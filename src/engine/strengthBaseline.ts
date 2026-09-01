// =============================================================================
// STRENGTH BASELINE — you already tested these. Read the log.
//
// The retest used to ask for four numbers: an estimated 1RM for "Back Squat",
// "Deadlift / hinge", "Press", "Pull / row", plus a plank hold. Three things
// were wrong with that, and they compound:
//
//   1. CUMBERSOME. "Estimated 1-rep max" on a lift you train at RPE 8 for fives
//      means going and testing something, or guessing. Neither is training.
//   2. AMBIGUOUS. "Press" is not a lift. If the athlete benches and overhead
//      presses, which one is it? The number they type answers a question the
//      app never actually asked precisely.
//   3. INERT. Of the five fields, exactly two were ever read — a squat:hinge
//      ratio check that mints one insight. Push, pull and plank were collected
//      at every retest and read by nothing, ever. And no strength number was
//      EVER compared across versions, so the retest could not tell you that
//      your squat had gone up. The one thing it was for.
//
// The athlete has been testing these lifts all along: every top set is a data
// point and `gatherExerciseBests` already knows the best one. So the strength
// half of a retest stops being a test and becomes a CONFIRMATION — here is what
// your log says, here is what it said last time, correct it if it's wrong.
//
// Pure, no I/O (see strengthBaseline.check.ts). The read that feeds it lives in
// index.ts as `gatherStrengthBaseline`.
// =============================================================================

import type { DiagnosticResults } from '../types/database.ts'
import { estimate1RM, type LiftBest } from './prs.ts'

/**
 * The four movement slots the read reasons in. Deliberately the same four the
 * old fixed battery used, so `generateInsightsFromDiagnostic`'s squat:hinge
 * ratio check keeps working — it just gets a logged number instead of a guess.
 */
export type StrengthSlot = 'squat' | 'hinge' | 'push' | 'pull'

/** The legacy key each slot writes, so old readers and old rows still line up. */
export const SLOT_KEY: Record<StrengthSlot, string> = {
  squat: 'squat_1rm_est',
  hinge: 'hinge_1rm_est',
  push:  'push_1rm_est',
  pull:  'pull_1rm_est',
}

// First match wins, so order matters: "Leg Press" is a squat pattern, not a
// press, and "Pull-Up" is a pull before "up" can mean anything else.
const SLOT_PATTERNS: Array<[RegExp, StrengthSlot]> = [
  [/\b(squat|leg\s*press|hack|split\s*squat|lunge|step[-\s]?up)\b/i, 'squat'],
  [/\b(deadlift|rdl|romanian|good\s*morning|hip\s*thrust|hinge|swing|back\s*extension|nordic)\b/i, 'hinge'],
  [/\b(row|pull[-\s]?up|chin[-\s]?up|pulldown|pull[-\s]?down|face\s*pull|curl)\b/i, 'pull'],
  [/\b(bench|press|dip|push[-\s]?up|fly|raise|extension)\b/i, 'push'],
]

/** Which slot a lift belongs to, or null when it isn't a main strength pattern. */
export function slotOf(exerciseName: string): StrengthSlot | null {
  for (const [re, slot] of SLOT_PATTERNS) if (re.test(exerciseName)) return slot
  return null
}

/** One lift the athlete actually trains, with what their log says about it. */
export interface BaselineLift {
  /** The lift's real name, as it appears in their program. */
  name: string
  slot: StrengthSlot
  /** Best estimated 1RM from the log, in STORAGE units. Null if never loaded. */
  e1rm: number | null
  /** The set that produced it, for "225 × 5" under the number. */
  topWeight: number | null
  topReps: number | null
  /** What the last retest recorded for this lift, if anything. */
  previous: number | null
}

/** How much a lift moved since the last retest. */
export interface StrengthDelta {
  name: string
  from: number
  to: number
  pct: number
}

/**
 * Build the baseline from the athlete's own lifts and their logged bests.
 *
 * `order` decides which lifts survive the cap: one per slot first, so a lifter
 * whose program is four pressing variations doesn't get a "strength baseline"
 * that is four benches and no squat. Lifts with no loaded history are dropped —
 * an empty row is a question, and the whole point is to stop asking.
 */
