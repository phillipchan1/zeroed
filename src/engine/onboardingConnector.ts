/**
 * Connector-side onboarding engine — answers, pack recommendation, the read,
 * and session-1 preview. Pure so `.check.ts` can run under node.
 *
 * Pain-flag routing lives here, not in prompt text: any pain other than
 * "nothing" forces the layoff pack. Preview helpers write nothing.
 */

import { estimateSessionMinutes } from '../../supabase/functions/_shared/engine/programDraft.ts'
import {
  STARTER_PACKS,
  previewPackProvisional,
  resolveDaysChip,
  resolveStarterPack,
  type PackSettings,
  type StarterPackId,
} from './starterPacks.ts'

export const PACK_IDS: readonly StarterPackId[] = [
  'sport_sc', 'get_strong', 'chase_total', 'hybrid', 'layoff', 'thirty_three', 'byo',
]

export const PAIN_VALUES = ['nothing', 'back', 'knee', 'shoulder', 'hip', 'other'] as const
export type PainValue = (typeof PAIN_VALUES)[number]

export const STYLE_VALUES = ['direct', 'explain', 'quiet'] as const
export type StyleValue = (typeof STYLE_VALUES)[number]

export const EQUIPMENT_VALUES = [
  'barbell', 'dumbbells', 'kettlebell', 'bands', 'bodyweight', 'machines', 'full_gym',
] as const
export type EquipmentValue = (typeof EQUIPMENT_VALUES)[number]

export const GOAL_ALIASES: Record<string, StarterPackId> = {
  sport_sc: 'sport_sc',
  sport: 'sport_sc',
  's&c': 'sport_sc',
  get_strong: 'get_strong',
  strong: 'get_strong',
  chase_total: 'chase_total',
  powerlifting: 'chase_total',
  total: 'chase_total',
  hybrid: 'hybrid',
  hyrox: 'hybrid',
  layoff: 'layoff',
  return: 'layoff',
  thirty_three: 'thirty_three',
  '30': 'thirty_three',
  time: 'thirty_three',
  byo: 'byo',
  own: 'byo',
}

export type Confidence = 'high' | 'medium' | 'low'

export interface OnboardingLifts {
  squat?: string
  bench?: string
  deadlift?: string
  dont_know?: boolean
}

export interface OnboardingAnswers {
  goal?: StarterPackId
  days?: number
  minutes?: number
  equipment?: EquipmentValue[]
  lifts?: OnboardingLifts
  pain?: PainValue
  style?: StyleValue
  sport?: string
  season?: 'in' | 'off'
  game_days?: string[]
  run_days?: number
  training_age?: number
  name?: string
}

export interface OnboardingQuestion {
  id: string
  prompt: string
  chips: string[]
}

export const ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = [
  {
    id: 'goal',
    prompt: 'What do you want out of the next 12 weeks?',
    chips: ['Get strong', 'S&C for a sport', 'Chase a total', 'Hybrid / Hyrox', 'Back from a layoff', '30 minutes, 3 days'],
  },
  {
    id: 'days',
    prompt: 'How many days per week can you train?',
    chips: ['2', '3', '4', '5+', 'It changes week to week'],
  },
  {
    id: 'minutes',
    prompt: 'How many minutes can a session be?',
    chips: ['30', '45', '60'],
  },
  {
    id: 'equipment',
    prompt: 'What equipment do you have?',
    chips: ['barbell', 'dumbbells', 'kettlebell', 'bands', 'bodyweight', 'machines', 'full_gym'],
  },
  {
    id: 'lifts',
    prompt: 'Recent squat, bench, deadlift — or don\'t know?',
    chips: ["don't know"],
  },
  {
    id: 'pain',
    prompt: 'Anything hurting?',
    chips: ['Nothing', 'Back', 'Knee', 'Shoulder', 'Hip', 'Other'],
  },
  {
    id: 'style',
    prompt: 'How do you want to be coached?',
    chips: ['direct', 'explain', 'quiet'],
  },
]

