// Run: node --experimental-strip-types worker/src/authUrl.check.ts
import {
  authCookieSecure,
  isLocalAuthHost,
  isLocalAuthRuntime,
  resolveAuthBaseURL,
} from './authUrl.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(isLocalAuthHost('http://localhost:8787'), 'localhost is local')
ok(isLocalAuthHost('http://127.0.0.1:5173'), '127.0.0.1 is local')
ok(!isLocalAuthHost('https://zeroed.example.workers.dev'), 'workers.dev is not local')
ok(!authCookieSecure('http://localhost:8787'), 'localhost cookies are not Secure')
ok(authCookieSecure('https://zeroed.example.workers.dev'), 'prod cookies are Secure')

ok(isLocalAuthRuntime({ DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/zeroed' }), 'local DB is local runtime')
ok(isLocalAuthRuntime({ ENVIRONMENT: 'development' }), 'ENVIRONMENT=development is local')
ok(!isLocalAuthRuntime({ DATABASE_URL: 'postgresql://neondb@ep-prod.us-east-1.aws.neon.tech/zeroed' }), 'Neon URL is not local')
ok(!isLocalAuthRuntime({}), 'empty env is not local')

ok(
  resolveAuthBaseURL({ BETTER_AUTH_URL: 'https://zeroed.example.workers.dev/' }) === 'https://zeroed.example.workers.dev',
  'configured URL wins and strips trailing slash',
)
ok(
  resolveAuthBaseURL({ DATABASE_URL: 'postgresql://x@localhost:5432/zeroed' }) === 'http://localhost:8787',
  'unset URL falls back on local runtime',
)
ok(
  resolveAuthBaseURL({ ENVIRONMENT: 'dev' }) === 'http://localhost:8787',
  'unset URL falls back when ENVIRONMENT=dev',
)

let threw = false
try {
  resolveAuthBaseURL({ DATABASE_URL: 'postgresql://neondb@ep-prod.neon.tech/zeroed' })
} catch (err) {
  threw = err instanceof Error && err.message.includes('BETTER_AUTH_URL must be set')
}
ok(threw, 'unset URL outside local throws')

threw = false
try {
  resolveAuthBaseURL({})
} catch (err) {
  threw = err instanceof Error && err.message.includes('BETTER_AUTH_URL must be set')
}
ok(threw, 'unset URL with no local signal throws')

threw = false
try {
  resolveAuthBaseURL({ BETTER_AUTH_URL: '   ', HYPERDRIVE: { connectionString: 'postgresql://x@neon.tech/db' } })
} catch (err) {
  threw = err instanceof Error && err.message.includes('BETTER_AUTH_URL must be set')
}
ok(threw, 'whitespace URL is treated as unset and throws outside local')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('authUrl: ok')
