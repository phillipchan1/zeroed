/**
 * Which logged work moves which goal. Pure — the commit writes, the finish
 * screen shows, MCP validates, all from these functions.
 *
 * A goal's `source_metric` names the metric and the exercise that feed it:
 *
 *   e1rm:Bench Press             estimated 1RM off the reps × RPE chart
 *   relative_e1rm:Pull-Up        estimated 1RM ÷ bodyweight (pull-ups add bodyweight)
 *   reps_to_failure:Pull-Up      reps + reps left in the tank (8 @8 is 10)
 *   top_set:Strict Press         heaviest completed set
 *   reps:Pull-up                 most reps in a completed set
 *   distance:Broad Jump          best completed rep
 *   time:Plank                   longest hold (shortest, for a lower-is-better goal)
 *   rounds:Alactic Bike          completed rounds
 *   output:Assault Bike          mean output per round (cal, m or W)
 *   fade:Assault Bike            last round's output ÷ first's, as a percent
 *   success_rate:Free Throw      makes ÷ attempts, as a percent (10+ attempts)
 *   test:Hip IR                  manual only; no session ever writes it
 *
 * Two families of kinds. ROLLING kinds (e1rm, relative_e1rm, reps_to_failure,
 * output, fade, success_rate) are estimates or rates: every usable session
 * writes, and the goal's current is a recency- and tier-weighted read of them
 * (capacity.ts). BEST kinds (top_set, reps, distance, time, rounds) are
 * max-intent marks: a session writes only when it holds or beats the mark.
 *
 * Goals written before the binding existed have none, so one is inferred from
 * the goal's name and unit against the session's exercise names. A sided goal
 * (L / R) is a manual test: sets don't carry a side.
 */
import { goalNumber, type GoalFields } from './goals.ts'
import {
  fadeEvidence, formatEvidenceNote, isProof, outputEvidence, repsToFailureEvidence, strengthEvidence,
  successRateEvidence, type Evidence, type EvidenceSet, type EvidenceTier,
} from './evidence.ts'
import { findLibraryExercise } from './exerciseLibrary.ts'
import { canonicalLift, pairsTo, ratioFor } from './liftFamilies.ts'

export const SOURCE_KINDS = [
  'e1rm', 'relative_e1rm', 'reps_to_failure', 'top_set', 'reps', 'distance', 'time', 'rounds',
  'output', 'fade', 'success_rate', 'test',
] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** Kinds read as a rolling estimate or rate: every usable session writes. */
export const ROLLING_KINDS: readonly SourceKind[] = ['e1rm', 'relative_e1rm', 'reps_to_failure', 'output', 'fade', 'success_rate']

export function isRollingKind(kind: SourceKind | null | undefined): boolean {
  return kind != null && ROLLING_KINDS.includes(kind)
}

export interface GoalSource {
  kind: SourceKind
  exercise: string | null
  /** True when read off the goal's name and unit, not a stored binding. */
  inferred: boolean
}

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === 'string' && (SOURCE_KINDS as readonly string[]).includes(v)
}

export function normalizeExerciseName(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** "e1rm:Bench Press" → { kind: 'e1rm', exercise: 'Bench Press' }. Null if unreadable. */
export function parseGoalSource(raw: string | null | undefined): GoalSource | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const at = text.indexOf(':')
  const kind = (at === -1 ? text : text.slice(0, at)).trim().toLowerCase()
  const exercise = at === -1 ? '' : text.slice(at + 1).trim()
  if (!isSourceKind(kind)) return null
  if (kind !== 'test' && !exercise) return null
  return { kind, exercise: exercise || null, inferred: false }
}

/** The same binding written back, so MCP and the app store one spelling. */
export function formatGoalSource(src: Pick<GoalSource, 'kind' | 'exercise'>): string {
  return src.exercise ? `${src.kind}:${src.exercise}` : src.kind
}

const STEM_NOISE = /\b(e1rm|1rm|1 rm|rm|max|pr|best|top set|test|l|r)\b/g

function kindFromUnit(goal: Pick<GoalFields, 'name' | 'metric' | 'unit'>): SourceKind | null {
  const metric = String(goal.metric ?? '').toLowerCase()
  const unit = String(goal.unit ?? '').trim().toLowerCase()
  if (['xbw', 'x bw', '×bw', 'bw'].includes(unit)) return 'relative_e1rm'
  if (/e1rm|1rm/.test(metric)) return 'e1rm'
  if (['cal', 'cals', 'kcal', 'w', 'watts'].includes(unit)) return 'output'
  if (unit === '%') return /fade|drop/.test(`${metric} ${String(goal.name ?? '').toLowerCase()}`) ? 'fade' : 'success_rate'
  if (unit === 'lb' || unit === 'lbs' || unit === 'kg') return 'top_set'
  if (['in', 'inch', 'inches', 'cm', 'm', 'ft'].includes(unit)) return 'distance'
  if (['s', 'sec', 'secs', 'seconds'].includes(unit)) return 'time'
  if (['rounds', 'round', 'rds'].includes(unit)) return 'rounds'
  if (unit === 'reps') return 'reps'
  return null
}

