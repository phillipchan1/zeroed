import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { loadCache, saveCache } from '../lib/cache'
import { computeWeekSchedule } from '../engine'
import { pendingWorkouts } from '../lib/workoutOutbox'
import type { AthleteRow, AthleteProfileRow, RoutineRow } from '../types/database'

export interface AppState {
  athlete: AthleteRow | null
  profile: AthleteProfileRow | null
  hasDiagnostic: boolean
  hasProfile: boolean       // true once "Zeroed In" is cleared
  todayRoutine: RoutineRow | null   // first routine available to log today
  routines: RoutineRow[]    // every session in the active phase (for free picking)
  loading: boolean
  refresh: () => void
}

// The slice we persist per athlete so a cold launch paints instantly from the
// last sync — the dominant fix for "takes a while to load" on low connectivity.
interface AppStateSnapshot {
  athlete: AthleteRow | null
  profile: AthleteProfileRow | null
  hasDiagnostic: boolean
  todayRoutine: RoutineRow | null
  routines: RoutineRow[]
}

const EMPTY: AppStateSnapshot = {
  athlete: null,
  profile: null,
  hasDiagnostic: false,
  todayRoutine: null,
  routines: [],
}

// Fetch + derive the whole app-state snapshot from Supabase. Throws on the first
// network failure so the caller keeps the cached snapshot instead of blanking.
async function fetchSnapshot(userId: string): Promise<AppStateSnapshot> {
  // 1. Athlete row
  const { data: athleteData, error: athErr } = await supabase
    .from('athlete')
    .select('*')
    .eq('auth_user_id', userId)
    .maybeSingle()
  if (athErr) throw athErr
  if (!athleteData) return EMPTY

  const athlete = athleteData as AthleteRow

  // 2. Diagnostic presence
  const { count: diagCount, error: diagErr } = await supabase
    .from('diagnostic')
    .select('id', { count: 'exact', head: true })
    .eq('athlete_id', athlete.id)
  if (diagErr) throw diagErr
  const hasDiagnostic = (diagCount ?? 0) > 0

  // 3. Athlete profile (signals zeroed-in is complete)
  const { data: profileData, error: profErr } = await supabase
    .from('athlete_profile')
    .select('*')
    .eq('athlete_id', athlete.id)
    .maybeSingle()
  if (profErr) throw profErr
  const profile = (profileData as AthleteProfileRow | null) ?? null

  // 4. Today's routine — derived from this week's plan (§4.1). Routines come
  //    from the ACTIVE phase only (a completed phase's routines stay on the
  //    program but must not surface), falling back to all program routines. The
  //    full ordered list is also kept so the athlete can freely pick any session.
  let todayRoutine: RoutineRow | null = null
  let routines: RoutineRow[] = []
  if (profile) {
    const { data: prog } = await supabase
      .from('program')
      .select('id')
      .eq('athlete_id', athlete.id)
      .eq('status', 'active')
      .maybeSingle()

    if (prog) {
      // Resolve THE current phase. A program should have exactly one active
      // phase, but a retest re-scope (which queues a new block and swaps it in at
      // the week boundary) can briefly leave zero or several rows flagged active.
      // Reading with .maybeSingle() returned null in that case, which dropped the
      // phase_id filter below and surfaced EVERY routine in the program — two or
      // three phases' worth — so the week read as 8-10 sessions assigned. Instead
      // pick a single phase deterministically: the newest active one, or (if none
      // is active mid-swap) the newest phase of any status.
      const { data: phaseRows } = await supabase
        .from('phase')
        .select('id, status, week_start')
        .eq('program_id', prog.id)
        .order('week_start', { ascending: false })
      const phases = (phaseRows ?? []) as Array<{ id: string; status: string; week_start: string }>
      const currentPhase = phases.find((p) => p.status === 'active') ?? phases[0] ?? null

      let routineQuery = supabase
        .from('routine')
        .select('*')
        .eq('program_id', prog.id)
        .order('name')
      if (currentPhase) routineQuery = routineQuery.eq('phase_id', currentPhase.id)

      let { data: routineRows } = await routineQuery
      // Legacy fallback: a program whose routines predate phase wiring (null
      // phase_id, no phase rows at all) — only then widen to every program routine.
      if (currentPhase && (!routineRows || routineRows.length === 0)) {
        const all = await supabase.from('routine').select('*').eq('program_id', prog.id).order('name')
        routineRows = all.data
      }

      if (routineRows && routineRows.length > 0) {
        const ordered = [...(routineRows as unknown as RoutineRow[])].sort((a, b) => a.name.localeCompare(b.name))
        // This week's workouts for these routines (Mon–Sun), for scheduling.
        const monday = new Date()
        monday.setHours(0, 0, 0, 0)
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
        const { data: weekWorkouts } = await supabase
          .from('workout')
          .select('routine_id, performed_at')
          .in('routine_id', ordered.map((r) => r.id))
          .gte('performed_at', monday.toISOString())

        // Fold in sessions finished but not yet committed (offline, or a commit
        // still in flight / failing). Without this, a finished session stays
        // invisible to scheduling until its DB row lands — so "today" keeps
        // offering a session the athlete already did, even across reloads.
        // computeWeekSchedule dedupes by calendar day, so a pending entry that
        // overlaps a committed one collapses to one session.
        const pending = pendingWorkouts().filter((w) => ordered.some((r) => r.id === w.routine_id))
        const schedule = computeWeekSchedule(
          ordered,
          [...((weekWorkouts ?? []) as Array<{ routine_id: string; performed_at: string }>), ...pending],
          athlete.sessions_per_week ?? 3,
        )
        todayRoutine = schedule.todayRoutine
        routines = ordered
      }
    }
  }

  return { athlete, profile, hasDiagnostic, todayRoutine, routines }
}

export function useAppState(userId: string | undefined): AppState {
  const cacheKey = userId ? `app-state:${userId}` : null

  // Hydrate synchronously from cache so a returning, cached athlete never sees
  // the Splash — even fully offline.
  const [snapshot, setSnapshot] = useState<AppStateSnapshot>(() =>
    cacheKey ? loadCache<AppStateSnapshot>(cacheKey) ?? EMPTY : EMPTY,
  )
  const [loading, setLoading] = useState<boolean>(() =>
    cacheKey ? loadCache<AppStateSnapshot>(cacheKey) === null : false,
  )
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  // refresh() should never re-show the Splash — we already have data to paint.
  const firstLoad = useRef(true)

  useEffect(() => {
    if (!userId || !cacheKey) {
      setSnapshot(EMPTY)
      setLoading(false)
      return
    }

    let cancelled = false
    const cached = loadCache<AppStateSnapshot>(cacheKey)
    if (cached) {
      setSnapshot(cached)
      setLoading(false)
    } else if (firstLoad.current) {
      setLoading(true)
    }

    fetchSnapshot(userId)
      .then((fresh) => {
        if (cancelled) return
        saveCache(cacheKey, fresh)
        setSnapshot(fresh)
        setLoading(false)
      })
      .catch(() => {
        // Offline / transient failure: keep whatever we hydrated from cache.
        if (!cancelled) setLoading(false)
      })
      .finally(() => {
        firstLoad.current = false
      })

    return () => { cancelled = true }
  }, [userId, cacheKey, tick])

  return {
    athlete: snapshot.athlete,
    profile: snapshot.profile,
    hasDiagnostic: snapshot.hasDiagnostic,
    hasProfile: !!snapshot.profile,
    todayRoutine: snapshot.todayRoutine,
    routines: snapshot.routines ?? [],
    loading,
    refresh,
  }
}
