// Run: node --experimental-strip-types worker/src/db.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compileTagged,
  makeClientSql,
  pgArrayLiteral,
  sslForConnection,
  taggedArray,
  withSql,
} from './db.ts'
import type { Env } from './env.ts'
import { assertCiUsesRealPostgres, openIsolationHarness, testDatabaseUrl } from './isolationDb.ts'
import { handleMcp } from './mcp.ts'
import { sha256Hex } from './mcpToken.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

assertCiUsesRealPostgres()

const neon = 'postgresql://neondb@ep-prod.us-east-1.aws.neon.tech/zeroed'
const prodQueryLocal = 'postgresql://app@ep-prod.neon.tech/zeroed?x=localhost&sslmode=require'
const lookalike = 'postgresql://app@127.0.0.1.example.com/zeroed'
const loopback = 'postgresql://postgres@127.0.0.1:5432/zeroed_test'
const loopbackNamed = 'postgresql://postgres@localhost:5432/zeroed_test'
const loopbackV6 = 'postgresql://postgres:postgres@[::1]:5432/zeroed_test'

ok(sslForConnection(neon) === 'require', 'ssl: Neon without sslmode requires TLS')
ok(sslForConnection(`${neon}?sslmode=require`) === 'require', 'ssl: sslmode=require is TLS')
ok(sslForConnection(`${neon}?sslmode=verify-full`) === 'require', 'ssl: sslmode=verify-full is TLS')
ok(sslForConnection(`${neon}?sslmode=prefer`) === 'require', 'ssl: remote sslmode=prefer still requires TLS')
ok(sslForConnection(`${neon}?sslmode=disable`) === false, 'ssl: sslmode=disable is off')
ok(sslForConnection(prodQueryLocal) === 'require', 'ssl: query value localhost does not disable TLS')
ok(sslForConnection(lookalike) === 'require', 'ssl: 127.0.0.1.example.com is not loopback')
ok(sslForConnection(loopback) === false, 'ssl: 127.0.0.1 without sslmode is off')
ok(sslForConnection(loopbackNamed) === false, 'ssl: localhost without sslmode is off')
ok(sslForConnection(loopbackV6) === false, 'ssl: [::1] without sslmode is off')
ok(sslForConnection(`${loopback}?sslmode=require`) === 'require', 'ssl: loopback + sslmode=require is TLS')
ok(sslForConnection(`${loopback}?sslmode=disable`) === false, 'ssl: loopback + sslmode=disable is off')
ok(sslForConnection(`${loopback}?sslmode=prefer`) === false, 'ssl: loopback + sslmode=prefer is off')
ok(sslForConnection(`${loopback}?application_name=localhost`) === false, 'ssl: loopback query localhost does not flip TLS')

const here = dirname(fileURLToPath(import.meta.url))
const dbSrc = readFileSync(join(here, 'db.ts'), 'utf8')
ok(!/\bWeakMap\b/.test(dbSrc), 'db.ts has no WeakMap client cache')
ok(!/\bgetSql\b/.test(dbSrc), 'db.ts has no getSql cache helper')
ok(!/\bconst cache\b/.test(dbSrc), 'db.ts has no module-scope client cache')
ok(!/clients\s*=/.test(dbSrc), 'db.ts has no module-scope clients map')
ok(dbSrc.includes('withSql') && dbSrc.includes('makeClientSql'), 'db.ts exposes per-request withSql/makeClientSql')
ok(dbSrc.includes('waitUntil'), 'db.ts closes via waitUntil when a ctx is present')
ok(!/fetch_types:\s*false/.test(dbSrc), 'db.ts does not set postgres.js fetch_types:false')
ok(pgArrayLiteral(['33333333-3333-3333-3333-333333333333']) === '{"33333333-3333-3333-3333-333333333333"}', 'pgArrayLiteral: one uuid')
ok(pgArrayLiteral(['a', 'b"c']).includes('\\"'), 'pgArrayLiteral: quotes are escaped')

const storeSrc = readFileSync(join(here, 'store.ts'), 'utf8')
ok(storeSrc.includes('sql.array(ids)'), 'loadNotes binds program ids with sql.array')
ok(!/ANY\(\$\{ids\}\)/.test(storeSrc), 'store.ts has no uncast ANY(${ids})')

const dataSrc = readFileSync(join(here, 'data.ts'), 'utf8')
ok(dataSrc.includes('unnest($${idx}${cast})'), 'data in-filter uses unnest + cast')
ok(dataSrc.includes('::uuid[]') && dataSrc.includes('::text[]'), 'data in-filter has explicit array casts')
ok(dataSrc.includes("op === 'in' ? 'FALSE' : 'TRUE'"), 'empty in[] does not bind an empty uuid[] as text[]')

const authSrc = readFileSync(join(here, 'auth.ts'), 'utf8')
ok(!authSrc.includes('allowExitOnIdle'), 'auth.ts has no allowExitOnIdle (workerd tid.unref)')
ok(authSrc.includes('new Client('), 'auth.ts opens a Workers-safe Client per request')
ok(authSrc.includes('waitUntil'), 'auth.ts closes the client via waitUntil')
ok(authSrc.includes('lower(${col}) = lower(${param})'), 'auth.ts adoption lookup is lower(email)')
ok(authSrc.includes('"user"."email"'), 'auth.ts rewrite handles Better Auth 1.7 qualified email')

