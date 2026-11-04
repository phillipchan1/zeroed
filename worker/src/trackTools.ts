/**
 * tracks_v1 MCP tools. Writes preview unless confirm=true.
 * SQL is scoped to store.athleteId on every query.
 */
import { applyMeasurement, computeGoalStatus, forecastAtDue, goalDisplayStatus, goalNumber, isGoalDirection, isGoalSide, lastMeasuredOn, pairKey, type GoalMeasurement } from '../../src/engine/goals.ts'
import { formatGoalSource, goalSource, parseGoalSource, sourceMatches, SOURCE_KINDS } from '../../src/engine/goalSources.ts'
import { listProposals } from './proposals.ts'
import { mcpStamp, writePreview } from '../../src/engine/mcpStamp.ts'
import { evaluateAutoregRules, type AutoregRule } from '../../src/engine/autoreg.ts'
import { proposeNextWeek, type PerformedExercise, type ProgressionRule } from '../../src/engine/progression.ts'
import { daysHitByTrack, findTrack, GENERAL_TRACK_SEED, isEngineType, resolveTrack, suggestTrackName, type TrackRef } from '../../src/engine/tracks.ts'
import { jsonParam } from './db.ts'
import type { ConnectedStore, LiveProgram } from './store.ts'
import { McpUserError } from './userError.ts'

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function asBool(v: unknown): boolean {
  return v === true
}

function asNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function todayISO(zone = 'America/Los_Angeles'): string {
  return mcpStamp(new Date(), zone).local_date
}

async function athleteZone(store: ConnectedStore): Promise<string> {
  const [row] = await store.sql<{ time_zone: string | null }[]>`
    SELECT time_zone FROM athlete WHERE id = ${store.athleteId} LIMIT 1
  `
  return row?.time_zone || 'America/Los_Angeles'
}

async function activeProgram(store: ConnectedStore, programId?: string): Promise<{ id: string; athlete_id: string } | null> {
  if (programId) {
    const [row] = await store.sql<{ id: string; athlete_id: string }[]>`
      SELECT id, athlete_id FROM program
      WHERE id = ${programId} AND athlete_id = ${store.athleteId} AND status = 'active'
      LIMIT 1
    `
    return row ?? null
  }
  const [row] = await store.sql<{ id: string; athlete_id: string }[]>`
    SELECT id, athlete_id FROM program
    WHERE athlete_id = ${store.athleteId} AND status = 'active'
    LIMIT 1
  `
  return row ?? null
}

async function loadTracks(store: ConnectedStore, programId: string): Promise<TrackRef[]> {
  return store.sql<TrackRef[]>`
    SELECT id, name, color, icon, sort_order AS "order", purpose
    FROM track
    WHERE program_id = ${programId}
    ORDER BY sort_order, name
  `
}

async function loadLiveSessions(store: ConnectedStore, programId: string): Promise<Array<{
  routineId: string
  name: string
  intendedDow: number | null
  sessionType: string | null
  exercises: Array<{ name: string; track_id?: string | null; sets?: number; reps?: string; load?: string; target_rpe?: number | null; superset_group?: string | null; rest_s?: number | null; contacts?: number | null }>
}>> {
  const rows = await store.sql<{
    id: string; name: string; intended_dow: number | null; session_type: string | null; exercises: unknown
  }[]>`
    SELECT r.id, r.name, r.intended_dow, r.session_type, r.exercises
    FROM routine r
    JOIN phase ph ON ph.id = r.phase_id
    JOIN program p ON p.id = r.program_id
    WHERE p.id = ${programId} AND p.athlete_id = ${store.athleteId} AND ph.status = 'active'
    ORDER BY r.intended_dow NULLS LAST, r.name
  `
  return rows.map((r) => ({
    routineId: r.id,
    name: r.name,
    intendedDow: r.intended_dow,
    sessionType: r.session_type,
    exercises: Array.isArray(r.exercises) ? r.exercises as never : [],
  }))
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * A confirmed coach write leaves a move the athlete can read: what changed and
 * why, pinned by ref_id to the goal, track or program it touched. The tools
 * take a rationale, and it used to live only on the preview. kind 'note' keeps
 * coach_message's kind check as it is; the Coach log already lists notes, and
 * the goal page reads the ones pinned to the goal or its lane.
 */
async function recordMove(
  store: ConnectedStore,
  what: string,
  args: Record<string, unknown>,
  refId: string | null,
): Promise<void> {
  const why = asString(args.rationale)
  const body = why ? `${what} Why: ${why}` : what
  await store.sql`
    INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
    VALUES (${store.athleteId}, 'coach', 'note', ${body}, ${refId})
  `
}

function engineLabel(engine: string): string {
  return engine.replace(/_/g, ' ')
}

export async function runTrackTool(
  store: ConnectedStore,
  name: string,
  args: Record<string, unknown>,
  live: LiveProgram | null,
): Promise<string | null> {
  switch (name) {
    case 'list_tracks':
      return json(await listTracks(store, asString(args.program_id)))
    case 'get_track':
      return json(await getTrack(store, asString(args.track_id) ?? asString(args.track) ?? asString(args.name)))
    case 'create_track':
      return json(await createTrack(store, args))
    case 'update_track':
      return json(await updateTrack(store, args))
    case 'assign_exercise_to_track':
      return json(await assignExercises(store, args))
    case 'get_track_progression':
      return json(await getTrackProgression(store, args, live))
    case 'set_track_progression_rule':
      return json(await setProgressionRule(store, args))
    case 'list_autoreg_rules':
      return json(await listAutoregRules(store, args))
    case 'upsert_autoreg_rule':
      return json(await upsertAutoregRule(store, args))
    case 'get_goals':
      return json(await getGoals(store, args))
    case 'get_goal_brief':
      return json(await getGoalBrief(store))
    case 'upsert_goal':
      return json(await upsertGoal(store, args))
    case 'log_goal_measurement':
      return json(await logGoalMeasurement(store, args))
    case 'get_goal_history':
      return json(await getGoalHistory(store, args))
    case 'add_workout_note':
      return json(await addWorkoutNote(store, args))
    case 'update_athlete_target':
      return json(await updateAthleteTarget(store, args))
    case 'update_program_meta':
      return json(await updateProgramMeta(store, args))
    default:
      return null
  }
}

export const TRACK_TOOL_NAMES = new Set([
  'list_tracks', 'get_track', 'create_track', 'update_track',
  'assign_exercise_to_track', 'get_track_progression', 'set_track_progression_rule',
  'list_autoreg_rules', 'upsert_autoreg_rule',
  'get_goals', 'get_goal_brief', 'upsert_goal', 'log_goal_measurement', 'get_goal_history',
  'add_workout_note', 'update_athlete_target', 'update_program_meta',
])

async function listTracks(store: ConnectedStore, programId?: string) {
  const program = await activeProgram(store, programId)
  if (!program) throw new McpUserError('No active program.')
  const tracks = await loadTracks(store, program.id)
  const sessions = await loadLiveSessions(store, program.id)
  const days = daysHitByTrack(sessions, tracks)
  const counts: Record<string, number> = {}
  for (const s of sessions) {
    for (const ex of s.exercises) {
      const t = resolveTrack(ex, tracks)
      if (t) counts[t.id] = (counts[t.id] ?? 0) + 1
    }
  }
  const rules = await store.sql<{ track_id: string; engine_type: string }[]>`
    SELECT track_id, engine_type FROM progression_rule
    WHERE program_id = ${program.id} AND (active_to IS NULL OR active_to >= CURRENT_DATE)
  `
  const engine: Record<string, string> = {}
  for (const r of rules) if (!engine[r.track_id]) engine[r.track_id] = r.engine_type
  const zone = await athleteZone(store)
  return {
    ...mcpStamp(new Date(), zone),
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      order: t.order,
      purpose: t.purpose,
      engine_type: engine[t.id] ?? null,
      exercise_count: counts[t.id] ?? 0,
      days: days[t.id] ?? [],
    })),
  }
}

