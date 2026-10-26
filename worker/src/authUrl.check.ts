// Run: node --experimental-strip-types worker/src/authUrl.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import app from './index.ts'
import { authConfigErrorResponse, beginAuthCors } from './cors.ts'
import { databaseUrl, useDatabaseSsl } from './env.ts'
import {
  authCookieSecure,
  connectionHostname,
  isLocalAuthHost,
  isLocalAuthRuntime,
  isLoopbackHostname,
  resolveAuthBaseURL,
} from './authUrl.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const neon = 'postgresql://neondb@ep-prod.us-east-1.aws.neon.tech/zeroed'
const prodWithLocalUser = 'postgresql://localhost_admin@ep-prod.neon.tech/zeroed'
const prodWithLocalDb = 'postgresql://app@ep-prod.neon.tech/localhost'
const prodWithLocalQuery = 'postgresql://app@ep-prod.neon.tech/zeroed?application_name=localhost&sslmode=require'
const loopbackPg = 'postgresql://postgres@localhost:5432/zeroed'
const loopbackV4 = 'postgresql://postgres@127.0.0.1:5432/zeroed'
const loopbackV6 = 'postgresql://postgres:postgres@[::1]:5432/zeroed'

// A2 — [::1] is loopback
ok(isLoopbackHostname('::1'), '::1 hostname is loopback')
ok(isLoopbackHostname('[::1]'), '[::1] hostname is loopback')
ok(isLocalAuthHost('http://[::1]:8787'), '[::1] auth origin is local')
ok(isLocalAuthHost('http://[::1]'), '[::1] without port is local')
ok(!authCookieSecure('http://[::1]:8787'), '[::1] cookies are not Secure')
ok(isLocalAuthRuntime({ DATABASE_URL: loopbackV6 }), '[::1] DB hostname is local runtime')
ok(connectionHostname(loopbackV6) === '[::1]' || connectionHostname(loopbackV6) === '::1', '[::1] postgres hostname parses')

ok(isLocalAuthHost('http://localhost:8787'), 'localhost is local')
ok(isLocalAuthHost('http://127.0.0.1:5173'), '127.0.0.1 is local')
ok(isLoopbackHostname('127.1'), '127.1 hostname is loopback')
ok(isLocalAuthHost('http://127.1:8787'), '127.1 auth origin is local')
ok(isLocalAuthRuntime({ DATABASE_URL: 'postgresql://postgres@127.1:5432/zeroed' }), '127.1 DB hostname is local')
ok(!isLocalAuthHost('https://zeroed.example.workers.dev'), 'workers.dev is not local')
ok(!authCookieSecure('http://localhost:8787'), 'localhost cookies are not Secure')
ok(authCookieSecure('https://zeroed.example.workers.dev'), 'prod cookies are Secure')

// A1 — no substring match on user / db / query
ok(!isLocalAuthRuntime({ DATABASE_URL: prodWithLocalUser }), 'user localhost_admin is not local')
ok(!isLocalAuthRuntime({ DATABASE_URL: prodWithLocalDb }), 'db name localhost is not local')
ok(!isLocalAuthRuntime({ DATABASE_URL: prodWithLocalQuery }), 'query localhost is not local')
ok(!isLocalAuthRuntime({ DATABASE_URL: neon }), 'Neon URL is not local')
ok(!isLocalAuthRuntime({}), 'empty env is not local')
ok(!isLocalAuthRuntime({ ENVIRONMENT: 'dev' }), 'ENVIRONMENT=dev is not local')
ok(!isLocalAuthRuntime({ ENVIRONMENT: 'development' }), 'ENVIRONMENT=development is not local')
ok(isLocalAuthRuntime({ ENVIRONMENT: 'local' }), 'ENVIRONMENT=local is local')
ok(!useDatabaseSsl(neon, { ENVIRONMENT: 'local' }), 'local env disables postgres.js ssl')
ok(useDatabaseSsl(neon), 'Neon URL uses ssl')
ok(!useDatabaseSsl(loopbackPg), 'loopback postgres URL disables ssl')
ok(!useDatabaseSsl('postgresql://u:p@hyperdrive.internal/db?sslmode=disable'), 'sslmode=disable is not require')
ok(
  databaseUrl({ ENVIRONMENT: 'local', DATABASE_URL: loopbackPg, HYPERDRIVE: { connectionString: neon } }) === loopbackPg,
  'local DATABASE_URL beats Hyperdrive',
)
ok(
  databaseUrl({ HYPERDRIVE: { connectionString: neon }, DATABASE_URL: loopbackPg }) === neon,
  'prod Hyperdrive beats DATABASE_URL',
)
ok(isLocalAuthRuntime({ ENVIRONMENT: 'LOCAL' }), 'ENVIRONMENT=LOCAL is local')
ok(isLocalAuthRuntime({ DATABASE_URL: loopbackPg }), 'hostname localhost is local')
ok(isLocalAuthRuntime({ DATABASE_URL: loopbackV4 }), 'hostname 127.0.0.1 is local')
ok(
  isLocalAuthRuntime({ HYPERDRIVE: { connectionString: loopbackV4 } }),
  'Hyperdrive loopback hostname is local',
)
ok(
  isLocalAuthRuntime({ ENVIRONMENT: 'local', DATABASE_URL: prodWithLocalUser }),
  'ENVIRONMENT=local wins even with a prod-looking URL',
)
ok(connectionHostname(prodWithLocalUser) === 'ep-prod.neon.tech', 'parses host not user')
ok(connectionHostname(prodWithLocalDb) === 'ep-prod.neon.tech', 'parses host not db name')
ok(connectionHostname(prodWithLocalQuery) === 'ep-prod.neon.tech', 'parses host not query')

