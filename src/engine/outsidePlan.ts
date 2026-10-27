// =============================================================================
// OUTSIDE THE PLAN — a session the plan didn't write: a BJJ class, a run, a
// match. Logged in a few taps as how long it took and how hard the whole thing
// was (session RPE), plus three exposure tags, and filed as an ordinary session
// so the outbox, the log and the MCP read it like any other.
//
// It never counts toward the planned week. Its routineId stays empty until
// commitSession files it under the athlete's one external program, and every
// week count reads the active program only.
//
// Session RPE is Foster's: one 0–10 rating of the whole session (CR-10), the
// same tap the finish of a planned session asks for. Load = RPE × minutes.
//
// Pure, no I/O (see outsidePlan.check.ts).
// =============================================================================

import type { PendingSession } from './index.ts'
import type { ProgramEdit } from './agentClient.ts'
import { applyEditsToDraft, type DraftSession, type ProgramDraft } from './programDraft.ts'
import type { ExposureTags, ExerciseTemplate, SetLog } from '../types/database.ts'

/** Offered when the athlete hasn't logged anything yet; their own come first after that. */
export const SUGGESTED_ACTIVITIES = ['Run', 'BJJ', 'Football', 'Class', 'Swim', 'Bike'] as const

export const MINUTE_CHOICES = [20, 30, 45, 60, 90, 120] as const

const MAX_ACTIVITY = 40
const MAX_MINUTES = 600
const REMEMBERED = 6

// Foster's modified CR-10. 6, 8 and 9 carry no word of their own on the scale.
const CR10: Record<number, string> = {
  0: 'Rest',
  1: 'Very, very easy',
  2: 'Easy',
  3: 'Moderate',
  4: 'Somewhat hard',
  5: 'Hard',
  6: 'Hard to very hard',
  7: 'Very hard',
  8: 'Very hard to maximal',
  9: 'Very hard to maximal',
  10: 'Maximal',
}

export const SESSION_RPE_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

export function sessionRpeWord(rpe: number): string {
  return CR10[rpe] ?? ''
}

/** A whole number 0–10, or null. */
export function cleanSessionRpe(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10 ? n : null
}

/** Whole minutes, 1–600, or null. */
export function cleanMinutes(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const m = Math.round(n)
  return m >= 1 && m <= MAX_MINUTES ? m : null
}

/** What the athlete typed, tidied: one line, capped, first letter up. Null when there's nothing. */
export function cleanActivity(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY).trim()
  if (!s) return null
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The athlete's own activities, newest first, deduped without regard to case. */
export function rememberActivity(list: readonly string[], activity: string): string[] {
  const clean = cleanActivity(activity)
  if (!clean) return [...list]
  const key = clean.toLowerCase()
  return [clean, ...list.filter((a) => a.toLowerCase() !== key)].slice(0, REMEMBERED)
}

/** Chips to offer: the athlete's own first, topped up with suggestions they haven't used. */
export function activityChoices(remembered: readonly string[]): string[] {
  const seen = new Set(remembered.map((a) => a.toLowerCase()))
  const fill = SUGGESTED_ACTIVITIES.filter((a) => !seen.has(a.toLowerCase()))
  return [...remembered, ...fill].slice(0, REMEMBERED)
}

export function isOutsidePlan(p: { outsidePlan?: unknown }): boolean {
  return p.outsidePlan != null
}

/**
 * A queued session that must not fill a planned slot: one logged outside the
 * plan, or a one-off the coach planned. The week strip and ring skip these.
 */
export function isOffPlan(p: { outsidePlan?: unknown; source?: string | null }): boolean {
  return p.outsidePlan != null || p.source === 'external'
}

export interface OutsidePlanInput {
  id: string
  athleteId: string
  athleteName: string | null
  activity: string
  minutes: number
  sessionRpe: number
  exposure: ExposureTags
  /** When it happened (ISO). */
  performedAt: string
  queuedAt: string
}

/**
 * The queued session for one log. One time-tracked row holding the minutes, so
 * every reader that already understands a timed set (the MCP formatter, the log)
 * shows it without learning anything new. Throws on input the sheet should
 * never have let through.
 */