const SPORT_QUESTION: OnboardingQuestion = {
  id: 'sport',
  prompt: 'Which sport? Season and game days are settings, not a schedule.',
  chips: ['Basketball', 'Soccer', 'Tennis', 'Combat', 'Other'],
}

const RUN_QUESTION: OnboardingQuestion = {
  id: 'run_days',
  prompt: 'How many run days a week? Saved as a setting — not scheduled.',
  chips: ['0', '1', '2', '3', '4'],
}

const AGE_QUESTION: OnboardingQuestion = {
  id: 'training_age',
  prompt: 'How many years of consistent training?',
  chips: ['0', '1', '2', '3', '5', '8'],
}

export function isPackId(value: string): value is StarterPackId {
  return (PACK_IDS as readonly string[]).includes(value)
}

function asTrimmed(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function parseGoal(v: unknown): StarterPackId | undefined {
  if (typeof v !== 'string') return undefined
  const key = v.trim().toLowerCase().replace(/[^a-z0-9&]+/g, '_')
  return GOAL_ALIASES[key] ?? GOAL_ALIASES[v.trim().toLowerCase()]
}

function parsePain(v: unknown): PainValue | undefined {
  if (typeof v !== 'string') return undefined
  const key = v.trim().toLowerCase()
  return (PAIN_VALUES as readonly string[]).includes(key) ? key as PainValue : undefined
}

function parseStyle(v: unknown): StyleValue | undefined {
  if (typeof v !== 'string') return undefined
  const key = v.trim().toLowerCase()
  return (STYLE_VALUES as readonly string[]).includes(key) ? key as StyleValue : undefined
}

function parseEquipment(v: unknown): EquipmentValue[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: EquipmentValue[] = []
  for (const item of v) {
    if (typeof item !== 'string') return undefined
    const key = item.trim().toLowerCase()
    if (!(EQUIPMENT_VALUES as readonly string[]).includes(key)) return undefined
    if (!out.includes(key as EquipmentValue)) out.push(key as EquipmentValue)
  }
  return out
}

function parseLifts(v: unknown): OnboardingLifts | undefined {
  if (v === 'dont_know' || v === "don't know" || v === true) return { dont_know: true }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const lifts: OnboardingLifts = {}
  if (o.dont_know === true || o.dont_know === 'true') lifts.dont_know = true
  for (const k of ['squat', 'bench', 'deadlift'] as const) {
    const s = asTrimmed(o[k])
    if (s) lifts[k] = s
  }
  return lifts
}

function parseDays(v: unknown): number | undefined {
  if (v == null) return undefined
  if (typeof v === 'number' || typeof v === 'string') return resolveDaysChip(v)
  return undefined
}

function parseMinutes(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  if (n < 15 || n > 120) return undefined
  return n
}

function parseAge(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  if (n < 0 || n > 40) return undefined
  return n
}

export type AnswersResult =
  | { ok: true; answers: OnboardingAnswers }
  | { ok: false; error: string }

/**
 * Validate and canonicalize a patch of answers. Unknown keys are dropped.
 * Invalid enum / range values fail the whole patch (engine disposes).
 */
export function validateOnboardingAnswers(raw: unknown): AnswersResult {
  if (raw == null) return { ok: true, answers: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'answers must be an object' }
  }
  const src = raw as Record<string, unknown>
  const answers: OnboardingAnswers = {}

  if ('goal' in src && src.goal != null) {
    const goal = parseGoal(src.goal)
    if (!goal) return { ok: false, error: 'goal must be a known pack (get_strong, sport_sc, chase_total, hybrid, layoff, thirty_three, byo)' }
    answers.goal = goal
  }
  if ('days' in src && src.days != null) {
    const days = parseDays(src.days)
    if (days == null) return { ok: false, error: 'days must be 1–7, "5+", or "It changes week to week"' }
    answers.days = days
  }
  if ('minutes' in src && src.minutes != null) {
    const minutes = parseMinutes(src.minutes)
    if (minutes == null) return { ok: false, error: 'minutes must be an integer 15–120' }
    answers.minutes = minutes
  }
  if ('equipment' in src && src.equipment != null) {
    const equipment = parseEquipment(src.equipment)
    if (!equipment) return { ok: false, error: 'equipment must be an array of barbell|dumbbells|kettlebell|bands|bodyweight|machines|full_gym' }
    answers.equipment = equipment
  }
  if ('lifts' in src && src.lifts != null) {
    const lifts = parseLifts(src.lifts)
    if (!lifts) return { ok: false, error: 'lifts must be {squat,bench,deadlift} or "dont_know"' }
    answers.lifts = lifts
  }
  if ('pain' in src && src.pain != null) {
    const pain = parsePain(src.pain)
    if (!pain) return { ok: false, error: 'pain must be nothing|back|knee|shoulder|hip|other' }
    answers.pain = pain
  }
  if ('style' in src && src.style != null) {
    const style = parseStyle(src.style)
    if (!style) return { ok: false, error: 'style must be direct|explain|quiet' }
    answers.style = style
  }
  if ('sport' in src && src.sport != null) {
    const sport = asTrimmed(src.sport)
    if (!sport) return { ok: false, error: 'sport must be a non-empty string' }
    answers.sport = sport
  }
  if ('season' in src && src.season != null) {
    if (src.season !== 'in' && src.season !== 'off') return { ok: false, error: 'season must be in|off' }
    answers.season = src.season
  }
  if ('game_days' in src && src.game_days != null) {
    if (!Array.isArray(src.game_days) || src.game_days.some((d) => typeof d !== 'string')) {
      return { ok: false, error: 'game_days must be an array of strings' }
    }
    answers.game_days = src.game_days.map((d) => String(d))
  }
  if ('run_days' in src && src.run_days != null) {
    if (typeof src.run_days !== 'number' || !Number.isFinite(src.run_days)) {
      return { ok: false, error: 'run_days must be 0–7' }
    }
    answers.run_days = Math.max(0, Math.min(7, Math.round(src.run_days)))
  }
  if ('training_age' in src && src.training_age != null) {
    const age = parseAge(src.training_age)
    if (age == null) return { ok: false, error: 'training_age must be 0–40 years' }
    answers.training_age = age
  }
  if ('name' in src && src.name != null) {
    const name = asTrimmed(src.name)
    if (!name) return { ok: false, error: 'name must be a non-empty string' }
    answers.name = name.slice(0, 80)
  }
  return { ok: true, answers }
}

