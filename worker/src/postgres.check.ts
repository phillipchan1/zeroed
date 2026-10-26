// Run: node --experimental-strip-types worker/src/postgres.check.ts
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const refuseSrc = readFileSync(join(here, 'refuseTestUrl.ts'), 'utf8')

ok(!/\bopenIsolationSql\b/.test(isolationSrc), 'isolationDb has no openIsolationSql wipe path')
ok(
  !/process\.env\.DATABASE_URL/.test(isolationSrc),
  'isolationDb never reads DATABASE_URL',
)
ok(refuseSrc.includes('pg-connection-string'), 'refuseUnsafeTestUrl runs pg-connection-string')
ok(refuseSrc.includes('PGHOST'), 'refuseUnsafeTestUrl checks PGHOST')
ok(refuseSrc.includes('PGHOSTADDR'), 'refuseUnsafeTestUrl checks PGHOSTADDR')
ok(refuseSrc.includes('hostaddr'), 'refuseUnsafeTestUrl rejects hostaddr')
ok(refuseSrc.includes('service'), 'refuseUnsafeTestUrl rejects service')
ok(refuseSrc.includes('multi-host'), 'refuseUnsafeTestUrl rejects multi-host lists')

const MIGRATE_ALLOWLIST = new Set([
  'migrate-supabase-to-neon.mjs',
  'migrate-users.lib.mjs',
])

const GUARDED_SCRIPTS = [
  { file: 'scripts/prove-postgres.mjs', varName: 'url' },
  { file: 'scripts/prove-better-auth-schema.mjs', varName: 'url' },
  { file: 'scripts/prove-workerd-auth.mjs', varName: 'url' },
  { file: 'scripts/prove-migrate-users.mjs', varName: 'url' },
  { file: 'scripts/prove-migrate-e2e.mjs', varName: 'adminUrl' },
] as const

const CONNECT_MARKERS = [
  'sequential withSql',
  'access isolation:',
  'postgres gate: ok',
  'better-auth schema:',
  'workerd get-session',
  'workerd auth:',
  'migrate users:',
  'migrate e2e:',
  'harness opened',
  'UNEXPECTED_CONNECT',
  'connect E',
  'getaddrinfo',
  'password authentication',
  'SSL alert',
  'ECONNREFUSED',
  'ETIMEDOUT',
]

const neon = 'postgresql://neondb@ep-prod.us-east-1.aws.neon.tech/zeroed'
const lookalike = 'postgresql://app@127.0.0.1.example.com/zeroed'
const prodLocalUser = 'postgresql://localhost_admin@ep-prod.neon.tech/zeroed'
const nonLoopback = 'postgresql://postgres@db.example.com:5432/zeroed'
const loopback = 'postgresql://postgres@127.0.0.1:5432/zeroed'
const hostBypass = 'postgres://u:x@localhost:55440/db?host=ep-x.neon.tech'
const hostaddrBypass = 'postgres://u:x@localhost:55440/db?sslmode=disable&hostaddr=1.2.3.4'
const multiHost = 'postgresql://localhost,ep-x.neon.tech/zeroed'

const URL_CASES = [
  { label: 'non-loopback', url: nonLoopback, evidence: 'db.example.com" is not loopback', env: {} },
  { label: 'Neon', url: neon, evidence: 'ep-prod.us-east-1.aws.neon.tech" is not loopback', env: {} },
  { label: 'lookalike', url: lookalike, evidence: '127.0.0.1.example.com" is not loopback', env: {} },
  { label: 'localhost-in-userinfo', url: prodLocalUser, evidence: 'ep-prod.neon.tech" is not loopback', env: {} },
  { label: '?host=', url: hostBypass, evidence: 'query param "host"', env: {} },
  { label: '&hostaddr=', url: hostaddrBypass, evidence: 'query param "hostaddr"', env: {} },
  { label: 'multi-host', url: multiHost, evidence: 'multi-host', env: {} },
  { label: 'PGHOST', url: loopback, evidence: 'PGHOST host "ep-x.neon.tech"', env: { PGHOST: 'ep-x.neon.tech' } },
] as const

