// change_log (G2) against a real schema: flag off writes no rows and lists no
// new tools; flag on, every covered write path logs exactly one row with the
// right actor and approval; a non-logging write without approval_ref (or a
// fresh, matching preview) is refused; undo restores state, links both rows,
// refuses stale targets and double undo; only the athlete undoes; revoking a
// coach voids its previews at once; athlete isolation everywhere.
// Synthetic athletes A and B from isolation-seed.sql.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/changeLog.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'
import {
  CHANGE_LOG_TOOLS, listChanges, revertChange, type ChangeView,
} from './changeLog.ts'
import { athleteChangeLogAction } from './changeLogRoute.ts'
import { approveAndAccept } from './proposals.ts'
import { createApproval } from './approvals.ts'
import { APP_COACH, athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import { addDays } from '../../src/engine/sessionOverride.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PHASE_A = '55555555-5555-5555-5555-555555555555'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const UPPER = 'c0c0c0c0-0000-4000-8000-000000000001'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const TOKEN_LATE_ID = 'aaaa9999-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const me: OverrideActor = { type: 'athlete', id: A }
// A well-formed approval_ref that resolves to no approval row.
const NO_APPROVAL = 'msg:00000000-0000-4000-8000-000000000000'
/** The athlete taps Approve on a preview (G10): its approval_ref, or NO_APPROVAL if refused. */
async function yes(previewId: string, athlete = A): Promise<string> {
  const r = await createApproval(makeStore(sql, athlete), { type: 'athlete', id: athlete }, { preview_id: previewId })
  return r.ok ? r.approval_ref : NO_APPROVAL
}

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
await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'late-coach', 'hash-late', 'late')`,
  [TOKEN_LATE_ID, A],
)

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
const logCount = (athleteId = A) => count('change_log', 'athlete_id = $1', [athleteId])
type LogRow = { id: string; tool: string; actor_type: string; actor_id: string; approval_ref: string | null; preview_id: string | null; target_type: string; target_id: string | null; rule_refs: unknown; diff: Record<string, unknown>; reverted_by: string | null; revert_of: string | null }
const lastLog = async (athleteId = A) => (await harness.query<LogRow>(
  `SELECT id::text AS id, tool, actor_type, actor_id, approval_ref, preview_id, target_type, target_id, rule_refs, diff,
          reverted_by::text AS reverted_by, revert_of::text AS revert_of
   FROM change_log WHERE athlete_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [athleteId],
))[0]
const logById = async (id: string) => (await harness.query<LogRow>(
  `SELECT id::text AS id, tool, actor_type, actor_id, approval_ref, preview_id, target_type, target_id, rule_refs, diff,
          reverted_by::text AS reverted_by, revert_of::text AS revert_of FROM change_log WHERE id = $1`, [id],
))[0]
const exercisesOf = async (id: string) =>
  JSON.stringify((await harness.query<{ exercises: unknown }>('SELECT exercises FROM routine WHERE id = $1', [id]))[0].exercises)
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}