async function getTrack(store: ConnectedStore, idOrName?: string) {
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  if (!idOrName) throw new McpUserError('track_id or name is required')
  const tracks = await loadTracks(store, program.id)
  const track = findTrack(tracks, idOrName)
  if (!track) throw new McpUserError(`No track "${idOrName}".`)
  const [full] = await store.sql<{
    id: string; name: string; color: string; icon: string; purpose: string | null
    methodology_text: string | null; sources: unknown; deload_policy: unknown; retest_policy: unknown
  }[]>`
    SELECT id, name, color, icon, purpose, methodology_text, sources, deload_policy, retest_policy
    FROM track WHERE id = ${track.id} AND program_id IN (
      SELECT id FROM program WHERE athlete_id = ${store.athleteId}
    )
  `
  const progression_rules = await store.sql<object[]>`
    SELECT id, exercise_name, engine_type, params, active_from, active_to
    FROM progression_rule WHERE track_id = ${track.id} AND program_id = ${program.id}
    ORDER BY exercise_name NULLS FIRST
  `
  const autoreg_rules = await store.sql<object[]>`
    SELECT id, scope_type, scope_id, scope_name, signal, op, value, action, action_params, message
    FROM autoreg_rule WHERE athlete_id = ${store.athleteId}
  `
  const sessions = await loadLiveSessions(store, program.id)
  const exercises = sessions.flatMap((s) =>
    s.exercises
      .filter((e) => resolveTrack(e, tracks)?.id === track.id)
      .map((e) => ({
        session: s.name,
        name: e.name,
        sets: e.sets,
        reps: e.reps,
        load: e.load,
        target_rpe: e.target_rpe ?? null,
        superset_group: e.superset_group ?? null,
      })),
  )
  const goals = await store.sql<object[]>`
    SELECT id, name, metric, unit, side, target, baseline, current, best, due_date, status
    FROM athlete_goal
    WHERE athlete_id = ${store.athleteId} AND track_id = ${track.id}
    ORDER BY name
  `
  return {
    ...mcpStamp(new Date(), await athleteZone(store)),
    track: full,
    methodology: full?.methodology_text ?? null,
    sources: full?.sources ?? [],
    progression_rules,
    autoreg_rules,
    exercises,
    goals,
    deload_policy: full?.deload_policy ?? null,
    retest_policy: full?.retest_policy ?? null,
  }
}

