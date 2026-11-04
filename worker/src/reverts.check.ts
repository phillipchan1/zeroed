// Every change type revertible (Round 2 item 3) against a real schema.
//   1. Static: every change_log type the Worker code writes has a revert
//      handler (REVERT_HANDLERS); fails the moment a new type lands without one.
//   2. Per type: write it, preview the revert, apply it with that preview
//      (one revert_change row linked by reverted_by), check the target; then
//      redo it (revert the revert) where redo is defined.
//   3. Conflicts: a later change to the same target shows in the preview and
//      blocks the revert; a preview that no longer matches asks for a new one.
//   4. Safety: no revert loosens an under-18 rule or unblocks a region;
//      voiding a check-in keeps its block; redoing a clinician clear is refused.
//   5. Flag off: tools and routes unchanged; retired rows read as before.
//   6. Isolation: athlete A's reverts and tombstones never reach athlete B.
// Synthetic athletes and data only (isolation-seed.sql + rows made here).
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/reverts.check.ts

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'
import { athleteChangeLogAction } from './changeLogRoute.ts'
import { listChanges, type ChangeView } from './changeLog.ts'
import { REVERT_HANDLERS, revertChange } from './reverts.ts'
import { hiddenIds } from './tombstones.ts'
import { createApproval } from './approvals.ts'
import { approveAndAccept } from './proposals.ts'
import { clearRedFlag, clearRegion, saveCheckin, setCoachHealth, setCoachRole } from './readiness.ts'
import { loadCheckins, loadPain, loadRegionStatus, blocksNow } from './regionStatus.ts'
import { loadSessionRpe, logSessionRpe } from './sessionRpe.ts'
import { athleteCoachAction } from './appCoach.ts'
import { blockedRegions, resolveMethodology } from './methodology.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import { addDays } from '../../src/engine/sessionOverride.ts'
import { addDaysIso } from './coach/composer.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ---- 1. static: every change type written in code has a revert handler ------------------

