import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import type { AthleteRow, AthleteProfileRow, RoutineRow } from '../types/database'
import { getWeekStart, computeWeekState, type WeekState } from '../lib/week'

export interface AppState {
  athlete: AthleteRow | null
  profile: AthleteProfileRow | null
  hasDiagnostic: boolean
  hasProfile: boolean       // true once "Zeroed In" is cleared
  todayRoutine: RoutineRow | null   // the next un-done session this week
  week: WeekState | null            // this week's sessions + completion
  loading: boolean
  refresh: () => void
}

export function useAppState(userId: string | undefined): AppState {
  const [athlete, setAthlete]         = useState<AthleteRow | null>(null)
  const [profile, setProfile]         = useState<AthleteProfileRow | null>(null)
  const [hasDiagnostic, setHasDiag]   = useState(false)
  const [todayRoutine, setTodayRoutine] = useState<RoutineRow | null>(null)
  const [week, setWeek]               = useState<WeekState | null>(null)
  const [loading, setLoading]         = useState(true)
  const [tick, setTick]               = useState(0)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!userId) {
      setAthlete(null)
      setProfile(null)
      setHasDiag(false)
      setWeek(null)
      setTodayRoutine(null)
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
        setWeek(null)
        setTodayRoutine(null)
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

      // 4. This week's loop — the active program's routines + the workouts logged
      //    this calendar week. done = a workout exists for that routine this week;
      //    next = first not-done. A repeating weekly template (see lib/week.ts).
      if (profileData) {
        const { data: routines } = await supabase
          .from('routine')
          .select('*, program!inner(athlete_id, status)')
          .eq('program.athlete_id', athleteData.id)
          .eq('program.status', 'active')
          .order('name')

        if (cancelled) return
        const routineRows = (routines ?? []) as unknown as RoutineRow[]

        if (routineRows.length > 0) {
          const { data: weekWorkouts } = await supabase
            .from('workout')
            .select('routine_id, performed_at')
            .in('routine_id', routineRows.map((r) => r.id))
            .gte('performed_at', getWeekStart().toISOString())

          if (cancelled) return
          const ws = computeWeekState(
            routineRows,
            (weekWorkouts ?? []) as Array<{ routine_id: string }>,
          )
          setWeek(ws)
          // todayRoutine = the next session to train (or, when the week is done,
          // the first session so "train again" still works).
          setTodayRoutine(ws.next ?? routineRows[0] ?? null)
        } else {
          setWeek(null)
          setTodayRoutine(null)
        }
      } else {
        setWeek(null)
        setTodayRoutine(null)
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
    week,
    loading,
    refresh,
  }
}
