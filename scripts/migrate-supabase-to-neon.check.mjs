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
  addMaskLines,
  argValue,
  authUsersToCopyCsv,
  confirmDropMismatchReason,
  fingerprintQuery,
  formatCountComparison,
  isNeonHost,
  isSocketHost,
  isSupabaseHost,
  loadUsersSql,
  main,
  missingMappedAuthUserIds,
  orderRestoreList,
  orphanAthleteQuery,
  parseAuthUsersMapping,
  parseCounts,
  parseFingerprint,
  parseIdList,
  parseOrphanIds,
  parseMigrateArgs,
  postgresUrlParts,
  redactSecrets,
  refuseSourceWipeReason,
  refuseTargetFingerprintReason,
  requireCounts,
  resolveSourceUrl,
  resolveTargetUrl,
  wrapRestoreTransaction,
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
eq(parseMigrateArgs(['--confirm-drop=neondb']).confirmDrop, 'neondb', '--confirm-drop=dbname is parsed')
eq(parseMigrateArgs(['--confirm-drop', 'neondb']).confirmDrop, 'neondb', '--confirm-drop dbname is parsed')
eq(parseMigrateArgs([], { CONFIRM_DROP: 'neondb' }).confirmDrop, 'neondb', 'CONFIRM_DROP env is read')
ok(!parseMigrateArgs([]).confirmDrop, 'confirm-drop is empty by default')

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

const sourceIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]
const wrongIdMap = parseAuthUsersMapping(JSON.stringify([
  { id: '11111111-1111-4111-8111-111111111111', email: 'a@example.invalid' },
  { id: '22222222-2222-4222-8222-222222222222', email: 'b@example.invalid' },
  { id: '33333333-3333-4333-8333-000000000099', email: 'wrong@example.invalid' },
]))
eq(wrongIdMap.length, 3, 'wrong-id fixture has 3 mapping rows (same count as source)')
const missingIds = missingMappedAuthUserIds(sourceIds, wrongIdMap)
eq(missingIds.length, 1, 'id-match guard flags one missing source id when counts match')
eq(missingIds[0], '33333333-3333-4333-8333-333333333333', 'id-match guard reports the unmapped source id')
eq(
  missingMappedAuthUserIds(sourceIds, parseAuthUsersMapping(JSON.stringify(sourceIds.map((id, i) => ({
    id,
    email: `${i}@example.invalid`,
  }))))).length,
  0,
  'id-match guard passes when every source id is present',
)
eq(parseIdList('aaa\nbbb\naaa\n').length, 2, 'parseIdList dedupes source ids')

const txn = wrapRestoreTransaction('INSERT INTO "user" VALUES (1);', 'COPY public.athlete FROM stdin;\n\\.')
ok(txn.startsWith('BEGIN;'), 'restore wrapper opens one transaction')
ok(txn.trim().endsWith('COMMIT;'), 'restore wrapper commits one transaction')
ok(txn.includes('INSERT INTO "user"') && txn.includes('COPY public.athlete'), 'restore wrapper includes users then data')

// ---- counts / redact --------------------------------------------------------
// Captured from `psql` 16 default aligned output (leading spaces, padded
// columns, header, rule, "(N rows)"). The old /^(\\w+)\\s*\\| regex missed this.

const PSQL_ALIGNED = `     t     | n 
-----------+---
 athlete   | 3
 insight   | 0
 mcp_token | 1
 phase     | 1
 program   | 1
 routine   | 1
 workout   | 1
(7 rows)
`

const aligned = parseCounts(PSQL_ALIGNED)
eq(aligned.athlete, 3, 'parseCounts reads padded psql aligned athlete')
eq(aligned.mcp_token, 1, 'parseCounts reads padded psql aligned mcp_token')
eq(aligned.insight, 0, 'parseCounts reads a zero count from aligned psql')
requireCounts(aligned, 'aligned-fixture')
ok(true, 'requireCounts accepts a complete aligned parse')

const atCsv = parseCounts('athlete,3\ninsight,0\nmcp_token,1\nphase,1\nprogram,1\nroutine,1\nworkout,1\n')
eq(atCsv.athlete, 3, 'parseCounts reads psql -At CSV')
requireCounts(atCsv, 'at-csv')