const here = dirname(fileURLToPath(import.meta.url))
const sources = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.check.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(here, f), 'utf8') }))
const TOOL_VERB = /^(apply|accept|add|app|assign|clear|create|log|reapply|revert|revoke|set|update|upsert|void)_[a-z_]+$/
/** Every change_log type a set of sources writes (and the writes it can't resolve). */
function scanTypes(files: Array<{ file: string; text: string }>): { written: Map<string, string>; unresolved: string[] } {
  const written = new Map<string, string>()
  const note = (tool: string, file: string) => { if (!written.has(tool)) written.set(tool, file) }
  const consts = new Map<string, string>()
  for (const { text } of files) for (const m of text.matchAll(/const ([A-Z_]*TOOL) = '([a-z_]+)'/g)) consts.set(m[1], m[2])
  const unresolved: string[] = []
  for (const { file, text } of files) {
    // writeChange(store, { … tool: '…' … }): every call site names its type, except the generic gate in changeLog.ts.
    for (const m of text.matchAll(/writeChange\(store, \{/g)) {
      const body = text.slice(m.index!, m.index! + 900)
      const lit = /\btool: '([a-z_]+)'/.exec(body)
      if (lit) note(lit[1], file)
      else if (file !== 'changeLog.ts') unresolved.push(`${file}: writeChange without a literal tool`)
    }
    for (const m of text.matchAll(/\btool: '([a-z_]+)'/g)) if (TOOL_VERB.test(m[1])) note(m[1], file)
    for (const m of text.matchAll(/gate\.(?:commit|logging)\('([a-z_]+)'/g)) note(m[1], file)
    for (const m of text.matchAll(/(?:gatedWrite|loggedWrite)(?:<[^(]*>)?\(gate, '([a-z_]+)'/g)) note(m[1], file)
    for (const m of text.matchAll(/commitAuthorized\(store, actor, ([A-Z_]+|'[a-z_]+')/g)) {
      const t = m[1].startsWith("'") ? m[1].slice(1, -1) : consts.get(m[1])
      if (t) note(t, file)
      else unresolved.push(`${file}: commitAuthorized with unknown tool ${m[1]}`)
    }
    // Raw SQL inserts into change_log: the tool literal sits among the values.
    for (const m of text.matchAll(/INSERT INTO change_log/g)) {
      const end = text.indexOf('`', m.index!)
      const body = text.slice(m.index!, end > 0 ? end : m.index! + 2000)
      const tools = [...body.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).filter((t) => TOOL_VERB.test(t))
      // changeLog.ts's writeChange is the generic writer: its callers name the type (checked above).
      if (!tools.length && file !== 'changeLog.ts') unresolved.push(`${file}: INSERT INTO change_log without a tool literal`)
      for (const t of tools) note(t, file)
    }
  }
  return { written, unresolved }
}
const { written, unresolved } = scanTypes(sources)
ok(unresolved.length === 0, `static: every change_log write names its type (${unresolved.join('; ')})`)
ok(written.size >= 28, `static: the scan finds the change types (${[...written.keys()].sort().join(', ')})`)
const missing = [...written.keys()].filter((t) => !REVERT_HANDLERS[t])
ok(missing.length === 0, `static: every change type has a revert handler (missing: ${missing.map((t) => `${t} in ${written.get(t)}`).join(', ')})`)
// The scan catches a new type in every write shape, so a type without a handler fails here.
for (const snippet of [
  "await writeChange(store, { id, actor, tool: 'brand_new_type', targetType: 'x' })",
  "return gate.commit('brand_new_type', args, state, body)",
  "return gatedWrite(gate, 'brand_new_type', args, state, body)",
  "const NEW_TOOL = 'brand_new_type'\nawait commitAuthorized(store, actor, NEW_TOOL, auth, null, [], body)",
  "await store.sql`INSERT INTO change_log (athlete_id, tool) VALUES (${a}, 'apply_brand_new_type')`",
]) {
  const probe = scanTypes([{ file: 'probe.ts', text: snippet }])
  ok([...probe.written.keys()].some((t) => /brand_new_type/.test(t) && !REVERT_HANDLERS[t]), `static: a new type without a handler is caught (${snippet.slice(0, 40)}…)`)
}
ok(scanTypes([{ file: 'probe.ts', text: 'await writeChange(store, { ...entry, actor, tool: someVar })' }]).unresolved.length === 1, 'static: a write whose type can\'t be read fails the check')
for (const [tool, h] of Object.entries(REVERT_HANDLERS)) {
  ok(typeof h.defined === 'string' && h.defined.length > 20, `static: ${tool} defines what its revert does`)
  ok(written.has(tool), `static: ${tool} is a type the code writes`)
}

// ---- harness ----------------------------------------------------------------------------

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '66666666-6666-4666-8666-666666666666'
const K = '88888888-8888-4888-8888-888888888888'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PHASE_A = '55555555-5555-5555-5555-555555555555'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const UPPER = 'c0c0c0c0-0000-4000-8000-000000000011'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const TOKEN_ROLE_ID = 'abab7777-0000-4000-8000-0000000000aa'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const me: OverrideActor = { type: 'athlete', id: A }

const upperExercises = [
  { name: 'Bench Press', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
  { name: 'Chest-Supported Row', sets: 3, reps: '10', load: 'moderate' },
  { name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' },
]
await harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, 'Upper', 'strength', $4::jsonb, 'Upper intent', 3)`,
  [UPPER, PROG_A, PHASE_A, JSON.stringify(upperExercises)],
)
await harness.query(`INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'role-coach', 'hash-role', 'role')`, [TOKEN_ROLE_ID, A])
for (const [id, user, name] of [[C, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Athlete C'], [K, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Athlete K']]) {
  await harness.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, `${name.slice(-1).toLowerCase()}@example.com`])
  await harness.query(`INSERT INTO athlete (id, auth_user_id, name, training_age, sessions_per_week) VALUES ($1, $2, $3, 2, 3)`, [id, user, name])
}
const storeC = makeStore(sql, C)
const storeK = makeStore(sql, K)

const call = (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A) =>
  executeZeroedTool(sql, athlete, name, args, {}, actor)
async function callErr(name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> {
  try {
    return await call(name, args, actor, athlete)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const kept = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? /preview_id: (chp_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const sop = (text: string) => /preview_id: (sop_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
async function yes(previewId: string, athlete = A): Promise<string> {
  const r = await createApproval(makeStore(sql, athlete), { type: 'athlete', id: athlete }, { preview_id: previewId })
  return r.ok ? r.approval_ref : 'msg:00000000-0000-4000-8000-000000000000'
}
async function approved(name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> {
  const preview = await call(name, args, actor, athlete)
  return call(name, { ...args, confirm: true, preview_id: kept(preview), approval_ref: await yes(kept(preview), athlete) }, actor, athlete)
}
async function flags(athleteId: string, f: { tracks?: boolean; coach?: boolean }) {
  for (const [k, on] of [['tracks_v1', f.tracks], ['coach_v1', f.coach]] as const) {
    if (on === undefined) continue
    if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || jsonb_build_object(${k}::text, true) WHERE id = ${athleteId}`
    else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - ${k}::text WHERE id = ${athleteId}`
  }
}
type LogRow = { id: string; tool: string; diff: Record<string, unknown>; reverted_by: string | null; revert_of: string | null; target_type: string; target_id: string | null; approval_ref: string | null; preview_id: string | null }
const lastLog = async (athleteId = A, tool?: string) => (await harness.query<LogRow>(
  `SELECT id::text AS id, tool, diff, reverted_by::text AS reverted_by, revert_of::text AS revert_of, target_type, target_id, approval_ref, preview_id
   FROM change_log WHERE athlete_id = $1 AND ($2::text IS NULL OR tool = $2::text) ORDER BY created_at DESC, id DESC LIMIT 1`, [athleteId, tool ?? null],
))[0]
const logById = async (id: string) => (await harness.query<LogRow>(
  `SELECT id::text AS id, tool, diff, reverted_by::text AS reverted_by, revert_of::text AS revert_of, target_type, target_id, approval_ref, preview_id
   FROM change_log WHERE id::text = $1`, [id],
))[0]
type Preview = { ok: boolean; preview_id?: string; direction?: string; text: string; reason?: string; conflicts?: Array<{ id: string; summary: string }> }
type Result = { ok: boolean; reason?: string; text: string; change_id?: string; direction?: string; conflicts?: Array<{ id: string }> }
const previewOf = async (id: string, store = storeA) => (await athleteChangeLogAction(store, { action: 'preview_revert', id }))[0] as Preview
const revertWith = async (id: string, previewId?: string, store = storeA) =>
  (await athleteChangeLogAction(store, { action: 'revert', id, ...(previewId ? { preview_id: previewId } : {}) }))[0] as Result
/** Preview, then the athlete's tap on exactly that preview. */
async function tapRevert(id: string, store = storeA): Promise<Result> {
  const p = await previewOf(id, store)
  if (!p.ok) return { ok: false, reason: p.reason, text: p.text, conflicts: p.conflicts }
  return revertWith(id, p.preview_id, store)
}
const exercisesOf = async (id: string) =>
  JSON.stringify((await harness.query<{ exercises: unknown }>('SELECT exercises FROM routine WHERE id = $1', [id]))[0].exercises)
const exercised = new Set<string>()
/** Revert `id`, check the new row links both ways, and remember the type was covered. */
async function reverted(label: string, id: string, store = storeA): Promise<LogRow | null> {
  const orig = await logById(id)
  const res = await tapRevert(id, store)
  ok(res.ok, `${label}: reverts (${res.text})`)
  if (!res.ok) return null
  const row = await logById(String(res.change_id))
  ok(row?.tool === 'revert_change' && row.revert_of === id && (await logById(id)).reverted_by === row.id, `${label}: one revert_change row, linked both ways`)
  ok(/^tap:/.test(String(row?.approval_ref)) && row?.preview_id?.startsWith('chp_') === true, `${label}: the athlete's tap on the preview they saw`)
  const tool = orig.tool === 'revert_change' ? String(orig.diff.undid_tool) : orig.tool
  exercised.add(tool)
  return row
}
const tracksListed = async (athlete = A, actor: OverrideActor = coachA) =>
  (JSON.parse(await call('list_tracks', {}, actor, athlete)) as { tracks: Array<{ id: string; name: string }> }).tracks
const dataRows = async (table: string, athleteId = A, userId = USER_A) =>
  ((await executeDataQuery(sql, { userId, athleteId }, { table, op: 'select', columns: '*' })).data ?? []) as Array<{ id: string; name?: string }>

// ---- 5a. flag OFF: nothing new ------------------------------------------------------------
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: tool list is exactly ZEROED_TOOLS')
ok((await athleteChangeLogAction(storeA, { action: 'preview_revert', id: A }))[1] === 404, 'flag off: preview_revert reads as absent')
ok((await athleteChangeLogAction(storeA, { action: 'revert', id: A }))[1] === 404, 'flag off: revert reads as absent')
ok((await callErr('preview_revert_change', { change_id: A })).includes('Unknown tool'), 'flag off: preview_revert_change is unknown')
const offTracks = await dataRows('track')
ok((await hiddenIds(storeA, 'track')).length === 0, 'flag off: nothing is hidden')

// ---- flag ON ---------------------------------------------------------------------------------
await flags(A, { tracks: true })
await flags(B, { tracks: true })
ok(JSON.stringify(await dataRows('track')) === JSON.stringify(offTracks), 'flag on, nothing reverted: /api/data reads exactly as before')

// ---- 2. per type ---------------------------------------------------------------------------

// create_track: retired (hidden, kept); redo brings it back.
await approved('create_track', { name: 'Sprint', purpose: 'top speed' })
const createRow = await lastLog(A, 'create_track')
const sprintId = String(createRow.target_id)
ok(createRow.diff.track_id === sprintId, 'create_track: the row names the track it created')
const unretire = await reverted('create_track', createRow.id)
ok(!(await tracksListed()).some((t) => t.id === sprintId) && await count('track', 'id::text = $1', [sprintId]) === 1, 'create_track undo: hidden from list_tracks, the row kept')
ok(!(await dataRows('track')).some((t) => t.id === sprintId), 'create_track undo: hidden from /api/data too')
ok((await approved('create_track', { name: 'Sprint' }).catch((e: Error) => e.message)).includes('was undone'), 'create_track: a retired name is not silently reused')
const redoTrack = await reverted('create_track redo', (unretire?.id ?? ''))
ok(redoTrack?.diff.direction === 'redo' && (await tracksListed()).some((t) => t.id === sprintId), 'create_track redo: the track is back')

// update_track: restore; redo re-applies.
await approved('update_track', { track: 'Sprint', set_purpose: 'acceleration' })
const upd = await lastLog(A, 'update_track')
const updUndo = await reverted('update_track', upd.id)
ok((await harness.query<{ purpose: string }>('SELECT purpose FROM track WHERE id = $1', [sprintId]))[0].purpose === 'top speed', 'update_track undo: purpose restored')
await reverted('update_track redo', (updUndo?.id ?? ''))
ok((await harness.query<{ purpose: string }>('SELECT purpose FROM track WHERE id = $1', [sprintId]))[0].purpose === 'acceleration', 'update_track redo: purpose re-applied')

// set_track_progression_rule: ended (not deleted); redo reopens.
await approved('set_track_progression_rule', { track: 'Sprint', engine_type: 'double_progression', params: { step: 5 } })
const rule = await lastLog(A, 'set_track_progression_rule')
const ruleUndo = await reverted('set_track_progression_rule', rule.id)
ok(await count('progression_rule', 'id::text = $1 AND active_to IS NOT NULL', [String(rule.target_id)]) === 1, 'rule undo: ended, kept')
ok(typeof ruleUndo?.diff.ended_on === 'string', 'rule undo: records the day it ended')
await reverted('set_track_progression_rule redo', (ruleUndo?.id ?? ''))
ok(await count('progression_rule', 'id::text = $1 AND active_to IS NULL', [String(rule.target_id)]) === 1, 'rule redo: open again')

// upsert_autoreg_rule: retired; redo back.
await approved('upsert_autoreg_rule', { signal: 'sleep_hours', op: '<', value: 6, action: 'trim_accessories', message: 'Short sleep trims accessories.' })
const auto = await lastLog(A, 'upsert_autoreg_rule')
const autoRules = async () => (JSON.parse(await call('list_autoreg_rules', {})) as { rules: Array<{ id: string }> }).rules
const autoUndo = await reverted('upsert_autoreg_rule', auto.id)
ok(!(await autoRules()).some((r) => r.id === auto.target_id) && await count('autoreg_rule', 'id::text = $1', [String(auto.target_id)]) === 1, 'autoreg undo: stops applying, kept')
ok(!(await dataRows('autoreg_rule')).some((r) => r.id === auto.target_id), 'autoreg undo: hidden from /api/data')
await reverted('upsert_autoreg_rule redo', (autoUndo?.id ?? ''))
ok((await autoRules()).some((r) => r.id === auto.target_id), 'autoreg redo: applies again')

// upsert_goal: a new goal is retired; an edit is restored.
await approved('upsert_goal', { name: 'Broad Jump', metric: 'distance', unit: 'in', direction: 'higher', target: 100 })
const goalNew = await lastLog(A, 'upsert_goal')
const goalId = String(goalNew.target_id)
const goalsListed = async () => (JSON.parse(await call('get_goals', {})) as { goals: Array<{ id: string; target: number | null }> }).goals
const goalUndo = await reverted('upsert_goal (new)', goalNew.id)
ok(!(await goalsListed()).some((g) => g.id === goalId) && await count('athlete_goal', 'id::text = $1', [goalId]) === 1, 'new goal undo: retired, kept')
ok(!(await dataRows('athlete_goal')).some((g) => g.id === goalId), 'new goal undo: hidden from /api/data')
ok((await approved('upsert_goal', { name: 'Broad Jump', direction: 'higher', target: 90 }).catch((e: Error) => e.message)).includes('was undone'), 'upsert_goal: a retired goal name is not silently reused')
await reverted('upsert_goal (new) redo', (goalUndo?.id ?? ''))
ok((await goalsListed()).some((g) => g.id === goalId), 'new goal redo: back')
await approved('upsert_goal', { goal_id: goalId, name: 'Broad Jump', direction: 'higher', target: 104 })
const goalEdit = await lastLog(A, 'upsert_goal')
await reverted('upsert_goal (edit)', goalEdit.id)
ok(Number((await harness.query<{ t: string }>('SELECT target::text AS t FROM athlete_goal WHERE id = $1', [goalId]))[0].t) === 100, 'goal edit undo: target restored')

// log_goal_measurement: voided; the goal's numbers go back; redo logs it back.
await call('log_goal_measurement', { goal: 'Broad Jump', value: 96, date: '2026-11-03', confirm: true })
const meas = await lastLog(A, 'log_goal_measurement')
const goalNums = async () => (await harness.query<{ current: number | null; best: number | null }>('SELECT current::float8 AS current, best::float8 AS best FROM athlete_goal WHERE id = $1', [goalId]))[0]
ok((await goalNums()).current === 96 && meas.diff.goal_before != null, 'measurement: logged, with the goal before it')
const history = async () => (JSON.parse(await call('get_goal_history', { goal: goalId })) as { measurements: unknown[] }).measurements.length
const measUndo = await reverted('log_goal_measurement', meas.id)
ok((await goalNums()).current == null && await history() === 0 && await count('goal_measurement', 'id::text = $1', [String(meas.target_id)]) === 1, 'measurement undo: voided (kept), goal numbers back')
ok(!(await dataRows('goal_measurement')).some((m) => m.id === meas.target_id), 'measurement undo: hidden from /api/data')
await reverted('log_goal_measurement redo', (measUndo?.id ?? ''))
ok((await goalNums()).current === 96 && await history() === 1, 'measurement redo: counted again')

// add_workout_note: voided; redo shows it.
await call('add_workout_note', { session_name: 'A day', text: 'Felt quick.', confirm: true })
const noteRow = await lastLog(A, 'add_workout_note')
const noteUndo = await reverted('add_workout_note', noteRow.id)
ok(!(await dataRows('workout_note')).some((n) => n.id === noteRow.target_id) && await count('workout_note', 'id::text = $1', [String(noteRow.target_id)]) === 1, 'note undo: voided, kept')
await reverted('add_workout_note redo', (noteUndo?.id ?? ''))
ok((await dataRows('workout_note')).some((n) => n.id === noteRow.target_id), 'note redo: shown again')

// update_athlete_target, update_program_meta, set_training_max: restore and redo.
await approved('update_athlete_target', { text: 'Jump farther' })
const tgtUndo = await reverted('update_athlete_target', (await lastLog(A, 'update_athlete_target')).id)
ok((await harness.query<{ goals: string }>('SELECT goals FROM athlete WHERE id = $1', [A]))[0].goals === 'A only goal', 'target undo: restored')
await reverted('update_athlete_target redo', (tgtUndo?.id ?? ''))
ok((await harness.query<{ goals: string }>('SELECT goals FROM athlete WHERE id = $1', [A]))[0].goals === 'Jump farther', 'target redo: re-applied')
await approved('update_program_meta', { set_phase: 'build', deload_week_start: '2026-11-23' })
await reverted('update_program_meta', (await lastLog(A, 'update_program_meta')).id)
ok((await harness.query<{ d: string | null }>('SELECT deload_week_start::text AS d FROM program WHERE id = $1', [PROG_A]))[0].d == null, 'block details undo: restored')
const pTm = await call('set_training_max', { lift: 'squat', training_max: 300 })
await call('set_training_max', { lift: 'squat', training_max: 300, confirm: true, preview_id: kept(pTm), approval_ref: await yes(kept(pTm)) })
const tmUndo = await reverted('set_training_max', (await lastLog(A, 'set_training_max')).id)
const tmo = async () => (await harness.query<{ o: Record<string, unknown> | null }>('SELECT training_max_overrides AS o FROM athlete WHERE id = $1', [A]))[0].o ?? {}
ok(!('squat' in await tmo()), 'TM undo: back to auto')
await reverted('set_training_max redo', (tmUndo?.id ?? ''))
ok(((await tmo()).squat as { value?: number })?.value === 300, 'TM redo: 300 again')

// apply_program_edits: now (incl. an added session, taken out of the week, kept) and next week (block skipped, date back).
const edit = { edits: [{ type: 'update_exercise', session_name: 'Upper', exercise_name: 'Bench Press', sets: 5, rationale: 'All sets at or under RPE 7 (U5).' }] }
const upperBefore = await exercisesOf(UPPER)
const pEdit = await call('preview_program_edits', edit)
await call('apply_program_edits', { ...edit, confirm: true, preview_id: kept(pEdit), approval_ref: await yes(kept(pEdit)) })
const editUndo = await reverted('apply_program_edits', (await lastLog(A, 'apply_program_edits')).id)
ok(await exercisesOf(UPPER) === upperBefore, 'program edit undo: the session is exactly as before')
await reverted('apply_program_edits redo', (editUndo?.id ?? ''))
ok(await exercisesOf(UPPER) !== upperBefore, 'program edit redo: the edit is back')
const addSession = { edits: [{ type: 'add_session', session_name: 'Conditioning', exercises: [{ name: 'Bike', sets: 1, reps: '20 min' }] }] }
const pAdd = await call('preview_program_edits', addSession)
await call('apply_program_edits', { ...addSession, confirm: true, preview_id: kept(pAdd), approval_ref: await yes(kept(pAdd)) })
const added = await lastLog(A, 'apply_program_edits')
const addedId = String((added.diff.added as Array<{ id: string }>)[0]?.id)
const addUndo = await reverted('apply_program_edits (add_session)', added.id)
ok(await count('routine', 'id::text = $1 AND phase_id IS NULL', [addedId]) === 1, 'added session undo: out of the week, kept')
await reverted('apply_program_edits (add_session) redo', (addUndo?.id ?? ''))
ok(await count('routine', 'id::text = $1 AND phase_id = $2', [addedId, PHASE_A]) === 1, 'added session redo: back in the week')
const weekEnd = async () => (await harness.query<{ e: string }>('SELECT week_end::text AS e FROM phase WHERE id = $1', [PHASE_A]))[0].e
const endBefore = await weekEnd()
const nextEdit = { edits: [{ type: 'update_exercise', session_name: 'A day', exercise_name: 'Back Squat', reps: '3' }], timing: 'next_week' }
const pNext = await call('preview_program_edits', { edits: nextEdit.edits })
const nextText = await call('apply_program_edits', { ...nextEdit, confirm: true, preview_id: kept(pNext), approval_ref: await yes(kept(pNext)) })
ok(nextText.startsWith('Queued for'), `next-week edit: queued (${nextText.slice(0, 60)})`)
const queued = await lastLog(A, 'apply_program_edits')
const queuedPhase = String((queued.diff.queued as { phase_id?: string })?.phase_id)
ok(await weekEnd() !== endBefore && await count('phase', `id::text = $1 AND status = 'pending'`, [queuedPhase]) === 1, 'next-week edit: this week ends Sunday, next week queued')
const queuedUndo = await reverted('apply_program_edits (next week)', queued.id)
ok(await weekEnd() === endBefore && await count('phase', `id::text = $1 AND status = 'skipped'`, [queuedPhase]) === 1, 'next-week undo: block skipped (kept), this week\'s end date back')
await reverted('apply_program_edits (next week) redo', (queuedUndo?.id ?? ''))
ok(await weekEnd() !== endBefore && await count('phase', `id::text = $1 AND status = 'pending'`, [queuedPhase]) === 1, 'next-week redo: queued again')
await reverted('apply_program_edits (next week) undo again', (await lastLog(A, 'revert_change')).id)

// assign_exercise_to_track and accept_proposal: restored.
await approved('assign_exercise_to_track', { assignments: [{ session_name: 'Upper', exercise_name: 'Plank', track: 'Sprint' }] })
const upperAssigned = await exercisesOf(UPPER)
await reverted('assign_exercise_to_track', (await lastLog(A, 'assign_exercise_to_track')).id)
ok(await exercisesOf(UPPER) !== upperAssigned && !(await exercisesOf(UPPER)).includes(sprintId), 'assignment undo: the exercise is off the track again')
await call('preview_program_edits', { propose: true, title: 'Add face pulls.', edits: [{ type: 'add_exercise', session_name: 'Upper', exercise_name: 'Face Pull', sets: 2, reps: '15', load: 'light' }] })
const [prop] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [A])
const upperPre = await exercisesOf(UPPER)
ok((await approveAndAccept(storeA, prop.id)).ok, 'proposal: accepted')
await reverted('accept_proposal', (await lastLog(A, 'accept_proposal')).id)
ok(await exercisesOf(UPPER) === upperPre, 'proposal undo: the session is as before it')

// app_editor: the athlete's own in-app edit (the app writes routines, then the revision).
const aDay = await exercisesOf(ROUTINE_A)
const aDayEx = JSON.parse(aDay) as Array<Record<string, unknown>>
// The app's snapshot is the whole week as it loaded it.
const week = await harness.query<{ name: string; intent: string | null; session_type: string | null; intended_dow: number | null; exercises: unknown }>(
  'SELECT name, intent, session_type, intended_dow, exercises FROM routine WHERE phase_id = $1 ORDER BY name', [PHASE_A],
)
const edited = aDayEx.map((e) => (e.name === 'Back Squat' ? { ...e, sets: 4 } : e))
await executeDataQuery(sql, { userId: USER_A, athleteId: A }, { table: 'routine', op: 'update', values: { exercises: edited }, filters: [{ column: 'id', op: 'eq', value: ROUTINE_A }] })
const today = await athleteToday(storeA)
await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'program_revision', op: 'insert', returning: 'id',
  values: {
    program_id: PROG_A, phase_id: PHASE_A, trigger: 'editor', effective_on: today, requests: [],
    snapshot: week,
    diff: { added: 0, removed: 0, changed: 1, new_sessions: 0, sessions: [{ name: 'A day', changes: [{ kind: 'changed', name: 'Back Squat', before: { sets: 3 }, after: { sets: 4 } }] }] },
    summary: '1 retuned',
  },
})
const appRow = await lastLog(A, 'app_editor')
ok(Array.isArray(appRow.diff.before) && (appRow.diff.before as unknown[]).length === 1 && !appRow.diff.unmatched, 'app_editor: the row records the session before and after')
const appUndo = await reverted('app_editor', appRow.id)
ok(await exercisesOf(ROUTINE_A) === aDay, 'app_editor undo: the session is as before the edit')
await reverted('app_editor redo', (appUndo?.id ?? ''))
ok(await exercisesOf(ROUTINE_A) === JSON.stringify(edited), 'app_editor redo: the edit is back')

// apply_session_override / clear_session_override: voided; put back as copies.
const pOv = await call('preview_session_override', { date: addDays(today, 1), session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }], rationale: 'Short on time.' })
await call('apply_session_override', { preview_id: sop(pOv), confirm: true, approval_ref: await yes(sop(pOv)) })
const ov = await lastLog(A, 'apply_session_override')
const ovId = (ov.diff.override_ids as string[])[0]
const ovUndo = await reverted('apply_session_override', ov.id)
ok(await count('session_override', 'id::text = $1 AND voided_at IS NOT NULL', [ovId]) === 1, 'override undo: voided (kept)')
const ovRedo = await reverted('apply_session_override redo', (ovUndo?.id ?? ''))
const copyId = (ovRedo?.diff.override_ids as string[] | undefined)?.[0] ?? ''
ok(copyId !== ovId && await count('session_override', 'id::text = $1 AND voided_at IS NULL', [copyId]) === 1, 'override redo: a live copy, the voided row untouched')
const pClr = await call('preview_clear_session_override', { override_id: copyId })
await call('apply_session_override', { preview_id: sop(pClr), confirm: true, approval_ref: await yes(sop(pClr)) })
const clr = await lastLog(A, 'clear_session_override')
const clrUndo = await reverted('clear_session_override', clr.id)
const back = (clrUndo?.diff.override_ids as string[] | undefined)?.[0] ?? ''
ok(await count('session_override', 'id::text = $1 AND voided_at IS NULL', [back]) === 1, 'clear undo: the week-only change is back')
await reverted('clear_session_override redo', (clrUndo?.id ?? ''))
ok(await count('session_override', 'id::text = $1 AND voided_at IS NOT NULL', [back]) === 1, 'clear redo: cleared again')

