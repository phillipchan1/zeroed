// Approval capture (G10) against a real schema: flag off nothing changes and no
// approval rows exist; flag on, only the athlete's own session creates an
// approval (a tap, or a chat message they wrote after the preview), and every
// apply path resolves approval_ref to one: same athlete, same preview, same
// diff hash, under 24 h, unconsumed, not voided. Each applies once and names
// the change_log row it produced. Forged, unknown, other-athlete,
// other-preview, consumed, voided and expired refs are refused, as is a diff
// that moved after approval. Coaches (MCP or app_coach) never create one.
// Revoking a coach voids its open previews and approvals and logs both.
// Synthetic athletes A and B from isolation-seed.sql.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/approvals.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'
import { APPROVAL_TOOLS, athleteApprovalAction, createApproval, diffHash, listApprovals } from './approvals.ts'
import { athleteChangeLogAction } from './changeLogRoute.ts'
import { approveAndAccept } from './proposals.ts'
import { APP_COACH, athleteOverrideAction, athleteToday, type OverrideActor } from './sessionOverride.ts'
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
const UPPER = 'c0c0c0c0-0000-4000-8000-000000000002'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const TOKEN_GONE_ID = 'aaaa9999-0000-4000-8000-000000000002'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const coachGone: OverrideActor = { type: 'mcp', id: TOKEN_GONE_ID }
const athleteA: OverrideActor = { type: 'athlete', id: A }
const athleteB: OverrideActor = { type: 'athlete', id: B }

await harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, 'Upper', 'strength', $4::jsonb, 'Upper intent', 3)`,
  [UPPER, PROG_A, PHASE_A, JSON.stringify([
    { name: 'Bench Press', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
    { name: 'Chest-Supported Row', sets: 3, reps: '10', load: 'moderate' },
    { name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' },
  ])],
)
await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'soon-gone', 'hash-soon-gone', 'gone')`,
  [TOKEN_GONE_ID, A],
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
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
type ApprovalRow = { id: string; preview_id: string; preview_kind: string; channel: string; message_id: string | null; requested_by_type: string; requested_by_id: string; consumed_at: string | null; consumed_by_change_id: string | null; voided_at: string | null; diff_hash: string }
const approvalRow = async (ref: string) => (await harness.query<ApprovalRow>(
  `SELECT id::text AS id, preview_id, preview_kind, channel, message_id::text AS message_id, requested_by_type, requested_by_id,
          consumed_at::text AS consumed_at, consumed_by_change_id::text AS consumed_by_change_id, voided_at::text AS voided_at, diff_hash
   FROM approval WHERE id::text = $1`, [ref.slice(4)],
))[0]
const changeRow = async (id: string) => (await harness.query<{ id: string; approval_ref: string | null; approval_id: string | null; preview_id: string | null; tool: string }>(
  `SELECT id::text AS id, approval_ref, approval_id::text AS approval_id, preview_id, tool FROM change_log WHERE id::text = $1`, [id],
))[0]
/** The athlete taps Approve. */
async function tap(previewId: string, store = storeA, actor: OverrideActor = athleteA): Promise<string> {
  const r = await createApproval(store, actor, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
/** A chat message, at an offset from now. */
async function message(athleteId: string, role: 'athlete' | 'coach', offset: string): Promise<string> {
  const [row] = await harness.query<{ id: string }>(
    `INSERT INTO coach_message (athlete_id, role, kind, body, created_at) VALUES ($1, $2, 'chat', 'Sounds good.', NOW() + $3::interval) RETURNING id::text AS id`,
    [athleteId, role, offset],
  )
  return row.id
}
const trackPreview = async (name: string, actor: OverrideActor = coachA, athlete = A) => kept(await call('create_track', { name, purpose: 'synthetic' }, actor, athlete))
const applyTrack = (name: string, previewId: string, ref: string, actor: OverrideActor = coachA, athlete = A) =>
  callErr('create_track', { name, purpose: 'synthetic', confirm: true, preview_id: previewId, approval_ref: ref }, actor, athlete)

// ---- flag OFF: exactly as before ------------------------------------------------------
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: tool list and schemas unchanged (no list_approvals)')
ok((await callErr('list_approvals', { preview_id: 'chp_x' })).includes('Unknown tool'), 'flag off: list_approvals is unknown')
ok((await athleteApprovalAction(storeA, { action: 'approve', preview_id: 'chp_x' }))[1] === 404, 'flag off: /api/approvals reads as absent')
const offCreate = await createApproval(storeA, athleteA, { preview_id: 'chp_x' })
ok(!offCreate.ok && offCreate.reason === 'off', 'flag off: no approval can be created')
ok((await call('create_track', { name: 'Off Track', confirm: true })).includes('Off Track'), 'flag off: a confirmed write needs no approval, as before')
const offPark = await call('preview_program_edits', { propose: true, title: 'Add a carry.', edits: [{ type: 'add_exercise', session_name: 'Upper', exercise_name: 'Farmer Carry', sets: 2, reps: '40m', load: 'moderate' }] })
ok(offPark.includes('Parked'), 'flag off: proposals park as before')
const [offProp] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [A])
const offAccept = await approveAndAccept(storeA, offProp.id)
ok(offAccept.ok && offAccept.status === 'applied' && !('approval_ref' in offAccept), 'flag off: Accept applies exactly as before')
ok(await count('approval') === 0 && await count('change_log') === 0, 'flag off: no approval or change_log rows at all')

// ---- flag ON --------------------------------------------------------------------------
await flag(A, true)
await flag(B, true)
const onTools = await zeroedToolsFor(sql, A)
ok(APPROVAL_TOOLS.every((t) => onTools.some((o) => o.name === t.name)), 'flag on: list_approvals is listed')
ok(!onTools.some((t) => /^(create|mint|record)_approval|^approve/.test(t.name)), 'flag on: no coach tool creates an approval')

// Only the athlete's own session creates an approval.
const pOnly = await trackPreview('Only Athlete')
for (const [actor, label] of [[coachA, 'an MCP coach'], [APP_COACH, 'app_coach'], [{ type: 'system', id: 'x' } as OverrideActor, 'system'], [athleteB, 'another athlete\'s session']] as const) {
  const r = await createApproval(storeA, actor, { preview_id: pOnly })
  ok(!r.ok && r.reason === 'refused', `create: ${label} cannot create an approval`)
}
const viaData = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'approval', op: 'insert',
  values: { preview_id: pOnly, preview_kind: 'change', diff_hash: 'x', channel: 'tap', requested_by_type: 'mcp', requested_by_id: TOKEN_A_ID },
})
ok(viaData.error != null, 'create: the generic data route cannot write approval rows')
ok(await count('approval') === 0, 'create: every refusal wrote nothing')
ok((await callErr('create_track', { name: 'Only Athlete', purpose: 'synthetic', confirm: true, preview_id: pOnly, approval_ref: 'msg:chat-1' }, APP_COACH)).includes('app_coach cannot supply approval_ref'), 'app_coach: cannot pass an approval_ref at all')

// Tap approval → apply works once and only once.
const tap1 = await tap(pOnly)
ok(/^tap:[0-9a-f-]{36}$/.test(tap1), 'tap: the athlete\'s tap returns tap:<approval id>')
const a1 = await approvalRow(tap1)
ok(a1?.preview_id === pOnly && a1.preview_kind === 'change' && a1.channel === 'tap' && a1.message_id == null, 'tap: row bound to the preview, channel tap')
ok(a1?.requested_by_type === 'mcp' && a1.requested_by_id === TOKEN_A_ID, 'tap: row records the coach that asked')
ok(a1?.consumed_at == null && a1.voided_at == null, 'tap: open until used')
const ok1 = await applyTrack('Only Athlete', pOnly, tap1)
ok(ok1.includes('Only Athlete') && !ok1.startsWith('Refused'), `tap: the coach applies with the athlete's approval (${ok1.slice(0, 80)})`)
const a1after = await approvalRow(tap1)
const c1 = await changeRow(String(a1after?.consumed_by_change_id))
ok(a1after?.consumed_at != null && c1?.approval_ref === tap1 && c1.approval_id === a1.id && c1.preview_id === pOnly, 'tap: consumed by the change_log row that links back to it')
ok((await applyTrack('Only Athlete', pOnly, tap1)).includes('already applied'), 'once: the same preview does not apply twice')
const pAgain = await trackPreview('Only Athlete')
const reuse = await applyTrack('Only Athlete', pAgain, tap1)
ok(reuse.includes('different preview'), 'once: an approval does not carry over to a new preview')
const log = JSON.parse(await call('get_change_log', { since: '2026-01-01', limit: 5 })) as { changes: Array<{ id: string; approval_id: string | null }> }
ok(log.changes.find((c) => c.id === c1?.id)?.approval_id === a1.id, 'get_change_log: rows name their approval_id')

