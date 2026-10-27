// Parity, token isolation, revoked 401, and "load a full program".
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/mcp.check.ts

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from './env.ts'
import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'
import { handleMcp, publicMcpError } from './mcp.ts'
import { resolveMcpToken, sha256Hex, timingSafeEqualHex } from './mcpToken.ts'
import { ZEROED_TOOLS } from './tools.ts'
import { LIFT_MODEL_TOOLS } from '../../supabase/functions/_shared/liftModelTools.ts'
import { SERVER_INSTRUCTIONS } from '../../supabase/functions/_shared/mcpProtocol.ts'
import {
  ONBOARDING_SERVER_INSTRUCTIONS,
  ONBOARDING_TOOLS,
  listedZeroedTools,
  onboardingAgentV1On,
} from './onboardingTools.ts'
import { McpUserError } from './userError.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const AUTH_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const WORKOUT_A = '99999999-9999-9999-9999-999999999999'
const WORKOUT_B = 'bbbb9999-9999-4999-8999-999999999999'

const TOKEN_A = 'zeroed-mcp-token-athlete-a-aaaaaaaa'
const TOKEN_B = 'zeroed-mcp-token-athlete-b-bbbbbbbb'
const TOKEN_C = 'zeroed-mcp-token-athlete-c-cccccccc'
const TOKEN_REVOKED = 'zeroed-mcp-token-revoked-cccccccc'
const TOKEN_EXPIRED = 'zeroed-mcp-token-expired-dddddddd'

function toolsBlock(src: string): string {
  const start = src.indexOf('export const ZEROED_TOOLS')
  const end = src.indexOf('\nfunction asString')
  if (start < 0 || end < 0) throw new Error('ZEROED_TOOLS block not found')
  return src.slice(start, end).replace(/\s+/g, ' ').trim()
}

const edgeSrc = readFileSync(join(here, '../../supabase/functions/_shared/zeroedTools.ts'), 'utf8')
const workerSrc = readFileSync(join(here, 'tools.ts'), 'utf8')
ok(toolsBlock(edgeSrc) === toolsBlock(workerSrc), 'parity: ZEROED_TOOLS matches the edge function source')

// The lift-model tools are one shared list spread into both, so they are only
// counted when the edge block actually spreads it.
const edgeNames = [
  ...[...toolsBlock(edgeSrc).matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]),
  ...(toolsBlock(edgeSrc).includes('...LIFT_MODEL_TOOLS') ? LIFT_MODEL_TOOLS.map((t) => t.name) : []),
]
const workerNames = ZEROED_TOOLS.map((t) => t.name)
ok(workerNames.join() === edgeNames.join(), `parity: tool names ${workerNames.join(',')}`)
ok(onboardingAgentV1On(undefined) === false && onboardingAgentV1On('1') === true && onboardingAgentV1On('true') === false, 'parity: server flag is off unless exactly 1')
ok(listedZeroedTools(ZEROED_TOOLS, false) === ZEROED_TOOLS, 'parity: flag-off listed tools is the same array')
ok(listedZeroedTools(ZEROED_TOOLS, true).map((t) => t.name).slice(0, workerNames.length).join() === workerNames.join(), 'parity: flag-on list keeps existing tools first')
ok(ONBOARDING_TOOLS.map((t) => t.name).join() === 'get_onboarding_state,list_starter_packs,record_onboarding_answers,preview_starter_pack,start_starter_pack', 'parity: five onboarding tools')
ok(workerSrc.includes("from './onboardingTools.ts'"), 'parity: worker tools import worker onboarding defs')
ok(!existsSync(join(here, '../../supabase/functions/_shared/onboardingTools.ts')), 'parity: edge mcp has no onboardingTools')
ok(!existsSync(join(here, '../../supabase/functions/_shared/onboardingStore.ts')), 'parity: edge mcp has no onboardingStore')
ok(!edgeSrc.includes('runOnboardingTool') && !edgeSrc.includes('onboardingTools'), 'parity: edge zeroedTools is unchanged')
const workerMcpSrc = readFileSync(join(here, 'mcp.ts'), 'utf8')
const edgeMcpSrc = readFileSync(join(here, '../../supabase/functions/mcp/index.ts'), 'utf8')
ok(workerMcpSrc.includes('listedZeroedTools') && workerMcpSrc.includes('ONBOARDING_SERVER_INSTRUCTIONS'), 'parity: worker MCP gates the list')
ok(!edgeMcpSrc.includes('listedZeroedTools') && !edgeMcpSrc.includes('ONBOARDING_SERVER_INSTRUCTIONS'), 'parity: edge MCP is unchanged')
ok(!workerNames.includes('get_onboarding_state'), 'parity: onboarding tools are not on the flag-off list')
ok(workerNames.includes('get_current_program'), 'parity: get_current_program is advertised')
ok(workerNames.includes('list_workouts') && workerNames.includes('get_workout'), 'parity: workout tools are advertised')
for (const need of [
  'get_training_brief', 'get_athlete', 'get_insights', 'get_current_program',
  'list_workouts', 'get_workout', 'search_lifts', 'get_program_journey',
  'get_coach_notes', 'preview_program_edits', 'apply_program_edits',
  'get_lift_model', 'set_training_max',
]) {
  const tool = ZEROED_TOOLS.find((t) => t.name === need)
  ok(Boolean(tool), `parity: ${need} exists`)
  ok(Boolean(tool?.inputSchema), `parity: ${need} has a schema`)
}

