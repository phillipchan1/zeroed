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

export const PHIL_GOAL_SEED: Array<GoalFields & { note?: string; test_protocol?: string }> = [
  { name: 'Bench 1RM', metric: 'e1rm', unit: 'lb', side: 'none', direction: 'higher', target: 295, target_range_hi: 300, current: 285, best: 285, baseline: 285, due_date: '2026-12-11', cadence: 'block', test_protocol: 'Paused or competition bench, Dec 7–11. Long-term 315.' },
  { name: 'Strict OHP', metric: 'load_x_reps', unit: 'lb', side: 'none', direction: 'higher', target: 155, current: 125, best: 125, due_date: null, cadence: 'open', test_protocol: 'Strict press. Last best 125×5 (Aug 26).' },
  { name: 'Squat held', metric: 'held_load', unit: 'lb', side: 'none', direction: 'higher', target: 375, due_date: '2026-12-11', cadence: 'block', test_protocol: 'Maintenance. A rep PR at RPE 8 counts as held. No maxing.' },
  { name: 'Deadlift held', metric: 'held_load', unit: 'lb', side: 'none', direction: 'higher', target: 410, current: 350, due_date: '2026-12-11', cadence: 'block', test_protocol: 'TM 410 (hand-set) / best 445. 3×3 @350. No maxing.', note: 'Deadlift TM is 410 and must stay 410.' },
  { name: 'Hip IR L', metric: 'hip_ir', unit: 'deg', side: 'L', direction: 'higher', target: 35, due_date: null, cadence: 'monthly', test_protocol: 'Seated or supine IR, each side.' },
  { name: 'Hip IR R', metric: 'hip_ir', unit: 'deg', side: 'R', direction: 'higher', target: 35, due_date: null, cadence: 'monthly', test_protocol: 'Seated or supine IR, each side.' },
  { name: 'Knee-to-wall L', metric: 'knee_to_wall', unit: 'in', side: 'L', direction: 'higher', target: 4, due_date: null, cadence: 'monthly' },
  { name: 'Knee-to-wall R', metric: 'knee_to_wall', unit: 'in', side: 'R', direction: 'higher', target: 4, due_date: null, cadence: 'monthly' },
  { name: 'Wall test', metric: 'wall_test', unit: 'pass', side: 'none', direction: 'pass', due_date: null, cadence: 'monthly', test_protocol: 'Pass / fail screen.' },
  { name: 'Broad jump', metric: 'distance', unit: 'in', side: 'none', direction: 'higher', target: 100, current: 95, best: 95, baseline: 95, due_date: '2026-12-11', cadence: 'block' },
  { name: 'Assault Bike 10-min calories', metric: 'calories', unit: 'cal', side: 'none', direction: 'higher', due_date: '2026-12-11', cadence: 'block', test_protocol: 'Set at first test.' },
  { name: 'Repeat sprint drop-off', metric: 'dropoff_pct', unit: '%', side: 'none', direction: 'lower', target: 5, due_date: '2026-12-11', cadence: 'block', test_protocol: '6 × 20 m, drop-off %.' },
  { name: 'Basketball gas tank', metric: 'rating', unit: '/10', side: 'none', direction: 'higher', target: 8, due_date: null, cadence: 'weekly', test_protocol: 'Post-game 1–10.' },
]
