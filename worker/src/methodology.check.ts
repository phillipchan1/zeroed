// Methodology as config (G3), preview validators (G5) and proposal created_by
// (G10 follow-up) against a real schema. Flag off: session-rx, previews,
// proposals and the MCP tool list are exactly as before. Flag on:
// prescriptions carry methodology_version and run on the resolved params;
// overrides go preview → athlete approval → apply and are logged; minors only
// tighten; a raised pain cap is refused for minors; red flags block; previews
// warn (U8–U10) and fail on U13; revoking a coach voids only that coach's
// proposals and approvals. Athletes A and B never see each other's rows.
// Synthetic athletes A and B from isolation-seed.sql.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/methodology.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'
import { createApproval } from './approvals.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteOverrideAction, athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { METHODOLOGY_TOOLS } from './methodology.ts'
import { makeStore } from './store.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_A2_ID = 'aaaa6666-0000-4000-8000-0000000000a2'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
// Section 11b: no age on file means the under-18 rules. These synthetic
// athletes are confirmed adults; ageStatus.check.ts covers unknown age.
await harness.query(`UPDATE athlete SET adult_confirmed_at = NOW()`)
const storeA = makeStore(sql, A)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachA2: OverrideActor = { type: 'mcp', id: TOKEN_A2_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const athleteA: OverrideActor = { type: 'athlete', id: A }

await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'second coach', 'hash-a2', 'aaa2')`,
  [TOKEN_A2_ID, A],
)

const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const chp = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? /preview_id: (chp_[0-9a-f]+)/.exec(text)?.[1] ?? ''
type Rx = { prescription: { exercises: Array<{ name: string; load: number | null; rpe: number | null; skip: boolean; reasons: string[] }>; methodology_version?: string; version: string }; version: string; program_version: string; methodology_version?: string }
const rx = async (athleteId = A, routine = A_DAY) => {
  const [out] = await sessionRxForAthlete(sql, athleteId, { routine_id: routine, unit: 'lb', storage_unit: 'lb' })
  return { out: out as Rx, text: JSON.stringify(out) }
}
const strip = (text: string) => JSON.stringify(JSON.parse(text), (k, v) => (k === 'methodology_version' ? undefined : v))
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const tap = async (previewId: string) => {
  const r = await createApproval(storeA, athleteA, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const squat = (r: Rx) => r.prescription.exercises.find((e) => e.name === 'Back Squat')!
const plyoAfterSquat = [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' }]

// ---- flag OFF: exactly as before -----------------------------------------------------------
const off = await rx()
ok(!off.text.includes('methodology_version'), 'flag off: session-rx has no methodology_version')
ok(off.out.prescription.exercises.length === 1 && squat(off.out).load != null, 'flag off: the squat is prescribed')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list unchanged (no methodology tools)')
ok((await call('get_methodology', {})).includes('Unknown tool'), 'flag off: get_methodology is unknown')
const offPreview = await call('preview_program_edits', { edits: plyoAfterSquat })
ok(!offPreview.includes('## Warnings') && !offPreview.includes('preview_id'), 'flag off: preview_program_edits has no warnings (and no kept preview)')
const offPark = await call('preview_program_edits', { propose: true, title: 'Old-style proposal.', edits: [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' }] })
ok(offPark.includes('Parked'), 'flag off: proposals park as before')
const [offProp] = await harness.query<{ id: string; created_by: string | null }>(`SELECT id::text AS id, created_by FROM coach_proposal WHERE athlete_id = $1 ORDER BY created_at DESC LIMIT 1`, [A])
ok(offProp.created_by == null, 'flag off: no created_by written')
ok(await count('methodology_override') === 0 && await count('change_log') === 0, 'flag off: no override or change_log rows')

// ---- flag ON ------------------------------------------------------------------------------
await flag(A, true)
const on = await rx()
ok(on.out.methodology_version === 'v1.2' && on.out.prescription.methodology_version === 'v1.2', 'flag on: session-rx and the prescription record methodology v1.2')
ok(strip(on.text) === off.text, 'flag on, defaults: every number and version string is byte-identical to flag off')
const [versionOnly] = await sessionRxForAthlete(sql, A, { routine_id: A_DAY, version_only: true })
ok((versionOnly as { methodology_version?: string }).methodology_version === 'v1.2', 'flag on: version_only carries it too')
const onTools = await zeroedToolsFor(sql, A)
ok(METHODOLOGY_TOOLS.every((t) => onTools.some((x) => x.name === t.name)), 'flag on: methodology tools are listed')
ok(JSON.stringify(onTools.find((t) => t.name === 'preview_program_edits')?.inputSchema).includes('rewrite'), 'flag on: preview_program_edits takes rewrite')

// G5 on program edits.
const warned = await call('preview_program_edits', { edits: plyoAfterSquat })
ok(warned.includes('## Warnings') && warned.includes('"rule": "U8"') && chp(warned) !== '', 'U8: the preview warns and still keeps a preview')
const twoNew = [
  { type: 'add_exercise', session_name: 'A day', exercise_name: 'Romanian Deadlift', sets: 3, reps: '8', load: 'moderate' },
  { type: 'add_exercise', session_name: 'A day', exercise_name: 'Walking Lunge', sets: 3, reps: '10', load: 'moderate' },
]
const u13 = await call('preview_program_edits', { edits: twoNew })
ok(u13.startsWith('Refused (U13)') && chp(u13) === '', 'U13: 2 changes on a 1-exercise week fail the preview, nothing kept')
ok((await call('preview_program_edits', { edits: twoNew, propose: true, title: 'Two adds.' })).startsWith('Refused (U13)'), 'U13: nor is it parked as a proposal')
ok(chp(await call('preview_program_edits', { edits: twoNew, rewrite: true })) !== '', 'U13: rewrite=true lets the preview through')
ok(!(await call('preview_program_edits', { edits: [{ type: 'update_exercise', session_name: 'A day', exercise_name: 'Back Squat', sets: 4 }] })).includes('## Warnings'), 'clean: a set change warns about nothing')

// G5 on week-only overrides (MCP and the athlete's own app preview).
const today = await athleteToday(storeA)
const ovWarn = await call('preview_session_override', { date: today, session: A_DAY, ops: [{ op: 'add', exercise: { name: 'Box Jump', sets: 3, reps: '3' } }] })
ok(ovWarn.includes('## Warnings') && ovWarn.includes('"rule": "U8"') && /preview_id: sop_/.test(ovWarn), 'U8: an override preview warns, and is kept')
const [appOut] = await athleteOverrideAction(storeA, { action: 'preview', date: today, session: A_DAY, ops: [{ op: 'add', exercise: { name: 'Box Jump', sets: 3, reps: '3' } }] })
ok(((appOut as { warnings?: Array<{ rule: string }> }).warnings ?? []).some((w) => w.rule === 'U8'), 'U8: the app preview returns structured warnings')
const ovBig = await call('preview_session_override', { date: today, session: A_DAY, ops: [
  { op: 'add', exercise: { name: 'Romanian Deadlift', sets: 3, reps: '8' } },
  { op: 'add', exercise: { name: 'Walking Lunge', sets: 3, reps: '10' } },
] })
ok(ovBig.startsWith('Refused (U13)'), 'U13: an override that rewrites the week fails without rewrite=true')
const [cleanOut] = await athleteOverrideAction(storeA, { action: 'preview', date: today, session: A_DAY, ops: [{ op: 'adjust', exercise_name: 'Back Squat', sets: 4 }] })
ok(JSON.stringify((cleanOut as { warnings?: unknown[] }).warnings) === '[]', 'clean: an override set change warns about nothing')

// get_methodology.
const got = JSON.parse(await call('get_methodology', {})) as { methodology_version: string; params: { U4: { tm_fraction: number } }; overrides: unknown[]; overridable_paths: string[] }
ok(got.methodology_version === 'v1.2' && got.params.U4.tm_fraction === 0.9 && got.overrides.length === 0, 'get_methodology: v1.2, defaults, no overrides')
ok(got.overridable_paths.includes('U4.tm_fraction') && got.overridable_paths.some((p) => p.startsWith('U7.regions.')), 'get_methodology: lists the overridable paths')

// Unknown paths and bad values.
ok((await call('preview_methodology_override', { path: 'U4.secret', value: 1 })).includes('unknown methodology path'), 'override: unknown path refused')
ok((await call('preview_methodology_override', { path: 'U4.tm_fraction', value: 2 })).startsWith('Refused'), 'override: out of range refused')
ok((await call('preview_methodology_override', { path: 'U7.red_flags_block', value: false })).includes('always block'), 'override: red flags can\'t be switched off')

// An engine override: preview → approval → apply.
const pTm = await call('preview_methodology_override', { path: 'U4.tm_fraction', value: 0.85, rationale: 'Grinding reps two weeks running; run off a lighter TM (U4).' })
const pTmId = chp(pTm)
ok(pTmId !== '' && pTm.includes('0.9') && pTm.includes('0.85'), 'override: preview shows before → after')
ok(await count('methodology_override') === 0, 'override: preview writes nothing')
ok((await call('apply_methodology_override', { preview_id: pTmId, confirm: true })).includes('approval_ref is required'), 'override: apply needs approval_ref')
ok((await call('apply_methodology_override', { preview_id: pTmId, confirm: true, approval_ref: 'standing:logging' })).includes('logging only'), 'override: standing approval does not cover it')
ok((await call('apply_methodology_override', { preview_id: pTmId, confirm: true, approval_ref: 'tap:aaaaaaaa-0000-4000-8000-000000000000' })).includes('no such approval'), 'override: a forged approval is refused')
ok((await call('apply_methodology_override', { preview_id: pTmId, confirm: false, approval_ref: 'tap:x' })).includes('confirm=true'), 'override: confirm=true required')
const refTm = await tap(pTmId)
ok((await call('apply_methodology_override', { preview_id: pTmId, confirm: true, approval_ref: refTm }, { type: 'app_coach', id: 'app_coach' })).includes('app_coach cannot'), 'override: app_coach can never apply')
const appliedTm = await call('apply_methodology_override', { preview_id: pTmId, confirm: true, approval_ref: refTm })
ok(appliedTm.startsWith('Set U4.tm_fraction'), `override: applies with the athlete's approval (${appliedTm.slice(0, 80)})`)
ok((await call('apply_methodology_override', { preview_id: pTmId, confirm: true, approval_ref: refTm })).startsWith('Refused'), 'override: applies once')
const [tmRow] = await harness.query<{ value: number; approval_ref: string; methodology_version: string; actor_id: string; change_id: string }>(
  `SELECT value, approval_ref, methodology_version, actor_id, change_id::text AS change_id FROM methodology_override WHERE athlete_id = $1 AND path = 'U4.tm_fraction'`, [A],
)
ok(Number(tmRow?.value) === 0.85 && tmRow.approval_ref === refTm && tmRow.methodology_version === 'v1.2' && tmRow.actor_id === TOKEN_A_ID, 'override: row records value, approval, base version, who')
const [tmLog] = await harness.query<{ tool: string; rule_refs: string[]; methodology_version: string; approval_ref: string; preview_id: string }>(
  `SELECT tool, rule_refs, methodology_version, approval_ref, preview_id FROM change_log WHERE id::text = $1`, [tmRow.change_id],
)
ok(tmLog?.tool === 'apply_methodology_override' && JSON.stringify(tmLog.rule_refs) === '["U4"]' && tmLog.approval_ref === refTm && tmLog.preview_id === pTmId, 'override: logged in change_log with rule_refs')
ok(/^v1\.2\+[0-9a-f]{8}$/.test(tmLog.methodology_version), 'override: the change_log row records the methodology version')
const afterTm = await rx()
ok(/^v1\.2\+[0-9a-f]{8}$/.test(afterTm.out.methodology_version ?? '') && afterTm.out.prescription.methodology_version === afterTm.out.methodology_version, 'override: prescriptions now record v1.2+<overrides>')
ok(afterTm.out.program_version !== on.out.program_version, 'override: program_version bumps so the app refetches')
ok(squat(afterTm.out).load != null && squat(afterTm.out).load! <= squat(on.out).load!, 'override: the engine runs on the lower TM fraction')

