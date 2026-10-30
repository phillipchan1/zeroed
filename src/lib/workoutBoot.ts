/* The workout screen's offline-first bootstrap.
 *
 * Everything the screen needs to paint the session and start logging, cached per
 * routine so opening a session (at the gym, on two bars) is instant and fully
 * offline — the network fetch then revalidates in the background. Every field is
 * serializable so it round-trips through localStorage.
 *
 * `seedWorkoutBootstrap` plants a minimal bootstrap from the app-state snapshot
 * so the first open paints with no spinner. A fetched bootstrap is left alone
 * while its routine still matches that snapshot. A rewrite under the same id
 * (MCP / editor) reseeds from the snapshot and drops an empty local draft of
 * the old version. Logged drafts and the outbox stay. The richer parts (last
 * session's numbers, the prescription, the per-exercise reads) fill in from
 * the background fetch.
 */
import { loadCache, saveCache } from './cache'
import { clearDraftLocal, loadDraftLocal } from './workoutDraft'
import {
  draftHasLoggedSets,
  reconcileWorkoutBootstrap,
} from './routineVersion'
import type {
  RoutineRow, SetLog, InsightRow, OnboardingStep,
} from '../types/database'
import type { SessionPrescription } from '../engine'
import type { LiftBest } from '../engine/prs'

export {
  routineContentDiffers,
  routineVersionMarker,
  reconcileWorkoutBootstrap,
  liveWorkoutReconcile,
} from './routineVersion'

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
 * Drop a local draft that has no logged sets. A draft with any logged set is
 * left alone — the athlete's numbers outrank a rewritten template. The outbox
 * is not touched.
 */
export function discardEmptyStaleDraft(routineId: string): void {
  const draft = loadDraftLocal(routineId)
  if (!draft || draftHasLoggedSets(draft.setLogs)) return
  clearDraftLocal(routineId)
}

/**
 * Plant a minimal bootstrap for a routine that has none, so its first open
 * paints immediately. A fetched bootstrap is left alone while its routine
 * still matches the snapshot (name / exercises / updated marker) — that one
 * carries last session's numbers and the prescription.
 *
 * When the snapshot routine has been rewritten under the same id, the stale
 * bootstrap is replaced from the snapshot and an empty local draft of the
 * old version is discarded. Logged drafts stay.
 */
export function seedWorkoutBootstrap(
  routine: RoutineRow,
  athleteId: string | null,
  athleteName: string | null,
  onboardingStep: OnboardingStep | null,
): void {
  const key = workoutBootKey(routine.id)
  const existing = loadCache<WorkoutBootstrap>(key)
  const action = reconcileWorkoutBootstrap(
    routine,
    existing?.routine ?? null,
    existing ? draftHasLoggedSets(loadDraftLocal(routine.id)?.setLogs) : false,
  )
  if (!action.reseed) return
  if (action.discardEmptyDraft) discardEmptyStaleDraft(routine.id)
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
