#!/usr/bin/env node
/**
 * Checks for the Supabase → Neon migrate script: flag parsing, provided
 * auth-user mapping (CSV/JSON), secret redaction, and that the Neon app
 * schema has no Supabase RLS / GRANT / auth.uid() leftovers.
 *
 * Run: node scripts/migrate-supabase-to-neon.check.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  argValue,
  authUsersToCopyCsv,
  formatCountComparison,
  parseAuthUsersMapping,
  parseCounts,
  parseMigrateArgs,
  redactSecrets,
  resolveSourceUrl,
  resolveTargetUrl,
} from './migrate-supabase-to-neon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fails = []
let checks = 0

function ok(cond, msg) {
  checks += 1
  if (!cond) fails.push(msg)
}

function eq(actual, expected, msg) {
  checks += 1
  if (actual !== expected) fails.push(`${msg} — expected ${String(expected)}, got ${String(actual)}`)
}

// ---- flags ------------------------------------------------------------------

const skip = parseMigrateArgs(['--dry-run', '--skip-auth-users'])
ok(skip.dryRun, '--dry-run is parsed')
ok(skip.skipAuthUsers, '--skip-auth-users is parsed')
ok(!skip.authUsersFile, '--skip-auth-users does not require a file to parse')

const withFile = parseMigrateArgs(['--auth-users-file', 'users.json'])
ok(withFile.skipAuthUsers, '--auth-users-file implies --skip-auth-users')
eq(withFile.authUsersFile, 'users.json', '--auth-users-file takes a positional path')

const eqFile = parseMigrateArgs(['--auth-users-file=./map.csv'])
eq(eqFile.authUsersFile, './map.csv', '--auth-users-file=path is accepted')
eq(argValue(['--auth-users-file', '--dry-run'], '--auth-users-file'), '', 'value cannot be another flag')

const fromEnv = parseMigrateArgs(['--dry-run'], { AUTH_USERS_FILE: '/tmp/users.csv' })
ok(fromEnv.skipAuthUsers, 'AUTH_USERS_FILE env implies skip')
eq(fromEnv.authUsersFile, '/tmp/users.csv', 'AUTH_USERS_FILE env is read')

ok(!parseMigrateArgs([]).skipAuthUsers, 'skip is off by default')

eq(
  resolveSourceUrl({ SUPABASE_READONLY_URL: 'postgres://ro' }),
  'postgres://ro',
  'prefers SUPABASE_READONLY_URL',
)
eq(
  resolveTargetUrl({ NEON_DIRECT_URL: 'postgres://neon' }),
  'postgres://neon',
  'prefers NEON_DIRECT_URL',
)
eq(
  resolveSourceUrl({ SUPABASE_DB_URL: 'postgres://legacy' }),
  'postgres://legacy',
  'falls back to SUPABASE_DB_URL',
)

// ---- mapping ----------------------------------------------------------------

const csvHeader = parseAuthUsersMapping(
  'id,email,created_at\n11111111-1111-4111-8111-111111111111,a@example.invalid,2026-01-01T00:00:00Z\n',
)
eq(csvHeader.length, 1, 'CSV with header: one row')
eq(csvHeader[0].id, '11111111-1111-4111-8111-111111111111', 'CSV keeps the same UUID')
eq(csvHeader[0].email, 'a@example.invalid', 'CSV email')
eq(csvHeader[0].name, 'a', 'CSV name defaults to the local part')

const csvBare = parseAuthUsersMapping('22222222-2222-4222-8222-222222222222,b@example.invalid,2026-02-02\n')
eq(csvBare[0].id, '22222222-2222-4222-8222-222222222222', 'headerless CSV: id')
eq(csvBare[0].email, 'b@example.invalid', 'headerless CSV: email')

const jsonRows = parseAuthUsersMapping(JSON.stringify([
  { id: '33333333-3333-4333-8333-333333333333', email: 'c@example.invalid', created_at: '2026-03-03' },
]))
eq(jsonRows[0].id, '33333333-3333-4333-8333-333333333333', 'JSON array keeps the same UUID')

const jsonWrapped = parseAuthUsersMapping(JSON.stringify({
  users: [{ id: '44444444-4444-4444-8444-444444444444', email: 'd@example.invalid' }],
}))
eq(jsonWrapped[0].email, 'd@example.invalid', 'JSON {users:[]} is accepted')

let missingFields = false
try {
  parseAuthUsersMapping('[{"email":"x@y.invalid"}]')
} catch {
  missingFields = true
}
ok(missingFields, 'JSON without id is rejected')

const copy = authUsersToCopyCsv(jsonRows)
ok(copy.includes('33333333-3333-4333-8333-333333333333'), 'COPY CSV includes the UUID')
ok(copy.includes('c@example.invalid'), 'COPY CSV includes email')

// ---- counts / redact --------------------------------------------------------

const counts = parseCounts('athlete | 3\nprogram | 1\n')
eq(counts.athlete, 3, 'parseCounts athlete')
const cmp = formatCountComparison({ athlete: 3 }, { athlete: 3 })
ok(!cmp.mismatch && cmp.lines[0].includes('ok'), 'matching counts are ok')
ok(formatCountComparison({ athlete: 3 }, { athlete: 2 }).mismatch, 'mismatch is flagged')

const leaked = 'pg_dump --dbname postgresql://user:s3cret@db.example/zeroed failed'
ok(!redactSecrets(leaked).includes('s3cret'), 'redactSecrets strips postgres URLs')
ok(redactSecrets(leaked).includes('postgresql://[redacted]'), 'redactSecrets keeps a placeholder')

// ---- spawn --skip-auth-users dry-run ----------------------------------------

function spawnMigrate(extraArgs, extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/migrate-supabase-to-neon.mjs', ...extraArgs], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ...extraEnv, SUPABASE_READONLY_URL: '', NEON_DIRECT_URL: '', SUPABASE_DB_URL: '', NEON_DB_URL: '' },
  })
}

const drySkip = spawnMigrate(['--dry-run', '--skip-auth-users'])
eq(drySkip.status, 0, 'offline dry-run --skip-auth-users exits 0')
ok(
  /will not read auth\.users on the source/.test(drySkip.stdout),
  'dry-run --skip-auth-users says it will not read auth.users',
)
ok(
  /data-only restore/.test(drySkip.stdout),
  'dry-run documents schema then data-only restore',
)
ok(!/would COPY auth\.users from source/.test(drySkip.stdout), 'skip path does not COPY auth.users')

const dryDefault = spawnMigrate(['--dry-run'])
eq(dryDefault.status, 0, 'offline dry-run without skip exits 0')
ok(/would COPY auth\.users from source/.test(dryDefault.stdout), 'default dry-run still mentions auth.users export')

const tmp = mkdtempSync(join(tmpdir(), 'zeroed-migrate-check-'))
try {
  const mapPath = join(tmp, 'users.json')
  writeFileSync(mapPath, JSON.stringify([
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'preview@zeroed.invalid', created_at: '2026-01-15' },
  ]))
  const dryFile = spawnMigrate(['--dry-run', '--skip-auth-users', '--auth-users-file', mapPath])
  eq(dryFile.status, 0, 'dry-run with mapping file exits 0')
  ok(
    /would map 1 provided auth users/.test(dryFile.stdout),
    'dry-run reports the provided mapping count',
  )

  const badJson = join(tmp, 'bad.json')
  writeFileSync(badJson, '{not json')
  const dryBad = spawnMigrate(['--dry-run', '--auth-users-file', badJson])
  ok(dryBad.status !== 0, 'invalid mapping JSON fails')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---- Neon schema: no Supabase leftovers + applies on PGlite -----------------

const appSql = readFileSync(join(root, 'worker/schema/app.sql'), 'utf8')
const appSqlCode = appSql.replace(/--.*$/gm, '')
ok(!/ENABLE ROW LEVEL SECURITY/i.test(appSqlCode), 'app.sql has no ENABLE ROW LEVEL SECURITY')
ok(!/CREATE POLICY/i.test(appSqlCode), 'app.sql has no CREATE POLICY')
ok(!/auth\.uid\(\)/i.test(appSqlCode), 'app.sql has no auth.uid()')
ok(!/\bGRANT\b/.test(appSqlCode), 'app.sql has no GRANT')
ok(!/\bauthenticated\b/.test(appSqlCode), 'app.sql has no authenticated role')
ok(/CREATE TABLE IF NOT EXISTS public\.athlete/.test(appSql), 'app.sql creates athlete')
ok(/data-only restore/i.test(appSql), 'app.sql documents data-only restore order')

const seedSql = readFileSync(join(root, 'worker/schema/preview-seed.sql'), 'utf8')
ok(/@zeroed\.invalid/.test(seedSql), 'preview seed uses .invalid email')
ok(!/phillipchan|gmail\.com/i.test(seedSql), 'preview seed has no real email')
ok(/Synthetic/.test(seedSql), 'preview seed is labeled synthetic')

const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
ok(wrangler.includes('feb7018e2ce14f3981fe2a43f3e2851b'), 'wrangler.jsonc has the Neon Hyperdrive id')
ok(!wrangler.includes('00000000000000000000000000000000'), 'wrangler.jsonc placeholder Hyperdrive id is gone')

const workflow = readFileSync(join(root, '.github/workflows/migrate-supabase-to-neon.yml'), 'utf8')
ok(/workflow_dispatch:/.test(workflow), 'migrate workflow is manually triggered')
ok(!/^\s+push:/m.test(workflow), 'migrate workflow is not on push')
ok(!/^\s+pull_request:/m.test(workflow), 'migrate workflow is not on pull_request')
ok(/dry_run:/.test(workflow), 'migrate workflow has a dry_run input')
ok(/default: true/.test(workflow), 'migrate workflow dry_run defaults to true')
ok(!/echo +["']?\$\{?SUPABASE_READONLY_URL/.test(workflow), 'workflow does not echo SUPABASE_READONLY_URL')
ok(!/echo +["']?\$\{?NEON_DIRECT_URL/.test(workflow), 'workflow does not echo NEON_DIRECT_URL')
ok(/--skip-auth-users/.test(workflow), 'workflow always skips auth.users export')

const db = new PGlite()
await db.exec(readFileSync(join(root, 'worker/schema/app.sql'), 'utf8'))
await db.exec(readFileSync(join(root, 'worker/schema/better-auth.sql'), 'utf8'))
await db.exec(readFileSync(join(root, 'worker/schema/preview-seed.sql'), 'utf8'))

const tables = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('athlete','program','phase','routine','workout','insight','mcp_token')
`)
eq(tables.rows.length, 7, 'PGlite app.sql creates the counted public tables')

const policies = await db.query(`SELECT COUNT(*)::int AS n FROM pg_policy`)
eq(Number(policies.rows[0]?.n ?? -1), 0, 'PGlite app.sql created no RLS policies')

const preview = await db.query(`SELECT email FROM "user" WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)
eq(preview.rows[0]?.email, 'preview.athlete@zeroed.invalid', 'preview seed maps the same UUID into Better Auth')

const athletes = await db.query(`SELECT COUNT(*)::int AS n FROM public.athlete`)
eq(Number(athletes.rows[0]?.n ?? 0), 1, 'preview seed inserts one synthetic athlete')

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} migrate checks failed:`)
  for (const f of fails) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✓ all ${checks} migrate / neon-schema checks passed`)
