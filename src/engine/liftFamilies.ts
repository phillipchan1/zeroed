// =============================================================================
// LIFT FAMILIES — how related lifts compare, and what it means when they don't.
//
// A coach knows a dumbbell press, an incline and a bench are one family, and
// roughly how they compare. That knowledge does two jobs here:
//
//   1. FILL GAPS. A bench goal in a dumbbell-only block still moves: the DB
//      press estimate, through the ratio, is an inferred bench (the weakest
//      tier, and labeled so).
//   2. FIND WEAK LINKS. When the athlete's own ratio drifts off what's
//      expected, or off what it used to be for them, that names something:
//      a DB press low against the bench is usually shoulder stability or
//      control, not chest strength.
//
// Doctrine, as in demandTables.ts: these are CODE-OWNED priors. The agent reads
// them, never invents them. Round numbers on purpose; they are population
// heuristics, and the athlete's own ratio replaces them once there is enough
// paired data (weakLinks.ts). Every e1RM ratio is FROM ÷ TO; a dumbbell lift's
// e1RM is per dumbbell, as it's logged.
//
// Pure data and lookups, no I/O (see weakLinks.check.ts).
// =============================================================================

import { findLibraryExercise } from './exerciseLibrary.ts'

/** Same spelling rule as goalSources.normalizeExerciseName (kept local: goalSources imports this file). */
export function normalizeExerciseName(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export interface LiftPair {
  /** The related lift. Canonical library name. */
  from: string
  /** The lift it is read against. Canonical library name. */
  to: string
  /** Expected e1RM(from) ÷ e1RM(to). */
  ratio: number
  /** What a ratio well under the expected one usually means. */
  low: string
  /** What a ratio well over it usually means, when that says something. */
  high: string | null
}

export const LIFT_PAIRS: readonly LiftPair[] = [
  { from: 'DB Bench Press', to: 'Bench Press', ratio: 0.4,
    low: 'shoulder stability, unilateral control or range of motion',
    high: 'bench technique: bar path, setup or lockout' },
  { from: 'Incline Bench Press', to: 'Bench Press', ratio: 0.8,
    low: 'upper chest and front delts', high: null },
  { from: 'Incline DB Press', to: 'Bench Press', ratio: 0.33,
    low: 'upper chest, shoulder stability', high: null },
  { from: 'Close-Grip Bench Press', to: 'Bench Press', ratio: 0.9,
    low: 'triceps and lockout', high: 'chest or the bench setup' },
  { from: 'Overhead Press', to: 'Bench Press', ratio: 0.62,
    low: 'overhead mobility, delts or triceps', high: null },
  { from: 'Barbell Row', to: 'Bench Press', ratio: 0.85,
    low: 'upper back behind the press (a shoulder-health flag)', high: null },
  { from: 'Front Squat', to: 'Back Squat', ratio: 0.83,
    low: 'quads, upper back or an upright torso', high: 'back squat technique or hip drive' },
  { from: 'Safety Bar Squat', to: 'Back Squat', ratio: 0.9,
    low: 'upper back and trunk', high: null },
  { from: 'Deadlift', to: 'Back Squat', ratio: 1.2,
    low: 'posterior chain', high: 'quads behind the hips' },
  { from: 'Romanian Deadlift', to: 'Deadlift', ratio: 0.7,
    low: 'hamstrings', high: null },
  { from: 'Trap Bar Deadlift', to: 'Deadlift', ratio: 1.05,
    low: 'quads off the floor', high: 'back position in the straight-bar pull' },
]

// Variations that the library files under their parent for swaps, but that
// estimate a different max (liftModel's rule): a paused squat is not a squat.
const VARIATION = /\b(paus\w*|tempo|pin|spoto|deficit|block|board|chains?|bands?)\b/

/** One spelling per lift: the library's canonical name, unless it's a variation. */
export function canonicalLift(name: string): string {
  const n = normalizeExerciseName(name)
  if (VARIATION.test(n)) return n
  return findLibraryExercise(name)?.name ?? n
}

const PAIR_BY_KEY = new Map(LIFT_PAIRS.map((p) => [pairId(p.from, p.to), p]))

export function pairId(from: string, to: string): string {
  return `${normalizeExerciseName(from)}→${normalizeExerciseName(to)}`
}

/** The pair that reads `from` against `to`, if the table has one. */
export function liftPair(from: string, to: string): LiftPair | null {
  return PAIR_BY_KEY.get(pairId(canonicalLift(from), canonicalLift(to))) ?? null
}

/** Every pair a lift reads against. */
export function pairsTo(to: string): LiftPair[] {
  const key = normalizeExerciseName(canonicalLift(to))
  return LIFT_PAIRS.filter((p) => normalizeExerciseName(p.to) === key)
}

/**
 * The ratio to read `from` against `to` with: the athlete's own once learned,
 * the prior until then.
 */
export function ratioFor(from: string, to: string, learned?: Record<string, number> | null): number | null {
  const pair = liftPair(from, to)
  if (!pair) return null
  const own = learned?.[pairId(pair.from, pair.to)]
  return typeof own === 'number' && own > 0 ? own : pair.ratio
}