async function createTrack(store: ConnectedStore, args: Record<string, unknown>) {
  const name = asString(args.name)
  if (!name) throw new McpUserError('name is required')
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  const diff = [{ op: 'create_track', name, purpose: asString(args.purpose) ?? null }]
  if (!asBool(args.confirm)) {
    return writePreview(diff, [], { rationale: asString(args.rationale) ?? null })
  }
  const [existing] = await store.sql<{ id: string }[]>`
    SELECT id FROM track WHERE program_id = ${program.id} AND lower(name) = ${name.toLowerCase()} LIMIT 1
  `
  if (existing) {
    if (asString(args.client_key)) return getTrack(store, existing.id)
    throw new McpUserError(`Track "${name}" already exists.`)
  }
  await store.sql`
    INSERT INTO track (program_id, name, color, icon, sort_order, purpose)
    SELECT ${program.id}, ${GENERAL_TRACK_SEED.name}, ${GENERAL_TRACK_SEED.color},
           ${GENERAL_TRACK_SEED.icon}, ${GENERAL_TRACK_SEED.sort_order}, ${GENERAL_TRACK_SEED.purpose}
    WHERE EXISTS (
      SELECT 1 FROM program
      WHERE id = ${program.id} AND athlete_id = ${store.athleteId}
        AND status IS DISTINCT FROM 'external'
    )
      AND NOT EXISTS (
        SELECT 1 FROM track WHERE program_id = ${program.id} AND name = ${GENERAL_TRACK_SEED.name}
      )
  `
  const [row] = await store.sql<{ id: string }[]>`
    INSERT INTO track (program_id, name, color, icon, sort_order, purpose, methodology_text, sources, deload_policy, retest_policy)
    SELECT ${program.id}, ${name}, ${asString(args.color) ?? '#9A9A9A'}, ${asString(args.icon) ?? 'circle'},
           COALESCE((SELECT MAX(sort_order) + 1 FROM track WHERE program_id = ${program.id}), 1),
           ${asString(args.purpose) ?? null}, ${asString(args.methodology_text) ?? null},
           ${jsonParam(store.sql, args.sources ?? [])},
           ${jsonParam(store.sql, args.deload_policy ?? null)},
           ${jsonParam(store.sql, args.retest_policy ?? null)}
    WHERE EXISTS (SELECT 1 FROM program WHERE id = ${program.id} AND athlete_id = ${store.athleteId})
    RETURNING id
  `
  if (!row) throw new McpUserError('Could not create track.')
  await recordMove(store, `Added the ${name} track.`, args, row.id)
  return getTrack(store, row.id)
}

async function updateTrack(store: ConnectedStore, args: Record<string, unknown>) {
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  const track = findTrack(await loadTracks(store, program.id), asString(args.track) ?? asString(args.track_id) ?? asString(args.name))
  if (!track) throw new McpUserError('track is required')
  const patch: Record<string, unknown> = {}
  if (asString(args.set_name)) patch.name = asString(args.set_name)
  if (asString(args.set_color)) patch.color = asString(args.set_color)
  if (asString(args.set_purpose)) patch.purpose = asString(args.set_purpose)
  if (asString(args.set_methodology_text)) patch.methodology_text = asString(args.set_methodology_text)
  if (args.set_sources !== undefined) patch.sources = args.set_sources
  if (asNum(args.set_order) != null) patch.sort_order = asNum(args.set_order)
  if (args.set_deload_policy !== undefined) patch.deload_policy = args.set_deload_policy
  if (args.set_retest_policy !== undefined) patch.retest_policy = args.set_retest_policy
  const diff = [{ op: 'update_track', track: track.name, set: patch }]
  if (!asBool(args.confirm)) return writePreview(diff, [], { rationale: asString(args.rationale) ?? null })
  if (Object.keys(patch).length === 0) throw new McpUserError('nothing to change')
  await store.sql`
    UPDATE track SET
      name = COALESCE(${asString(args.set_name) ?? null}, name),
      color = COALESCE(${asString(args.set_color) ?? null}, color),
      purpose = COALESCE(${asString(args.set_purpose) ?? null}, purpose),
      methodology_text = COALESCE(${asString(args.set_methodology_text) ?? null}, methodology_text),
      sort_order = COALESCE(${asNum(args.set_order)}, sort_order)
    WHERE id = ${track.id} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
  `
  if (args.set_sources !== undefined) {
    await store.sql`UPDATE track SET sources = ${jsonParam(store.sql, args.set_sources)}
      WHERE id = ${track.id} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})`
  }
  if (args.set_deload_policy !== undefined) {
    await store.sql`UPDATE track SET deload_policy = ${jsonParam(store.sql, args.set_deload_policy)}
      WHERE id = ${track.id} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})`
  }
  if (args.set_retest_policy !== undefined) {
    await store.sql`UPDATE track SET retest_policy = ${jsonParam(store.sql, args.set_retest_policy)}
      WHERE id = ${track.id} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})`
  }
  await recordMove(store, `Updated the ${track.name} track.`, args, track.id)
  return getTrack(store, track.id)
}

async function assignExercises(store: ConnectedStore, args: Record<string, unknown>) {
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  const tracks = await loadTracks(store, program.id)
  const assignments = Array.isArray(args.assignments) ? args.assignments as Array<Record<string, unknown>> : []
  if (!assignments.length) throw new McpUserError('assignments is required')
  const planned = []
  for (const a of assignments) {
    const session = asString(a.session_name)
    const exercise = asString(a.exercise_name)
    const track = findTrack(tracks, asString(a.track) ?? asString(a.track_id))
    if (!session || !exercise || !track) {
      planned.push({ session, exercise, track: track?.name ?? null, ok: false, reason: 'missing session, exercise, or track' })
      continue
    }
    planned.push({ session, exercise, track: track.name, track_id: track.id, ok: true })
  }
  if (!asBool(args.confirm)) {
    return writePreview(planned, planned.filter((p) => !p.ok).map((p) => String(p.reason)), { rationale: asString(args.rationale) ?? null })
  }
  const sessions = await loadLiveSessions(store, program.id)
  const updated: string[] = []
  const movedTo = new Set<string>()
  for (const a of planned) {
    if (!a.ok || !a.track_id) continue
    const sess = sessions.find((s) => s.name.toLowerCase().includes(a.session!.toLowerCase()) || a.session!.toLowerCase().includes(s.name.toLowerCase()))
    if (!sess) continue
    const next = sess.exercises.map((ex) => {
      const match = ex.name.toLowerCase().includes(a.exercise!.toLowerCase()) || a.exercise!.toLowerCase().includes(ex.name.toLowerCase())
      return match ? { ...ex, track_id: a.track_id } : ex
    })
    await store.sql`
      UPDATE routine SET exercises = ${jsonParam(store.sql, next)}
      WHERE id = ${sess.routineId}
        AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
    `
    updated.push(`${a.exercise} → ${a.track}`)
    movedTo.add(a.track_id)
  }
  if (updated.length) {
    await recordMove(store, `Moved ${updated.join(', ')}.`, args, movedTo.size === 1 ? [...movedTo][0] : null)
  }
  return { ...mcpStamp(new Date(), await athleteZone(store)), updated }
}