// A stale preview: the state moved since.
const pTm2 = chp(await call('preview_methodology_override', { path: 'U4.tm_fraction', value: 0.87 }))
const pTm3 = chp(await call('preview_methodology_override', { path: 'U4.tm_fraction', value: 0.86 }))
const ref3 = await tap(pTm3)
ok((await call('apply_methodology_override', { preview_id: pTm3, confirm: true, approval_ref: ref3 })).startsWith('Set'), 'override: a newer value supersedes')
const ref2 = await tap(pTm2)
ok((await call('apply_methodology_override', { preview_id: pTm2, confirm: true, approval_ref: ref2 })).includes('no longer matches'), 'override: an apply whose diff moved is refused')
ok(await count('methodology_override', 'athlete_id = $1 AND path = $2 AND superseded_at IS NULL', [A, 'U4.tm_fraction']) === 1, 'override: one active row per path')

// Track-level override over the athlete-level one.
const [general] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM track WHERE name = 'General' AND program_id = '33333333-3333-3333-3333-333333333333'`)
const pAth = chp(await call('preview_methodology_override', { path: 'U10.main_lift_rest_s', value: [150, 240] }))
await call('apply_methodology_override', { preview_id: pAth, confirm: true, approval_ref: await tap(pAth) })
const pTrk = chp(await call('preview_methodology_override', { path: 'U10.main_lift_rest_s', value: [180, 300], track: 'General' }))
await call('apply_methodology_override', { preview_id: pTrk, confirm: true, approval_ref: await tap(pTrk) })
const athleteView = JSON.parse(await call('get_methodology', {})) as { params: { U10: { main_lift_rest_s: number[] } } }
const trackView = JSON.parse(await call('get_methodology', { track: general.id })) as { params: { U10: { main_lift_rest_s: number[] } }; methodology_version: string }
ok(JSON.stringify(athleteView.params.U10.main_lift_rest_s) === '[150,240]', 'resolve: athlete override over global')
ok(JSON.stringify(trackView.params.U10.main_lift_rest_s) === '[180,300]', 'resolve: track override over athlete')
ok((await call('preview_methodology_override', { path: 'U4.tm_fraction', value: 0.88, track: 'General' })).includes('per athlete'), 'resolve: engine paths are athlete-wide only')

// Minors: tighten only; no raised pain cap.
await sql`UPDATE athlete SET birth_date = (CURRENT_DATE - INTERVAL '15 years')::date WHERE id = ${A}`
ok((await call('preview_methodology_override', { path: 'minors.max_rpe', value: 9 })).startsWith('Refused'), 'minors: max RPE cannot be raised')
ok(chp(await call('preview_methodology_override', { path: 'minors.max_rpe', value: 7.5 })) !== '', 'minors: it can be tightened')
const minorCap = await call('preview_methodology_override', { path: 'U7.regions.knee.raised_cap', value: true })
ok(minorCap.includes('never allowed for an athlete under 18'), 'minors: a raised pain cap is refused')
ok((await call('preview_methodology_override', { path: 'U5.top_single_rpe', value: [8, 9.5] })).includes('under 18'), 'minors: no override loosens anything')
const minorRx = await rx()
ok(minorRx.out.methodology_version !== afterTm.out.methodology_version, 'minors: the version records the under-18 rules')
ok(minorRx.out.prescription.exercises.every((e) => e.rpe == null || e.rpe <= 8), 'minors: no prescribed RPE above 8')
await sql`UPDATE athlete SET birth_date = NULL, adult_confirmed_at = NULL WHERE id = ${A}`
ok((await call('preview_methodology_override', { path: 'U7.regions.knee.raised_cap', value: true })).includes('date of birth'), 'raised cap: refused while age is unknown')
await sql`UPDATE athlete SET birth_date = '1990-01-01' WHERE id = ${A}`
ok(chp(await call('preview_methodology_override', { path: 'U7.regions.knee.raised_cap', value: true })) !== '', 'raised cap: an adult can opt one region in')

// Red flags block, in the engine and in previews.
const pFlag = chp(await call('preview_methodology_override', { path: 'U7.regions.knee.blocked', value: true, rationale: 'Knee locking (U7); referred out.' }))
await call('apply_methodology_override', { preview_id: pFlag, confirm: true, approval_ref: await tap(pFlag) })
const flaggedRx = await rx()
ok(squat(flaggedRx.out).skip === true && squat(flaggedRx.out).load == null && squat(flaggedRx.out).reasons[0].includes('Red flag'), 'red flag: session-rx does not load the region')
ok((await call('preview_program_edits', { edits: [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Bulgarian Split Squat', sets: 3, reps: '8', load: 'moderate' }] })).startsWith('Refused (U7)'), 'red flag: a preview that loads the region fails')
ok((await call('preview_methodology_override', { path: 'U7.regions.knee.raised_cap', value: true })).includes('red flag'), 'red flag: no raised cap on a flagged region')
ok((await call('preview_methodology_override', { path: 'U7.regions.knee.blocked', clear: true })).includes('only the athlete'), 'red flag: a coach cannot clear it')

// Every flag-on change_log row now records a version.
const pTrack = chp(await call('create_track', { name: 'Logged Track', purpose: 'synthetic' }))
await call('create_track', { name: 'Logged Track', purpose: 'synthetic', confirm: true, preview_id: pTrack, approval_ref: await tap(pTrack) })
ok(await count('change_log', 'athlete_id = $1 AND methodology_version IS NULL', [A]) === 0 && await count('change_log', 'athlete_id = $1 AND tool = $2', [A, 'create_track']) === 1, 'change_log: every row records methodology_version')

// ---- isolation ----------------------------------------------------------------------------
await flag(B, true)
const bView = JSON.parse(await call('get_methodology', {}, coachB, B)) as { methodology_version: string; overrides: unknown[] }
ok(bView.methodology_version === 'v1.2' && bView.overrides.length === 0, 'isolation: B sees none of A\'s overrides')
const pA = chp(await call('preview_methodology_override', { path: 'U9.hiit_max_per_week', value: 1 }))
const refA = await tap(pA)
ok((await call('apply_methodology_override', { preview_id: pA, confirm: true, approval_ref: refA }, coachB, B)).includes('no apply_methodology_override preview'), 'isolation: B cannot apply A\'s preview, even with A\'s approval')
ok((await call('preview_methodology_override', { path: 'U10.main_lift_rest_s', value: [120, 200], track: general.id }, coachB, B)).includes('no track'), 'isolation: B cannot target A\'s track')
const [bRx] = await sessionRxForAthlete(sql, B, { routine_id: A_DAY, unit: 'lb' })
ok((bRx as { error?: string }).error === 'not found', 'isolation: B cannot prescribe A\'s session')
ok(await count('methodology_override', 'athlete_id = $1', [B]) === 0, 'isolation: B has no override rows')

// ---- proposal created_by + revocation -------------------------------------------------------
const park = (title: string, name: string, actor: OverrideActor) =>
  call('preview_program_edits', { propose: true, title, edits: [{ type: 'add_exercise', session_name: 'A day', exercise_name: name, sets: 2, reps: '12', load: 'light' }] }, actor)
ok((await park('Add a face pull.', 'Face Pull', coachA)).includes('Parked'), 'created_by: coach A parks')
ok((await park('Add a band pull-apart.', 'Band Pull-Apart', coachA2)).includes('Parked'), 'created_by: the second coach parks')
const props = await harness.query<{ id: string; title: string; created_by: string | null; status: string }>(
  `SELECT id::text AS id, title, created_by, status FROM coach_proposal WHERE athlete_id = $1 AND status = 'pending' ORDER BY created_at`, [A],
)
const propA = props.find((p) => p.title === 'Add a face pull.')!
const propA2 = props.find((p) => p.title === 'Add a band pull-apart.')!
ok(propA.created_by === `mcp:${TOKEN_A_ID}` && propA2.created_by === `mcp:${TOKEN_A2_ID}`, 'created_by: each proposal names its coach')
const apprA = await tap(propA.id)
const apprA2 = await tap(propA2.id)
const [reqBy] = await harness.query<{ requested_by_id: string }>(`SELECT requested_by_id FROM approval WHERE id::text = $1`, [apprA2.slice(4)])
ok(reqBy?.requested_by_id === TOKEN_A2_ID, 'created_by: the approval of a proposal names the coach that asked')
const revoke = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, {
  table: 'mcp_token', op: 'update', values: { revoked_at: new Date().toISOString() }, filters: [{ column: 'id', op: 'eq', value: TOKEN_A2_ID }],
})
ok(revoke.error == null, 'revoke: the app revokes as before')
const after = new Map((await harness.query<{ id: string; status: string; voided_at: string | null }>(
  `SELECT id::text AS id, status, voided_at::text AS voided_at FROM coach_proposal WHERE athlete_id = $1`, [A],
)).map((r) => [r.id, r]))
ok(after.get(propA2.id)?.status === 'stale' && after.get(propA2.id)?.voided_at != null, 'revoke: the revoked coach\'s parked proposal is voided')
ok(after.get(propA.id)?.status === 'pending' && after.get(propA.id)?.voided_at == null, 'revoke: another coach\'s proposal is untouched')
ok(after.get(offProp.id)?.status === 'pending', 'revoke: a pre-G3 proposal (no created_by) is left alone')
const approvals = new Map((await harness.query<{ id: string; voided_at: string | null }>(`SELECT id::text AS id, voided_at::text AS voided_at FROM approval WHERE athlete_id = $1`, [A])).map((r) => [r.id, r]))
ok(approvals.get(apprA2.slice(4))?.voided_at != null && approvals.get(apprA.slice(4))?.voided_at == null, 'revoke: only the revoked coach\'s approvals are voided')
const [revLog] = await harness.query<{ diff: { voided_proposals?: string[]; voided_approvals?: string[] }; methodology_version: string | null }>(
  `SELECT diff, methodology_version FROM change_log WHERE athlete_id = $1 AND tool = 'revoke_coach' AND target_id = $2`, [A, TOKEN_A2_ID],
)
ok(JSON.stringify(revLog?.diff.voided_proposals) === JSON.stringify([propA2.id]) && (revLog.diff.voided_approvals ?? []).includes(apprA2.slice(4)), 'revoke: logged, naming the voided proposal and approval')
ok((await call('apply_program_edits', { confirm: true, proposal_id: propA2.id, approval_ref: apprA2 })).includes('already stale'), 'revoke: the voided proposal can\'t be applied')

// ---- rollback: flag off ----------------------------------------------------------------------
await flag(A, false)
const back = await rx()
ok(!back.text.includes('methodology_version') && squat(back.out).skip !== true && back.text === off.text, 'rollback: flag off, overrides ignored and session-rx is exactly as before')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'rollback: tool list back to ZEROED_TOOLS')
ok((await call('get_methodology', {})).includes('Unknown tool'), 'rollback: methodology tools unknown again')

await harness.close()
console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`methodology: ok (${harness.backend})`)
