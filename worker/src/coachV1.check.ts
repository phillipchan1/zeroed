// coach_v1 (G6 + G7) against a real schema. Flag off (or tracks_v1 off):
// the MCP tool list, every tool, /api/session-rx and the routes are exactly
// as before and nothing is written. Flag on: activities and composed blocks
// go preview → the athlete's approval → apply, once, logged; the section 4
// worked example end to end; trade-offs block the apply until the athlete
// picks; the app coach (app_coach) runs only through the MCP tool functions,
// its reads are logged, and it can never approve, pass approval_ref or
// confirm a write; chat approvals need the athlete's own yes, newer than the
// preview, and apply once; intake stops on a red flag and tightens for
// minors; athlete A never reads or writes athlete B's rows. Synthetic data.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/coachV1.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { createApproval } from './approvals.ts'
import { ACTIVITY_TOOLS, coachV1On, recomposeDue } from './activities.ts'
import { appCoachMayCall, appCoachTurn, athleteCoachAction, runAppCoachTool, type AppCoachModel } from './appCoach.ts'
import { SECTION_8_GUARDRAILS, SUPPLEMENT_REFUSAL, NUTRITION_REFUSAL, MINOR_NUTRITION_REFUSAL, guardReply, appCoachSystemPrompt } from './coach/prompt.ts'
import { clearRegion } from './readiness.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { APP_COACH, athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import { addDaysIso } from './coach/composer.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '66666666-6666-4666-8666-666666666666'
const D = '88888888-8888-4888-8888-888888888888'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const athleteA: OverrideActor = { type: 'athlete', id: A }