const csvHeaderOut = parseCounts('t,n\nathlete,3\ninsight,0\nmcp_token,1\nphase,1\nprogram,1\nroutine,1\nworkout,1\n')
eq(csvHeaderOut.workout, 1, 'parseCounts skips psql --csv header')

let emptyFailed = false
try {
  requireCounts(parseCounts('     t     | n \n-----------+---\n(0 rows)\n'), 'empty')
} catch (err) {
  emptyFailed = /missing row counts/.test(err instanceof Error ? err.message : '')
}
ok(emptyFailed, 'requireCounts fails hard when aligned output has no table rows')

const full = {
  athlete: 3, insight: 0, mcp_token: 1, phase: 1, program: 1, routine: 1, workout: 1,
}
ok(!formatCountComparison(full, full).mismatch, 'matching required tables are ok')
ok(formatCountComparison(full, { ...full, athlete: 2 }).mismatch, 'mismatch is flagged')
ok(formatCountComparison(full, null).mismatch, 'missing dest counts are a mismatch')
ok(formatCountComparison({}, {}).mismatch, 'empty vs empty is a mismatch, not ok')

eq(parseOrphanIds('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n').length, 1, 'parseOrphanIds counts a uuid')
ok(orphanAthleteQuery().includes('"user"'), 'orphan query joins Better Auth user')

const toc = orderRestoreList(`;
; Selected TOC Entries:
;
210; 0 16400 TABLE DATA public workout postgres
211; 0 16410 TABLE DATA public athlete postgres
212; 0 16420 TABLE DATA public session_observation postgres
213; 0 16430 TABLE DATA public "user" postgres
214; 0 16440 SEQUENCE SET public probe_throttle_id_seq postgres
`)
ok(toc.indexOf('TABLE DATA public athlete') < toc.indexOf('TABLE DATA public workout'), 'restore list puts athlete before workout')
ok(toc.indexOf('TABLE DATA public workout') < toc.indexOf('TABLE DATA public session_observation'), 'restore list puts workout before session_observation')
ok(!/TABLE DATA public "?user"?/.test(toc), 'restore list skips Better Auth user')
ok(/SEQUENCE SET public probe_throttle_id_seq/.test(toc), 'restore list keeps SEQUENCE SET after data')

const leaked = 'pg_dump --dbname postgresql://user:s3cret@db.example/zeroed failed'
ok(!redactSecrets(leaked).includes('s3cret'), 'redactSecrets strips postgres URLs')
ok(redactSecrets(leaked).includes('postgresql://[redacted]'), 'redactSecrets keeps a placeholder')

const masks = addMaskLines([
  'postgresql://neondb_owner:s3cret@ep-foo.us-east-2.aws.neon.tech/neondb',
  'postgres://reader@db.example.com:5432/zeroed',
])
ok(masks.includes('::add-mask::neondb_owner'), 'masks Neon user')
ok(masks.includes('::add-mask::ep-foo.us-east-2.aws.neon.tech'), 'masks Neon host')
ok(masks.includes('::add-mask::reader'), 'masks source user')
ok(masks.includes('::add-mask::db.example.com'), 'masks source host')
ok(!masks.join(' ').includes('s3cret'), 'mask lines do not include the password')

// ---- source-wipe guards (B2) ------------------------------------------------

const neonDirect = 'postgresql://reader@ep-foo.us-east-2.aws.neon.tech/neondb'
const neonCased = 'postgresql://reader@EP-FOO.US-EAST-2.AWS.NEON.TECH/Neondb'
const neonAppName = `${neonDirect}?application_name=neon`
const neonOtherUser = 'postgresql://neondb_owner@ep-foo.us-east-2.aws.neon.tech/neondb'
const neonOtherDb = 'postgresql://reader@ep-foo.us-east-2.aws.neon.tech/otherdb'
const supabaseDirect = 'postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres'
const supabasePooler = 'postgresql://postgres.abcdefghijkl@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
const supabaseCom = 'postgresql://postgres@db.abcdefghijkl.supabase.com:5432/postgres'

