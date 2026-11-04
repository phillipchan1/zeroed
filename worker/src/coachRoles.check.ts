// Round 2 PR 2 (spec D3, section 11 item 2) against a real schema: coach
// read / propose roles on tokens, and the athlete's clear of a red flag set in
// their rules (methodology U7.regions.<region>.blocked).
//
//   Roles: every existing token is 'propose' and behaves as before. A 'read'
//   token lists and runs only get_/list_/search_ tools; every preview, apply
//   and write is refused server-side (through /api/mcp and executeZeroedTool)
//   and the refusal is logged. No role approves. Only the athlete changes a
//   role (logged); no coach, app_coach included, can; /api/data can't write
//   the column. Revocation is unchanged.
//   Red flag: only the athlete clears it (logged, with their tap); each kind
//   of block says whether the other still blocks; the minors rules are
//   untouched.
//   Flag off: tool lists, the routes and the logs are exactly as before.
//   Athletes A and B never see or change each other's rows.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/coachRoles.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { createApproval } from './approvals.ts'
import { executeDataQuery } from './data.ts'
import { handleMcp } from './mcp.ts'
import { resolveMcpToken, sha256Hex } from './mcpToken.ts'
import { isCoachRole, parseRole, roleAllows, roleRefusal, toolsForRole } from './coachRoles.ts'
import { isReadTool } from './coachReads.ts'
import { athleteReadinessAction, clearRedFlag, clearRegion, coachAccess, saveCheckin, setCoachRole } from './readiness.ts'
import { blockedRegions, resolveMethodology } from './methodology.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import type { Env } from './env.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const AUTH_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_R_ID = 'aaaa6666-0000-4000-8000-0000000000e1'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const PLAIN_A = 'zeroed-roles-synthetic-a'
const PLAIN_R = 'zeroed-roles-synthetic-read'
const PLAIN_B = 'zeroed-roles-synthetic-b'

const harness = await openIsolationHarness()
const sql = harness.sql
const env = {} as Env
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachR: OverrideActor = { type: 'mcp', id: TOKEN_R_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const appCoach: OverrideActor = { type: 'app_coach', id: 'app_coach' }
const athleteA: OverrideActor = { type: 'athlete', id: A }
const athleteB: OverrideActor = { type: 'athlete', id: B }

await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(PLAIN_A)} WHERE id = ${TOKEN_A_ID}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(PLAIN_B)} WHERE id = ${TOKEN_B_ID}`
await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'second opinion', $3, 'aae1')`,
  [TOKEN_R_ID, A, await sha256Hex(PLAIN_R)],
)