// apply_methodology_override: back to the value before; redo re-applies.
const pM = await call('preview_methodology_override', { path: 'U4.tm_fraction', value: 0.85, rationale: 'Lighter TM (U4).' })
await call('apply_methodology_override', { preview_id: kept(pM), confirm: true, approval_ref: await yes(kept(pM)) })
const mRow = await lastLog(A, 'apply_methodology_override')
const tmFraction = async () => (await resolveMethodology(storeA)).params.U4.tm_fraction
const mUndo = await reverted('apply_methodology_override', mRow.id)
ok(await tmFraction() === 0.9, 'override undo: the default again')
await reverted('apply_methodology_override redo', (mUndo?.id ?? ''))
ok(await tmFraction() === 0.85, 'override redo: 0.85 again')

// ---- 4. safety ---------------------------------------------------------------------------------

// Under-18 rules only tighten: undoing a tightening is refused, for anyone.
const pMin = await call('preview_methodology_override', { path: 'minors.max_rpe', value: 7.5 })
await call('apply_methodology_override', { preview_id: kept(pMin), confirm: true, approval_ref: await yes(kept(pMin)) })
const minRow = await lastLog(A, 'apply_methodology_override')
const minUndo = await tapRevert(minRow.id)
ok(!minUndo.ok && minUndo.reason === 'not_revertible' && /tightened, never loosened/.test(minUndo.text), `safety: undoing a minors tightening is refused (${minUndo.text})`)
ok((await resolveMethodology(storeA)).minors.max_rpe === 7.5, 'safety: the minors rule stays tightened')