// Two more synthetic athletes: C (under 18) and D (red flag at intake).
for (const [id, user, name] of [[C, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Athlete C'], [D, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Athlete D']]) {
  await harness.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, `${name.slice(-1).toLowerCase()}@example.com`])
  await harness.query(`INSERT INTO athlete (id, auth_user_id, name, training_age, sessions_per_week) VALUES ($1, $2, $3, 2, 3)`, [id, user, name])
}
const storeC = makeStore(sql, C)
const storeD = makeStore(sql, D)

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
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
async function flags(athleteId: string, f: { tracks?: boolean; coach?: boolean }) {
  for (const [k, on] of [['tracks_v1', f.tracks], ['coach_v1', f.coach]] as const) {
    if (on === undefined) continue
    if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || jsonb_build_object(${k}::text, true) WHERE id = ${athleteId}`
    else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - ${k}::text WHERE id = ${athleteId}`
  }
}
async function tap(previewId: string, store = storeA, actor: OverrideActor = athleteA): Promise<string> {
  const r = await createApproval(store, actor, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
const rx = async () => JSON.stringify(await sessionRxForAthlete(sql, A, { routine_id: ROUTINE_A, unit: 'lb', storage_unit: 'lb' }))
const coachRowCount = async () => await count('activity') + await count('composed_block') + await count('coach_intake')

/** A scripted model: each round returns the next turn. */
function scripted(turns: Array<{ reply: string; tool_calls?: Array<{ name: string; arguments: string }>; escalate?: 'disagreed_twice' | 'red_flag' | 'rule_conflict' | null }>): AppCoachModel & { seen: unknown[] } {
  let i = 0
  const seen: unknown[] = []
  const fn = (async ({ payload }: { system: string; payload: unknown }) => {
    seen.push(payload)
    const t = turns[Math.min(i++, turns.length - 1)]
    return { reply: t.reply, tool_calls: t.tool_calls ?? [], rule_refs: ['U2'], escalate: t.escalate ?? null }
  }) as AppCoachModel & { seen: unknown[] }
  fn.seen = seen
  return fn
}

await harness.query(`INSERT INTO athlete_goal (athlete_id, name, metric, unit, direction, target, due_date, test_protocol) VALUES ($1, 'Back Squat 1RM', 'Back Squat', 'lb', 'higher', 315, CURRENT_DATE + 120, 'Back Squat 1RM')`, [A])
await harness.query(`INSERT INTO athlete_goal (athlete_id, name, metric, unit, direction, target) VALUES ($1, 'B Row 2k', 'Row 2k', 's', 'lower', 420)`, [B])

// ---- flag OFF: exactly as before ---------------------------------------------------------------
const rxBefore = await rx()
await flags(A, { coach: true })   // coach_v1 without tracks_v1 does not count
ok(!(await coachV1On(storeA)), 'coach_v1 without tracks_v1 is off')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: tool list is exactly ZEROED_TOOLS')
ok((await callErr('get_activities', {})).includes('Unknown tool'), 'flag off: get_activities is unknown')
ok((await callErr('preview_composed_block', {})).includes('Unknown tool'), 'flag off: preview_composed_block is unknown')
ok((await athleteCoachAction(storeA, { action: 'state' }, { model: null }))[1] === 404, 'flag off: /api/coach reads as absent')
ok((await appCoachTurn(sql, A, { message: 'hi' }, { model: scripted([{ reply: 'x' }]) })).status === 404, 'flag off: no app-coach turn')
ok((await runAppCoachTool(sql, A, { name: 'get_goals', arguments: '{}' })).refused?.includes('off') === true, 'flag off: the app coach calls nothing')
ok(await rx() === rxBefore, 'flag off: /api/session-rx unchanged')

await flags(A, { tracks: true, coach: false })
const tracksList = await zeroedToolsFor(sql, A)
ok(!tracksList.some((t) => ACTIVITY_TOOLS.some((x) => x.name === t.name)), 'tracks_v1 only: no coach_v1 tools in the list')
ok((await callErr('get_activities', {})).includes('Unknown tool'), 'tracks_v1 only: get_activities is unknown')
ok((await athleteCoachAction(storeA, { action: 'state' }, { model: null }))[1] === 404, 'tracks_v1 only: /api/coach reads as absent')
const rxTracks = await rx()
ok(await coachRowCount() === 0 && await count('coach_message', `kind = 'chat'`) === 0, 'flag off: no coach_v1 rows and no chat rows written')

// ---- flag ON ------------------------------------------------------------------------------------
await flags(A, { coach: true })
await flags(B, { tracks: true, coach: true })
ok(await coachV1On(storeA), 'coach_v1 + tracks_v1: on')
const coachList = await zeroedToolsFor(sql, A)
ok(JSON.stringify(coachList) === JSON.stringify([...tracksList, ...ACTIVITY_TOOLS]), 'flag on: the tracks_v1 list, unchanged, plus the 5 coach_v1 tools at the end')
ok(await rx() === rxTracks, 'flag on, no block applied: /api/session-rx unchanged')

const readsBefore = await count('coach_read_log', `athlete_id = $1 AND tool = 'get_activities'`, [A])
const acts0 = JSON.parse(await call('get_activities', {}))
ok(Array.isArray(acts0.activities) && acts0.activities.length === 0 && acts0.recompose.reason === 'no_block' && acts0.modules.catalog.length === 5, 'get_activities: empty, recompose due (no block), 5 modules')
ok(await count('coach_read_log', `athlete_id = $1 AND tool = 'get_activities'`, [A]) === readsBefore + 1, 'get_activities is a logged coach read')

// Activity: preview → approval → apply, once.
const actPrev = await call('preview_activity_change', { op: 'add', module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'in', days: [3], rationale: 'Games count as load (U9, U14).' })
const actId = kept(actPrev)
ok(actId.startsWith('chp_') && await count('activity') === 0, 'preview_activity_change: kept preview, nothing written')
ok((await callErr('apply_activity_change', { preview_id: actId, confirm: true })).includes('approval_ref is required'), 'apply_activity_change: refused without approval_ref')
ok((await callErr('apply_activity_change', { preview_id: actId, confirm: true, approval_ref: 'standing:logging' })).includes('standing approval covers logging only'), 'apply_activity_change: standing approval does not cover it')
const actRef = await tap(actId)
ok(actRef.startsWith('tap:'), 'the athlete approves the activity preview')
const actApplied = await call('apply_activity_change', { preview_id: actId, confirm: true, approval_ref: actRef })
ok(actApplied.startsWith('Added Rec basketball') && /Re-composed/.test(actApplied), 'apply_activity_change: added, and a re-composed block preview comes back')
const [actRow] = await harness.query<{ id: string; module_key: string; days: unknown; change_id: string }>(`SELECT id::text AS id, module_key, days, change_id::text AS change_id FROM activity WHERE athlete_id = $1`, [A])
ok(actRow?.module_key === 'court' && String(actRow.days).replace(/[{}[\] ]/g, '') === '3', 'activity row written for A')
const [actLog] = await harness.query<{ approval_ref: string; preview_id: string; actor_type: string; tool: string }>(`SELECT approval_ref, preview_id, actor_type, tool FROM change_log WHERE id::text = $1`, [actRow.change_id])
ok(actLog?.tool === 'apply_activity_change' && actLog.approval_ref === actRef && actLog.preview_id === actId && actLog.actor_type === 'mcp', 'one change_log row with the approval and the preview')
ok((await callErr('apply_activity_change', { preview_id: actId, confirm: true, approval_ref: actRef })).includes('already'), 'apply_activity_change: applies once')

// Worked example, part 1: the squat goal as priority.
const blockPrev = await call('preview_composed_block', {
  goal_weights: [{ goal: 'Back Squat 1RM', weight: 'priority' }],
  schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] },
  training_age: '3to10',
  rationale: 'One priority strength goal; basketball counts as conditioning (U2, U9).',
})
const blockId = kept(blockPrev)
const blockJson = JSON.parse(/\{\n {2}"preview_id"[\s\S]*?\n\}/.exec(blockPrev)![0])
ok(blockJson.block.priorities.join() === 'Max strength' && !blockJson.block.needs_decision, 'block preview: max strength is the one priority, nothing to decide')
ok(blockJson.methodology_version === 'v1' && blockJson.modules_version === 'modules-v1', 'block preview: records the methodology and module versions')
ok(blockJson.block.tracks.find((t: { name: string }) => t.name === 'Aerobic')?.added_per_week === 1, 'block preview: 1 aerobic session added (basketball supplies the other)')
ok(await count('composed_block') === 0, 'block preview: nothing written')
const blockRef = await tap(blockId)
const blockApplied = await call('apply_composed_block', { preview_id: blockId, confirm: true, approval_ref: blockRef })
ok(blockApplied.startsWith('Applied the composed block'), 'apply_composed_block: applied with the athlete\'s approval')
const [cb] = await harness.query<{ id: string; methodology_version: string; modules_version: string; approval_ref: string; change_id: string; program_id: string }>(`SELECT id::text AS id, methodology_version, modules_version, approval_ref, change_id::text AS change_id, program_id::text AS program_id FROM composed_block WHERE athlete_id = $1`, [A])
ok(cb?.methodology_version === 'v1' && cb.modules_version === 'modules-v1' && cb.approval_ref === blockRef && cb.program_id === PROG_A, 'composed_block row: versions, approval, program')
const [cbLog] = await harness.query<{ tool: string; target_type: string; methodology_version: string; diff: { tracks: unknown[]; program_meta: { after: { deload_week_start: string } } } }>(`SELECT tool, target_type, methodology_version, diff FROM change_log WHERE id::text = $1`, [cb.change_id])
ok(cbLog?.tool === 'apply_composed_block' && cbLog.target_type === 'composed_block' && cbLog.methodology_version === 'v1', 'composed block: one change_log row, stamped with the methodology version')
ok(Array.isArray(cbLog.diff.tracks) && cbLog.diff.tracks.length >= 5 && !!cbLog.diff.program_meta.after.deload_week_start, 'composed block diff: tracks and program dates before → after')
ok(await count('track', `program_id = $1 AND name IN ('Max strength', 'Other lifts', 'Aerobic', 'Repeat sprint', 'Power')`, [PROG_A]) === 5, 'tracks created in A\'s program')
ok(await count('progression_rule', `program_id = $1 AND engine_type = 'tm_wave'`, [PROG_A]) === 1, 'a tm_wave rule for the priority track')
ok(await count('athlete_goal', `athlete_id = $1 AND name = 'Back Squat 1RM' AND weight = 'priority' AND quality = 'max_strength'`, [A]) === 1, 'goal weight + quality written')
ok(await count('athlete_goal', `athlete_id = $1 AND name LIKE 'Screen: %'`, [A]) === 3, 'court screens became monthly screen goals')
const [meta] = await harness.query<{ deload_week_start: string; retest_start: string }>(`SELECT deload_week_start::text AS deload_week_start, retest_start::text AS retest_start FROM program WHERE id = $1`, [PROG_A])
ok(!!meta.deload_week_start && addDaysIso(meta.deload_week_start, 7) === meta.retest_start, 'program: deload week then retest week')
ok(await recomposeDue(storeA) === null, 'after apply: no re-compose due')
ok((await callErr('apply_composed_block', { preview_id: blockId, confirm: true, approval_ref: blockRef })).includes('already'), 'apply_composed_block: applies once')
const [{ training_max_overrides: tmo }] = await harness.query<{ training_max_overrides: unknown }>(`SELECT training_max_overrides FROM athlete WHERE id = $1`, [A])
ok(tmo == null, 'training_max_overrides untouched')