const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const roleOf = async (id: string) => (await harness.query<{ role: string }>(`SELECT role FROM mcp_token WHERE id = $1`, [id]))[0]?.role
const refusals = (actorId: string, tool?: string) => count(
  'coach_read_log',
  `athlete_id = $1 AND actor_id = $2 AND scope ->> 'refused' = 'role:read'${tool ? ' AND tool = $3' : ''}`,
  tool ? [A, actorId, tool] : [A, actorId],
)
const chp = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? /preview_id: (chp_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const tap = async (previewId: string) => {
  const r = await createApproval(storeA, athleteA, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await handleMcp(new Request('https://zeroed.test/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, { sql })
  return { status: res.status, body: res.status === 200 ? await res.json() as Record<string, unknown> : {} }
}
const listed = async (token: string) => ((await rpc(token, 'tools/list')).body.result as { tools?: Array<{ name: string }> } | undefined)?.tools?.map((t) => t.name) ?? []
const callText = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args })
  const result = r.body.result as { content?: Array<{ text?: string }> } | undefined
  return result?.content?.[0]?.text ?? JSON.stringify(r.body.error ?? r.body)
}
const editArgs = { edits: [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Face Pull', sets: 2, reps: '15', load: 'light' }] }
type Today = {
  blocked: Array<{ region: string; kind?: string; also_rule?: boolean }>
  rule_blocked?: Array<{ region: string; kind: string; also_checkin: boolean }>
}
const today = async (store = storeA) => (await athleteReadinessAction(store, { action: 'today' }))[0] as Today

// ---- pure ------------------------------------------------------------------------------------
ok(parseRole(null) === 'propose' && parseRole(undefined) === 'propose' && parseRole('propose') === 'propose', 'pure: absent or propose reads as propose (today\'s powers)')
ok(parseRole('read') === 'read' && parseRole('admin') === 'read' && parseRole('') === 'read', 'pure: anything unrecognized fails closed to read')
ok(isCoachRole('read') && isCoachRole('propose') && !isCoachRole('approve'), 'pure: two roles only, and neither approves')
ok(roleAllows('read', 'get_athlete') && roleAllows('read', 'list_workouts') && roleAllows('read', 'search_lifts'), 'pure: read allows get_/list_/search_')
ok(['preview_program_edits', 'apply_program_edits', 'log_goal_measurement', 'add_workout_note', 'upsert_goal', 'create_track', 'set_training_max']
  .every((t) => !roleAllows('read', t) && roleAllows('propose', t)), 'pure: read refuses previews, applies and writes; propose allows them')
ok(toolsForRole(ZEROED_TOOLS, 'propose') === ZEROED_TOOLS, 'pure: a propose list is the same list')
ok(toolsForRole(ZEROED_TOOLS, 'read').every((t) => isReadTool(t.name)) && toolsForRole(ZEROED_TOOLS, 'read').length > 0, 'pure: a read list has only read tools')

// ---- default: existing tokens are propose -------------------------------------------------------
const roles = await harness.query<{ role: string }>(`SELECT role FROM mcp_token`)
ok(roles.length >= 3 && roles.every((r) => r.role === 'propose'), 'default: every existing token is propose')
ok((await resolveMcpToken(sql, PLAIN_A))?.role === 'propose', 'default: resolveMcpToken reports propose')
let badRole = false
try { await sql`UPDATE mcp_token SET role = 'approve' WHERE id = ${TOKEN_R_ID}` } catch { badRole = true }
ok(badRole && await roleOf(TOKEN_R_ID) === 'propose', 'schema: no third role (no "approve")')

// ---- flag OFF: exactly as before ------------------------------------------------------------------
const zeroedNames = ZEROED_TOOLS.map((t) => t.name).join(',')
ok((await listed(PLAIN_A)).join(',') === zeroedNames, 'flag off: a propose token lists exactly ZEROED_TOOLS')
ok((await zeroedToolsFor(sql, A)).map((t) => t.name).join(',') === zeroedNames, 'flag off: zeroedToolsFor unchanged')
const offPreview = await callText(PLAIN_A, 'preview_program_edits', editArgs)
ok(!offPreview.includes('read access only') && offPreview.includes('Face Pull'), 'flag off: a propose coach previews as before')
ok(await count('coach_read_log') === 0, 'flag off: nothing logged')
ok((await athleteReadinessAction(storeA, { action: 'set_coach_role', token_id: TOKEN_R_ID, role: 'read' }))[1] === 404, 'flag off: set_coach_role route is 404')
ok((await athleteReadinessAction(storeA, { action: 'clear_red_flag', region: 'knee' }))[1] === 404, 'flag off: clear_red_flag route is 404')
ok(!(await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'read')).ok && await roleOf(TOKEN_R_ID) === 'propose', 'flag off: no role change')
ok(!(await clearRedFlag(storeA, athleteA, 'knee')).ok, 'flag off: no red-flag clear')
ok(await count('change_log') === 0, 'flag off: no change_log rows')

// ---- flag ON: roles ---------------------------------------------------------------------------------
await flag(A, true)
const full = (await zeroedToolsFor(sql, A)).map((t) => t.name)
ok((await listed(PLAIN_A)).join(',') === full.join(','), 'propose: lists every flag-on tool, as before')
ok((await listed(PLAIN_R)).join(',') === full.join(','), 'propose (default): the new token too')

// The athlete makes the second coach read-only.
const setRead = await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'read')
ok(setRead.ok && setRead.change_id != null && await roleOf(TOKEN_R_ID) === 'read', 'athlete: sets a coach to read')
const [roleRow] = await harness.query<{ tool: string; actor_type: string; actor_id: string; approval_ref: string; target_id: string; diff: { role: { before: string; after: string } } }>(
  `SELECT tool, actor_type, actor_id, approval_ref, target_id, diff FROM change_log WHERE id = $1`, [setRead.change_id],
)
ok(roleRow?.tool === 'set_coach_role' && roleRow.actor_type === 'athlete' && roleRow.actor_id === A && /^tap:/.test(roleRow.approval_ref)
  && roleRow.target_id === TOKEN_R_ID && roleRow.diff.role.before === 'propose' && roleRow.diff.role.after === 'read', 'athlete: the role change is logged with their tap')
ok((await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'read')).text === 'Already set.', 'athlete: setting the same role writes nothing')
ok(await count('change_log', 'tool = $1', ['set_coach_role']) === 1, 'athlete: one row per change')
ok((await coachAccess(storeA)).find((c) => c.id === TOKEN_R_ID)?.role === 'read', 'coach access: shows the role')