const uuid = '11111111-1111-1111-1111-111111111111'
const compiled = compileTagged(
  Object.assign(['WHERE program_id = ANY(', ')'], { raw: ['WHERE program_id = ANY(', ')'] }),
  [taggedArray([uuid])],
)
ok(compiled.text === 'WHERE program_id = ANY($1::uuid[])', 'compileTagged: sql.array emits ::uuid[]')
ok(Array.isArray(compiled.params[0]) && (compiled.params[0] as string[])[0] === uuid, 'compileTagged: array stays a JS array')

const bare = compileTagged(
  Object.assign(['WHERE id = ANY(', ')'], { raw: ['WHERE id = ANY(', ')'] }),
  [[uuid]],
)
ok(bare.text.includes('::uuid[]'), 'compileTagged: bare JS uuid array is cast')

let last = { text: '', params: [] as unknown[] }
const sql = makeClientSql(async (text, params = []) => {
  last = { text, params }
  return { rows: [{ n: 1 }] }
})
await sql`SELECT id FROM program WHERE id = ANY(${sql.array([uuid, '22222222-2222-2222-2222-222222222222'])})`
ok(last.text.includes('::uuid[]'), 'makeClientSql: sql.array in a tag is ::uuid[]')
ok(Array.isArray(last.params[0]) && (last.params[0] as unknown[]).length === 2, 'makeClientSql: two ids in one array param')

const url = testDatabaseUrl()
if (url) {
  const env = { DATABASE_URL: url } as Env
  const waitUntilCalls: Promise<unknown>[] = []
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilCalls.push(promise)
    },
  }

  const arrayBound = await withSql(env, async (clientSql) => {
    const literal = pgArrayLiteral(['33333333-3333-3333-3333-333333333333'])
    const [row] = await clientSql<{ n: number }[]>`SELECT cardinality(${literal}::uuid[])::int AS n`
    return Number(row?.n)
  }, ctx)
  ok(arrayBound === 1, 'withSql: pgArrayLiteral binds as uuid[] on real Postgres')
  ok(waitUntilCalls.length === 1, 'withSql: array bind scheduled waitUntil close')

  const first = await withSql(env, async (clientSql) => {
    const [row] = await clientSql<{ n: number }[]>`SELECT 1::int AS n`
    return Number(row?.n)
  }, ctx)
  ok(first === 1, 'withSql: first request on env returns 1')
  ok(waitUntilCalls.length === 2, 'withSql: first request scheduled waitUntil close')

  const second = await withSql(env, async (clientSql) => {
    const [row] = await clientSql<{ n: number }[]>`SELECT 2::int AS n`
    return Number(row?.n)
  }, ctx)
  ok(second === 2, 'withSql: second request on the same env returns 2')
  ok(waitUntilCalls.length === 3, 'withSql: second request scheduled its own close')

  const third = await withSql(env, async (clientSql) => {
    const [row] = await clientSql<{ n: number }[]>`SELECT 3::int AS n`
    return Number(row?.n)
  }, ctx)
  ok(third === 3, 'withSql: third sequential request on the same env returns 3')
  ok(waitUntilCalls.length === 4, 'withSql: each sequential request opened its own client')
  await Promise.all(waitUntilCalls)

  const harness = await openIsolationHarness()
  const TOKEN_A = 'zeroed-mcp-token-athlete-a-aaaaaaaa'
  await harness.sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(TOKEN_A)} WHERE name = ${'claude-a'}`
  await harness.close()

  const mcpWaits: Promise<unknown>[] = []
  const mcpCtx = {
    waitUntil(promise: Promise<unknown>) {
      mcpWaits.push(promise)
    },
  }

  async function ping(i: number): Promise<Response> {
    return handleMcp(new Request('https://zeroed.test/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN_A}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
    }), env, { ctx: mcpCtx })
  }

  for (let i = 1; i <= 5; i++) {
    const res = await ping(i)
    ok(res.status === 200, `sequential MCP ${i}/5 on one env is 200`)
    await res.json()
  }
  ok(mcpWaits.length === 5, 'sequential MCP: each request scheduled waitUntil close')

  const notes = await handleMcp(new Request('https://zeroed.test/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN_A}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'get_coach_notes', arguments: {} },
    }),
  }), env, { ctx: mcpCtx })
  ok(notes.status === 200, 'openSql path: get_coach_notes is 200')
  const notesBody = await notes.json() as {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  const notesText = notesBody.result?.content?.[0]?.text ?? notesBody.error?.message ?? ''
  ok(
    (notesText.includes('A weekly note') || notesText.includes('private A'))
      && !notesText.includes('malformed array'),
    'openSql path: get_coach_notes binds uuid[] without leaking PG array error',
  )
  await Promise.all(mcpWaits)
}

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
if (process.env.CI && !url) {
  console.error('CI must run db.check sequential requests against real Postgres')
  process.exit(1)
}
console.log('db: ok')