ok(timingSafeEqualHex('abc', 'abc'), 'timingSafeEqualHex: equal')
ok(!timingSafeEqualHex('abc', 'abd'), 'timingSafeEqualHex: differs')
ok(!timingSafeEqualHex('ab', 'abc'), 'timingSafeEqualHex: length differs')
ok(publicMcpError(new Error('relation "routine" does not exist')) === 'request failed', 'publicMcpError: SQL is generic')
ok(publicMcpError(new Error('workout_id is required')) === 'request failed', 'publicMcpError: generic Error is hidden')
ok(publicMcpError(new Error('malformed array literal: "33333333-3333-3333-3333-333333333333"')) === 'request failed', 'publicMcpError: PG array error is hidden')
ok(publicMcpError(new Error('invalid byte sequence for encoding "UTF8": 0x00')) === 'request failed', 'publicMcpError: UTF8 NUL is hidden')
ok(publicMcpError(new McpUserError('workout_id is required')) === 'workout_id is required', 'publicMcpError: McpUserError kept')

const harness = await openIsolationHarness()
const sql = harness.sql
const env = {} as Env
const envOn = { ONBOARDING_AGENT_V1: '1' } as Env

await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_A)} WHERE name = ${'claude-a'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_B)} WHERE name = ${'claude-b'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_REVOKED)} WHERE name = ${'revoked-a'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_EXPIRED)} WHERE name = ${'expired-a'}`

await sql`INSERT INTO auth.users (id, email) VALUES (${AUTH_C}, ${'c@example.com'})`
await sql`
  INSERT INTO athlete (id, auth_user_id, name, onboarding_step, training_age)
  VALUES (${C}, ${AUTH_C}, ${'Athlete C'}, ${'hook'}, 2)
`
await sql`
  INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four)
  VALUES (
    ${'cccc6666-0000-4000-8000-000000000001'},
    ${C},
    ${'claude-c'},
    ${await sha256Hex(TOKEN_C)},
    ${'ccc1'}
  )
