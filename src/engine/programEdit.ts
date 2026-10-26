// =============================================================================
// programEdit — the athlete's steering wheel.
//
// The phase rebuild asks a model to redraw the whole week and then shows you
// what changed. That is the wrong shape for "I want to add jumps": a fresh draft
// churns everything, so asking for six additions costs you five deletions you
// never asked for, and the conversation ends after one shot.
//
// This module is the other shape. The model returns SURGICAL EDITS against a
// working draft; deterministic code applies them, clamps the numbers, and diffs
// the result. Nothing is written until the athlete says so, and the conversation
// keeps going — each turn stacks on the draft, so the program converges over
// several messages instead of being re-rolled by each one.
//
// Division of labour, unchanged from the rest of the app: the agent PROPOSES
// (which movement, what dose, what to say), code DISPOSES (bounds, tracking
// types, what actually reaches the DB, and the diff the athlete confirms).
// =============================================================================

import { supabase } from '../lib/supabaseClient'
import type { UnitContext } from '../lib/units'
import {
  diffDraft, estimateDraft, mergePreferences, MAX_SESSIONS, clampInt,
  type ProgramDraft, type DraftSession,
} from './programDraft'
import {
  callProgramEdit,
  type ProgramEditContext, type ProgramEditTurn, type EditWeekSession, type ProgramEdit,
} from './agentClient'
import { readLoggedExercises, type LoggedWorkoutLike } from './loggedSets'
import {
  startOfWeekMonday, isoDate, addDaysISO, nextMondayISO, sundayOnOrAfterISO,
} from './weekDates'
import { recordProgramRevision, gatherProgramHistory } from './programHistory'
import type {
  ExerciseTemplate, PhaseName, PhaseRow, RoutineRow, SetLog,
} from '../types/database'

// The deterministic half (draft shape, edit application, diff, estimates) lives
// in programDraft.ts and is re-exported here, so screens import one module.
export * from './programDraft'

/** What the editor is editing, and the scope of that edit. */
export interface ProgramEditState {
  programId: string
  phaseId: string
  phaseName: string
  /** How many more weeks this block runs — the true blast radius of an edit. */
  weeksRemaining: number | null
  context: ProgramEditContext
  base: ProgramDraft
  /** The live block's own dates and rules — needed to split it at a week boundary. */
  phase: {
    name: PhaseName
    weekStart: string
    weekEnd: string
    nonNegotiables: string[]
    advancementCriteria: string[]
  }
  /**
   * Sessions already logged in the current week, newest first. The whole point
   * of the timing choice: applying now rewrites the prescription these were
   * performed against, and an athlete four sessions into a Friday deserves to
   * see which ones before deciding.
   */
  loggedThisWeek: Array<{ routineId: string; sessionName: string; performedAt: string }>
  /**
   * A block already queued to start later — from a mid-week retest, or from an
   * earlier deferral in this same week. Its existence rules OUT deferring again:
   * this editor works on the ACTIVE week, so a second scheduled block would
   * either be built on the wrong base (discarding a retest's re-scope) or leave
   * two pending phases racing to activate, which stalls phase advancement
   * outright. Named on screen instead of silently mishandled.
   */
  scheduledPhase: { id: string; name: string; weekStart: string } | null
}

/** When a confirmed change takes effect. */
export type ApplyTiming = 'now' | 'next_week'

// The week-date primitives live in weekDates.ts (pure, so they can be checked
// without a database). Re-exported here so existing importers of this module
// keep working.
export {
  startOfWeekMonday, isoDate, addDaysISO, nextMondayISO, sundayOnOrAfterISO,
  ATHLETE_TIME_ZONE, weekWindowInZone, upcomingWeekWindow, isSundayInZone,
  logTimestampForWeek, isoInWeek, isoDateInZone, planPagerFutureWeeks,
} from './weekDates'

// ---- reading the live program ----------------------------------------------