const parsedAlias = postgresUrlParts(neonAppName)
eq(parsedAlias.host, 'ep-foo.us-east-2.aws.neon.tech', 'postgresUrlParts lowercases host')
eq(parsedAlias.port, '5432', 'postgresUrlParts defaults missing port to 5432')
eq(parsedAlias.dbname, 'neondb', 'postgresUrlParts reads dbname')
eq(postgresUrlParts(neonCased).host, parsedAlias.host, 'postgresUrlParts treats host case as equal')
eq(postgresUrlParts(neonCased).dbname, parsedAlias.dbname, 'postgresUrlParts lowercases dbname')
eq(postgresUrlParts(neonCased).port, parsedAlias.port, 'postgresUrlParts default port matches explicit-default')
eq(
  postgresUrlParts(`${neonDirect}?dbname=other`).dbname,
  'other',
  'postgresUrlParts honors libpq dbname= override',
)
eq(
  postgresUrlParts(`${neonDirect}?host=/tmp/pg`).host,
  '/tmp/pg',
  'postgresUrlParts honors libpq host= override',
)
eq(
  postgresUrlParts(`${neonDirect}?hostaddr=127.0.0.1`).host,
  '127.0.0.1',
  'postgresUrlParts honors libpq hostaddr= override',
)
ok(isSocketHost('/tmp/pg'), 'isSocketHost treats an absolute path as a socket')
ok(isSocketHost('/tmp/pg.sock'), 'isSocketHost treats a sock path as a socket')
ok(!isSocketHost('ep-foo.us-east-2.aws.neon.tech'), 'isSocketHost rejects a Neon hostname')

ok(isSupabaseHost('db.abcdefghijkl.supabase.co'), 'isSupabaseHost matches *.supabase.co')
ok(isSupabaseHost('db.abcdefghijkl.supabase.com'), 'isSupabaseHost matches *.supabase.com')
ok(isSupabaseHost('aws-0-us-east-1.pooler.supabase.com'), 'isSupabaseHost matches pooler.supabase')
ok(!isSupabaseHost('ep-foo.us-east-2.aws.neon.tech'), 'isSupabaseHost rejects Neon')
ok(isNeonHost('ep-foo.us-east-2.aws.neon.tech'), 'isNeonHost matches *.neon.tech')
ok(!isNeonHost('neon.tech'), 'isNeonHost requires a subdomain')
ok(!isNeonHost('ep-foo.neon.tech.evil.com'), 'isNeonHost rejects a suffix spoof')

eq(
  refuseSourceWipeReason(neonDirect, neonAppName),
  'source and target resolve to the same host, port, and database',
  'application_name alias is refused',
)
eq(
  refuseSourceWipeReason(neonDirect, neonOtherUser),
  'source and target resolve to the same host, port, and database',
  'different user alias is refused',
)
eq(
  refuseSourceWipeReason(neonDirect, neonCased),
  'source and target resolve to the same host, port, and database',
  'host/dbname case alias is refused',
)
eq(
  refuseSourceWipeReason(supabaseDirect, supabasePooler),
  'target host looks like Supabase',
  'pooler.supabase target is refused',
)
eq(
  refuseSourceWipeReason(supabaseDirect, supabaseCom),
  'target host looks like Supabase',
  'supabase.com target is refused',
)
eq(
  refuseSourceWipeReason(supabaseDirect, supabaseDirect),
  'target host looks like Supabase',
  'supabase.co target is refused',
)
eq(
  refuseSourceWipeReason(supabaseDirect, 'postgresql://postgres@localhost/neondb'),
  'target host must end in .neon.tech',
  'non-Neon target is refused',
)
eq(
  refuseSourceWipeReason(supabaseDirect, neonDirect),
  '',
  'distinct Neon target is allowed at the URL layer',
)
eq(
  refuseSourceWipeReason(neonDirect, neonOtherDb),
  '',
  'same Neon host with a different dbname is allowed at the URL layer',
)
eq(
  refuseSourceWipeReason(supabaseDirect, `${neonDirect}?host=/tmp/pg`),
  'target host is a socket path',
  '.neon.tech URL with ?host=socket is refused',
)
eq(
  refuseSourceWipeReason(supabaseDirect, `${neonDirect}?hostaddr=127.0.0.1`),
  'target host override must end in .neon.tech',
  '.neon.tech URL with hostaddr= is refused',
)