/**
 * Read a binding off the goal's name and unit, against the session's exercises.
 * Exact names only: a "Deadlift" goal must not be fed by a Trap Bar Deadlift
 * session. A goal named for a lift the program spells differently ("Bench 1RM"
 * against Bench Press) needs an explicit source_metric, which get_goal_brief
 * asks Claude to set.
 */
export function inferGoalSource(
  goal: Pick<GoalFields, 'name' | 'metric' | 'unit' | 'side'>,
  exerciseNames: string[],
): GoalSource | null {
  if (goal.side === 'L' || goal.side === 'R') return null
  const kind = kindFromUnit(goal)
  if (!kind) return null
  const stem = normalizeExerciseName(goal.name).replace(STEM_NOISE, ' ').replace(/\s+/g, ' ').trim()
  if (stem.length < 4) return null
  const match = exerciseNames.find((n) => normalizeExerciseName(n) === stem)
  return match ? { kind, exercise: match, inferred: true } : null
}

export function goalSource(
  goal: Pick<GoalFields, 'name' | 'metric' | 'unit' | 'side'> & { source_metric?: string | null },
  exerciseNames: string[],
): GoalSource | null {
  return parseGoalSource(goal.source_metric) ?? inferGoalSource(goal, exerciseNames)
}

export function sourceMatches(src: GoalSource, exerciseName: string): boolean {
  return src.exercise != null && normalizeExerciseName(src.exercise) === normalizeExerciseName(exerciseName)
}

export type LoggedSet = EvidenceSet

export interface LoggedExercise {
  name: string
  sets: LoggedSet[]
}

export interface SourceUnits {
  /** What stored weights mean (units.ts storage unit). */
  weight: 'lb' | 'kg'
  /** What logged distances mean (units.ts distance unit). */
  distance: 'in' | 'cm'
}

const LB_PER_KG = 2.2046226218

const WEIGHT_UNITS = ['', 'lb', 'lbs', 'kg']
const DISTANCE_UNITS = ['', 'in', 'inch', 'inches', 'cm', 'm', 'ft', 'yd']
const TIME_UNITS = ['', 's', 'sec', 'secs', 'seconds', 'min', 'mins', 'minutes']
const COUNT_UNITS: Record<string, string[]> = {
  reps: ['', 'rep', 'reps'],
  reps_to_failure: ['', 'rep', 'reps'],
  rounds: ['', 'round', 'rounds', 'rds'],
}
const RELATIVE_UNITS = ['', 'xbw', 'x bw', '×bw', 'bw', 'ratio']
const PERCENT_UNITS = ['', '%', 'pct', 'percent']
const OUTPUT_GOAL_UNITS = ['', 'cal', 'cals', 'kcal', 'calories', 'm', 'meter', 'meters', 'w', 'watt', 'watts']

/** Whether a session value of this kind can be stated in this goal unit. */
export function sourceUnitSupported(kind: SourceKind, goalUnit: string | null | undefined): boolean {
  const unit = String(goalUnit ?? '').trim().toLowerCase()
  switch (kind) {
    case 'e1rm':
    case 'top_set': return WEIGHT_UNITS.includes(unit)
    case 'distance': return DISTANCE_UNITS.includes(unit)
    case 'time': return TIME_UNITS.includes(unit)
    case 'reps':
    case 'reps_to_failure':
    case 'rounds': return COUNT_UNITS[kind].includes(unit)
    case 'relative_e1rm': return RELATIVE_UNITS.includes(unit)
    case 'fade':
    case 'success_rate': return PERCENT_UNITS.includes(unit)
    case 'output': return OUTPUT_GOAL_UNITS.includes(unit)
    default: return true
  }
}

/** The session value in the goal's unit, or null when the unit can't be reached. */
function toGoalUnit(value: number, kind: SourceKind, goalUnit: string | null | undefined, units: SourceUnits): number | null {
  if (!sourceUnitSupported(kind, goalUnit)) return null
  const unit = String(goalUnit ?? '').trim().toLowerCase()
  if (kind === 'e1rm' || kind === 'top_set') {
    if (unit === 'kg' && units.weight === 'lb') return value / LB_PER_KG
    if ((unit === 'lb' || unit === 'lbs') && units.weight === 'kg') return value * LB_PER_KG
    return value
  }
  if (kind === 'distance') {
    const inches = units.distance === 'cm' ? value / 2.54 : value
    switch (unit) {
      case 'cm': return inches * 2.54
      case 'm': return (inches * 2.54) / 100
      case 'ft': return inches / 12
      case 'yd': return inches / 36
      case '': return value
      default: return inches
    }
  }
  if (kind === 'time' && ['min', 'mins', 'minutes'].includes(unit)) return value / 60
  return value
}