// A read token: only read tools listed…
const readList = await listed(PLAIN_R)
ok(readList.length > 0 && readList.every(isReadTool), 'read: tools/list has only get_/list_/search_ tools')
ok(!readList.some((n) => /^(preview|apply)_/.test(n)) && !readList.includes('log_goal_measurement') && !readList.includes('add_workout_note'), 'read: no preview, apply or logging tool listed')
ok(readList.includes('get_change_log') && readList.includes('get_methodology') && readList.includes('list_approvals'), 'read: the read tools stay')
// …every write refused over /api/mcp, and logged.
const changePreviews = await count('change_preview', 'athlete_id = $1', [A])
const viaMcp = await callText(PLAIN_R, 'preview_program_edits', editArgs)
ok(viaMcp === roleRefusal('preview_program_edits'), 'read: preview_program_edits over MCP is refused')
ok(await refusals(TOKEN_R_ID, 'preview_program_edits') === 1, 'read: the refusal is logged')
ok(await count('change_preview', 'athlete_id = $1', [A]) === changePreviews, 'read: the refused preview wrote nothing')
for (const [tool, args] of [
  ['preview_methodology_override', { path: 'U9.hiit_max_per_week', value: 1 }],
  ['apply_methodology_override', { preview_id: 'chp_00', confirm: true, approval_ref: 'tap:00000000-0000-4000-8000-000000000000' }],
  ['apply_program_edits', { ...editArgs, confirm: true }],
  ['log_goal_measurement', { goal: 'x', value: 1 }],
  ['add_workout_note', { note: 'synthetic' }],
  ['preview_revert_change', { change_id: '00000000-0000-4000-8000-000000000000' }],
] as Array<[string, Record<string, unknown>]>) {
  ok((await callText(PLAIN_R, tool, args)) === roleRefusal(tool), `read: ${tool} refused over MCP`)
  ok(await refusals(TOKEN_R_ID, tool) === 1, `read: ${tool} refusal logged`)
}
// …and server-side whatever the transport.
ok((await call('preview_session_override', { date: '2026-11-05', session: 'A day', ops: [] }, coachR)) === roleRefusal('preview_session_override'), 'read: refused in executeZeroedTool too')
ok(await refusals(TOKEN_R_ID, 'preview_session_override') === 1, 'read: logged there too')
ok(await count('change_log', 'actor_id = $1', [TOKEN_R_ID]) === 0, 'read: no change_log row from the read coach')
// Reads still work and are logged as reads.
const readsBefore = await count('coach_read_log', `actor_id = $1 AND tool = 'get_athlete' AND scope ->> 'refused' IS NULL`, [TOKEN_R_ID])
ok(!(await callText(PLAIN_R, 'get_athlete')).includes('read access only'), 'read: get_athlete runs')
ok(await count('coach_read_log', `actor_id = $1 AND tool = 'get_athlete' AND scope ->> 'refused' IS NULL`, [TOKEN_R_ID]) === readsBefore + 1, 'read: the read is logged as a read')
const access = (await athleteReadinessAction(storeA, { action: 'coach_access' }))[0] as { reads: Array<{ tool: string; refused: boolean; actor_id: string }> }
ok(access.reads.some((r) => r.actor_id === TOKEN_R_ID && r.refused && r.tool === 'preview_program_edits')
  && access.reads.some((r) => r.actor_id === TOKEN_R_ID && !r.refused && r.tool === 'get_athlete'), 'coach access: the athlete sees refusals and reads apart')

