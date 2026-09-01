// =============================================================================
// REST — how long between sets, and who decides.
//
// The rest timer was 90 seconds for everything. Every lift, every block, every
// athlete. That number is wrong in both directions at once: it cuts a heavy
// triple's recovery in half and makes you stand around for a minute and a half
// after a band pull-apart. A Strength block's whole premise is that the main
// lift is heavy enough to need real rest, and the app was quietly denying it.
//
// So rest is prescribed the same way load is: from the block's intent and the
// lift's role in it. The numbers below are the ordinary S&C ones —
//
//   · a main lift near-maximal (Strength / Power)  → 3 min, full phosphagen
//   · a main lift moderate (Stability / Sport)     → 2 min
//   · accessory work                               → 60–90 s
//   · a timed hold or a carry                      → 45 s, it is already work
//
// — and the athlete can move any of them ±30s in the moment, because the coach
// is not in the gym and the set that just happened is better evidence than the
// table.
//
// Pure, no I/O (see restTimer.check.ts).
// =============================================================================

import type { ExerciseTemplate, PhaseName, TrackingType } from '../types/database.ts'
import { MAIN_LIFT } from './weekDiff.ts'

/** How far a single tap moves the clock. */
export const REST_STEP_SECONDS = 30
/** Never below this — a rest of nothing is not a rest. */
export const MIN_REST_SECONDS = 15
/** Never above this — past five minutes it is a new session, not a rest. */
export const MAX_REST_SECONDS = 600

/** The fallback when nothing about the lift or the block is known. */
export const DEFAULT_REST_SECONDS = 90

const MAIN_LIFT_REST: Record<PhaseName, number> = {
  Stability: 120,   // control the pattern; heavy enough to matter, not maximal
  Strength:  180,   // the block's spine, 4–6 at RPE 7–8 — this needs the full three
  Power:     180,   // expressed fast and fresh; fatigue is the enemy of the quality
  Sport:     120,   // mixed qualities, rarely maximal
}

const ACCESSORY_REST: Record<PhaseName, number> = {
  Stability: 60,
  Strength:  90,
  Power:     90,
  Sport:     60,
}

/** A held or carried effort is its own rest — the set already cost time. */
const TIMED_REST = 45

/**
 * How long to rest after this exercise, in seconds.
 *
 * `trackingType` matters as much as the lift's name: a 45-second plank and a
 * heavy triple are both "one set" and they are not the same demand.
 */
export function restSecondsFor(
  ex: Pick<ExerciseTemplate, 'name' | 'load'> | null | undefined,
  phaseName: string | null | undefined,
  trackingType?: TrackingType,
): number {
  if (trackingType === 'time' || trackingType === 'distance') return TIMED_REST
  if (!ex) return DEFAULT_REST_SECONDS

  const phase = (phaseName && phaseName in MAIN_LIFT_REST ? phaseName : null) as PhaseName | null
  if (!phase) return DEFAULT_REST_SECONDS

  // Two ways a session says "this one is the work": the lift's name, or the
  // program's own load stamp. But an explicit LIGHT stamp overrides the name —
  // a light goblet squat is warm-up or accessory work and does not need three
  // minutes just because "squat" appears in it. The program saying "light" is
  // more specific than a regex saying "squat".
  if (ex.load === 'light' || ex.load === 'bodyweight') return ACCESSORY_REST[phase]
  const isMain = ex.load === 'heavy' || MAIN_LIFT.test(ex.name)
  return isMain ? MAIN_LIFT_REST[phase] : ACCESSORY_REST[phase]
}

/** Clamp any rest value into the sane band. */
export function clampRest(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_REST_SECONDS
  return Math.max(MIN_REST_SECONDS, Math.min(MAX_REST_SECONDS, Math.round(seconds)))
}

/** Nudge a running rest by one step, clamped. */
export function adjustRest(seconds: number, steps: number): number {
  return clampRest(seconds + steps * REST_STEP_SECONDS)
}

/** "3:00" / "1:30" / "0:45" — the clock, as it reads on the pill. */
export function formatRest(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