export interface SessionContext {
  /** Bodyweight this session, in the storage weight unit. */
  bodyweight?: number | null
  /** The goal's unit, for kinds whose sets carry their own unit (output). */
  goalUnit?: string | null
  /** The exercise, for kinds that read it (a pull-up's load includes bodyweight). */
  exercise?: string | null
}

function isBodyweightMovement(exercise: string | null | undefined): boolean {
  if (!exercise) return false
  const lib = findLibraryExercise(exercise)
  if (lib) return lib.tracking === 'bodyweight_reps'
  return /\b(pull[-\s]?ups?|chin[-\s]?ups?|dips?|push[-\s]?ups?)\b/i.test(exercise)
}

/**
 * One exercise's evidence for a source kind, from its completed sets: the
 * value, how it was earned, and the set behind it. Null if nothing counts.
 */
export function sessionEvidence(
  kind: SourceKind,
  sets: LoggedSet[],
  direction: string,
  ctx: SessionContext = {},
): Evidence | null {
  const done = sets.filter((s) => s.done === true)
  const pick = (vals: Array<number | null | undefined>, lowest = false): number | null => {
    const ok = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
    if (!ok.length) return null
    return lowest ? Math.min(...ok) : Math.max(...ok)
  }
  const tested = (value: number | null, detail: string): Evidence | null =>
    value == null ? null : { value, tier: 'tested', detail }
  switch (kind) {
    case 'e1rm':
      return strengthEvidence(done)
    case 'relative_e1rm': {
      const bw = ctx.bodyweight
      if (!(typeof bw === 'number' && bw > 0)) return null
      const addBodyweight = isBodyweightMovement(ctx.exercise)
      const ev = strengthEvidence(done, (s) => (addBodyweight ? bw + (s.weight ?? 0) : s.weight ?? null))
      return ev ? { ...ev, value: ev.value / bw } : null
    }
    case 'reps_to_failure':
      return repsToFailureEvidence(done)
    case 'top_set': {
      const v = pick(done.map((s) => ((s.reps ?? 0) >= 1 ? s.weight : null)))
      return tested(v, v == null ? '' : `top set ${v}`)
    }
    case 'reps': {
      const v = pick(done.map((s) => s.reps))
      return tested(v, v == null ? '' : `${v} reps`)
    }
    case 'distance': {
      const v = pick(done.map((s) => s.distance))
      return tested(v, v == null ? '' : `best ${v}`)
    }
    case 'time': {
      const v = pick(done.map((s) => s.duration), direction === 'lower')
      return tested(v, v == null ? '' : `${v}s`)
    }
    case 'rounds':
      return tested(done.length || null, `${done.length} rounds`)
    case 'output':
      return outputEvidence(done, ctx.goalUnit ?? null)
    case 'fade':
      return fadeEvidence(done, null)
    case 'success_rate':
      return successRateEvidence(sets)
    default:
      return null
  }
}

/** One exercise's value for a source kind, from its completed sets. Null if nothing counts. */
export function sessionValue(
  kind: SourceKind,
  sets: LoggedSet[],
  direction: string,
  ctx: SessionContext = {},
): number | null {
  return sessionEvidence(kind, sets, direction, ctx)?.value ?? null
}

export interface GoalForSource extends GoalFields {
  id: string
  source_metric?: string | null
}

export interface DerivedMeasurement {
  goal_id: string
  name: string
  value: number
  /** The goal's current before this session; null if it had none. */
  previous: number | null
  /** The value meets the target AND the evidence is proof (tested or strong). */
  hit: boolean
  /** The value meets the target on an estimate: a test would confirm it. */
  confirm: boolean
  exercise: string
  tier: EvidenceTier
  /** The set behind it: "285×3 @8". */
  detail: string
  /** What the measurement row's note says: exercise, set, and tier. */
  note: string
}

export interface DeriveOptions {
  /**
   * Best kinds write only when the session holds or beats the goal's current.
   * An edit corrects what the session was; it isn't judged against the goal
   * again, or a typo that became current could never be taken back.
   */
  requireHold?: boolean
  /** Bodyweight this session, storage units. Relative strength needs it. */
  bodyweight?: number | null
  /**
   * Readiness from the session check-in (1–10). At 4 or under, a rolling
   * estimate that lands below the goal's current is fatigue, not lost
   * capacity, and doesn't move the goal.
   */
  readiness?: number | null
  /** The athlete's own lift ratios (weakLinks.learnedRatios), for inferred reads. */
  ratios?: Record<string, number> | null
}