`

const resolvedA = await resolveMcpToken(sql, TOKEN_A)
ok(resolvedA?.athlete_id === A, 'resolveMcpToken: A token maps to A')
ok((await resolveMcpToken(sql, TOKEN_B))?.athlete_id === B, 'resolveMcpToken: B token maps to B')
ok(await resolveMcpToken(sql, TOKEN_REVOKED) === null, 'resolveMcpToken: revoked is null')
ok(await resolveMcpToken(sql, TOKEN_EXPIRED) === null, 'resolveMcpToken: expired is null')

async function mcp(
  token: string | null,
  body: unknown,
  extra: Record<string, string> = {},
  useEnv: Env = env,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  return handleMcp(new Request('https://zeroed.test/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }), useEnv, { sql })
}

async function rpc(token: string, method: string, params: unknown = {}, id: number | string = 1) {
  const res = await mcp(token, { jsonrpc: '2.0', id, method, params })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function rpcOn(token: string, method: string, params: unknown = {}, id: number | string = 1) {
  const res = await mcp(token, { jsonrpc: '2.0', id, method, params }, {}, envOn)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function toolText(body: Record<string, unknown>): string {
  const result = body.result as { content?: Array<{ text?: string }> } | undefined
  return result?.content?.[0]?.text ?? ''
}

const missing = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'ping' })
ok(missing.status === 401, 'HTTP: missing bearer is 401')

const revoked = await mcp(TOKEN_REVOKED, { jsonrpc: '2.0', id: 1, method: 'ping' })
ok(revoked.status === 401, 'HTTP: revoked token is 401')
const revokedBody = await revoked.json() as { error?: string }
ok(revokedBody.error === 'Invalid or revoked token', 'HTTP: revoked message is generic')

const expired = await mcp(TOKEN_EXPIRED, { jsonrpc: '2.0', id: 1, method: 'ping' })
ok(expired.status === 401, 'HTTP: expired token is 401')

const unknown = await mcp('not-a-token', { jsonrpc: '2.0', id: 1, method: 'ping' })
ok(unknown.status === 401, 'HTTP: unknown token is 401')

const viaHeader = await handleMcp(new Request('https://zeroed.test/api/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer gateway-anon',
    'x-zeroed-token': TOKEN_A,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
}), env, { sql })
ok(viaHeader.status === 200, 'HTTP: x-zeroed-token is accepted')

const listed = await rpc(TOKEN_A, 'tools/list')
ok(listed.status === 200, 'HTTP: tools/list is 200')
const listedTools = ((listed.body.result as { tools?: Array<{ name: string; inputSchema?: unknown }> })?.tools) ?? []
ok(listedTools.map((t) => t.name).join() === workerNames.join(), 'HTTP: tools/list names match the edge list')
for (const tool of ZEROED_TOOLS) {
  const advertised = listedTools.find((t) => t.name === tool.name)
  ok(JSON.stringify(advertised?.inputSchema) === JSON.stringify(tool.inputSchema), `HTTP: ${tool.name} schema matches`)
}

const program = await rpc(TOKEN_A, 'tools/call', { name: 'get_current_program', arguments: {} })
ok(program.status === 200, 'e2e: get_current_program is 200')
const programText = toolText(program.body)
ok(programText.includes('Strength'), 'e2e: program names the phase')
ok(programText.includes('A day'), 'e2e: program names the routine')
ok(programText.includes('Back Squat'), 'e2e: program lists exercises')
ok(programText.includes(PROG_A), 'e2e: program includes program id')
ok(programText.includes(ROUTINE_A), 'e2e: program includes routine id')
ok(!programText.includes('B day') && !programText.includes('Deadlift'), 'e2e: A program does not include B session')

const workouts = await rpc(TOKEN_A, 'tools/call', { name: 'list_workouts', arguments: {} })
const workoutList = toolText(workouts.body)
ok(workoutList.includes('Back Squat'), 'e2e: list_workouts returns A session')
ok(!workoutList.includes('Deadlift'), 'isolation: A list_workouts hides B lifts')

const ownWorkout = await rpc(TOKEN_A, 'tools/call', { name: 'get_workout', arguments: { workout_id: WORKOUT_A } })
const ownText = toolText(ownWorkout.body)
ok(ownText.includes('Back Squat') && ownText.includes('A felt good'), 'e2e: get_workout returns A workout + observations')

const crossed = await rpc(TOKEN_A, 'tools/call', { name: 'get_workout', arguments: { workout_id: WORKOUT_B } })
const crossedText = toolText(crossed.body)
ok(crossedText.includes('No workout') && !crossedText.includes('Deadlift'), 'isolation: A get_workout of B is a miss')

const brief = await rpc(TOKEN_A, 'tools/call', { name: 'get_training_brief', arguments: {} })
const briefText = toolText(brief.body)
ok(briefText.includes('Athlete A') && briefText.includes('Back Squat'), 'e2e: brief loads A profile + week + session')
ok(!briefText.includes('Athlete B') && !briefText.includes('Deadlift'), 'isolation: brief does not leak B')

const sneak = await rpc(TOKEN_A, 'tools/call', {
  name: 'apply_program_edits',
  arguments: {
    confirm: true,
    edits: [{ type: 'update_session', session_name: 'B day', set_name: 'should not apply', rationale: 'cross' }],
  },
})
const sneakText = toolText(sneak.body)
ok(!sneakText.includes('should not apply') || sneakText.includes('skipped') || sneakText.includes('Nothing'), 'isolation: A apply cannot target B session')

const stealArgs = await rpc(TOKEN_A, 'tools/call', {
  name: 'apply_program_edits',
  arguments: {
    confirm: true,
    athlete_id: B,
    edits: [{ type: 'update_session', session_name: 'A day', set_name: 'A day from MCP', rationale: 'own' }],
  },
})
const stealArgsText = toolText(stealArgs.body)
ok(stealArgsText.includes('Applied') || stealArgsText.includes('Wrote'), 'isolation: actor override is stripped and A can still edit own week')

const [bName] = await sql<{ name: string }[]>`SELECT name FROM routine WHERE id = ${'88888888-8888-8888-8888-888888888888'}`
ok(bName?.name === 'B day', 'isolation: B routine name unchanged after A writes')

const [aName] = await sql<{ name: string }[]>`SELECT name FROM routine WHERE id = ${ROUTINE_A}`
ok(aName?.name === 'A day from MCP', 'isolation: A own apply via token wrote')

ok((await resolveMcpToken(sql, TOKEN_A))?.athlete_id === A, 'token: A still resolves after use')

const notes = await rpc(TOKEN_A, 'tools/call', { name: 'get_coach_notes', arguments: {} })
ok(notes.status === 200, 'e2e: get_coach_notes is 200')
const notesText = toolText(notes.body)
ok(
  (notesText.includes('A weekly note') || notesText.includes('private A'))
    && !notesText.includes('malformed array'),
  'e2e: get_coach_notes returns A notes without array-bind error',
)
ok(!notesText.includes('B weekly note') && !notesText.includes('private B'), 'isolation: get_coach_notes hides B')

const liftModel = await rpc(TOKEN_A, 'tools/call', { name: 'get_lift_model', arguments: { lift: 'squat' } })
const liftText = toolText(liftModel.body)
ok(liftModel.status === 200 && liftText.includes('# Squat'), 'e2e: get_lift_model returns the squat model')
ok(liftText.includes('225x5 @8') && liftText.includes('Reason: '), 'e2e: get_lift_model reads A\'s log and carries a reason line')
const liftB = toolText((await rpc(TOKEN_A, 'tools/call', { name: 'get_lift_model', arguments: { lift: 'deadlift' } })).body)
ok(liftB.includes('nothing to recommend') && !liftB.includes('315'), 'isolation: A get_lift_model never sees B\'s deadlift')
const notALift = toolText((await rpc(TOKEN_A, 'tools/call', { name: 'get_lift_model', arguments: { lift: 'cossack squat' } })).body)
ok(notALift.includes('not a main lift'), 'e2e: get_lift_model refuses a variation')

const tmPreview = toolText((await rpc(TOKEN_A, 'tools/call', {
  name: 'set_training_max', arguments: { lift: 'squat', training_max: 200 },
})).body)
ok(tmPreview.includes('Preview only'), 'e2e: set_training_max without confirm only previews')
const [beforeTm] = await sql<{ training_max_overrides: unknown }[]>`SELECT training_max_overrides FROM athlete WHERE id = ${A}`
ok(beforeTm?.training_max_overrides == null, 'e2e: a preview writes nothing')
const tmSaved = toolText((await rpc(TOKEN_A, 'tools/call', {
  name: 'set_training_max', arguments: { lift: 'squat', training_max: 200, confirm: true, athlete_id: B },
})).body)
ok(tmSaved.includes('Saved.'), 'e2e: set_training_max with confirm saves')
const [aTm] = await sql<{ training_max_overrides: unknown }[]>`SELECT training_max_overrides FROM athlete WHERE id = ${A}`
const aTmValue = typeof aTm?.training_max_overrides === 'string' ? JSON.parse(aTm.training_max_overrides) : aTm?.training_max_overrides
const aSquat = (aTmValue as Record<string, { value?: number; set_at?: string } | null> | null)?.squat
ok(aSquat?.value === 200, 'e2e: A\'s squat TM is 200')
ok(typeof aSquat?.set_at === 'string' && !Number.isNaN(Date.parse(aSquat.set_at)), 'e2e: the write is stamped with when it was set')
const [bTm] = await sql<{ training_max_overrides: unknown }[]>`SELECT training_max_overrides FROM athlete WHERE id = ${B}`
ok(bTm?.training_max_overrides == null, 'isolation: an athlete_id arg cannot write B\'s TM')
const afterTm = toolText((await rpc(TOKEN_A, 'tools/call', { name: 'get_lift_model', arguments: { lift: 'squat' } })).body)
ok(afterTm.includes('Training max: 200lb (set by hand'), 'e2e: the hand-set TM is what the model reads next')

const search = toolText((await rpc(TOKEN_A, 'tools/call', { name: 'search_lifts', arguments: { exercise: 'squat' } })).body)
ok(search.includes('RPE chart') && search.includes('lift identity'), 'e2e: search_lifts uses the RPE chart and lift identity')

const nul = await mcp(TOKEN_A, {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'apply_program_edits',
    arguments: {
      confirm: true,
      edits: [{ type: 'add_note', note: 'a\u0000b', rationale: 'nul' }],
    },
  },
})
ok(nul.status === 400, 'HTTP: NUL in body is 400')
const nulBody = await nul.json() as { error?: string }
ok(nulBody.error === 'invalid input', 'HTTP: NUL message is generic')
ok(!JSON.stringify(nulBody).includes('UTF8') && !JSON.stringify(nulBody).includes('0x00'), 'HTTP: NUL response does not leak PG encoding')

const initOff = await rpc(TOKEN_A, 'initialize')
const initOffText = (initOff.body.result as { instructions?: string } | undefined)?.instructions ?? ''
ok(
  initOffText === `${SERVER_INSTRUCTIONS} You are connected as Athlete A. That is the only athlete this token can see.`,
  'flag-off: initialize instructions are unchanged',
)
ok(!initOffText.includes('get_onboarding_state'), 'flag-off: initialize does not mention onboarding tools')

const listedOff = ((listed.body.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name)
ok(!listedOff.includes('get_onboarding_state'), 'flag-off: tools/list does not advertise onboarding tools')

const hiddenCall = await rpc(TOKEN_A, 'tools/call', { name: 'get_onboarding_state', arguments: {} })
const hiddenErr = hiddenCall.body.error as { message?: string } | undefined
ok(hiddenCall.status === 200 && hiddenErr?.message === 'Unknown tool: get_onboarding_state', 'flag-off: get_onboarding_state is not callable')

const listedOn = await rpcOn(TOKEN_A, 'tools/list')
const listedOnTools = ((listedOn.body.result as { tools?: Array<{ name: string; inputSchema?: unknown; annotations?: unknown }> })?.tools) ?? []
ok(listedOn.status === 200, 'flag-on: tools/list is 200')
ok(listedOnTools.map((t) => t.name).join() === listedZeroedTools(ZEROED_TOOLS, true).map((t) => t.name).join(), 'flag-on: list is existing tools plus the five onboarding tools')
for (const tool of ONBOARDING_TOOLS) {
  const advertised = listedOnTools.find((t) => t.name === tool.name)
  ok(JSON.stringify(advertised?.inputSchema) === JSON.stringify(tool.inputSchema), `flag-on: ${tool.name} schema matches shared def`)
  ok(JSON.stringify(advertised?.annotations) === JSON.stringify(tool.annotations), `flag-on: ${tool.name} annotations match`)
}

const initOn = await rpcOn(TOKEN_C, 'initialize')
const initOnText = (initOn.body.result as { instructions?: string } | undefined)?.instructions ?? ''
ok(initOnText.includes(ONBOARDING_SERVER_INSTRUCTIONS), 'flag-on: initialize tells the model to run onboarding first')
ok(initOnText.includes(SERVER_INSTRUCTIONS.slice(0, 40)), 'flag-on: existing instructions are still present')

const coachOn = await rpcOn(TOKEN_C, 'prompts/get', { name: 'coach' })
const coachText = JSON.stringify(coachOn.body)
ok(coachText.includes('get_onboarding_state'), 'flag-on: coach prompt mentions onboarding')
const coachOff = await rpc(TOKEN_C, 'prompts/get', { name: 'coach' })
ok(!JSON.stringify(coachOff.body).includes('get_onboarding_state'), 'flag-off: coach prompt is unchanged')

const stateC = toolText((await rpcOn(TOKEN_C, 'tools/call', { name: 'get_onboarding_state', arguments: {} })).body)
ok(stateC.includes('Step: hook') && stateC.includes('Session 1: none'), 'e2e: get_onboarding_state reads C')
ok(stateC.includes('Next question') && stateC.includes('goal'), 'e2e: get_onboarding_state suggests the next question')
ok(!stateC.includes('Athlete B') && !stateC.includes('B only'), 'isolation: C state does not leak B')

const packs = toolText((await rpcOn(TOKEN_C, 'tools/call', { name: 'list_starter_packs', arguments: {} })).body)
ok(packs.includes('sport_sc') && packs.includes('get_strong') && packs.includes('byo'), 'e2e: list_starter_packs names all 7 packs')
ok(packs.includes('sport') && packs.includes('setting'), 'e2e: list_starter_packs says sport is a setting')

const recPreview = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'record_onboarding_answers',
  arguments: { answers: { goal: 'get_strong', days: 3, pain: 'nothing' } },
})).body)
ok(recPreview.includes('Preview only'), 'e2e: record_onboarding_answers without confirm only previews')
const [cBefore] = await sql<{ onboarding_answers: unknown }[]>`SELECT onboarding_answers FROM athlete WHERE id = ${C}`
ok(cBefore?.onboarding_answers == null, 'e2e: record preview writes nothing')

const recSaved = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'record_onboarding_answers',
  arguments: { answers: { goal: 'get_strong', days: 3, pain: 'nothing', minutes: 45 }, confirm: true, athlete_id: B },
})).body)
ok(recSaved.includes('Saved.'), 'e2e: record_onboarding_answers with confirm saves')
const [cAns] = await sql<{ onboarding_answers: unknown }[]>`SELECT onboarding_answers FROM athlete WHERE id = ${C}`
const cAnsVal = typeof cAns?.onboarding_answers === 'string' ? JSON.parse(cAns.onboarding_answers) : cAns?.onboarding_answers
ok((cAnsVal as { v?: number; goal?: string } | null)?.v === 1, 'e2e: saved answers carry v:1')
ok((cAnsVal as { v?: number; goal?: string } | null)?.goal === 'get_strong', 'e2e: C answers were saved')
ok(!Object.prototype.hasOwnProperty.call(cAnsVal ?? {}, 'starter_pack'), 'e2e: answers stay off starter_pack_settings')
const badVersion = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'record_onboarding_answers',
  arguments: { answers: { v: 2, goal: 'hybrid' }, confirm: true },
})).body)
ok(badVersion.includes('Refused') && badVersion.includes('v must be 1'), 'e2e: v!=1 answers are refused')
const [cAnsAfterBad] = await sql<{ onboarding_answers: unknown }[]>`SELECT onboarding_answers FROM athlete WHERE id = ${C}`
const cAnsAfterBadVal = typeof cAnsAfterBad?.onboarding_answers === 'string'
  ? JSON.parse(cAnsAfterBad.onboarding_answers)
  : cAnsAfterBad?.onboarding_answers
ok((cAnsAfterBadVal as { goal?: string } | null)?.goal === 'get_strong', 'e2e: refused v!=1 write leaves prior answers')
const [bAns] = await sql<{ onboarding_answers: unknown }[]>`SELECT onboarding_answers FROM athlete WHERE id = ${B}`
ok(bAns?.onboarding_answers == null, 'isolation: athlete_id override cannot write B answers')

const packPreview = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'preview_starter_pack',
  arguments: { pack: 'get_strong' },
})).body)
ok(packPreview.includes('Recommended: get_strong') && packPreview.includes('arithmetic:'), 'e2e: preview_starter_pack shows pack + arithmetic')
ok(packPreview.includes('Writes nothing'), 'e2e: preview_starter_pack says it writes nothing')
const [cPackBefore] = await sql<{ starter_pack: string | null }[]>`SELECT starter_pack FROM athlete WHERE id = ${C}`
ok(cPackBefore?.starter_pack == null, 'e2e: preview_starter_pack writes no pack')

const painPrev = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'preview_starter_pack',
  arguments: { pack: 'chase_total', answers: { pain: 'knee' } },
})).body)
// answers on preview are not a write path; pain comes from saved answers (nothing) unless we record it
ok(painPrev.includes('get_strong') || painPrev.includes('layoff') || painPrev.includes('chase_total'), 'e2e: preview_starter_pack returns a pack')

const recPain = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'record_onboarding_answers',
  arguments: { answers: { pain: 'knee' }, confirm: true },
})).body)
ok(recPain.includes('Saved.'), 'e2e: pain answer saved')
const painPack = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'preview_starter_pack',
  arguments: { pack: 'chase_total' },
})).body)
ok(painPack.includes('layoff') && painPack.includes('Pain-flag override'), 'e2e: preview enforces the pain flag in the engine')

const startRefused = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'start_starter_pack',
  arguments: { pack: 'layoff' },
})).body)
ok(startRefused.includes('confirm=true'), 'e2e: start_starter_pack without confirm is refused')
const [cProgBefore] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM program WHERE athlete_id = ${C}`
ok(cProgBefore?.n === '0', 'e2e: start without confirm writes no program')