// A red flag set in the rules: undoing it would unblock → refused. The athlete's clear, undone → flagged again.
const pFlag = await call('preview_methodology_override', { path: 'U7.regions.shoulder.blocked', value: true, rationale: 'Swelling reported (U7).' })
await call('apply_methodology_override', { preview_id: kept(pFlag), confirm: true, approval_ref: await yes(kept(pFlag)) })
const flagRow = await lastLog(A, 'apply_methodology_override')
const flagUndo = await tapRevert(flagRow.id)
ok(!flagUndo.ok && /red flag/.test(flagUndo.text), `safety: undoing a red flag is refused (${flagUndo.text})`)
const blockedRules = async () => blockedRegions(await resolveMethodology(storeA))
ok((await blockedRules()).includes('shoulder'), 'safety: the shoulder stays blocked')
ok((await clearRedFlag(storeA, me, 'shoulder')).ok && !(await blockedRules()).includes('shoulder'), 'clear_red_flag: the athlete clears it')
const flagClear = await lastLog(A, 'clear_red_flag')
const reflag = await reverted('clear_red_flag', flagClear.id)
ok((await blockedRules()).includes('shoulder') && reflag?.diff.reflagged === true, 'clear_red_flag undo: flagged again (blocked)')
const reflagRedo = await tapRevert((reflag?.id ?? ''))
ok(!reflagRedo.ok && /clinician/.test(reflagRedo.text) && (await blockedRules()).includes('shoulder'), 'safety: redoing a red-flag clear is refused; still blocked')