ok(
  resolveAuthBaseURL({ BETTER_AUTH_URL: 'https://zeroed.example.workers.dev/' }) === 'https://zeroed.example.workers.dev',
  'configured URL wins and strips trailing slash',
)
ok(
  resolveAuthBaseURL({ DATABASE_URL: loopbackPg }) === 'http://localhost:8787',
  'unset URL falls back when DB hostname is loopback',
)
ok(
  resolveAuthBaseURL({ ENVIRONMENT: 'local' }) === 'http://localhost:8787',
  'unset URL falls back when ENVIRONMENT=local',
)

function throwsUnset(env: Parameters<typeof resolveAuthBaseURL>[0]): boolean {
  try {
    resolveAuthBaseURL(env)
    return false
  } catch (err) {
    return err instanceof Error && err.message.includes('BETTER_AUTH_URL must be set')
  }
}

ok(throwsUnset({ DATABASE_URL: neon }), 'unset URL + Neon throws')
ok(throwsUnset({}), 'unset URL with no local signal throws')
ok(throwsUnset({ BETTER_AUTH_URL: '   ', DATABASE_URL: neon }), 'whitespace URL throws outside local')
ok(throwsUnset({ DATABASE_URL: prodWithLocalUser }), 'unset URL + localhost in user throws')
ok(throwsUnset({ DATABASE_URL: prodWithLocalDb }), 'unset URL + localhost in db name throws')
ok(throwsUnset({ DATABASE_URL: prodWithLocalQuery }), 'unset URL + localhost in query throws')
ok(throwsUnset({ ENVIRONMENT: 'dev', DATABASE_URL: neon }), 'ENVIRONMENT=dev + Neon throws')

// A3 — ENVIRONMENT documented where local config lives
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
ok(
  readFileSync(join(root, 'wrangler.jsonc'), 'utf8').includes('ENVIRONMENT=local'),
  'wrangler.jsonc documents ENVIRONMENT=local',
)
ok(
  /ENVIRONMENT=local/.test(readFileSync(join(root, '.dev.vars.example'), 'utf8')),
  '.dev.vars.example sets ENVIRONMENT=local',
)
ok(
  readFileSync(join(root, 'docs/cloudflare-cutover.md'), 'utf8').includes('ENVIRONMENT'),
  'cutover docs mention ENVIRONMENT',
)

// A4 / B1 — misconfig is JSON 500; echo ACAO only for loopback Origins
const prodEnv = {
  DATABASE_URL: prodWithLocalUser,
  BETTER_AUTH_SECRET: 'x'.repeat(32),
}
const started = beginAuthCors('https://zeroed.example', prodEnv)
ok(!started.ok, 'beginAuthCors fails closed when URL unset outside local')
if (!started.ok) {
  ok(started.response.status === 500, 'misconfig status is 500')
  ok(
    (started.response.headers.get('content-type') ?? '').includes('application/json'),
    'misconfig is JSON',
  )
  ok(
    started.response.headers.get('access-control-allow-origin') == null,
    'non-loopback misconfig omits ACAO',
  )
  ok(
    started.response.headers.get('access-control-allow-credentials') == null,
    'non-loopback misconfig omits credentials',
  )
  const body = await started.response.json() as { error?: string }
  ok(
    typeof body.error === 'string' && body.error.includes('BETTER_AUTH_URL must be set'),
    'misconfig body names BETTER_AUTH_URL',
  )
}

const loopbackErr = authConfigErrorResponse('http://localhost:5173', new Error('BETTER_AUTH_URL must be set'))
ok(loopbackErr.headers.get('access-control-allow-origin') === 'http://localhost:5173', 'loopback misconfig echoes Origin')
ok(loopbackErr.headers.get('access-control-allow-credentials') === 'true', 'loopback misconfig keeps credentials')

const noOrigin = authConfigErrorResponse(null, new Error('BETTER_AUTH_URL must be set'))
ok(noOrigin.status === 500, 'misconfig without Origin is 500')
ok(noOrigin.headers.get('access-control-allow-origin') == null, 'no-Origin misconfig omits ACAO')
ok(noOrigin.headers.get('access-control-allow-credentials') == null, 'no-Origin misconfig omits credentials')

for (const method of ['OPTIONS', 'GET', 'POST'] as const) {
  const res = await app.request(`http://localhost/api/auth/ok`, {
    method,
    headers: { Origin: 'https://evil.example' },
  }, prodEnv)
  ok(res.status === 500, `${method} evil.example: JSON 500`)
  ok(res.headers.get('access-control-allow-origin') == null, `${method} evil.example: no ACAO`)
  ok(res.headers.get('access-control-allow-credentials') == null, `${method} evil.example: no credentials`)
}

const localOk = beginAuthCors('http://localhost:5173', { ENVIRONMENT: 'local' })
ok(localOk.ok, 'beginAuthCors succeeds when ENVIRONMENT=local')
if (localOk.ok) {
  ok(
    localOk.cors['Access-Control-Allow-Origin'] === 'http://localhost:5173',
    'local CORS echoes vite origin',
  )
}

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('authUrl: ok')