eq(
  confirmDropMismatchReason('', neonDirect),
  'live restore requires --confirm-drop=<target dbname>',
  'missing --confirm-drop is refused',
)
eq(
  confirmDropMismatchReason('postgres', neonDirect),
  '--confirm-drop=postgres does not match target database neondb',
  'wrong --confirm-drop dbname is refused',
)
eq(confirmDropMismatchReason('neondb', neonDirect), '', '--confirm-drop matches target dbname')
eq(confirmDropMismatchReason('NEONDB', neonDirect), '', '--confirm-drop matches dbname case-insensitively')

ok(fingerprintQuery().includes('to_regnamespace'), 'fingerprint query checks storage schema')
ok(fingerprintQuery().includes('pg_policies'), 'fingerprint query checks pg_policies')
ok(fingerprintQuery().includes('pg_control_system'), 'fingerprint query reads system_identifier when permitted')
ok(fingerprintQuery().includes('has_function_privilege'), 'fingerprint query does not require pg_control_system')
ok(fingerprintQuery().includes('inet_server_addr'), 'fingerprint query reads inet_server_addr')
ok(fingerprintQuery().includes('inet_server_port'), 'fingerprint query reads inet_server_port')
ok(fingerprintQuery().includes('pg_postmaster_start_time'), 'fingerprint query reads postmaster start time')

const fp = parseFingerprint('{"db":"neondb","addr":"","port":"","start":"t0","sysid":"1","has_storage":false,"has_policies":false}\n')
eq(fp.db, 'neondb', 'parseFingerprint reads db')
eq(fp.start, 't0', 'parseFingerprint reads start time')
ok(!fp.has_storage && !fp.has_policies, 'parseFingerprint reads false flags')
eq(
  refuseTargetFingerprintReason(null, fp),
  'could not read target fingerprint',
  'unreadable target fingerprint is refused',
)
eq(
  refuseTargetFingerprintReason(fp, null),
  'could not read source fingerprint',
  'unreadable source fingerprint is refused',
)
eq(
  refuseTargetFingerprintReason({ ...fp, has_storage: true }, fp),
  'target has a storage schema (Supabase)',
  'storage schema on target is refused',
)
eq(
  refuseTargetFingerprintReason({ ...fp, has_policies: true }, fp),
  'target has pg_policies rows (Supabase RLS)',
  'pg_policies on target are refused',
)
eq(
  refuseTargetFingerprintReason(
    { db: 'postgres', addr: '1.2.3.4', port: '5432', start: '', sysid: '99', has_storage: false, has_policies: false },
    { db: 'postgres', addr: '1.2.3.4', port: '5432', start: '', sysid: '88' },
  ),
  'target server identity matches the source',
  'same current_database + inet_server_addr is refused',
)
eq(
  refuseTargetFingerprintReason(
    { db: 'postgres', addr: '', port: '', start: '', sysid: '99', has_storage: false, has_policies: false },
    { db: 'postgres', addr: '', port: '', start: '', sysid: '99' },
  ),
  'target server identity matches the source',
  'same current_database + system_identifier is refused',
)
eq(
  refuseTargetFingerprintReason(
    { db: 'postgres', addr: '', port: '', start: '2026-01-01', sysid: '', has_storage: false, has_policies: false },
    { db: 'postgres', addr: '', port: '', start: '2026-01-01', sysid: '' },
  ),
  'target server identity matches the source',
  'same current_database + postmaster start time is refused',
)
eq(
  refuseTargetFingerprintReason(
    { db: 'postgres', addr: '', port: '', start: '', sysid: '', has_storage: false, has_policies: false },
    { db: 'postgres', addr: '', port: '', start: '', sysid: '' },
  ),
  'could not prove target is a different server from the source',
  'incomplete fingerprints fail closed',
)
eq(
  refuseTargetFingerprintReason(
    { db: 'neondb', addr: '9.9.9.9', port: '5432', start: 't1', sysid: '1', has_storage: false, has_policies: false },
    { db: 'postgres', addr: '1.2.3.4', port: '5432', start: 't2', sysid: '2' },
  ),
  '',
  'distinct db + server identity is allowed',
)

