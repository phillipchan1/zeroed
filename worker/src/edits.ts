import {
  applyEditsToDraft, diffDraft, estimateDraft, mergePreferences,
  type ProgramDraft,
} from '../../supabase/functions/_shared/engine/programDraft.ts'
import {
  addDaysISO, isoDate, nextMondayISO, sundayOnOrAfterISO,
} from '../../supabase/functions/_shared/engine/weekDates.ts'
import type { ProgramEdit } from '../../supabase/functions/_shared/engine/types.ts'
import type { DraftSession } from '../../supabase/functions/_shared/engine/programDraft.ts'
import { formatDiff, formatDraft } from '../../supabase/functions/_shared/zeroedFormat.ts'
import { jsonParam } from './db.ts'
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
  }>
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
    })),
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

function revisionPayload(_before: DraftSession[], diff: ReturnType<typeof diffDraft>) {
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

export function previewEdits(live: LiveProgram, inputs: EditInput[]): {
  text: string
  applied: number
  skipped: number
  dirty: boolean
} {
  const base = liveToDraft(live)
  const edits = inputs.map(toProgramEdit)
  const { draft, outcomes, notes } = applyEditsToDraft(base, edits)
  const diff = diffDraft(base, draft)
  const outcomeLines = outcomes.map((o) =>
    o.applied ? `- applied: ${o.label}` : `- skipped: ${o.label} (${o.reason})`,
  )
  const text = [
    `# Preview against ${live.phaseName} (${live.weekStart} → ${live.weekEnd})`,
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

export async function writeDraftInPlace(
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
      const updated = await store.sql<{ id: string }[]>`
        UPDATE routine r
        SET name = ${payload.name},
            session_type = ${payload.session_type},
            exercises = ${jsonParam(store.sql, payload.exercises)},
            intent = ${payload.intent},
            intended_dow = ${payload.intended_dow}
        FROM program p
        WHERE r.id = ${s.routineId}
          AND r.program_id = p.id
          AND p.athlete_id = ${store.athleteId}
        RETURNING r.id
      `
      if (!updated.length) errors.push(`${s.name}: not found or not owned`)
      else written++
    } else {
      const inserted = await store.sql<{ id: string }[]>`
        INSERT INTO routine (program_id, phase_id, name, session_type, exercises, intent, intended_dow)
        SELECT ${live.programId}, ${live.phaseId}, ${payload.name}, ${payload.session_type},
               ${jsonParam(store.sql, payload.exercises)}, ${payload.intent}, ${payload.intended_dow}
        WHERE EXISTS (
          SELECT 1 FROM program p WHERE p.id = ${live.programId} AND p.athlete_id = ${store.athleteId}
        )
        RETURNING id
      `
      if (!inserted.length) errors.push(`${s.name}: insert refused`)
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
  const closed = await store.sql<{ id: string }[]>`
    UPDATE phase ph
    SET week_end = ${thisSunday}
    FROM program p
    WHERE ph.id = ${live.phaseId}
      AND ph.program_id = p.id
      AND p.athlete_id = ${store.athleteId}
    RETURNING ph.id
  `
  if (!closed.length) {
    errors.push(`couldn't close out the current block`)
    return 0
  }
  const weekEnd = sundayOnOrAfterISO(
    live.weekEnd > startsOn ? live.weekEnd : addDaysISO(startsOn, 27),
  )
  const inserted = await store.sql<{ id: string }[]>`
    INSERT INTO phase (program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status)
    SELECT ${live.programId}, ${live.phaseName}, ${startsOn}, ${weekEnd},
           ${jsonParam(store.sql, live.nonNegotiables)}, ${jsonParam(store.sql, live.advancementCriteria)}, 'pending'
    WHERE EXISTS (
      SELECT 1 FROM program p WHERE p.id = ${live.programId} AND p.athlete_id = ${store.athleteId}
    )
    RETURNING id
  `
  const newPhase = inserted[0]
  if (!newPhase) {
    await store.sql`
      UPDATE phase SET week_end = ${live.weekEnd} WHERE id = ${live.phaseId}
    `
    errors.push(`couldn't schedule the new block`)
    return 0
  }
  for (const s of draft.sessions) {
    await store.sql`
      INSERT INTO routine (program_id, phase_id, name, session_type, exercises, intent, intended_dow)
      VALUES (
        ${live.programId}, ${newPhase.id}, ${s.name}, ${s.sessionType},
        ${jsonParam(store.sql, s.exercises)}, ${s.intent}, ${s.intendedDow}
      )
    `
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
  await store.sql`
    INSERT INTO program_revision (
      program_id, phase_id, trigger, effective_on, requests, snapshot, diff, summary
    )
    SELECT ${live.programId}, ${live.phaseId}, 'editor', ${effectiveOn},
           ${jsonParam(store.sql, requests)},
           ${jsonParam(store.sql, base.sessions.map((s) => ({
             name: s.name,
             intent: s.intent,
             session_type: s.sessionType,
             intended_dow: s.intendedDow,
             exercises: s.exercises,
           })))},
           ${jsonParam(store.sql, storedDiff)},
           ${summarizeRevision(storedDiff)}
    WHERE EXISTS (
      SELECT 1 FROM program p WHERE p.id = ${live.programId} AND p.athlete_id = ${store.athleteId}
    )
  `

  if (draft.sessionsPerWeek !== live.sessionsPerWeek) {
    await store.sql`
      UPDATE athlete SET sessions_per_week = ${draft.sessionsPerWeek}
      WHERE id = ${store.athleteId}
    `
  }
  const preferences = mergePreferences(live.standingPreferences, requests)
  if (preferences && preferences !== live.standingPreferences) {
    await store.sql`
      UPDATE athlete SET training_preferences = ${preferences}
      WHERE id = ${store.athleteId}
    `
  }

  const parts = [
    diff.added > 0 ? `${diff.added} added` : null,
    diff.removed > 0 ? `${diff.removed} dropped` : null,
    diff.changed > 0 ? `${diff.changed} retuned` : null,
    diff.newSessions > 0 ? `${diff.newSessions} new session${diff.newSessions === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  await store.sql`
    INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
    VALUES (
      ${store.athleteId},
      'coach',
      'phase_change',
      ${[
        opts.timing === 'next_week'
          ? `Your reshaped ${live.phaseName} block is queued for Monday — ${parts.join(' · ') || 'no net change'}. This week stays as it is.`
          : `You reshaped your ${live.phaseName} block — ${parts.join(' · ') || 'no net change'}.`,
        ...notes,
      ].join(' ')},
      ${live.phaseId}
    )
  `

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
