/**
 * Starter packs — seeds for the existing provisional build.
 *
 * A pack is parameters (days, goal text, a couple of settings), not a content
 * library. Sport is a setting on `sport_sc`, never a per-sport exercise table.
 * Pure data + pure helpers so `starterPacks.check.ts` can run under node.
 *
 * Card `days` / `length` strings are the engine-verified copy from issue #31
 * (Director of Product signed off 2026-10-27). Do not paraphrase them.
 */

import { estimateSessionMinutes } from '../../supabase/functions/_shared/engine/programDraft.ts'
import { validateProvisionalProgram } from './safety.ts'
import type { ProgramDesignResult, ProgramExercise } from './programDesignTypes.ts'
import type { ExerciseTemplate } from '../types/database.ts'

export type StarterPackId =
  | 'sport_sc'
  | 'get_strong'
  | 'chase_total'
  | 'hybrid'
  | 'layoff'
  | 'thirty_three'
  | 'byo'

export type Season = 'in' | 'off'

export interface StarterPackCard {
  id: StarterPackId
  title: string
  who: string
  /** Exact card copy from the #31 table. */
  days: string
  /** Exact card copy from the #31 table. */
  length: string
  visible: boolean
}

// TODO(onboarding_agent_v1): BYO pack is hidden. Opening the existing program
// editor with the pasted plan as the first message is not a clean hand-off from
// pre-auth onboarding (ProgramEditScreen has no initial-message seam, and it
// only mounts after `first_session_pending`). Re-enable when that seam exists.
export const BYO_PACK_VISIBLE = false

export const STARTER_PACKS: readonly StarterPackCard[] = [
  {
    id: 'sport_sc',
    title: 'S&C for your sport',
    who: 'A lifter who plays a sport and wants to play better, not just lift more.',
    days: '2, 3 or 4 (user picks one)',
    length: 'about 30-45 min to start',
    visible: true,
  },
  {
    id: 'get_strong',
    title: 'Get strong (first 12 weeks)',
    who: 'Newer lifters, under a year of consistent training.',
    days: '3',
    length: 'about 30-45 min to start',
    visible: true,
  },
  {
    id: 'chase_total',
    title: 'Powerlifting / chase a total',
    who: 'Lifters with a meet or a number in mind.',
    days: '4',
    length: 'about 30-45 min to start; heavy SBD after your first 4-week block',
    visible: true,
  },
  {
    id: 'hybrid',
    title: 'Hybrid / Hyrox',
    who: 'Lifters who also run or race.',
    days: '3 lift days',
    length: 'about 30-45 min',
    visible: true,
  },
  {
    id: 'layoff',
    title: 'Back from a layoff',
    who: 'Returning after injury, illness, or a break of 6+ weeks.',
    days: '3',
    length: 'about 30 min to start',
    visible: true,
  },
  {
    id: 'thirty_three',
    title: '30 minutes, 3 days',
    who: 'Busy parents and shift workers.',
    days: '3',
    length: 'about 30 min',
    visible: true,
  },
  {
    id: 'byo',
    title: 'Bring your own plan',
    who: 'A lifter who already has a program — coach, Reddit, or an agent.',
    days: '1-7 (from their plan)',
    length: "your plan's length; we flag sessions over 75 min",
    visible: BYO_PACK_VISIBLE,
  },
]

export function visibleStarterPacks(): StarterPackCard[] {
  return STARTER_PACKS.filter((p) => p.visible)
}

export function clampSessions(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(7, Math.round(n)))
}

/**
 * Days-chip → a single integer 1–7.
 *   "5+" → 5
 *   "It changes week to week" → 3
 *   ranges ("2-4", "2–4") → one integer (the lower bound)
 */
export function resolveDaysChip(value: string | number): number {
  if (typeof value === 'number') return clampSessions(value)
  const s = value.trim()
  if (s === '5+') return 5
  if (s === 'It changes week to week') return 3
  const range = s.match(/^(\d+)\s*[-–]\s*(\d+)/)
  if (range) return clampSessions(Number(range[1]))
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? clampSessions(n) : 3
}