// Forged / unknown / malformed.
const pForge = await trackPreview('Forge')
ok((await applyTrack('Forge', pForge, 'tap:forged')).includes('approval_ref must be'), 'forged: malformed tap refused')
ok((await applyTrack('Forge', pForge, 'tap:aaaaaaaa-0000-4000-8000-00000000abcd')).includes('no such approval'), 'forged: an unknown tap id refused')
ok((await applyTrack('Forge', pForge, 'msg:aaaaaaaa-0000-4000-8000-00000000abcd')).includes('no such approval'), 'forged: an unknown msg id refused')
const forgeTap = await tap(pForge)
ok((await applyTrack('Forge', pForge, `msg:${forgeTap.slice(4)}`)).includes('no such approval'), 'forged: a tap approval passed as msg: refused')
ok((await applyTrack('Forge', pForge, 'standing:logging')).includes('logging only'), 'forged: standing approval does not cover it')

// Other preview: an approval binds to one preview.
const pOther = await trackPreview('Other')
ok((await applyTrack('Other', pOther, forgeTap)).includes('different preview'), 'other preview: refused')
// Other athlete: B's approval never resolves on A, and A's never on B.
const pB = await trackPreview('B Thing', coachB, B)
const tapB = await tap(pB, storeB, athleteB)
ok(tapB.startsWith('tap:'), 'B: B approves B\'s own preview')
ok((await applyTrack('Forge', pForge, tapB)).includes('no such approval'), 'other athlete: B\'s approval refused on A')
ok((await applyTrack('B Thing', pB, forgeTap, coachB, B)).includes('no such approval'), 'other athlete: A\'s approval refused on B')
const bOnA = await createApproval(storeB, athleteB, { preview_id: pForge })
ok(!bOnA.ok && bOnA.reason === 'not_found', 'other athlete: B cannot approve A\'s preview')

// Expired: an approval over 24 h old (inserted directly; rows can't be backdated).
const pExp = await trackPreview('Expired')
const [expRow] = await harness.query<{ id: string }>(
  `INSERT INTO approval (athlete_id, preview_id, preview_kind, diff_hash, channel, requested_by_type, requested_by_id, created_at)
   SELECT $1, preview_id, 'change', '', 'tap', 'mcp', $2, NOW() - INTERVAL '25 hours' FROM change_preview WHERE preview_id = $3
   RETURNING id::text AS id`, [A, TOKEN_A_ID, pExp],
)
ok((await applyTrack('Expired', pExp, `tap:${expRow.id}`)).includes('more than 24 h old'), 'expired: an approval over 24 h old refused')
const pOldPrev = await trackPreview('Old Preview')
const tapOld = await tap(pOldPrev)
await harness.query(`UPDATE change_preview SET created_at = NOW() - INTERVAL '25 hours' WHERE preview_id = $1`, [pOldPrev])
ok((await applyTrack('Old Preview', pOldPrev, tapOld)).includes('more than 24 h old'), 'expired: a preview over 24 h old refused even with an approval')
const lateApprove = await createApproval(storeA, athleteA, { preview_id: pOldPrev })
ok(!lateApprove.ok && lateApprove.reason === 'stale', 'expired: a preview over 24 h old cannot be approved')

