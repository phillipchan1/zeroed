// Week-only session overrides (G1) against a real schema: flag off is
// byte-for-byte unchanged, overrides apply on their date only, expiry, moves,
// the preview / approval contract, app_coach, revoked coaches, clear, and
// athlete isolation. Synthetic athletes A and B from isolation-seed.sql.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/sessionOverride.check.ts

import type { Env } from './env.ts'
import { openIsolationHarness } from './isolationDb.ts'
import { handleMcp } from './mcp.ts'
import { sha256Hex } from './mcpToken.ts'
import { acceptProposal, approveAndAccept, listProposals } from './proposals.ts'
import { createApproval } from './approvals.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import {
  APP_COACH, athleteOverrideAction, athleteToday, listOverrides, SESSION_OVERRIDE_TOOLS,
  type OverrideActor,
} from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import { addDays } from '../../src/engine/sessionOverride.ts'
import type { SessionPrescription } from '../../src/engine/sessionRxCompute.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PHASE_A = '55555555-5555-5555-5555-555555555555'
const ROUTINE_B = '88888888-8888-8888-8888-888888888888'
const LOWER = 'a0a0a0a0-0000-4000-8000-000000000001'
const UPPER = 'a0a0a0a0-0000-4000-8000-000000000002'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_REVOKED_ID = 'aaaa7777-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const TOKEN_A = 'zeroed-mcp-token-override-a-aaaaaaa'
const TOKEN_B = 'zeroed-mcp-token-override-b-bbbbbbb'

const harness = await openIsolationHarness()
const sql = harness.sql
// Section 11b: no age on file means the under-18 rules. These synthetic
// athletes are confirmed adults; ageStatus.check.ts covers unknown age.
await harness.query(`UPDATE athlete SET adult_confirmed_at = NOW()`)
const env = {} as Env
const storeA = makeStore(sql, A)
// A well-formed approval_ref that resolves to no approval row.
const NO_APPROVAL = 'msg:00000000-0000-4000-8000-000000000000'
/** The athlete taps Approve on a preview (G10); its approval_ref, or NO_APPROVAL if refused. */
async function yes(previewId: string): Promise<string> {
  const r = await createApproval(storeA, { type: 'athlete', id: A }, { preview_id: previewId })
  return r.ok ? r.approval_ref : NO_APPROVAL
}
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }

await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_A)} WHERE id = ${TOKEN_A_ID}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_B)} WHERE id = ${TOKEN_B_ID}`

const lowerExercises = [
  { name: 'Back Squat', sets: 3, reps: '5', load: 'heavy' },
  { name: 'Romanian Deadlift', sets: 3, reps: '8', load: 'moderate' },
]
const upperExercises = [
  { name: 'Bench Press', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
  { name: 'Chest-Supported Row', sets: 3, reps: '10', load: 'moderate' },
  { name: 'Triceps Pushdown', sets: 3, reps: '12', load: 'light' },
  { name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' },
]
await harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, 'Lower', 'strength', $4::jsonb, 'Lower intent', 1),
          ($5, $2, $3, 'Upper', 'strength', $6::jsonb, 'Upper intent', 3)`,
  [LOWER, PROG_A, PHASE_A, JSON.stringify(lowerExercises), UPPER, JSON.stringify(upperExercises)],
)

const today = await athleteToday(storeA)
const D1 = addDays(today, 1)
const D2 = addDays(today, 2)
const D3 = addDays(today, 3)
const D4 = addDays(today, 4)
const D5 = addDays(today, 5)

type Single = { prescription: SessionPrescription; version: string; program_version: string }
async function rx(athleteId: string, body: Record<string, unknown>): Promise<{ status: number; text: string; out: Single }> {
  const [out, status] = await sessionRxForAthlete(sql, athleteId, { unit: 'lb', storage_unit: 'lb', ...body })
  // G3 stamps methodology_version on every flag-on response (methodology.check.ts
  // covers it); these comparisons are about overrides, so it is left out of text.
  const text = JSON.stringify(out, (k, v) => (k === 'methodology_version' ? undefined : v))
  return { status, text, out: out as Single }
}
const call = (store: 'A' | 'B', name: string, args: Record<string, unknown>, actor: OverrideActor) =>
  executeZeroedTool(sql, store === 'A' ? A : B, name, args, {}, actor)