export interface PackSettings {
  sport?: string
  season?: Season
  game_days?: string[]
  run_days?: number
  squat?: string
  bench?: string
  deadlift?: string
  plan_days?: number
  plan_text?: string
}

export interface PackResolveInput {
  id: StarterPackId
  trainingAge: number
  sessionsPick?: string | number
  settings?: PackSettings
}

export interface ResolvedPack {
  id: StarterPackId
  sessions: number
  goal: string
  obstacle: string
  trainingAge: number
  /** Used for the provisional safety ceiling + first-session strengthen. */
  effectiveTrainingAge: number
  timeBoxMinutes: number | null
  settings: PackSettings
  /** First 28-day block. Packs never start on Sport (that's the 4th phase). */
  firstPhase: 'Stability'
}

export function resolveStarterPack(input: PackResolveInput): ResolvedPack {
  const trainingAge = Number.isFinite(input.trainingAge) ? input.trainingAge : 0
  const settings: PackSettings = { ...(input.settings ?? {}) }
  const base = {
    id: input.id,
    trainingAge,
    effectiveTrainingAge: trainingAge,
    timeBoxMinutes: null as number | null,
    settings,
    firstPhase: 'Stability' as const,
  }

  switch (input.id) {
    case 'sport_sc': {
      const pick = input.sessionsPick ?? 3
      const sessions = clampSessions(
        typeof pick === 'number' || /^\d+$/.test(String(pick).trim())
          ? Number(pick)
          : resolveDaysChip(pick),
      )
      const allowed = sessions === 2 || sessions === 3 || sessions === 4 ? sessions : 3
      const sport = (settings.sport ?? '').trim() || 'your sport'
      const season = settings.season === 'in' || settings.season === 'off' ? settings.season : 'off'
      const gameDays = Array.isArray(settings.game_days) ? settings.game_days : []
      const seasonLabel = season === 'in' ? 'in-season' : 'off-season'
      const games = gameDays.length ? ` Game days (noted, not scheduled): ${gameDays.join(', ')}.` : ''
      return {
        ...base,
        sessions: allowed,
        settings: { ...settings, sport: sport === 'your sport' ? (settings.sport ?? '') : sport, season, game_days: gameDays },
        goal: `S&C for ${sport}, ${seasonLabel}`,
        obstacle: `S&C for ${sport} (${seasonLabel}).${games}`,
      }
    }
    case 'get_strong':
      return {
        ...base,
        sessions: 3,
        goal: 'build base strength',
        obstacle: 'Getting strong — first 12 weeks, building a base.',
      }
    case 'chase_total': {
      const lifts = [
        settings.squat ? `S ${settings.squat}` : null,
        settings.bench ? `B ${settings.bench}` : null,
        settings.deadlift ? `D ${settings.deadlift}` : null,
      ].filter((x): x is string => !!x)
      const liftBit = lifts.length ? ` Lifts: ${lifts.join(', ')}.` : ''
      return {
        ...base,
        sessions: 4,
        goal: `Chase a total.${liftBit}`,
        obstacle: `Powerlifting — chase a total.${liftBit}`,
      }
    }
    case 'hybrid':
      return {
        ...base,
        sessions: 3,
        settings: {
          ...settings,
          run_days: Math.max(0, Math.min(7, Math.round(Number(settings.run_days ?? 0)) || 0)),
        },
        goal: 'Hybrid strength',
        obstacle: 'Hybrid / Hyrox — three lift days. Run days are a setting, not a schedule.',
      }
    case 'layoff':
      return {
        ...base,
        sessions: 3,
        effectiveTrainingAge: Math.min(trainingAge, 1),
        goal: 'Return from a layoff',
        obstacle: 'Back from a layoff — conservative start.',
      }
    case 'thirty_three':
      return {
        ...base,
        sessions: 3,
        timeBoxMinutes: 30,
        goal: 'Train in 30 minutes, 3 days',
        obstacle: 'Thirty minutes, three days — time-boxed full body.',
      }
    case 'byo': {
      const fromPlan = settings.plan_days ?? input.sessionsPick ?? 3
      return {
        ...base,
        sessions: resolveDaysChip(fromPlan),
        goal: 'Bring your own plan',
        obstacle: (settings.plan_text ?? '').trim() || 'Bring-your-own plan.',
      }
    }
  }
}