export function mergeAnswers(base: OnboardingAnswers, patch: OnboardingAnswers): OnboardingAnswers {
  return { ...base, ...patch }
}

export function painFlagTriggered(answers: OnboardingAnswers): boolean {
  return answers.pain != null && answers.pain !== 'nothing'
}

export interface PackRecommendation {
  pack: StarterPackId
  reason: string
  confidence: Confidence
  painFlagOverride: boolean
}

export function recommendStarterPack(
  answers: OnboardingAnswers,
  requested?: StarterPackId,
): PackRecommendation {
  if (painFlagTriggered(answers)) {
    return {
      pack: 'layoff',
      reason: 'Pain flag: anything other than Nothing routes to Back from a layoff. Check with a clinician before you load.',
      confidence: 'high',
      painFlagOverride: requested != null && requested !== 'layoff',
    }
  }

  if (requested) {
    const card = STARTER_PACKS.find((p) => p.id === requested)
    return {
      pack: requested,
      reason: `Start with ${card?.title ?? requested}${answers.goal && answers.goal !== requested ? ` (stated goal was ${answers.goal})` : ''}.`,
      confidence: answers.goal || answers.days != null ? 'high' : 'medium',
      painFlagOverride: false,
    }
  }

  if (answers.goal) {
    return {
      pack: answers.goal,
      reason: `Matches the stated goal (${STARTER_PACKS.find((p) => p.id === answers.goal)?.title ?? answers.goal}).`,
      confidence: answers.days != null && answers.pain != null ? 'high' : 'medium',
      painFlagOverride: false,
    }
  }

  if (answers.minutes != null && answers.minutes <= 30 && (answers.days == null || answers.days <= 3)) {
    return {
      pack: 'thirty_three',
      reason: 'Time-boxed: 30 minutes, 3 days.',
      confidence: answers.days != null ? 'high' : 'medium',
      painFlagOverride: false,
    }
  }

  const filled = Object.values(answers).filter((v) => v != null).length
  return {
    pack: 'get_strong',
    reason: 'Default first-12-weeks pack when the goal is still open.',
    confidence: filled >= 3 ? 'medium' : 'low',
    painFlagOverride: false,
  }
}

