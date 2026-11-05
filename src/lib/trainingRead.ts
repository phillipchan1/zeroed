import { supabase } from './supabaseClient'
import { readLoggedExercises, type LoggedWorkoutLike } from '../engine/loggedSets'
import { localDay } from '../engine/liftModel'
import { readTraining, type TrainingRead } from '../engine/signals'
import type { SidedGoal, TrainingSession } from '../engine/weakLinks'

/** How far back the training read looks: long enough for an own-ratio baseline. */
const LOOKBACK_DAYS = 150

interface WorkoutRow extends LoggedWorkoutLike {
  performed_at: string
  rpe?: number | null
  session_rpe?: number | string | null
  duration_mins?: number | null
  readiness?: number | null
  sleep_hours?: number | string | null
  bodyweight?: number | string | null
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A logged workout as the training reads take it. */
export function toTrainingSession(w: WorkoutRow, timeZone: string): TrainingSession {
  return {
    date: localDay(w.performed_at, timeZone),
    exercises: readLoggedExercises(w).map((e) => ({ name: e.name, sets: e.sets })),
    session_rpe: num(w.session_rpe) ?? num(w.rpe),
    duration_mins: num(w.duration_mins),
    readiness: num(w.readiness),
    sleep_hours: num(w.sleep_hours),
    bodyweight: num(w.bodyweight),
  }
}

/** Every session the athlete logged in the lookback, oldest first, across programs. */
export async function fetchTrainingSessions(athleteId: string): Promise<TrainingSession[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from('workout')
    .select('performed_at, rpe, session_rpe, duration_mins, readiness, sleep_hours, bodyweight, actual_weights, exercises_snapshot, routine!inner(exercises, program!inner(athlete_id))')
    .eq('routine.program.athlete_id', athleteId)
    .gte('performed_at', since)
    .order('performed_at', { ascending: true })
    .limit(400)
  if (error) throw error
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return ((data ?? []) as unknown as WorkoutRow[]).map((w) => toTrainingSession(w, zone))
}

/** Weak links, cross-domain signals and the athlete's own lift ratios. */
export async function fetchTrainingRead(athleteId: string, goals: SidedGoal[] = []): Promise<TrainingRead> {
  const sessions = await fetchTrainingSessions(athleteId)
  return readTraining(sessions, new Date().toLocaleDateString('en-CA'), goals)
}
