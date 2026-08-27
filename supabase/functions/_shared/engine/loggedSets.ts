// =============================================================================
// loggedSets — read a logged session without letting the present rewrite it.
//
// workout.actual_weights is keyed by the exercise's INDEX in the routine
// ({"0": [...], "1": [...]}), so a set only knows which movement it belongs to
// by position. That is fine while the routine is frozen and wrong the moment it
// isn't: the program editor splices exercises in and out, and every index after
// the splice point shifts. Resolving an old log against the routine's CURRENT
// list therefore reattributes work the athlete already did — last month's squats
// silently become this month's calf raises, in History, in the coach's context,
// and in the loads the next phase is designed from.
//
// The fix is to stop asking the routine what a logged set was. workout carries
// `exercises_snapshot`: the prescription as it stood at log time. Everything
// here resolves against that, and falls back to the live routine only for
// sessions logged before the snapshot existed (where the two are equal anyway,
// unless that routine has since been edited — the one case the fallback cannot
// save, and the reason the snapshot is written going forward).
//
// Pure, no I/O.
// =============================================================================

import type { ExerciseTemplate, SetLog } from './types.ts'

/** One movement's logged work, correctly attributed. */
export interface LoggedExercise {
  name: string
  exercise: ExerciseTemplate | null
  sets: SetLog[]
}

/** The row shape every caller already selects — snapshot optional. */
export interface LoggedWorkoutLike {
  actual_weights: Record<string, SetLog[]> | null
  exercises_snapshot?: ExerciseTemplate[] | null
  routine?: { exercises?: ExerciseTemplate[] | null } | null
}

/**
 * The exercise list a logged workout's set keys are indexed against: its own
 * snapshot when it has one, otherwise the routine's live list.
 */
export function resolveLoggedExercises(w: LoggedWorkoutLike): ExerciseTemplate[] {
  const snap = w.exercises_snapshot
  if (Array.isArray(snap) && snap.length) return snap
  const live = w.routine?.exercises
  return Array.isArray(live) ? live : []
}

/**
 * Every logged movement in a workout, in prescription order, with its sets.
 *
 * Keys are normally numeric indices. A non-numeric key is treated as the
 * exercise NAME instead — older rows and hand-seeded data use that shape, and
 * guessing wrong would be exactly the mislabeling this module exists to stop.
 */
export function readLoggedExercises(w: LoggedWorkoutLike): LoggedExercise[] {
  const exercises = resolveLoggedExercises(w)
  const out: LoggedExercise[] = []
  for (const [key, sets] of Object.entries(w.actual_weights ?? {})) {
    if (!Array.isArray(sets) || sets.length === 0) continue
    const asIndex = Number(key)
    if (Number.isInteger(asIndex) && String(asIndex) === key.trim()) {
      const ex = exercises[asIndex]
      if (!ex) continue   // an index with no movement behind it names nothing
      out.push({ name: ex.name, exercise: ex, sets })
    } else {
      const ex = exercises.find((e) => e.name === key) ?? null
      out.push({ name: key, exercise: ex, sets })
    }
  }
  return out
}