/** One write path: run it, and it must add exactly one change_log row. */
async function onePath(label: string, run: () => Promise<unknown>, athleteId = A): Promise<LogRow> {
  const before = await logCount(athleteId)
  await run()
  ok(await logCount(athleteId) === before + 1, `${label}: exactly one change_log row`)
  return lastLog(athleteId)
}
/** A previewed, approved coach write: preview (no confirm), then confirm with its preview_id. */
async function approved(name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> {
  const preview = await call(name, args, actor, athlete)
  return call(name, { ...args, confirm: true, preview_id: kept(preview), approval_ref: await yes(kept(preview), athlete) }, actor, athlete)
}
const appRevert = async (store: typeof storeA, id: string) =>
  (await athleteChangeLogAction(store, { action: 'revert', id }))[0] as { ok: boolean; reason?: string; text: string; change_id?: string }

// ---- flag OFF: nothing new, nothing written ----------------------------------------
ok((await zeroedToolsFor(sql, A)).map((t) => t.name).join() === ZEROED_TOOLS.map((t) => t.name).join(), 'flag off: tool list is exactly ZEROED_TOOLS')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: tool schemas are unchanged (no approval args)')
ok((await callErr('get_change_log', { since: '2026-01-01' })).includes('Unknown tool'), 'flag off: get_change_log is unknown')
ok((await callErr('preview_revert_change', { change_id: A })).includes('Unknown tool'), 'flag off: preview_revert_change is unknown')
ok((await athleteChangeLogAction(storeA, { action: 'list' }))[1] === 404, 'flag off: /api/change-log reads as absent')
const offTrack = await call('create_track', { name: 'Off Track', confirm: true })
ok(offTrack.includes('Off Track'), 'flag off: a confirmed track write needs no approval, as before')
const offPreview = await call('create_track', { name: 'Off Track 2' })
ok(!offPreview.includes('chp_') && /"preview_id": "[0-9a-f]{24}"/.test(offPreview), 'flag off: previews keep their deterministic id and store nothing')
const offEdit = await call('apply_program_edits', { confirm: true, edits: [{ type: 'update_exercise', session_name: 'Upper', exercise_name: 'Plank', reps: '40s' }] })
ok(offEdit.startsWith('Applied now'), 'flag off: apply_program_edits applies without approval, as before')
ok((await call('set_training_max', { lift: 'bench', training_max: 200, confirm: true })).includes('Saved.'), 'flag off: set_training_max saves, as before')
const offRev = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'program_revision', op: 'insert',
  values: { program_id: PROG_A, phase_id: PHASE_A, trigger: 'editor', effective_on: '2026-11-04', requests: [], snapshot: [], diff: {}, summary: 'off edit' },
})
ok(offRev.error == null && offRev.status === 201, 'flag off: the app editor still writes program_revision')
ok(await count('change_log') === 0 && await count('change_preview') === 0, 'flag off: no change_log or change_preview rows at all')
await harness.query(`UPDATE routine SET exercises = $1::jsonb WHERE id = $2`, [JSON.stringify(upperExercises), UPPER])
await harness.query(`UPDATE athlete SET training_max_overrides = '{}'::jsonb WHERE id = $1`, [A])

// ---- flag ON -----------------------------------------------------------------------
await flag(A, true)
const onTools = await zeroedToolsFor(sql, A)
ok(CHANGE_LOG_TOOLS.every((t) => onTools.some((o) => o.name === t.name)), 'flag on: get_change_log and preview_revert_change are listed')
const createSchema = onTools.find((t) => t.name === 'create_track')?.inputSchema as { properties: Record<string, unknown> }
ok('approval_ref' in createSchema.properties && 'preview_id' in createSchema.properties, 'flag on: write tools advertise approval_ref and preview_id')
ok(!('approval_ref' in ((onTools.find((t) => t.name === 'log_goal_measurement')?.inputSchema as { properties: Record<string, unknown> }).properties)), 'flag on: logging tools need no approval args')

// Refusals: a non-logging write without approval or a valid preview writes nothing.
const tracksBefore = await count('track', 'program_id = $1', [PROG_A])
const pTrack = await call('create_track', { name: 'Speed', purpose: 'sprints', rationale: 'Two priorities max (U2).' })
const pTrackId = kept(pTrack)
ok(pTrackId.startsWith('chp_'), 'flag on: a preview is kept and returns a chp_ preview_id')
const trackArgs = { name: 'Speed', purpose: 'sprints', rationale: 'Two priorities max (U2).', confirm: true }
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId })).includes('approval_ref is required'), 'refuse: no approval_ref')
ok((await callErr('create_track', { ...trackArgs, approval_ref: NO_APPROVAL })).includes('preview_id is required'), 'refuse: no preview_id')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'standing:logging' })).includes('logging only'), 'refuse: standing approval does not cover a track')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'tap:forged' })).includes('approval_ref must be'), 'refuse: a malformed tap')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'tap:aaaaaaaa-0000-4000-8000-000000000000' })).includes('no such approval'), 'refuse: a coach cannot forge a tap')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'msg:chat-1' })).includes('approval_ref must be'), 'refuse: a bare chat message id is not an approval')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'ok' })).startsWith('Refused'), 'refuse: free-form approval_ref')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'msg:chat-1' }, APP_COACH)).includes('app_coach cannot supply approval_ref'), 'refuse: app_coach never approves')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: 'msg:chat-1' }, APP_COACH)).includes('app_coach'), 'refuse: an unnamed caller gets app_coach powers')
ok((await callErr('create_track', { ...trackArgs, name: 'Power', preview_id: pTrackId, approval_ref: NO_APPROVAL })).includes('no longer matches'), 'refuse: the confirmed request must match the preview')
const pRule = await call('upsert_autoreg_rule', { signal: 'sleep_hours', op: '<', value: 6, action: 'trim_accessories', message: 'Short sleep trims accessories.' })
ok((await callErr('create_track', { ...trackArgs, preview_id: kept(pRule), approval_ref: NO_APPROVAL })).includes('no create_track preview'), 'refuse: another tool\'s preview')
const pOld = await call('create_track', { name: 'Old', purpose: 'x' })
await harness.query(`UPDATE change_preview SET created_at = NOW() - INTERVAL '25 hours' WHERE preview_id = $1`, [kept(pOld)])
ok((await callErr('create_track', { name: 'Old', purpose: 'x', confirm: true, preview_id: kept(pOld), approval_ref: NO_APPROVAL })).includes('more than 24 h old'), 'refuse: a preview over 24 h old')
ok(await count('track', 'program_id = $1', [PROG_A]) === tracksBefore && await logCount() === 0, 'refuse: every refusal wrote nothing and logged nothing')