// A check-in that blocked a region: undoing the check-in voids it, and the block stays.
// v1.2: the red flag makes it a persistent block (7/10 alone lapses after the next session).
const knee = await saveCheckin(storeA, me, { sleep_hours: 5, stress: 4, pain: [{ region: 'knee', score: 7, red_flags: ['swelling'] }] })
ok(knee.ok, 'log_checkin: knee 7/10 with swelling blocks the knee')
const kneeBlocked = async () => blocksNow((await loadRegionStatus(storeA)).find((s) => s.region === 'knee'))
ok(await kneeBlocked(), 'log_checkin: knee blocked')
const ck = await lastLog(A, 'log_checkin')
const ckUndo = await reverted('log_checkin', ck.id)
ok((await loadCheckins(storeA, addDays(today, -6), today)).length === 0 && (await loadPain(storeA, addDays(today, -6), today)).length === 0, 'check-in undo: voided, readiness no longer counts it')
ok(await count('checkin', 'athlete_id = $1', [A]) === 1 && await count('pain_report', 'athlete_id = $1', [A]) === 1, 'check-in undo: nothing deleted (append-only)')
ok(await kneeBlocked(), 'safety: voiding the check-in never unblocks the knee')
await reverted('log_checkin redo', (ckUndo?.id ?? ''))
ok((await loadCheckins(storeA, addDays(today, -6), today)).length === 1, 'check-in redo: counted again')