function topWorkingSet(sets: SetLog[] | undefined): SetLog | null {
  if (!Array.isArray(sets) || sets.length === 0) return null
  const loaded = sets.filter((s) => s.weight != null)
  if (loaded.length) return loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  const logged = sets.filter((s) => s.done || s.reps != null || s.duration != null || s.distance != null)
  return logged.length ? logged[logged.length - 1] : null
}

function formatSetCell(s: SetLog, u: UnitContext): string | null {
  if (s.weight != null) return `${u.fmt(s.weight)}${u.unit}×${s.reps ?? '?'}${s.rpe != null ? ` @${s.rpe}` : ''}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}`
  if (s.reps != null) return `${s.reps} reps${s.rpe != null ? ` @${s.rpe}` : ''}`
  return null
}

function weeksBetween(fromISO: string | null, toISO: string | null): number | null {
  if (!fromISO || !toISO) return null
  const ms = new Date(`${toISO}T12:00:00`).getTime() - Date.now()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24 * 7)))
}

/**
 * Read the live program into an editable draft plus the scoped slice the editor
 * is allowed to see. Returns null when there is no active program/phase — the
 * screen shows the "no program yet" state rather than inventing one.
 */
export async function gatherProgramEditState(athleteId: string, u: UnitContext): Promise<ProgramEditState | null> {
  const [{ data: athlete }, { data: prog }] = await Promise.all([
    supabase.from('athlete').select('name, goals, obstacle, training_age, sessions_per_week, training_preferences').eq('id', athleteId).maybeSingle(),
    supabase.from('program').select('id, goal').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
  ])
  if (!prog?.id) return null

  const { data: phaseRow } = await supabase
    .from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
  if (!phaseRow) return null
  const phase = phaseRow as PhaseRow

  const [routineRes, { data: insightRows }] = await Promise.all([
    supabase.from('routine').select('*').eq('program_id', prog.id).eq('phase_id', phase.id).order('name'),
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
  ])
  // Same fallback the Program screen uses: an older program can carry routines
  // that were never phase-linked. Editing those is right; inserting a fresh week
  // alongside them would quietly duplicate the athlete's training.
  let routineRows = routineRes.data
  if (!routineRows || routineRows.length === 0) {
    const { data } = await supabase.from('routine').select('*').eq('program_id', prog.id).order('name')
    routineRows = data
  }

  const sessions: DraftSession[] = ((routineRows ?? []) as RoutineRow[]).map((r) => ({
    routineId: r.id,
    name: r.name,
    intent: r.intent ?? '',
    sessionType: r.session_type ?? 'strength',
    intendedDow: r.intended_dow ?? null,
    exercises: Array.isArray(r.exercises) ? r.exercises : [],
  }))

  const insights = ((insightRows ?? []) as Array<{ id: string; priority: string; category: string; claim: string; confidence: number; status: string }>)
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
    .map((i) => ({ id: i.id, priority: i.priority, category: i.category, claim: i.claim, confidence: i.confidence, status: i.status }))

  // Their real logged work: the top set per movement (newest wins) and the last
  // few sessions, so the coach edits against numbers instead of guesses.
  const { data: workoutRows } = await supabase
    .from('workout')
    .select('rpe, performed_at, duration_mins, actual_weights, exercises_snapshot, routine!inner(name, exercises, program_id)')
    .eq('routine.program_id', prog.id)
    .order('performed_at', { ascending: false })
    .limit(30)
  type WRow = LoggedWorkoutLike & {
    rpe: number | null; performed_at: string; duration_mins: number | null
    routine: { name: string; exercises: ExerciseTemplate[] }
  }
  const rows = (workoutRows ?? []) as unknown as WRow[]

  const liftSeen = new Map<string, { top_set: string; rpe: number | null }>()
  for (const w of rows) {
    for (const { name, sets } of readLoggedExercises(w)) {
      if (liftSeen.has(name)) continue
      const top = topWorkingSet(sets)
      const cell = top ? formatSetCell(top, u) : null
      if (!cell) continue
      liftSeen.set(name, { top_set: cell, rpe: top?.rpe ?? w.rpe })
    }
  }

  const recent_sessions = rows.slice(0, 5).map((w) => {
    const lines: string[] = []
    for (const { name, sets } of readLoggedExercises(w)) {
      const cells = sets.map((s) => formatSetCell(s, u)).filter((c): c is string => c != null)
      if (cells.length) lines.push(`${name}: ${cells.join(', ')}`)
    }
    return {
      session: w.routine?.name ?? 'Session',
      performed_at: w.performed_at,
      rpe: w.rpe,
      duration_mins: w.duration_mins ?? null,
      sets: lines,
    }
  })

  // The long arc, so the editor answers "am I actually getting stronger?" from
  // the record instead of from the last thirty sessions. Non-fatal: a failure
  // here costs the coach context, never the ability to edit.
  const history = await gatherProgramHistory(athleteId, prog.id, u).catch(() => null)

  const context: ProgramEditContext = {
    name: (athlete?.name as string | null) ?? null,
    profile: {
      target: (athlete?.goals as string | null) ?? null,
      obstacle: (athlete?.obstacle as string | null) ?? null,
      training_age: (athlete?.training_age as number | null) ?? null,
      sessions_per_week: (athlete?.sessions_per_week as number | null) ?? null,
    },
    standing_preferences: (athlete?.training_preferences as string | null) ?? null,
    phase: {
      name: phase.name ?? null,
      week_of: phase.week_start ?? null,
      weeks_remaining: weeksBetween(phase.week_start, phase.week_end),
      non_negotiables: Array.isArray(phase.non_negotiables) ? (phase.non_negotiables as string[]) : [],
      goal: (prog.goal as string | null) ?? null,
    },
    insights,
    recent_lifts: [...liftSeen.entries()].map(([name, v]) => ({ name, top_set: v.top_set, rpe: v.rpe })).slice(0, 20),
    recent_sessions,
    ...(history ? { history } : {}),
  }

  // What's already been trained this week. An edit applied now rewrites the
  // prescription behind these sessions; deferring to Monday leaves them alone.
  const weekMonday = startOfWeekMonday(new Date())
  const [{ data: weekRows }, { data: queued }] = await Promise.all([
    supabase
      .from('workout')
      .select('performed_at, routine_id, routine!inner(name, program_id)')
      .eq('routine.program_id', prog.id)
      .gte('performed_at', weekMonday.toISOString())
      .order('performed_at', { ascending: false }),
    supabase
      .from('phase').select('id, name, week_start')
      .eq('program_id', prog.id).eq('status', 'pending')
      .order('week_start').limit(1).maybeSingle(),
  ])
  const loggedThisWeek = ((weekRows ?? []) as unknown as Array<{
    performed_at: string; routine_id: string; routine: { name: string }
  }>).map((w) => ({
    routineId: w.routine_id,
    sessionName: w.routine?.name ?? 'Session',
    performedAt: w.performed_at,
  }))

  return {
    programId: prog.id,
    phaseId: phase.id,
    phaseName: phase.name,
    weeksRemaining: weeksBetween(phase.week_start, phase.week_end),
    context,
    base: {
      sessions,
      sessionsPerWeek: clampInt(athlete?.sessions_per_week, 1, MAX_SESSIONS, Math.max(1, sessions.length)),
    },
    phase: {
      name: phase.name,
      weekStart: phase.week_start,
      weekEnd: phase.week_end,
      nonNegotiables: Array.isArray(phase.non_negotiables) ? (phase.non_negotiables as string[]) : [],
      advancementCriteria: Array.isArray(phase.advancement_criteria) ? (phase.advancement_criteria as string[]) : [],
    },
    loggedThisWeek,
    scheduledPhase: queued
      ? {
          id: (queued as { id: string }).id,
          name: (queued as { name: string }).name,
          weekStart: (queued as { week_start: string }).week_start,
        }
      : null,
  }
}

