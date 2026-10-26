// Parity, token isolation, revoked 401, and "load a full program".
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/mcp.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from './env.ts'
import { openIsolationHarness } from './isolationDb.ts'
import { handleMcp, publicMcpError } from './mcp.ts'
import { resolveMcpToken, sha256Hex, timingSafeEqualHex } from './mcpToken.ts'
import { ZEROED_TOOLS } from './tools.ts'
import { LIFT_MODEL_TOOLS } from '../../supabase/functions/_shared/liftModelTools.ts'
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
const PROG_A = '33333333-3333-3333-3333-333333333333'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const WORKOUT_A = '99999999-9999-9999-9999-999999999999'
const WORKOUT_B = 'bbbb9999-9999-4999-8999-999999999999'

const TOKEN_A = 'zeroed-mcp-token-athlete-a-aaaaaaaa'
const TOKEN_B = 'zeroed-mcp-token-athlete-b-bbbbbbbb'
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

await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_A)} WHERE name = ${'claude-a'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_B)} WHERE name = ${'claude-b'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_REVOKED)} WHERE name = ${'revoked-a'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_EXPIRED)} WHERE name = ${'expired-a'}`

const resolvedA = await resolveMcpToken(sql, TOKEN_A)
ok(resolvedA?.athlete_id === A, 'resolveMcpToken: A token maps to A')
ok((await resolveMcpToken(sql, TOKEN_B))?.athlete_id === B, 'resolveMcpToken: B token maps to B')
ok(await resolveMcpToken(sql, TOKEN_REVOKED) === null, 'resolveMcpToken: revoked is null')
ok(await resolveMcpToken(sql, TOKEN_EXPIRED) === null, 'resolveMcpToken: expired is null')

async function mcp(
  token: string | null,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  return handleMcp(new Request('https://zeroed.test/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }), env, { sql })
}

async function rpc(token: string, method: string, params: unknown = {}, id: number | string = 1) {
  const res = await mcp(token, { jsonrpc: '2.0', id, method, params })
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
ok((aTmValue as Record<string, number> | null)?.squat === 200, 'e2e: A\'s squat TM is 200')
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

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`mcp port: ok (${harness.backend})`)
