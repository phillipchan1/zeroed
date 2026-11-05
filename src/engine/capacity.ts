// =============================================================================
// CAPACITY — where a goal actually is, how sure we are, and whether to test.
//
// The goal used to be its latest measurement, and a goal with no fresh one
// "needed a test". That made the athlete do chores the log could answer. This
// reads every measurement the goal has (tested, estimated off working sets,
// inferred from a related lift) and answers three questions:
//
//   value   where the goal is now. For rolling kinds (estimates and rates) a
//           recency- and tier-weighted read: a tested single counts three times
//           an RPE-8 triple, and last week counts twice what three weeks ago
//           did. For best kinds (a top set, a jump) the latest mark, as before.
//   range   how sure. Tight for a tested number, wider for an estimate,
//           wider still for an inferred one, and widening every week the
//           goal goes without evidence.
//   test    whether to ask for a test, and WHY — only when the answer would
//           change something: an estimate past the target (confirm it), no
//           usable sets in four weeks (stale), no evidence at all, or a manual
//           measurement whose cadence lapsed.
//
// goalRead is the one entry point the app and the Worker both call, so the
// Goals tab and Claude's brief can never disagree.
//
// Pure, no I/O (see capacity.check.ts).
// =============================================================================

import {
  cadenceDays, computeGoalStatus, forecastAtDue, goalNumber, isSeedMeasurement, lastMeasuredOn,
  type GoalDisplay, type GoalFields, type GoalForecast, type GoalMeasurement, type GoalStatus,
} from './goals.ts'
import { isProof, parseEvidenceTier, TIER_WEIGHT, type EvidenceTier } from './evidence.ts'
import { isRollingKind, parseGoalSource, type SourceKind } from './goalSources.ts'

/** What the athlete sees about the evidence. */
export const CAPACITY_TIERS = ['tested', 'estimated', 'inferred', 'stale'] as const
export type CapacityTier = (typeof CAPACITY_TIERS)[number]

export const CAPACITY_TIER_LABEL: Record<CapacityTier, string> = {
  tested: 'Tested',
  estimated: 'Estimated',
  inferred: 'Inferred',
  stale: 'Stale',
}

/** Readings older than this don't move the value. */
export const WINDOW_DAYS = 42
/** A reading this old counts half. */
export const HALF_LIFE_DAYS = 21
/** No evidence for this long and a passive goal is stale. */
export const STALE_DAYS = 28

const HALF_WIDTH: Record<EvidenceTier, number> = {
  tested: 0.01,
  strong: 0.02,
  estimate: 0.035,
  inferred: 0.06,
}
const WIDEN_PER_WEEK = 0.005

export interface GoalCapacity {
  value: number
  lo: number
  hi: number
  tier: CapacityTier
  /** Latest real measurement day. */
  last_evidence: string
  days_since: number
  /** Readings inside the window. */
  points: number
  /** A tested or strong reading has met the target. */
  proven: boolean
}

export type TestReasonCode = 'no_evidence' | 'confirm' | 'stale' | 'cadence'

export interface TestReason {
  code: TestReasonCode
  text: string
}

function dayNumber(day: string): number | null {
  const t = Date.parse(`${String(day).slice(0, 10)}T12:00:00Z`)
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null
}

/** The goal's source kind, from its stored binding; null for none. */
export function goalKind(goal: { source_metric?: string | null }): SourceKind | null {
  return parseGoalSource(goal.source_metric)?.kind ?? null
}

/**
 * Whether logged training moves this goal: a stored binding to a session
 * kind, or a history that sessions have already written to.
 */
export function isPassiveGoal(goal: { source_metric?: string | null }, history: Array<Pick<GoalMeasurement, 'source'>>): boolean {
  const kind = goalKind(goal)
  if (kind) return kind !== 'test'
  return history.some((m) => m.source === 'workout_log')
}

/**
 * Whether the goal reads as a rolling estimate: a rolling binding, or (with no
 * binding stored) sessions that wrote tiered estimates to it.
 */
export function isRollingGoal(goal: { source_metric?: string | null }, history: Array<Pick<GoalMeasurement, 'source' | 'note'>>): boolean {
  const kind = goalKind(goal)
  if (kind) return isRollingKind(kind)
  return history.some((m) => {
    if (m.source !== 'workout_log') return false
    const t = parseEvidenceTier(m.note)
    return t != null && t !== 'tested'
  })
}

/**
 * The tier a measurement was earned at. A note with a tier says so; a note
 * from before tiers is read by where it came from: a person's or Claude's
 * measurement is a test, a session's was the old Epley estimate on an e1rm
 * goal and a real mark on everything else.
 */