async function getTrackProgression(store: ConnectedStore, args: Record<string, unknown>, live: LiveProgram | null) {
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  const tracks = await loadTracks(store, program.id)
  const track = findTrack(tracks, asString(args.track) ?? asString(args.track_id))
  if (!track) throw new McpUserError('track is required')
  const rules = await store.sql<{ exercise_name: string | null; engine_type: string; params: ProgressionRule['params'] }[]>`
    SELECT exercise_name, engine_type, params FROM progression_rule
    WHERE track_id = ${track.id} AND program_id = ${program.id}
      AND (active_to IS NULL OR active_to >= CURRENT_DATE)
  `
  const engine_type = rules[0]?.engine_type ?? null
  const sessions = live?.sessions ?? []
  const performed: PerformedExercise[] = []
  for (const s of sessions) {
    for (const ex of s.exercises) {
      if (resolveTrack(ex, tracks)?.id !== track.id) continue
      performed.push({
        name: ex.name,
        prescribed: { sets: ex.sets, reps: ex.reps, load: ex.load ?? '', target_rpe: ex.target_rpe ?? null },
        sets: [],
      })
    }
  }
  const proposal_next_week = proposeNextWeek(
    rules.filter((r) => isEngineType(r.engine_type)).map((r) => ({
      engine_type: r.engine_type as ProgressionRule['engine_type'],
      exercise_name: r.exercise_name,
      params: r.params ?? {},
    })),
    performed,
  )
  return {
    ...mcpStamp(new Date(), await athleteZone(store)),
    engine_type,
    params: rules[0]?.params ?? {},
    history: [],
    proposal_next_week,
  }
}

async function setProgressionRule(store: ConnectedStore, args: Record<string, unknown>) {
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  const track = findTrack(await loadTracks(store, program.id), asString(args.track) ?? asString(args.track_id))
  if (!track) throw new McpUserError('track is required')
  const engine = asString(args.engine_type)
  if (!engine || !isEngineType(engine)) throw new McpUserError('engine_type is required')
  const params = (args.params && typeof args.params === 'object') ? args.params : {}
  const exercise = asString(args.exercise_name) ?? null
  const diff = [{ op: 'set_track_progression_rule', track: track.name, exercise, engine_type: engine, params }]
  if (!asBool(args.confirm)) return writePreview(diff, [], { rationale: asString(args.rationale) ?? null })
  const [row] = await store.sql<{ id: string }[]>`
    INSERT INTO progression_rule (program_id, track_id, exercise_name, engine_type, params, active_from)
    SELECT ${program.id}, ${track.id}, ${exercise}, ${engine}, ${jsonParam(store.sql, params)},
           ${asString(args.active_from) ?? null}
    WHERE EXISTS (SELECT 1 FROM program WHERE id = ${program.id} AND athlete_id = ${store.athleteId})
    RETURNING id
  `
  if (!row) throw new McpUserError('Could not save rule.')
  await recordMove(
    store,
    `Set ${track.name} to progress by ${engineLabel(engine)}${exercise ? ` for ${exercise}` : ''}.`,
    args,
    track.id,
  )
  return { ...mcpStamp(new Date(), await athleteZone(store)), rule: { id: row.id, track: track.name, exercise, engine_type: engine, params } }
}

async function listAutoregRules(store: ConnectedStore, args: Record<string, unknown>) {
  const scope = asString(args.scope_type)
  const rows = await store.sql<object[]>`
    SELECT id, scope_type, scope_id, scope_name, signal, op, value, action, action_params, message, created_at
    FROM autoreg_rule WHERE athlete_id = ${store.athleteId}
    ORDER BY created_at
  `
  const filtered = scope ? rows.filter((r) => (r as { scope_type: string }).scope_type === scope) : rows
  return { ...mcpStamp(new Date(), await athleteZone(store)), rules: filtered }
}

async function upsertAutoregRule(store: ConnectedStore, args: Record<string, unknown>) {
  const signal = asString(args.signal)
  const op = asString(args.op)
  const action = asString(args.action)
  const message = asString(args.message)
  const scope_type = asString(args.scope_type) ?? 'program'
  if (!signal || !op || !action || !message) throw new McpUserError('signal, op, action, and message are required')
  const diff = [{ op: 'upsert_autoreg_rule', signal, action, message }]
  if (!asBool(args.confirm)) return writePreview(diff, [], { rationale: asString(args.rationale) ?? null })
  const [row] = await store.sql<{ id: string }[]>`
    INSERT INTO autoreg_rule (athlete_id, scope_type, scope_id, scope_name, signal, op, value, action, action_params, message)
    VALUES (
      ${store.athleteId}, ${scope_type}, ${asString(args.scope) ?? asString(args.scope_id) ?? null},
      ${asString(args.scope_name) ?? null}, ${signal}, ${op}, ${asNum(args.value)}, ${action},
      ${jsonParam(store.sql, args.action_params ?? {})}, ${message}
    )
    RETURNING id
  `
  await recordMove(store, `Added a rule: ${message}`, args, null)
  return { ...mcpStamp(new Date(), await athleteZone(store)), rule: { id: row?.id, signal, op, action, message } }
}