const previewIdOf = (text: string) => /preview_id: (sop_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const countRows = async (table: string, athleteId = A) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE athlete_id = $1`, [athleteId]))[0].n)
const templateOf = async (id: string) =>
  JSON.stringify((await harness.query<{ exercises: unknown }>('SELECT exercises FROM routine WHERE id = $1', [id]))[0].exercises)
const upperTemplate = await templateOf(UPPER)
const lowerTemplate = await templateOf(LOWER)
const [revisionsBefore] = await harness.query<{ n: string }>('SELECT count(*)::text AS n FROM program_revision')

// ---- flag OFF: nothing changes ------------------------------------------------
const baseUpper = await rx(A, { routine_id: UPPER })
const baseLower = await rx(A, { routine_id: LOWER })
ok(baseUpper.status === 200 && !('override' in baseUpper.out.prescription), 'baseline: session-rx works and has no override')

// A row already in the table (the flag was on, then rolled back) must still be ignored.
await harness.query(
  `INSERT INTO session_override (athlete_id, date, routine_id, ops, expires_on, actor_type, actor_id, approval_ref, preview_id)
   VALUES ($1, $2, $3, $4::jsonb, $5, 'athlete', 'seed', 'tap:seed', 'sop_seed')`,
  [A, D1, UPPER, JSON.stringify([{ op: 'drop', exercise_name: 'Plank' }]), D1],
)
const offWithDate = await rx(A, { routine_id: UPPER, date: D1 })
ok(offWithDate.text === baseUpper.text, 'flag off: session-rx with a date is byte-for-byte the same, even with an override row present')
const offBatch = await rx(A, { routine_ids: [UPPER, LOWER], date: D1 })
const offBatchBase = await rx(A, { routine_ids: [UPPER, LOWER] })
ok(offBatch.text === offBatchBase.text, 'flag off: batch session-rx with a date is byte-for-byte the same')
ok((await zeroedToolsFor(sql, A)).map((t) => t.name).join() === ZEROED_TOOLS.map((t) => t.name).join(), 'flag off: tool list is exactly ZEROED_TOOLS')
let offErr = ''
try {
  await call('A', 'preview_session_override', { date: D1, session: UPPER, ops: [{ op: 'drop', exercise_name: 'Plank' }] }, coachA)
} catch (e) {
  offErr = e instanceof Error ? e.message : String(e)
}
ok(offErr.includes('Unknown tool'), 'flag off: override tools refuse as unknown')
ok((await athleteOverrideAction(storeA, { action: 'list' }))[1] === 404, 'flag off: the app route reads as absent')

const listRpc = async (token: string) => {
  const res = await handleMcp(new Request('https://zeroed.test/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), env, { sql })
  const body = await res.json() as { result?: { tools?: Array<{ name: string }> } }
  return (body.result?.tools ?? []).map((t) => t.name)
}
ok((await listRpc(TOKEN_A)).join() === ZEROED_TOOLS.map((t) => t.name).join(), 'flag off: MCP tools/list is unchanged')
const offCall = await handleMcp(new Request('https://zeroed.test/api/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_session_overrides', arguments: {} } }),
}), env, { sql })
ok(JSON.stringify(await offCall.json()).includes('Unknown tool'), 'flag off: MCP tools/call of an override tool is unknown')

await harness.query(`DELETE FROM session_override WHERE preview_id = 'sop_seed'`)

// ---- flag ON ------------------------------------------------------------------
await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id IN (${A}, ${B})`
const onTools = await listRpc(TOKEN_A)
ok(SESSION_OVERRIDE_TOOLS.every((t) => onTools.includes(t.name)), 'flag on: MCP tools/list adds the override tools')
ok((await rx(A, { routine_id: UPPER })).text === baseUpper.text, 'flag on, no date: session-rx unchanged')
ok((await rx(A, { routine_id: UPPER, date: D1 })).text === baseUpper.text, 'flag on, date with no override: session-rx unchanged')

// Preview writes no override.
const swapOps = [
  { op: 'swap', exercise_name: 'Bench Press', with: { name: 'DB Bench Press' } },
  { op: 'drop', exercise_name: 'Plank' },
  { op: 'adjust', exercise_name: 'Triceps Pushdown', sets: 2 },
  { op: 'add', exercise: { name: 'Face Pull', sets: 2, reps: '15', load: 'light' }, after: 'Chest-Supported Row' },
]
// Four changes is over the U13 small-edit cap (G5), so this preview says rewrite=true.
const p1 = await call('A', 'preview_session_override', { date: D1, session: 'Upper', ops: swapOps, rationale: 'Bench is taken Thursday.', rewrite: true }, coachA)
const p1Id = previewIdOf(p1)
ok(p1Id !== '', 'preview: returns a preview_id')
ok(p1.includes('+ DB Bench Press') && p1.includes('− Bench Press') && p1.includes('− Plank') && p1.includes('~ Triceps Pushdown') && p1.includes('+ Face Pull'), 'preview: diff names every change')
ok(await countRows('session_override') === 0, 'preview: writes no override')

// Apply without a valid preview / approval is rejected.
const refusedNoConfirm = await call('A', 'apply_session_override', { preview_id: p1Id, approval_ref: 'msg:chat-1' }, coachA)
ok(refusedNoConfirm.startsWith('Refused') && refusedNoConfirm.includes('confirm=true'), 'apply: confirm=true required')
const refusedNoRef = await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true }, coachA)
ok(refusedNoRef.startsWith('Refused') && refusedNoRef.includes('approval_ref'), 'apply: approval_ref required')
ok((await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: 'standing:logging' }, coachA)).includes('logging only'), 'apply: standing approval does not cover overrides')
ok((await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: 'tap:forged' }, coachA)).includes('approval_ref must be'), 'apply: a malformed tap approval is rejected')
ok((await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: 'tap:aaaaaaaa-0000-4000-8000-000000000000' }, coachA)).includes('no such approval'), 'apply: a coach cannot forge a tap approval')
ok((await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: 'yes' }, coachA)).startsWith('Refused'), 'apply: a free-form approval_ref is rejected')
ok((await call('A', 'apply_session_override', { preview_id: 'sop_000000000000000000000000', confirm: true, approval_ref: NO_APPROVAL }, coachA)).includes('no such preview'), 'apply: an unknown preview_id is rejected')
ok((await call('A', 'apply_session_override', { confirm: true, approval_ref: NO_APPROVAL }, coachA)).includes('preview_id is required'), 'apply: no preview_id is rejected')
ok(await countRows('session_override') === 0, 'apply: every refusal wrote nothing')