// Hundredths: a sprint time lives there, and one decimal would turn 1.84 s
// into a 1.8 that beats a 1.82.
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** At or under this readiness, a low estimate is read as fatigue. */
export const LOW_READINESS = 4

/**
 * The measurements a session writes.
 *
 * Best kinds (top_set, reps, distance, time, rounds) count when the session
 * holds or beats the goal's current value: three weeks pressing 120 is three
 * points at 120, which is how a plateau reaches the forecast, while a deload
 * day under the current mark writes nothing.
 *
 * Rolling kinds write every usable session. Deload protection comes from the
 * evidence itself: a set under RPE 7 says nothing about a max and isn't read,
 * so an easy day writes nothing rather than a low number.
 *
 * An e1rm goal whose lift isn't in the session, but a related one is (DB
 * press for a bench goal), gets an inferred reading through the lift's ratio.
 */
export function deriveGoalMeasurements(
  exercises: LoggedExercise[],
  goals: GoalForSource[],
  units: SourceUnits,
  opts: DeriveOptions = {},
): DerivedMeasurement[] {
  const requireHold = opts.requireHold ?? true
  const names = exercises.map((e) => e.name)
  const out: DerivedMeasurement[] = []
  for (const goal of goals) {
    const src = goalSource(goal, names)
    if (!src || src.kind === 'test' || !src.exercise) continue
    const lower = goal.direction === 'lower'
    const rolling = isRollingKind(src.kind)
    let best: { value: number; exercise: string; ev: Evidence; via: string | null } | null = null
    const better = (v: number) => !best || (lower ? v < best.value : v > best.value)
    for (const ex of exercises) {
      if (!sourceMatches(src, ex.name)) continue
      const ev = sessionEvidence(src.kind, ex.sets, goal.direction, {
        bodyweight: opts.bodyweight ?? null,
        goalUnit: goal.unit ?? null,
        exercise: ex.name,
      })
      if (!ev) continue
      const converted = src.kind === 'relative_e1rm' ? ev.value : toGoalUnit(ev.value, src.kind, goal.unit, units)
      if (converted == null) continue
      const value = round2(converted)
      if (better(value)) best = { value, exercise: ex.name, ev, via: null }
    }
    if (!best && src.kind === 'e1rm') {
      // Nothing direct: read a related lift through its ratio.
      for (const pair of pairsTo(src.exercise)) {
        for (const ex of exercises) {
          if (canonicalLift(ex.name) !== pair.from) continue
          const ev = strengthEvidence(ex.sets.filter((s) => s.done === true))
          const ratio = ratioFor(pair.from, pair.to, opts.ratios)
          if (!ev || !ratio) continue
          const converted = toGoalUnit(ev.value / ratio, 'e1rm', goal.unit, units)
          if (converted == null) continue
          const value = round2(converted)
          if (better(value)) best = { value, exercise: ex.name, ev: { ...ev, tier: 'inferred' }, via: ex.name }
        }
      }
    }
    if (!best) continue
    const previous = goalNumber(goal.current)
    const below = previous != null && (lower ? best.value > previous : best.value < previous)
    if (requireHold && !rolling && below) continue
    if (rolling && below && opts.readiness != null && opts.readiness <= LOW_READINESS) continue
    const target = goalNumber(goal.target)
    const meets = target != null && (lower ? best.value <= target : best.value >= target)
    const proof = isProof(best.ev.tier)
    out.push({
      goal_id: goal.id,
      name: goal.name,
      value: best.value,
      previous,
      hit: meets && proof,
      confirm: meets && !proof,
      exercise: best.exercise,
      tier: best.ev.tier,
      detail: best.ev.detail,
      note: formatEvidenceNote(best.via ? src.exercise : best.exercise, best.ev, best.via),
    })
  }
  return out
}

/** The goals a list of exercises trains, each with the exercise that feeds it. Manual tests never count. */
export function goalsTrainedBy<G extends GoalForSource>(
  goals: G[],
  exerciseNames: string[],
): Array<{ goal: G; exercise: string }> {
  const out: Array<{ goal: G; exercise: string }> = []
  for (const goal of goals) {
    const src = goalSource(goal, exerciseNames)
    if (!src || src.kind === 'test') continue
    const exercise = exerciseNames.find((n) => sourceMatches(src, n))
    if (exercise) out.push({ goal, exercise })
  }
  return out
}

export function workoutMeasurementKey(workoutId: string, goalId: string): string {
  return `wl:${workoutId}:${goalId}`
}