// Propose: unchanged.
const pPropose = chp(await callText(PLAIN_A, 'preview_methodology_override', { path: 'U9.hiit_max_per_week', value: 1, rationale: 'Synthetic (U9).' }))
ok(pPropose !== '', 'propose: previews as before')
const applied = await callText(PLAIN_A, 'apply_methodology_override', { preview_id: pPropose, confirm: true, approval_ref: await tap(pPropose) })
ok(applied.includes('change_id'), 'propose: applies with the athlete\'s approval, as before')
ok(await refusals(TOKEN_A_ID) === 0, 'propose: nothing refused by role')
// app_coach: propose-equivalent, never approves.
ok(chp(await call('preview_methodology_override', { path: 'U9.hiit_max_per_week', clear: true }, appCoach)) !== '', 'app_coach: previews (propose-equivalent)')
// No role approves.
for (const [who, actor] of [['read coach', coachR], ['propose coach', coachA], ['app_coach', appCoach]] as Array<[string, OverrideActor]>) {
  ok(!(await createApproval(storeA, actor, { preview_id: pPropose })).ok, `no role approves: ${who}`)
}

// Only the athlete changes a role.
ok(!(await setCoachRole(storeA, coachA, TOKEN_R_ID, 'propose')).ok, 'role: a propose coach can\'t change one')
ok(!(await setCoachRole(storeA, coachR, TOKEN_R_ID, 'propose')).ok, 'role: the read coach can\'t upgrade itself')
ok(!(await setCoachRole(storeA, appCoach, TOKEN_R_ID, 'propose')).ok, 'role: app_coach can\'t')
ok((await call('set_coach_role', { token_id: TOKEN_R_ID, role: 'propose' }, coachA)).includes('Unknown tool'), 'role: there is no coach tool for it')
ok(!(await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'approve')).ok, 'role: no "approve" role')
const viaData = await executeDataQuery(sql, { userId: AUTH_A, athleteId: A }, {
  table: 'mcp_token', op: 'update', values: { role: 'propose' }, filters: [{ column: 'id', op: 'eq', value: TOKEN_R_ID }],
})
ok(viaData.error != null && await roleOf(TOKEN_R_ID) === 'read', 'role: /api/data can\'t write it')
ok(await count('change_log', 'tool = $1', ['set_coach_role']) === 1, 'role: no refused attempt was logged as a change')

// Back to propose: logged, and the token can write again.
const setPropose = await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'propose')
ok(setPropose.ok && await roleOf(TOKEN_R_ID) === 'propose' && await count('change_log', 'tool = $1', ['set_coach_role']) === 2, 'athlete: back to propose, logged')
ok((await listed(PLAIN_R)).join(',') === full.join(',') && (await callText(PLAIN_R, 'preview_program_edits', editArgs)).includes('Face Pull'), 'athlete: propose again lists and previews')
await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'read')

// Revocation: unchanged (access ends, whatever the role).
await sql`UPDATE mcp_token SET revoked_at = NOW() WHERE id = ${TOKEN_R_ID}`
ok((await rpc(PLAIN_R, 'tools/list')).status === 401, 'revoke: a revoked read token is 401')
ok(!(await setCoachRole(storeA, athleteA, TOKEN_R_ID, 'propose')).ok, 'revoke: a revoked coach\'s role can\'t be changed')

// ---- flag ON: clearing a red flag in the rules ------------------------------------------------------
const flagKnee = chp(await call('preview_methodology_override', { path: 'U7.regions.knee.blocked', value: true, rationale: 'Synthetic: knee giving way (U7); referred out.' }))
ok((await call('apply_methodology_override', { preview_id: flagKnee, confirm: true, approval_ref: await tap(flagKnee) })).includes('change_id'), 'setup: a coach sets a red flag on the knee, the athlete approves')
let view = await today()
ok(view.rule_blocked?.length === 1 && view.rule_blocked[0].region === 'knee' && view.rule_blocked[0].kind === 'rule' && view.rule_blocked[0].also_checkin === false, 'today: the red flag shows as the rule kind')
ok(view.blocked.every((b) => b.region !== 'knee'), 'today: no check-in block on the knee yet')