// app_coach never supplies approval_ref.
const coachRef = await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: await yes(p1Id) }, APP_COACH)
ok(coachRef.includes('app_coach cannot supply approval_ref'), 'app_coach: approval_ref is rejected')
const defaultActor = await executeZeroedTool(sql, A, 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: await yes(p1Id) })
ok(defaultActor.includes('app_coach cannot supply approval_ref'), 'a caller that names no actor gets app_coach powers')
ok(await countRows('session_override') === 0, 'app_coach: nothing written')

// The good path.
const ref1 = await yes(p1Id)
ok(ref1.startsWith('tap:'), 'approval: the athlete\'s tap creates an approval row')
const applied = await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: ref1 }, coachA)
ok(applied.startsWith('Applied 1 week-only override row'), `apply: writes with a fresh preview and approval (${applied.slice(0, 80)})`)
const [row1] = await harness.query<{ id: string; actor_type: string; actor_id: string; approval_ref: string; preview_id: string; expires_on: string; rationale: string }>(
  `SELECT id, actor_type, actor_id, approval_ref, preview_id, expires_on::text AS expires_on, rationale FROM session_override WHERE athlete_id = $1`, [A],
)
ok(row1?.actor_type === 'mcp' && row1.actor_id === TOKEN_A_ID && row1.approval_ref === ref1 && row1.preview_id === p1Id, 'apply: row records who, approval and preview')
ok(row1?.rationale === 'Bench is taken Thursday.', 'apply: row keeps the rationale')
ok(row1 != null && row1.expires_on >= D1 && row1.expires_on <= addDays(D1, 6), 'apply: default expiry is the end of that ISO week')
const [log1] = await harness.query<{ tool: string; approval_ref: string; preview_id: string; actor_type: string }>(
  `SELECT tool, approval_ref, preview_id, actor_type FROM session_override_log WHERE athlete_id = $1 ORDER BY created_at`, [A],
)
ok(log1?.tool === 'apply_session_override' && log1.approval_ref === ref1 && log1.preview_id === p1Id, 'audit: the apply is logged with approval and preview')
ok((await call('A', 'apply_session_override', { preview_id: p1Id, confirm: true, approval_ref: ref1 }, coachA)).includes('already applied'), 'apply: a preview applies once')
ok(await templateOf(UPPER) === upperTemplate, 'template: routine.exercises untouched')

