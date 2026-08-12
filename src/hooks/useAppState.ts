import { useMemo } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useCachedLoader } from '../lib/cache'
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
//
// NOTE: this holds the week's raw workouts, not a resolved `todayRoutine`. Which
// session is "today" depends on the current time and on sessions finished but
// not yet synced, so it's derived at READ time — a cached snapshot then stays
// correct across a day boundary, and updates the instant a session is finished
// offline, with no refetch.
interface AppStateSnapshot {
  athlete: AthleteRow | null
  profile: AthleteProfileRow | null
  hasDiagnostic: boolean
  routines: RoutineRow[]
  weekWorkouts: Array<{ routine_id: string; performed_at: string }>
}

const EMPTY: AppStateSnapshot = {
  athlete: null,
  profile: null,
  hasDiagnostic: false,
  routines: [],
  weekWorkouts: [],
}

export function appStateKey(userId: string): string {
  return `app-state:${userId}`
}

// Fetch + derive the whole app-state snapshot from Supabase. Throws on the first
// network failure so the caller keeps the cached snapshot instead of blanking.
export async function fetchSnapshot(userId: string): Promise<AppStateSnapshot> {
  // 1. Athlete row
  const { data: athleteData, error: athErr } = await supabase
    .from('athlete')
    .select('*')
    .eq('auth_user_id', userId)
    .maybeSingle()
  if (athErr) throw athErr
  if (!athleteData) return EMPTY

  const athlete = athleteData as AthleteRow

  // 2. Diagnostic presence + athlete profile (the profile signals zeroed-in is
  //    complete). Independent reads, so issue them together.
  const [diagRes, profRes] = await Promise.all([
    supabase.from('diagnostic').select('id', { count: 'exact', head: true }).eq('athlete_id', athlete.id),
    supabase.from('athlete_profile').select('*').eq('athlete_id', athlete.id).maybeSingle(),
  ])
  if (diagRes.error) throw diagRes.error
  if (profRes.error) throw profRes.error
  const hasDiagnostic = (diagRes.count ?? 0) > 0
  const profile = (profRes.data as AthleteProfileRow | null) ?? null

  // 3. This week's plan (§4.1). Routines come from the ACTIVE phase only (a
  //    completed phase's routines stay on the program but must not surface),
  //    falling back to all program routines. The full ordered list is kept so
  //    the athlete can freely pick any session.
  let routines: RoutineRow[] = []
  let weekWorkouts: Array<{ routine_id: string; performed_at: string }> = []
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
        routines = [...(routineRows as unknown as RoutineRow[])].sort((a, b) => a.name.localeCompare(b.name))
        // This week's workouts (Mon–Sun), for scheduling. Scoped to the PROGRAM
        // and the date window, not to the current phase's routine ids — the way
        // gatherWeeklyRecap already counts a week. A phase boundary mints fresh
        // routine rows, so filtering by the active phase's routines made every
        // session logged earlier in the same week vanish from the week the
        // moment the block swapped, and the athlete's finished work read as
        // never done.
        const monday = new Date()
        monday.setHours(0, 0, 0, 0)
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
        const { data: weekRows } = await supabase
          .from('workout')
          .select('routine_id, performed_at, routine!inner(program_id)')
          .eq('routine.program_id', prog.id)
          .gte('performed_at', monday.toISOString())
        weekWorkouts = (weekRows ?? []) as unknown as Array<{ routine_id: string; performed_at: string }>
      }
    }
  }

  return { athlete, profile, hasDiagnostic, routines, weekWorkouts }
}

export function useAppState(userId: string | undefined): AppState {
  const cacheKey = userId ? appStateKey(userId) : null

  // Paints from the held snapshot on frame one (memory, then localStorage), so a
  // returning athlete never sees the splash — even fully offline. It refetches
  // only when the snapshot has gone stale or when refresh() forces it after a
  // write, so moving between tabs costs nothing.
  const { data, loading, refetch } = useCachedLoader<AppStateSnapshot>(
    cacheKey,
    () => fetchSnapshot(userId!),
  )

  const snapshot = data ?? EMPTY

  // Which session is "today", derived here rather than at fetch time, folding in
  // sessions finished but not yet committed (offline, or a commit still in
  // flight). Without that fold a finished session stays invisible to scheduling
  // until its DB row lands — so "today" keeps offering a session the athlete
  // already did, even across reloads. computeWeekSchedule dedupes by calendar
  // day, so a pending entry overlapping a committed one collapses to one.
  const routines = snapshot.routines ?? []
  const todayRoutine = useMemo(() => {
    if (!snapshot.athlete || routines.length === 0) return null
    const logged = snapshot.weekWorkouts ?? []
    const pending = pendingWorkouts().filter((w) => routines.some((r) => r.id === w.routine_id))
    return computeWeekSchedule(
      routines,
      [...logged, ...pending],
      snapshot.athlete.sessions_per_week ?? 3,
    ).todayRoutine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])

  return {
    athlete: snapshot.athlete,
    profile: snapshot.profile,
    hasDiagnostic: snapshot.hasDiagnostic,
    hasProfile: !!snapshot.profile,
    todayRoutine,
    routines,
    loading,
    refresh: refetch,
  }
}