function answered(answers: OnboardingAnswers, id: string): boolean {
  switch (id) {
    case 'goal': return answers.goal != null
    case 'days': return answers.days != null
    case 'minutes': return answers.minutes != null
    case 'equipment': return answers.equipment != null
    case 'lifts': return answers.lifts != null
    case 'pain': return answers.pain != null
    case 'style': return answers.style != null
    case 'sport': return Boolean(answers.sport?.trim())
    case 'run_days': return answers.run_days != null
    case 'training_age': return answers.training_age != null
    default: return false
  }
}

export function nextOnboardingQuestion(answers: OnboardingAnswers): OnboardingQuestion | null {
  for (const q of ONBOARDING_QUESTIONS) {
    if (!answered(answers, q.id)) return q
  }
  const rec = recommendStarterPack(answers)
  if (rec.pack === 'sport_sc' && !answered(answers, 'sport')) return SPORT_QUESTION
  if (rec.pack === 'hybrid' && !answered(answers, 'run_days')) return RUN_QUESTION
  if (!answered(answers, 'training_age')) return AGE_QUESTION
  return null
}

export function settingsFromAnswers(answers: OnboardingAnswers, extra?: PackSettings): PackSettings {
  return {
    sport: answers.sport,
    season: answers.season,
    game_days: answers.game_days,
    run_days: answers.run_days,
    squat: answers.lifts?.dont_know ? undefined : answers.lifts?.squat,
    bench: answers.lifts?.dont_know ? undefined : answers.lifts?.bench,
    deadlift: answers.lifts?.dont_know ? undefined : answers.lifts?.deadlift,
    ...extra,
  }
}

export function trainingAgeFrom(answers: OnboardingAnswers, fallback = 2): number {
  return answers.training_age != null ? answers.training_age : fallback
}

export interface PackCardView {
  id: StarterPackId
  title: string
  who: string
  days: string
  length: string
  visible: boolean
  settings_schema: Record<string, string>
  seeds: {
    sessions: number
    first_phase: 'Stability'
    effective_training_age_rule: string
    time_box_minutes: number | null
  }
}

export function listStarterPackViews(): PackCardView[] {
  return STARTER_PACKS.map((card) => {
    const resolved = resolveStarterPack({
      id: card.id,
      trainingAge: 2,
      sessionsPick: card.id === 'sport_sc' ? 3 : undefined,
      settings: card.id === 'sport_sc' ? { sport: 'your sport', season: 'off' } : {},
    })
    const settings_schema: Record<string, string> = {}
    if (card.id === 'sport_sc') {
      settings_schema.sport = 'string — free text plus common picks'
      settings_schema.season = 'in | off'
      settings_schema.game_days = 'string[] — noted, not scheduled'
      settings_schema.sessions = '2 | 3 | 4'
    }
    if (card.id === 'chase_total') {
      settings_schema.squat = 'optional recent number'
      settings_schema.bench = 'optional recent number'
      settings_schema.deadlift = 'optional recent number'
    }
    if (card.id === 'hybrid') settings_schema.run_days = '0–7 — setting only'
    if (card.id === 'byo') {
      settings_schema.plan_days = '1–7 from their plan'
      settings_schema.plan_text = 'pasted plan'
    }
    const ageRule = card.id === 'layoff'
      ? 'min(training_age, 1) for the first build; real training_age is still saved'
      : 'training_age as given'
    return {
      id: card.id,
      title: card.title,
      who: card.who,
      days: card.days,
      length: card.length,
      visible: card.visible,
      settings_schema,
      seeds: {
        sessions: resolved.sessions,
        first_phase: 'Stability',
        effective_training_age_rule: ageRule,
        time_box_minutes: resolved.timeBoxMinutes,
      },
    }
  })
}