const started = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'start_starter_pack',
  arguments: { pack: 'chase_total', confirm: true, athlete_id: B },
})).body)
ok(started.includes('Started layoff') || started.includes('Already started'), 'e2e: start_starter_pack with confirm writes (pain routes to layoff)')
const [cAfter] = await sql<{ starter_pack: string | null; onboarding_step: string }[]>`
  SELECT starter_pack, onboarding_step FROM athlete WHERE id = ${C}
`
ok(cAfter?.starter_pack === 'layoff', 'e2e: C pack is layoff after pain flag')
ok(cAfter?.onboarding_step === 'first_session_pending', 'e2e: start advances onboarding_step')
const [cProg] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM program WHERE athlete_id = ${C} AND status = 'active'`
ok(cProg?.n === '1', 'e2e: C has one active program')
const [bProg] = await sql<{ goal: string | null }[]>`SELECT goal FROM program WHERE athlete_id = ${B} AND status = 'active'`
ok(bProg?.goal === 'B program', 'isolation: start cannot replace B via athlete_id')

const again = toolText((await rpcOn(TOKEN_C, 'tools/call', {
  name: 'start_starter_pack',
  arguments: { pack: 'layoff', confirm: true },
})).body)
ok(again.includes('Already started') || again.includes('Idempotent'), 'e2e: start_starter_pack is idempotent')
const [cProg2] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM program WHERE athlete_id = ${C}`
ok(cProg2?.n === '1', 'e2e: idempotent start does not insert a second program')

