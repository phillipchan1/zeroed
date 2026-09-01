// =============================================================================
// PRs — "that was the heaviest you've ever done it."
//
// The app could tell you the load it wanted and why, and could argue itself out
// of a limiter from one hard set, but it could not tell you that you had just
// hit the best set of your life. `bestWeight` / `bestE1rm` existed as two
// numbers at the top of a sheet you had to go looking for, with nothing marking
// WHICH session earned them and nothing saying so at the moment it happened.
// Every app this one is measured against — Hevy, Strong, JEFIT, TrainHeroic —
// says it out loud, in the set row, as it happens.
//
// Doctrine, same as everywhere else here: code owns the arithmetic. A PR is a
// fact about numbers, not a judgement, so nothing about it is ever asked of a
// model.
//
// Pure, no I/O (see prs.check.ts).
// =============================================================================

import type { SetLog } from '../types/database'

/**
 * Epley's estimate — the standard load×reps → strength proxy.
 *
 * The one correction against the textbook formula: at ONE rep it returns the
 * weight itself. Epley's `w(1 + r/30)` is an extrapolation from a submaximal
 * set, and at r=1 it extrapolates past the thing it is extrapolating from —
 * 225×1 came back as an estimated 233, so a true single printed as an e1RM
 * higher than the bar the athlete had just held. An actual single IS the 1RM;
 * there is nothing left to estimate.
 *
 * Above ~12 reps the estimate stops meaning much (it is a strength proxy, not
 * an endurance one). We still return it — dropping the point would leave a hole
 * in the trend line — but `estimateIsReliable` marks where it should not be
 * presented as a number to train off.
 */
export function estimate1RM(weight: number, reps: number): number | null {
  if (!Number.isFinite(weight) || !Number.isFinite(reps)) return null
  if (weight <= 0 || reps < 1) return null
  if (reps === 1) return weight
  return Math.round(weight * (1 + reps / 30))
}

export const RELIABLE_E1RM_REPS = 12

export function estimateIsReliable(reps: number | null | undefined): boolean {
  return reps != null && reps >= 1 && reps <= RELIABLE_E1RM_REPS
}

/** What an athlete has ever done on one lift. Nulls mean "never, yet". */
export interface LiftBest {
  /** Heaviest single set, whatever the reps. */
  weight: number | null
  /** Best estimated 1RM — the honest "are you stronger" line. */
  e1rm: number | null
  /** Most reps at or above `weight` — the rep PR's benchmark. */
  repsAtBest: number | null
}

export const NO_BEST: LiftBest = { weight: null, e1rm: null, repsAtBest: null }

export type PrKind = 'weight' | 'e1rm' | 'reps'

const PR_LABEL: Record<PrKind, string> = {
  weight: 'Heaviest',
  e1rm:   'Best e1RM',
  reps:   'Most reps',
}

export function prLabel(kinds: PrKind[]): string | null {
  if (!kinds.length) return null
  // Heaviest ever outranks the estimate, which outranks a rep record — say the
  // biggest true thing rather than stacking three badges on one set.
  const rank: PrKind[] = ['weight', 'e1rm', 'reps']
  const best = rank.find((k) => kinds.includes(k))!
  return PR_LABEL[best]
}

/**
 * Which records this set breaks, against everything before it.
 *
 * STRICTLY GREATER, deliberately. A tie is not a PR: repeating your best is
 * real work and worth logging, but calling it a record devalues the badge on
 * the day it is actually earned, and an app that fires "PR!" on every repeat of
 * a working weight teaches you to ignore it. Equalling a best leaves the record
 * standing, which is exactly what happened.
 */
export function detectSetPRs(set: SetLog | null | undefined, best: LiftBest): PrKind[] {
  if (!set || set.weight == null || set.weight <= 0) return []
  const kinds: PrKind[] = []

  if (best.weight == null || set.weight > best.weight) kinds.push('weight')

  const e1rm = set.reps != null ? estimate1RM(set.weight, set.reps) : null
  if (e1rm != null && (best.e1rm == null || e1rm > best.e1rm)) kinds.push('e1rm')

  // A rep PR only counts at or above the standing best weight — more reps with
  // less on the bar is not a record, it is a different set.
  if (
    set.reps != null && best.weight != null && best.repsAtBest != null &&
    set.weight >= best.weight && set.reps > best.repsAtBest
  ) {
    kinds.push('reps')
  }

  return kinds
}

/**
 * The PRs worth SHOWING. Same arithmetic, one extra rule: a first-ever loaded
 * set on a lift sets a BASELINE, not a record — there was nothing to beat. A
 * badge on every set of a first session is a badge that means nothing by the
 * second one. `detectSetPRs` stays the honest primitive (it is what folds the
 * running best forward); this is what a surface renders.
 */
export function displayPRs(set: SetLog | null | undefined, best: LiftBest): PrKind[] {
  if (best.weight == null) return []
  return detectSetPRs(set, best)
}

/** Fold one more set into a running best. Returns a new object; never mutates. */
export function foldBest(best: LiftBest, set: SetLog | null | undefined): LiftBest {
  if (!set || set.weight == null || set.weight <= 0) return best
  const e1rm = set.reps != null ? estimate1RM(set.weight, set.reps) : null
  const heavier = best.weight == null || set.weight > best.weight
  return {
    weight: heavier ? set.weight : best.weight,
    e1rm: e1rm != null && (best.e1rm == null || e1rm > best.e1rm) ? e1rm : best.e1rm,
    // repsAtBest tracks the reps standing at the CURRENT best weight: a new top
    // weight resets it, and matching that weight for more reps raises it.
    repsAtBest: heavier
      ? set.reps ?? null
      : best.weight != null && set.weight === best.weight && set.reps != null
        ? Math.max(best.repsAtBest ?? 0, set.reps)
        : best.repsAtBest,
  }
}

/** The best across a whole list of sets, oldest → newest. */
export function bestOfSets(sets: Iterable<SetLog>): LiftBest {
  let best = NO_BEST
  for (const s of sets) best = foldBest(best, s)
  return best
}
