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
import { placeholderRpePreviewSection } from '../../src/engine/rpePlaceholder.ts'
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
    track?: string | null
    track_id?: string | null
    superset_group?: string | null
    rest_s?: number | null
    contacts?: number | null
    kind?: 'skill' | 'interval' | null
    window_s?: number | null
  }>
  track?: string | null
  track_id?: string | null
  superset_group?: string | null
  rest_s?: number | null
  contacts?: number | null
  kind?: 'skill' | 'interval' | null
  window_s?: number | null
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
      // skill_blocks_v1: present only when the flag let them in (skillBlocks.ts).
      ...(x.kind != null ? { kind: x.kind } : {}),
      ...(x.window_s != null ? { window_s: x.window_s } : {}),
    })),
    track: e.track ?? null,
    track_id: e.track_id ?? null,
    superset_group: e.superset_group ?? null,
    rest_s: e.rest_s ?? null,
    contacts: e.contacts ?? null,
    ...(e.kind != null ? { kind: e.kind } : {}),
    ...(e.window_s != null ? { window_s: e.window_s } : {}),
  }
}

export async function athleteOwnsProgram(store: ConnectedStore, programId: string): Promise<boolean> {
  const [row] = await store.sql<{ id: string }[]>`
    SELECT id FROM program
    WHERE id = ${programId} AND athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return Boolean(row)
}

export async function athleteOwnsPhase(store: ConnectedStore, phaseId: string): Promise<boolean> {
  const [row] = await store.sql<{ id: string }[]>`
    SELECT ph.id
    FROM phase ph
    JOIN program p ON p.id = ph.program_id
    WHERE ph.id = ${phaseId}
      AND p.athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return Boolean(row)
}

export async function athleteOwnsRoutine(store: ConnectedStore, routineId: string): Promise<boolean> {
  const [row] = await store.sql<{ id: string }[]>`
    SELECT r.id
    FROM routine r
    JOIN program p ON p.id = r.program_id
    WHERE r.id = ${routineId}
      AND p.athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return Boolean(row)
}

/** Re-check every FK the write would land on. Missing ids are ignored. */
export async function assertOwnedForeignKeys(
  store: ConnectedStore,
  refs: { programId?: string | null; phaseId?: string | null; routineId?: string | null },
): Promise<boolean> {
  if (refs.programId && !(await athleteOwnsProgram(store, refs.programId))) return false
  if (refs.phaseId && !(await athleteOwnsPhase(store, refs.phaseId))) return false
  if (refs.routineId && !(await athleteOwnsRoutine(store, refs.routineId))) return false
  return true
}

export async function insertOwnedRoutine(
  store: ConnectedStore,
  row: {
    programId: string
    phaseId: string
    name: string
    sessionType: string
    exercises: unknown
    intent: string
    intendedDow: number | null
  },
): Promise<string | null> {
  const inserted = await store.sql<{ id: string }[]>`
    INSERT INTO routine (program_id, phase_id, name, session_type, exercises, intent, intended_dow)
    SELECT ${row.programId}, ${row.phaseId}, ${row.name}, ${row.sessionType},
           ${jsonParam(store.sql, row.exercises)}, ${row.intent}, ${row.intendedDow}
    WHERE EXISTS (
      SELECT 1 FROM program p WHERE p.id = ${row.programId} AND p.athlete_id = ${store.athleteId}
    )
    AND EXISTS (
      SELECT 1 FROM phase ph
      JOIN program p ON p.id = ph.program_id
      WHERE ph.id = ${row.phaseId}
        AND p.athlete_id = ${store.athleteId}
    )
    RETURNING id
  `
  return inserted[0]?.id ?? null
}

/**
 * Upsert a routine by id. ON CONFLICT only updates a row the caller already owns.
 * A cannot take B's id (QA #15).
 */
export async function upsertOwnedRoutine(
  store: ConnectedStore,
  row: {
    id: string
    programId: string
    phaseId: string
    name: string
    sessionType: string
    exercises: unknown
    intent: string
    intendedDow: number | null
  },
): Promise<number> {
  const written = await store.sql<{ id: string }[]>`
    INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
    SELECT ${row.id}::uuid, ${row.programId}::uuid, ${row.phaseId}::uuid, ${row.name},
           ${row.sessionType}, ${jsonParam(store.sql, row.exercises)}, ${row.intent}, ${row.intendedDow}
    WHERE EXISTS (
      SELECT 1 FROM program p WHERE p.id = ${row.programId} AND p.athlete_id = ${store.athleteId}
    )
    AND EXISTS (
      SELECT 1 FROM phase ph
      JOIN program p ON p.id = ph.program_id
      WHERE ph.id = ${row.phaseId}
        AND p.athlete_id = ${store.athleteId}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      session_type = EXCLUDED.session_type,
      exercises = EXCLUDED.exercises,
      intent = EXCLUDED.intent,
      intended_dow = EXCLUDED.intended_dow
    WHERE routine.program_id IN (
      SELECT id FROM program WHERE athlete_id = ${store.athleteId}
    )
    RETURNING id
  `
  return written.length
}

/** Move a routine's program/phase FKs only when the caller owns the row and both targets. */
export async function updateOwnedRoutineFks(
  store: ConnectedStore,
  routineId: string,
  refs: { programId: string; phaseId: string },
): Promise<number> {
  const updated = await store.sql<{ id: string }[]>`
    UPDATE routine r
    SET program_id = ${refs.programId},
        phase_id = ${refs.phaseId}
    FROM program p
    WHERE r.id = ${routineId}
      AND r.program_id = p.id
      AND p.athlete_id = ${store.athleteId}
      AND EXISTS (
        SELECT 1 FROM program p2
        WHERE p2.id = ${refs.programId} AND p2.athlete_id = ${store.athleteId}
      )
      AND EXISTS (
        SELECT 1 FROM phase ph
        JOIN program p3 ON p3.id = ph.program_id
        WHERE ph.id = ${refs.phaseId}
          AND p3.athlete_id = ${store.athleteId}
      )
    RETURNING r.id
  `
  return updated.length
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

export function revisionPayload(_before: DraftSession[], diff: ReturnType<typeof diffDraft>) {
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

function draftForWeek(live: LiveProgram, weekStart?: string): { draft: ProgramDraft; header: string } {
  const want = weekStart?.slice(0, 10)
  if (want && live.scheduledPhase && live.scheduledPhase.weekStart === want) {
    return {
      draft: {
        sessionsPerWeek: live.sessionsPerWeek,
        sessions: live.scheduledSessions.map((s) => ({
          routineId: s.routineId,
          name: s.name,
          intent: s.intent,
          sessionType: s.sessionType,
          intendedDow: s.intendedDow,
          exercises: s.exercises.map((ex) => ({ ...ex })),
        })),
      },
      header: `# Preview against queued ${live.scheduledPhase.name} (${want})`,
    }
  }
  const labeled = want && want !== live.weekStart
    ? `# Preview against ${live.phaseName} (live template, labeled ${want})`
    : `# Preview against ${live.phaseName} (${live.weekStart} → ${live.weekEnd})`
  return { draft: liveToDraft(live), header: labeled }
}