// Session-rx applies it on that date only.
const onD1 = await rx(A, { routine_id: UPPER, date: D1 })
const ov = onD1.out.prescription.override
ok(ov != null && ov.label === 'This week only' && ov.date === D1, 'session-rx: override on its date, labeled This week only')
ok(ov?.exercises.map((e) => e.name).join('|') === 'DB Bench Press|Chest-Supported Row|Face Pull|Triceps Pushdown', `session-rx: the day's list is the override's (${ov?.exercises.map((e) => e.name).join('|')})`)
ok(ov?.marks[0]?.kind === 'swapped' && ov.marks[0].from === 'Bench Press', 'session-rx: swap is marked with what it stands in for')
ok(ov?.marks[2]?.kind === 'added' && ov.marks[3]?.kind === 'adjusted' && ov.marks[1] == null, 'session-rx: add and adjust are marked; untouched lifts are not')
ok(ov?.exercises[3].sets === 2 && ov.exercises[0].sets === 4 && ov.exercises[0].target_rpe === 8, 'session-rx: adjust changes sets; swap keeps the slot dose')
ok(ov?.dropped.includes('Plank') === true, 'session-rx: dropped lifts are listed')
ok(onD1.out.prescription.exerciseNames?.[0] === 'DB Bench Press' || onD1.out.prescription.exercises?.[0]?.name === 'DB Bench Press', 'session-rx: the engine prescribed the overridden list')
ok(onD1.out.version !== baseUpper.out.version, 'session-rx: version changes with the override')
ok((await rx(A, { routine_id: UPPER, date: D2 })).text === baseUpper.text, 'session-rx: another date is unchanged')
ok((await rx(A, { routine_id: UPPER })).text === baseUpper.text, 'session-rx: no date is unchanged')
ok((await rx(A, { routine_id: LOWER, date: D1 })).text === baseLower.text, 'session-rx: another session on that date is unchanged')
const batchD1 = await rx(A, { routine_ids: [UPPER, LOWER], date: D1 }) as unknown as { out: { prescriptions: Record<string, SessionPrescription> } }
ok(batchD1.out.prescriptions[UPPER]?.override != null && batchD1.out.prescriptions[LOWER]?.override == null, 'session-rx: batch marks only the overridden session')