// Worked example, part 2: a half-marathon goal flips running to priority and flags the trade-off.
const due = addDaysIso(await athleteToday(storeA), 70)
const halfPrev = await call('preview_composed_block', { add_goals: [{ name: 'Half marathon', test: 'Half marathon', weight: 'priority', due_date: due }] })
const halfId = kept(halfPrev)
ok(/Trade-offs for the athlete to pick/.test(halfPrev) && /interference/.test(halfPrev) && /Not appliable yet/.test(halfPrev), 'half: the preview flags the strength trade-off')
const halfRef = await tap(halfId)
ok((await callErr('apply_composed_block', { preview_id: halfId, confirm: true, approval_ref: halfRef })).includes('has not picked interference'), 'half: undecided → apply refused, even approved')
const picked = await athleteCoachAction(storeA, { action: 'repreview', preview_id: halfId, resolutions: { interference: 'endurance_first' } }, { model: null })
const pickedBody = picked[0] as { ok: boolean; preview_id: string; block: { priorities: string[]; needs_decision: boolean; goals: Array<{ name: string; role: string; note: string | null }> } }
ok(pickedBody.ok && pickedBody.block.priorities.join() === 'Aerobic' && !pickedBody.block.needs_decision, 'half: the athlete picks; running is the priority')
ok(pickedBody.block.goals.find((g) => g.name === 'Back Squat 1RM')?.role === 'maintenance' && /not dropped/i.test(pickedBody.block.goals.find((g) => g.name === 'Back Squat 1RM')?.note ?? ''), 'half: lifting at maintenance, the strength goal kept')
const appliedHalf = await athleteCoachAction(storeA, { action: 'approve', preview_id: pickedBody.preview_id }, { model: null })
ok((appliedHalf[0] as { applied: boolean }).applied === true, 'half: the athlete\'s tap approves and applies it')
ok(await count('composed_block', `athlete_id = $1 AND superseded_at IS NOT NULL`, [A]) === 1 && await count('composed_block', `athlete_id = $1 AND superseded_at IS NULL`, [A]) === 1, 'half: the new block supersedes the old')
ok(await count('athlete_goal', `athlete_id = $1 AND name = 'Half marathon' AND weight = 'priority' AND quality = 'aerobic'`, [A]) === 1, 'half: the race goal was added')
const [{ start_date: liveStart }] = await harness.query<{ start_date: string }>(`SELECT start_date::text AS start_date FROM composed_block WHERE athlete_id = $1 AND superseded_at IS NULL`, [A])
ok(await count('progression_rule', `program_id = $1 AND active_from <= $2::date AND (active_to IS NULL OR active_to >= $2::date)
  AND track_id IN (SELECT id FROM track WHERE program_id = $1 AND name = 'Max strength')`, [PROG_A, liveStart]) === 1, 'half: one live rule per track after re-composing (the old block\'s rule ended)')