export function measurementTier(m: Pick<GoalMeasurement, 'source' | 'note'>, rolling: boolean): EvidenceTier {
  const parsed = parseEvidenceTier(m.note)
  if (parsed) return parsed
  if (m.source === 'workout_log') return rolling ? 'estimate' : 'tested'
  return 'tested'
}

function meets(direction: string, value: number, target: number | null, hi?: number | null): boolean {
  if (direction === 'pass') return value >= 1
  if (target == null) return false
  if (direction === 'lower') return value <= target
  if (hi != null) return value >= target && value <= hi
  return value >= target
}

/** A tested or strong reading met the target. Empty history (a direct write) counts as proof. */
export function goalProven(
  goal: Pick<GoalFields, 'direction' | 'target' | 'target_range_hi'> & { source_metric?: string | null },
  history: GoalMeasurement[],
): boolean {
  const real = history.filter((m) => !isSeedMeasurement(m))
  if (!real.length) return true
  const rolling = isRollingGoal(goal, real)
  const target = goalNumber(goal.target)
  const hi = goalNumber(goal.target_range_hi)
  return real.some((m) => {
    const v = goalNumber(m.value)
    return v != null && isProof(measurementTier(m, rolling)) && meets(goal.direction, v, target, hi)
  })
}

/**
 * Where the goal is, from its measurements. Null when it has no real one.
 */
export function goalCapacity(
  goal: Pick<GoalFields, 'direction' | 'target' | 'target_range_hi'> & { source_metric?: string | null },
  history: GoalMeasurement[],
  today: string,
): GoalCapacity | null {
  const todayN = dayNumber(today)
  if (todayN == null) return null
  const rolling = isRollingGoal(goal, history)
  const pts = history
    .filter((m) => !isSeedMeasurement(m))
    .map((m) => ({ day: dayNumber(m.date), value: goalNumber(m.value), tier: measurementTier(m, rolling), date: String(m.date).slice(0, 10) }))
    .filter((p): p is { day: number; value: number; tier: EvidenceTier; date: string } => p.day != null && p.value != null)
    .sort((a, b) => a.day - b.day)
  if (!pts.length) return null
  const last = pts[pts.length - 1]
  const daysSince = Math.max(0, todayN - last.day)
  const inWindow = pts.filter((p) => todayN - p.day <= WINDOW_DAYS)

  let value: number
  let tier: EvidenceTier
  let spread = 0
  if (rolling && inWindow.length) {
    let wSum = 0
    let vSum = 0
    for (const p of inWindow) {
      const w = TIER_WEIGHT[p.tier] * Math.pow(0.5, Math.max(0, todayN - p.day) / HALF_LIFE_DAYS)
      wSum += w
      vSum += w * p.value
    }
    value = vSum / wSum
    let varSum = 0
    for (const p of inWindow) {
      const w = TIER_WEIGHT[p.tier] * Math.pow(0.5, Math.max(0, todayN - p.day) / HALF_LIFE_DAYS)
      varSum += w * (p.value - value) ** 2
    }
    spread = value !== 0 ? Math.sqrt(varSum / wSum) / Math.abs(value) : 0
    tier = last.tier
  } else {
    value = last.value
    tier = last.tier
  }

  const weeksSince = daysSince / 7
  const half = HALF_WIDTH[tier] + Math.min(spread, 0.05) + WIDEN_PER_WEEK * weeksSince
  const lo = value * (1 - half)
  const hi = value * (1 + half)
  const shown: CapacityTier = daysSince > STALE_DAYS
    ? 'stale'
    : tier === 'inferred' ? 'inferred' : tier === 'tested' ? 'tested' : 'estimated'
  return {
    value: round(value),
    lo: round(lo),
    hi: round(hi),
    tier: shown,
    last_evidence: last.date,
    days_since: daysSince,
    points: inWindow.length,
    proven: goalProven(goal, history),
  }
}

// A capacity is an estimate: a 296.07 lb bench is false precision. Whole
// numbers from 100 up, tenths from 10, hundredths below (a 1.43×BW ratio).
function round(v: number): number {
  const a = Math.abs(v)
  if (a >= 100) return Math.round(v)
  if (a >= 10) return Math.round(v * 10) / 10
  return Math.round(v * 100) / 100
}

