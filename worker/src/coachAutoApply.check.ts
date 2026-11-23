// Coach auto-apply for MCP apply_program_edits: setting OFF is the same
// writeApprovalProblem refusal as before; ON applies a pending program-edit
// proposal with proposal_id + confirm=true and no approval_ref; notices +
// athlete-only Undo restore the prior program version exactly; dismiss and
// 7-day expiry refuse both paths. Scope is program edits only.
// Synthetic athletes A and B from isolation-seed.sql.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/coachAutoApply.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'
import { writeApprovalProblem } from './changeLog.ts'
import { APP_COACH, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool } from './tools.ts'
import { loadLiveProgram, makeStore } from './store.ts'
import { createApproval } from './approvals.ts'
import { declineProposal, listProposals } from './proposals.ts'
import {
  AUTO_APPLY_APPROVAL_REF, captureProgramVersion, coachAutoApplyOn,
  listAutoApplyNotices, programVersionsEqual, undoAutoApplyNotice,
} from './coachAutoApply.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'

const OFF_REFUSAL = writeApprovalProblem({ type: 'mcp', id: TOKEN_A_ID }, undefined)
ok(
  OFF_REFUSAL === 'Refused: approval_ref is required (the approval the athlete created for this preview; see list_approvals). Only logging (results, notes, measurements) has standing approval.',
  'OFF-path proof: writeApprovalProblem string is unchanged',
)

const toolsSrc = readFileSync(join(here, 'tools.ts'), 'utf8')
const applyCase = toolsSrc.slice(toolsSrc.indexOf("case 'apply_program_edits':"), toolsSrc.indexOf("default:"))
ok(applyCase.includes('writeApprovalProblem(actor, args.approval_ref)'), 'OFF path: apply_program_edits still calls writeApprovalProblem')
ok(applyCase.includes('await coachAutoApplyOn(store)'), 'apply_program_edits is the only tool that calls coachAutoApplyOn')

const sqlSrc = readFileSync(join(here, '../schema/coach-auto-apply.sql'), 'utf8')
ok(/ADD COLUMN IF NOT EXISTS coach_auto_apply BOOLEAN NOT NULL DEFAULT false/.test(sqlSrc), 'migration: additive BOOLEAN DEFAULT false')
ok(!/\bDROP\b|\bRENAME\b|\bALTER COLUMN\b|\bTYPE\b/.test(sqlSrc.replace(/--.*$/gm, '')), 'migration: no drops, renames, or type changes')
ok(!/SET coach_auto_apply\s*=\s*true/i.test(sqlSrc), 'migration: does not turn the setting on')
ok(!/SET coach_auto_apply\s*=\s*true/i.test(readFileSync(join(here, 'coachAutoApply.ts'), 'utf8')), 'worker: does not turn the setting on')

const harness = await openIsolationHarness()
const sql = harness.sql
await harness.query(`UPDATE athlete SET adult_confirmed_at = NOW()`)
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const call = (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A) =>
  executeZeroedTool(sql, athlete, name, args, {}, actor)