export function buildBaseline(
  exerciseNames: Iterable<string>,
  bests: Record<string, LiftBest>,
  previous: Record<string, number | null> = {},
  maxLifts = 5,
): BaselineLift[] {
  const candidates: BaselineLift[] = []
  const seen = new Set<string>()

  for (const name of exerciseNames) {
    if (seen.has(name)) continue
    seen.add(name)
    const slot = slotOf(name)
    if (!slot) continue
    const best = bests[name]
    if (!best || best.weight == null) continue
    const e1rm = best.e1rm ?? (best.repsAtBest != null ? estimate1RM(best.weight, best.repsAtBest) : best.weight)
    candidates.push({
      name,
      slot,
      e1rm,
      topWeight: best.weight,
      topReps: best.repsAtBest,
      previous: previous[name] ?? null,
    })
  }

  // Heaviest first within a slot — the main lift, not the accessory.
  candidates.sort((a, b) => (b.e1rm ?? 0) - (a.e1rm ?? 0))

  // One per slot first, then fill the remaining places with whatever is next.
  const picked: BaselineLift[] = []
  const usedSlots = new Set<StrengthSlot>()
  for (const c of candidates) {
    if (usedSlots.has(c.slot)) continue
    usedSlots.add(c.slot)
    picked.push(c)
    if (picked.length >= maxLifts) return picked
  }
  for (const c of candidates) {
    if (picked.includes(c)) continue
    picked.push(c)
    if (picked.length >= maxLifts) break
  }
  return picked
}

/**
 * The `strength` map a diagnostic stores.
 *
 * Written TWICE on purpose: once under the lift's real name (so the next retest
 * can say "your Back Squat went 263 → 291" rather than "your push went up") and
 * once under the canonical slot key (so the existing ratio check, and every row
 * already in the database, keep meaning the same thing). The slot value is the
 * heaviest lift in that slot, which is the one the ratio check wants anyway.
 */
export function toStrengthMap(lifts: BaselineLift[]): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  const bySlot: Partial<Record<StrengthSlot, number>> = {}
  for (const l of lifts) {
    if (l.e1rm == null) continue
    out[l.name] = l.e1rm
    const cur = bySlot[l.slot]
    if (cur == null || l.e1rm > cur) bySlot[l.slot] = l.e1rm
  }
  for (const [slot, value] of Object.entries(bySlot)) {
    out[SLOT_KEY[slot as StrengthSlot]] = value ?? null
  }
  return out
}

const LEGACY_KEYS = new Set<string>([...Object.values(SLOT_KEY), 'plank_secs'])

/** The named lifts in a stored strength map, ignoring the canonical slot keys. */
export function namedLifts(strength: Record<string, number | null> | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(strength ?? {})) {
    if (!LEGACY_KEYS.has(k)) out[k] = v
  }
  return out
}

/**
 * What moved between two diagnostics. Compares named lifts first — the honest
 * comparison, same lift to same lift — and falls back to the canonical slots so
 * a retest against a pre-existing diagnostic still has something to say.
 *
 * Only improvements above a floor are reported. e1RM is an estimate, and a 1%
 * move is inside its own error bar; calling that "progress" is the same kind of
 * lie as calling a tied set a PR.
 */
export const MEANINGFUL_GAIN_PCT = 2

/**
 * How much a lift moved, or null if it didn't move enough to say so.
 *
 * ONE definition, shared by the retest step and the retest summary. They had two
 * — the step rounded first and asked "is it ≥ 2?", the summary asked "is the raw
 * value ≥ 2?" — so a bench that went 258 → 263 (1.94%) was announced as "+2%
 * since last retest" on the way in and then silently dropped from the list of
 * what got stronger on the way out. Exactly the class of split definition this
 * audit has been closing everywhere else.
 */
export function gainPct(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || from <= 0 || to <= 0) return null
  const pct = ((to - from) / from) * 100
  return pct < MEANINGFUL_GAIN_PCT ? null : Math.round(pct)
}

export function strengthDeltas(
  prior: DiagnosticResults['strength'] | undefined,
  current: DiagnosticResults['strength'] | undefined,
): StrengthDelta[] {
  if (!prior || !current) return []
  const out: StrengthDelta[] = []

  const compare = (keys: Iterable<string>, label?: (k: string) => string) => {
    for (const k of keys) {
      const from = prior[k]
      const to = current[k]
      const pct = gainPct(from, to)
      if (pct == null) continue
      out.push({ name: label ? label(k) : k, from: from!, to: to!, pct })
    }
  }

  const named = Object.keys(namedLifts(current))
  if (named.length) compare(named)
  // Nothing named in common (a first retest against a legacy row) — fall back.
  if (!out.length) {
    compare(Object.values(SLOT_KEY), (k) => {
      const slot = (Object.keys(SLOT_KEY) as StrengthSlot[]).find((s) => SLOT_KEY[s] === k)
      return slot ? slot[0].toUpperCase() + slot.slice(1) : k
    })
  }

  return out.sort((a, b) => b.pct - a.pct)
}
