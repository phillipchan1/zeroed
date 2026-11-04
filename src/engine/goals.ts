/**
 * Structured goals. Status is computed from trend vs target and due date.
 * History is the measurement list. L/R are two rows paired in the UI.
 */

export const GOAL_SIDES = ['L', 'R', 'both', 'none'] as const
export const GOAL_DIRECTIONS = ['higher', 'lower', 'pass'] as const
export const GOAL_STATUSES = ['on_track', 'behind', 'hit'] as const
export const GOAL_SOURCES = ['workout_log', 'manual', 'agent'] as const

export type GoalSide = (typeof GOAL_SIDES)[number]
export type GoalDirection = (typeof GOAL_DIRECTIONS)[number]
export type GoalStatus = (typeof GOAL_STATUSES)[number]
export type GoalSource = (typeof GOAL_SOURCES)[number]

export interface GoalMeasurement {
  date: string
  value: number
  side?: string | null
  source: string
  note?: string | null
  client_key?: string | null
}

export interface GoalFields {
  name: string
  metric: string
  unit?: string | null
  side?: GoalSide | string | null
  direction: GoalDirection | string
  target?: number | null
  target_range_hi?: number | null
  baseline?: number | null
  current?: number | null
  best?: number | null
  due_date?: string | null
  cadence?: string | null
}

export function isGoalSide(v: unknown): v is GoalSide {
  return typeof v === 'string' && (GOAL_SIDES as readonly string[]).includes(v)
}

export function isGoalDirection(v: unknown): v is GoalDirection {
  return typeof v === 'string' && (GOAL_DIRECTIONS as readonly string[]).includes(v)
}

/** Postgres NUMERIC often arrives as a string. Never compare those lexicographically. */
export function goalNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function isSeedMeasurement(m: { client_key?: string | null }): boolean {
  return typeof m.client_key === 'string' && m.client_key.startsWith('seed:')
}

/** Latest real measured_on. Seed rows (client_key seed:*) do not count. */
export function lastMeasuredOn(
  history: Array<Pick<GoalMeasurement, 'date' | 'client_key'> | GoalMeasurement>,
): string | null {
  let latest: string | null = null
  for (const m of history) {
    const day = String(m.date ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isSeedMeasurement(m)) continue
    if (!latest || day > latest) latest = day
  }
  return latest
}

function meetsTarget(direction: string, current: unknown, target: unknown, hi?: unknown): boolean {
  const c = goalNumber(current)
  if (c == null) return false
  if (direction === 'pass') return c >= 1
  const t = goalNumber(target)
  if (t == null) return false
  if (direction === 'lower') return c <= t
  const ceiling = goalNumber(hi)
  if (ceiling != null) return c >= t && c <= ceiling
  return c >= t
}

function daysUntil(due: string | null | undefined, today: string): number | null {
  if (!due) return null
  const a = Date.parse(`${due}T12:00:00Z`)
  const b = Date.parse(`${today}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((a - b) / 86_400_000)
}

function slope(history: GoalMeasurement[]): number | null {
  const pts = history.filter((h) => Number.isFinite(h.value) && !isSeedMeasurement(h)).slice(-6)
  if (pts.length < 2) return 0
  const first = pts[0].value
  const last = pts[pts.length - 1].value
  return last - first
}

/**
 * hit — current meets the target.
 * behind — due is within 21 days (or past) and trend is flat or away.
 * on_track — everything else, including pending baselines.
 */
export function computeGoalStatus(
  goal: GoalFields,
  history: GoalMeasurement[],
  today: string,
): GoalStatus {
  const current = goalNumber(goal.current)
  const target = goalNumber(goal.target)
  if (meetsTarget(goal.direction, current, target, goal.target_range_hi)) {
    return 'hit'
  }
  const dueIn = daysUntil(goal.due_date, today)
  const trend = slope(history)
  const pending = current == null && goalNumber(goal.baseline) == null
  if (pending) {
    if (dueIn != null && dueIn <= 21) return 'behind'
    return 'on_track'
  }
  if (dueIn != null && dueIn <= 21) {
    const toward = goal.direction === 'lower' ? (trend ?? 0) < 0 : (trend ?? 0) > 0
    if (!toward) return 'behind'
  }
  return 'on_track'
}

/**
 * What the athlete sees. Color is status, so each state owns one of the
 * five-color tokens: zeroed is confirmed, off course is the signal (the thing
 * to act on), needs a test is pending (the number is unproven), on course is
 * plain text. A goal with no real measurement needs a test whatever its seeded
 * numbers say, so that check runs first.
 */
export const GOAL_DISPLAYS = ['zeroed', 'on_course', 'off_course', 'needs_test'] as const
export type GoalDisplay = (typeof GOAL_DISPLAYS)[number]

export const GOAL_DISPLAY_LABEL: Record<GoalDisplay, string> = {
  zeroed: 'Zeroed',
  on_course: 'On course',
  off_course: 'Off course',
  needs_test: 'Needs a test',
}

export function goalDisplayStatus(status: GoalStatus | string, lastMeasured: string | null): GoalDisplay {
  if (!lastMeasured) return 'needs_test'
  if (status === 'hit') return 'zeroed'
  if (status === 'behind') return 'off_course'
  return 'on_course'
}

export function applyMeasurement(
  goal: GoalFields,
  measurement: GoalMeasurement,
): { current: number; best: number | null; baseline: number | null } {
  const current = measurement.value
  const direction = goal.direction
  let best = goalNumber(goal.best)
  if (best == null) best = current
  else if (direction === 'lower') best = Math.min(best, current)
  else best = Math.max(best, current)
  const baseline = goalNumber(goal.baseline) ?? current
  return { current, best, baseline }
}

export function progressRatio(goal: GoalFields): number | null {
  const current = goalNumber(goal.current)
  const target = goalNumber(goal.target)
  const baseline = goalNumber(goal.baseline)
  if (current == null || target == null) return null
  if (goal.direction === 'pass') return current >= 1 ? 1 : 0
  if (baseline == null || baseline === target) {
    if (goal.direction === 'lower') return current <= target ? 1 : 0
    return Math.max(0, Math.min(1, current / target))
  }
  if (goal.direction === 'lower') {
    const span = baseline - target
    if (span === 0) return current <= target ? 1 : 0
    return Math.max(0, Math.min(1, (baseline - current) / span))
  }
  const span = target - baseline
  if (span === 0) return current >= target ? 1 : 0
  return Math.max(0, Math.min(1, (current - baseline) / span))
}

export function pairKey(name: string): string {
  return name.replace(/\s+[LR]$/i, '').trim().toLowerCase()
}

export function projectedAtDue(
  history: GoalMeasurement[],
  due: string | null | undefined,
): number | null {
  if (!due) return null
  const pts = history.filter((h) => Number.isFinite(h.value) && h.date)
  if (pts.length < 2) return pts[0]?.value ?? null
  const first = Date.parse(`${pts[0].date}T12:00:00Z`)
  const last = Date.parse(`${pts[pts.length - 1].date}T12:00:00Z`)
  const dueMs = Date.parse(`${due}T12:00:00Z`)
  if (!Number.isFinite(first) || !Number.isFinite(last) || last === first) return pts[pts.length - 1].value
  const slopePerMs = (pts[pts.length - 1].value - pts[0].value) / (last - first)
  return pts[pts.length - 1].value + slopePerMs * (dueMs - last)
}