async function getGoals(store: ConnectedStore, args: Record<string, unknown>) {
  const program = await activeProgram(store)
  const tracks = program ? await loadTracks(store, program.id) : []
  const track = findTrack(tracks, asString(args.track))
  const status = asString(args.status)
  const rows = await store.sql<{
    id: string; name: string; metric: string; unit: string | null; side: string | null
    direction: string
    target: number | null; target_range_hi: number | null
    baseline: number | null; current: number | null; best: number | null
    due_date: string | null; status: string; track_id: string | null
    cadence: string | null; source_metric: string | null
  }[]>`
    SELECT id, name, metric, unit, side, direction, target, target_range_hi, baseline, current, best, due_date::text, status, track_id,
           cadence, source_metric
    FROM athlete_goal WHERE athlete_id = ${store.athleteId}
    ORDER BY name
  `
  const measurements = await store.sql<{
    goal_id: string; measured_on: string; value: number | string; client_key: string | null
  }[]>`
    SELECT goal_id, measured_on::text, value, client_key
    FROM goal_measurement WHERE athlete_id = ${store.athleteId}
    ORDER BY measured_on
  `
  const historyByGoal = new Map<string, GoalMeasurement[]>()
  for (const m of measurements) {
    const list = historyByGoal.get(m.goal_id) ?? []
    list.push({
      date: m.measured_on,
      value: goalNumber(m.value) ?? 0,
      source: 'manual',
      client_key: m.client_key,
    })
    historyByGoal.set(m.goal_id, list)
  }
  const today = todayISO(await athleteZone(store))
  let list = rows.map((g) => {
    const history = historyByGoal.get(g.id) ?? []
    const computed = computeGoalStatus(g, history, today)
    const last_measured = lastMeasuredOn(history)
    return {
      ...g,
      status: computed,
      // What the app shows: zeroed / on_course / off_course / needs_test.
      display: goalDisplayStatus(computed, last_measured, { cadence: g.cadence, today }),
      forecast: forecastAtDue(g, history),
      last_measured,
      pair: pairKey(g.name),
    }
  })
  if (track) list = list.filter((g) => g.track_id === track.id)
  if (status) list = list.filter((g) => g.status === status)
  return { ...mcpStamp(new Date(), await athleteZone(store)), goals: list }
}

const DISPLAY_ORDER: Record<string, number> = { off_course: 0, needs_test: 1, on_course: 2, zeroed: 3 }

/**
 * The goal-first read Claude plans from: every goal as the athlete sees it,
 * where its trend lands, what trains it this week, what the coach last did
 * for it, and what is waiting on the athlete. Off course first.
 */
async function getGoalBrief(store: ConnectedStore) {
  const { goals } = await getGoals(store, {})
  const program = await activeProgram(store)
  const sessions = program ? await loadLiveSessions(store, program.id) : []
  const exerciseNames = [...new Set(sessions.flatMap((s) => s.exercises.map((e) => e.name)))]
  const lanes = await store.sql<{ id: string; name: string }[]>`
    SELECT t.id, t.name FROM track t JOIN program p ON p.id = t.program_id
    WHERE p.athlete_id = ${store.athleteId}
  `
  const laneName = new Map(lanes.map((t) => [t.id, t.name]))
  const refs = [...new Set(goals.flatMap((g) => [g.id, g.track_id]).filter((id): id is string => !!id))]
  const moves = refs.length
    ? await store.sql<{ ref_id: string; body: string; created_at: string }[]>`
        SELECT ref_id::text, body, to_json(created_at) #>> '{}' AS created_at
        FROM coach_message
        WHERE athlete_id = ${store.athleteId} AND kind = 'note' AND ref_id = ANY(${refs}::uuid[])
        ORDER BY created_at DESC
        LIMIT 60
      `
    : []
  const proposals = await listProposals(store)
  const brief = goals.map((g) => {
    const src = goalSource(g, exerciseNames)
    const trainedBy = src && src.kind !== 'test'
      ? sessions.filter((s) => s.exercises.some((e) => sourceMatches(src, e.name))).map((s) => s.name)
      : []
    return {
      id: g.id,
      name: g.name,
      lane: g.track_id ? laneName.get(g.track_id) ?? null : null,
      display: g.display,
      status: g.status,
      current: g.current,
      target: g.target,
      unit: g.unit,
      direction: g.direction,
      due_date: g.due_date,
      last_measured: g.last_measured,
      cadence: g.cadence,
      forecast: g.forecast,
      source: src ? { binding: formatGoalSource(src), inferred: src.inferred } : null,
      sessions_this_week: trainedBy,
      recent_moves: moves.filter((m) => m.ref_id === g.id || m.ref_id === g.track_id).slice(0, 3)
        .map((m) => ({ at: m.created_at, body: m.body })),
      pending_proposals: (proposals ?? []).filter((p) => (p.goal_ids ?? []).includes(g.id)).map((p) => p.id),
    }
  }).sort((a, b) => (DISPLAY_ORDER[a.display] ?? 9) - (DISPLAY_ORDER[b.display] ?? 9) || a.name.localeCompare(b.name))
  return {
    ...mcpStamp(new Date(), await athleteZone(store)),
    goals: brief,
    pending_proposals: proposals == null
      ? 'unavailable on this database'
      : proposals.map((p) => ({ id: p.id, title: p.title, goal_ids: p.goal_ids, created_at: p.created_at })),
    next: 'For an off_course goal: preview a change to the lane or sessions that train it, then preview_program_edits with propose=true and goal_ids so the athlete accepts it in the app. A needs_test goal wants a test, not a program change. Give a goal with no source a source_metric (upsert_goal) so logged sets move it.',
  }
}