export function previewEdits(live: LiveProgram, inputs: EditInput[], weekStart?: string): {
  text: string
  applied: number
  skipped: number
  dirty: boolean
} {
  const { draft: base, header } = draftForWeek(live, weekStart)
  const edits = inputs.map(toProgramEdit)
  const { draft, outcomes, notes } = applyEditsToDraft(base, edits)
  const diff = diffDraft(base, draft)
  const outcomeLines = outcomes.map((o) =>
    o.applied ? `- applied: ${o.label}` : `- skipped: ${o.label} (${o.reason})`,
  )
  const suggested = placeholderRpePreviewSection(base.sessions, live.phaseName)
  const text = [
    header,
    '',
    '## Outcomes',
    outcomeLines.join('\n') || 'No edits sent.',
    notes.length ? `\nCoach notes that would be stored:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
    suggested ? `\n${suggested}` : '',
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
      const inserted = await insertOwnedRoutine(store, {
        programId: live.programId,
        phaseId: live.phaseId,
        name: payload.name,
        sessionType: payload.session_type,
        exercises: payload.exercises,
        intent: payload.intent,
        intendedDow: payload.intended_dow,
      })
      if (!inserted) errors.push(`${s.name}: insert refused`)
      else written++
    }
  }
  return written
}

export async function rollbackPhaseWeekEnd(
  store: ConnectedStore, phaseId: string, weekEnd: string,
): Promise<void> {
  await store.sql`
    UPDATE phase ph
    SET week_end = ${weekEnd}
    FROM program p
    WHERE ph.id = ${phaseId}
      AND ph.program_id = p.id
      AND p.athlete_id = ${store.athleteId}
  `
}

export async function scheduleDraftForNextWeek(
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
    await rollbackPhaseWeekEnd(store, live.phaseId, live.weekEnd)
    errors.push(`couldn't schedule the new block`)
    return 0
  }
  for (const s of draft.sessions) {
    const inserted = await insertOwnedRoutine(store, {
      programId: live.programId,
      phaseId: newPhase.id,
      name: s.name,
      sessionType: s.sessionType,
      exercises: s.exercises,
      intent: s.intent,
      intendedDow: s.intendedDow,
    })
    if (!inserted) errors.push(`${s.name}: insert refused`)
  }
  return draft.sessions.length
}

export async function insertProgramRevision(
  store: ConnectedStore,
  live: Pick<LiveProgram, 'programId' | 'phaseId'>,
  payload: {
    trigger: string
    effectiveOn: string
    requests: unknown
    snapshot: unknown
    diff: unknown
    summary: string
  },
): Promise<number> {
  const inserted = await store.sql<{ id: string }[]>`
    INSERT INTO program_revision (
      program_id, phase_id, trigger, effective_on, requests, snapshot, diff, summary
    )
    SELECT ${live.programId}, ${live.phaseId}, ${payload.trigger}, ${payload.effectiveOn},
           ${jsonParam(store.sql, payload.requests)},
           ${jsonParam(store.sql, payload.snapshot)},
           ${jsonParam(store.sql, payload.diff)},
           ${payload.summary}
    WHERE EXISTS (
      SELECT 1 FROM program p WHERE p.id = ${live.programId} AND p.athlete_id = ${store.athleteId}
    )
    AND EXISTS (
      SELECT 1 FROM phase ph
      JOIN program p ON p.id = ph.program_id
      WHERE ph.id = ${live.phaseId}
        AND p.athlete_id = ${store.athleteId}
    )
    RETURNING id
  `
  return inserted.length
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
  await insertProgramRevision(store, live, {
    trigger: 'editor',
    effectiveOn,
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
