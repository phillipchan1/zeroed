/* Compare two routine rows by the content the workout screen must show.
 *
 * A Friday row keeps its id across MCP / editor rewrites. The per-routine
 * bootstrap and local draft are keyed only by that id, so "is this the same
 * session?" is name + exercises + optional updated marker — not the id.
 */
import { isSetLogged } from '../engine/volume.ts'
import type { ExerciseTemplate, SetLog } from '../types/database'

export type RoutineVersioned = {
  name: string
  exercises: ExerciseTemplate[] | null | undefined
  /** Optional on the wire (`select('*')`); the table itself has no such column. */
  updated_at?: string | null
}

export function routineVersionMarker(routine: RoutineVersioned): string {
  return JSON.stringify({
    name: routine.name,
    exercises: routine.exercises ?? [],
    updated: routine.updated_at ?? '',
  })
}

export function routineContentDiffers(a: RoutineVersioned, b: RoutineVersioned): boolean {
  return routineVersionMarker(a) !== routineVersionMarker(b)
}

export function draftHasLoggedSets(
  setLogs: Record<number, SetLog[]> | Record<string, SetLog[]> | null | undefined,
): boolean {
  return Object.values(setLogs ?? {}).flat().some((s) => s != null && isSetLogged(s))
}

export interface BootstrapReconcile {
  /** Write a bootstrap from the snapshot routine (first seed or a rewrite). */
  reseed: boolean
  /** Drop a local draft that has no logged sets. Never true when sets are logged. */
  discardEmptyDraft: boolean
}

/**
 * What to do when the app-state snapshot routine for an id is compared to the
 * cached WorkoutBootstrap (and its local draft). The outbox is never in scope.
 */
export function reconcileWorkoutBootstrap(
  snapshot: RoutineVersioned,
  cachedRoutine: RoutineVersioned | null,
  draftLoggedSets: boolean,
): BootstrapReconcile {
  if (!cachedRoutine) return { reseed: true, discardEmptyDraft: false }
  if (!routineContentDiffers(cachedRoutine, snapshot)) {
    return { reseed: false, discardEmptyDraft: false }
  }
  return { reseed: true, discardEmptyDraft: !draftLoggedSets }
}

export interface LiveWorkoutReconcile {
  /** Paint the snapshot's name / exercises on the open workout screen. */
  adoptRoutine: boolean
  /** Rebuild the empty set grid to match the snapshot. Never true when sets are logged. */
  rebuildGrid: boolean
}

/**
 * The open workout screen vs a snapshot that arrived late (slow app-state).
 * Same version compare as the bootstrap seed. A draft with logged sets keeps
 * the grid the athlete is typing into — we never swap the exercise list under
 * numbers they already logged.
 */
export function liveWorkoutReconcile(
  snapshot: RoutineVersioned,
  painted: RoutineVersioned | null,
  draftLoggedSets: boolean,
): LiveWorkoutReconcile {
  if (draftLoggedSets) return { adoptRoutine: false, rebuildGrid: false }
  if (!painted) return { adoptRoutine: true, rebuildGrid: true }
  if (!routineContentDiffers(painted, snapshot)) {
    return { adoptRoutine: false, rebuildGrid: false }
  }
  return { adoptRoutine: true, rebuildGrid: true }
}