// Expired override is ignored (and kept).
await harness.query(
  `INSERT INTO session_override (athlete_id, date, routine_id, ops, expires_on, actor_type, actor_id, approval_ref, preview_id)
   VALUES ($1, $2, $3, $4::jsonb, $5, 'athlete', 'seed', 'tap:old', 'sop_old')`,
  [A, addDays(today, -2), UPPER, JSON.stringify([{ op: 'drop', exercise_name: 'Plank' }]), addDays(today, -1)],
)
ok((await rx(A, { routine_id: UPPER, date: addDays(today, -2) })).text === baseUpper.text, 'expiry: an expired override is ignored on its own date')
const allRows = await listOverrides(storeA, { from: addDays(today, -7), to: addDays(today, 13), includeInactive: true })
ok(allRows?.some((r) => r.approval_ref === 'tap:old' && !r.active) === true, 'expiry: the expired row stays for audit')
ok((await listOverrides(storeA))?.every((r) => r.active) === true, 'expiry: list shows active rows by default')
ok((await call('A', 'preview_session_override', { date: D1, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }], expires_on: addDays(D1, 8) }, coachA)).includes('at most 7 days'), 'expiry: expires_on capped at 7 days after the date')

// Move one missed lift: the source date loses it, the target date gains it.
const pMove = await call('A', 'preview_session_override', {
  date: today, session: 'Lower', ops: [{ op: 'move', exercise_name: 'Back Squat', to_date: D1, to_session: 'Upper' }], rationale: 'Missed the squat today.',
}, coachA)
ok(pMove.includes('moved to'), 'move: preview shows where it goes')
ok((await call('A', 'apply_session_override', { preview_id: previewIdOf(pMove), confirm: true, approval_ref: await yes(previewIdOf(pMove)) }, coachA)).startsWith('Applied 2'), 'move: writes two rows')
const pair = await harness.query<{ id: string; date: string; pair_id: string | null }>(
  `SELECT id, date::text AS date, pair_id::text AS pair_id FROM session_override WHERE preview_id = $1 ORDER BY date`, [previewIdOf(pMove)],
)
ok(pair.length === 2 && pair[0].pair_id != null && pair[0].pair_id === pair[1].pair_id, 'move: the two rows share a pair_id')
const srcDay = (await rx(A, { routine_id: LOWER, date: today })).out.prescription.override
ok(srcDay != null && !srcDay.exercises.some((e) => e.name === 'Back Squat') && srcDay.moved_out[0]?.to_date === D1, 'move: the source date loses the lift')
const dstDay = (await rx(A, { routine_id: UPPER, date: D1 })).out.prescription.override
const squatAt = dstDay?.exercises.findIndex((e) => e.name === 'Back Squat') ?? -1
ok(squatAt >= 0 && dstDay?.marks[squatAt]?.kind === 'moved_in' && dstDay.marks[squatAt].from === today, 'move: the target date gains it, marked moved in')
ok(dstDay?.exercises.some((e) => e.name === 'DB Bench Press') === true, 'move: stacks on the target date\'s existing override')
ok(await templateOf(LOWER) === lowerTemplate && await templateOf(UPPER) === upperTemplate, 'move: templates untouched')

// Move a whole session; it moves as it stands that day, edits included.
const pPre = await call('A', 'preview_session_override', { date: D2, session: LOWER, ops: [{ op: 'swap', exercise_name: 'Back Squat', with: { name: 'Leg Press' } }] }, coachA)
await call('A', 'apply_session_override', { preview_id: previewIdOf(pPre), confirm: true, approval_ref: await yes(previewIdOf(pPre)) }, coachA)
const pWhole = await call('A', 'preview_session_override', { date: D2, session: LOWER, ops: [{ op: 'move', to_date: D3 }] }, coachA)
ok((await call('A', 'apply_session_override', { preview_id: previewIdOf(pWhole), confirm: true, approval_ref: await yes(previewIdOf(pWhole)) }, coachA)).startsWith('Applied 2'), 'move session: two rows')
const out = (await rx(A, { routine_id: LOWER, date: D2 })).out.prescription.override
ok(out != null && out.exercises.length === 0 && out.moved_out[0]?.name == null && out.moved_out[0]?.to_date === D3, 'move session: the source date is empty')
const into = (await rx(A, { routine_id: LOWER, date: D3 })).out.prescription.override
ok(into?.moved_in_from === D2 && into.exercises.length === 2 && into.marks[0]?.kind === 'moved_in', 'move session: the target date has the whole session')
ok(into?.exercises[0]?.name === 'Leg Press', 'move session: carries the source day\'s edits, not the bare template')

