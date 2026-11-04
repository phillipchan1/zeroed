/**
 * Which logged work moves which goal. Pure — the commit writes, the finish
 * screen shows, MCP validates, all from these functions.
 *
 * A goal's `source_metric` names the metric and the exercise that feed it:
 *
 *   e1rm:Bench Press      best estimated 1RM in the session
 *   top_set:Strict Press  heaviest completed set
 *   reps:Pull-up          most reps in a completed set
 *   distance:Broad Jump   best completed rep
 *   time:Plank            longest hold (shortest, for a lower-is-better goal)
 *   rounds:Alactic Bike   completed rounds
 *   test:Hip IR           manual only; no session ever writes it
 *
 * Goals written before the binding existed have none, so one is inferred from
 * the goal's name and unit against the session's exercise names. A sided goal
 * (L / R) is a manual test: sets don't carry a side.
 */
import { goalNumber, type GoalFields } from './goals.ts'
import { estimate1RM } from './prs.ts'

export const SOURCE_KINDS = ['e1rm', 'top_set', 'reps', 'distance', 'time', 'rounds', 'test'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

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

function kindFromUnit(goal: Pick<GoalFields, 'metric' | 'unit'>): SourceKind | null {
  const metric = String(goal.metric ?? '').toLowerCase()
  const unit = String(goal.unit ?? '').trim().toLowerCase()
  if (/e1rm|1rm/.test(metric)) return 'e1rm'
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

export interface LoggedSet {
  weight?: number | null
  reps?: number | null
  duration?: number | null
  distance?: number | null
  done?: boolean
}

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
  rounds: ['', 'round', 'rounds', 'rds'],
}

/** Whether a session value of this kind can be stated in this goal unit. */
export function sourceUnitSupported(kind: SourceKind, goalUnit: string | null | undefined): boolean {
  const unit = String(goalUnit ?? '').trim().toLowerCase()
  switch (kind) {
    case 'e1rm':
    case 'top_set': return WEIGHT_UNITS.includes(unit)
    case 'distance': return DISTANCE_UNITS.includes(unit)
    case 'time': return TIME_UNITS.includes(unit)
    case 'reps':
    case 'rounds': return COUNT_UNITS[kind].includes(unit)
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

/** One exercise's value for a source kind, from its completed sets. Null if nothing counts. */
export function sessionValue(
  kind: SourceKind,
  sets: LoggedSet[],
  direction: string,
): number | null {
  const done = sets.filter((s) => s.done === true)
  const pick = (vals: Array<number | null | undefined>, lowest = false): number | null => {
    const ok = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
    if (!ok.length) return null
    return lowest ? Math.min(...ok) : Math.max(...ok)
  }
  switch (kind) {
    case 'e1rm':
      return pick(done.map((s) => (s.weight != null && s.reps != null ? estimate1RM(s.weight, s.reps) : null)))
    case 'top_set':
      return pick(done.map((s) => ((s.reps ?? 0) >= 1 ? s.weight : null)))
    case 'reps':
      return pick(done.map((s) => s.reps))
    case 'distance':
      return pick(done.map((s) => s.distance))
    case 'time':
      return pick(done.map((s) => s.duration), direction === 'lower')
    case 'rounds':
      return done.length || null
    default:
      return null
  }
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
  hit: boolean
  exercise: string
}

// Hundredths: a sprint time lives there, and one decimal would turn 1.84 s
// into a 1.8 that beats a 1.82.
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * The measurements a session writes. A session counts when it holds or beats
 * the goal's current value: three weeks pressing 120 is three points at 120,
 * which is how a plateau reaches the forecast, while a deload day under the
 * current mark writes nothing and can't drag the trend down.
 */
export function deriveGoalMeasurements(
  exercises: LoggedExercise[],
  goals: GoalForSource[],
  units: SourceUnits,
  opts: { requireHold?: boolean } = {},
): DerivedMeasurement[] {
  // An edit corrects what the session was; it isn't judged against the goal
  // again, or a typo that became current could never be taken back.
  const requireHold = opts.requireHold ?? true
  const names = exercises.map((e) => e.name)
  const out: DerivedMeasurement[] = []
  for (const goal of goals) {
    const src = goalSource(goal, names)
    if (!src || src.kind === 'test' || !src.exercise) continue
    const lower = goal.direction === 'lower'
    let best: { value: number; exercise: string } | null = null
    for (const ex of exercises) {
      if (!sourceMatches(src, ex.name)) continue
      const raw = sessionValue(src.kind, ex.sets, goal.direction)
      if (raw == null) continue
      const converted = toGoalUnit(raw, src.kind, goal.unit, units)
      if (converted == null) continue
      const value = round2(converted)
      if (!best || (lower ? value < best.value : value > best.value)) best = { value, exercise: ex.name }
    }
    if (!best) continue
    const previous = goalNumber(goal.current)
    if (requireHold && previous != null && (lower ? best.value > previous : best.value < previous)) continue
    const target = goalNumber(goal.target)
    const hit = target != null && (lower ? best.value <= target : best.value >= target)
    out.push({ goal_id: goal.id, name: goal.name, value: best.value, previous, hit, exercise: best.exercise })
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