async function upsertGoal(store: ConnectedStore, args: Record<string, unknown>) {
  const name = asString(args.name)
  if (!name) throw new McpUserError('name is required')
  const direction = asString(args.direction) ?? 'higher'
  if (!isGoalDirection(direction)) throw new McpUserError('direction must be higher, lower, or pass')
  const side = asString(args.side) ?? 'none'
  if (!isGoalSide(side)) throw new McpUserError('side must be L, R, both, or none')
  const program = await activeProgram(store)
  const tracks = program ? await loadTracks(store, program.id) : []
  const track = findTrack(tracks, asString(args.track))
  const rawSource = asString(args.source_metric)
  const source = rawSource ? parseGoalSource(rawSource) : null
  if (rawSource && !source) {
    throw new McpUserError(`source_metric must be kind:Exercise with kind one of ${SOURCE_KINDS.join(', ')} (test may omit the exercise), e.g. top_set:Strict Press`)
  }
  if (source) args = { ...args, source_metric: formatGoalSource(source) }
  const diff = [{ op: 'upsert_goal', name, target: asNum(args.target), track: track?.name ?? null, source: source ? formatGoalSource(source) : null }]
  if (!asBool(args.confirm)) return writePreview(diff, [], { rationale: asString(args.rationale) ?? null })
  const goalId = asString(args.goal_id)
  if (goalId) {
    await store.sql`
      UPDATE athlete_goal SET
        name = ${name},
        metric = COALESCE(${asString(args.metric) ?? null}, metric),
        unit = COALESCE(${asString(args.unit) ?? null}, unit),
        side = ${side},
        direction = ${direction},
        target = COALESCE(${asNum(args.target)}, target),
        target_range_hi = COALESCE(${asNum(args.target_range_hi)}, target_range_hi),
        baseline = COALESCE(${asNum(args.baseline)}, baseline),
        due_date = COALESCE(${asString(args.due_date) ?? null}, due_date),
        test_protocol = COALESCE(${asString(args.test_protocol) ?? null}, test_protocol),
        cadence = COALESCE(${asString(args.cadence) ?? null}, cadence),
        source_metric = COALESCE(${asString(args.source_metric) ?? null}, source_metric),
        track_id = COALESCE(${track?.id ?? null}, track_id),
        updated_at = NOW()
      WHERE id = ${goalId} AND athlete_id = ${store.athleteId}
    `
    const [owned] = await store.sql<{ id: string }[]>`
      SELECT id FROM athlete_goal WHERE id = ${goalId} AND athlete_id = ${store.athleteId} LIMIT 1
    `
    if (owned) await recordMove(store, `Updated the goal ${name}.`, args, owned.id)
    return { ...mcpStamp(new Date(), await athleteZone(store)), goal: { id: goalId, name } }
  }
  const [row] = await store.sql<{ id: string }[]>`
    INSERT INTO athlete_goal (
      athlete_id, track_id, name, metric, unit, side, direction,
      target, target_range_hi, baseline, due_date, test_protocol, cadence, source_metric, status
    ) VALUES (
      ${store.athleteId}, ${track?.id ?? null}, ${name}, ${asString(args.metric) ?? name},
      ${asString(args.unit) ?? null}, ${side}, ${direction}, ${asNum(args.target)},
      ${asNum(args.target_range_hi)}, ${asNum(args.baseline)}, ${asString(args.due_date) ?? null},
      ${asString(args.test_protocol) ?? null}, ${asString(args.cadence) ?? null},
      ${asString(args.source_metric) ?? null}, 'on_track'
    )
    ON CONFLICT (athlete_id, name) DO UPDATE SET
      target = COALESCE(EXCLUDED.target, athlete_goal.target),
      updated_at = NOW()
    RETURNING id
  `
  if (row) {
    const target = asNum(args.target)
    const unit = asString(args.unit)
    const due = asString(args.due_date)
    await recordMove(
      store,
      `Set the goal ${name}${target != null ? `: ${target}${unit ? ` ${unit}` : ''}` : ''}${due ? ` by ${due}` : ''}.`,
      args,
      row.id,
    )
  }
  return { ...mcpStamp(new Date(), await athleteZone(store)), goal: { id: row?.id, name } }
}

