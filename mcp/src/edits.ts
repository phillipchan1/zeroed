import {
  applyEditsToDraft, diffDraft, estimateDraft, mergePreferences,
  type ProgramDraft,
} from '../../src/engine/programDraft.ts'
import {
  addDaysISO, isoDate, nextMondayISO, sundayOnOrAfterISO,
} from '../../src/engine/weekDates.ts'
import type { ProgramEdit } from '../../src/engine/agentClient.ts'
import type { DraftSession } from '../../src/engine/programDraft.ts'
import { formatDiff, formatDraft } from './format.ts'
import { loadLiveProgram, type ConnectedStore, type LiveProgram } from './store.ts'

export type ApplyTiming = 'now' | 'next_week'

export interface EditInput {
  type: ProgramEdit['type']
  rationale?: string | null
  session_name?: string | null
  exercise_name?: string | null
  after_exercise?: string | null
  set_name?: string | null
  set_intent?: string | null
  set_session_type?: string | null
  set_intended_dow?: number | null
  sets?: number | null
  reps?: string | null
  load?: string | null
  cue?: string | null
  target_rpe?: number | null
  sessions_per_week?: number | null
  note?: string | null
  exercises?: Array<{
    name: string
    sets?: number
    reps?: string
    load?: string
    cue?: string
    target_rpe?: number | null
    track?: string | null
    track_id?: string | null
    superset_group?: string | null
    rest_s?: number | null
    contacts?: number | null
  }>
  track?: string | null
  track_id?: string | null
  superset_group?: string | null
  rest_s?: number | null
  contacts?: number | null
}

export function toProgramEdit(e: EditInput): ProgramEdit {
  return {
    type: e.type,
    rationale: e.rationale ?? '',
    session_name: e.session_name ?? null,
    exercise_name: e.exercise_name ?? null,
    after_exercise: e.after_exercise ?? null,
    set_name: e.set_name ?? null,
    set_intent: e.set_intent ?? null,
    set_session_type: e.set_session_type ?? null,
    set_intended_dow: e.set_intended_dow ?? null,
    sets: e.sets ?? null,
    reps: e.reps ?? null,
    load: e.load ?? null,
    cue: e.cue ?? null,
    target_rpe: e.target_rpe ?? null,
    sessions_per_week: e.sessions_per_week ?? null,
    note: e.note ?? null,
    exercises: (e.exercises ?? []).map((x) => ({
      name: x.name,
      sets: x.sets ?? 3,
      reps: x.reps ?? '8',
      load: x.load ?? 'moderate',
      cue: x.cue ?? '',
      target_rpe: x.target_rpe ?? null,
      track: x.track ?? null,
      track_id: x.track_id ?? null,
      superset_group: x.superset_group ?? null,
      rest_s: x.rest_s ?? null,
      contacts: x.contacts ?? null,
    })),
    track: e.track ?? null,
    track_id: e.track_id ?? null,
    superset_group: e.superset_group ?? null,
    rest_s: e.rest_s ?? null,
    contacts: e.contacts ?? null,
  }
}

export function liveToDraft(live: LiveProgram): ProgramDraft {
  return {
    sessionsPerWeek: live.sessionsPerWeek,
    sessions: live.sessions.map((s) => ({
      routineId: s.routineId,
      name: s.name,
      intent: s.intent,
      sessionType: s.sessionType,
      intendedDow: s.intendedDow,
      exercises: s.exercises.map((ex) => ({ ...ex })),
    })),
  }
}

function revisionPayload(before: DraftSession[], diff: ReturnType<typeof diffDraft>) {
  return {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    new_sessions: diff.newSessions,
    sessions: diff.sessions
      .map((s) => ({
        name: s.name,
        changes: s.changes
          .filter((c) => c.kind !== 'kept')
          .map((c) => ({ kind: c.kind, name: c.name, before: c.before, after: c.after })),
      }))
      .filter((s) => s.changes.length > 0),
  }
}

function summarizeRevision(diff: ReturnType<typeof revisionPayload>): string {
  const parts = [
    diff.new_sessions > 0 ? `${diff.new_sessions} new session${diff.new_sessions === 1 ? '' : 's'}` : null,
    diff.added > 0 ? `${diff.added} added` : null,
    diff.removed > 0 ? `${diff.removed} dropped` : null,
    diff.changed > 0 ? `${diff.changed} retuned` : null,
  ].filter(Boolean)
  return parts.join(' · ') || 'no net change'
}