// ---- the conversation -------------------------------------------------------

export interface ProgramEditReply {
  source: 'agent' | 'fallback'
  reply: string
  followups: string[]
  edits: ProgramEdit[]
}

/** The shape the model sees — the draft, flattened, with nothing internal in it. */
function toWirePayload(draft: ProgramDraft): EditWeekSession[] {
  return draft.sessions.map((s) => ({
    name: s.name,
    intent: s.intent || null,
    session_type: s.sessionType || null,
    intended_dow: s.intendedDow,
    exercises: s.exercises.map((e) => ({
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      load: e.load ?? null,
      cue: e.cue ?? null,
      target_rpe: e.target_rpe ?? null,
    })),
  }))
}

/**
 * One turn of the editing conversation. The model is handed the WORKING draft
 * (not the saved program), so a fourth message refines what the third one
 * staged instead of starting over.
 *
 * On failure the surface degrades to answering nothing rather than to a
 * half-applied program: no edits, an in-voice line, and the draft untouched.
 */
export async function runProgramEditChat(
  context: ProgramEditContext,
  draft: ProgramDraft,
  pending: string[],
  history: ProgramEditTurn[],
  message: string,
): Promise<ProgramEditReply> {
  const res = await callProgramEdit({
    context,
    week: toWirePayload(draft),
    pending,
    estimates: estimateDraft(draft),
    history,
    message,
  })
  if (res.ok) {
    return {
      source: 'agent',
      reply: res.data.reply,
      followups: Array.isArray(res.data.followups) ? res.data.followups : [],
      edits: Array.isArray(res.data.edits) ? res.data.edits : [],
    }
  }
  // Name the real failure. "Couldn't reach the coach" on a healthy connection
  // reads as "this feature doesn't work" — and when the server rejected the task
  // as unknown, that reading is exactly right until the function is redeployed.
  const reply =
    res.error === 'stale_function'
      ? 'The server is running an older coach that doesn\'t know this screen yet — nothing was changed. Deploy the latest agent Edge Function (`supabase functions deploy agent`) and program editing switches on.'
      : res.error === 'rate_limited'
        ? 'The coach is rate-limited right now — nothing was changed. Give it a minute and send that again.'
        : res.error === 'model_failed'
          ? `The coach hit an error drafting that change — nothing was changed. Try it again${res.reason ? ` (server said: ${String(res.reason).slice(0, 140)})` : ''}.`
          : "Couldn't reach the coach just now — nothing was changed. Your staged edits are still here; try that again in a moment."
  return { source: 'fallback', reply, followups: [], edits: [] }
}

