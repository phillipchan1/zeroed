import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import type { AthleteRow, AthleteProfileRow, RoutineRow } from '../types/database'

export interface AppState {
  athlete: AthleteRow | null
  profile: AthleteProfileRow | null
  hasDiagnostic: boolean
  hasProfile: boolean       // true once "Zeroed In" is cleared
  todayRoutine: RoutineRow | null   // first routine available to log today
  loading: boolean
  refresh: () => void
}

export function useAppState(userId: string | undefined): AppState {
  const [athlete, setAthlete]         = useState<AthleteRow | null>(null)
  const [profile, setProfile]         = useState<AthleteProfileRow | null>(null)
  const [hasDiagnostic, setHasDiag]   = useState(false)
  const [todayRoutine, setTodayRoutine] = useState<RoutineRow | null>(null)
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

      // 4. Today's routine (first routine from active program, cycle through A/B/C)
      if (profileData) {
        const { data: routines } = await supabase
          .from('routine')
          .select('*, program!inner(athlete_id, status)')
          .eq('program.athlete_id', athleteData.id)
          .eq('program.status', 'active')
          .order('name')

        if (!cancelled && routines && routines.length > 0) {
          // Pick the next routine based on workout count
          const { count: workoutCount } = await supabase
            .from('workout')
            .select('id', { count: 'exact', head: true })
            .in('routine_id', routines.map((r) => r.id))

          if (!cancelled) {
            const idx = (workoutCount ?? 0) % routines.length
            setTodayRoutine(routines[idx] as unknown as RoutineRow)
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
    loading,
    refresh,
  }
}