// Consumed or voided on its own (the preview itself still open): refused.
const pSpent = await trackPreview('Spent')
const [spentRow] = await harness.query<{ id: string }>(
  `INSERT INTO approval (athlete_id, preview_id, preview_kind, diff_hash, channel, requested_by_type, requested_by_id, consumed_at, consumed_by_change_id)
   VALUES ($1, $2, 'change', '', 'tap', 'mcp', $3, NOW(), gen_random_uuid()) RETURNING id::text AS id`, [A, pSpent, TOKEN_A_ID],
)
ok((await applyTrack('Spent', pSpent, `tap:${spentRow.id}`)).includes('already used'), 'consumed: a spent approval is refused')
const [voidRow] = await harness.query<{ id: string }>(
  `INSERT INTO approval (athlete_id, preview_id, preview_kind, diff_hash, channel, requested_by_type, requested_by_id, voided_at)
   VALUES ($1, $2, 'change', '', 'tap', 'mcp', $3, NOW()) RETURNING id::text AS id`, [A, pSpent, TOKEN_A_ID],
)
ok((await applyTrack('Spent', pSpent, `tap:${voidRow.id}`)).includes('voided'), 'voided: a voided approval is refused')

// Diff changed after approval.
const pHash = await trackPreview('Hash')
const [hashRow] = await harness.query<{ id: string }>(
  `INSERT INTO approval (athlete_id, preview_id, preview_kind, diff_hash, channel, requested_by_type, requested_by_id)
   VALUES ($1, $2, 'change', $3, 'tap', 'mcp', $4) RETURNING id::text AS id`, [A, pHash, await diffHash({ something: 'else' }), TOKEN_A_ID],
)
ok((await applyTrack('Hash', pHash, `tap:${hashRow.id}`)).includes('diff changed since the athlete approved'), 'diff: an approval of a different diff is refused')
const today = await athleteToday(storeA)
const pOv = sop(await call('preview_session_override', { date: addDays(today, 1), session: 'Upper', ops: [{ op: 'adjust', exercise_name: 'Plank', reps: '45s' }] }))
const tapOv = await tap(pOv)
ok((await approvalRow(tapOv))?.preview_kind === 'session_override', 'diff: an override preview approval is kind session_override')
await harness.query(`UPDATE routine SET exercises = jsonb_set(exercises, '{2,reps}', '"40s"') WHERE id = $1`, [UPPER])
const movedText = await call('apply_session_override', { preview_id: pOv, confirm: true, approval_ref: tapOv })
ok(movedText.startsWith('Refused') && /no longer matches|changed since/.test(movedText), 'diff: the session moved after approval → refused')
ok((await approvalRow(tapOv))?.consumed_at == null && await count('session_override', 'athlete_id = $1', [A]) === 0, 'diff: nothing written, the approval not spent')

// Session override: the approval is spent in the same statement as the write.
const pOv2 = sop(await call('preview_session_override', { date: addDays(today, 2), session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }))
const tapOv2 = await tap(pOv2)
const ovApplied = await call('apply_session_override', { preview_id: pOv2, confirm: true, approval_ref: tapOv2 })
ok(ovApplied.startsWith('Applied 1'), `override: applies with the athlete's approval (${ovApplied.slice(0, 60)})`)
const ovApproval = await approvalRow(tapOv2)
const ovChange = await changeRow(String(ovApproval?.consumed_by_change_id))
ok(ovChange?.tool === 'apply_session_override' && ovChange.approval_id === ovApproval?.id, 'override: consumed by its change_log row')
ok(await count('session_override', 'preview_id = $1 AND approval_ref = $2', [pOv2, tapOv2]) === 1, 'override: the row records the approval_ref')
const pOv3 = sop(await call('preview_session_override', { date: addDays(today, 3), session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }))
ok((await call('apply_session_override', { preview_id: pOv3, confirm: true, approval_ref: tapOv2 })).includes('different preview'), 'override: a spent approval does not apply elsewhere')

// The athlete's own app apply mints its tap server-side, and spends it.
const [ownPrev] = await athleteOverrideAction(storeA, { action: 'preview', date: addDays(today, 4), session: UPPER, ops: [{ op: 'drop', exercise_name: 'Plank' }] })
const ownId = (ownPrev as { preview_id: string }).preview_id
const [ownApplied] = await athleteOverrideAction(storeA, { action: 'apply', preview_id: ownId, approval_ref: 'tap:aaaaaaaa-0000-4000-8000-00000000abcd' })
ok((ownApplied as { ok: boolean }).ok === true, 'own apply: the athlete\'s tap applies their own preview')
const [ownApproval] = await harness.query<ApprovalRow>(`SELECT requested_by_type, consumed_at::text AS consumed_at FROM approval WHERE preview_id = $1`, [ownId])
ok(ownApproval?.requested_by_type === 'athlete' && ownApproval.consumed_at != null, 'own apply: a real approval row, spent (client-sent ref ignored)')