export function previewEdits(live: LiveProgram, inputs: EditInput[], weekStart?: string): {
  text: string
  applied: number
  skipped: number
  dirty: boolean
} {
  const want = weekStart?.slice(0, 10)
  const queued = want && live.scheduledPhase && live.scheduledPhase.weekStart === want
  const base = queued
    ? {
        sessionsPerWeek: live.sessionsPerWeek,
        sessions: (live.scheduledSessions ?? []).map((s) => ({
          routineId: s.routineId,
          name: s.name,
          intent: s.intent,
          sessionType: s.sessionType,
          intendedDow: s.intendedDow,
          exercises: s.exercises.map((ex) => ({ ...ex })),
        })),
      }
    : liveToDraft(live)
  const edits = inputs.map(toProgramEdit)
  const { draft, outcomes, notes } = applyEditsToDraft(base, edits)
  const diff = diffDraft(base, draft)
  const outcomeLines = outcomes.map((o) =>
    o.applied ? `- applied: ${o.label}` : `- skipped: ${o.label} (${o.reason})`,
  )
  const header = queued
    ? `# Preview against queued ${live.scheduledPhase!.name} (${want})`
    : want && want !== live.weekStart
      ? `# Preview against ${live.phaseName} (live template, labeled ${want})`
      : `# Preview against ${live.phaseName} (${live.weekStart} → ${live.weekEnd})`
  const text = [
    header,
    '',
    '## Outcomes',
    outcomeLines.join('\n') || 'No edits sent.',
    notes.length ? `\nCoach notes that would be stored:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
    '',
    '## Diff',
    formatDiff(diff),
    '',
    '## Resulting week',
    formatDraft(draft),
    '',
    live.scheduledPhase
      ? `A block is already queued for ${live.scheduledPhase.weekStart} (${live.scheduledPhase.name}). Apply now, or wait — do not schedule another Monday handoff.`
      : 'Apply with confirm=true. Use timing=next_week to leave this week alone and queue Monday.',
  ].filter((line) => line !== '').join('\n')
  return {
    text,
    applied: outcomes.filter((o) => o.applied).length,
    skipped: outcomes.filter((o) => !o.applied).length,
    dirty: diff.dirty,
  }
}

async function writeDraftInPlace(
  store: ConnectedStore, live: LiveProgram, draft: ProgramDraft, errors: string[],
): Promise<number> {
  let written = 0
  const baseById = new Map(live.sessions.map((s) => [s.routineId, s]))
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
      const { error } = await store.supabase.from('routine').update(payload).eq('id', s.routineId)
      if (error) errors.push(`${s.name}: ${error.message}`)
      else written++
    } else {
      const { error } = await store.supabase.from('routine').insert({
        program_id: live.programId,
        phase_id: live.phaseId,
        ...payload,
      })
      if (error) errors.push(`${s.name}: ${error.message}`)
      else written++
    }
  }
  return written
}

async function scheduleDraftForNextWeek(
  store: ConnectedStore, live: LiveProgram, draft: ProgramDraft, errors: string[], startsOn: string,
): Promise<number> {
  if (live.scheduledPhase) {
    errors.push(
      `a block is already scheduled to start ${live.scheduledPhase.weekStart}. Apply now instead, or wait for that block to begin.`,
    )
    return 0
  }
  const thisSunday = addDaysISO(startsOn, -1)
  const { error: truncErr } = await store.supabase
    .from('phase').update({ week_end: thisSunday }).eq('id', live.phaseId)
  if (truncErr) {
    errors.push(`couldn't close out the current block: ${truncErr.message}`)
    return 0
  }
  const weekEnd = sundayOnOrAfterISO(
    live.weekEnd > startsOn ? live.weekEnd : addDaysISO(startsOn, 27),
  )
  const { data: newPhase, error: phaseErr } = await store.supabase
    .from('phase')
    .insert({
      program_id: live.programId,
      name: live.phaseName,
      week_start: startsOn,
      week_end: weekEnd,
      non_negotiables: live.nonNegotiables,
      advancement_criteria: live.advancementCriteria,
      status: 'pending',
    })
    .select('id').single()
  if (phaseErr || !newPhase) {
    await store.supabase.from('phase').update({ week_end: live.weekEnd }).eq('id', live.phaseId)
    errors.push(`couldn't schedule the new block: ${phaseErr?.message ?? 'insert failed'}`)
    return 0
  }
  const { error: routineErr } = await store.supabase.from('routine').insert(
    draft.sessions.map((s) => ({
      program_id: live.programId,
      phase_id: newPhase.id,
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

export async function applyEdits(
  store: ConnectedStore,
  inputs: EditInput[],
  opts: { confirm: boolean; timing: ApplyTiming; request?: string },
): Promise<string> {
  if (!opts.confirm) {
    return 'Refused: apply_program_edits requires confirm=true. Call preview_program_edits first, then apply with confirm=true.'
  }
  const live = await loadLiveProgram(store)
  if (!live) return 'No active program/phase to edit.'
  if (opts.timing === 'next_week' && live.scheduledPhase) {
    return `Refused: a block is already queued for ${live.scheduledPhase.weekStart}. Apply now, or wait.`
  }

  const base = liveToDraft(live)
  const { draft, outcomes, notes } = applyEditsToDraft(base, inputs.map(toProgramEdit))
  const diff = diffDraft(base, draft)
  if (!diff.dirty && notes.length === 0) {
    return [
      'Nothing to write — every edit was skipped or a no-op.',
      ...outcomes.map((o) => o.applied ? `- ${o.label}` : `- skipped: ${o.label} (${o.reason})`),
    ].join('\n')
  }

  const errors: string[] = []
  const effectiveOn = opts.timing === 'next_week' ? nextMondayISO() : isoDate(new Date())
  let written = 0
  if (opts.timing === 'next_week') {
    written = await scheduleDraftForNextWeek(store, live, draft, errors, effectiveOn)
    if (!written) return `Write failed:\n${errors.join('\n')}`
  } else {
    written = await writeDraftInPlace(store, live, draft, errors)
  }

  const requests = opts.request ? [opts.request] : []
  const storedDiff = revisionPayload(base.sessions, diff)
  await store.supabase.from('program_revision').insert({
    program_id: live.programId,
    phase_id: live.phaseId,
    trigger: 'editor',
    effective_on: effectiveOn,
    requests,
    snapshot: base.sessions.map((s) => ({
      name: s.name,
      intent: s.intent,
      session_type: s.sessionType,
      intended_dow: s.intendedDow,
      exercises: s.exercises,
    })),
    diff: storedDiff,
    summary: summarizeRevision(storedDiff),
  })

  const athletePatch: Record<string, unknown> = {}
  if (draft.sessionsPerWeek !== live.sessionsPerWeek) {
    athletePatch.sessions_per_week = draft.sessionsPerWeek
  }
  const preferences = mergePreferences(live.standingPreferences, requests)
  if (preferences && preferences !== live.standingPreferences) {
    athletePatch.training_preferences = preferences
  }
  if (Object.keys(athletePatch).length) {
    const { error } = await store.supabase.from('athlete').update(athletePatch).eq('id', store.athleteId)
    if (error) errors.push(`profile: ${error.message}`)
  }

  const parts = [
    diff.added > 0 ? `${diff.added} added` : null,
    diff.removed > 0 ? `${diff.removed} dropped` : null,
    diff.changed > 0 ? `${diff.changed} retuned` : null,
    diff.newSessions > 0 ? `${diff.newSessions} new session${diff.newSessions === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  await store.supabase.from('coach_message').insert({
    athlete_id: store.athleteId,
    role: 'coach',
    kind: 'phase_change',
    body: [
      opts.timing === 'next_week'
        ? `Your reshaped ${live.phaseName} block is queued for Monday — ${parts.join(' · ') || 'no net change'}. This week stays as it is.`
        : `You reshaped your ${live.phaseName} block — ${parts.join(' · ') || 'no net change'}.`,
      ...notes,
    ].join(' '),
    ref_id: live.phaseId,
  })

  return [
    opts.timing === 'next_week'
      ? `Queued for ${effectiveOn}. Wrote ${written} session${written === 1 ? '' : 's'}.`
      : `Applied now. Wrote ${written} session${written === 1 ? '' : 's'}.`,
    formatDiff(diff),
    errors.length ? `\nWrite notes:\n${errors.join('\n')}` : '',
    '',
    '## Week after the write',
    formatDraft(draft),
    estimateDraft(draft).map((e) => `- ${e.session}: ~${e.minutes} min`).join('\n'),
  ].filter(Boolean).join('\n')
}