for (const { file, varName } of GUARDED_SCRIPTS) {
  const src = readFileSync(join(root, file), 'utf8')
  const name = file.replace(/^scripts\//, '')
  const immediate = new RegExp(
    `const ${varName} = process\\.env\\.DATABASE_URL\\?\\.trim\\(\\)\\n` +
      `if \\(!${varName}\\) throw new Error\\([^\\n]+\\)\\n` +
      `refuseUnsafeTestUrl\\(${varName}, 'DATABASE_URL'\\)`,
  )
  ok(immediate.test(src), `${name} calls refuseUnsafeTestUrl right after reading DATABASE_URL`)
  ok(
    src.includes("from '../worker/src/refuseTestUrl.ts'"),
    `${name} imports refuseUnsafeTestUrl from refuseTestUrl.ts`,
  )
}

const scriptsDir = join(root, 'scripts')
for (const name of readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'))) {
  if (MIGRATE_ALLOWLIST.has(name)) continue
  const src = readFileSync(join(scriptsDir, name), 'utf8')
  const destructive = /\b(DROP|TRUNCATE|DELETE)\b/.test(src)
  const readsEnvUrl = /process\.env\.(?:DATABASE_URL|ZEROED_TEST_DATABASE_URL|NEON_DB_URL|TARGET_DATABASE_URL)/.test(src)
  if (!destructive || !readsEnvUrl) continue
  ok(
    /refuseUnsafeTestUrl\((?:url|adminUrl), 'DATABASE_URL'\)/.test(src),
    `${name} is a wipe script and is loopback-guarded`,
  )
}

const preloadPath = join(tmpdir(), `zeroed-no-connect-${process.pid}.mjs`)
writeFileSync(
  preloadPath,
  `
import net from 'node:net'
import tls from 'node:tls'
function dest(args) {
  const a = args[0]
  if (typeof a === 'string') return a
  if (a && typeof a === 'object') return String(a.host ?? a.hostname ?? a.path ?? '')
  return String(args[1] ?? '')
}
function isLoopback(host) {
  const h = String(host).replace(/^\\[|\\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(?:\\.\\d+){0,3}$/.test(h)
}
function guard(kind, args) {
  const host = dest(args)
  if (host && !isLoopback(host) && !String(host).startsWith('/')) {
    console.error('UNEXPECTED_CONNECT ' + kind + ' ' + host)
    process.exit(2)
  }
}
const sock = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  guard('net.Socket.connect', args)
  return sock.apply(this, args)
}
const tlsConnect = tls.connect
tls.connect = function (...args) {
  guard('tls.connect', args)
  return tlsConnect.apply(this, args)
}
`,
)

const harnessProbe = join(tmpdir(), `zeroed-harness-${process.pid}.ts`)
writeFileSync(
  harnessProbe,
  `import { openIsolationHarness } from ${JSON.stringify(join(root, 'worker/src/isolationDb.ts'))}
const h = await openIsolationHarness()
console.log('harness opened (' + h.backend + ')')
await h.close()
`,
)

function spawnNode(script: string, extraEnv: NodeJS.ProcessEnv) {
  const res = spawnSync(
    process.execPath,
    ['--import', preloadPath, '--experimental-strip-types', script],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        PGHOST: '',
        PGHOSTADDR: '',
        ...extraEnv,
      },
    },
  )
  return {
    status: res.status,
    timedOut: res.error?.message?.includes('ETIMEDOUT') === true,
    out: `${res.stdout || ''}\n${res.stderr || ''}`,
  }
}

function runScript(script: string, databaseUrl: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnNode(script, { DATABASE_URL: databaseUrl, ...extraEnv })
}

function runHarness(databaseUrl: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnNode(harnessProbe, { ZEROED_TEST_DATABASE_URL: databaseUrl, ...extraEnv })
}

function refusedWithoutConnect(
  name: string,
  caseLabel: string,
  result: ReturnType<typeof spawnNode>,
  evidence: string,
) {
  const label = `${name} ${caseLabel}`
  ok(result.status !== 0, `${label}: exits non-zero`)
  ok(!result.timedOut, `${label}: does not wait on a remote connect`)
  ok(
    result.out.includes(evidence) && result.out.includes('refusing to wipe'),
    `${label}: refuses with ${JSON.stringify(evidence)}`,
  )
  ok(
    CONNECT_MARKERS.every((marker) => !result.out.includes(marker)),
    `${label}: zero connections / no query output`,
  )
}

for (const { file } of GUARDED_SCRIPTS) {
  const name = file.replace(/^scripts\//, '')
  for (const urlCase of URL_CASES) {
    refusedWithoutConnect(
      name,
      urlCase.label,
      runScript(file, urlCase.url, urlCase.env),
      urlCase.evidence,
    )
  }
}

for (const urlCase of URL_CASES) {
  refusedWithoutConnect(
    'isolation harness',
    urlCase.label,
    runHarness(urlCase.url, urlCase.env),
    urlCase.evidence,
  )
}

refusedWithoutConnect(
  'prove-postgres.mjs',
  'ENVIRONMENT=local + Neon',
  runScript('scripts/prove-postgres.mjs', neon, { ENVIRONMENT: 'local', ZEROED_REAL_PG: '1' }),
  'ep-prod.us-east-1.aws.neon.tech" is not loopback',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('postgres refuse: ok')
