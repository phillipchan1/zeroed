// =============================================================================
// PRESCRIPTION — the deterministic half of "how hard, and how much load".
//
// Pure, no I/O, no Supabase. Everything here is arithmetic and policy: how hard
// a block is meant to feel, whether a week earned more load, how far a single
// lift steps, whether a limiter still gets to cap anything, and what would clear
// it. index.ts does the reading and writing; this file does the deciding.
//
// It lives apart from index.ts so the numbers can be checked without a database
// (see prescription.check.ts). These rules used to be scattered through a 4,000
// line module with no way to exercise them, which is how the app ended up
// prescribing a Strength block at RPE 7–8 while separately treating anything
// above 6.5 as evidence the athlete was overreaching.
// =============================================================================

import type {
  PhaseName, ExerciseTemplate, SetLog, InsightRow, InsightStatus,
  WeeklyDirective, WeeklyPrescription, ClearanceTest,
} from '../types/database.ts'
import { isClearanceTest } from '../types/database.ts'
import { convertWeight, roundToIncrement, type UnitContext, type WeightUnit } from '../lib/units.ts'
import { resolveCategory } from './exerciseLibrary.ts'
import { MAIN_LIFT } from './weekDiff.ts'
import { weekAdherence } from './weekStatus.ts'
import { isoInWeek } from './weekDates.ts'
import { estimate1RM } from './prs.ts'

// ────────────────────────────────────────────────────────────────────────────
// FELT-CHIP SEVERITY BANDS — one vocabulary, read the same way everywhere.
// FELT_CHIPS (types/database.ts) scores Easy/Solid 1, Off 2, Hard 3, Tweak 4,
// Pain 5. The band that matters most is the line between 3 and 4: "Hard" is an
// EFFORT report, "Tweak"/"Pain" are INJURY reports. Reading them as the same
// thing is what made a correctly-trained strength block deload itself — in a
// block prescribed at RPE 7–8, "Hard" is the right answer, not a red flag.
// ────────────────────────────────────────────────────────────────────────────
export const SEVERITY_STRONG = 1   // ≤ → the work felt strong (disconfirms a limiter)
export const SEVERITY_HARD = 3     // = → hard but not hurt; effort, never a veto
export const SEVERITY_PAIN = 4     // ≥ → a real pain signal; always a veto

/**
 * The top set, when it says the work was strong: it landed at or under the
 * lift's target RPE with nothing missed anywhere in the lift. This is what
 * "Easy" / "Solid" used to say by hand — the chips are gone from the session,
 * and the set's own RPE says it more precisely. Null for no top set, no RPE on
 * it, an RPE over target, or a missed rep.
 */
export function strongTopSet(sets: SetLog[] | null | undefined, targetRpe: number): SetLog | null {
  const loaded = (sets ?? []).filter((s) => s.done !== false && s.weight != null && s.weight > 0 && (s.reps ?? 0) > 0)
  if (!loaded.length) return null
  if ((sets ?? []).some((s) => (s.missed_reps ?? 0) > 0)) return null
  const top = loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  return top.rpe != null && top.rpe <= targetRpe ? top : null
}

// ────────────────────────────────────────────────────────────────────────────
// THE RPE CONTRACT — one source of truth for how hard a block is MEANT to feel.
//
// This used to be a hardcoded 7 in the directive tree and a hardcoded 6.5/8.5
// pair of thresholds, applied identically to every block. That is what made a
// Strength block unable to progress: the block prescribes RPE 7–8 (see
// PHASE_SCHEMES.rpeLabel in index.ts), so an athlete who trained it exactly as
// written tripped the "too hard" branch every week and could only earn load by
// training EASY. The contract now lives with the phase, and both the weekly tree
// and the per-lift autoregulator read it — so the number the app asks for and
// the number it rewards can never drift apart again.
//
// `ceiling` is the top of the intended band, not a red line: DELOAD fires half a
// point above it, which is where honest effort ends and grinding begins.
// ────────────────────────────────────────────────────────────────────────────
export interface RpeContract { target: number; ceiling: number }

export const PHASE_RPE: Record<PhaseName, RpeContract> = {
  Stability: { target: 6, ceiling: 7 },   // control the pattern
  Strength:  { target: 8, ceiling: 9 },   // moderate–heavy, the block's whole point
  Power:     { target: 7, ceiling: 8 },   // fast, never grindy
  Sport:     { target: 7, ceiling: 9 },   // mixed qualities
}