let blockedUpdate = false
try { await harness.query(`UPDATE composed_block SET block = '{}'::jsonb WHERE athlete_id = $1`, [A]) } catch { blockedUpdate = true }
ok(blockedUpdate, 'composed_block is append-only')

// Re-compose triggers and stale previews.
const stalePrev = kept(await call('preview_composed_block', {}))
await harness.query(`INSERT INTO activity (athlete_id, module_key, name, sessions_per_week, season, days) VALUES ($1, 'field', 'Sunday soccer', 1, 'in', '{6}')`, [A])
ok(await recomposeDue(storeA) === 'inputs_changed', 'an activity added → re-compose due')
const staleRef = await tap(stalePrev)
ok((await callErr('apply_composed_block', { preview_id: stalePrev, confirm: true, approval_ref: staleRef })).includes('no longer matches'), 'a block preview whose inputs moved is refused')
await harness.query(`UPDATE activity SET active = false WHERE athlete_id = $1 AND name = 'Sunday soccer'`, [A])

// Revoking a coach voids its open activity/block previews (and their approvals) at once.
const TOKEN_A2 = 'aaaa5555-0000-4000-8000-000000000003'
await harness.query(`INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'coach-a2', 'hash-a2', 'aa22')`, [TOKEN_A2, A])
const revPrev = kept(await call('preview_activity_change', { op: 'add', module: 'general', name: 'Gym class', sessions_per_week: 1, season: 'in', days: [5] }, { type: 'mcp', id: TOKEN_A2 }))
const revRef = await tap(revPrev)
const { liveCoachTokenIds, voidRevokedCoachPreviews } = await import('./changeLog.ts')
const wasLive = await liveCoachTokenIds(storeA)
await harness.query(`UPDATE mcp_token SET revoked_at = NOW() WHERE id = $1`, [TOKEN_A2])
await voidRevokedCoachPreviews(storeA, wasLive)
ok(await count('change_preview', `preview_id = $1 AND voided_at IS NOT NULL`, [revPrev]) === 1, 'revoke: the coach\'s open activity preview is voided')
ok((await callErr('apply_activity_change', { preview_id: revPrev, confirm: true, approval_ref: revRef }, { type: 'mcp', id: TOKEN_A2 })).includes('voided'), 'revoke: and can no longer be applied')
ok(await count('change_log', `athlete_id = $1 AND tool = 'revoke_coach' AND target_id = $2`, [A, TOKEN_A2]) === 1, 'revoke: logged')