// clear_region: undone → blocked again; redoing the clear refused.
ok((await clearRegion(storeA, me, 'knee')).ok && !(await kneeBlocked()), 'clear_region: the athlete clears the knee')
const clearRow = await lastLog(A, 'clear_region')
const reblock = await reverted('clear_region', clearRow.id)
ok(await kneeBlocked(), 'clear_region undo: blocked again')
const reblockRedo = await tapRevert((reblock?.id ?? ''))
ok(!reblockRedo.ok && /clinician/.test(reblockRedo.text) && await kneeBlocked(), 'safety: redoing a clinician clear is refused; still blocked')
// A program edit made before the block: undoing it would put the squat back on a blocked knee → refused.
await harness.query(`UPDATE routine SET exercises = exercises || '[{"name":"Hip Thrust","sets":3,"reps":"8","load":"moderate"}]'::jsonb WHERE id = $1`, [ROUTINE_A])
const dropSquat = { edits: [{ type: 'remove_exercise', session_name: 'A day', exercise_name: 'Back Squat' }] }
const pDrop = await call('preview_program_edits', dropSquat)
await call('apply_program_edits', { ...dropSquat, confirm: true, preview_id: kept(pDrop), approval_ref: await yes(kept(pDrop)) })
const dropRow = await lastLog(A, 'apply_program_edits')
const aDayDropped = await exercisesOf(ROUTINE_A)
ok(!aDayDropped.includes('Back Squat'), 'program edit: the squat is out')
const dropUndo = await tapRevert(dropRow.id)
ok(!dropUndo.ok && dropUndo.reason === 'not_revertible' && /blocked/.test(dropUndo.text) && await exercisesOf(ROUTINE_A) === aDayDropped, `safety: an undo never puts work back on a blocked region (${dropUndo.text.slice(0, 80)})`)
const feedNow = (await listChanges(storeA, { limit: 100 }))!.changes
ok(feedNow.find((c) => c.id === (reblock?.id ?? ''))?.revertible === false, 'feed: a re-block shows no Revert')

// log_session_rpe: a first rating is voided; a second goes back to the first; redo re-applies.
const rpe1 = await logSessionRpe(storeA, me, { session_id: ROUTINE_A, rating: 6 })
ok(rpe1.ok, 'log_session_rpe: logged')
const rpeRow1 = await lastLog(A, 'log_session_rpe')
const rpe1Undo = await reverted('log_session_rpe (first)', rpeRow1.id)
ok((await loadSessionRpe(storeA, today, today)).length === 0 && await count('session_rpe', 'athlete_id = $1', [A]) === 1, 'session RPE undo: voided (kept)')
await reverted('log_session_rpe (first) redo', (rpe1Undo?.id ?? ''))
ok((await loadSessionRpe(storeA, today, today))[0]?.rating === 6, 'session RPE redo: 6 again')
await logSessionRpe(storeA, me, { session_id: ROUTINE_A, rating: 8 })
const rpeRow2 = await lastLog(A, 'log_session_rpe')
const rpe2Undo = await reverted('log_session_rpe (second)', rpeRow2.id)
ok((await loadSessionRpe(storeA, today, today))[0]?.rating === 6, 'session RPE undo: back to the rating before')
await reverted('log_session_rpe (second) redo', (rpe2Undo?.id ?? ''))
ok((await loadSessionRpe(storeA, today, today))[0]?.rating === 8, 'session RPE redo: 8 again')

// A rating undone, then tapped again: the new tap can be undone in turn.
await logSessionRpe(storeA, me, { session_id: UPPER, rating: 5 })
await reverted('log_session_rpe (upper)', (await lastLog(A, 'log_session_rpe')).id)
ok(!(await loadSessionRpe(storeA, today, today)).some((r) => r.session_id === UPPER), 'session RPE: the undone rating is hidden')
await logSessionRpe(storeA, me, { session_id: UPPER, rating: 7 })
ok((await loadSessionRpe(storeA, today, today)).find((r) => r.session_id === UPPER)?.rating === 7, 'session RPE: a new tap revives the row')
await reverted('log_session_rpe (revived)', (await lastLog(A, 'log_session_rpe')).id)
ok(!(await loadSessionRpe(storeA, today, today)).some((r) => r.session_id === UPPER), 'session RPE: the revived tap undoes too')

// set_coach_role / set_coach_health_access: back to what they were.
const roleOf = async () => (await harness.query<{ role: string }>('SELECT role FROM mcp_token WHERE id = $1', [TOKEN_ROLE_ID]))[0].role
ok((await setCoachRole(storeA, me, TOKEN_ROLE_ID, 'read')).ok && await roleOf() === 'read', 'set_coach_role: read')
const roleUndo = await reverted('set_coach_role', (await lastLog(A, 'set_coach_role')).id)
ok(await roleOf() === 'propose', 'role undo: propose again')
await reverted('set_coach_role redo', (roleUndo?.id ?? ''))
ok(await roleOf() === 'read', 'role redo: read again')
const healthOf = async () => (await harness.query<{ s: boolean }>('SELECT share_health AS s FROM mcp_token WHERE id = $1', [TOKEN_ROLE_ID]))[0].s
ok((await setCoachHealth(storeA, me, TOKEN_ROLE_ID, false)).ok && !(await healthOf()), 'set_coach_health_access: off')
await reverted('set_coach_health_access', (await lastLog(A, 'set_coach_health_access')).id)
ok(await healthOf(), 'health access undo: on again')