const aRefuse = toolText((await rpcOn(TOKEN_A, 'tools/call', {
  name: 'start_starter_pack',
  arguments: { pack: 'get_strong', confirm: true },
})).body)
ok(aRefuse.includes('already has a live program'), 'e2e: start refuses a live program without replace')
const [aPack] = await sql<{ starter_pack: string | null }[]>`SELECT starter_pack FROM athlete WHERE id = ${A}`
ok(aPack?.starter_pack == null, 'e2e: refused start writes no pack on A')

const aReplace = toolText((await rpcOn(TOKEN_A, 'tools/call', {
  name: 'start_starter_pack',
  arguments: { pack: 'get_strong', confirm: true, replace: true },
})).body)
ok(aReplace.includes('Started get_strong'), 'e2e: start with replace=true writes A')
const [aAfter] = await sql<{ starter_pack: string | null }[]>`SELECT starter_pack FROM athlete WHERE id = ${A}`
ok(aAfter?.starter_pack === 'get_strong', 'e2e: A pack is get_strong after replace')
const [aActive] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM program WHERE athlete_id = ${A} AND status = 'active'`
ok(aActive?.n === '1', 'e2e: A still has one active program after replace')
const [bStill] = await sql<{ name: string }[]>`SELECT name FROM routine WHERE id = ${'88888888-8888-8888-8888-888888888888'}`
ok(bStill?.name === 'B day', 'isolation: replace on A leaves B routines alone')

const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AUTH_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
await sql`INSERT INTO auth.users (id, email) VALUES (${AUTH_D}, ${'d@example.com'})`
await sql`
  INSERT INTO athlete (id, auth_user_id, name, onboarding_step, starter_pack, starter_pack_settings, onboarding_answers)
  VALUES (
    ${D}, ${AUTH_D}, ${'Athlete D'}, ${'first_session_pending'}, ${'get_strong'},
    ${JSON.stringify({ sport: 'basketball' })}::jsonb,
    ${JSON.stringify({ v: 1, goal: 'get_strong', pain: 'nothing' })}::jsonb
  )