async function logGoalMeasurement(store: ConnectedStore, args: Record<string, unknown>) {
  const ident = asString(args.goal) ?? asString(args.goal_id) ?? asString(args.name)
  if (!ident) throw new McpUserError('goal is required')
  const value = asNum(args.value)
  if (value == null) throw new McpUserError('value is required')
  const date = asString(args.date) ?? todayISO(await athleteZone(store))
  const [goal] = await store.sql<{
    id: string; name: string; metric: string; direction: string; target: number | null; target_range_hi: number | null
    baseline: number | null; current: number | null; best: number | null; due_date: string | null
  }[]>`
    SELECT id, name, metric, direction, target, target_range_hi, baseline, current, best, due_date::text
    FROM athlete_goal
    WHERE athlete_id = ${store.athleteId}
      AND (id::text = ${ident} OR lower(name) = ${ident.toLowerCase()} OR name ILIKE ${'%' + ident + '%'})
    LIMIT 1
  `
  if (!goal) throw new McpUserError(`No goal "${ident}".`)
  const clientKey = asString(args.client_key)
  const diff = [{ op: 'log_goal_measurement', goal: goal.name, date, value }]
  if (!asBool(args.confirm)) return writePreview(diff)
  if (clientKey) {
    const [dup] = await store.sql<{ id: string }[]>`
      SELECT id FROM goal_measurement
      WHERE athlete_id = ${store.athleteId} AND client_key = ${clientKey}
      LIMIT 1
    `
    if (dup) {
      return { ...mcpStamp(new Date(), await athleteZone(store)), measurement: { id: dup.id, reused: true }, goal_after: goal }
    }
  }
  const applied = applyMeasurement(goal, { date, value, source: asString(args.source) ?? 'agent' })
  const [row] = await store.sql<{ id: string }[]>`
    INSERT INTO goal_measurement (athlete_id, goal_id, measured_on, value, side, source, note, client_key)
    VALUES (
      ${store.athleteId}, ${goal.id}, ${date}, ${value}, ${asString(args.side) ?? null},
      ${asString(args.source) ?? 'agent'}, ${asString(args.note) ?? null}, ${clientKey ?? null}
    )
    RETURNING id
  `
  const today = todayISO(await athleteZone(store))
  const status = computeGoalStatus({ ...goal, current: applied.current, best: applied.best, baseline: applied.baseline }, [], today)
  await store.sql`
    UPDATE athlete_goal
    SET current = ${applied.current}, best = ${applied.best}, baseline = ${applied.baseline},
        status = ${status}, updated_at = NOW()
    WHERE id = ${goal.id} AND athlete_id = ${store.athleteId}
  `
  return {
    ...mcpStamp(new Date(), await athleteZone(store)),
    measurement: { id: row?.id, date, value, goal: goal.name },
    goal_after: { ...goal, current: applied.current, best: applied.best, baseline: applied.baseline, status },
  }
}

async function getGoalHistory(store: ConnectedStore, args: Record<string, unknown>) {
  const ident = asString(args.goal) ?? asString(args.goal_id)
  if (!ident) throw new McpUserError('goal is required')
  const [goal] = await store.sql<{
    id: string; name: string; metric: string; direction: string; target: number | null; due_date: string | null
    current: number | null; baseline: number | null; best: number | null; target_range_hi: number | null
  }[]>`
    SELECT id, name, metric, direction, target, due_date::text, current, baseline, best, target_range_hi
    FROM athlete_goal
    WHERE athlete_id = ${store.athleteId}
      AND (id::text = ${ident} OR lower(name) = ${ident.toLowerCase()} OR name ILIKE ${'%' + ident + '%'})
    LIMIT 1
  `
  if (!goal) throw new McpUserError(`No goal "${ident}".`)
  const since = asString(args.since)
  const rows = await store.sql<{
    measured_on: string; value: number | string; side: string | null; source: string; note: string | null
    client_key: string | null
  }[]>`
    SELECT measured_on::text, value, side, source, note, client_key
    FROM goal_measurement
    WHERE athlete_id = ${store.athleteId} AND goal_id = ${goal.id}
      AND (${since ?? null}::date IS NULL OR measured_on >= ${since ?? null}::date)
    ORDER BY measured_on
  `
  const history: GoalMeasurement[] = rows.map((r) => ({
    date: r.measured_on,
    value: goalNumber(r.value) ?? 0,
    side: r.side,
    source: r.source,
    note: r.note,
    client_key: r.client_key,
  }))
  const today = todayISO(await athleteZone(store))
  return {
    ...mcpStamp(new Date(), await athleteZone(store)),
    goal: { ...goal, status: computeGoalStatus(goal, history, today), last_measured: lastMeasuredOn(history) },
    measurements: history,
    trend: history.length >= 2 ? history[history.length - 1].value - history[0].value : 0,
    // The same forecast the app's status reads: the last three real points.
    projected_at_due: forecastAtDue(goal, history)?.value ?? null,
    forecast: forecastAtDue(goal, history),
  }
}

async function addWorkoutNote(store: ConnectedStore, args: Record<string, unknown>) {
  const text = asString(args.text)
  if (!text) throw new McpUserError('text is required')
  const workoutId = asString(args.workout_id)
  const sessionName = asString(args.session_name)
  const date = asString(args.date)
  const clientKey = asString(args.client_key)
  let sessionId: string | null = null
  let resolvedWorkout = workoutId ?? null
  if (!resolvedWorkout && sessionName) {
    const [sess] = await store.sql<{ id: string }[]>`
      SELECT r.id FROM routine r
      JOIN program p ON p.id = r.program_id
      WHERE p.athlete_id = ${store.athleteId} AND r.name ILIKE ${'%' + sessionName + '%'}
      LIMIT 1
    `
    sessionId = sess?.id ?? null
    if (sessionId && date) {
      const [w] = await store.sql<{ id: string }[]>`
        SELECT w.id FROM workout w
        JOIN routine r ON r.id = w.routine_id
        JOIN program p ON p.id = r.program_id
        WHERE p.athlete_id = ${store.athleteId} AND w.routine_id = ${sessionId}
          AND (w.performed_at AT TIME ZONE 'UTC')::date = ${date}::date
        LIMIT 1
      `
      resolvedWorkout = w?.id ?? null
    }
  }
  if (!resolvedWorkout && !sessionId) throw new McpUserError('workout_id or session_name is required')
  const diff = [{ op: 'add_workout_note', workout_id: resolvedWorkout, session_id: sessionId, text }]
  if (!asBool(args.confirm)) return writePreview(diff)
  if (clientKey) {
    const [dup] = await store.sql<{ id: string; body: string }[]>`
      SELECT id, body FROM workout_note
      WHERE athlete_id = ${store.athleteId} AND client_key = ${clientKey}
      LIMIT 1
    `
    if (dup) return { ...mcpStamp(new Date(), await athleteZone(store)), note: { id: dup.id, text: dup.body, reused: true } }
  }
  const [row] = await store.sql<{ id: string; created_at: string }[]>`
    INSERT INTO workout_note (athlete_id, workout_id, session_id, author, body, client_key)
    VALUES (${store.athleteId}, ${resolvedWorkout}, ${sessionId}, 'coach', ${text}, ${clientKey ?? null})
    RETURNING id, created_at
  `
  return { ...mcpStamp(new Date(), await athleteZone(store)), note: { id: row?.id, text, workout_id: resolvedWorkout, session_id: sessionId } }
}