// No coach can clear it.
ok(!(await clearRedFlag(storeA, coachA, 'knee')).ok, 'clear flag: an MCP coach can\'t')
ok(!(await clearRedFlag(storeA, appCoach, 'knee')).ok, 'clear flag: app_coach can\'t')
ok((await call('clear_red_flag', { region: 'knee' })).includes('Unknown tool'), 'clear flag: there is no coach tool for it')
ok((await call('preview_methodology_override', { path: 'U7.regions.knee.blocked', clear: true })).includes('only the athlete'), 'clear flag: nor through a rule override')
ok(blockedRegions(await resolveMethodology(storeA)).includes('knee'), 'clear flag: still flagged after the coaches tried')

// Both kinds at once: a check-in block on the knee too.
const knee = await saveCheckin(storeA, athleteA, { pain: [{ region: 'knee', score: 7, red_flags: ['locking'] }] })
ok(knee.ok, 'setup: a 7/10 knee with locking in the check-in blocks it')
view = await today()
ok(view.blocked.find((b) => b.region === 'knee')?.also_rule === true && view.rule_blocked?.find((b) => b.region === 'knee')?.also_checkin === true, 'today: each kind says the other also blocks')

const minorsBefore = JSON.stringify((await resolveMethodology(storeA)).minors)
const cleared = await clearRedFlag(storeA, athleteA, 'knee')
ok(cleared.ok && /check-in still blocks/i.test(cleared.text), 'clear flag: the athlete clears it; told the check-in still blocks')
const [flagRow] = await harness.query<{ tool: string; actor_type: string; approval_ref: string; rule_refs: string[]; target_type: string; target_id: string; methodology_version: string | null }>(
  `SELECT tool, actor_type, approval_ref, rule_refs, target_type, target_id, methodology_version FROM change_log WHERE id = $1`, [cleared.change_id],
)
ok(flagRow?.tool === 'clear_red_flag' && flagRow.actor_type === 'athlete' && /^tap:/.test(flagRow.approval_ref) && flagRow.rule_refs.includes('U7')
  && flagRow.target_type === 'methodology' && flagRow.target_id === 'U7.regions.knee.blocked' && flagRow.methodology_version != null, 'clear flag: logged with the athlete\'s tap, U7 and the version')
ok(!blockedRegions(await resolveMethodology(storeA)).includes('knee'), 'clear flag: the rule no longer flags the knee')
ok(await count('methodology_override', `athlete_id = $1 AND path = 'U7.regions.knee.blocked' AND superseded_at IS NOT NULL`, [A]) === 1, 'clear flag: the override is superseded, not deleted')
ok(JSON.stringify((await resolveMethodology(storeA)).minors) === minorsBefore, 'clear flag: the minors rules are untouched')
const [rxStill] = await sessionRxForAthlete(sql, A, { routine_id: A_DAY, unit: 'lb', storage_unit: 'lb' })
ok(JSON.stringify(rxStill).includes('"knee"'), 'clear flag: the check-in block still holds the knee')
view = await today()
ok(!view.rule_blocked?.some((b) => b.region === 'knee') && view.blocked.find((b) => b.region === 'knee')?.also_rule === false, 'today: only the check-in kind is left')
ok(!(await clearRedFlag(storeA, athleteA, 'knee')).ok, 'clear flag: once')
const kneeRegion = await clearRegion(storeA, athleteA, 'knee')
ok(kneeRegion.ok && kneeRegion.text.includes('can be loaded again'), 'clear region: then the check-in block; the knee loads again')

// The other order: the check-in cleared first says the red flag still blocks.
const flagAnkle = chp(await call('preview_methodology_override', { path: 'U7.regions.ankle.blocked', value: true, rationale: 'Synthetic (U7).' }))
await call('apply_methodology_override', { preview_id: flagAnkle, confirm: true, approval_ref: await tap(flagAnkle) })
await saveCheckin(storeA, athleteA, { pain: [{ region: 'ankle', score: 2, red_flags: ['swelling'] }] })
const ankleRegion = await clearRegion(storeA, athleteA, 'ankle')
ok(ankleRegion.ok && ankleRegion.text.includes('red flag is also set'), 'clear region: says the red flag still blocks')
ok(blockedRegions(await resolveMethodology(storeA)).includes('ankle'), 'clear region: the red flag is untouched')
const viaRoute = (await athleteReadinessAction(storeA, { action: 'clear_red_flag', region: 'ankle' }))[0] as { ok: boolean; text: string }
ok(viaRoute.ok && viaRoute.text.includes('can be loaded again'), 'route: clear_red_flag through POST /api/readiness')
ok(!(await clearRedFlag(storeA, athleteA, 'spleen')).ok, 'clear flag: unknown region refused')