`
const resetD = await executeDataQuery(sql, { userId: AUTH_D, athleteId: D }, {
  table: 'athlete',
  op: 'rpc',
  fn: 'reset_athlete_orientation',
})
ok(resetD.status === 200 && resetD.error == null, 'reset: orientation wipe succeeds')
const [dWiped] = await sql<{
  starter_pack: string | null
  starter_pack_settings: unknown
  onboarding_answers: unknown
  onboarding_step: string
}[]>`
  SELECT starter_pack, starter_pack_settings, onboarding_answers, onboarding_step
  FROM athlete WHERE id = ${D}
`
ok(dWiped?.onboarding_step === 'hook', 'reset: step returns to hook')
ok(dWiped?.starter_pack == null, 'reset: starter_pack is cleared')
ok(dWiped?.starter_pack_settings == null, 'reset: starter_pack_settings is cleared')
ok(dWiped?.onboarding_answers == null, 'reset: onboarding_answers is cleared')
ok((await sql<{ name: string }[]>`SELECT name FROM athlete WHERE id = ${A}`)[0]?.name === 'Athlete A', 'reset: A athlete row is untouched')

await sql`
  UPDATE athlete SET
    starter_pack = ${'layoff'},
    starter_pack_settings = ${JSON.stringify({ season: 'off' })}::jsonb,
    onboarding_answers = ${JSON.stringify({ v: 1, goal: 'layoff', pain: 'knee' })}::jsonb
  WHERE id = ${D}
`
await sql`DELETE FROM auth.users WHERE id = ${AUTH_D}`
const [dGone] = await sql<{ id: string }[]>`SELECT id FROM athlete WHERE id = ${D}`
ok(dGone == null, 'account-delete: athlete row (and new columns) cascade with the auth user')
ok((await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM athlete WHERE id = ${D}`)[0]?.n === '0', 'account-delete: no leftover D row')
ok((await sql<{ starter_pack: string | null }[]>`SELECT starter_pack FROM athlete WHERE id = ${A}`)[0]?.starter_pack === 'get_strong', 'account-delete: A pack is untouched')
ok((await sql<{ onboarding_answers: unknown }[]>`SELECT onboarding_answers FROM athlete WHERE id = ${B}`)[0]?.onboarding_answers == null, 'account-delete: B answers stay null')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`mcp port: ok (${harness.backend})`)