async function updateAthleteTarget(store: ConnectedStore, args: Record<string, unknown>) {
  const text = asString(args.text)
  if (!text) throw new McpUserError('text is required')
  const diff = [{ op: 'update_athlete_target', text }]
  if (!asBool(args.confirm)) return writePreview(diff)
  await store.sql`UPDATE athlete SET goals = ${text} WHERE id = ${store.athleteId}`
  await recordMove(store, `Changed your target to: ${text}`, args, null)
  const [row] = await store.sql<{ id: string; name: string | null; goals: string | null }[]>`
    SELECT id, name, goals FROM athlete WHERE id = ${store.athleteId}
  `
  return { ...mcpStamp(new Date(), await athleteZone(store)), athlete: row }
}

const PROGRAM_META_LABEL = {
  name: 'name', block_phase: 'phase', start_date: 'start', end_date: 'end',
  deload_week_start: 'deload', retest_start: 'retest', retest_end: 'retest ends',
} as const

async function updateProgramMeta(store: ConnectedStore, args: Record<string, unknown>) {
  const program = await activeProgram(store)
  if (!program) throw new McpUserError('No active program.')
  const patch = {
    name: asString(args.set_name) ?? null,
    block_phase: asString(args.set_phase) ?? null,
    start_date: asString(args.start_date) ?? null,
    end_date: asString(args.end_date) ?? null,
    deload_week_start: asString(args.deload_week_start) ?? null,
    retest_start: asString(args.retest_start) ?? null,
    retest_end: asString(args.retest_end) ?? null,
  }
  const diff = [{ op: 'update_program_meta', ...patch }]
  if (!asBool(args.confirm)) return writePreview(diff)
  await store.sql`
    UPDATE program SET
      name = COALESCE(${patch.name}, name),
      block_phase = COALESCE(${patch.block_phase}, block_phase),
      start_date = COALESCE(${patch.start_date}::date, start_date),
      end_date = COALESCE(${patch.end_date}::date, end_date),
      deload_week_start = COALESCE(${patch.deload_week_start}::date, deload_week_start),
      retest_start = COALESCE(${patch.retest_start}::date, retest_start),
      retest_end = COALESCE(${patch.retest_end}::date, retest_end)
    WHERE id = ${program.id} AND athlete_id = ${store.athleteId}
  `
  const changed = (Object.entries(patch) as Array<[keyof typeof patch, string | null]>)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${PROGRAM_META_LABEL[k]} ${v}`)
  if (changed.length) await recordMove(store, `Updated the block: ${changed.join(', ')}.`, args, program.id)
  const [row] = await store.sql<object[]>`
    SELECT id, name, block_phase, start_date::text, end_date::text, deload_week_start::text,
           retest_start::text, retest_end::text, goal, status
    FROM program WHERE id = ${program.id} AND athlete_id = ${store.athleteId}
  `
  return { ...mcpStamp(new Date(), await athleteZone(store)), program: row }
}

export async function firedRulesForSignals(
  store: ConnectedStore,
  signals: { pain_knee_L?: number | null; pain_knee_R?: number | null; sleep_hours?: number | null },
  exercises: Array<{ name: string; track_id?: string | null }>,
) {
  const rows = await store.sql<AutoregRule[]>`
    SELECT scope_type, scope_id, scope_name, signal, op, value, action, action_params, message
    FROM autoreg_rule WHERE athlete_id = ${store.athleteId}
  `
  return evaluateAutoregRules(rows, signals, exercises)
}

export async function briefTracksAndGoals(store: ConnectedStore, live: LiveProgram | null): Promise<string> {
  try {
    const listed = await listTracks(store, live?.programId)
    const goals = await getGoals(store, {})
    const tracks = (listed as { tracks?: Array<{ name: string; engine_type?: string | null; days?: number[] }> }).tracks ?? []
    const goalRows = (goals as { goals?: Array<{ name: string; status: string; current?: number | null; target?: number | null; unit?: string | null }> }).goals ?? []
    const trackLines = tracks.length
      ? tracks.map((t) => `- ${t.name}${t.engine_type ? ` · ${t.engine_type}` : ''}${t.days?.length ? ` · days ${t.days.join(',')}` : ''}`)
      : ['- none']
    const goalLines = goalRows.length
      ? goalRows.map((g) => {
          const cur = g.current != null ? `${g.current}${g.unit ?? ''}` : 'pending'
          const tgt = g.target != null ? `${g.target}${g.unit ?? ''}` : '—'
          return `- ${g.name}: ${cur} → ${tgt} (${g.status})`
        })
      : ['- none']
    return ['## Tracks', ...trackLines, '', '## Goals', ...goalLines].join('\n')
  } catch {
    return ''
  }
}

export function suggestAssignments(
  sessions: Array<{ name: string; sessionType?: string | null; exercises: Array<{ name: string }> }>,
) {
  return sessions.flatMap((s) =>
    s.exercises.map((e) => ({
      session_name: s.name,
      exercise_name: e.name,
      track: suggestTrackName(e.name, s.name, s.sessionType),
    })),
  )
}