// ---- each covered path: exactly one row, right actor and approval ------------------
const refTrack = await yes(pTrackId)
const created = await onePath('create_track', () => call('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: refTrack }))
ok(created.tool === 'create_track' && created.actor_type === 'mcp' && created.actor_id === TOKEN_A_ID, 'create_track: actor is the coach token')
ok(created.approval_ref === refTrack && created.preview_id === pTrackId, 'create_track: approval and preview recorded')
ok(JSON.stringify(created.rule_refs) === '["U2"]', 'create_track: rule_refs read from the rationale')
ok((await callErr('create_track', { ...trackArgs, preview_id: pTrackId, approval_ref: refTrack })).includes('already applied'), 'a preview applies once')
const [speed] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM track WHERE program_id = $1 AND name = 'Speed'`, [PROG_A])

const upd1 = await onePath('update_track', () => approved('update_track', { track: 'Speed', set_purpose: 'acceleration', rationale: 'U14 contacts' }))
ok(upd1.target_type === 'track' && upd1.target_id === speed.id, 'update_track: target is the track')
// A preview whose target moved since no longer matches.
const pUpd = await call('update_track', { track: 'Speed', set_color: '#FF0000' })
await harness.query(`UPDATE track SET methodology_text = 'changed elsewhere' WHERE id = $1`, [speed.id])
ok((await callErr('update_track', { track: 'Speed', set_color: '#FF0000', confirm: true, preview_id: kept(pUpd), approval_ref: await yes(kept(pUpd)) })).includes('no longer matches'), 'refuse: a preview whose target changed since')
await harness.query(`UPDATE track SET methodology_text = NULL WHERE id = $1`, [speed.id])
const upd2 = await onePath('update_track again', () => approved('update_track', { track: 'Speed', set_purpose: 'top speed' }))

const rule = await onePath('set_track_progression_rule', () => approved('set_track_progression_rule', { track: 'Speed', engine_type: 'double_progression', params: { step: 5 } }))
const refRule = await yes(kept(pRule))
const autoreg = await onePath('upsert_autoreg_rule', () => call('upsert_autoreg_rule', {
  signal: 'sleep_hours', op: '<', value: 6, action: 'trim_accessories', message: 'Short sleep trims accessories.', confirm: true, preview_id: kept(pRule), approval_ref: refRule,
}))
const goalNew = await onePath('upsert_goal (new)', () => approved('upsert_goal', { name: 'Broad Jump', metric: 'distance', unit: 'in', direction: 'higher', target: 100 }))
ok(goalNew.diff.before == null, 'upsert_goal (new): before is null')
const goalId = String(goalNew.target_id)
const goalUpd = await onePath('upsert_goal (update)', () => approved('upsert_goal', { goal_id: goalId, name: 'Broad Jump', direction: 'higher', target: 104 }))
const meas = await onePath('log_goal_measurement', () => call('log_goal_measurement', { goal: 'Broad Jump', value: 96, date: '2026-11-03', confirm: true }))
ok(meas.approval_ref === 'standing:logging' && meas.preview_id == null, 'logging: standing:logging, no preview needed')
const measDup = await logCount()
await call('log_goal_measurement', { goal: 'Broad Jump', value: 96, date: '2026-11-03', confirm: true, client_key: 'k1' })
await call('log_goal_measurement', { goal: 'Broad Jump', value: 99, date: '2026-11-03', confirm: true, client_key: 'k1' })
ok(await logCount() === measDup + 1, 'logging: a reused client_key writes and logs nothing')
const note = await onePath('add_workout_note', () => call('add_workout_note', { session_name: 'A day', text: 'Felt quick.', confirm: true }))
ok(note.approval_ref === 'standing:logging', 'add_workout_note: standing:logging')
const target = await onePath('update_athlete_target', () => approved('update_athlete_target', { text: 'Jump farther' }))
const meta = await onePath('update_program_meta', () => approved('update_program_meta', { set_phase: 'build', deload_week_start: '2026-11-23' }))
const assigned = await onePath('assign_exercise_to_track', () => approved('assign_exercise_to_track', {
  assignments: [{ session_name: 'Upper', exercise_name: 'Plank', track: 'Speed' }],
}))
ok(assigned.target_type === 'routine', 'assign_exercise_to_track: target is the routine')

// set_training_max keeps the prior value.
const tm1 = await onePath('set_training_max', async () => {
  const p = await call('set_training_max', { lift: 'squat', training_max: 300 })
  ok(kept(p) !== '' && p.includes('Preview only'), 'set_training_max: preview keeps a preview_id')
  return call('set_training_max', { lift: 'squat', training_max: 300, confirm: true, preview_id: kept(p), approval_ref: await yes(kept(p)) })
})
ok(tm1.diff.before == null && (tm1.diff.after as { value?: number })?.value === 300, 'set_training_max: before → after recorded')
const tm2 = await onePath('set_training_max again', async () => {
  const p = await call('set_training_max', { lift: 'squat', training_max: 315 })
  return call('set_training_max', { lift: 'squat', training_max: 315, confirm: true, preview_id: kept(p), approval_ref: await yes(kept(p)) })
})
ok((await callErr('set_training_max', { lift: 'squat', training_max: 320, confirm: true })).includes('approval_ref is required'), 'refuse: set_training_max without approval')

// Program edits through MCP.
const editArgs = { edits: [{ type: 'update_exercise', session_name: 'Upper', exercise_name: 'Bench Press', sets: 5, rationale: 'All sets at or under RPE 7 (U5).' }] }
const pEdit = await call('preview_program_edits', editArgs)
ok(kept(pEdit) !== '', 'preview_program_edits: a kept preview_id')
ok((await call('apply_program_edits', { ...editArgs, confirm: true, preview_id: kept(pEdit) })).includes('approval_ref is required'), 'refuse: apply_program_edits without approval')
const upperBefore = await exercisesOf(UPPER)
const revisionsBefore = await count('program_revision', 'program_id = $1', [PROG_A])
const refEdit = await yes(kept(pEdit))
ok(refEdit.startsWith('tap:'), 'approval: the athlete approves a program-edit preview')
const edit = await onePath('apply_program_edits', () => call('apply_program_edits', { ...editArgs, confirm: true, preview_id: kept(pEdit), approval_ref: refEdit }))
ok(edit.tool === 'apply_program_edits' && edit.approval_ref === refEdit && JSON.stringify(edit.rule_refs) === '["U5"]', 'apply_program_edits: approval and rule refs')
ok(await count('program_revision', 'program_id = $1', [PROG_A]) === revisionsBefore + 1, 'apply_program_edits: program_revision is still written as before')
ok(await exercisesOf(UPPER) !== upperBefore, 'apply_program_edits: the routine changed')

// A proposal accepted in the app.
const proposed = await call('preview_program_edits', { propose: true, title: 'Add face pulls.', edits: [{ type: 'add_exercise', session_name: 'Upper', exercise_name: 'Face Pull', sets: 2, reps: '15', load: 'light' }] })
ok(proposed.includes('Parked'), 'proposal: parked')
const [prop] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [A])
let acceptRef = ''
const accepted = await onePath('accept_proposal', async () => {
  const res = await approveAndAccept(storeA, prop.id)
  acceptRef = res.approval_ref ?? ''
  ok(res.ok, `proposal: the athlete's tap applies it (${res.text.slice(0, 60)})`)
})
ok(accepted.tool === 'accept_proposal' && accepted.approval_ref === acceptRef && acceptRef.startsWith('tap:') && accepted.actor_type === 'mcp', 'accept_proposal: authored by the coach, approved by the tap')
const proposedOld = await call('preview_program_edits', { propose: true, title: 'Add curls.', edits: [{ type: 'add_exercise', session_name: 'Upper', exercise_name: 'Curl', sets: 2, reps: '12', load: 'light' }] })
ok(proposedOld.includes('Parked'), 'proposal: second parked')
const [oldProp] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [A])
await harness.query(`UPDATE coach_proposal SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [oldProp.id])
const beforeOld = await logCount()
const oldRes = await approveAndAccept(storeA, oldProp.id)
ok(!oldRes.ok && oldRes.status === 'stale' && await logCount() === beforeOld, 'proposal: over 24 h old is stale and logs nothing')

// Week-only override (a move is still one change).
const today = await athleteToday(storeA)
const pOv = await call('preview_session_override', { date: addDays(today, 1), session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }], rationale: 'Short on time.' })
const refOv = await yes(sop(pOv))
const override = await onePath('apply_session_override', () => call('apply_session_override', { preview_id: sop(pOv), confirm: true, approval_ref: refOv }))
ok(override.tool === 'apply_session_override' && override.preview_id === sop(pOv) && Array.isArray(override.diff.override_ids), 'apply_session_override: logged with its override ids')
const pMove = await call('preview_session_override', { date: today, session: 'A day', ops: [{ op: 'move', exercise_name: 'Back Squat', to_date: addDays(today, 2), to_session: 'Upper' }] })
const refMove = await yes(sop(pMove))
const moved = await onePath('apply_session_override (move)', () => call('apply_session_override', { preview_id: sop(pMove), confirm: true, approval_ref: refMove }))
ok((moved.diff.override_ids as unknown[]).length === 2, 'apply_session_override (move): two rows, one change')
const pClr = await call('preview_clear_session_override', { override_id: (moved.diff.override_ids as string[])[0] })
const refClr = await yes(sop(pClr))
const cleared = await onePath('clear_session_override', () => call('apply_session_override', { preview_id: sop(pClr), confirm: true, approval_ref: refClr }))
ok(cleared.tool === 'clear_session_override', 'clear_session_override: logged')

// The app editor's own program_revision.
const appRev = await onePath('app_editor', async () => {
  const res = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
    table: 'program_revision', op: 'insert', returning: 'id',
    values: { program_id: PROG_A, phase_id: PHASE_A, trigger: 'editor', effective_on: today, requests: ['more pulling'], snapshot: [], diff: { added: 1 }, summary: '1 added' },
  })
  ok(res.error == null, 'app_editor: the insert succeeds')
})
ok(appRev.actor_type === 'athlete' && appRev.actor_id === A && appRev.approval_ref?.startsWith('tap:') === true, 'app_editor: the athlete, with their own tap')
ok(await count('program_revision', 'id::text = $1', [String(appRev.diff.revision_id)]) === 1, 'app_editor: the log names the revision it wrote')

// ---- undo --------------------------------------------------------------------------
// Coaches cannot undo; they can suggest.
ok((await revertChange(storeA, coachA, upd2.id)).text.includes('only the athlete'), 'undo: a coach cannot apply an undo')
ok((await revertChange(storeA, APP_COACH, upd2.id)).text.includes('only the athlete'), 'undo: app_coach cannot apply an undo')
const beforeSuggest = await logCount()
const suggested = await call('preview_revert_change', { change_id: upd2.id, rationale: 'Keep it simple.' })
ok(suggested.includes('Preview: undo') && suggested.includes('Only the athlete can undo'), 'undo: preview_revert_change previews')
ok(await logCount() === beforeSuggest, 'undo: a suggestion writes no change')
const pageA = await listChanges(storeA, { limit: 100 })
ok(pageA?.changes.find((c) => c.id === upd2.id)?.revert_suggested === true, 'undo: the feed shows the coach suggestion')

// Stale: the first update can't be undone while the second sits on top of it.
const staleUndo = await appRevert(storeA, upd1.id)
ok(!staleUndo.ok && staleUndo.reason === 'stale' && staleUndo.text.includes('changed since'), 'undo: refused when the target changed since')
const undo2 = await appRevert(storeA, upd2.id)
ok(undo2.ok, `undo: the latest track update undoes (${undo2.text})`)
const undoRow = await lastLog()
const origRow = await logById(upd2.id)
ok(undoRow.tool === 'revert_change' && undoRow.revert_of === upd2.id && origRow.reverted_by === undoRow.id, 'undo: new row with revert_of, original carries reverted_by')
ok(undoRow.actor_type === 'athlete' && /^tap:[0-9a-f-]{36}$/.test(String(undoRow.approval_ref)), 'undo: by the athlete, with their tap')
const [undoApproval] = await harness.query<{ preview_kind: string; consumed_by: string | null }>(
  `SELECT preview_kind, consumed_by_change_id::text AS consumed_by FROM approval WHERE id::text = $1`, [String(undoRow.approval_ref).slice(4)],
)
ok(undoApproval?.preview_kind === 'revert' && undoApproval.consumed_by === undoRow.id, 'undo: its tap is an approval row, spent by the undo')
ok((await harness.query<{ purpose: string }>(`SELECT purpose FROM track WHERE id = $1`, [speed.id]))[0].purpose === 'acceleration', 'undo: track restored to before that change')
ok((await listChanges(storeA, { limit: 100 }))?.changes.find((c) => c.id === upd2.id)?.revert_suggested === false, 'undo: the suggestion is spent')
ok(!(await appRevert(storeA, upd2.id)).ok && (await appRevert(storeA, upd2.id)).text.includes('Already undone'), 'undo: double undo refused')
// Round 2 item 3: undoing an undo redoes it; undoing that redo undoes again.
const redo = await appRevert(storeA, undoRow.id)
ok(redo.ok && redo.text.startsWith('Redone'), `undo: undoing an undo redoes it (${redo.text})`)
ok((await harness.query<{ purpose: string }>(`SELECT purpose FROM track WHERE id = $1`, [speed.id]))[0].purpose === 'top speed', 'redo: the track has the change again')
const redoRow = await lastLog()
ok(redoRow.revert_of === undoRow.id && (await logById(undoRow.id)).reverted_by === redoRow.id, 'redo: linked to the undo it reverts')
ok((await appRevert(storeA, redoRow.id)).ok, 'redo: undoing the redo undoes again')
ok((await appRevert(storeA, upd1.id)).ok, 'undo: with the newer change gone, the older one undoes')
ok((await harness.query<{ purpose: string }>(`SELECT purpose FROM track WHERE id = $1`, [speed.id]))[0].purpose === 'sprints', 'undo: track back to how it was created')

// Program edits.
const editUndo = await appRevert(storeA, edit.id)
ok(!editUndo.ok && editUndo.reason === 'stale', 'undo: program edit refused once the routine moved again (proposal + assignment since)')
const upperNow = await exercisesOf(UPPER)
const aDayBefore = await exercisesOf(ROUTINE_A)
const pEdit2 = await call('preview_program_edits', { edits: [{ type: 'update_exercise', session_name: 'A day', exercise_name: 'Back Squat', reps: '3' }] })
const refEdit2 = await yes(kept(pEdit2))
const edit2 = await onePath('apply_program_edits (A day)', () => call('apply_program_edits', { edits: [{ type: 'update_exercise', session_name: 'A day', exercise_name: 'Back Squat', reps: '3' }], confirm: true, preview_id: kept(pEdit2), approval_ref: refEdit2 }))
const aDayEdited = await exercisesOf(ROUTINE_A)
ok(aDayEdited !== aDayBefore, 'apply_program_edits (A day): the routine changed')
const revBeforeUndo = await count('program_revision', 'program_id = $1', [PROG_A])
ok((await appRevert(storeA, edit2.id)).ok, 'undo: a program edit undoes')
ok(await exercisesOf(ROUTINE_A) === aDayBefore, 'undo: the routine is back to exactly what it was before the edit')
ok(await exercisesOf(UPPER) === upperNow, 'undo: untouched routines stay as they are')
ok(await count('program_revision', 'program_id = $1 AND summary = $2', [PROG_A, 'Undid a coach change']) === 1 && await count('program_revision', 'program_id = $1', [PROG_A]) === revBeforeUndo + 1, 'undo: the journey records the undo as a revision')
const pAdd = await call('preview_program_edits', { edits: [{ type: 'add_session', session_name: 'Conditioning', exercises: [{ name: 'Bike', sets: 1, reps: '20 min' }] }] })
const added = await onePath('apply_program_edits (add_session)', async () => {
  const t = await call('apply_program_edits', { edits: [{ type: 'add_session', session_name: 'Conditioning', exercises: [{ name: 'Bike', sets: 1, reps: '20 min' }] }], confirm: true, preview_id: kept(pAdd), approval_ref: await yes(kept(pAdd)) })
  ok(t.startsWith('Applied now'), `apply_program_edits (add_session): applied (${t.slice(0, 120)})`)
})
const addUndo = await appRevert(storeA, added.id)
const addedId = String((added.diff.added as Array<{ id: string }>)[0]?.id)
ok(addUndo.ok, `undo: a change that added a session undoes (${addUndo.text})`)
ok(await count('routine', 'id::text = $1 AND phase_id IS NULL', [addedId]) === 1, 'undo: the added session comes out of the week, kept (not deleted)')

// Training max: restores the prior value, only that lift.
await harness.query(`UPDATE athlete SET training_max_overrides = training_max_overrides || '{"bench": 205}'::jsonb WHERE id = $1`, [A])
ok(!(await appRevert(storeA, tm1.id)).ok, 'undo: the older TM change is stale while a newer one stands')
ok((await appRevert(storeA, tm2.id)).ok, 'undo: the TM change undoes')
const tmNow = (await harness.query<{ o: Record<string, { value?: number } | number> }>(`SELECT training_max_overrides AS o FROM athlete WHERE id = $1`, [A]))[0].o
ok((tmNow.squat as { value?: number })?.value === 300 && tmNow.bench === 205, 'undo: squat TM back to the prior value; bench untouched')

// Other kinds.
ok((await appRevert(storeA, rule.id)).ok, 'undo: progression rule')
ok(await count('progression_rule', 'id::text = $1 AND active_to IS NOT NULL', [String(rule.target_id)]) === 1, 'undo: the rule is ended, not deleted')
const goalUndo = await appRevert(storeA, goalUpd.id)
ok(goalUndo.ok, `undo: goal update (${goalUndo.text})`)
ok(Number((await harness.query<{ t: string }>(`SELECT target::text AS t FROM athlete_goal WHERE id = $1`, [goalId]))[0].t) === 100, 'undo: goal target restored')
ok((await appRevert(storeA, target.id)).ok, 'undo: athlete target')
ok((await harness.query<{ goals: string }>(`SELECT goals FROM athlete WHERE id = $1`, [A]))[0].goals === 'A only goal', 'undo: athlete target restored')
ok((await appRevert(storeA, meta.id)).ok, 'undo: block details')
ok((await harness.query<{ d: string | null }>(`SELECT deload_week_start::text AS d FROM program WHERE id = $1`, [PROG_A]))[0].d == null, 'undo: block details restored')
ok((await appRevert(storeA, override.id)).ok, 'undo: week-only override')
ok(await count('session_override', 'id::text = $1 AND voided_at IS NOT NULL', [(override.diff.override_ids as string[])[0]]) === 1, 'undo: the override is voided (kept for audit)')
ok(await count('session_override_log', 'athlete_id = $1 AND tool = $2', [A, 'revert_session_override']) === 1, 'undo: session_override_log records it too')
// Round 2 item 3: every type has a defined revert (reverts.check.ts covers each in depth).
for (const [row, label] of [[goalNew, 'a new goal (retired)'], [autoreg, 'an autoreg rule (retired)'], [note, 'a note (voided)'], [cleared, 'a clear (put back)']] as const) {
  const res = await appRevert(storeA, row.id)
  ok(res.ok, `undo: ${label} undoes (${res.text.slice(0, 60)})`)
}
const measUndo = await appRevert(storeA, meas.id)
ok(!measUndo.ok && measUndo.reason === 'stale' && (measUndo as { conflicts?: unknown[] }).conflicts?.length === 1, 'undo: a measurement with a newer one on its goal is a conflict')
const createdUndo = await appRevert(storeA, created.id)
ok(!createdUndo.ok && createdUndo.reason === 'not_revertible' && createdUndo.text.includes('still use'), 'undo: a track exercises still use is not retired')
const appRevUndo = await appRevert(storeA, appRev.id)
ok(!appRevUndo.ok && appRevUndo.reason === 'not_revertible', 'undo: an editor revision that can\'t be matched is refused, clearly')
const assignUndo = await appRevert(storeA, assigned.id)
ok(!assignUndo.ok && assignUndo.reason === 'stale', 'undo: an assignment the proposal then built on is stale')

// ---- revocation --------------------------------------------------------------------
const pLate = await call('create_track', { name: 'Late' }, { type: 'mcp', id: TOKEN_LATE_ID })
const revoke = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'mcp_token', op: 'update', values: { revoked_at: new Date().toISOString() }, filters: [{ column: 'id', op: 'eq', value: TOKEN_LATE_ID }],
})
ok(revoke.error == null, 'revoke: the app revokes as before')
ok(await count('change_preview', 'preview_id = $1 AND voided_at IS NOT NULL', [kept(pLate)]) === 1, 'revoke: the coach\'s open preview is voided at revoke time')
const [revLog] = await harness.query<{ diff: { voided_previews: string[] }; actor_type: string }>(
  `SELECT diff, actor_type FROM change_log WHERE athlete_id = $1 AND tool = 'revoke_coach' AND target_id = $2`, [A, TOKEN_LATE_ID],
)
ok(revLog?.actor_type === 'system' && revLog.diff.voided_previews.includes(kept(pLate)), 'revoke: logged once, by system, naming the voided preview')
ok((await callErr('create_track', { name: 'Late', confirm: true, preview_id: kept(pLate), approval_ref: NO_APPROVAL })).includes('voided'), 'revoke: the voided preview cannot be applied by anyone')
ok(await count('change_log', 'athlete_id = $1 AND tool = $2', [A, 'revoke_coach']) === 1, 'revoke: only the coach just revoked is logged (not ones revoked before)')

// ---- reading -----------------------------------------------------------------------
ok((await callErr('get_change_log', {})).includes('since is required'), 'get_change_log: since is required')
const page1 = JSON.parse(await call('get_change_log', { since: '2026-01-01', limit: 3 })) as { changes: Array<{ id: string; who: string; summary: string }>; next_before: string | null }
ok(page1.changes.length === 3 && page1.next_before != null, 'get_change_log: limited, with a cursor')
const page2 = JSON.parse(await call('get_change_log', { since: '2026-01-01', limit: 3, before: page1.next_before })) as typeof page1
ok(page2.changes.length === 3 && !page2.changes.some((c) => page1.changes.some((p) => p.id === c.id)), 'get_change_log: the next page is older rows')
const athleteOnly = JSON.parse(await call('get_change_log', { since: '2026-01-01', actor: 'athlete', limit: 100 })) as typeof page1
ok(athleteOnly.changes.length > 0 && athleteOnly.changes.every((c) => c.who === 'You'), 'get_change_log: actor filter')
const trackOnly = JSON.parse(await call('get_change_log', { since: '2026-01-01', target: speed.id, limit: 100 })) as { changes: Array<{ target: { id: string } }> }
ok(trackOnly.changes.length >= 2 && trackOnly.changes.every((c) => c.target.id === speed.id), 'get_change_log: target filter')
ok((await call('get_change_log', { since: '2099-01-01' })).includes('No changes'), 'get_change_log: since filters')
const feed = (await athleteChangeLogAction(storeA, { action: 'list', limit: 100 }))[0] as { changes: ChangeView[] }
ok(feed.changes.length > 0 && feed.changes.every((c) => typeof c.summary === 'string' && c.summary.length > 0 && ['You', 'Claude', 'Coach', 'System', 'claude-a', 'late-coach'].includes(c.who)), 'feed: who and what on every row')
ok(feed.changes.find((c) => c.id === upd2.id)?.reverted_by != null, 'feed: undone rows show it')

// ---- append-only ---------------------------------------------------------------------
let blocked = 0
for (const q of [`UPDATE change_log SET tool = 'x' WHERE id = '${created.id}'`, `DELETE FROM change_log WHERE id = '${created.id}'`, `UPDATE change_log SET reverted_by = NULL WHERE id = '${upd2.id}'`]) {
  try { await harness.query(q) } catch { blocked++ }
}
ok(blocked === 3, 'append-only: no edits, no deletes, reverted_by set once')

// ---- isolation -----------------------------------------------------------------------
await flag(B, true)
const aIds = new Set((await listChanges(storeA, { limit: 100 }))!.changes.map((c) => c.id))
ok(((await listChanges(storeB, { limit: 100 }))?.changes ?? []).every((c) => !aIds.has(c.id)), 'isolation: B lists none of A\'s rows')
ok((await call('get_change_log', { since: '2026-01-01' }, coachB, B)).includes('No changes'), 'isolation: B\'s coach sees none of A\'s rows')
const bRevert = await appRevert(storeB, edit.id)
ok(!bRevert.ok && bRevert.reason === 'not_found', 'isolation: B cannot undo A\'s change')
ok((await call('preview_revert_change', { change_id: edit.id }, coachB, B)).includes('No such change'), 'isolation: B\'s coach cannot preview undoing A\'s change')
const pA = await call('create_track', { name: 'A Only' })
ok((await callErr('create_track', { name: 'A Only', confirm: true, preview_id: kept(pA), approval_ref: await yes(kept(pA)) }, coachB, B)).includes('no create_track preview'), 'isolation: B cannot apply A\'s preview')
await onePath('B create_track', () => approved('create_track', { name: 'B Track' }, coachB, B).then((t) => {
  ok(t.includes('B Track'), 'B: approved write lands on B')
}), B)
ok(await count('change_log', 'athlete_id = $1 AND tool = $2', [A, 'create_track']) === 1, 'isolation: B\'s write logs only under B')

// ---- rollback: flag off again --------------------------------------------------------
await flag(A, false)
const totalAfter = await count('change_log')
ok((await call('create_track', { name: 'After Rollback', confirm: true })).includes('After Rollback'), 'rollback: flag off writes without approval again')
ok(await count('change_log') === totalAfter, 'rollback: flag off writes no change_log rows')
ok((await athleteChangeLogAction(storeA, { action: 'revert', id: edit.id }))[1] === 404, 'rollback: undo route reads as absent')
ok((await revertChange(storeA, me, edit.id)).reason === 'off', 'rollback: undo is off')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`change log: ok (${harness.backend})`)