function shortDay(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Whether to ask for a test, and why. Null means the log is answering.
 */
export function goalTestReason(
  goal: Pick<GoalFields, 'direction' | 'target' | 'target_range_hi' | 'cadence'> & { source_metric?: string | null },
  capacity: GoalCapacity | null,
  ctx: { passive: boolean; today: string; exercise?: string | null },
): TestReason | null {
  const lift = ctx.exercise ?? parseGoalSource(goal.source_metric)?.exercise ?? null
  if (!capacity) {
    return ctx.passive
      ? { code: 'no_evidence', text: lift ? `Your first ${lift} session sets it.` : 'Your first session on it sets it.' }
      : { code: 'no_evidence', text: 'Needs a first measurement. A minute in a warm-up does it.' }
  }
  const target = goalNumber(goal.target)
  const kind = goalKind(goal)
  if (meets(goal.direction, capacity.value, target, goalNumber(goal.target_range_hi)) && !capacity.proven) {
    const how = kind === 'e1rm' || kind === 'relative_e1rm'
      ? `A top single at RPE 8–9${lift ? ` on ${lift}` : ''} next heavy day confirms it.`
      : 'One max-effort set confirms it.'
    return { code: 'confirm', text: `The estimate is past the target. ${how}` }
  }
  if (ctx.passive) {
    if (capacity.days_since > STALE_DAYS) {
      return { code: 'stale', text: `No usable ${lift ?? 'sets'}${lift ? ' sets' : ''} since ${shortDay(capacity.last_evidence)}. One rated working set brings it back.` }
    }
    return null
  }
  const every = cadenceDays(goal.cadence)
  if (every != null && capacity.days_since > every) {
    return { code: 'cadence', text: `Due for its ${String(goal.cadence).trim().toLowerCase()} check. It fits in a warm-up.` }
  }
  return null
}

export interface GoalRead {
  computed: GoalStatus
  display: GoalDisplay
  forecast: GoalForecast | null
  last_measured: string | null
  capacity: GoalCapacity | null
  test_reason: TestReason | null
  passive: boolean
}

/**
 * Everything the app and the brief show about a goal, from its row and its
 * measurements. Status first:
 *
 *   zeroed      proven at the target.
 *   confirm     an estimate is at the target; a test would make it Zeroed.
 *   needs_test  a test reason other than confirm.
 *   off_course  the forecast misses (computeGoalStatus).
 *   on_course   everything else.
 */
export function goalRead(
  goal: GoalFields & { source_metric?: string | null },
  history: GoalMeasurement[],
  today: string,
  opts: { exercise?: string | null } = {},
): GoalRead {
  const passive = isPassiveGoal(goal, history)
  const capacity = goalCapacity(goal, history, today)
  // A rolling goal is where its capacity is, whatever the row last stored.
  const read = capacity && isRollingGoal(goal, history) ? { ...goal, current: capacity.value } : goal
  const computed = computeGoalStatus(read, history, today, { proven: capacity?.proven ?? true })
  const test_reason = goalTestReason(goal, capacity, { passive, today, exercise: opts.exercise })
  const last_measured = lastMeasuredOn(history)
  let display: GoalDisplay
  if (computed === 'hit') display = 'zeroed'
  else if (test_reason?.code === 'confirm') display = 'confirm'
  else if (test_reason) display = 'needs_test'
  else if (computed === 'behind') display = 'off_course'
  else display = 'on_course'
  return { computed, display, forecast: forecastAtDue(goal, history), last_measured, capacity, test_reason, passive }
}

/**
 * What the goal row stores after its measurements change. current is the
 * capacity for a rolling goal and the latest mark otherwise; best is the best
 * reading (an inferred one never sets a best); baseline is the first.
 */
export function goalMarks(
  goal: Pick<GoalFields, 'direction' | 'target' | 'target_range_hi' | 'baseline'> & { source_metric?: string | null },
  history: GoalMeasurement[],
  today: string,
): { current: number; best: number; baseline: number } | null {
  const real = history
    .filter((m) => !isSeedMeasurement(m) && goalNumber(m.value) != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  if (!real.length) return null
  const rolling = isRollingGoal(goal, real)
  const latest = goalNumber(real[real.length - 1].value)!
  const current = rolling ? goalCapacity(goal, real, today)?.value ?? latest : latest
  const counted = real.filter((m) => measurementTier(m, rolling) !== 'inferred').map((m) => goalNumber(m.value)!)
  const pool = counted.length ? counted : [current]
  const best = goal.direction === 'lower' ? Math.min(...pool) : Math.max(...pool)
  const baseline = goalNumber(goal.baseline) ?? goalNumber(real[0].value)!
  return { current, best, baseline }
}