// ---- spawn --skip-auth-users dry-run ----------------------------------------

function spawnMigrate(extraArgs, extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/migrate-supabase-to-neon.mjs', ...extraArgs], {
    encoding: 'utf8',
    cwd: root,
    env: {
      ...process.env,
      SUPABASE_READONLY_URL: '',
      NEON_DIRECT_URL: '',
      SUPABASE_DB_URL: '',
      NEON_DB_URL: '',
      AUTH_USERS_FILE: '',
      CONFIRM_DROP: '',
      ...extraEnv,
    },
  })
}

function refusedBeforeWrite(res, label) {
  const out = `${res.stdout}\n${res.stderr}`
  ok(res.status !== 0, `${label} exits non-zero`)
  eq(res.status, 2, `${label} exits 2`)
  ok(!/dumping/i.test(out), `${label} does not dump`)
  ok(!/resetting/i.test(out), `${label} does not reset`)
  ok(!/probing target identity/i.test(out), `${label} does not connect for a fingerprint`)
  ok(/Refusing to continue|confirm-drop|Source is read-only/i.test(out), `${label} prints a refuse reason`)
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
ok(/live restore without --auth-users-file exits 2/.test(drySkip.stdout), 'dry-run documents live exit 2')
ok(/every source auth_user_id/.test(drySkip.stdout), 'dry-run documents id-match mapping guard')
ok(/one transaction/.test(drySkip.stdout), 'dry-run documents a single restore transaction')
ok(/--confirm-drop=<target dbname>/.test(drySkip.stdout), 'dry-run documents --confirm-drop')
ok(/\.neon\.tech/.test(drySkip.stdout), 'dry-run documents a .neon.tech target')
ok(/unreadable fingerprint/.test(drySkip.stdout), 'dry-run documents fail-closed fingerprints')
ok(!/would COPY auth\.users from source/.test(drySkip.stdout), 'skip path does not COPY auth.users')

const liveNoConfirm = spawnMigrate(['--skip-auth-users'], {
  SUPABASE_READONLY_URL: 'postgresql://reader@db.example.com/zeroed',
  NEON_DIRECT_URL: 'postgresql://neondb_owner@ep-foo.neon.tech/neondb',
})
eq(liveNoConfirm.status, 2, 'live run without --confirm-drop exits 2')
ok(
  /--confirm-drop=<target dbname>/.test(`${liveNoConfirm.stdout}\n${liveNoConfirm.stderr}`),
  'live run without --confirm-drop says it is required',
)
ok(!/dumping/i.test(`${liveNoConfirm.stdout}\n${liveNoConfirm.stderr}`), 'missing --confirm-drop does not dump')

const liveNoMap = spawnMigrate(['--skip-auth-users', '--confirm-drop=neondb'], {
  SUPABASE_READONLY_URL: 'postgresql://reader@db.example.com/zeroed',
  NEON_DIRECT_URL: 'postgresql://neondb_owner@ep-foo.neon.tech/neondb',
})
eq(liveNoMap.status, 2, 'live run without a mapping exits 2')
ok(
  /Live restore without --auth-users-file exits 2/.test(`${liveNoMap.stdout}\n${liveNoMap.stderr}`),
  'live run without a mapping says it exits 2',
)
ok(
  /::add-mask::reader/.test(liveNoMap.stdout) && /::add-mask::neondb_owner/.test(liveNoMap.stdout),
  'live run masks DB users before exiting',
)
ok(!/dumping/i.test(`${liveNoMap.stdout}\n${liveNoMap.stderr}`), 'live run without a mapping does not dump')

refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=neondb'], {
  SUPABASE_READONLY_URL: neonDirect,
  NEON_DIRECT_URL: neonAppName,
}), 'application_name alias')
refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=neondb'], {
  SUPABASE_READONLY_URL: neonDirect,
  NEON_DIRECT_URL: neonOtherUser,
}), 'different user alias')
refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=neondb'], {
  SUPABASE_READONLY_URL: neonDirect,
  NEON_DIRECT_URL: neonCased,
}), 'host/dbname case alias')
refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=postgres'], {
  SUPABASE_READONLY_URL: supabaseDirect,
  NEON_DIRECT_URL: supabasePooler,
}), 'pooler vs direct')
refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=postgres'], {
  SUPABASE_READONLY_URL: neonDirect,
  NEON_DIRECT_URL: supabaseDirect,
}), 'supabase host as target')
refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=neondb'], {
  SUPABASE_READONLY_URL: supabaseDirect,
  NEON_DIRECT_URL: `${neonDirect}?host=/tmp/pg`,
}), '.neon.tech URL with ?host=socket')
refusedBeforeWrite(spawnMigrate(['--skip-auth-users', '--confirm-drop=neondb'], {
  SUPABASE_READONLY_URL: supabaseDirect,
  NEON_DIRECT_URL: `${neonDirect}?hostaddr=127.0.0.1`,
}), '.neon.tech URL with hostaddr=')

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

  let dropAttempted = false
  const unreadFp = main(
    ['--skip-auth-users', '--confirm-drop=neondb', '--auth-users-file', mapPath],
    {
      SUPABASE_READONLY_URL: supabaseDirect,
      NEON_DIRECT_URL: neonDirect,
    },
    {
      readFingerprint(url) {
        if (/supabase/.test(url)) throw new Error('could not read source fingerprint')
        return {
          db: 'neondb',
          addr: '9.9.9.9',
          port: '5432',
          start: 't-target',
          sysid: '1',
          has_storage: false,
          has_policies: false,
        }
      },
      checkSourceMarker() {
        dropAttempted = true
        return ''
      },
    },
  )
  eq(unreadFp, 2, 'unreadable source fingerprint exits 2')
  ok(!dropAttempted, 'unreadable source fingerprint does not write a marker or drop')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---- Neon schema: no Supabase leftovers + applies on PGlite -----------------