// No active phase (a brand-new athlete, or a review that spans a phase edge) →
// the pre-contract behaviour, exactly: PROGRESS at ≤6.5, DELOAD at ≥8.5.
export const DEFAULT_RPE_CONTRACT: RpeContract = { target: 6.5, ceiling: 8 }

export function rpeContract(phaseName: string | null | undefined): RpeContract {
  return (phaseName && PHASE_RPE[phaseName as PhaseName]) || DEFAULT_RPE_CONTRACT
}

// ────────────────────────────────────────────────────────────────────────────
// THE WEEKLY TALLY + DIRECTIVE
// ────────────────────────────────────────────────────────────────────────────

export interface WeekWorkout {
  performed_at: string
  rpe: number | null
  actual_weights: Record<string, SetLog[]> | null
}
export interface WeekObservation {
  severity: number
  signal: string
  logged_at: string
}

export interface WeeklyTally {
  planned: number
  done: number
  adherence: number
  avgRPE: number | null
  painCount: number
  hardCount: number
  positiveCount: number
  flagged_categories: string[]
}

const POSITIVE_SIGNAL = /\b(easy|solid|strong|pr)\b/i

export function tallyWeek(
  planned: number,
  workouts: WeekWorkout[],
  observations: WeekObservation[],
  week?: { start?: string; end?: string; weekStart?: string; weekEnd?: string },
): WeeklyTally {
  const start = week?.start ?? week?.weekStart ?? null
  const end = week?.end ?? week?.weekEnd ?? null
  const inRange = (iso: string) => {
    if (!start || !end) return !week
    return isoInWeek(iso, start, end)
  }
  const scoped = workouts.filter((w) => inRange(w.performed_at ?? ''))
  const { done, adherence } = weekAdherence(
    planned,
    scoped.map((w) => ({ routineId: '', performedAt: w.performed_at })),
    start ?? '0000-01-01',
    end ?? '9999-12-31',
  )

  const rpes: number[] = []
  for (const w of scoped) {
    const sets = w.actual_weights ? Object.values(w.actual_weights).flat() : []
    const setRpes = sets.map((s) => s.rpe).filter((r): r is number => r != null)
    if (setRpes.length) rpes.push(...setRpes)
    else if (w.rpe != null) rpes.push(w.rpe) // fall back to the session-level RPE
  }
  const avgRPE = rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10 : null

  // Pain and hard are counted SEPARATELY. Only pain (Tweak/Pain) can veto — a
  // week of hard work is a week of hard work, and the flagged categories the
  // coach narrates should name what hurt, not what was heavy.
  const weekObs = observations.filter((o) => inRange(o.logged_at ?? ''))
  const painObs = weekObs.filter((o) => o.severity >= SEVERITY_PAIN)
  const hardCount = weekObs.filter((o) => o.severity === SEVERITY_HARD).length
  const positiveCount = weekObs.filter((o) => POSITIVE_SIGNAL.test(o.signal)).length
  const flagged_categories = [
    ...new Set(painObs.map((o) => o.signal.split('—')[0].trim()).filter(Boolean)),
  ].slice(0, 5)

  return { planned, done, adherence, avgRPE, painCount: painObs.length, hardCount, positiveCount, flagged_categories }
}