// revoke_coach / void_preview: defined as never reverted.
await executeDataQuery(sql, { userId: USER_A, athleteId: A }, { table: 'mcp_token', op: 'update', values: { revoked_at: new Date().toISOString() }, filters: [{ column: 'id', op: 'eq', value: TOKEN_ROLE_ID }] })
const revoke = await lastLog(A, 'revoke_coach')
const revokeUndo = await tapRevert(revoke.id)
ok(!revokeUndo.ok && revokeUndo.reason === 'not_revertible' && /never given back/.test(revokeUndo.text), 'revoke_coach: access is never given back by an undo')
ok((await listChanges(storeA, { limit: 200 }))!.changes.find((c) => c.id === revoke.id)?.revertible === false, 'feed: no Revert on a revocation')
exercised.add('revoke_coach')
const healthUndoRole = await tapRevert((await lastLog(A, 'set_coach_role')).id)
ok(!healthUndoRole.ok, 'coach access: a revoked coach\'s role is not changed back')

// ---- coach_v1: activities, composed blocks, birth date --------------------------------------
await flags(A, { coach: true })
await harness.query(`INSERT INTO athlete_goal (athlete_id, name, metric, unit, direction, target, due_date, test_protocol) VALUES ($1, 'Back Squat 1RM', 'Back Squat', 'lb', 'higher', 315, CURRENT_DATE + 120, 'Back Squat 1RM')`, [A])
const pAct = await call('preview_activity_change', { op: 'add', module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'in', days: [3] })
await call('apply_activity_change', { preview_id: kept(pAct), confirm: true, approval_ref: await yes(kept(pAct)) })
const act = await lastLog(A, 'apply_activity_change')
const actUndo = await reverted('apply_activity_change', act.id)
ok(await count('activity', 'id::text = $1 AND NOT active', [String(act.target_id)]) === 1, 'activity undo: inactive, kept')
await reverted('apply_activity_change redo', (actUndo?.id ?? ''))
ok(await count('activity', 'id::text = $1 AND active', [String(act.target_id)]) === 1, 'activity redo: active again')
const pBlock = await call('preview_composed_block', { goal_weights: [{ goal: 'Back Squat 1RM', weight: 'priority' }], schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] }, training_age: '3to10' })
const blockText = await call('apply_composed_block', { preview_id: kept(pBlock), confirm: true, approval_ref: await yes(kept(pBlock)) })
ok(blockText.startsWith('Applied the composed block'), `composed block: applied (${blockText.slice(0, 60)})`)
const block = await lastLog(A, 'apply_composed_block')
const createdTracks = (block.diff.tracks as Array<{ track_id: string; created: boolean; rule_id: string }>)
ok(block.diff.ended_rule_ends != null, 'composed block: records each ended rule\'s end, for its revert')
const blockUndo = await reverted('apply_composed_block', block.id)
ok(await count('composed_block', 'athlete_id = $1 AND superseded_at IS NULL', [A]) === 0, 'block undo: no block of record (there was none before)')
const listedAfter = await tracksListed()
ok(createdTracks.filter((t) => t.created).every((t) => !listedAfter.some((x) => x.id === t.track_id)), 'block undo: tracks it created are retired')
ok(await count('progression_rule', `id::text = ANY($1::text[]) AND active_to IS NOT NULL`, [`{${createdTracks.map((t) => t.rule_id).join(',')}}`]) === createdTracks.length, 'block undo: its rules ended')
ok((await harness.query<{ d: string | null }>('SELECT deload_week_start::text AS d FROM program WHERE id = $1', [PROG_A]))[0].d == null, 'block undo: block dates back')
const blockRedo = await tapRevert((blockUndo?.id ?? ''))
ok(!blockRedo.ok && /re-compose/.test(blockRedo.text), 'composed block: redo refused (re-compose on the current methodology instead)')
// Re-composing after the undo brings back the goals and tracks it retired, under their names.
const pBlock2 = await call('preview_composed_block', { goal_weights: [{ goal: 'Back Squat 1RM', weight: 'priority' }], schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] }, training_age: '3to10' })
const block2Text = await call('apply_composed_block', { preview_id: kept(pBlock2), confirm: true, approval_ref: await yes(kept(pBlock2)) })
ok(block2Text.startsWith('Applied the composed block'), `composed block: re-composed after its undo (${block2Text.slice(0, 80)})`)
const block2 = await lastLog(A, 'apply_composed_block')
const unretired = (block2.diff.goals_unretired as string[] | undefined) ?? []
ok(unretired.length > 0 && (block2.diff.tracks as Array<{ unretired?: boolean }>).some((t) => t.unretired), 'composed block: the retired screen goals and tracks come back, recorded')
ok((await goalsListed()).some((g) => unretired.includes(g.id)), 'composed block: those goals read again')
await reverted('apply_composed_block (again)', block2.id)
ok(!(await goalsListed()).some((g) => unretired.includes(g.id)), 'composed block undo: retired again')

// Birth date (intake): an adult's goes back to not on file; a minor's can't (it would loosen).
await flags(C, { tracks: true, coach: true })
await flags(K, { tracks: true, coach: true })
const answers = (over: Record<string, unknown> = {}) => ({
  birth_date: '1992-03-04',
  goals: [{ name: 'Row 2k under 7:00', test: '2k row', current: 440, target: 420, unit: 's', direction: 'lower', due_date: addDaysIso(today, 90), weight: 'priority', quality: 'aerobic' }],
  activities: [],
  schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [6], equipment: ['rower'] },
  training_age: '1to3',
  injuries: { history: [], pain: [] },
  screens: [],
  recovery: { sleep_hours: 7, stress: 2, soreness: 2 },
  ...over,
})
await athleteCoachAction(storeC, { action: 'intake', answers: answers() }, { model: null })
const dob = await lastLog(C, 'set_birth_date')
ok(dob?.tool === 'set_birth_date', 'set_birth_date: recorded at intake')
const dobUndo = await reverted('set_birth_date', dob.id, storeC)
ok(await count('athlete', 'id = $1 AND birth_date IS NULL', [C]) === 1, 'birth date undo (adult): not on file')
await reverted('set_birth_date redo', (dobUndo?.id ?? ''), storeC)
ok(await count('athlete', `id = $1 AND birth_date = '1992-03-04'`, [C]) === 1, 'birth date redo: recorded again')
await athleteCoachAction(storeK, { action: 'intake', answers: answers({ birth_date: addDaysIso(today, -15 * 365), parental_consent: { guardian_name: 'Sample Guardian', confirmed: true } }) }, { model: null })
const kidDob = await lastLog(K, 'set_birth_date')
const kidUndo = await tapRevert(kidDob.id, storeK)
ok(!kidUndo.ok && /under 18/.test(kidUndo.text) && await count('athlete', 'id = $1 AND birth_date IS NOT NULL', [K]) === 1, 'safety: a minor\'s birth date is never undone (it would loosen their rules)')

