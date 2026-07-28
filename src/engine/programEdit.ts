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
import {
  diffDraft, estimateDraft, mergePreferences, MAX_SESSIONS, clampInt,
  type ProgramDraft, type DraftSession,
} from './programDraft'
import {
  callProgramEdit,
  type ProgramEditContext, type ProgramEditTurn, type EditWeekSession, type ProgramEdit,
} from './agentClient'
import type {
  ExerciseTemplate, PhaseRow, RoutineRow, SetLog,
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
}

// ---- reading the live program ----------------------------------------------

function topWorkingSet(sets: SetLog[] | undefined): SetLog | null {
  if (!Array.isArray(sets) || sets.length === 0) return null
  const loaded = sets.filter((s) => s.weight != null)
  if (loaded.length) return loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  const logged = sets.filter((s) => s.done || s.reps != null || s.duration != null || s.distance != null)
  return logged.length ? logged[logged.length - 1] : null
}

function formatSetCell(s: SetLog, unit: string): string | null {
  if (s.weight != null) return `${s.weight}${unit}×${s.reps ?? '?'}${s.rpe != null ? ` @${s.rpe}` : ''}`
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
export async function gatherProgramEditState(athleteId: string, unit: string): Promise<ProgramEditState | null> {
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
    .select('rpe, performed_at, duration_mins, actual_weights, routine!inner(name, exercises, program_id)')
    .eq('routine.program_id', prog.id)
    .order('performed_at', { ascending: false })
    .limit(30)
  type WRow = {
    rpe: number | null; performed_at: string; duration_mins: number | null
    actual_weights: Record<string, SetLog[]> | null
    routine: { name: string; exercises: ExerciseTemplate[] }
  }
  const rows = (workoutRows ?? []) as unknown as WRow[]

  const liftSeen = new Map<string, { top_set: string; rpe: number | null }>()
  for (const w of rows) {
    const exs = w.routine?.exercises ?? []
    for (const [idx, sets] of Object.entries(w.actual_weights ?? {})) {
      const ex = exs[Number(idx)]
      if (!ex || liftSeen.has(ex.name)) continue
      const top = topWorkingSet(sets)
      const cell = top ? formatSetCell(top, unit) : null
      if (!cell) continue
      liftSeen.set(ex.name, { top_set: cell, rpe: top?.rpe ?? w.rpe })
    }
  }

  const recent_sessions = rows.slice(0, 5).map((w) => {
    const exs = w.routine?.exercises ?? []
    const lines: string[] = []
    for (const [idx, sets] of Object.entries(w.actual_weights ?? {})) {
      const ex = exs[Number(idx)]
      if (!ex || !Array.isArray(sets)) continue
      const cells = sets.map((s) => formatSetCell(s, unit)).filter((c): c is string => c != null)
      if (cells.length) lines.push(`${ex.name}: ${cells.join(', ')}`)
    }
    return {
      session: w.routine?.name ?? 'Session',
      performed_at: w.performed_at,
      rpe: w.rpe,
      duration_mins: w.duration_mins ?? null,
      sets: lines,
    }
  })

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
  }

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
): Promise<ApplyDraftResult> {
  const errors: string[] = []
  let written = 0

  // Only the sessions that actually moved are written. An untouched session has
  // no business being re-saved: the write would be a no-op at best, and at worst
  // it would stamp a stale draft over something changed elsewhere since.
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
  const diff = diffDraft(state.base, draft)
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
      `You reshaped your ${state.phaseName} block — ${parts.join(' · ') || 'no net change'}.`,
      ...notes,
    ].join(' '),
    ref_id: state.phaseId,
  })

  return { ok: errors.length === 0, written, errors }
}
