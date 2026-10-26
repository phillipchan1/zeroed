// Run: node --experimental-strip-types worker/src/postgres.check.ts
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const isolationSrc = readFileSync(join(here, 'isolationDb.ts'), 'utf8')
const proveSrc = readFileSync(join(root, 'scripts/prove-postgres.mjs'), 'utf8')

ok(!/\bopenIsolationSql\b/.test(isolationSrc), 'isolationDb has no openIsolationSql wipe path')
ok(
  !/process\.env\.DATABASE_URL/.test(isolationSrc),
  'isolationDb never reads DATABASE_URL',
)
ok(
  proveSrc.includes("refuseUnsafeTestUrl(url, 'DATABASE_URL')"),
  'prove-postgres runs refuseUnsafeTestUrl on DATABASE_URL',
)
ok(
  proveSrc.includes("from '../worker/src/authUrl.ts'"),
  'prove-postgres imports refuseUnsafeTestUrl without loading isolationDb',
)
ok(
  proveSrc.indexOf("refuseUnsafeTestUrl(url, 'DATABASE_URL')")
    < proveSrc.indexOf("await import('../worker/src/db.ts')"),
  'prove-postgres refuses before importing db.ts',
)

const neon = 'postgresql://neondb@ep-prod.us-east-1.aws.neon.tech/zeroed'
const lookalike = 'postgresql://app@127.0.0.1.example.com/zeroed'
const prodLocalUser = 'postgresql://localhost_admin@ep-prod.neon.tech/zeroed'

function runCheckPostgres(databaseUrl: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const started = Date.now()
  const res = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/prove-postgres.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        DATABASE_URL: databaseUrl,
        ...extraEnv,
      },
    },
  )
  return {
    elapsedMs: Date.now() - started,
    status: res.status,
    timedOut: res.error?.message?.includes('ETIMEDOUT') === true,
    out: `${res.stdout || ''}\n${res.stderr || ''}`,
  }
}

function refusedWithoutQuery(label: string, result: ReturnType<typeof runCheckPostgres>, host: string) {
  ok(result.status !== 0, `${label}: check:postgres exits non-zero`)
  ok(!result.timedOut, `${label}: check:postgres does not wait on a remote connect`)
  ok(
    result.out.includes(`${host}" is not loopback`) && result.out.includes('refusing to wipe'),
    `${label}: names the non-loopback host and refuses`,
  )
  ok(
    !result.out.includes('sequential withSql')
      && !result.out.includes('access isolation:')
      && !result.out.includes('postgres gate: ok'),
    `${label}: does not connect or run any query`,
  )
}

refusedWithoutQuery('Neon DATABASE_URL', runCheckPostgres(neon), 'ep-prod.us-east-1.aws.neon.tech')
refusedWithoutQuery(
  'ENVIRONMENT=local + Neon',
  runCheckPostgres(neon, { ENVIRONMENT: 'local', ZEROED_REAL_PG: '1' }),
  'ep-prod.us-east-1.aws.neon.tech',
)
refusedWithoutQuery('127.0.0.1.example.com lookalike', runCheckPostgres(lookalike), '127.0.0.1.example.com')
refusedWithoutQuery('localhost in user, Neon host', runCheckPostgres(prodLocalUser), 'ep-prod.neon.tech')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('postgres refuse: ok')