// ---- 3. conflicts --------------------------------------------------------------------------------
await approved('update_track', { track: 'Sprint', set_purpose: 'first' })
const c1 = await lastLog(A, 'update_track')
await approved('update_track', { track: 'Sprint', set_purpose: 'second' })
const c2 = await lastLog(A, 'update_track')
const conflicted = await previewOf(c1.id)
ok(!conflicted.ok && conflicted.reason === 'stale' && conflicted.conflicts?.length === 1 && conflicted.conflicts[0].id === c2.id, 'conflict: the preview names the newer change to the same target')
const coachConflict = await call('preview_revert_change', { change_id: c1.id })
ok(/newer change/.test(coachConflict) && /Undo that first/.test(coachConflict), 'conflict: a coach\'s preview shows it too')
ok(!(await revertWith(c1.id)).ok, 'conflict: the revert is refused')
const fresh = await previewOf(c2.id)
ok(fresh.ok, 'conflict: the newest change previews')
await harness.query(`UPDATE track SET purpose = 'moved elsewhere' WHERE id = $1`, [sprintId])
const moved = await revertWith(c2.id, fresh.preview_id)
ok(!moved.ok && moved.reason === 'stale', 'conflict: the target moved since the preview → refused, preview again')
await harness.query(`UPDATE track SET purpose = 'second' WHERE id = $1`, [sprintId])
ok((await revertWith(c2.id, fresh.preview_id)).ok, 'conflict: once it matches the preview again, the tap applies it')
ok((await tapRevert(c1.id)).ok, 'conflict: with the newer change undone, the older one reverts')
const spent = await revertWith(c2.id, fresh.preview_id)
ok(!spent.ok, 'conflict: a preview applies once')
// A coach suggestion vs the athlete's own preview.
await approved('update_track', { track: 'Sprint', set_purpose: 'third' })
const c3 = await lastLog(A, 'update_track')
await previewOf(c3.id)
ok((await listChanges(storeA, { limit: 5 }))!.changes.find((c) => c.id === c3.id)?.revert_suggested === false, 'feed: the athlete\'s own preview is not a coach suggestion')
await call('preview_revert_change', { change_id: c3.id, rationale: 'Keep it simple.' })
ok((await listChanges(storeA, { limit: 5 }))!.changes.find((c) => c.id === c3.id)?.revert_suggested === true, 'feed: a coach\'s preview is')
ok((await revertChange(storeA, coachA, c3.id)).text.includes('only the athlete'), 'only the athlete applies a revert')

// Health rows: a coach without the health toggle can't preview reverting one.
await harness.query('UPDATE mcp_token SET share_health = false WHERE id = $1', [TOKEN_A_ID])
const healthHidden = await call('preview_revert_change', { change_id: ck.id })
ok(/health data/.test(healthHidden) && !/knee/.test(healthHidden), 'privacy: no revert preview of a health row for a coach without health access')
await harness.query('UPDATE mcp_token SET share_health = true WHERE id = $1', [TOKEN_A_ID])

// ---- feed --------------------------------------------------------------------------------------
const feed = (await athleteChangeLogAction(storeA, { action: 'list', limit: 100 }))[0] as { changes: ChangeView[] }
ok(feed.changes.every((c) => (c.revertible ? c.revert_action != null : c.revert_action == null)), 'feed: revertible rows say undo or redo')
ok(feed.changes.some((c) => c.revert_action === 'redo'), 'feed: an undo row offers Redo')

// ---- every type covered, in code and in the database ---------------------------------------
const tools = (await harness.query<{ tool: string }>('SELECT DISTINCT tool FROM change_log')).map((r) => r.tool)
ok(tools.every((t) => REVERT_HANDLERS[t]), `db: every change type written has a handler (${tools.filter((t) => !REVERT_HANDLERS[t]).join(', ')})`)
const forward = Object.keys(REVERT_HANDLERS).filter((t) => t !== 'revert_change' && t !== 'void_preview')
const uncovered = forward.filter((t) => !exercised.has(t))
ok(uncovered.length === 0, `per-type: every type was reverted here (missing: ${uncovered.join(', ')})`)

// ---- 6. isolation --------------------------------------------------------------------------------
const bTracks = await tracksListed(B, coachB)
ok((await hiddenIds(storeB, 'track')).length === 0, 'isolation: A\'s tombstones hide nothing of B\'s')
ok(JSON.stringify(await tracksListed(B, coachB)) === JSON.stringify(bTracks), 'isolation: B reads exactly its own tracks')
const bOnA = await previewOf(c3.id, storeB)
ok(!bOnA.ok && bOnA.reason === 'not_found', 'isolation: B cannot preview reverting A\'s change')
ok((await revertWith(c3.id, undefined, storeB)).reason === 'not_found', 'isolation: B cannot revert A\'s change')
ok((await call('preview_revert_change', { change_id: c3.id }, coachB, B)).includes('No such change'), 'isolation: B\'s coach cannot either')
await approved('create_track', { name: 'B Sprint' }, coachB, B)
const bCreate = await lastLog(B, 'create_track')
ok(!(await revertWith(bCreate.id)).ok, 'isolation: A cannot revert B\'s change')
const aRevertsBefore = await count('change_log', `athlete_id = $1 AND tool = 'revert_change'`, [A])
ok((await tapRevert(bCreate.id, storeB)).ok && await count('change_log', `athlete_id = $1 AND tool = 'revert_change'`, [A]) === aRevertsBefore, 'isolation: B\'s revert logs only under B')
ok((await tracksListed()).some((t) => t.name === 'Sprint'), 'isolation: B\'s retire hides nothing of A\'s')
ok(await count('change_tombstone', 'athlete_id = $1', [B]) === 1 && (await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM change_tombstone t WHERE t.athlete_id = $1 AND t.row_table = 'track' AND NOT EXISTS (SELECT 1 FROM track x JOIN program p ON p.id = x.program_id WHERE x.id = t.row_id AND p.athlete_id = $1)`, [A]))[0].n === '0', 'isolation: every tombstone names its own athlete\'s row')

// ---- append-only ---------------------------------------------------------------------------------
let blocked = 0
for (const q of [`UPDATE change_tombstone SET row_id = gen_random_uuid() WHERE athlete_id = '${A}'`, `DELETE FROM change_tombstone WHERE athlete_id = '${A}'`]) {
  try { await harness.query(q) } catch { blocked++ }
}
ok(blocked === 2, 'append-only: a tombstone is never edited or deleted (only lifted, once)')

// ---- 5b. rollback: flag off -------------------------------------------------------------------
const retiredBlockTrack = createdTracks.find((t) => t.created)!.track_id
await flags(A, { tracks: false, coach: false })
ok((await tracksListed()).some((t) => t.id === retiredBlockTrack), 'rollback: with the flag off, a retired track reads as it did before')
ok((await dataRows('track')).some((t) => t.id === retiredBlockTrack), 'rollback: /api/data too')
ok((await athleteChangeLogAction(storeA, { action: 'preview_revert', id: c3.id }))[1] === 404, 'rollback: the revert route reads as absent')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'rollback: tool list is exactly ZEROED_TOOLS')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`reverts: ok (${harness.backend})`)