// Chat approvals.
const pChat = await trackPreview('Chat')
const chatOf = (messageId: unknown) => createApproval(storeA, athleteA, { preview_id: pChat, message_id: messageId })
const fromCoach = await chatOf(await message(A, 'coach', '1 second'))
ok(!fromCoach.ok && fromCoach.text.includes('written by the coach'), 'chat: a coach-authored message is not the athlete\'s yes')
const older = await chatOf(await message(A, 'athlete', '-1 hour'))
ok(!older.ok && older.text.includes('older than the preview'), 'chat: a message older than the preview is refused')
const othersMsg = await chatOf(await message(B, 'athlete', '1 second'))
ok(!othersMsg.ok && othersMsg.reason === 'not_found', 'chat: another athlete\'s message is refused')
const madeUp = await chatOf('aaaaaaaa-0000-4000-8000-00000000abcd')
ok(!madeUp.ok && madeUp.reason === 'not_found', 'chat: an unknown message is refused')
ok(!(await chatOf('chat-1')).ok, 'chat: a non-id message ref is refused')
const yesMsg = await message(A, 'athlete', '1 second')
const chatYes = await chatOf(yesMsg)
ok(chatYes.ok && chatYes.approval_ref.startsWith('msg:') && chatYes.channel === 'chat', 'chat: the athlete\'s newer message is an approval, msg:<approval id>')
ok(chatYes.ok && (await approvalRow(chatYes.approval_ref))?.message_id === yesMsg, 'chat: the row keeps the message id')
const listedChat = await call('list_approvals', { preview_id: pChat })
ok(chatYes.ok && listedChat.includes(chatYes.approval_ref) && listedChat.includes('"open"'), 'chat: list_approvals shows the coach the athlete\'s approval')
ok((await call('list_approvals', { preview_id: pChat }, coachB, B)).includes('No approvals'), 'isolation: B\'s coach cannot list A\'s approvals')
ok(chatYes.ok && !(await applyTrack('Chat', pChat, chatYes.approval_ref)).startsWith('Refused'), 'chat: the coach applies with it')
ok(chatYes.ok && (await applyTrack('Chat', pChat, chatYes.approval_ref)).includes('already applied'), 'chat: once only')

// Proposals: Accept is approve + apply.
const parked = await call('preview_program_edits', { propose: true, title: 'Add face pulls.', edits: [{ type: 'add_exercise', session_name: 'Upper', exercise_name: 'Face Pull', sets: 2, reps: '15', load: 'light' }] })
ok(parked.includes('Parked'), 'proposal: parked')
const [prop] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [A])
ok((await call('apply_program_edits', { confirm: true, proposal_id: prop.id, approval_ref: forgeTap })).includes('different preview'), 'proposal: another preview\'s approval refused')
ok((await call('apply_program_edits', { confirm: true, proposal_id: prop.id, approval_ref: `tap:${prop.id}` })).includes('no such approval'), 'proposal: the old tap:<proposal id> form is refused')
ok(await count('coach_proposal', 'id = $1 AND status = $2', [prop.id, 'pending']) === 1, 'proposal: refusals leave it pending')
const accept = await approveAndAccept(storeA, prop.id)
ok(accept.ok && accept.status === 'applied', `proposal: Accept approves and applies (${accept.text.slice(0, 60)})`)
const propApproval = await approvalRow(String(accept.approval_ref))
const propChange = await changeRow(String(propApproval?.consumed_by_change_id))
ok(propApproval?.preview_kind === 'proposal' && propApproval.preview_id === prop.id && propChange?.tool === 'accept_proposal' && propChange.approval_id === propApproval.id, 'proposal: the approval is recorded and spent by the accept')
ok(!(await approveAndAccept(storeA, prop.id)).ok, 'proposal: a second Accept does nothing')
ok(!(await approveAndAccept(storeB, prop.id)).ok, 'isolation: B cannot accept A\'s proposal')
// A proposal whose program moved after approval goes stale.
await call('preview_program_edits', { propose: true, title: 'Add curls.', edits: [{ type: 'add_exercise', session_name: 'Upper', exercise_name: 'Curl', sets: 2, reps: '12', load: 'light' }] })
const [prop2] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [A])
const chatMsg2 = await message(A, 'athlete', '1 second')
const prop2Yes = await createApproval(storeA, athleteA, { preview_id: prop2.id, message_id: chatMsg2 })
ok(prop2Yes.ok && prop2Yes.preview_kind === 'proposal', 'proposal: approvable in chat')
const pMove = await call('preview_program_edits', { edits: [{ type: 'update_exercise', session_name: 'Upper', exercise_name: 'Bench Press', sets: 5 }] })
await call('apply_program_edits', { edits: [{ type: 'update_exercise', session_name: 'Upper', exercise_name: 'Bench Press', sets: 5 }], confirm: true, preview_id: kept(pMove), approval_ref: await tap(kept(pMove)) })
const staleAccept = await call('apply_program_edits', { confirm: true, proposal_id: prop2.id, approval_ref: prop2Yes.ok ? prop2Yes.approval_ref : '' })
ok(staleAccept.includes('changed after') && prop2Yes.ok && (await approvalRow(prop2Yes.approval_ref))?.consumed_at == null, 'proposal: the program moved after approval → stale, approval unspent')