// ---- committing -------------------------------------------------------------

export interface ApplyDraftResult {
  ok: boolean
  written: number
  errors: string[]
  /** The day the change takes effect — today, or the Monday it was deferred to. */
  effectiveOn: string
  /** True when the change was queued as a new block rather than applied in place. */
  scheduled: boolean
}

/**
 * Write the confirmed draft. Existing sessions are updated in place so the
 * routine ids Today, the outbox, and every logged workout reference stay valid;
 * genuinely new sessions are inserted. Days-per-week rides along, because a new
 * session the schedule never reaches would be invisible.
 *
 * Best-effort per row: one failed write is reported, it does not abort the rest,
 * and the caller re-reads the program afterwards either way.
 */
export async function applyProgramDraft(
  athleteId: string,
  state: ProgramEditState,
  draft: ProgramDraft,
  notes: string[] = [],
  /** What the athlete asked for, in their own words — kept as a standing steer. */
  requests: string[] = [],
  /** Now, or at the coming week boundary. Defaults to the old behaviour. */
  timing: ApplyTiming = 'now',
): Promise<ApplyDraftResult> {
  const errors: string[] = []
  let written = 0
  const diff = diffDraft(state.base, draft)
  const effectiveOn = timing === 'next_week' ? nextMondayISO() : isoDate(new Date())

  if (timing === 'next_week') {
    written = await scheduleDraftForNextWeek(state, draft, errors, effectiveOn)
    // Scheduling is all-or-nothing and self-repairing on failure. If it didn't
    // take, stop here: writing preferences and a coach note for a change that
    // isn't happening would tell the athlete it worked.
    if (!written) return { ok: false, written: 0, errors, effectiveOn, scheduled: false }
  } else {
    written = await writeDraftInPlace(state, draft, errors)
  }

  // Record what happened, now that something has. The snapshot is taken from
  // state.base — the week as it was read at load time — so it still describes
  // what preceded the change even though the rows have already been rewritten.
  await recordProgramRevision({
    programId: state.programId,
    phaseId: state.phaseId,
    trigger: 'editor',
    effectiveOn,
    requests,
    before: state.base.sessions,
    diff,
  })

  const athletePatch: Record<string, unknown> = {}
  if (draft.sessionsPerWeek !== state.base.sessionsPerWeek) {
    athletePatch.sessions_per_week = draft.sessionsPerWeek
  }
  // Steering has to outlive the block it was done in. Without this, the next
  // phase is designed from scratch at the boundary and quietly drops everything
  // the athlete asked for — the app fighting them all over again a month later.
  const preferences = mergePreferences(state.context.standing_preferences, requests)
  if (preferences && preferences !== state.context.standing_preferences) {
    athletePatch.training_preferences = preferences
  }
  if (Object.keys(athletePatch).length) {
    const { error } = await supabase.from('athlete').update(athletePatch).eq('id', athleteId)
    if (error) errors.push(`profile: ${error.message}`)
  }

  // The change belongs in the coach log too — this is the same event class as a
  // phase change, and the athlete should find it there later.
  const parts = [
    diff.added > 0 ? `${diff.added} added` : null,
    diff.removed > 0 ? `${diff.removed} dropped` : null,
    diff.changed > 0 ? `${diff.changed} retuned` : null,
    diff.newSessions > 0 ? `${diff.newSessions} new session${diff.newSessions === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  await supabase.from('coach_message').insert({
    athlete_id: athleteId,
    role: 'coach',
    kind: 'phase_change',
    body: [
      timing === 'next_week'
        ? `Your reshaped ${state.phaseName} block is queued for Monday — ${parts.join(' · ') || 'no net change'}. This week stays as it is.`
        : `You reshaped your ${state.phaseName} block — ${parts.join(' · ') || 'no net change'}.`,
      ...notes,
    ].join(' '),
    ref_id: state.phaseId,
  })

  return { ok: errors.length === 0, written, errors, effectiveOn, scheduled: timing === 'next_week' }
}

/**
 * Apply now: update the live routine rows in place, so the change is on Train
 * the moment the athlete closes the screen.
 *
 * Only sessions that actually moved are written. An untouched session has no
 * business being re-saved: the write would be a no-op at best, and at worst it
 * would stamp a stale draft over something changed elsewhere since.
 */
async function writeDraftInPlace(
  state: ProgramEditState, draft: ProgramDraft, errors: string[],
): Promise<number> {
  let written = 0
  const baseById = new Map(state.base.sessions.filter((s) => s.routineId).map((s) => [s.routineId as string, s]))

  for (const s of draft.sessions) {
    const payload = {
      name: s.name,
      session_type: s.sessionType,
      exercises: s.exercises,
      intent: s.intent,
      intended_dow: s.intendedDow,
    }
    if (s.routineId) {
      const before = baseById.get(s.routineId)
      if (before && JSON.stringify(payload) === JSON.stringify({
        name: before.name,
        session_type: before.sessionType,
        exercises: before.exercises,
        intent: before.intent,
        intended_dow: before.intendedDow,
      })) continue
      const { error } = await supabase.from('routine').update(payload).eq('id', s.routineId)
      if (error) errors.push(`${s.name}: ${error.message}`)
      else written++
    } else {
      const { error } = await supabase.from('routine').insert({
        program_id: state.programId,
        phase_id: state.phaseId,
        ...payload,
      })
      if (error) errors.push(`${s.name}: ${error.message}`)
      else written++
    }
  }
  return written
}

/**
 * Apply Monday: leave this week completely alone and queue the reshaped week as
 * a new block starting at the boundary.
 *
 * This is the same manoeuvre a mid-week retest already performs — end the live
 * block this Sunday, insert the new one as `pending`, and let
 * activateDueScheduledPhase promote it once its week_start lands. Crucially the
 * new block gets FRESH routine rows: the sessions the athlete already trained
 * this week keep pointing at the untouched originals, so nothing they logged is
 * rewritten and the old prescription survives as history rather than being
 * overwritten by the new one.
 */
async function scheduleDraftForNextWeek(
  state: ProgramEditState, draft: ProgramDraft, errors: string[], startsOn: string,
): Promise<number> {
  // Refuse rather than race. activateDueScheduledPhase promotes ONE due pending
  // phase and runPhaseAdvancement stands down while any pending phase exists, so
  // a second queued block doesn't just get ignored — it strands the loser as
  // pending forever and stops the arc advancing at all. The screen already hides
  // this option when a block is queued; this is the backstop for a stale load.
  const { data: existing } = await supabase
    .from('phase').select('id, week_start')
    .eq('program_id', state.programId).eq('status', 'pending')
    .order('week_start').limit(1).maybeSingle()
  if (existing) {
    errors.push(
      `a block is already scheduled to start ${(existing as { week_start: string }).week_start}. ` +
      'Apply now instead, or wait for that block to begin and change it then.',
    )
    return 0
  }

  // Run the block through to the end of this week, then hand over. If the block
  // was already due to end sooner, the handover date wins — a phase must never
  // end before the one replacing it begins.
  const thisSunday = addDaysISO(startsOn, -1)
  const { error: truncErr } = await supabase
    .from('phase').update({ week_end: thisSunday }).eq('id', state.phaseId)
  if (truncErr) {
    errors.push(`couldn't close out the current block: ${truncErr.message}`)
    return 0
  }

  // The new block continues the same phase of the arc — same name, same rules,
  // same advancement criteria. Only the week changed. Its end date keeps whatever
  // runway the original had, and never less than a full week.
  const weekEnd = sundayOnOrAfterISO(
    state.phase.weekEnd > startsOn ? state.phase.weekEnd : addDaysISO(startsOn, 27),
  )
  const { data: newPhase, error: phaseErr } = await supabase
    .from('phase')
    .insert({
      program_id: state.programId,
      name: state.phase.name,
      week_start: startsOn,
      week_end: weekEnd,
      non_negotiables: state.phase.nonNegotiables,
      advancement_criteria: state.phase.advancementCriteria,
      status: 'pending',
    })
    .select('id').single()
  if (phaseErr || !newPhase) {
    // Put the block's original end date back rather than leaving it truncated
    // with nothing queued to follow it — that would strand the athlete without
    // a live phase come Monday.
    await supabase.from('phase').update({ week_end: state.phase.weekEnd }).eq('id', state.phaseId)
    errors.push(`couldn't schedule the new block: ${phaseErr?.message ?? 'insert failed'}`)
    return 0
  }
  const newPhaseId = (newPhase as { id: string }).id

  const { error: routineErr } = await supabase.from('routine').insert(
    draft.sessions.map((s) => ({
      program_id: state.programId,
      phase_id: newPhaseId,
      name: s.name,
      session_type: s.sessionType,
      exercises: s.exercises,
      intent: s.intent,
      intended_dow: s.intendedDow,
    })),
  )
  if (routineErr) {
    errors.push(`couldn't write the scheduled week: ${routineErr.message}`)
    return 0
  }
  return draft.sessions.length
}
