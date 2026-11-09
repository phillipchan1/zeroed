// Onboarding connector tools for the live Worker MCP (/api/mcp, also served
// at /functions/v1/mcp). Behind onboarding_agent_v1 (off unless exactly "1").
// Write tools preview first; they write only with confirm=true.

import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { jsonBlock } from '../../supabase/functions/_shared/zeroedFormat.ts'
import {
  formatSession1Preview,
  formatTheRead,
  isPackId,
  listStarterPackViews,
  mergeAnswers,
  nextOnboardingQuestion,
  recommendStarterPack,
  settingsFromAnswers,
  setupFinished,
  trainingAgeFrom,
  validateOnboardingAnswers,
  type InsightSnap,
  type OnboardingAnswers,
} from '../../src/engine/onboardingConnector.ts'
import {
  previewPackProvisional,
  type PackSettings,
  type StarterPackId,
} from '../../src/engine/starterPacks.ts'

export const ONBOARDING_SERVER_INSTRUCTIONS =
  "If get_onboarding_state shows setup isn't finished, run onboarding before coaching."

export function onboardingAgentV1On(raw: string | undefined | null): boolean {
  return raw === '1'
}

type ToolAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type OnboardingMcpTool = McpTool & { annotations?: ToolAnnotations }

export const ONBOARDING_TOOLS: OnboardingMcpTool[] = [
  {
    name: 'get_onboarding_state',
    description: 'Current onboarding_step, answers so far, the next suggested question, and whether a pack or session 1 exists. Call this first when setup may be unfinished.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_starter_packs',
    description: 'The 7 starter packs: who each is for, settings schema (S&C sport, season, game days, etc.), and what each seeds. Sport is a setting, not a library.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'record_onboarding_answers',
    description: 'Save onboarding answers (goal, days, minutes, equipment, lifts, pain, style). Validated against an enum and range schema. Without confirm=true it only previews the merged answers.',
    inputSchema: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          description: 'Patch of answers. Unknown keys are dropped. Invalid enums/ranges are refused.',
          properties: {
            goal: { type: 'string', description: 'Pack id or alias: get_strong, sport_sc, chase_total, hybrid, layoff, thirty_three, byo' },
            days: { description: '1–7, "5+", or "It changes week to week"' },
            minutes: { type: 'integer', minimum: 15, maximum: 120 },
            equipment: {
              type: 'array',
              items: { type: 'string', enum: ['barbell', 'dumbbells', 'kettlebell', 'bands', 'bodyweight', 'machines', 'full_gym'] },
            },
            lifts: { description: '{squat,bench,deadlift} strings, or "dont_know"' },
            pain: { type: 'string', enum: ['nothing', 'back', 'knee', 'shoulder', 'hip', 'other'] },
            style: { type: 'string', enum: ['direct', 'explain', 'quiet'] },
            sport: { type: 'string' },
            season: { type: 'string', enum: ['in', 'off'] },
            game_days: { type: 'array', items: { type: 'string' } },
            run_days: { type: 'integer', minimum: 0, maximum: 7 },
            training_age: { type: 'integer', minimum: 0, maximum: 40 },
            name: { type: 'string' },
          },
          additionalProperties: false,
        },
        confirm: { type: 'boolean', description: 'true writes; anything else previews' },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'preview_starter_pack',
    description: 'Given a pack + settings, return the recommendation, confidence, the pain-flag override if any, the read, and session 1 with arithmetic. Writes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'sport_sc | get_strong | chase_total | hybrid | layoff | thirty_three | byo' },
        settings: { type: 'object', description: 'Pack settings (sport, season, game_days, run_days, lifts, …)' },
        sessions: { description: 'Days pick for sport_sc (2, 3 or 4) or a days chip' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'start_starter_pack',
    description: 'Write the pack + settings, build session 1 through the same provisional path the app uses, and advance onboarding_step. Requires confirm=true. Idempotent per athlete; refuses a live program unless replace=true.',
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'sport_sc | get_strong | chase_total | hybrid | layoff | thirty_three | byo' },
        settings: { type: 'object', description: 'Pack settings' },
        sessions: { description: 'Days pick for sport_sc (2, 3 or 4) or a days chip' },
        confirm: { type: 'boolean', description: 'Must be true. Refuses otherwise.' },
        replace: { type: 'boolean', description: 'If a live program exists, pause it and write a new session 1.' },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
  },
]

export const ONBOARDING_TOOL_NAMES = new Set(ONBOARDING_TOOLS.map((t) => t.name))

export function listedZeroedTools(base: McpTool[], flagOn: boolean): McpTool[] {
  return flagOn ? [...base, ...ONBOARDING_TOOLS] : base
}

export interface OnboardingSnapshot {
  onboarding_step: string
  starter_pack: string | null
  starter_pack_settings: PackSettings | null
  onboarding_answers: OnboardingAnswers | null
  name: string | null
  training_age: number | null
  goals: string | null
  sessions_per_week: number | null
  obstacle: string | null
  sport: string | null
}