// ---- app_coach: the same tools, no extra powers -------------------------------------------------------
const acPrev = await runAppCoachTool(sql, A, { name: 'preview_composed_block', arguments: '{}' })
ok(acPrev.ok && acPrev.preview_ids.length === 1, 'app_coach previews a block through the MCP tool')
const acRef = await tap(acPrev.preview_ids[0])
ok((await runAppCoachTool(sql, A, { name: 'apply_composed_block', arguments: JSON.stringify({ preview_id: acPrev.preview_ids[0], confirm: true, approval_ref: acRef }) })).refused !== null, 'app_coach boundary: no apply_*')
ok((await runAppCoachTool(sql, A, { name: 'preview_composed_block', arguments: JSON.stringify({ approval_ref: acRef }) })).refused?.includes('approval_ref') === true, 'app_coach boundary: never passes approval_ref')
ok((await runAppCoachTool(sql, A, { name: 'create_track', arguments: JSON.stringify({ name: 'Sneaky', confirm: true }) })).refused !== null, 'app_coach boundary: no gated write')
ok((await runAppCoachTool(sql, A, { name: 'drop_everything', arguments: '{}' })).refused?.includes('not a tool') === true, 'app_coach boundary: only tools the athlete\'s coaches have')
ok((await runAppCoachTool(sql, A, { name: 'get_goals', arguments: 'not json' })).refused?.includes('JSON') === true, 'app_coach boundary: bad arguments refused')
// Underneath the boundary, the G10 gate refuses app_coach on its own.
const direct = await callErr('apply_composed_block', { preview_id: acPrev.preview_ids[0], confirm: true, approval_ref: acRef }, APP_COACH)
ok(direct.includes('app_coach cannot supply approval_ref'), 'G10 gate: app_coach can never write approval_ref, even with a real approval')
ok((await callErr('apply_activity_change', { preview_id: actId, confirm: true, approval_ref: acRef }, APP_COACH)).includes('app_coach cannot supply approval_ref'), 'G10 gate: nor for an activity')
const acApprove = await createApproval(storeA, APP_COACH, { preview_id: acPrev.preview_ids[0] })
ok(!acApprove.ok && /in-app coach cannot approve/.test(acApprove.text), 'app_coach can never create an approval')
ok((await clearRegion(storeA, APP_COACH, 'knee')).ok === false, 'app_coach cannot clear a region')
ok(appCoachMayCall('get_goals') && appCoachMayCall('preview_program_edits') && appCoachMayCall('log_goal_measurement') && !appCoachMayCall('apply_program_edits') && !appCoachMayCall('upsert_goal') && !appCoachMayCall('set_training_max'), 'app_coach kinds: reads, previews, logging only')
const readLogBefore = await count('coach_read_log', `athlete_id = $1 AND actor_type = 'app_coach'`, [A])
await runAppCoachTool(sql, A, { name: 'get_goals', arguments: '{}' })
ok(await count('coach_read_log', `athlete_id = $1 AND actor_type = 'app_coach' AND tool = 'get_goals'`, [A]) >= 1 && await count('coach_read_log', `athlete_id = $1 AND actor_type = 'app_coach'`, [A]) === readLogBefore + 1, 'app_coach reads are logged')
const sys = appCoachSystemPrompt({ minor: false, tools: ['get_goals'] })
ok(sys.includes(SECTION_8_GUARDRAILS) && SECTION_8_GUARDRAILS.includes('No supplement, drug, PED or medication advice.') && SECTION_8_GUARDRAILS.includes('Nutrition basics only:'), 'system prompt carries section 8 verbatim')
ok(/pain \/ red flags.*readiness.*progression call \(U5\).*schedule conflicts \(U8–U10\).*smallest edit/.test(sys) && /Cite the rule \(U#\)/.test(sys), 'system prompt: decision procedure in order, cite rule refs')

// A turn: the model asks for a mix of allowed and forbidden calls.
const chatBefore = await count('coach_message', `athlete_id = $1 AND kind = 'chat'`, [A])
const model = scripted([
  { reply: 'Let me look.', tool_calls: [
    { name: 'get_activities', arguments: '{}' },
    { name: 'preview_composed_block', arguments: '{"rationale":"Re-compose after the race was added (U2)."}' },
    { name: 'apply_composed_block', arguments: `{"preview_id":"${acPrev.preview_ids[0]}","confirm":true,"approval_ref":"${acRef}"}` },
    { name: 'upsert_goal', arguments: '{"name":"Sneaky goal","confirm":true}' },
  ] },
  { reply: 'Here is the re-composed block. Tap Approve or reply yes (U2).' },
])
const turn = await appCoachTurn(sql, A, { message: 'What does my week look like now?' }, { model })
ok(turn.ok && turn.reply?.role === 'coach' && /re-composed block/.test(turn.reply.body), 'turn: the coach reply is stored as role coach')
ok(turn.tool_calls?.map((c) => `${c.name}:${c.ok}`).join() === 'get_activities:true,preview_composed_block:true,apply_composed_block:false,upsert_goal:false', 'turn: reads and previews run; apply and writes are refused')
ok(turn.previews?.length === 1 && turn.previews[0].startsWith('chp_'), 'turn: the preview id comes back for the app')
ok(await count('athlete_goal', `athlete_id = $1 AND name = 'Sneaky goal'`, [A]) === 0, 'turn: nothing the model asked to write was written')
ok(await count('coach_message', `athlete_id = $1 AND kind = 'chat'`, [A]) === chatBefore + 2, 'turn: one athlete row + one coach row')
const [{ role: msgRole }] = await harness.query<{ role: string }>(`SELECT role FROM coach_message WHERE id::text = $1`, [turn.message_id])
ok(msgRole === 'athlete', 'turn: the athlete\'s message is role athlete')
const ctx = (model.seen[0] as { context: Record<string, string> }).context
ok(Object.keys(ctx).join() === 'get_goal_brief,list_tracks,get_current_program,list_workouts,get_checkins,get_region_status,get_change_log,get_activities', 'turn: section 7 context, loaded through the read tools')
ok(await count('coach_read_log', `athlete_id = $1 AND actor_type = 'app_coach' AND tool = 'get_change_log'`, [A]) >= 1, 'turn: its context reads are logged')

// Chat approvals.
const turnPreview = turn.previews![0]
const coachMsgApprove = await createApproval(storeA, athleteA, { preview_id: turnPreview, message_id: turn.reply!.id })
ok(!coachMsgApprove.ok && /written by the coach/.test(coachMsgApprove.text), 'chat approval: the coach\'s own message is never an approval')
const olderMsgApprove = await createApproval(storeA, athleteA, { preview_id: turnPreview, message_id: turn.message_id })
ok(!olderMsgApprove.ok && /older than the preview/.test(olderMsgApprove.text), 'chat approval: a message older than the preview is not a yes to it')
const notYes = await appCoachTurn(sql, A, { message: 'hmm, not sure', approves: turnPreview }, { model: null })
ok(notYes.approval?.ok === false && await count('approval', `preview_id = $1`, [turnPreview]) === 0, 'chat approval: not a yes, no approval')
const yes = await appCoachTurn(sql, A, { message: 'Yes, apply it', approves: turnPreview }, { model: null })
ok(yes.approval?.applied === true && yes.approval.approval_ref?.startsWith('msg:') === true, 'chat approval: the athlete\'s yes approves (msg:) and the app applies')
const [chatApproval] = await harness.query<{ channel: string; message_id: string; consumed_at: string | null }>(`SELECT channel, message_id::text AS message_id, consumed_at::text AS consumed_at FROM approval WHERE id::text = $1`, [yes.approval!.approval_ref!.slice(4)])
ok(chatApproval.channel === 'chat' && chatApproval.message_id === yes.message_id && chatApproval.consumed_at != null, 'chat approval: channel chat, cites the yes message, consumed')
const yesAgain = await appCoachTurn(sql, A, { message: 'yes', approves: turnPreview }, { model: null })
ok(yesAgain.approval?.applied !== true && await count('composed_block', `athlete_id = $1 AND preview_id = $2`, [A, turnPreview]) === 1, 'chat approval: consumed once; a second yes applies nothing')
const [blockActor] = await harness.query<{ actor_type: string; approval_ref: string }>(`SELECT actor_type, approval_ref FROM composed_block WHERE preview_id = $1`, [turnPreview])
ok(!!blockActor && blockActor.actor_type === 'athlete' && blockActor.approval_ref.startsWith('msg:'), 'chat approval: the athlete\'s session applied it, not app_coach')

// Section 8 on the way out, and escalation.
const supp = await appCoachTurn(sql, A, { message: 'What should I take?' }, { model: scripted([{ reply: 'Take 5 g of creatine and 400 mg caffeine.' }]) })
ok(supp.reply?.body === SUPPLEMENT_REFUSAL && supp.guard === 'supplement', 'guardrail: no supplement advice reaches the athlete')
ok(guardReply('Aim for 2,400 calories and 180 g of protein.', { minor: false }).text === NUTRITION_REFUSAL, 'guardrail: no calorie or macro numbers')
ok(guardReply('Eat enough protein, hydrate and sleep.', { minor: false }).guard === null, 'guardrail: nutrition basics pass')
ok(guardReply('Eat enough protein.', { minor: true }).text === MINOR_NUTRITION_REFUSAL, 'guardrail: nothing for minors')
ok(guardReply('Cut back-off volume by one set (U5).', { minor: true }).guard === null, 'guardrail: training talk passes for minors')
const off = await appCoachTurn(sql, A, { message: 'hello' }, { model: null })
ok(off.ok && /not available/.test(off.reply?.body ?? ''), 'no model configured: the coach says so, nothing else changes')
const disagree = await appCoachTurn(sql, A, { message: 'No, I still disagree.' }, { model: scripted([{ reply: 'Understood.', escalate: 'disagreed_twice' }]) })
ok(disagree.escalate === 'disagreed_twice' && /human coach/.test(disagree.reply?.body ?? ''), 'escalate: disagreed twice → a human coach')
ok(await count('coach_message', `athlete_id = $1 AND kind = 'note' AND body LIKE 'Escalated to a human coach%'`, [A]) === 1, 'escalate: noted in the coach log')

// ---- intake -------------------------------------------------------------------------------------------
await flags(C, { tracks: true, coach: true })
await flags(D, { tracks: true, coach: true })
const today = await athleteToday(storeB)
const answers = (over: Record<string, unknown> = {}) => ({
  birth_date: '1992-03-04',
  goals: [{ name: 'Row 2k under 7:00', test: '2k row', current: 440, target: 420, unit: 's', direction: 'lower', due_date: addDaysIso(today, 90), weight: 'priority', quality: 'aerobic' }],
  activities: [{ module: 'court', name: 'Pickup volleyball', sessions_per_week: 1, season: 'in', days: [2] }],
  schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [6], equipment: ['rower', 'barbell'] },
  training_age: '1to3',
  injuries: { history: [{ region: 'shoulder', note: 'old strain' }], pain: [{ region: 'knee', score: 2, red_flags: [] }] },
  screens: [{ key: 'knee_to_wall', value: 9, side: 'L' }, { key: 'knee_to_wall', value: 10, side: 'R' }],
  recovery: { sleep_hours: 7, stress: 2, soreness: 2 },
  ...over,
})
const intakeB = (await athleteCoachAction(storeB, { action: 'intake', answers: answers({ schedule: { days_per_week: 2, minutes_per_session: 60, rest_days: [6], equipment: ['rower'] } }) }, { model: null }))[0] as { ok: boolean; stopped: boolean; preview_id: string; block: { minor: boolean; screens: string[]; needs_decision: boolean } }
ok(intakeB.ok && !intakeB.stopped && intakeB.preview_id.startsWith('chp_') && !intakeB.block.minor, 'intake: a clean adult intake composes one block preview')
const [prevActor] = await harness.query<{ actor_type: string }>(`SELECT actor_type FROM change_preview WHERE preview_id = $1`, [intakeB.preview_id])
ok(prevActor.actor_type === 'app_coach', 'intake: the app coach made the preview')
ok(await count('activity', `athlete_id = $1`, [B]) === 0 && await count('composed_block', `athlete_id = $1`, [B]) === 0, 'intake: nothing applied before the athlete approves')
ok(await count('checkin', `athlete_id = $1`, [B]) === 1 && await count('pain_report', `athlete_id = $1`, [B]) === 1, 'intake: recovery baseline + pain logged as a check-in (standing approval)')
ok(await count('coach_intake', `athlete_id = $1 AND outcome = 'previewed'`, [B]) === 1, 'intake: recorded')
const bTooSoon = (await athleteCoachAction(storeB, { action: 'approve', preview_id: intakeB.preview_id }, { model: null }))[0] as { applied: boolean; text: string }
ok(!bTooSoon.applied && /has not picked time_budget/.test(bTooSoon.text) && intakeB.block.needs_decision, 'intake: work that does not fit 2 × 60 min is a trade-off; no apply until the athlete picks')
const bPicked = (await athleteCoachAction(storeB, { action: 'repreview', preview_id: intakeB.preview_id, resolutions: { time_budget: 'add_day' } }, { model: null }))[0] as { ok: boolean; preview_id: string; block: { needs_decision: boolean } }
ok(bPicked.ok && !bPicked.block.needs_decision, 'intake: the athlete picks another training day')
const bApply = (await athleteCoachAction(storeB, { action: 'approve', preview_id: bPicked.preview_id }, { model: null }))[0] as { applied: boolean; text: string }
ok(bApply.applied === true && /screen baselines?/.test(bApply.text), 'intake: the athlete approves → applied, screen baselines logged')
ok(await count('activity', `athlete_id = $1 AND name = 'Pickup volleyball'`, [B]) === 1 && await count('athlete_goal', `athlete_id = $1 AND name = 'Row 2k under 7:00' AND weight = 'priority'`, [B]) === 1, 'intake: activities and goals written on apply')
ok(await count('goal_measurement', `athlete_id = $1 AND note = 'Intake baseline'`, [B]) === 2, 'intake: both knee-to-wall sides logged as baselines (log_goal_measurement)')
ok(await count('change_log', `athlete_id = $1 AND tool = 'log_goal_measurement' AND approval_ref = 'standing:logging'`, [B]) === 2, 'intake: baselines under standing approval')
const [{ birth_date: bDob }] = await harness.query<{ birth_date: string }>(`SELECT birth_date::text AS birth_date FROM athlete WHERE id = $1`, [B])
ok(bDob === '1992-03-04' && await count('change_log', `athlete_id = $1 AND tool = 'set_birth_date'`, [B]) === 1, 'intake: birth date recorded once, logged')

// Minors.
const kidNo = (await athleteCoachAction(storeC, { action: 'intake', answers: answers({ birth_date: addDaysIso(today, -15 * 365) }) }, { model: null }))[0] as { ok: boolean; needs_consent: boolean }
ok(!kidNo.ok && kidNo.needs_consent, 'minor intake: no plan without parental consent')
ok(await count('athlete', `id = $1 AND birth_date IS NOT NULL`, [C]) === 0 && await count('coach_intake', `athlete_id = $1`, [C]) === 0, 'minor intake: nothing written without consent')
const kid = (await athleteCoachAction(storeC, { action: 'intake', answers: answers({
  birth_date: addDaysIso(today, -15 * 365),
  parental_consent: { guardian_name: 'Sample Guardian', confirmed: true },
  goals: [{ name: 'Back Squat 1RM', test: 'Back Squat 1RM', weight: 'priority', quality: 'max_strength' }, { name: 'Vertical jump', weight: 'maintenance', quality: 'power' }],
  activities: [],
  training_age: '10plus',
}) }, { model: null }))[0] as { ok: boolean; preview_id: string; block: { minor: boolean; tracks: Array<{ name: string; engine: string }>; retest_week: { order: string[] }; warnings: string[] } }
ok(kid.ok && kid.block.minor && kid.block.warnings.some((w) => /Under 18/.test(w)), 'minor intake: composes tightened')
const [kidPrev] = await harness.query<{ diff: { block: { tracks: Array<{ quality: string; params: { max_rpe?: number; top_single_rpe?: number[]; contacts_per_session?: number[] } }>; retest_week: { order: string[] } } } }>(`SELECT diff FROM change_preview WHERE preview_id = $1`, [kid.preview_id])
const kidTracks = kidPrev.diff.block.tracks
ok(kidTracks.find((t) => t.quality === 'max_strength')?.params.max_rpe === 8 && (kidTracks.find((t) => t.quality === 'max_strength')?.params.top_single_rpe ?? [9])[1] <= 8, 'minor: no RPE above 8')
ok((kidTracks.find((t) => t.quality === 'power')?.params.contacts_per_session ?? [999, 999])[1] <= 80, 'minor: lower contacts')
ok(!kidPrev.diff.block.retest_week.order.some((x) => /RPE 10/.test(x)) && kidPrev.diff.block.retest_week.order.some((x) => /no max test/.test(x)), 'minor: no max testing')
ok(await count('coach_intake', `athlete_id = $1 AND minor AND parental_consent ->> 'guardian_name' = 'Sample Guardian'`, [C]) === 1, 'minor: consent recorded')
const kidAdult = (await athleteCoachAction(storeC, { action: 'intake', answers: answers({ birth_date: '1980-01-01' }) }, { model: null }))[0] as { ok: boolean; needs_consent: boolean }
ok(!kidAdult.ok && kidAdult.needs_consent, 'minor: re-entering an adult birth date does not loosen the rules')

// Red flag stops intake.
const flagged = (await athleteCoachAction(storeD, { action: 'intake', answers: answers({ injuries: { history: [], pain: [{ region: 'knee', score: 4, red_flags: ['giving_way'] }] } }) }, { model: null }))[0] as { ok: boolean; stopped: boolean; refer_out: string; preview_id?: string }
ok(flagged.ok && flagged.stopped && /doctor or physio/.test(flagged.refer_out) && !flagged.preview_id, 'red flag: intake stops with the section 8 refer-out')
ok(await count('region_status', `athlete_id = $1 AND region = 'knee' AND status = 'blocked'`, [D]) === 1, 'red flag: the knee is blocked (U7)')
ok(await count('change_preview', `athlete_id = $1 AND tool = 'apply_composed_block'`, [D]) === 0 && await count('coach_intake', `athlete_id = $1 AND outcome = 'stopped'`, [D]) === 1, 'red flag: nothing composed; the stop is recorded')
// D3: a coach D hasn't shared health data with sees that work is held, not where.
const TOKEN_D = 'dddd6666-0000-4000-8000-000000000001'
await harness.query(`INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four, share_health) VALUES ($1, $2, 'coach-d', 'hash-d', 'ddd1', false)`, [TOKEN_D, D])
await harness.query(`INSERT INTO activity (athlete_id, module_key, name, sessions_per_week, season, days) VALUES ($1, 'court', 'Rec volleyball', 2, 'in', '{1,4}')`, [D])
const hidden = await call('preview_composed_block', {}, { type: 'mcp', id: TOKEN_D }, D)
const shown = await call('preview_composed_block', {}, { type: 'athlete', id: D }, D)
ok(/knee/.test(shown) && /Jumps/.test(shown), 'red flag: the athlete\'s own preview names the held knee')
ok(!/knee/i.test(hidden.replace(/Knee-to-wall/g, '')) && /not shared with you/.test(hidden), 'D3: without the health toggle a coach\'s preview never names the region')
const flaggedTurn = await appCoachTurn(sql, D, { message: 'Can I jump today?' }, { model: scripted([{ reply: 'Let us see.' }]) })
ok(flaggedTurn.escalate === 'red_flag' && /doctor or physio/.test(flaggedTurn.reply?.body ?? ''), 'red flag: the app coach escalates and refers out')

// ---- isolation ------------------------------------------------------------------------------------------
const bActs = JSON.parse(await call('get_activities', {}, coachB, B))
ok(bActs.activities.length === 1 && bActs.activities[0].name === 'Pickup volleyball', 'isolation: B\'s coach sees only B\'s activities')
ok((await callErr('apply_activity_change', { preview_id: actId, confirm: true, approval_ref: actRef }, coachB, B)).includes('no apply_activity_change preview'), 'isolation: B cannot apply A\'s preview')
ok((await call('preview_activity_change', { op: 'remove', activity_id: actRow.id }, coachB, B)).includes('No such activity'), 'isolation: B cannot touch A\'s activity')
const crossApprove = (await athleteCoachAction(storeB, { action: 'approve', preview_id: halfId }, { model: null }))[0] as { ok: boolean; text: string }
ok(!crossApprove.ok && /No such preview/.test(crossApprove.text), 'isolation: B cannot approve A\'s preview')
const bOpen = kept(await call('preview_composed_block', {}, coachB, B))
const crossChat = await createApproval(storeB, { type: 'athlete', id: B }, { preview_id: bOpen, message_id: yes.message_id })
ok(!crossChat.ok && /no such chat message/.test(crossChat.text), 'isolation: A\'s message is never B\'s approval')
ok(((await athleteCoachAction(storeB, { action: 'repreview', preview_id: halfId, resolutions: {} }, { model: null }))[0] as { ok: boolean }).ok === false, 'isolation: B cannot re-preview A\'s block')
const bState = (await athleteCoachAction(storeB, { action: 'state' }, { model: null }))[0] as { chat: Array<{ body: string }>; block: { goals: Array<{ name: string }> } | null }
ok(bState.chat.length === 0 && (bState.block?.goals ?? []).every((g) => g.name !== 'Back Squat 1RM'), 'isolation: B\'s state has none of A\'s chat or goals')
const bTool = await runAppCoachTool(sql, B, { name: 'preview_activity_change', arguments: JSON.stringify({ op: 'update', activity_id: actRow.id, sessions_per_week: 3 }) })
ok(bTool.ok && /No such activity/.test(bTool.output ?? ''), 'isolation: B\'s app coach cannot reach A\'s activity')
ok(await count('activity', `athlete_id = $1 AND sessions_per_week = 3`, [A]) === 0, 'isolation: A\'s activity untouched')

// ---- rollback: flag off again → as before ------------------------------------------------------------------
await flags(A, { coach: false })
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(tracksList), 'rollback: coach_v1 off → the tracks_v1 tool list again')
ok((await callErr('get_activities', {})).includes('Unknown tool'), 'rollback: tools unknown again')
ok((await athleteCoachAction(storeA, { action: 'state' }, { model: null }))[1] === 404, 'rollback: /api/coach 404 again')

await harness.close()
if (fails.length) {
  console.error(`${fails.length}/${checks} coach_v1 checks failed (${harness.backend}):\n- ${fails.join('\n- ')}`)
  process.exit(1)
}
console.log(`${checks} checks, 0 failed (${harness.backend})`)
console.log('coach-v1: ok')