// The §4.3 decision tree — the only place a directive is chosen.
//
// Two athlete-state overrides sit in front of the tree:
//  • injury  — explicit "I'm hurt / taking time off". The engine never infers
//    this; only the athlete declares it. Forces a RECOVERY back-off.
//  • emptyMissed — a completed week with NO logged work. A no-penalty reset so a
//    skipped week never reads as a failure or silently vanishes.
export function decidePrescription(
  t: WeeklyTally,
  opts: { injury?: boolean; emptyMissed?: boolean; phaseName?: string | null } = {},
): WeeklyPrescription {
  const { target, ceiling } = rpeContract(opts.phaseName)
  const deloadAt = ceiling + 0.5
  const holdTarget = Math.round(target)

  if (opts.injury) {
    return {
      directive: 'RECOVERY',
      load_delta_pct: -20,
      rpe_target: 5,
      rationale:
        'You flagged an injury / time off — next week backs load off 20% and caps effort at RPE 5. Recovery is the training right now; we ramp back when the joint is calm.',
    }
  }
  if (opts.emptyMissed || t.done === 0) {
    return {
      directive: 'HOLD (missed)',
      load_delta_pct: 0,
      rpe_target: holdTarget,
      rationale: 'No sessions logged this week — holding load, no penalty. Pick it back up when you can; the week resets clean.',
    }
  }
  if (t.painCount >= 2 || (t.avgRPE != null && t.avgRPE >= deloadAt)) {
    return {
      directive: 'DELOAD',
      load_delta_pct: -10,
      rpe_target: Math.max(5, holdTarget - 2),
      rationale: t.painCount >= 2
        ? `${t.painCount} pain flags this week — backing load off 10% to let the pattern settle.`
        : `Average RPE ${t.avgRPE} is past ${ceiling} — that's grinding, not training. Backing off 10% to recover.`,
    }
  }
  if (t.adherence >= 0.8 && t.avgRPE != null && t.avgRPE <= target && t.painCount === 0) {
    return {
      directive: 'PROGRESS',
      load_delta_pct: 5,
      rpe_target: holdTarget,
      rationale: `Adherence ${Math.round(t.adherence * 100)}% and RPE ${t.avgRPE} against a target of ${target}, no pain${t.hardCount ? ` (${t.hardCount} hard set${t.hardCount === 1 ? '' : 's'} — that's the block working)` : ''} — adding 5%.`,
    }
  }
  if (t.adherence < 0.5) {
    return {
      directive: 'HOLD (missed)',
      load_delta_pct: 0,
      rpe_target: holdTarget,
      rationale: `Only ${t.done}/${t.planned} sessions logged — holding load and resetting the week.`,
    }
  }
  // Nothing decisive. Say WHICH gate held it, so a held week is legible instead
  // of just feeling like the app is being timid.
  const why = t.painCount > 0
    ? `a pain flag this week`
    : t.avgRPE != null && t.avgRPE > target
      ? `RPE ${t.avgRPE} sits above this block's target of ${target}`
      : t.avgRPE == null
        ? `no RPE logged, so there's nothing to autoregulate against`
        : `adherence ${Math.round(t.adherence * 100)}% is short of 80%`
  return {
    directive: 'HOLD',
    load_delta_pct: 0,
    rpe_target: holdTarget,
    rationale: `Holding load — ${why}.`,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// PER-LIFT LOAD
// ────────────────────────────────────────────────────────────────────────────

/**
 * Round a computed load to a real, rackable number IN THE ATHLETE'S OWN UNIT.
 *
 * This used to round to the nearest 5 in every unit, which is only right in
 * pounds: 5 kg is a 11 lb jump, more than twice the smallest step a kg lifter
 * can actually make. The increment now comes from the unit (see loadIncrement).
 */
export function roundLoad(w: number, u: UnitContext): number {
  return roundToIncrement(w, u.unit)
}

/**
 * The concrete recommended working load for a lift — the number to put on the
 * bar. Its last top weight (a STORED number) with the autoregulated delta
 * applied, then converted into the athlete's display unit and rounded to that
 * unit's plate increment. Null when the lift has no weighted history to
 * recommend from.
 *
 * Delta 0 means "repeat what you lifted", so it converts the logged load
 * verbatim rather than racking it — the athlete already made that weight.
 */
export function recommendedLoad(top: SetLog | null, delta: number, u: UnitContext): number | null {
  if (top?.weight == null) return null
  return delta === 0 ? u.show(top.weight) : u.prescribe(top.weight * (1 + delta / 100))
}

/**
 * Per-exercise RPE autoregulation. Turns how far THIS lift's last top set landed
 * from its target into a load nudge — ~3% per RPE point (≈ one RIR ≈ ~3% of load
 * near the top end), clamped. This is what makes "logged RPE 4 on an RPE-8 lift"
 * recommend a heavier weight for THAT lift specifically, while a lift that hit
 * RPE 9 backs off — even in the same week.
 *
 * The target matters enormously and used to be wrong: it fell back to a flat 7
 * regardless of block, so a Strength lift logged at the RPE 8 the block asked
 * for was read as 1 point too hard and marked DOWN 3% every week. Callers pass
 * the block's contract now.
 *
 * A DELOAD week is a hard recovery directive and is never overridden upward.
 * maxUp caps progression by phase (Stability banks load).
 */
export function autoregulateDelta(
  lastRpe: number | null | undefined,
  rpeTarget: number | null,
  weeklyDelta: number,
  directive: WeeklyDirective | null,
  maxUp: number,
): number {
  if (directive === 'DELOAD') return weeklyDelta
  if (lastRpe != null) {
    const target = rpeTarget ?? 7
    const adj = Math.round((target - lastRpe) * 3)
    return Math.max(-10, Math.min(maxUp, adj))
  }
  return Math.max(-10, Math.min(maxUp, weeklyDelta))
}

/** How far a single easy lift may jump in one step, by block. */
export function maxUpFor(phaseName: string | null | undefined): number {
  return phaseName === 'Stability' ? 5 : 15
}

export type TrainingIntent =
  | 'work' | 'speed' | 'technique' | 'prehab' | 'test' | 'deload'
  | 'explosive' | 'mobility' | 'warmup' | 'primer' | 'tempo' | 'opener' | 'activation'

const INTENT_RULES: Array<{ intent: TrainingIntent; re: RegExp }> = [
  { intent: 'deload', re: /\bdeload\b/i },
  { intent: 'warmup', re: /\b(warm[\s-]?up|warmup)\b/i },
  { intent: 'primer', re: /\bprimer\b/i },
  { intent: 'opener', re: /\bopener\b/i },
  { intent: 'activation', re: /\bactivat(?:e|ion|ing)\b/i },
  { intent: 'mobility', re: /\bmobility\b/i },
  { intent: 'tempo', re: /\btempo\b/i },
  { intent: 'explosive', re: /\bexplosive\b/i },
  { intent: 'speed', re: /\b(speed|velocity|dynamic[\s-]?effort|\bde\b)\b/i },
  { intent: 'technique', re: /\b(technique|tech work|form work|groove)\b/i },
  { intent: 'prehab', re: /\b(prehab|rehab|corrective)\b/i },
  { intent: 'test', re: /\b(baseline|retest|\btest\b)\b/i },
]

/** Classify a session or lift from the words the program used. */
export function trainingIntent(...texts: Array<string | null | undefined>): TrainingIntent {
  const hay = texts.filter(Boolean).join(' ')
  for (const { intent, re } of INTENT_RULES) {
    if (re.test(hay)) return intent
  }
  return 'work'
}

export interface ParsedPrescription {
  load: number | null
  loadUnit: WeightUnit | null
  percent: number | null
  rpe: number | null
  sets: number | null
  reps: number | null
  qualitative: boolean
  ambiguous: boolean
}

const EMPTY_PARSE: ParsedPrescription = {
  load: null, loadUnit: null, percent: null, rpe: null,
  sets: null, reps: null, qualitative: false, ambiguous: false,
}

const QUALITATIVE = /^(light|moderate|heavy|bodyweight|bw)$/i
const SETS_REPS = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*(lbs?|kg|#)\b)?/i
const MAX_REALISTIC_SETS = 10
const MAX_REALISTIC_REPS = 30
const MIN_BARE_LOAD = 20
const PERCENT = /(\d+(?:\.\d+)?)\s*(?:[-–—]\s*(\d+(?:\.\d+)?))?\s*%(?:\s*(?:of\s+)?1\s*rm)?/i
const RPE = /\brpe\s*[:\s]*(\d+(?:\.\d+)?)/i
const LOAD_UNIT = /(?:(?:about|approx(?:imately)?|around)\s+)?~?\s*(\d+(?:\.\d+)?)\s*(lbs?|kg|#)\b/i
const LOAD_APPROX = /(?:(?:about|approx(?:imately)?|around)\s+|~)\s*(\d+(?:\.\d+)?)/i
const AT_RPE = /@\s*(\d+(?:\.\d+)?)\b/

/**
 * Split a prescription into sets×reps, bar load, RPE and % — independently,
 * in any order. A unit (lb/kg) always wins over a bare number. A percentage
 * is never a poundage. Fail-safe: leftover unclassified loads mark ambiguous.
 */
export function parsePrescription(load: string | null | undefined): ParsedPrescription {
  if (!load) return { ...EMPTY_PARSE }
  const trimmed = load.trim()
  if (!trimmed) return { ...EMPTY_PARSE }
  if (QUALITATIVE.test(trimmed)) return { ...EMPTY_PARSE, qualitative: true }

  let rest = trimmed
  const out: ParsedPrescription = { ...EMPTY_PARSE }

  const sxr = rest.match(SETS_REPS)
  if (sxr) {
    const left = Number(sxr[1])
    const right = Number(sxr[2])
    const unitTok = sxr[3]
    const unit: WeightUnit | null = unitTok
      ? (unitTok.toLowerCase() === 'kg' ? 'kg' : 'lb')
      : null
    const leftSets = left >= 1 && left <= MAX_REALISTIC_SETS
    const rightReps = right >= 1 && right <= MAX_REALISTIC_REPS
    const leftLoad = left >= MIN_BARE_LOAD
    const rightLoad = right >= MIN_BARE_LOAD
    // In NxM, a number outside realistic sets (>10) or reps (>30) is a load.
    // A unit on the right number always wins. 3x25 is both 25 reps and 25 lb
    // — ambiguous, no +5% unless a separate load is given.
    if (unit) {
      out.load = right
      out.loadUnit = unit
      if (leftSets) out.sets = left
      else out.ambiguous = true
    } else if (!leftSets && leftLoad && rightReps) {
      out.load = left
      out.reps = right
    } else if (leftSets && right > MAX_REALISTIC_REPS) {
      out.sets = left
      out.load = right
    } else if (leftSets && rightReps && rightLoad) {
      out.sets = left
      out.reps = right
      out.ambiguous = true
    } else if (leftSets && rightReps) {
      out.sets = left
      out.reps = right
    } else {
      out.ambiguous = true
    }
    rest = rest.replace(sxr[0], ' ')
  }

  const pct = rest.match(PERCENT)
  if (pct) {
    const a = Number(pct[1])
    const b = pct[2] != null ? Number(pct[2]) : a
    if (Number.isFinite(a) && Number.isFinite(b)) out.percent = (a + b) / 2
    rest = rest.replace(pct[0], ' ')
  }

  const rpeM = rest.match(RPE)
  if (rpeM) {
    const n = Number(rpeM[1])
    if (n > 0 && n <= 10) out.rpe = n
    rest = rest.replace(rpeM[0], ' ')
  }

  const unitM = rest.match(LOAD_UNIT)
  if (unitM) {
    const n = Number(unitM[1])
    if (Number.isFinite(n) && n > 0) {
      out.load = n
      const u = unitM[2].toLowerCase()
      out.loadUnit = u === 'kg' ? 'kg' : 'lb'
    }
    rest = rest.replace(unitM[0], ' ')
  }

  if (out.load == null) {
    const approx = rest.match(LOAD_APPROX)
    if (approx) {
      const n = Number(approx[1])
      if (Number.isFinite(n) && n >= 20) out.load = n
      rest = rest.replace(approx[0], ' ')
    }
  }

  if (out.rpe == null) {
    const at = rest.match(AT_RPE)
    if (at) {
      const n = Number(at[1])
      if (n > 0 && n <= 10 && out.percent == null) out.rpe = n
      rest = rest.replace(at[0], ' ')
    }
  }

  if (out.load == null && out.percent == null) {
    const bare = rest.match(/(\d+(?:\.\d+)?)/)
    if (bare) {
      const n = Number(bare[1])
      if (Number.isFinite(n) && n >= 20) {
        out.load = n
        rest = rest.replace(bare[0], ' ')
      }
    }
  }

  const leftovers = [...rest.matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => Number(m[0]))
    .filter((n) => Number.isFinite(n) && n >= 20)
  if (leftovers.length) out.ambiguous = true

  const parsedNumber = out.load != null || out.percent != null || out.rpe != null
    || out.sets != null || out.reps != null
  // Exact light/moderate/heavy/bodyweight stay qualitative. Any other
  // non-empty text with no number ("heavy-ish", "top set", "work up")
  // is ambiguous — never +5%. Empty load is left alone.
  if (!parsedNumber && !out.qualitative) out.ambiguous = true

  return out
}

/**
 * Bar weight from a prescription string. Percentages are never pounds.
 * Ambiguous or RPE/%-only strings return null.
 */
export function parseExplicitLoad(load: string | null | undefined): number | null {
  const p = parsePrescription(load)
  if (p.ambiguous) return null
  if (p.percent != null && p.load == null) return null
  return p.load
}

export function allowsAutoProgress(opts: {
  exercise: Pick<ExerciseTemplate, 'name' | 'load' | 'target_rpe'>
  sessionIntent?: string | null
  sessionName?: string | null
  directive?: WeeklyDirective | null
}): boolean {
  if (opts.directive === 'DELOAD' || opts.directive === 'RECOVERY') return false
  const parsed = parsePrescription(opts.exercise.load)
  if (parsed.ambiguous) return false
  if (parsed.load != null || parsed.percent != null || parsed.rpe != null) return false
  const intent = trainingIntent(opts.sessionIntent, opts.sessionName, opts.exercise.name, opts.exercise.load)
  if (intent !== 'work') return false
  if (opts.exercise.target_rpe != null && opts.exercise.target_rpe <= 5) return false
  return true
}

/** Last logged top set is only a base when it was the same lift and the same intent. */
export function isComparableWorkingBase(opts: {
  currentIntent: TrainingIntent
  lastIntent?: TrainingIntent | null
  lastRpe?: number | null
  lastWeight?: number | null
  prescribedWeight?: number | null
}): boolean {
  const last = opts.lastIntent
    ?? ((opts.lastRpe != null && opts.lastRpe >= 7) ||
        (opts.prescribedWeight != null && opts.lastWeight != null && opts.lastWeight > opts.prescribedWeight * 1.15)
      ? 'work'
      : opts.currentIntent)
  return last === opts.currentIntent
}

export type ProjectedLoadSource = 'explicit' | 'progressed' | 'held' | 'none'

export interface ProjectedLoad {
  weight: number | null
  source: ProjectedLoadSource
}

function storedBarWeight(parsed: ParsedPrescription, u: UnitContext): number | null {
  if (parsed.load == null) return null
  const from = parsed.loadUnit ?? u.unit
  return convertWeight(parsed.load, from, u.storage)
}

function resolveOneRm(opts: {
  oneRm?: number | null
  lastWeight?: number | null
  lastReps?: number | null
}): number | null {
  if (opts.oneRm != null && opts.oneRm > 0) return opts.oneRm
  if (opts.lastWeight != null && opts.lastReps != null && opts.lastReps >= 1) {
    return estimate1RM(opts.lastWeight, opts.lastReps)
  }
  return null
}

/**
 * What next week should put on the bar.
 *
 * An explicit load, %, or RPE always wins. Auto +5% never runs on a deload
 * week, on non-progressive intents, or off a top set logged under a different
 * intent. Ambiguous parses fail safe: no progression.
 */
export function projectExerciseLoad(opts: {
  exercise: Pick<ExerciseTemplate, 'name' | 'sets' | 'reps' | 'load' | 'target_rpe'>
  lastWeight: number | null
  lastRpe?: number | null
  lastReps?: number | null
  lastIntent?: TrainingIntent | null
  oneRm?: number | null
  weeklyDelta: number
  directive: WeeklyDirective | null
  sessionIntent?: string | null
  sessionName?: string | null
  u: UnitContext
}): ProjectedLoad {
  const parsed = parsePrescription(opts.exercise.load)
  if (parsed.ambiguous) return { weight: null, source: 'none' }

  const stored = storedBarWeight(parsed, opts.u)
  if (stored != null) {
    return { weight: opts.u.prescribe(stored), source: 'explicit' }
  }

  if (parsed.percent != null) {
    const max = resolveOneRm(opts)
    if (max == null) return { weight: null, source: 'explicit' }
    return { weight: opts.u.prescribe(max * parsed.percent / 100), source: 'explicit' }
  }

  const currentIntent = trainingIntent(opts.sessionIntent, opts.sessionName, opts.exercise.name, opts.exercise.load)
  const canProgress = allowsAutoProgress({
    exercise: opts.exercise,
    sessionIntent: opts.sessionIntent,
    sessionName: opts.sessionName,
    directive: opts.directive,
  })
  const comparable = opts.lastWeight != null && isComparableWorkingBase({
    currentIntent,
    lastIntent: opts.lastIntent,
    lastRpe: opts.lastRpe,
    lastWeight: opts.lastWeight,
    prescribedWeight: stored,
  })

  if (!canProgress || !comparable) {
    if (opts.lastWeight != null && comparable && !canProgress) {
      return { weight: opts.u.show(opts.lastWeight), source: 'held' }
    }
    return { weight: null, source: 'none' }
  }

  const progressed = recommendedLoad(
    { set: 1, weight: opts.lastWeight, reps: null, rpe: opts.lastRpe ?? null, done: true },
    opts.weeklyDelta,
    opts.u,
  )
  return { weight: progressed, source: progressed == null ? 'none' : 'progressed' }
}

// ────────────────────────────────────────────────────────────────────────────
// LIMITER SCOPE + STATUS
// ────────────────────────────────────────────────────────────────────────────

export const P1_RESOLVE_THRESHOLD = 0.30   // limiter confidence at/below this → resolved
export const P1_DISCONFIRM_STEP = 0.15     // bounded step per strong, pain-free session

const STATUS_THRESHOLDS = { likely: 0.50, confirmed: 0.80 } as const

/**
 * Given a current status and a (possibly nudged) confidence, returns the new
 * status if a threshold was crossed, otherwise null.
 *
 * This moves in BOTH directions. It used to only ever advance, which produced a
 * one-way ratchet: evidence could raise a read to "confirmed" but no amount of
 * contrary evidence could ever retire one. A limiter's confidence could be ground
 * down session after session to almost nothing and the row would sit there at
 * "hypothesis" forever, still capping load, because nothing was allowed to say
 * the words. Falling to the resolve threshold IS the system changing its mind,
 * and it should be able to.
 */
export function advanceStatus(current: InsightStatus, confidence: number): InsightStatus | null {
  if (current === 'resolved' || current === 'disproved') return null   // terminal
  if (confidence <= P1_RESOLVE_THRESHOLD) return 'resolved'
  if (current === 'hypothesis' && confidence >= STATUS_THRESHOLDS.confirmed) return 'confirmed'
  if (current === 'hypothesis' && confidence >= STATUS_THRESHOLDS.likely)    return 'likely'
  if (current === 'likely'     && confidence >= STATUS_THRESHOLDS.confirmed) return 'confirmed'
  return null
}

/**
 * Does this exercise address the limiter? Returns null for "no opinion" — an
 * exercise the library hasn't curated and whose name says nothing. Callers pick
 * their own default for null, because the safe answer differs by direction:
 * when STAMPING a new phase, null means don't claim the lift serves the read;
 * when READING an existing phase, null means trust what was already recorded.
 */
export function addressesLimiter(
  exerciseName: string,
  limiterCategory: string | null | undefined,
): boolean | null {
  if (!limiterCategory) return false
  const cat = resolveCategory(exerciseName)
  return cat === null ? null : cat === limiterCategory
}

/**
 * Whether a limiter still gets to cap load. Gated on CONFIDENCE, not merely on
 * the row existing: the cap used to fire for any insight that wasn't explicitly
 * resolved, which meant a read the system had already argued itself out of — 12%
 * confident, still technically "a hypothesis" — capped load exactly as hard as
 * one it was sure about. A belief that weak has no business holding a barbell
 * down.
 */
export function capIsActive(p1: InsightRow | null | undefined): boolean {
  return !!p1 && p1.confidence >= P1_RESOLVE_THRESHOLD
}

/**
 * Whether THIS lift is held. Requires a live cap, the program's own attribution,
 * and that the lift genuinely trains the limiter's chain. `addressesLimiter`
 * returning null means the library has no opinion about the movement, in which
 * case we trust the stamp the program already carries rather than inventing an
 * answer in either direction.
 */
export function isLiftHeld(
  ex: ExerciseTemplate,
  p1: InsightRow | null | undefined,
  capActive: boolean,
): boolean {
  if (!capActive || !p1) return false
  const stamped = !!ex.insight_id && ex.insight_id === p1.id
  if (!stamped) return false
  return addressesLimiter(ex.name, p1.category) !== false
}

// ────────────────────────────────────────────────────────────────────────────
// THE CLEARANCE TEST — the door in the wall.
//
// "Load stays capped until the pattern clears" is only fair if the athlete can
// find out what clearing it takes. This states the exit condition as a concrete,
// dated, falsifiable claim on ONE named lift, tracks it session by session, and
// either retires the limiter or reconfirms it out loud.
//
// Doctrine: code owns the criteria and the arithmetic. The agent is not asked
// what would clear a limiter; it is at most asked to phrase the answer.
// ────────────────────────────────────────────────────────────────────────────

// A qualifying session needs this many top sets at or above the block's target
// RPE, pain-free; this many such sessions closes the test out. Deliberately
// small: the test has to be reachable inside one training week, or it is just
// the same wall with a countdown painted on it.
export const CLEARANCE_TOP_SETS = 2
export const CLEARANCE_SESSIONS = 2

/** The open clearance test on an insight, if any. */
export function clearanceTestOf(insight: InsightRow | null | undefined): ClearanceTest | null {
  if (!insight || !Array.isArray(insight.evidence)) return null
  for (let i = insight.evidence.length - 1; i >= 0; i--) {
    const e = insight.evidence[i]
    if (isClearanceTest(e) && e.status === 'open') return e
  }
  return null
}

/**
 * Which lift should carry the proof: a main lift that trains the limiter's chain
 * and is actually programmed this block, preferring one the athlete already has
 * a logged base for.
 */
export function pickClearanceLift(
  exercises: ExerciseTemplate[],
  limiterCategory: string,
  hasHistory: (name: string) => boolean,
): string | null {
  const onChain = exercises.filter((ex) => addressesLimiter(ex.name, limiterCategory) === true)
  if (!onChain.length) return null
  const mains = onChain.filter((ex) => MAIN_LIFT.test(ex.name))
  const pool = mains.length ? mains : onChain
  return (pool.find((ex) => hasHistory(ex.name)) ?? pool[0]).name
}

/** Human-readable exit condition — the sentence the athlete actually reads. */
export function describeClearanceTest(t: ClearanceTest): string {
  const { top_sets, min_rpe, sessions } = t.criterion
  return `${top_sets} top set${top_sets === 1 ? '' : 's'} at RPE ${min_rpe}+ on ${t.lift}, pain-free, across ${sessions} sessions.`
}

export function newClearanceTest(lift: string, minRpe: number, openedAt: string): ClearanceTest {
  return {
    kind: 'clearance_test',
    lift,
    criterion: { top_sets: CLEARANCE_TOP_SETS, min_rpe: minRpe, sessions: CLEARANCE_SESSIONS, pain_free: true },
    opened_at: openedAt,
    sessions_passed: 0,
    status: 'open',
    log: [],
  }
}

/** How a single logged session scored against a clearance test, on one lift. */
export interface LiftAttempt {
  name: string
  qualifying: number   // sets at/above the test's min RPE
  pain: boolean
}

/**
 * Resolve one session's attempts into a verdict. Pure so the arithmetic — which
 * lift gets the credit, whether pain overrides a good day, whether the test
 * closes — can be checked without a database.
 */
export function judgeClearanceSession(
  test: ClearanceTest,
  attempts: LiftAttempt[],
): { relevant: boolean; passed: boolean; painOnLift: boolean; provedOn: string; qualifying: number } {
  if (!attempts.length) {
    return { relevant: false, passed: false, painOnLift: false, provedOn: test.lift, qualifying: 0 }
  }
  // Pain anywhere on the tested chain is decisive on its own — it confirms the
  // limiter, and no number of hard sets outweighs it.
  const painEntry = attempts.find((a) => a.pain) ?? null
  const bestClean = attempts.filter((a) => !a.pain)
    .reduce<LiftAttempt | null>((best, a) => (best && best.qualifying >= a.qualifying ? best : a), null)

  const painOnLift = !!painEntry
  const qualifying = painOnLift ? 0 : bestClean?.qualifying ?? 0
  const passed = !painOnLift && qualifying >= test.criterion.top_sets
  return {
    relevant: passed || painOnLift,
    passed,
    painOnLift,
    provedOn: painEntry?.name ?? bestClean?.name ?? test.lift,
    qualifying,
  }
}
