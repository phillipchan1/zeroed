/* The workout screen's offline-first bootstrap.
 *
 * Everything the screen needs to paint the session and start logging, cached per
 * routine so opening a session (at the gym, on two bars) is instant and fully
 * offline — the network fetch then revalidates in the background. Every field is
 * serializable so it round-trips through localStorage.
 *
 * `seedWorkoutBootstrap` covers the one case a per-routine cache can't: the
 * FIRST time a session is opened, when nothing has been cached for it yet. The
 * routine row is already in hand from the app-state snapshot, and the routine is
 * all the screen needs to lay down the exercise list and the empty set grid —
 * so we plant a minimal bootstrap ahead of time and the first open paints with
 * no spinner. The richer parts (last session's numbers, the prescription, the
 * per-exercise reads) fill in from the background fetch.
 */
import { loadCache, saveCache } from './cache'
import type {
  RoutineRow, SetLog, InsightRow, OnboardingStep,
} from '../types/database'
import type { SessionPrescription } from '../engine'
import type { LiftBest } from '../engine/prs'

export interface WorkoutBootstrap {
  routine: RoutineRow
  athleteId: string | null
  athleteName: string | null
  onboardingStep: OnboardingStep | null
  prevByExercise: Record<number, SetLog[]>
  insightMap: Record<string, InsightRow>
  prescription: SessionPrescription | null
  /**
   * The standing record on each of this session's lifts, by exercise index —
   * what a set logged right now has to beat. Cached with the rest so the PR
   * badge fires offline, on the bar, at the moment it is earned. Absent on
   * bootstraps written before this field existed — read with `?.`.
   */
  bestByExercise?: Record<number, LiftBest>
  /**
   * The same records and last-session sets, keyed by NAME across the whole
   * program — what a swapped-in movement is measured against, since it has no
   * history in this routine's slots. Absent on older bootstraps — read with `?.`.
   */
  bestsByName?: Record<string, LiftBest>
  prevByName?: Record<string, SetLog[]>
}

export const workoutBootKey = (routineId: string) => `workout:${routineId}`

/**
 * Plant a minimal bootstrap for a routine that has none, so its first open
 * paints immediately. Never overwrites a real (fetched) bootstrap — that one
 * carries the previous session's numbers and the prescription.
 */
export function seedWorkoutBootstrap(
  routine: RoutineRow,
  athleteId: string | null,
  athleteName: string | null,
  onboardingStep: OnboardingStep | null,
): void {
  const key = workoutBootKey(routine.id)
  if (loadCache<WorkoutBootstrap>(key)) return
  saveCache<WorkoutBootstrap>(key, {
    routine,
    athleteId,
    athleteName,
    onboardingStep,
    prevByExercise: {},
    insightMap: {},
    prescription: null,
    bestByExercise: {},
  })
}
