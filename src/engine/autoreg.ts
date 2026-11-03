/**
 * Data-driven autoregulation. Rules are rows: if <signal> <op> <value>
 * then <action>, scoped to program / track / exercise.
 *
 * Phil fixtures (spec §2 / §8):
 *   knee 6/10 → drop squats, lunges, jumps
 *   knee 4/10 on squat day → 265 or cut depth
 *   knee > 3/10 → drop jumps / plyos
 */

export const AUTOREG_SIGNALS = [
  'pain_knee_L',
  'pain_knee_R',
  'pain_knee',
  'sleep_hours',
  'set_rpe',
  'all_sets_rpe_max',
  'warmup_quality',
  'bar_speed_drop',
] as const

export const AUTOREG_OPS = ['>', '>=', '<', '<=', '==', '!='] as const

export const AUTOREG_ACTIONS = [
  'drop_exercise',
  'swap_exercise',
  'reduce_load_lb',
  'reduce_load_pct',
  'cap_depth',
  'hold',
  'deload',
] as const

export type AutoregSignal = (typeof AUTOREG_SIGNALS)[number]
export type AutoregOp = (typeof AUTOREG_OPS)[number]
export type AutoregAction = (typeof AUTOREG_ACTIONS)[number]

export interface AutoregRule {
  id?: string
  scope_type: 'program' | 'track' | 'exercise'
  scope_id?: string | null
  scope_name?: string | null
  signal: AutoregSignal | string
  op: AutoregOp | string
  value: number | string
  action: AutoregAction | string
  action_params?: Record<string, unknown>
  message: string
}

export interface AutoregSignals {
  pain_knee_L?: number | null
  pain_knee_R?: number | null
  sleep_hours?: number | null
  set_rpe?: number | null
  all_sets_rpe_max?: number | null
  warmup_quality?: number | string | null
  bar_speed_drop?: number | null
}

export interface FiredRule {
  rule: AutoregRule
  message: string
  action: string
  exercise_name?: string | null
}

const SQUAT_LUNGE = /\b(squat|lunge|split squat|cossack|step-up|step up)\b/i
const PLYO = /\b(jump|bound|pogo|plyo|depth jump|broad jump)\b/i

function cmp(signal: number, op: string, value: number): boolean {
  switch (op) {
    case '>': return signal > value
    case '>=': return signal >= value
    case '<': return signal < value
    case '<=': return signal <= value
    case '==': return signal === value
    case '!=': return signal !== value
    default: return false
  }
}

function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
    // warmup_quality: "shaky" / "good" — 0 is shaky, 1 is good
    if (/shaky|poor|bad/i.test(v)) return 0
    if (/good|solid|fine/i.test(v)) return 1
  }
  return null
}

function maxKnee(signals: AutoregSignals): number | null {
  const vals = [signals.pain_knee_L, signals.pain_knee_R].filter((n): n is number => n != null)
  return vals.length ? Math.max(...vals) : null
}

function signalValue(rule: AutoregRule, signals: AutoregSignals): number | null {
  if (rule.signal === 'pain_knee') return maxKnee(signals)
  const raw = (signals as Record<string, unknown>)[rule.signal]
  return asNumber(raw)
}

function exerciseMatches(rule: AutoregRule, exerciseName: string, trackId?: string | null): boolean {
  if (rule.scope_type === 'program') return true
  if (rule.scope_type === 'track') {
    if (rule.scope_id && trackId) return rule.scope_id === trackId
    return true
  }
  if (rule.scope_type === 'exercise') {
    const want = (rule.scope_name ?? '').toLowerCase()
    if (!want) return true
    return exerciseName.toLowerCase().includes(want) || want.includes(exerciseName.toLowerCase())
  }
  return true
}

function actionAppliesTo(rule: AutoregRule, exerciseName: string): boolean {
  const names = (rule.action_params?.exercises as string[] | undefined)
    ?? (typeof rule.action_params?.exercise === 'string' ? [rule.action_params.exercise] : null)
  if (names?.length) {
    const lower = exerciseName.toLowerCase()
    return names.some((n) => lower.includes(String(n).toLowerCase()))
  }
  if (rule.action === 'drop_exercise') {
    const kind = String(rule.action_params?.kind ?? '')
    if (kind === 'squat_lunge') return SQUAT_LUNGE.test(exerciseName)
    if (kind === 'plyo') return PLYO.test(exerciseName)
    if (kind === 'squat_lunge_plyo') return SQUAT_LUNGE.test(exerciseName) || PLYO.test(exerciseName)
  }
  return true
}

export function evaluateAutoregRules(
  rules: AutoregRule[],
  signals: AutoregSignals,
  exercises: Array<{ name: string; track_id?: string | null }>,
): FiredRule[] {
  const fired: FiredRule[] = []
  for (const rule of rules) {
    const left = signalValue(rule, signals)
    const right = asNumber(rule.value)
    if (left == null || right == null) continue
    if (!cmp(left, rule.op, right)) continue
    const targets = exercises.filter((ex) =>
      exerciseMatches(rule, ex.name, ex.track_id) && actionAppliesTo(rule, ex.name),
    )
    if (!targets.length) {
      fired.push({ rule, message: rule.message, action: rule.action })
      continue
    }
    for (const ex of targets) {
      fired.push({
        rule,
        message: rule.message,
        action: rule.action,
        exercise_name: ex.name,
      })
    }
  }
  return fired
}

export function droppedExerciseNames(fired: FiredRule[]): Set<string> {
  return new Set(
    fired.filter((f) => f.action === 'drop_exercise' && f.exercise_name).map((f) => f.exercise_name as string),
  )
}

export const PHIL_AUTOREG_SEED: AutoregRule[] = [
  {
    scope_type: 'program',
    signal: 'pain_knee',
    op: '>',
    value: 5,
    action: 'drop_exercise',
    action_params: { kind: 'squat_lunge_plyo' },
    message: 'Knee > 5/10: no squats, lunges, or jumps today',
  },
  {
    scope_type: 'program',
    signal: 'pain_knee',
    op: '>',
    value: 3,
    action: 'drop_exercise',
    action_params: { kind: 'plyo' },
    message: 'Knee > 3/10: drop jumps and plyos',
  },
  {
    scope_type: 'program',
    signal: 'pain_knee',
    op: '>=',
    value: 4,
    action: 'cap_depth',
    action_params: { kind: 'squat_lunge', load_lb: 265 },
    message: 'Knee 4–5/10: squat 265 or cut depth',
  },
  {
    scope_type: 'program',
    signal: 'sleep_hours',
    op: '<',
    value: 6,
    action: 'reduce_load_lb',
    action_params: { lb: 10 },
    message: 'Short sleep: −10 lb, hold RPE',
  },
  {
    scope_type: 'exercise',
    scope_name: 'OHP',
    signal: 'warmup_quality',
    op: '==',
    value: 0,
    action: 'reduce_load_pct',
    action_params: { pct: 15 },
    message: 'Shaky OHP warm-up: work at 85%',
  },
]