export interface Session1Plan {
  goal: string
  phaseName: 'Stability'
  weekStart: string
  weekEnd: string
  retestDate: string
  nonNegotiables: string[]
  advancementCriteria: string[]
  sessions: Array<{
    name: string
    intent: string
    sessionType: string
    exercises: Array<{ name: string; sets: number; reps: string; load?: string; cue?: string }>
  }>
}

export interface OnboardingIo {
  loadSnapshot(): Promise<OnboardingSnapshot>
  loadInsights(): Promise<InsightSnap[]>
  hasLiveProgram(): Promise<boolean>
  saveAnswers(answers: OnboardingAnswers): Promise<void>
  persistStart(input: {
    packId: string
    settings: PackSettings
    answers: OnboardingAnswers
    athletePatch: {
      name: string | null
      training_age: number
      goals: string
      sessions_per_week: number
      obstacle: string
      sport: string | null
    }
    plan: Session1Plan
    replace: boolean
  }): Promise<{ programId: string }>
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function parseRequestedPack(v: unknown): StarterPackId | undefined {
  if (typeof v !== 'string') return undefined
  const parsed = validateOnboardingAnswers({ goal: v })
  if (parsed.ok && parsed.answers.goal) return parsed.answers.goal
  return isPackId(v) ? v : undefined
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function answersFromSnap(snap: OnboardingSnapshot): OnboardingAnswers {
  const stored = snap.onboarding_answers && typeof snap.onboarding_answers === 'object'
    ? snap.onboarding_answers
    : {}
  const parsed = validateOnboardingAnswers(stored)
  const answers = parsed.ok ? { ...parsed.answers } : {}
  if (answers.training_age == null && snap.training_age != null) answers.training_age = snap.training_age
  if (answers.name == null && snap.name) answers.name = snap.name
  if (answers.sport == null && snap.sport) answers.sport = snap.sport
  if (answers.days == null && snap.sessions_per_week != null) answers.days = snap.sessions_per_week
  return answers
}

function sessionsFor(
  pack: StarterPackId,
  answers: OnboardingAnswers,
  settings: PackSettings,
  sessionsPick?: string | number,
): Session1Plan['sessions'] {
  const { design } = previewPackProvisional({
    id: pack,
    trainingAge: trainingAgeFrom(answers),
    sessionsPick: sessionsPick ?? answers.days,
    settings: settingsFromAnswers(answers, settings),
  })
  return design.sessions.map((s) => ({
    name: s.name,
    intent: s.intent,
    sessionType: 'strength',
    exercises: s.exercises.map((e) => ({
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      load: e.load,
      cue: e.cue,
    })),
  }))
}

function formatState(input: {
  snap: OnboardingSnapshot
  answers: OnboardingAnswers
  hasSession1: boolean
  insights: InsightSnap[]
}): string {
  const next = nextOnboardingQuestion(input.answers)
  const finished = setupFinished(input.snap.onboarding_step, input.hasSession1)
  const rec = Object.keys(input.answers).length ? recommendStarterPack(input.answers) : null
  return [
    '# Onboarding state',
    `Step: ${input.snap.onboarding_step}`,
    `Setup finished: ${finished ? 'yes' : 'no'}`,
    `Starter pack: ${input.snap.starter_pack ?? 'none'}`,
    `Session 1: ${input.hasSession1 ? 'exists' : 'none'}`,
    '',
    '## Answers so far',
    Object.keys(input.answers).length ? jsonBlock(input.answers) : 'None recorded.',
    '',
    next
      ? `## Next question\n${next.prompt}\nChips: ${next.chips.join(', ')}\n(id: ${next.id})`
      : '## Next question\nNone — ready to preview_starter_pack / start_starter_pack.',
    rec ? `\nSuggested pack: ${rec.pack} (${rec.confidence}) — ${rec.reason}` : null,
    '',
    '## The read',
    formatTheRead(input.insights, input.answers),
  ].filter((l) => l !== null).join('\n')
}

export async function runOnboardingTool(
  name: string,
  args: Record<string, unknown>,
  io: OnboardingIo,
): Promise<string> {
  if (name === 'get_onboarding_state') {
    const [snap, insights, hasSession1] = await Promise.all([
      io.loadSnapshot(),
      io.loadInsights(),
      io.hasLiveProgram(),
    ])
    return formatState({ snap, answers: answersFromSnap(snap), hasSession1, insights })
  }

  if (name === 'list_starter_packs') {
    const views = listStarterPackViews()
    return [
      '# Starter packs',
      'A pack seeds days, the first-session prior, and settings. The engine still clamps every load. Sport is a setting on S&C, not a library.',
      '',
      ...views.map((v) => [
        `## ${v.title} (\`${v.id}\`)${v.visible ? '' : ' — hidden for v1'}`,
        `Who: ${v.who}`,
        `Days: ${v.days}`,
        `Length: ${v.length}`,
        `Seeds: ${v.seeds.sessions} days, first phase ${v.seeds.first_phase}` +
          (v.seeds.time_box_minutes != null ? `, time box ${v.seeds.time_box_minutes} min` : ''),
        `Effective training age: ${v.seeds.effective_training_age_rule}`,
        Object.keys(v.settings_schema).length
          ? `Settings:\n${Object.entries(v.settings_schema).map(([k, d]) => `- ${k}: ${d}`).join('\n')}`
          : 'Settings: none',
      ].join('\n')),
      '',
      jsonBlock(views),
    ].join('\n')
  }

  if (name === 'record_onboarding_answers') {
    const patchRaw = 'answers' in args ? args.answers : args
    const parsed = validateOnboardingAnswers(patchRaw)
    if (!parsed.ok) return `Refused: ${parsed.error}`
    const snap = await io.loadSnapshot()
    const merged = mergeAnswers(answersFromSnap(snap), parsed.answers)
    const next = nextOnboardingQuestion(merged)
    const preview = [
      '# Record onboarding answers',
      '',
      '## Merged answers',
      jsonBlock(merged),
      '',
      next
        ? `## Next question\n${next.prompt}\nChips: ${next.chips.join(', ')}`
        : '## Next question\nNone — ready to preview_starter_pack.',
    ].join('\n')
    if (args.confirm !== true) {
      return `${preview}\n\nPreview only — call again with confirm=true to save it.`
    }
    await io.saveAnswers(merged)
    return `${preview}\n\nSaved.`
  }

  if (name === 'preview_starter_pack') {
    const snap = await io.loadSnapshot()
    const answers = answersFromSnap(snap)
    const requested = parseRequestedPack(args.pack) ?? answers.goal
    const rec = recommendStarterPack(answers, requested)
    const settings = { ...settingsFromAnswers(answers), ...asRecord(args.settings) }
    const preview = formatSession1Preview({
      pack: rec.pack,
      answers,
      settings,
      sessionsPick: args.sessions as string | number | undefined,
    })
    const insights = await io.loadInsights()
    return [
      '# Pack preview',
      `Recommended: ${rec.pack} (${rec.confidence})`,
      rec.reason,
      rec.painFlagOverride ? 'Pain-flag override applied — the requested pack was replaced with layoff.' : 'No pain-flag override.',
      requested && requested !== rec.pack ? `Requested: ${requested}` : null,
      '',
      '## The read',
      formatTheRead(insights, answers),
      '',
      preview.text,
      '',
      'Writes nothing. start_starter_pack with confirm=true persists this pack and session 1.',
    ].filter((l) => l !== null).join('\n')
  }

  if (name === 'start_starter_pack') {
    if (args.confirm !== true) {
      return 'Refused: start_starter_pack requires confirm=true. Call preview_starter_pack first, then start with confirm=true.'
    }
    const snap = await io.loadSnapshot()
    const answers = answersFromSnap(snap)
    const requested = parseRequestedPack(args.pack) ?? answers.goal
    const rec = recommendStarterPack(answers, requested)
    const settings = { ...settingsFromAnswers(answers), ...asRecord(args.settings) }
    const hasLive = await io.hasLiveProgram()
    const samePack = snap.starter_pack === rec.pack && hasLive
    if (hasLive && !samePack && args.replace !== true) {
      return 'Refused: this athlete already has a live program. Pass replace=true to pause it and write a new session 1.'
    }
    if (samePack && args.replace !== true) {
      return [
        `# Already started — ${rec.pack}`,
        'Idempotent: a live program and this pack are already on the athlete. Nothing written.',
        `Step: ${snap.onboarding_step}`,
      ].join('\n')
    }

    const preview = formatSession1Preview({
      pack: rec.pack,
      answers,
      settings,
      sessionsPick: args.sessions as string | number | undefined,
    })
    const start = todayIso()
    const plan: Session1Plan = {
      goal: preview.resolved.goal,
      phaseName: 'Stability',
      weekStart: start,
      weekEnd: addDays(start, 27),
      retestDate: addDays(start, 28),
      nonNegotiables: ['Move well before you move heavy', 'Log how each session felt'],
      advancementCriteria: [
        'Pattern quality holds across all sets',
        'Zero pain signals for 3 consecutive sessions',
      ],
      sessions: sessionsFor(rec.pack, answers, settings, args.sessions as string | number | undefined),
    }
    const { programId } = await io.persistStart({
      packId: rec.pack,
      settings: preview.resolved.settings,
      answers,
      athletePatch: {
        name: answers.name ?? snap.name,
        training_age: preview.resolved.trainingAge,
        goals: preview.resolved.goal,
        sessions_per_week: preview.resolved.sessions,
        obstacle: preview.resolved.obstacle,
        sport: preview.resolved.settings.sport ?? snap.sport,
      },
      plan,
      replace: args.replace === true,
    })
    return [
      `# Started ${rec.pack}`,
      rec.reason,
      rec.painFlagOverride ? 'Pain-flag override applied.' : null,
      'onboarding_step → first_session_pending',
      `program: ${programId}`,
      '',
      preview.text,
    ].filter((l) => l !== null).join('\n')
  }

  throw new Error(`Unknown tool: ${name}`)
}