const appSql = readFileSync(join(root, 'worker/schema/app.sql'), 'utf8')
const appSqlCode = appSql.replace(/--.*$/gm, '')
ok(!/ENABLE ROW LEVEL SECURITY/i.test(appSqlCode), 'app.sql has no ENABLE ROW LEVEL SECURITY')
ok(!/CREATE POLICY/i.test(appSqlCode), 'app.sql has no CREATE POLICY')
ok(!/auth\.uid\(\)/i.test(appSqlCode), 'app.sql has no auth.uid()')
ok(!/request\.jwt\.claim\.sub/.test(appSqlCode), 'app.sql has no Supabase JWT claim fallback')
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
ok(/confirm_drop:/.test(workflow), 'migrate workflow has a confirm_drop input')
ok(/--confirm-drop=/.test(workflow), 'workflow passes --confirm-drop on a live run')
ok(!/echo +["']?\$\{?SUPABASE_READONLY_URL/.test(workflow), 'workflow does not echo SUPABASE_READONLY_URL')
ok(!/echo +["']?\$\{?NEON_DIRECT_URL/.test(workflow), 'workflow does not echo NEON_DIRECT_URL')
ok(/--skip-auth-users/.test(workflow), 'workflow always skips auth.users export')
ok(!/^\s+auth_users:/m.test(workflow), 'workflow has no auth_users input (PII)')
ok(/AUTH_USERS_MAPPING/.test(workflow), 'workflow reads AUTH_USERS_MAPPING secret')
ok(/base64 --decode/.test(workflow), 'workflow decodes AUTH_USERS_MAPPING as base64')
ok(/umask 077/.test(workflow), 'workflow writes the mapping under umask 077')
ok(/if: always\(\)/.test(workflow), 'workflow deletes the mapping in always()')
ok(/Recommended/.test(workflow) && /Environment/.test(workflow), 'workflow documents a GitHub Environment as recommended')
ok(!/^\s+environment:/.test(workflow), 'workflow does not add a protected environment key')
const migrateSrc = readFileSync(join(root, 'scripts/migrate-supabase-to-neon.mjs'), 'utf8')
ok(!/disable-triggers/.test(migrateSrc), 'migrate script does not use --disable-triggers')
ok(/DROP SCHEMA IF EXISTS public CASCADE/.test(migrateSrc), 'live restore drops public so a rerun starts empty')
ok(/wrapRestoreTransaction/.test(migrateSrc), 'live restore wraps data in one transaction')
ok(/refuseSourceWipeReason/.test(migrateSrc), 'live restore refuses source-wipe aliases before a write')
ok(/refuseTargetFingerprintReason/.test(migrateSrc), 'live restore fingerprints the target before DROP')
ok(/confirmDropMismatchReason/.test(migrateSrc), 'live restore requires --confirm-drop')
ok(/probing target identity before drop/.test(migrateSrc), 'fingerprint probe is logged before DROP')
ok(/could not read source fingerprint/.test(migrateSrc), 'unreadable source fingerprint fails closed')
ok(/source marker is visible on the target/.test(migrateSrc), 'source marker visible on target is refused')
ok(/hostaddr/.test(migrateSrc) && /dbname/.test(migrateSrc), 'URL parser honors libpq hostaddr and dbname')
ok(
  /INSERT INTO "user" \(id, name, email, email_verified, created_at, updated_at\)/.test(migrateSrc),
  'auth-user copy writes snake_case Better Auth user columns',
)
ok(!/emailVerified|createdAt|updatedAt|userId|expiresAt/.test(loadUsersSql('/tmp/x.csv')), 'auth-user SQL has no camelCase columns')
ok(!/CREATE TABLE IF NOT EXISTS "user"[\s\S]*emailVerified/.test(readFileSync(join(root, 'worker/schema/better-auth.sql'), 'utf8')), 'better-auth.sql has no camelCase user table')

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

const authCols = await db.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('user', 'session', 'account', 'verification')
`)
ok(authCols.rows.length > 0, 'Better Auth tables exist')
ok(
  authCols.rows.every((r) => !/[A-Z]/.test(r.column_name)),
  'Better Auth user/session/account/verification columns are snake_case',
)
ok(
  authCols.rows.some((r) => r.table_name === 'user' && r.column_name === 'email_verified'),
  'user.email_verified is snake_case',
)
ok(
  !authCols.rows.some((r) => /emailVerified|createdAt|userId|expiresAt/.test(r.column_name)),
  'Better Auth tables have no camelCase columns',
)

const athletes = await db.query(`SELECT COUNT(*)::int AS n FROM public.athlete`)
eq(Number(athletes.rows[0]?.n ?? 0), 1, 'preview seed inserts one synthetic athlete')

ok(/reset_athlete_orientation/.test(appSql), 'app.sql defines reset_athlete_orientation')
ok(/do not re-add request\.jwt\.claim\.sub/.test(appSql), 'app.sql documents when the JWT fallback must stay gone')
await db.query(`SELECT set_config('app.current_auth_user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false)`)
await db.query(`SELECT public.reset_athlete_orientation()`)
const afterReset = await db.query(`SELECT onboarding_step, obstacle FROM public.athlete WHERE id = '11111111-1111-4111-8111-111111111111'`)
eq(afterReset.rows[0]?.onboarding_step, 'hook', 'reset_athlete_orientation returns the athlete to hook')
eq(Number((await db.query(`SELECT COUNT(*)::int AS n FROM public.workout`)).rows[0]?.n ?? -1), 0, 'reset_athlete_orientation clears workouts')

const livePsql = spawnSync('psql', [
  '-c',
  `SELECT 'athlete' AS t, 3::bigint AS n UNION ALL SELECT 'insight', 0 UNION ALL SELECT 'mcp_token', 1 UNION ALL SELECT 'phase', 1 UNION ALL SELECT 'program', 1 UNION ALL SELECT 'routine', 1 UNION ALL SELECT 'workout', 1 ORDER BY 1;`,
], { encoding: 'utf8' })
if (livePsql.status === 0 && livePsql.stdout) {
  const live = parseCounts(livePsql.stdout)
  eq(live.athlete, 3, 'parseCounts reads a live psql aligned session')
  requireCounts(live, 'live-psql')
} else {
  requireCounts(aligned, 'captured-psql-aligned')
  ok(PSQL_ALIGNED.startsWith('     t     | n'), 'captured fixture is real padded psql aligned output')
}

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} migrate checks failed:`)
  for (const f of fails) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✓ all ${checks} migrate / neon-schema checks passed`)