export function buildOutsidePlanSession(input: OutsidePlanInput): PendingSession {
  const activity = cleanActivity(input.activity)
  const minutes = cleanMinutes(input.minutes)
  const sessionRpe = cleanSessionRpe(input.sessionRpe)
  if (!activity || minutes == null || sessionRpe == null) throw new Error('outside-plan session needs an activity, minutes and a session RPE')

  const exposure: ExposureTags = {}
  if (input.exposure.impact) exposure.impact = true
  if (input.exposure.sprint) exposure.sprint = true
  if (input.exposure.contact) exposure.contact = true

  const row: ExerciseTemplate = { name: activity, sets: 1, reps: `${minutes} min`, tracking_type: 'time', exposure }
  const set: SetLog = { set: 1, weight: null, reps: null, rpe: null, done: true, duration: minutes * 60, distance: null }

  return {
    id: input.id,
    athleteId: input.athleteId,
    routineId: '',
    actualWeights: { 0: [set] },
    actualReps: { 0: [0] },
    rpe: null,
    durationMins: minutes,
    setsDone: 0,
    athleteName: input.athleteName,
    onboardingTransition: null,
    debrief: null,
    editWorkoutId: null,
    performedAt: input.performedAt,
    queuedAt: input.queuedAt,
    exercisesSnapshot: [row],
    sessionRpe,
    outsidePlan: { activity, minutes, exposure },
  }
}

// ---- A one-off the coach plans ----------------------------------------------
// "Easy run with my wife." "Hotel gym, dumbbells, 45 minutes." The athlete says
// what they've got; the coach builds one session for today. It reuses the
// program editor's task and its checks rather than a new model call: the week
// it's handed is empty on purpose, and the one add_session that comes back goes
// through applyEditsToDraft, the same bounds every edited session gets. Nothing
// here touches the program.

export const ONE_OFF_EXAMPLES = [
  'Easy run with my wife, about 40 minutes',
  'Hotel gym, dumbbells only, 45 minutes',
  'Bodyweight in my room, 20 minutes',
] as const

const MAX_REQUEST = 500

/**
 * The athlete's words, framed so the program editor builds one session and
 * leaves the week alone. With a session already on the table, it changes that
 * one instead ("shorter", "no running").
 */
export function oneOffMessage(request: string, revising = false): string {
  const said = request.replace(/\s+/g, ' ').trim().slice(0, MAX_REQUEST)
  return [
    'ONE-OFF SESSION FOR TODAY, OUTSIDE THE PROGRAM. Not a change to their week: nothing you return is saved to the program.',
    revising
      ? 'The week you are handed holds only that one-off session. Change THAT session with surgical edits (session_name is its name) to do what they ask below.'
      : 'The week you are handed is empty on purpose. Return exactly one add_session edit: session_name a short name for it (2–4 words), set_intent one line on what it is for, set_session_type, and exercises for the whole session, warm-up included when it needs one.',
    'Build what they describe, around what you know about them: their lifts, their weak-link stack, how long they have, the kit they have. Loads are load labels and target RPE; never write kg or lb.',
    'If it is a run, a ride or a swim with someone, keep it the easy thing they asked for: one movement (e.g. "Easy run", sets 1, reps "40 min"), not a workout bolted onto it. Intervals go in one row as a rep spec ("6 × 2 min / 1 min easy").',
    'Ask one short question instead only if you truly cannot build it from what they said.',
    '',
    `What they want: ${said}`,
  ].join('\n')
}

/** The week the model is handed: empty, or just the one-off being revised. */
export function oneOffDraft(current: DraftSession | null): ProgramDraft {
  return { sessions: current ? [current] : [], sessionsPerWeek: 1 }
}

/**
 * The session after the coach's edits, through the editor's own bounds. A new
 * add_session replaces the one on the table; otherwise surgical edits change
 * it. Null when there's still nothing to run (the coach only asked a question).
 */
export function nextOneOff(current: DraftSession | null, edits: readonly ProgramEdit[]): DraftSession | null {
  const added = (edits ?? []).filter((e) => e.type === 'add_session').slice(0, 1)
  const { draft } = added.length
    ? applyEditsToDraft(oneOffDraft(null), added)
    : applyEditsToDraft(oneOffDraft(current), (edits ?? []).filter((e) => ['add_exercise', 'update_exercise', 'remove_exercise', 'update_session'].includes(e.type)))
  const session = draft.sessions[0]
  return session && session.exercises.length ? session : null
}