export interface InsightSnap {
  claim: string
  category: string
  confidence: number
  status: string
  priority: string
}

export function formatTheRead(insights: InsightSnap[], answers: OnboardingAnswers): string {
  const open = insights.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const p1 = open.find((i) => i.priority === 'P1') ?? open[0]
  if (p1) {
    const pct = Math.round(Number(p1.confidence) * 100)
    return [
      `P1 ${p1.category} [${p1.status}, ${pct}%]: ${p1.claim}`,
      'What would change my mind: a clean session with no pain at the named limiter, or a logged set that misses the claim.',
    ].join('\n')
  }
  if (painFlagTriggered(answers)) {
    return [
      `P1 Recovery [hypothesis, 40%]: Pain at ${answers.pain} — start conservative and read the limiter before you load.`,
      'What would change my mind: two pain-free sessions and clinician clearance.',
    ].join('\n')
  }
  return [
    'P1 Strength [hypothesis, 35%]: First-session prior only — no logged limiter yet.',
    'What would change my mind: the first logged session and how the lead lift felt.',
  ].join('\n')
}

function formatExerciseLine(ex: { name: string; sets: number; reps: string; load?: string; cue?: string }): string {
  const load = ex.load ? ` · ${ex.load}` : ''
  const cue = ex.cue ? `\n  cue: ${ex.cue}` : ''
  return `- ${ex.name} · ${ex.sets}×${ex.reps}${load}\n  arithmetic: ${ex.sets} sets × ${ex.reps} reps${cue}`
}

export function formatSession1Preview(input: {
  pack: StarterPackId
  answers: OnboardingAnswers
  settings?: PackSettings
  sessionsPick?: string | number
}): {
  text: string
  resolved: ReturnType<typeof resolveStarterPack>
  minutes: number[]
} {
  const { resolved, design } = previewPackProvisional({
    id: input.pack,
    trainingAge: trainingAgeFrom(input.answers),
    sessionsPick: input.sessionsPick ?? input.answers.days,
    settings: settingsFromAnswers(input.answers, input.settings),
  })
  const first = design.sessions[0]
  const minutes = design.sessions.map((s) => estimateSessionMinutes(s.exercises))
  const lines = [
    `# Session 1 preview — ${resolved.goal}`,
    `Pack: ${resolved.id} · ${resolved.sessions} days · first phase ${resolved.firstPhase}`,
    resolved.timeBoxMinutes != null ? `Time box: ${resolved.timeBoxMinutes} min (engine trims until the estimate fits)` : null,
    resolved.id === 'layoff' ? `Effective training age for the build: ${resolved.effectiveTrainingAge} (layoff cap)` : null,
    '',
    first
      ? [
          `## ${first.name} — ~${minutes[0]} min`,
          first.intent ? `Intent: ${first.intent}` : null,
          ...first.exercises.map(formatExerciseLine),
          '',
          `Estimated minutes: ${minutes[0]} (sum of movement + rest estimates; the engine still clamps every load)`,
        ].filter((l) => l !== null).join('\n')
      : 'No session designed.',
  ]
  return { text: lines.filter((l) => l !== null).join('\n'), resolved, minutes }
}

export function setupFinished(step: string, hasSession1: boolean): boolean {
  if (hasSession1) return true
  return step === 'first_session_pending' || step === 'first_session_complete' || step === 'complete'
}