async function callErr(name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> {
  try {
    return await call(name, args, actor, athlete)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const squatEdit = {
  type: 'update_exercise',
  session_name: 'A day',
  exercise_name: 'Back Squat',
  sets: 4,
  rationale: 'A little more volume this week.',
}
const originalSquat = '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy","cue":"A squat"}]'
function squatSets(ex: unknown): number {
  const arr = typeof ex === 'string' ? JSON.parse(ex) as Array<{ name?: string; sets?: number }> : ex
  const hit = Array.isArray(arr) ? arr.find((e) => e.name === 'Back Squat') : undefined
  return Number(hit?.sets ?? -1)
}
async function restoreSquat() {
  await harness.query(`UPDATE routine SET exercises = $1::jsonb WHERE id = $2`, [originalSquat, ROUTINE_A])
}
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const setAuto = async (athleteId: string, on: boolean) => {
  await sql`UPDATE athlete SET coach_auto_apply = ${on} WHERE id = ${athleteId}`
}
async function park(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const text = await call('preview_program_edits', { propose: true, title, edits: [squatEdit], ...extra })
  ok(text.includes('Parked') || text.includes('Already parked'), `park: ${title} (${text.slice(0, 80)})`)
  const [row] = await harness.query<{ id: string }>(
    `SELECT id::text AS id FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [A],
  )
  return row?.id ?? ''
}

// ---- default OFF, settings path ----------------------------------------------------
ok(await coachAutoApplyOn(storeA) === false, 'default: coachAutoApplyOn is false')
const [seeded] = await harness.query<{ on: boolean }>(`SELECT coach_auto_apply AS on FROM athlete WHERE id = $1`, [A])
ok(seeded?.on === false, 'default: isolation seed did not turn it on')
const readOff = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'athlete', op: 'select', columns: 'coach_auto_apply', single: 'maybe',
})
ok((readOff.data as { coach_auto_apply?: boolean } | null)?.coach_auto_apply === false, 'settings: /api/data reads coach_auto_apply as false')
const wroteOn = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'athlete', op: 'update', values: { coach_auto_apply: true },
  filters: [{ column: 'id', op: 'eq', value: A }],
})
ok(wroteOn.error == null, 'settings: /api/data update ON has no error')
const readOn = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'athlete', op: 'select', columns: 'coach_auto_apply', single: 'maybe',
})
ok((readOn.data as { coach_auto_apply?: boolean } | null)?.coach_auto_apply === true, 'settings: /api/data can turn it on')
const wroteOff = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'athlete', op: 'update', values: { coach_auto_apply: false },
  filters: [{ column: 'id', op: 'eq', value: A }],
})
ok(wroteOff.error == null, 'settings: /api/data update OFF has no error')
const readBack = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'athlete', op: 'select', columns: 'coach_auto_apply', single: 'maybe',
})
ok((readBack.data as { coach_auto_apply?: boolean } | null)?.coach_auto_apply === false, 'settings: /api/data can turn it back off')

await flag(A, true)
await flag(B, true)

// ---- setting OFF: byte-for-byte writeApprovalProblem --------------------------------
const offId = await park('OFF squat volume')
const offApply = await call('apply_program_edits', { confirm: true, proposal_id: offId })
ok(offApply === OFF_REFUSAL, 'setting OFF: apply_program_edits without approval_ref is byte-for-byte writeApprovalProblem')
const [stillPending] = await harness.query<{ status: string; exercises: unknown }>(
  `SELECT p.status, r.exercises FROM coach_proposal p, routine r WHERE p.id = $1 AND r.id = $2`,
  [offId, ROUTINE_A],
)
ok(stillPending?.status === 'pending' && squatSets(stillPending.exercises) === 3, 'setting OFF: nothing was written')

// ---- confirm missing / false, ON or OFF --------------------------------------------
ok(
  (await call('apply_program_edits', { proposal_id: offId })).includes('requires confirm=true'),
  'confirm missing: refused (setting OFF)',
)
ok(
  (await call('apply_program_edits', { confirm: false, proposal_id: offId })).includes('requires confirm=true'),
  'confirm false: refused (setting OFF)',
)
await setAuto(A, true)
ok(
  (await call('apply_program_edits', { proposal_id: offId })).includes('requires confirm=true'),
  'confirm missing: refused (setting ON)',
)
ok(
  (await call('apply_program_edits', { confirm: false, proposal_id: offId })).includes('requires confirm=true'),
  'confirm false: refused (setting ON)',
)

// ---- another athlete's proposal ----------------------------------------------------
await setAuto(B, true)
ok(
  (await call('apply_program_edits', { confirm: true, proposal_id: offId }, coachB, B)).includes('No such proposal'),
  'isolation: B cannot auto-apply A\'s proposal',
)

// ---- other tools still need approval_ref when ON -----------------------------------
ok(
  (await callErr('create_track', { name: 'Speed', purpose: 'sprints', confirm: true })).includes('approval_ref is required'),
  'scope: create_track still needs approval_ref when auto-apply is ON',
)
ok(
  (await call('apply_program_edits', { confirm: true, edits: [squatEdit] })).includes('approval_ref is required'),
  'scope: apply_program_edits(edits) still needs approval_ref when auto-apply is ON',
)
ok(
  (await call('apply_program_edits', { confirm: true, proposal_id: offId }, APP_COACH)).includes('app_coach cannot supply approval_ref'),
  'auth: app_coach cannot auto-apply',
)

// ---- setting ON: applies without approval_ref --------------------------------------
const liveBefore = await loadLiveProgram(storeA)
if (!liveBefore) throw new Error('no live program')
const prior = await captureProgramVersion(storeA, liveBefore)
const onApply = await call('apply_program_edits', { confirm: true, proposal_id: offId })
ok(!/^Refused/.test(onApply) && onApply.startsWith('Applied'), `setting ON: applied without approval_ref (${onApply.slice(0, 80)})`)
const [applied] = await harness.query<{ status: string; sets: number }>(
  `SELECT p.status, (SELECT (e->>'sets')::int FROM jsonb_array_elements(r.exercises) e WHERE e->>'name' = 'Back Squat' LIMIT 1) AS sets
   FROM coach_proposal p, routine r WHERE p.id = $1 AND r.id = $2`,
  [offId, ROUTINE_A],
)
ok(applied?.status === 'applied' && applied.sets === 4, 'setting ON: proposal applied and squat is 4x5')
const [logRow] = await harness.query<{ approval_ref: string | null; tool: string }>(
  `SELECT approval_ref, tool FROM change_log WHERE athlete_id = $1 ORDER BY created_at DESC LIMIT 1`,
  [A],
)
ok(logRow?.approval_ref === AUTO_APPLY_APPROVAL_REF && logRow.tool === 'accept_proposal', 'setting ON: change_log uses standing:coach_auto_apply')
const notices = await listAutoApplyNotices(storeA)
ok(notices != null && notices.length === 1 && notices[0].undone_at == null, 'notice: one open auto-apply notice')
ok(/Back Squat/.test(notices![0].diff_text) && /3/.test(notices![0].diff_text) && /4/.test(notices![0].diff_text), `notice: plain-language diff (${notices![0].diff_text})`)

// ---- undo round-trip ---------------------------------------------------------------
const noticeId = notices![0].id
const firstUndo = await undoAutoApplyNotice(storeA, noticeId)
ok(firstUndo.ok && !('already' in firstUndo && firstUndo.already), `undo: restored (${firstUndo.text})`)
const liveAfterUndo = await loadLiveProgram(storeA)
if (!liveAfterUndo) throw new Error('no live program after undo')
const restored = await captureProgramVersion(storeA, liveAfterUndo)
ok(programVersionsEqual(prior, restored), 'undo: restored program is deep-equal to the prior version')
const [squatBack] = await harness.query<{ exercises: unknown }>(`SELECT exercises FROM routine WHERE id = $1`, [ROUTINE_A])
ok(squatSets(squatBack?.exercises) === 3, 'undo: squat is back to 3 sets')
const secondUndo = await undoAutoApplyNotice(storeA, noticeId)
ok(secondUndo.ok && secondUndo.already === true, 'undo: second tap is idempotent')
ok(programVersionsEqual(prior, await captureProgramVersion(storeA, (await loadLiveProgram(storeA))!)), 'undo: idempotent tap leaves the program equal')
const otherUndo = await undoAutoApplyNotice(storeB, noticeId)
ok(!otherUndo.ok && otherUndo.status === 'not_found', 'undo: athlete-only — B cannot undo A\'s notice')

// ---- dismiss -----------------------------------------------------------------------
await restoreSquat()
const dismissId = await park('Dismiss this squat')
const dismissYes = await createApproval(storeA, { type: 'athlete', id: A }, { preview_id: dismissId })
ok(dismissYes.ok, 'dismiss: athlete can approve a pending proposal')
const dismissed = await declineProposal(storeA, dismissId)
ok(dismissed.ok && dismissed.status === 'declined', 'dismiss: declineProposal marks it declined')
ok(
  (await call('apply_program_edits', { confirm: true, proposal_id: dismissId })).includes('already declined'),
  'dismiss: auto-apply path refuses a dismissed proposal',
)
await setAuto(A, false)
ok(
  (await call('apply_program_edits', { confirm: true, proposal_id: dismissId, approval_ref: dismissYes.ok ? dismissYes.approval_ref : '' })).includes('already declined'),
  'dismiss: approval path refuses a dismissed proposal',
)

// ---- 7-day expiry, both paths ------------------------------------------------------
await setAuto(A, true)
const expireId = await park('Expire this squat')
const expireYes = await createApproval(storeA, { type: 'athlete', id: A }, { preview_id: expireId })
ok(expireYes.ok, 'expiry: athlete can approve before it ages out')
await harness.query(`UPDATE coach_proposal SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [expireId])
const listed = await listProposals(storeA)
ok(!(listed ?? []).some((p) => p.id === expireId), 'expiry: 8-day-old pending proposal is hidden at read time')
ok(
  (await call('apply_program_edits', { confirm: true, proposal_id: expireId })).includes('expired'),
  'expiry: auto-apply path refuses at 7 days',
)
await setAuto(A, false)
ok(
  (await call('apply_program_edits', { confirm: true, proposal_id: expireId, approval_ref: expireYes.ok ? expireYes.approval_ref : '' })).includes('expired'),
  'expiry: approval path refuses at 7 days',
)
const [expireRow] = await harness.query<{ status: string }>(`SELECT status FROM coach_proposal WHERE id = $1`, [expireId])
ok(expireRow?.status !== 'applied', 'expiry: neither path applied the expired proposal')
const [stillSquat] = await harness.query<{ exercises: unknown }>(`SELECT exercises FROM routine WHERE id = $1`, [ROUTINE_A])
ok(squatSets(stillSquat?.exercises) === 3, 'expiry: the program was not changed')

await harness.close()
console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('coachAutoApply: ok')