export type TimeBoxExercise = Pick<ExerciseTemplate, 'name' | 'sets' | 'reps'> & {
  load?: string
}

/**
 * Trim trailing exercises until `estimateSessionMinutes` is <= `maxMinutes`.
 * Never drops below 3 exercises — the provisional floor.
 */
export function timeBoxSession<T extends TimeBoxExercise>(exercises: T[], maxMinutes: number): T[] {
  if (exercises.length <= 3) return exercises.slice()
  let next = exercises.slice()
  while (next.length > 3 && estimateSessionMinutes(next) > maxMinutes) {
    next = next.slice(0, -1)
  }
  return next
}

const PREVIEW_SEED: ProgramExercise[] = [
  { name: 'Goblet Squat', sets: 3, reps: '8', load: 'light', cue: 'Chest tall' },
  { name: 'Barbell Back Squat', sets: 5, reps: '5', load: 'light', cue: 'dropped by validator' },
  { name: 'Romanian Deadlift', sets: 3, reps: '8', load: 'moderate', cue: 'Hinge' },
  { name: 'Dead Bug', sets: 3, reps: '8 each side', load: 'bodyweight', cue: 'Lumbar flat' },
  { name: 'Band Pull-Apart', sets: 3, reps: '15', load: 'light', cue: 'Scapulae' },
  { name: 'Bird Dog', sets: 3, reps: '8 each side', load: 'bodyweight', cue: 'Hips level' },
  { name: 'Glute Bridge', sets: 3, reps: '12', load: 'bodyweight', cue: 'Brace first' },
]

/**
 * Pure stand-in for the agent → validator → time-box path. Always Stability —
 * packs do not open a Sport-phase routine. Used by checks and by the client
 * to reason about a pack before persist.
 */
export function previewPackProvisional(input: PackResolveInput): {
  resolved: ResolvedPack
  design: ProgramDesignResult
} {
  const resolved = resolveStarterPack(input)
  const raw: ProgramDesignResult = {
    goal: resolved.goal,
    non_negotiables: [],
    sessions: [
      { name: 'Session A', intent: resolved.goal, exercises: PREVIEW_SEED.map((e) => ({ ...e })) },
      { name: 'Session B', intent: resolved.goal, exercises: PREVIEW_SEED.map((e) => ({ ...e })) },
      { name: 'Session C', intent: resolved.goal, exercises: PREVIEW_SEED.map((e) => ({ ...e })) },
    ],
  }
  let design = validateProvisionalProgram(raw, { trainingAge: resolved.effectiveTrainingAge })
  if (resolved.timeBoxMinutes != null) {
    const cap = resolved.timeBoxMinutes
    design = {
      ...design,
      sessions: design.sessions.map((s) => ({
        ...s,
        exercises: timeBoxSession(s.exercises, cap),
      })),
    }
  }
  return { resolved, design }
}

export function packToProvisionalFields(resolved: ResolvedPack, name: string): {
  name: string | null
  trainingAge: number
  sessions: number
  obstacle: string | null
  effectiveTrainingAge: number
  timeBoxMinutes?: number
} {
  return {
    name: name.trim() || null,
    trainingAge: resolved.trainingAge,
    sessions: resolved.sessions,
    obstacle: resolved.obstacle || null,
    effectiveTrainingAge: resolved.effectiveTrainingAge,
    timeBoxMinutes: resolved.timeBoxMinutes ?? undefined,
  }
}