// Stale previews: older than 24 h, or the diff no longer matches.
const pOld = await call('A', 'preview_session_override', { date: D4, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }, coachA)
await harness.query(`UPDATE session_override_preview SET created_at = NOW() - INTERVAL '25 hours' WHERE preview_id = $1`, [previewIdOf(pOld)])
const oldText = await call('A', 'apply_session_override', { preview_id: previewIdOf(pOld), confirm: true, approval_ref: await yes(previewIdOf(pOld)) }, coachA)
ok(oldText.includes('more than 24 h old'), 'stale: a preview over 24 h old is rejected')
const pAdj = await call('A', 'preview_session_override', { date: D4, session: 'Upper', ops: [{ op: 'adjust', exercise_name: 'Bench Press', sets: 5 }] }, coachA)
const pDrop = await call('A', 'preview_session_override', { date: D4, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Triceps Pushdown' }] }, coachA)
await call('A', 'apply_session_override', { preview_id: previewIdOf(pDrop), confirm: true, approval_ref: await yes(previewIdOf(pDrop)) }, coachA)
const mismatch = await call('A', 'apply_session_override', { preview_id: previewIdOf(pAdj), confirm: true, approval_ref: await yes(previewIdOf(pAdj)) }, coachA)
ok(mismatch.includes('no longer matches'), `stale: a preview whose diff changed is rejected (${mismatch.slice(0, 90)})`)
const pTpl = await call('A', 'preview_session_override', { date: D5, session: 'Upper', ops: [{ op: 'adjust', exercise_name: 'Plank', reps: '45s' }] }, coachA)
await harness.query(`UPDATE routine SET exercises = $1::jsonb WHERE id = $2`, [JSON.stringify(upperExercises.map((e) => e.name === 'Plank' ? { ...e, reps: '40s' } : e)), UPPER])
const tplText = await call('A', 'apply_session_override', { preview_id: previewIdOf(pTpl), confirm: true, approval_ref: await yes(previewIdOf(pTpl)) }, coachA)
ok(tplText.startsWith('Refused') && /no longer matches|changed since/.test(tplText), 'stale: a template change since the preview is rejected')
await harness.query(`UPDATE routine SET exercises = $1::jsonb WHERE id = $2`, [JSON.stringify(upperExercises), UPPER])

// A revoked coach's preview is void, and that is logged.
const pRevoked = await call('A', 'preview_session_override', { date: D5, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }, { type: 'mcp', id: TOKEN_REVOKED_ID })
const revokedText = await call('A', 'apply_session_override', { preview_id: previewIdOf(pRevoked), confirm: true, approval_ref: await yes(previewIdOf(pRevoked)) }, coachA)
ok(revokedText.includes('voided'), 'revoke: a revoked coach\'s preview cannot be applied')
const pExpiredTok = await call('A', 'preview_session_override', { date: D5, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }, { type: 'mcp', id: 'aaaa8888-0000-4000-8000-000000000001' })
ok((await call('A', 'apply_session_override', { preview_id: previewIdOf(pExpiredTok), confirm: true, approval_ref: await yes(previewIdOf(pExpiredTok)) }, coachA)).includes('voided'), 'revoke: an expired coach token\'s preview is void too')
const [voidLog] = await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM session_override_log WHERE athlete_id = $1 AND tool = 'void_preview'`, [A])
ok(Number(voidLog.n) === 2, 'revoke: each void is logged')

// app_coach proposes; only the athlete's tap applies it.
const proposed = await call('A', 'preview_session_override', {
  date: D5, session: 'Upper', ops: [{ op: 'swap', exercise_name: 'Chest-Supported Row', with: { name: 'Seated Cable Row' } }],
  propose: true, title: 'Cable row instead of the chest-supported row on Tuesday.', rationale: 'The bench is booked.',
}, APP_COACH)
ok(proposed.includes('Parked for the athlete as proposal'), 'app_coach: propose parks a coach_proposal')
const pending = await listProposals(storeA)
const overrideProposal = pending?.find((p) => p.kind === 'session_override')
ok(overrideProposal != null && (overrideProposal.diff as { sessions?: unknown[] }).sessions?.length === 1, 'proposal: listed with kind and a card-shaped diff')
ok(pending?.filter((p) => p.kind !== 'session_override').every((p) => !('kind' in p)) === true, 'proposal: program-edit proposals read back without a kind field')
const parkedId = previewIdOf(proposed)
const coachGrab = await call('A', 'apply_session_override', { preview_id: parkedId, confirm: true, approval_ref: await yes(parkedId) }, coachA)
ok(coachGrab.includes('parked for the athlete'), 'proposal: a coach cannot apply a preview parked for the athlete')
const viaMcp = await acceptProposal(storeA, overrideProposal!.id)
ok(!viaMcp.ok && viaMcp.text.includes('accepts it in the app'), 'proposal: MCP apply_program_edits(proposal_id) cannot accept an override')
const byB = await approveAndAccept(storeB, overrideProposal!.id)
ok(!byB.ok && byB.status === 'not_found', 'isolation: B cannot accept A\'s proposal')
const forgedTap = await acceptProposal(storeA, overrideProposal!.id, { approvalRef: `tap:${overrideProposal!.id}` })
ok(!forgedTap.ok && forgedTap.text.includes('no such approval'), 'proposal: a tap ref that is not an approval row is refused')
const tapped = await approveAndAccept(storeA, overrideProposal!.id)
ok(tapped.ok && tapped.status === 'applied', `proposal: the athlete's tap applies it (${tapped.text.slice(0, 80)})`)
const [fromCoach] = await harness.query<{ actor_type: string; approval_ref: string }>(
  `SELECT actor_type, approval_ref FROM session_override WHERE athlete_id = $1 AND actor_type = 'app_coach'`, [A],
)
ok(fromCoach?.approval_ref === tapped.approval_ref && /^tap:[0-9a-f-]{36}$/.test(String(tapped.approval_ref)), 'proposal: created_by app_coach, approved by the athlete\'s tap (a real approval row)')

// The athlete's own app session: the tap is the approval, minted server-side.
const [prevOut, prevStatus] = await athleteOverrideAction(storeA, { action: 'preview', date: D3, session: UPPER, ops: [{ op: 'drop', exercise_name: 'Plank' }] })
const appPreview = prevOut as { ok: boolean; preview_id: string }
ok(prevStatus === 200 && appPreview.ok, 'app: athlete preview')
const [appApplied] = await athleteOverrideAction(storeA, { action: 'apply', preview_id: appPreview.preview_id, approval_ref: 'msg:ignored' })
ok((appApplied as { ok: boolean }).ok === true, 'app: athlete apply')
const [appRow] = await harness.query<{ actor_type: string; approval_ref: string }>(
  `SELECT actor_type, approval_ref FROM session_override WHERE preview_id = $1`, [appPreview.preview_id],
)
ok(appRow?.actor_type === 'athlete' && appRow.approval_ref.startsWith('tap:'), 'app: recorded as the athlete with a tap ref (client-sent ref ignored)')
const pCoachOnly = await call('A', 'preview_session_override', { date: D3, session: UPPER, ops: [{ op: 'drop', exercise_name: 'Triceps Pushdown' }] }, coachA)
const [appCoach] = await athleteOverrideAction(storeA, { action: 'apply', preview_id: previewIdOf(pCoachOnly) })
ok((appCoach as { ok: boolean }).ok === false, 'app: the athlete route only applies the athlete\'s own previews; coach changes come as proposals')

// Clear: needs approval, clears both halves of a move, is logged.
const moveSrc = pair[0].id
const pClear = await call('A', 'preview_clear_session_override', { override_id: moveSrc, rationale: 'Squat got done after all.' }, coachA)
ok(pClear.includes('Preview: clear'), 'clear: preview')
ok((await call('A', 'apply_session_override', { preview_id: previewIdOf(pClear), confirm: true }, coachA)).includes('approval_ref is required'), 'clear: needs approval')
const ref9 = await yes(previewIdOf(pClear))
ok((await call('A', 'apply_session_override', { preview_id: previewIdOf(pClear), confirm: true, approval_ref: ref9 }, coachA)).startsWith('Cleared 2'), 'clear: both halves of the move clear')
const [cleared] = await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM session_override WHERE pair_id = $1 AND voided_at IS NOT NULL AND void_approval_ref = $2`, [pair[0].pair_id, ref9])
ok(Number(cleared.n) === 2, 'clear: rows kept, voided with the approval')
const [clearLog] = await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM session_override_log WHERE athlete_id = $1 AND tool = 'clear_session_override'`, [A])
ok(Number(clearLog.n) === 2, 'clear: logged')
const afterClear = (await rx(A, { routine_id: LOWER, date: today })).out.prescription
ok(afterClear.override == null, 'clear: the source date follows the plan again')

// ---- isolation -------------------------------------------------------------------
ok((await call('B', 'preview_session_override', { date: D1, session: UPPER, ops: [{ op: 'drop', exercise_name: 'Plank' }] }, coachB)).includes('No session'), 'isolation: B cannot preview on A\'s session')
ok(!(await call('B', 'preview_session_override', { date: D1, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }, coachB)).includes('preview_id:'), 'isolation: B name lookup only sees B sessions')
const pA = await call('A', 'preview_session_override', { date: D2, session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }, coachA)
const refA = await yes(previewIdOf(pA))
ok((await call('B', 'apply_session_override', { preview_id: previewIdOf(pA), confirm: true, approval_ref: refA }, coachB)).includes('no such preview'), 'isolation: B cannot apply A\'s preview, even with A\'s approval')
ok((await call('B', 'preview_clear_session_override', { override_id: row1!.id }, coachB)).includes('No active override'), 'isolation: B cannot clear A\'s override')
ok((await listOverrides(storeB, { includeInactive: true }))?.length === 0, 'isolation: B lists none of A\'s overrides')
ok((await call('B', 'list_session_overrides', { include_inactive: true }, coachB)).includes('No week-only overrides'), 'isolation: B MCP list is empty')
ok((await rx(B, { routine_id: UPPER, date: D1 })).status === 404, 'isolation: B session-rx cannot read A\'s session')
const bOwn = await rx(B, { routine_id: ROUTINE_B, date: D1 })
ok(bOwn.status === 200 && bOwn.out.prescription.override == null, 'isolation: A\'s override never reaches B\'s session-rx')
const [bApp] = await athleteOverrideAction(storeB, { action: 'apply', preview_id: appPreview.preview_id })
ok((bApp as { ok: boolean }).ok === false, 'isolation: B app route cannot apply A\'s preview')
ok(await countRows('session_override', B) === 0 && await countRows('session_override_log', B) === 0, 'isolation: nothing written on B')

// ---- never touched -----------------------------------------------------------------
const [revisionsAfter] = await harness.query<{ n: string }>('SELECT count(*)::text AS n FROM program_revision')
ok(revisionsAfter.n === revisionsBefore.n, 'template: no program_revision rows (the program never changed)')
ok(await templateOf(LOWER) === lowerTemplate && await templateOf(UPPER) === upperTemplate, 'template: both routines exactly as seeded')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`session override: ok (${harness.backend})`)