// A minor clears a red flag the same way; nothing in their under-18 rules loosens.
await sql`UPDATE athlete SET birth_date = '2012-01-01' WHERE id = ${A}`
const minorMinors = JSON.stringify((await resolveMethodology(storeA)).minors)
const flagHip = chp(await call('preview_methodology_override', { path: 'U7.regions.hip.blocked', value: true, rationale: 'Synthetic (U7).' }))
await call('apply_methodology_override', { preview_id: flagHip, confirm: true, approval_ref: await tap(flagHip) })
const minorClear = await clearRedFlag(storeA, athleteA, 'hip')
ok(minorClear.ok && !blockedRegions(await resolveMethodology(storeA)).includes('hip'), 'minor: the athlete clears a clinician-cleared red flag')
ok(JSON.stringify((await resolveMethodology(storeA)).minors) === minorMinors && (await resolveMethodology(storeA)).minor === true, 'minor: under-18 rules unchanged')
ok((await call('preview_methodology_override', { path: 'U7.regions.hip.raised_cap', value: true })).includes('under 18'), 'minor: still no raised cap')
await sql`UPDATE athlete SET birth_date = NULL WHERE id = ${A}`

// ---- rollback: flag off never widens a read coach ------------------------------------------------
await sql`UPDATE mcp_token SET revoked_at = NULL WHERE id = ${TOKEN_R_ID}`
await flag(A, false)
ok((await listed(PLAIN_R)).every(isReadTool) && (await callText(PLAIN_R, 'preview_program_edits', editArgs)) === roleRefusal('preview_program_edits'), 'flag off: a read coach stays read-only')
ok((await listed(PLAIN_A)).join(',') === zeroedNames, 'flag off: a propose coach is back to exactly ZEROED_TOOLS')
await flag(A, true)

// ---- isolation ------------------------------------------------------------------------------------
await flag(B, true)
ok(!(await setCoachRole(storeB, athleteB, TOKEN_R_ID, 'propose')).ok && await roleOf(TOKEN_R_ID) === 'read', 'isolation: B can\'t change A\'s coach\'s role')
ok((await coachAccess(storeB)).every((c) => c.id === TOKEN_B_ID || !c.id.startsWith('aaaa')), 'isolation: B\'s coach access has none of A\'s tokens')
ok((await listed(PLAIN_B)).join(',') === (await zeroedToolsFor(sql, B)).map((t) => t.name).join(','), 'isolation: A\'s read token doesn\'t narrow B\'s coach')
ok(!(await callText(PLAIN_B, 'preview_program_edits', { edits: [{ ...editArgs.edits[0], session_name: 'B day' }] })).includes('read access only'), 'isolation: B\'s propose coach previews')
const flagB = chp(await call('preview_methodology_override', { path: 'U7.regions.wrist.blocked', value: true, rationale: 'Synthetic (U7).' }))
await call('apply_methodology_override', { preview_id: flagB, confirm: true, approval_ref: await tap(flagB) })
ok(!(await clearRedFlag(storeB, athleteB, 'wrist')).ok && blockedRegions(await resolveMethodology(storeA)).includes('wrist'), 'isolation: B can\'t clear A\'s red flag')
ok(!(await call('get_change_log', { since: '2000-01-01' }, coachB, B)).includes('clear_red_flag'), 'isolation: B\'s coach sees none of A\'s clears or role changes')
const bView = await today(storeB)
ok(!(bView.rule_blocked ?? []).some((b) => b.region === 'wrist') && !bView.blocked.some((b) => b.region === 'knee'), 'isolation: B sees none of A\'s blocks')
ok(await count('change_log', 'athlete_id = $1', [B]) === 0 && await count('coach_read_log', `athlete_id = $1 AND scope ->> 'refused' IS NOT NULL`, [B]) === 0, 'isolation: nothing written to B')

await harness.close()
console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`coach-roles: ok (${harness.backend})`)