// Undo: the athlete's tap is an approval of kind revert, spent by the undo.
const tm = await call('set_training_max', { lift: 'bench', training_max: 205 })
await call('set_training_max', { lift: 'bench', training_max: 205, confirm: true, preview_id: kept(tm), approval_ref: await tap(kept(tm)) })
const [tmChange] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM change_log WHERE athlete_id = $1 AND tool = 'set_training_max' ORDER BY created_at DESC LIMIT 1`, [A])
// A coach's undo suggestion is not approved directly; the Undo tap is its approval.
const pSuggest = await call('preview_revert_change', { change_id: tmChange.id })
const suggestId = /preview_id: (chp_[0-9a-f]+)/.exec(pSuggest)?.[1] ?? ''
const suggestApproval = await createApproval(storeA, athleteA, { preview_id: suggestId })
ok(suggestId !== '' && !suggestApproval.ok && suggestApproval.text.includes('Changes'), 'undo: a coach suggestion is approved by the Undo tap, not separately')
const undone = (await athleteChangeLogAction(storeA, { action: 'revert', id: tmChange.id }))[0] as { ok: boolean; change_id: string }
ok(undone.ok, 'undo: applies')
const undoRow = await changeRow(undone.change_id)
ok(undoRow?.approval_id != null && (await approvalRow(String(undoRow.approval_ref)))?.preview_kind === 'revert' && (await approvalRow(String(undoRow.approval_ref)))?.consumed_by_change_id === undone.change_id, 'undo: its approval row is spent by the undo')

// The app route.
const pRoute = await trackPreview('Route')
const [routeOut, routeStatus] = await athleteApprovalAction(storeA, { action: 'approve', preview_id: pRoute })
ok(routeStatus === 200 && (routeOut as { ok: boolean; approval_ref: string }).approval_ref?.startsWith('tap:'), 'route: approve returns the tap ref')
const [routeList] = await athleteApprovalAction(storeA, { action: 'list', preview_id: pRoute })
ok((routeList as { approvals: unknown[] }).approvals.length === 1, 'route: list shows it')
const [routeB] = await athleteApprovalAction(storeB, { action: 'approve', preview_id: pRoute })
ok((routeB as { ok: boolean; reason: string }).reason === 'not_found', 'isolation: B\'s route cannot approve A\'s preview')

// Revocation voids the coach's open previews AND unconsumed approvals, logged.
const pGone1 = await trackPreview('Gone One', coachGone)
const pGone2 = sop(await call('preview_session_override', { date: addDays(today, 5), session: 'Upper', ops: [{ op: 'drop', exercise_name: 'Plank' }] }, coachGone))
const pGone3 = await trackPreview('Gone Three', coachGone)
const goneTap1 = await tap(pGone1)
const goneTap2 = await tap(pGone2)
const goneTap3 = await tap(pGone3)
ok(!(await applyTrack('Gone Three', pGone3, goneTap3, coachGone)).startsWith('Refused'), 'revoke: before revoking, the coach applies normally')
const revoke = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'mcp_token', op: 'update', values: { revoked_at: new Date().toISOString() }, filters: [{ column: 'id', op: 'eq', value: TOKEN_GONE_ID }],
})
ok(revoke.error == null, 'revoke: the app revokes as before')
ok((await approvalRow(goneTap1))?.voided_at != null && (await approvalRow(goneTap2))?.voided_at != null, 'revoke: the coach\'s open approvals are voided')
ok((await approvalRow(goneTap3))?.voided_at == null && (await approvalRow(goneTap3))?.consumed_at != null, 'revoke: a spent approval stays as it was')
ok(await count('change_preview', 'preview_id = $1 AND voided_at IS NOT NULL', [pGone1]) === 1, 'revoke: the coach\'s open preview is voided')
const [revLog] = await harness.query<{ diff: { voided_previews: string[]; voided_approvals: string[] } }>(
  `SELECT diff FROM change_log WHERE athlete_id = $1 AND tool = 'revoke_coach' AND target_id = $2`, [A, TOKEN_GONE_ID],
)
ok(revLog?.diff.voided_previews.includes(pGone1) && revLog.diff.voided_previews.includes(pGone2) && revLog.diff.voided_approvals.length === 2
  && revLog.diff.voided_approvals.includes(goneTap1.slice(4)) && revLog.diff.voided_approvals.includes(goneTap2.slice(4)), 'revoke: logged once, naming voided previews and approvals')
ok((await applyTrack('Gone One', pGone1, goneTap1)).includes('voided'), 'revoke: a voided approval cannot be applied by anyone')
const goneOv = await call('apply_session_override', { preview_id: pGone2, confirm: true, approval_ref: goneTap2 })
ok(goneOv.startsWith('Refused') && goneOv.includes('voided'), 'revoke: the voided override approval cannot be applied')
const goneNew = await createApproval(storeA, athleteA, { preview_id: pGone1 })
ok(!goneNew.ok, 'revoke: the athlete cannot approve a revoked coach\'s preview')

// Append-only.
let blocked = 0
const spentId = a1.id
for (const q of [
  `UPDATE approval SET diff_hash = 'x' WHERE id = '${spentId}'`,
  `UPDATE approval SET consumed_at = NULL, consumed_by_change_id = NULL WHERE id = '${spentId}'`,
  `UPDATE approval SET consumed_at = NOW(), consumed_by_change_id = '${spentId}' WHERE id = '${spentId}'`,
  `UPDATE approval SET voided_at = NOW() WHERE id = '${spentId}'`,
  `UPDATE approval SET voided_at = NULL WHERE id = '${goneTap1.slice(4)}'`,
  `DELETE FROM approval WHERE id = '${spentId}'`,
]) {
  try { await harness.query(q) } catch { blocked++ }
}
ok(blocked === 6, `append-only: no edits, no un-consume, no re-consume, no void after use, no un-void, no delete (${blocked}/6)`)

// Isolation of reads.
const aIds = new Set((await listApprovals(storeA, { limit: 100 }))!.map((r) => r.approval_ref))
ok(((await listApprovals(storeB, { limit: 100 })) ?? []).every((r) => !aIds.has(r.approval_ref)), 'isolation: B lists none of A\'s approvals')
ok(await count('approval', 'athlete_id = $1', [B]) === 1, 'isolation: B has only its own approval')

// ---- rollback: flag off again -----------------------------------------------------------
await flag(A, false)
const approvalsBefore = await count('approval')
ok((await call('create_track', { name: 'After Rollback', confirm: true })).includes('After Rollback'), 'rollback: flag off writes without approval again')
ok((await athleteApprovalAction(storeA, { action: 'list' }))[1] === 404, 'rollback: /api/approvals reads as absent')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'rollback: tool list back to exactly ZEROED_TOOLS')
ok(await count('approval') === approvalsBefore, 'rollback: flag off writes no approval rows')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`approvals: ok (${harness.backend})`)
