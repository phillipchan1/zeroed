import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import { computeWeekSchedule } from '../engine'
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

export function useAppState(userId: string | undefined): AppState {
  const [athlete, setAthlete]         = useState<AthleteRow | null>(null)
  const [profile, setProfile]         = useState<AthleteProfileRow | null>(null)
  const [hasDiagnostic, setHasDiag]   = useState(false)
  const [todayRoutine, setTodayRoutine] = useState<RoutineRow | null>(null)
  const [routines, setRoutines]       = useState<RoutineRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [tick, setTick]               = useState(0)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!userId) {
      setAthlete(null)
      setProfile(null)
      setHasDiag(false)
      setLoading(false)
      return
    }

    let cancelled = false

    async function load() {
      setLoading(true)

      // 1. Athlete row
      const { data: athleteData } = await supabase
        .from('athlete')
        .select('*')
        .eq('auth_user_id', userId!)
        .maybeSingle()

      if (cancelled) return
      if (!athleteData) {
        setAthlete(null)
        setProfile(null)
        setHasDiag(false)
        setLoading(false)
        return
      }

      setAthlete(athleteData as AthleteRow)

      // 2. Diagnostic
      const { count: diagCount } = await supabase
        .from('diagnostic')
        .select('id', { count: 'exact', head: true })
        .eq('athlete_id', athleteData.id)

      if (cancelled) return
      setHasDiag((diagCount ?? 0) > 0)

      // 3. Athlete profile (signals zeroed-in is complete)
      const { data: profileData } = await supabase
        .from('athlete_profile')
        .select('*')
        .eq('athlete_id', athleteData.id)
        .maybeSingle()

      if (cancelled) return
      setProfile(profileData as AthleteProfileRow | null)

      // 4. Today's routine — derived from this week's plan (§4.1). Routines come
      //    from the ACTIVE phase only (a completed phase's routines stay on the
      //    program but must not surface), falling back to all program routines.
      if (profileData) {
        const { data: prog } = await supabase
          .from('program')
          .select('id')
          .eq('athlete_id', athleteData.id)
          .eq('status', 'active')
          .maybeSingle()

        if (!cancelled && prog) {
          const { data: activePhase } = await supabase
            .from('phase')
            .select('id')
            .eq('program_id', prog.id)
            .eq('status', 'active')
            .maybeSingle()

          let routineQuery = supabase
            .from('routine')
            .select('*')
            .eq('program_id', prog.id)
            .order('name')
          if (activePhase) routineQuery = routineQuery.eq('phase_id', activePhase.id)

          let { data: routines } = await routineQuery
          // Fallback: a program whose routines predate phase wiring.
          if (activePhase && (!routines || routines.length === 0)) {
            const all = await supabase.from('routine').select('*').eq('program_id', prog.id).order('name')
            routines = all.data
          }

          if (!cancelled && routines && routines.length > 0) {
            // This week's workouts for these routines (Mon–Sun), for scheduling.
            const monday = new Date()
            monday.setHours(0, 0, 0, 0)
            monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
            const { data: weekWorkouts } = await supabase
              .from('workout')
              .select('routine_id, performed_at')
              .in('routine_id', routines.map((r) => r.id))
              .gte('performed_at', monday.toISOString())

            if (!cancelled) {
              const ordered = [...(routines as unknown as RoutineRow[])].sort((a, b) => a.name.localeCompare(b.name))
              const schedule = computeWeekSchedule(
                ordered,
                (weekWorkouts ?? []) as Array<{ routine_id: string; performed_at: string }>,
                (athleteData as AthleteRow).sessions_per_week ?? 3,
              )
              setTodayRoutine(schedule.todayRoutine)
              setRoutines(ordered)
            }
          } else if (!cancelled) {
            setTodayRoutine(null)
            setRoutines([])
          }
        }
      }

      if (!cancelled) setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [userId, tick])

  return {
    athlete,
    profile,
    hasDiagnostic,
    hasProfile: !!profile,
    todayRoutine,
    routines,
    loading,
    refresh,
  }
}
