#!/usr/bin/env node
/**
 * Checks for the Supabase → Neon migrate script: flag parsing, provided
 * auth-user mapping (CSV/JSON), secret redaction, and that the Neon app
 * schema has no Supabase RLS / GRANT / auth.uid() leftovers.
 *
 * Run: node --experimental-strip-types scripts/migrate-supabase-to-neon.check.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { refuseUnsafeTestUrl } from '../worker/src/refuseTestUrl.ts'
import {
  addMaskLines,
  advisoryLockParts,
  advisoryLockVisibleSql,
  argValue,
  assertSourcePgSsl,
  authUsersToCopyCsv,
  canExecutePgControlSystemQuery,
  checkSourceLockAbsentOnTarget,
  checksumPgOptions,
  checksumQuery,
  checksumRowsToMaps,
  checksumSessionSetSql,
  CHECKSUM_SESSION_GUC,
  confirmDropMismatchReason,
  createdAtTablesQuery,
  EXCLUDED_PUBLIC_TABLES,
  fingerprintQuery,
  formatCountComparison,
  formatSafeCommandError,
  formatSafePgClientError,
  formatSourceCountLines,
  GENERIC_SAFE_ERROR,
  isForbiddenSourceUrlParam,
  isLoopbackHost,
  isNeonHost,
  isSocketHost,
  isSupabaseHost,
  libpqCleanEnv,
  loadSourceCa,
  loadUsersSql,
  logLooksLikeRowData,
  main,
  maxCreatedAtQuery,
  missingMappedAuthUserIds,
  orderRestoreList,
  orphanAthleteQuery,
  parseAuthUsersMapping,
  parseChecksums,
  parseCounts,
  parseFingerprint,
  parseHashes,
  pgDumpSnapshotArgs,
  parseIdList,
  parseOrphanIds,
  parseMigrateArgs,
  postgresUrlParts,
  psqlArgv,
  psqlTuples,
  readFingerprint,
  redactSecrets,
  refuseSourceWipeReason,
  refuseTransactionPoolerReason,
  refuseUncoveredPublicTables,
  refuseUnexpectedPrimaryKeys,
  releaseHeldAdvisoryLocks,
  refuseTargetFingerprintReason,
  REQUIRED_COUNT_TABLES,
  requireCounts,
  requireHashes,
  resolveSourceUrl,
  resolveTargetUrl,
  restoreListSanityReason,
  run,
  sanitizePgFailureText,
  sanitizeSourceConnectionString,
  sourceCaFile,
  sourceCaFingerprintSha256,
  sourceCountsReport,
  sourceLibpqSslEnv,
  sourcePgClientConfig,
  sourcePgSsl,
  stripPgErrorValues,
  stripSslMode,
  SUPABASE_SOURCE_CA_FILE,
  SUPABASE_SOURCE_CA_FINGERPRINT_SHA256,
  targetPgClientConfig,
  SNAPSHOT_BEGIN_SQL,
  SNAPSHOT_EXPORT_SQL,
  SNAPSHOT_TIMEOUT_SQL,
  SQLSTATE_CLASS_TEXT,
  systemIdentifierQuery,
  uncoveredPublicTablesQuery,
  unexpectedPrimaryKeyQuery,
  withSourceSnapshot,
  wrapRestoreTransaction,
} from './migrate-supabase-to-neon.mjs'
import { previewTargetRefuseReason } from './seed-preview.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const checkPsqlUrl = process.env.ZEROED_CHECK_PSQL_URL?.trim() || ''
if (checkPsqlUrl) refuseUnsafeTestUrl(checkPsqlUrl, 'ZEROED_CHECK_PSQL_URL')
const sourceUrl = process.env.ZEROED_PG_SOURCE_URL?.trim() || ''
if (sourceUrl) refuseUnsafeTestUrl(sourceUrl, 'ZEROED_PG_SOURCE_URL')
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

let authMapDecode = ''
try {
  parseAuthUsersMapping('{ "email": "phil@example.com",', 'auth-users')
} catch (err) {
  authMapDecode = err instanceof Error ? err.message : String(err)
}
ok(authMapDecode.startsWith('auth map decode failed'), 'malformed auth-map JSON is a decode failure')
ok(!/phil@/i.test(authMapDecode), 'auth-map decode error omits the JSON / email')
ok(!/Unexpected|token|JSON/i.test(authMapDecode), 'auth-map decode error omits SyntaxError text')
ok(!logLooksLikeRowData(authMapDecode), 'auth-map decode error is not row data')

const leakyPg = [
  'ERROR:  duplicate key value violates unique constraint "user_email_key"',
  'DETAIL:  Key (email)=(phil@example.com) already exists.',
  'CONTEXT:  COPY auth_users_import, line 1: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,Phil,phil@example.com,t"',
  'HINT:  You might need to use ON CONFLICT.',
  'WHERE:  SQL statement',
  'LINE 1: INSERT INTO',
  'Failing row contains (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, Phil, phil@example.com).',
  'SQLSTATE 23505',
].join('\n')
const sanitized = sanitizePgFailureText(leakyPg)
eq(sanitized.sqlstate, '23505', 'sanitizer keeps SQLSTATE')
eq(sanitized.firstError, '', 'allowlist sanitizer does not keep ERROR text')
const safeFail = formatSafeCommandError('psql', 1, leakyPg, '')
eq(safeFail, 'psql failed (1): SQLSTATE 23505: integrity constraint violation', 'safe command error is SQLSTATE + class only')
ok(!/phil@/i.test(safeFail), 'safe command error has no email')
ok(!/user_email_key|Failing row|DETAIL/i.test(safeFail), 'safe command error has no constraint or DETAIL text')
ok(!logLooksLikeRowData(safeFail), 'safe command error is not row data')
ok(
  !/\(phil@/i.test(stripPgErrorValues('DETAIL:  Key (email)=(phil@example.com) already exists.')),
  'stripPgErrorValues removes Key values',
)
eq(
  formatSafeCommandError('psql', 1, 'ERROR:  boom phil@example.com leaked\n', ''),
  GENERIC_SAFE_ERROR,
  'safe command error becomes generic if it still looks like row data',
)
ok(logLooksLikeRowData('phil@example.com,not-a-real-hash'), 'email/CSV is treated as row data')
ok(!logLooksLikeRowData('| athlete | 1 | 1 | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |'), 'checksum table is not row data')

const quoteTok = 'rowtok-has"quote'
const slashTok = 'rowtok-slash\\'
const nlTok = 'rowtok-line1\nrowtok-line2'
const mixTok = `': "`
eq(
  formatSafeCommandError('psql', 1, `ERROR:  invalid "${quoteTok}" is bad\n`, ''),
  GENERIC_SAFE_ERROR,
  'odd " count in failure text becomes generic',
)
eq(
  formatSafeCommandError('psql', 1, `ERROR:  boom ${slashTok}\n`, ''),
  GENERIC_SAFE_ERROR,
  'trailing backslash in failure text becomes generic',
)
eq(
  formatSafeCommandError('psql', 1, `ERROR:  boom ${nlTok}\n`, ''),
  GENERIC_SAFE_ERROR,
  'newline value without SQLSTATE becomes generic',
)
eq(
  formatSafeCommandError('psql', 1, `ERROR:  ${mixTok}\n`, ''),
  GENERIC_SAFE_ERROR,
  `': " mix in failure text becomes generic`,
)
eq(
  formatSafeCommandError('psql', 1, 'ERROR:  P0001\n', ''),
  GENERIC_SAFE_ERROR,
  'P0001 RAISE becomes generic',
)
eq(
  formatSafeCommandError('psql', 1, 'ERROR:  P0001\nDETAIL:  rowtok-plpgsql\n', ''),
  GENERIC_SAFE_ERROR,
  'plpgsql RAISE (P0001) becomes generic',
)
eq(
  formatSafeCommandError('psql', 1, 'ERROR:  P0001\nCONTEXT:  PL/pgSQL function boom_trig()\nDETAIL:  rowtok-trig\n', ''),
  GENERIC_SAFE_ERROR,
  'trigger RAISE (P0001) becomes generic',
)
eq(
  formatSafeCommandError('psql', 1, 'ERROR:  P0001\nCONTEXT:  PL/pgSQL function inline_code_block line 1\nDETAIL:  rowtok-do\n', ''),
  GENERIC_SAFE_ERROR,
  'DO-block RAISE (P0001) becomes generic',
)
eq(
  formatSafeCommandError('pg_dump', 1, 'pg_dump: error: SQLSTATE 08006\nDETAIL: leaked-rowtok\n', ''),
  'pg_dump failed (1): SQLSTATE 08006: connection exception',
  'pg_dump logs cmd, exit, SQLSTATE, and class only',
)
eq(
  formatSafeCommandError('pg_restore', 1, 'pg_restore: error: SQLSTATE 23505\nDETAIL: leaked-rowtok\n', ''),
  'pg_restore failed (1): SQLSTATE 23505: integrity constraint violation',
  'pg_restore logs cmd, exit, SQLSTATE, and class only',
)
eq(
  formatSafeCommandError('pg_dump', 1, 'pg_dump: error: connection failed\nDETAIL: leaked-rowtok\n', ''),
  GENERIC_SAFE_ERROR,
  'pg_dump without a known SQLSTATE class is generic',
)
eq(SQLSTATE_CLASS_TEXT['23'], 'integrity constraint violation', '23505 class text is pinned')
eq(
  formatSafePgClientError({ code: '22P02', message: 'invalid input syntax for type integer: "rowtok-pg"' }, 'snapshot'),
  'snapshot failed (1): SQLSTATE 22P02: data exception',
  'node-pg snapshot errors keep SQLSTATE + class only',
)
ok(!formatSafePgClientError({ code: '22P02', message: 'invalid input syntax for type integer: "rowtok-pg"' }, 'snapshot').includes('rowtok-pg'), 'node-pg snapshot error omits the value')
eq(
  formatSafePgClientError(new Error(slashTok)),
  GENERIC_SAFE_ERROR,
  'uncaught error with trailing backslash is generic',
)
ok(psqlArgv('-d', 'x').includes('VERBOSITY=sqlstate'), 'psqlArgv sets VERBOSITY=sqlstate')
ok(psqlArgv('-d', 'x').includes('ON_ERROR_STOP=1'), 'psqlArgv sets ON_ERROR_STOP=1')

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

const EXTRA_COUNT_TABLES = [
  'weekly_review', 'probe_throttle', 'diagnostic', 'insight_draft',
  'athlete_profile', 'workout_draft', 'program_revision', 'session_observation',
  'coach_message',
]
const PSQL_ALIGNED = `     t     | n 
-----------+---
 athlete   | 3
 athlete_profile | 0
 coach_message | 0
 diagnostic | 0
 insight   | 0
 insight_draft | 0
 mcp_token | 1
 phase     | 1
 probe_throttle | 0
 program   | 1
 program_revision | 0
 routine   | 1
 session_observation | 0
 weekly_review | 0
 workout   | 1
 workout_draft | 0
(16 rows)
`

eq(REQUIRED_COUNT_TABLES.length, 16, 'counts cover all 16 public app tables')
for (const table of EXTRA_COUNT_TABLES) {
  ok(REQUIRED_COUNT_TABLES.includes(table), `counts include ${table}`)
}
ok(!REQUIRED_COUNT_TABLES.includes('user'), 'counts exclude Better Auth user')
ok(!REQUIRED_COUNT_TABLES.includes('session'), 'counts exclude Better Auth session')
ok(!REQUIRED_COUNT_TABLES.includes('account'), 'counts exclude Better Auth account')
ok(!REQUIRED_COUNT_TABLES.includes('verification'), 'counts exclude Better Auth verification')

const checksumSql = checksumQuery()
for (const table of REQUIRED_COUNT_TABLES) {
  ok(checksumSql.includes(`public.${table}`), `checksumQuery includes ${table}`)
}
ok(!/FROM public\."?user"?/.test(checksumSql), 'checksumQuery excludes Better Auth user')
ok(!/FROM public\.session(?:\s|;|$)/.test(checksumSql), 'checksumQuery excludes Better Auth session')
ok(/to_jsonb\(t\)/.test(checksumSql), 'checksumQuery hashes to_jsonb(t) so column order does not matter')
ok(/ORDER BY t\.id/.test(checksumSql), 'checksumQuery aggregates hashes in primary-key order')
ok(/AS h /.test(checksumSql), 'checksumQuery selects a content hash column')
eq(EXCLUDED_PUBLIC_TABLES.join(','), 'user,session,account,verification', 'Better Auth tables are excluded on purpose')
ok(uncoveredPublicTablesQuery().includes('pg_tables'), 'coverage guard lists public tables')
ok(uncoveredPublicTablesQuery().includes("'user'"), 'coverage guard excludes Better Auth user')
ok(unexpectedPrimaryKeyQuery().includes('indisprimary'), 'pk guard inspects primary keys')
ok(SNAPSHOT_BEGIN_SQL.includes('REPEATABLE READ'), 'snapshot opens REPEATABLE READ')
ok(SNAPSHOT_BEGIN_SQL.includes('READ ONLY'), 'snapshot transaction is READ ONLY')
ok(SNAPSHOT_BEGIN_SQL.startsWith('BEGIN ISOLATION LEVEL'), 'snapshot uses BEGIN ISOLATION LEVEL')
ok(SNAPSHOT_EXPORT_SQL.includes('pg_export_snapshot()'), 'snapshot exports pg_export_snapshot()')
const dumpArgs = pgDumpSnapshotArgs('/tmp/public.dump', '00000003-0000001A-1', 'postgresql://example')
ok(dumpArgs.includes('--snapshot=00000003-0000001A-1'), 'pg_dump receives --snapshot')
ok(dumpArgs.includes('--data-only'), 'snapshot dump stays data-only')
ok(dumpArgs.includes('--schema=public'), 'snapshot dump is public-only')
let uncoveredFailed = false
try {
  refuseUncoveredPublicTables(['new_public_table'])
} catch (err) {
  uncoveredFailed = /not in coverage list/.test(err instanceof Error ? err.message : '')
}
ok(uncoveredFailed, 'coverage guard fails when a public table is missing from the list')
eq(refuseUncoveredPublicTables([]).length, 0, 'coverage guard accepts an empty extra list')
let pkFailed = false
try {
  refuseUnexpectedPrimaryKeys([{ table_name: 'athlete', pk: 'athlete_id' }])
} catch (err) {
  pkFailed = /primary key is not id/.test(err instanceof Error ? err.message : '')
}
ok(pkFailed, 'pk guard fails when a covered table is not keyed by id')
eq(CHECKSUM_SESSION_GUC.TimeZone, 'UTC', 'checksum sessions pin TimeZone=UTC')
eq(CHECKSUM_SESSION_GUC.extra_float_digits, '1', 'checksum sessions pin extra_float_digits=1')
eq(CHECKSUM_SESSION_GUC.IntervalStyle, 'postgres', 'checksum sessions pin IntervalStyle=postgres')
ok(checksumPgOptions().includes('TimeZone=UTC'), 'psql PGOPTIONS pins TimeZone=UTC')
ok(checksumPgOptions().includes('extra_float_digits=1'), 'psql PGOPTIONS pins extra_float_digits=1')
ok(checksumPgOptions().includes('IntervalStyle=postgres'), 'psql PGOPTIONS pins IntervalStyle=postgres')
ok(checksumSessionSetSql().includes("SET TimeZone = 'UTC'"), 'snapshot client SET pins TimeZone')
ok(checksumSessionSetSql().includes('SET extra_float_digits = 1'), 'snapshot client SET pins extra_float_digits')
ok(checksumSessionSetSql().includes("SET IntervalStyle = 'postgres'"), 'snapshot client SET pins IntervalStyle')
ok(SNAPSHOT_TIMEOUT_SQL.includes('statement_timeout = 0'), 'snapshot session disables statement_timeout')
ok(SNAPSHOT_TIMEOUT_SQL.includes('idle_in_transaction_session_timeout = 0'), 'snapshot session disables idle-in-transaction timeout')
ok(isLoopbackHost('127.0.0.1'), 'isLoopbackHost matches 127.0.0.1')
ok(!stripSslMode('postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require').includes('sslmode='), 'stripSslMode drops sslmode')
const sslSoup = 'postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require&sslrootcert=/secret.crt&sslcert=/c.pem&sslkey=/k.pem&sslcrl=/crl.pem&uselibpqcompat=true'
ok(isForbiddenSourceUrlParam('sslmode'), 'sslmode is a forbidden source param')
ok(isForbiddenSourceUrlParam('sslrootcert'), 'sslrootcert is a forbidden source param')
ok(isForbiddenSourceUrlParam('uselibpqcompat'), 'uselibpqcompat is a forbidden source param')
ok(!stripSslMode(sslSoup).includes('sslmode='), 'stripSslMode drops sslmode among other ssl*')
ok(!stripSslMode(sslSoup).includes('sslrootcert='), 'stripSslMode drops sslrootcert')
ok(!stripSslMode(sslSoup).includes('sslcert='), 'stripSslMode drops sslcert')
ok(!stripSslMode(sslSoup).includes('sslkey='), 'stripSslMode drops sslkey')
ok(!stripSslMode(sslSoup).includes('sslcrl='), 'stripSslMode drops sslcrl')
ok(!/uselibpqcompat/i.test(stripSslMode(sslSoup)), 'stripSslMode drops uselibpqcompat')
const sanitizedSoup = sanitizeSourceConnectionString(sslSoup)
ok(!/[?&](ssl|uselibpqcompat)/i.test(sanitizedSoup), 'sanitizeSourceConnectionString leaves no ssl* or uselibpqcompat')
const plusOpts = 'postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?options=-c+TimeZone=UTC&sslmode=require'
const cleanedPlus = sanitizeSourceConnectionString(plusOpts)
ok(cleanedPlus.includes('options=-c+TimeZone=UTC'), 'sanitizeSourceConnectionString does not re-encode + in libpq options')
ok(!cleanedPlus.includes('%20') && !cleanedPlus.includes('%2B'), 'libpq options plus stays a plus')
ok(!cleanedPlus.includes('sslmode='), 'plus-preserving sanitize still drops sslmode')
let unexpectedParam = false
try {
  sanitizeSourceConnectionString('postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?channel_binding=require')
} catch (err) {
  unexpectedParam = /unexpected query parameter/.test(err instanceof Error ? err.message : '')
}
ok(unexpectedParam, 'unexpected source URL params are refused')
let hostOverride = false
let hostOverrideMsg = ''
try {
  sanitizeSourceConnectionString('postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?host=evil.example')
} catch (err) {
  hostOverrideMsg = err instanceof Error ? err.message : String(err)
  hostOverride = /host=/.test(hostOverrideMsg)
}
ok(hostOverride, 'source URL ?host= override is refused')
ok(!/evil\.example/.test(hostOverrideMsg), 'host= refuse message omits the override host')
ok(existsSync(SUPABASE_SOURCE_CA_FILE), 'Supabase prod-ca-2021.crt is committed')
ok(loadSourceCa().includes('BEGIN CERTIFICATE'), 'committed source CA is a PEM certificate')
eq(sourceCaFile(), SUPABASE_SOURCE_CA_FILE, 'default source CA is the committed file')
eq(sourceCaFingerprintSha256(), SUPABASE_SOURCE_CA_FINGERPRINT_SHA256, 'committed Supabase CA SHA-256 fingerprint is pinned')
const libpqSsl = sourceLibpqSslEnv('postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require')
eq(libpqSsl.PGSSLMODE, 'verify-full', 'source libpq sets PGSSLMODE=verify-full')
eq(libpqSsl.PGSSLROOTCERT, SUPABASE_SOURCE_CA_FILE, 'source libpq points PGSSLROOTCERT at the pinned CA')
ok(!libpqSsl.PGSSLCERT && !libpqSsl.PGSSLKEY, 'source libpq does not set client cert env')
const supabaseTlsUrl = 'postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require'
const srcCfg = sourcePgClientConfig(supabaseTlsUrl)
assertSourcePgSsl(srcCfg)
ok(srcCfg.ssl.rejectUnauthorized === true, 'source client sets rejectUnauthorized: true')
ok(String(srcCfg.ssl.ca).includes('BEGIN CERTIFICATE'), 'source client is built with the CA')
ok(!String(srcCfg.connectionString).includes('sslmode='), 'source client URL has sslmode stripped')
eq(sourcePgSsl(supabaseTlsUrl).rejectUnauthorized, true, 'sourcePgSsl verifies remote Supabase')
let missingCaFailed = false
try {
  assertSourcePgSsl({ connectionString: stripSslMode(supabaseTlsUrl), ssl: { rejectUnauthorized: true } })
} catch (err) {
  missingCaFailed = /must be built with a CA/.test(err instanceof Error ? err.message : '')
}
ok(missingCaFailed, 'source pg client built without a CA is refused')
let noVerifyFailed = false
try {
  assertSourcePgSsl({ connectionString: stripSslMode(supabaseTlsUrl), ssl: { ca: loadSourceCa(), rejectUnauthorized: false } })
} catch {
  noVerifyFailed = true
}
ok(noVerifyFailed, 'source pg client with rejectUnauthorized: false is refused')
const neonCfg = targetPgClientConfig('postgresql://neondb_owner@ep-foo.us-east-2.aws.neon.tech/neondb?sslmode=require')
ok(neonCfg.ssl.rejectUnauthorized === true, 'Neon client keeps verify-full')
ok(!Object.hasOwn(neonCfg.ssl, 'ca'), 'Neon client uses the public CA store')
ok(!String(neonCfg.connectionString).includes('sslmode='), 'Neon client URL has sslmode stripped')
eq(sourcePgSsl('postgresql://src:dummy@127.0.0.1:55418/srcdb'), false, 'loopback migrate-pg source stays plaintext')
const report = sourceCountsReport({ workout: 113, athlete: 2 }, { workout: 'a'.repeat(32) })
eq(report.tables.workout.n, 113, 'source-counts report includes workout')
ok(formatSourceCountLines({ workout: 113 }).some((l) => l.includes('workout: 113')), 'source count lines include workout')
ok(
  /workout/.test(restoreListSanityReason('211; 0 16410 TABLE DATA public athlete postgres\n')),
  'restore-list sanity flags a missing workout table',
)
eq(
  refuseTransactionPoolerReason('postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres'),
  '',
  'direct Supabase :5432 is allowed',
)
eq(
  refuseTransactionPoolerReason('postgresql://reader@aws-0-us-east-1.pooler.supabase.com:5432/postgres'),
  '',
  'session-mode pooler :5432 is allowed',
)
ok(
  /port 6543/.test(refuseTransactionPoolerReason('postgresql://reader@aws-0-us-east-1.pooler.supabase.com:6543/postgres')),
  'transaction pooler :6543 is refused',
)
ok(
  /port 6543/.test(refuseTransactionPoolerReason('postgresql://reader@db.abcdefghijkl.supabase.co/postgres?port=6543')),
  'libpq ?port=6543 is refused as transaction pooler',
)
ok(
  /mode=transaction/.test(refuseTransactionPoolerReason('postgresql://reader@aws-0-us-east-1.pooler.supabase.com:5432/postgres?mode=transaction')),
  'mode=transaction is refused',
)
ok(
  /mode=transaction/.test(refuseTransactionPoolerReason('postgresql://reader@aws-0-us-east-1.pooler.supabase.com:5432/postgres?pool_mode=transaction')),
  'pool_mode=transaction is refused',
)
ok(
  /mode=transaction/.test(refuseTransactionPoolerReason('postgresql://reader@db.abcdefghijkl.supabase.co:5432/postgres?options=-c%20pool_mode=transaction')),
  'options pool_mode=transaction is refused',
)
ok(createdAtTablesQuery().includes("column_name = 'created_at'"), 'createdAtTablesQuery finds created_at columns')
ok(maxCreatedAtQuery('athlete').includes('MAX(created_at)'), 'maxCreatedAtQuery reads athlete.created_at')
let refusedAuthTable = false
try {
  maxCreatedAtQuery('user')
} catch {
  refusedAuthTable = true
}
ok(refusedAuthTable, 'maxCreatedAtQuery refuses Better Auth tables')

const aligned = parseCounts(PSQL_ALIGNED)
eq(aligned.athlete, 3, 'parseCounts reads padded psql aligned athlete')
eq(aligned.mcp_token, 1, 'parseCounts reads padded psql aligned mcp_token')
eq(aligned.insight, 0, 'parseCounts reads a zero count from aligned psql')
eq(aligned.weekly_review, 0, 'parseCounts reads padded psql aligned weekly_review')
eq(aligned.coach_message, 0, 'parseCounts reads padded psql aligned coach_message')
requireCounts(aligned, 'aligned-fixture')
ok(true, 'requireCounts accepts a complete aligned parse')

const atCsv = parseCounts('athlete,3\nathlete_profile,0\ncoach_message,0\ndiagnostic,0\ninsight,0\ninsight_draft,0\nmcp_token,1\nphase,1\nprobe_throttle,0\nprogram,1\nprogram_revision,0\nroutine,1\nsession_observation,0\nweekly_review,0\nworkout,1\nworkout_draft,0\n')
eq(atCsv.athlete, 3, 'parseCounts reads psql -At CSV')
requireCounts(atCsv, 'at-csv')

const csvHeaderOut = parseCounts('t,n\nathlete,3\nathlete_profile,0\ncoach_message,0\ndiagnostic,0\ninsight,0\ninsight_draft,0\nmcp_token,1\nphase,1\nprobe_throttle,0\nprogram,1\nprogram_revision,0\nroutine,1\nsession_observation,0\nweekly_review,0\nworkout,1\nworkout_draft,0\n')
eq(csvHeaderOut.workout, 1, 'parseCounts skips psql --csv header')
eq(csvHeaderOut.session_observation, 0, 'parseCounts reads session_observation from csv header output')

let emptyFailed = false
try {
  requireCounts(parseCounts('     t     | n \n-----------+---\n(0 rows)\n'), 'empty')
} catch (err) {
  emptyFailed = /missing row counts/.test(err instanceof Error ? err.message : '')
}
ok(emptyFailed, 'requireCounts fails hard when aligned output has no table rows')

const full = Object.fromEntries(REQUIRED_COUNT_TABLES.map((t) => [t, aligned[t] ?? 0]))
eq(Object.keys(full).length, 16, 'complete count fixture has 16 tables')
ok(!formatCountComparison(full, full).mismatch, 'matching required tables are ok')
ok(formatCountComparison(full, { ...full, athlete: 2 }).mismatch, 'mismatch is flagged')
ok(formatCountComparison(full, null).mismatch, 'missing dest counts are a mismatch')
ok(formatCountComparison({}, {}).mismatch, 'empty vs empty is a mismatch, not ok')

const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'
const hashCsv = REQUIRED_COUNT_TABLES.map((t, i) => `${t},${i},${EMPTY_MD5}`).join('\n')
const parsedHashCounts = parseCounts(hashCsv)
const parsedHashes = parseHashes(hashCsv)
eq(parsedHashCounts.athlete, 0, 'parseCounts reads counts when a hash column is present')
eq(parsedHashes.athlete, EMPTY_MD5, 'parseHashes reads a 32-hex content md5')
eq(parseChecksums(`t,n,h\n${hashCsv}`).hashes.workout, EMPTY_MD5, 'parseChecksums skips the t,n,h header')
requireHashes(parsedHashes, 'hash-csv')
ok(true, 'requireHashes accepts a complete hash parse')
let hashFailed = false
try {
  requireHashes({}, 'empty-hash')
} catch (err) {
  hashFailed = /missing content hashes/.test(err instanceof Error ? err.message : '')
}
ok(hashFailed, 'requireHashes fails hard when hashes are missing')
const fullHashes = Object.fromEntries(REQUIRED_COUNT_TABLES.map((t) => [t, EMPTY_MD5]))
ok(!formatCountComparison(full, full, fullHashes, fullHashes).mismatch, 'matching counts and hashes are ok')
ok(
  formatCountComparison(full, full, fullHashes, { ...fullHashes, athlete: 'a'.repeat(32) }).mismatch,
  'hash mismatch is flagged even when counts match',
)
eq(
  checksumRowsToMaps([{ t: 'athlete', n: '3', h: EMPTY_MD5 }]).hashes.athlete,
  EMPTY_MD5,
  'checksumRowsToMaps keeps the content hash',
)

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

const cleaned = libpqCleanEnv({
  PATH: '/usr/bin',
  HOME: '/home/ci',
  PGHOST: 'ep-x.neon.tech',
  PGHOSTADDR: '1.2.3.4',
  PGSERVICE: 'neon',
  PGSERVICEFILE: '/tmp/pg_service.conf',
  PGSYSCONFDIR: '/tmp',
  PGPASSWORD: 'secret',
})
ok(!cleaned.PGHOST && !cleaned.PGHOSTADDR, 'libpqCleanEnv strips PGHOST/PGHOSTADDR')
ok(!cleaned.PGSERVICE && !cleaned.PGSERVICEFILE && !cleaned.PGSYSCONFDIR, 'libpqCleanEnv strips PGSERVICE*')
ok(!cleaned.PGPASSWORD, 'libpqCleanEnv strips PGPASSWORD')
eq(cleaned.PATH, '/usr/bin', 'libpqCleanEnv keeps PATH')
eq(cleaned.HOME, '/home/ci', 'libpqCleanEnv keeps HOME')

eq(previewTargetRefuseReason(neonDirect), '', 'preview seed allows a Neon host')
eq(
  previewTargetRefuseReason('postgresql://postgres@127.0.0.1:5432/zeroed'),
  'target host must end in .neon.tech',
  'preview seed refuses loopback',
)
eq(
  previewTargetRefuseReason(supabaseDirect),
  'target host looks like Supabase',
  'preview seed refuses Supabase',
)
eq(
  previewTargetRefuseReason(`${neonDirect}?host=/tmp/pg`),
  'target host is a socket path',
  'preview seed refuses a socket override',
)
eq(
  previewTargetRefuseReason(`${neonDirect}?host=db.example.com`),
  'target host override must end in .neon.tech',
  'preview seed refuses a non-Neon host override',
)

const seedSrc = readFileSync(join(root, 'scripts/seed-preview.mjs'), 'utf8')
ok(/libpqCleanEnv/.test(seedSrc), 'seed-preview uses libpqCleanEnv')
ok(/previewTargetRefuseReason/.test(seedSrc), 'seed-preview calls the Neon allowlist before psql')

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
ok(!fingerprintQuery().includes('pg_control_system'), 'fingerprint query does not call pg_control_system')
ok(
  canExecutePgControlSystemQuery().includes("has_function_privilege('pg_control_system()', 'EXECUTE')"),
  'privilege check is its own query',
)
ok(systemIdentifierQuery().includes('pg_control_system()'), 'sysid query is separate and only used when allowed')
ok(fingerprintQuery().includes('inet_server_addr'), 'fingerprint query reads inet_server_addr')
ok(fingerprintQuery().includes('inet_server_port'), 'fingerprint query reads inet_server_port')
ok(fingerprintQuery().includes('pg_postmaster_start_time'), 'fingerprint query reads postmaster start time')
eq(advisoryLockParts('1').objid, 1, 'advisoryLockParts low bits of 1')
ok(advisoryLockVisibleSql('1').includes('pg_locks'), 'lock visibility query reads pg_locks')
ok(advisoryLockVisibleSql('1').includes('objsubid = 1'), 'lock visibility query uses the bigint form')

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
ok(/advisory lock/.test(drySkip.stdout), 'dry-run documents the advisory-lock same-server check')
ok(/pg_export_snapshot/.test(drySkip.stdout), 'offline dry-run documents the snapshot dump')
ok(/TimeZone=UTC/.test(drySkip.stdout) && /extra_float_digits=1/.test(drySkip.stdout), 'offline dry-run documents checksum GUC pins')
ok(/idle_in_transaction_session_timeout=0/.test(drySkip.stdout), 'offline dry-run documents snapshot timeouts')
ok(/transaction-pooler source/.test(drySkip.stdout), 'offline dry-run documents the transaction-pooler refuse')
ok(/source-only/.test(drySkip.stdout), 'offline dry-run documents source-only semantics')
ok(/no Neon compare/.test(drySkip.stdout), 'offline dry-run says it does not compare Neon')
ok(/coverage list/.test(drySkip.stdout), 'offline dry-run documents the public-table coverage guard')
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

const srcOnlyDry = spawnMigrate(['--dry-run', '--skip-auth-users'], {
  SUPABASE_READONLY_URL: 'postgresql://reader@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
})
const srcOnlyDryOut = `${srcOnlyDry.stdout}\n${srcOnlyDry.stderr}`
eq(srcOnlyDry.status, 2, 'source-only dry-run still refuses the transaction pooler')
ok(/transaction pooler/.test(srcOnlyDryOut), 'source-only dry-run does not require a Neon URL to refuse the pooler')
ok(!/NEON_DIRECT_URL/.test(srcOnlyDryOut), 'source-only dry-run does not demand NEON_DIRECT_URL')

const txnPooler = spawnMigrate(['--dry-run', '--skip-auth-users'], {
  SUPABASE_READONLY_URL: 'postgresql://reader@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
  NEON_DIRECT_URL: neonDirect,
})
const txnPoolerOut = `${txnPooler.stdout}\n${txnPooler.stderr}`
eq(txnPooler.status, 2, 'transaction-pooler source dry-run exits 2')
ok(/transaction pooler/.test(txnPoolerOut), 'transaction-pooler source prints a refuse reason')
ok(!/dumping/i.test(txnPoolerOut), 'transaction-pooler source does not dump')
ok(!/postgresql:\/\//i.test(txnPoolerOut), 'transaction-pooler refuse does not print a URL')

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

  let lockAttempted = false
  const unreadFp = await main(
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
      checkSourceLock() {
        lockAttempted = true
        return ''
      },
    },
  )
  eq(unreadFp, 2, 'unreadable source fingerprint exits 2')
  ok(!lockAttempted, 'unreadable source fingerprint does not take a lock or drop')
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
const checksYml = readFileSync(join(root, '.github/workflows/checks.yml'), 'utf8')
ok(!/pg-source:/.test(checksYml) && !/pg-target:/.test(checksYml), 'migrate-pg does not use GitHub services: Postgres')
ok(/docker run/.test(checksYml) && /55418/.test(checksYml) && /55419/.test(checksYml), 'migrate-pg starts source and target Postgres via docker run')
ok(/--log-driver=none/.test(checksYml), 'migrate-pg discards Postgres container logs')
ok(!/docker logs/.test(checksYml), 'CI never prints docker logs')
ok(/pin-postgres-container-logs/.test(checksYml), 'CI pins Postgres log verbosity')
ok(/ZEROED_PG_SOURCE_URL/.test(checksYml), 'CI passes a source URL to live migrate checks')
ok(/ZEROED_PG_TARGET_URL/.test(checksYml), 'CI passes a target URL to live migrate checks')
ok(/ZEROED_PG_ALIAS_URL/.test(checksYml), 'CI passes an alias URL to live migrate checks')
const pinLogs = readFileSync(join(root, 'scripts/pin-postgres-container-logs.sh'), 'utf8')
ok(/log_min_messages = panic/.test(pinLogs), 'pin script sets log_min_messages=panic')
ok(/log_min_error_statement = panic/.test(pinLogs), 'pin script sets log_min_error_statement=panic')
ok(/log_error_verbosity = terse/.test(pinLogs), 'pin script sets log_error_verbosity=terse')
ok(/pg_reload_conf/.test(pinLogs), 'pin script reloads Postgres after ALTER SYSTEM')
ok(/-d "\$\{db\}"/.test(pinLogs) || /-d postgres/.test(pinLogs), 'pin script connects to an existing database')
ok(/Silence Postgres fixture logs/.test(checksYml), 'fixture Postgres services pin log verbosity')
const migrateSrc = readFileSync(join(root, 'scripts/migrate-supabase-to-neon.mjs'), 'utf8')
ok(!/disable-triggers/.test(migrateSrc), 'migrate script does not use --disable-triggers')
ok(/DROP SCHEMA IF EXISTS public CASCADE/.test(migrateSrc), 'live restore drops public so a rerun starts empty')
ok(/wrapRestoreTransaction/.test(migrateSrc), 'live restore wraps data in one transaction')
ok(/refuseSourceWipeReason/.test(migrateSrc), 'live restore refuses source-wipe aliases before a write')
ok(/refuseTargetFingerprintReason/.test(migrateSrc), 'live restore fingerprints the target before DROP')
ok(/confirmDropMismatchReason/.test(migrateSrc), 'live restore requires --confirm-drop')
ok(/probing target identity before drop/.test(migrateSrc), 'fingerprint probe is logged before DROP')
ok(/could not read source fingerprint/.test(migrateSrc), 'unreadable source fingerprint fails closed')
ok(
  /extractSqlstate\(message\) === '42P01'/.test(migrateSrc),
  'empty-target checksum treats allowlisted 42P01 as missing tables',
)
ok(/source advisory lock is visible on the target/.test(migrateSrc), 'source lock visible on target is refused')
ok(!/zeroed_cutover_guard/.test(migrateSrc), 'migrate script does not write a source marker schema')
ok(/SIGINT/.test(migrateSrc) && /SIGTERM/.test(migrateSrc), 'lock session is released on SIGINT/SIGTERM')
ok(/hostaddr/.test(migrateSrc) && /dbname/.test(migrateSrc), 'URL parser honors libpq hostaddr and dbname')
ok(
  /INSERT INTO "user" \(id, name, email, email_verified, created_at, updated_at\)/.test(migrateSrc),
  'auth-user copy writes snake_case Better Auth user columns',
)
ok(!/emailVerified|createdAt|updatedAt|userId|expiresAt/.test(loadUsersSql('/tmp/x.csv')), 'auth-user SQL has no camelCase columns')
ok(!/CREATE TABLE IF NOT EXISTS "user"[\s\S]*emailVerified/.test(readFileSync(join(root, 'worker/schema/better-auth.sql'), 'utf8')), 'better-auth.sql has no camelCase user table')
ok(migrateSrc.includes('weekly_review') && migrateSrc.includes('coach_message'), 'migrate counts weekly_review and coach_message')
ok(migrateSrc.includes('createdAtTablesQuery') || migrateSrc.includes("column_name = 'created_at'"), 'migrate looks up created_at columns')
ok(/MAX\(created_at\)/.test(migrateSrc), 'maxCreatedAtQuery reads created_at')
ok(/pg_export_snapshot/.test(migrateSrc), 'migrate exports a REPEATABLE READ snapshot')
ok(/--snapshot=/.test(migrateSrc), 'migrate passes --snapshot to pg_dump')
ok(/to_jsonb\(t\)/.test(migrateSrc), 'migrate hashes row content as to_jsonb')
ok(/uncoveredPublicTablesQuery/.test(migrateSrc), 'migrate refuses uncovered public tables')
ok(/source-only succeeded/.test(migrateSrc), 'dry-run is source-only and does not abort on empty Neon')
ok(/sourcePgClientConfig/.test(migrateSrc), 'source pg clients go through sourcePgClientConfig')
ok(/sourceLibpqSslEnv/.test(migrateSrc), 'source psql/pg_dump use sourceLibpqSslEnv')
ok(/formatSafeCommandError/.test(migrateSrc), 'run() uses formatSafeCommandError')
ok(/installSafeErrorHandlers/.test(migrateSrc), 'migrate installs safe uncaught handlers')
ok(/VERBOSITY=sqlstate/.test(migrateSrc), 'every psql sets VERBOSITY=sqlstate')
ok(/psqlArgv\(/.test(migrateSrc), 'psql invocations go through psqlArgv')
ok(/formatSafePgClientError/.test(migrateSrc), 'node-pg snapshot errors go through formatSafePgClientError')
ok(/must not include a host= override/.test(migrateSrc), 'source URL ?host= is refused')
ok(/queryParamKey/.test(migrateSrc) || /does not re-encode/.test(migrateSrc) || /without re-encoding/.test(migrateSrc), 'libpq options plus is not re-encoded')
ok(/READ ONLY/.test(migrateSrc), 'snapshot SQL is READ ONLY')
ok(!/new pg\.Client\(\{\s*connectionString:\s*sourceUrl/.test(migrateSrc), 'source pg clients are not built from a raw URL')
ok(!/ssl:\s*\{[^}]*rejectUnauthorized:\s*false/.test(migrateSrc), 'migrate script never sets rejectUnauthorized: false')
ok(!/uselibpqcompat\s*[:=]/.test(migrateSrc), 'migrate script does not enable uselibpqcompat')
ok(/prod-ca-2021/.test(migrateSrc), 'migrate script references the committed Supabase CA')
ok(/migrate-tls:/.test(checksYml), 'CI has a migrate-tls job')
ok(/checksumPgOptions/.test(migrateSrc) && /PGOPTIONS/.test(migrateSrc), 'psqlTuples pins checksum GUCs via PGOPTIONS')
ok(/checksumSessionSetSql/.test(migrateSrc), 'snapshot client applies checksum SET pins')
ok(/refuseTransactionPoolerReason/.test(migrateSrc), 'migrate refuses a transaction-pooler source')
ok(/idle_in_transaction_session_timeout = 0/.test(migrateSrc), 'snapshot session clears idle_in_transaction_session_timeout')
ok(!/upload-artifact/.test(workflow), 'manual migrate does not upload dump artifacts')
const runbook = readFileSync(join(root, 'docs/cloudflare-cutover.md'), 'utf8')
ok(/pg_export_snapshot/.test(runbook), 'RUNBOOK documents pg_export_snapshot')
ok(/pg_dump --snapshot/.test(runbook), 'RUNBOOK documents pg_dump --snapshot')
ok(/REPEATABLE READ/.test(runbook), 'RUNBOOK documents the REPEATABLE READ snapshot')
ok(/exits 0/.test(runbook) && /empty Neon is not a dry-run failure/.test(runbook), 'RUNBOOK documents source-only dry-run exit 0')
ok(/prod-ca-2021/.test(runbook), 'RUNBOOK documents the committed Supabase CA')
ok(/statement_timeout=0/.test(runbook) && /idle_in_transaction_session_timeout=0/.test(runbook), 'RUNBOOK documents snapshot timeouts')
ok(/TimeZone=UTC/.test(runbook) && /extra_float_digits=1/.test(runbook), 'RUNBOOK documents checksum GUC pins')
ok(/transaction pooler/.test(runbook), 'RUNBOOK documents the transaction-pooler refuse')
ok(/PGPASSFILE=\/dev\/null/.test(workflow), 'migrate workflow version-check nulls PGPASSFILE')
ok(/PGSSLMODE=verify-full/.test(workflow), 'migrate workflow version-check sets PGSSLMODE=verify-full')
ok(/PGSSLROOTCERT/.test(workflow), 'migrate workflow version-check sets PGSSLROOTCERT')
ok(/sanitizeSourceConnectionString/.test(workflow), 'migrate workflow version-check strips ssl* from the source URL')
ok(/::add-mask::/.test(workflow) && /postgresUrlParts/.test(workflow), 'migrate workflow masks the probed source host')
ok(/VERBOSITY=sqlstate/.test(workflow), 'migrate workflow probe uses VERBOSITY=sqlstate')
ok(/set -euo pipefail/.test(workflow) && /psql .*\|\s*tr/.test(workflow), 'migrate workflow probe pipe runs under pipefail')
ok(/::add-mask::/.test(checksYml) && /postgresUrlParts/.test(checksYml), 'migrate-pg probe masks the source host')
ok(/VERBOSITY=sqlstate/.test(checksYml), 'migrate-pg probe uses VERBOSITY=sqlstate')
ok(/migrate-tls:[\s\S]*persist-credentials:\s*false/.test(checksYml), 'migrate-tls checkout does not persist credentials')
ok(/PGPASSFILE=\/dev\/null/.test(checksYml), 'migrate-pg version-check nulls PGPASSFILE')
ok(/-u PGSSLMODE|-u PGHOSTADDR|PGHOSTADDR/.test(checksYml), 'migrate-pg version-check unsets inherited PGHOSTADDR/PGSSLMODE')

const db = new PGlite()
await db.exec(readFileSync(join(root, 'worker/schema/app.sql'), 'utf8'))
await db.exec(readFileSync(join(root, 'worker/schema/better-auth.sql'), 'utf8'))
await db.exec(readFileSync(join(root, 'worker/schema/preview-seed.sql'), 'utf8'))

const tables = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (${REQUIRED_COUNT_TABLES.map((t) => `'${t}'`).join(',')})
`)
eq(tables.rows.length, 16, 'PGlite app.sql creates the counted public tables')
const uncovered = await db.query(uncoveredPublicTablesQuery())
eq(uncovered.rows.length, 0, 'PGlite public tables are covered or Better Auth excluded')
const badPk = await db.query(unexpectedPrimaryKeyQuery())
eq(badPk.rows.length, 0, 'PGlite covered tables have a single-column id primary key')

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

const TZ_HASH_SQL = `SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) AS h FROM tz_hash_probe t`
await db.exec(`CREATE TABLE tz_hash_probe (id int PRIMARY KEY, ts timestamptz NOT NULL)`)
await db.exec(`INSERT INTO tz_hash_probe VALUES (1, TIMESTAMPTZ '2026-01-15 12:00:00+00')`)
async function hashProbe(tz) {
  await db.exec(`SET TimeZone TO '${tz}'`)
  return String((await db.query(TZ_HASH_SQL)).rows[0]?.h || '')
}
let driftTz = 'America/New_York'
let drifted
try {
  drifted = await hashProbe(driftTz)
} catch {
  driftTz = '-05'
  drifted = await hashProbe(driftTz)
}
const unpinnedUtc = await hashProbe('UTC')
ok(
  drifted !== unpinnedUtc,
  `unpinned TimeZone=${driftTz} vs UTC hashes the same timestamptz differently (false mismatch)`,
)
await db.exec(checksumSessionSetSql())
const pinnedA = String((await db.query(TZ_HASH_SQL)).rows[0]?.h || '')
await db.exec(`SET TimeZone TO '${driftTz}'`)
await db.exec(checksumSessionSetSql())
const pinnedB = String((await db.query(TZ_HASH_SQL)).rows[0]?.h || '')
eq(pinnedA, pinnedB, 'checksum session pins make TimeZone drift hash the same (false mismatch gone)')
eq(pinnedA, unpinnedUtc, 'pinned TimeZone=UTC matches an explicit UTC hash')

const livePsqlUrl = checkPsqlUrl
const livePsql = livePsqlUrl
  ? spawnSync('psql', [
    '-d',
    livePsqlUrl,
    '-c',
    REQUIRED_COUNT_TABLES.map((t, i) => {
      const n = t === 'athlete' ? 3 : ['mcp_token', 'phase', 'program', 'routine', 'workout'].includes(t) ? 1 : 0
      return i === 0 ? `SELECT '${t}' AS t, ${n}::bigint AS n` : `UNION ALL SELECT '${t}', ${n}`
    }).join(' ') + ' ORDER BY 1;',
  ], {
    encoding: 'utf8',
    env: libpqCleanEnv({ PATH: process.env.PATH || '/usr/bin', HOME: process.env.HOME || '', LANG: 'C' }),
  })
  : { status: 1, stdout: '' }
if (livePsqlUrl && livePsql.status === 0 && livePsql.stdout) {
  const live = parseCounts(livePsql.stdout)
  eq(live.athlete, 3, 'parseCounts reads a live psql aligned session')
  requireCounts(live, 'live-psql')
} else {
  requireCounts(aligned, 'captured-psql-aligned')
  ok(PSQL_ALIGNED.startsWith('     t     | n'), 'captured fixture is real padded psql aligned output')
  ok(!livePsqlUrl || livePsql.status !== 0, 'pinned live psql uses ZEROED_CHECK_PSQL_URL only')
}

function pinnedPsql(url, sql, extraArgs = []) {
  const res = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-At', '-d', url, ...extraArgs, ...(sql ? ['-c', sql] : [])], {
    encoding: 'utf8',
    env: libpqCleanEnv({ PATH: process.env.PATH || '/usr/bin', HOME: process.env.HOME || '', LANG: 'C' }),
  })
  if (res.status !== 0) {
    throw new Error(redactSecrets((res.stderr || res.stdout || `psql ${res.status}`).trim()))
  }
  return res.stdout
}

function pinnedPsqlFile(url, filePath) {
  return pinnedPsql(url, '', ['-f', filePath])
}

function sourceResidue(url) {
  const schemas = pinnedPsql(url, `SELECT COUNT(*) FROM pg_namespace WHERE nspname = 'zeroed_cutover_guard'`)
  const locks = pinnedPsql(url, `SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory' AND granted`)
  return { schemas: Number(schemas.trim()), locks: Number(locks.trim()) }
}

{
  function spawnSafeUnit(code) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      cwd: root,
      env: libpqCleanEnv({ ...process.env, NODE_NO_WARNINGS: '1' }),
    })
  }
  const timerTok = 'rowtok-timer\\'
  const timerFail = spawnSafeUnit(`
    import { installSafeErrorHandlers } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    setTimeout(() => { throw new Error(${JSON.stringify(`ERROR:  boom ${timerTok}`)}); }, 0);
    await new Promise((r) => setTimeout(r, 250));
  `)
  const timerOut = `${timerFail.stdout || ''}\n${timerFail.stderr || ''}`
  ok(timerFail.status !== 0, 'uncaught timer exits non-zero')
  ok(timerOut.includes(GENERIC_SAFE_ERROR) || /omitted/.test(timerOut), 'uncaught timer is re-sanitized')
  ok(!timerOut.includes('rowtok-timer'), 'uncaught timer omits the value')

  const rejTok = 'rowtok-reject\\'
  const rejFail = spawnSafeUnit(`
    import { installSafeErrorHandlers } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    Promise.reject(new Error(${JSON.stringify(`ERROR:  boom ${rejTok}`)}));
    await new Promise((r) => setTimeout(r, 250));
  `)
  const rejOut = `${rejFail.stdout || ''}\n${rejFail.stderr || ''}`
  ok(rejFail.status !== 0, 'unhandledRejection exits non-zero')
  ok(rejOut.includes(GENERIC_SAFE_ERROR) || /omitted/.test(rejOut), 'unhandledRejection is re-sanitized')
  ok(!rejOut.includes('rowtok-reject'), 'unhandledRejection omits the value')
}

async function runLivePostgresChecks() {
  const targetUrl = process.env.ZEROED_PG_TARGET_URL || ''
  const aliasUrl = process.env.ZEROED_PG_ALIAS_URL || ''
  if (process.env.ZEROED_REQUIRE_PG === '1' && (!sourceUrl || !targetUrl || !aliasUrl)) {
    ok(false, 'ZEROED_REQUIRE_PG=1 needs ZEROED_PG_SOURCE_URL, ZEROED_PG_TARGET_URL, ZEROED_PG_ALIAS_URL')
    return
  }
  if (!sourceUrl || !targetUrl || !aliasUrl) {
    ok(true, 'live Postgres checks skipped (no ZEROED_PG_* URLs)')
    return
  }

  pinnedPsql(sourceUrl, `
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND query ILIKE '%advisory_lock%'
  `)
  pinnedPsqlFile(sourceUrl, join(root, 'worker/schema/app.sql'))
  pinnedPsqlFile(sourceUrl, join(root, 'worker/schema/better-auth.sql'))
  pinnedPsqlFile(sourceUrl, join(root, 'worker/schema/preview-seed.sql'))

  const tmpPg = mkdtempSync(join(tmpdir(), 'zeroed-migrate-pg-'))
  const mapPath = join(tmpPg, 'users.json')
  writeFileSync(mapPath, JSON.stringify([
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'preview.athlete@zeroed.invalid', created_at: '2026-01-15' },
  ]))

  const athletesBefore = Number(pinnedPsql(sourceUrl, 'SELECT COUNT(*) FROM public.athlete').trim())
  const nspBefore = pinnedPsql(sourceUrl, `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY 1`)

  const tzLive = pinnedPsql(sourceUrl, `
    CREATE TEMP TABLE tz_hash_probe (id int PRIMARY KEY, ts timestamptz NOT NULL);
    INSERT INTO tz_hash_probe VALUES (1, TIMESTAMPTZ '2026-01-15 12:00:00+00');
    SET TimeZone = 'America/New_York';
    SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) FROM tz_hash_probe t;
    SET TimeZone = 'UTC';
    SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) FROM tz_hash_probe t;
    ${checksumSessionSetSql()};
    SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) FROM tz_hash_probe t;
    SET TimeZone = 'America/New_York';
    ${checksumSessionSetSql()};
    SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) FROM tz_hash_probe t;
  `)
  const tzHashes = tzLive.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{32}$/i.test(s))
  eq(tzHashes.length, 4, 'live TimeZone probe returns four hashes')
  ok(tzHashes[0] !== tzHashes[1], 'live unpinned TimeZone=America/New_York vs UTC is a false mismatch')
  eq(tzHashes[2], tzHashes[3], 'live checksum session pins make TimeZone drift hash the same')
  eq(tzHashes[2], tzHashes[1], 'live pinned TimeZone=UTC matches an explicit UTC hash')

  function spawnSafeModule(code) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      cwd: root,
      env: libpqCleanEnv({ ...process.env, NODE_NO_WARNINGS: '1' }),
    })
  }
  function assertNoRowLeak(label, res) {
    const captured = `${res.stdout || ''}\n${res.stderr || ''}`
    ok(res.status !== 0, `${label} exits non-zero`)
    ok(/failed|ERROR|omitted|duplicate|decode/i.test(captured), `${label} logs a safe failure`)
    ok(!logLooksLikeRowData(captured), `${label} captured log is not row data`)
    ok(!captured.includes('phil@example.com'), `${label} omits phil@example.com`)
    ok(!captured.includes('Phil@Example.com'), `${label} omits Phil@Example.com`)
    ok(!/Failing row contains/i.test(captured), `${label} drops Failing row contains`)
    ok(!/^\s*DETAIL:/mi.test(captured), `${label} drops DETAIL`)
    ok(!/^\s*CONTEXT:/mi.test(captured), `${label} drops CONTEXT`)
    return captured
  }

  const errUrl = (() => {
    const u = new URL(sourceUrl)
    u.pathname = '/zeroed_err'
    return u.href
  })()
  pinnedPsql(sourceUrl, 'DROP DATABASE IF EXISTS zeroed_err')
  pinnedPsql(sourceUrl, 'CREATE DATABASE zeroed_err')
  pinnedPsql(errUrl, `
    CREATE TABLE auth_users_import (
      id TEXT, name TEXT, email TEXT CHECK (char_length(email) < 5),
      email_verified BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    )
  `)
  const copyCsv = join(tmpPg, 'bad_copy.csv')
  writeFileSync(copyCsv, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,Phil,phil@example.com,t,2020-01-01,2020-01-01\n')
  const copySql = `\\copy auth_users_import FROM '${copyCsv}' WITH CSV`
  const copyFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run("psql", ["-v", "ON_ERROR_STOP=1", "-d", ${JSON.stringify(errUrl)}, "-c", ${JSON.stringify(copySql)}]);
  `)
  assertNoRowLeak('COPY constraint failure', copyFail)

  pinnedPsql(errUrl, "CREATE TABLE uniq_t (email TEXT PRIMARY KEY); INSERT INTO uniq_t VALUES ('phil@example.com')")
  const uniqFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run("psql", ["-v", "ON_ERROR_STOP=1", "-d", ${JSON.stringify(errUrl)}, "-c", "INSERT INTO uniq_t VALUES ('phil@example.com')"]);
  `)
  assertNoRowLeak('unique violation', uniqFail)

  const invalidFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run("psql", ["-v", "ON_ERROR_STOP=1", "-d", ${JSON.stringify(errUrl)}, "-c", "SELECT 'phil@example.com'::uuid"]);
  `)
  assertNoRowLeak('invalid-input error', invalidFail)

  pinnedPsql(errUrl, "DROP TABLE IF EXISTS restore_t; CREATE TABLE restore_t (id int PRIMARY KEY, email text); INSERT INTO restore_t VALUES (1, 'phil@example.com')")
  const restoreDump = join(tmpPg, 'restore_fail.dump')
  const pgDump17 = existsSync('/usr/lib/postgresql/17/bin/pg_dump') ? '/usr/lib/postgresql/17/bin/pg_dump' : 'pg_dump'
  const pgRestore17 = existsSync('/usr/lib/postgresql/17/bin/pg_restore') ? '/usr/lib/postgresql/17/bin/pg_restore' : 'pg_restore'
  run(pgDump17, ['-Fc', '-t', 'restore_t', '-f', restoreDump, errUrl])
  pinnedPsql(errUrl, 'TRUNCATE restore_t; ALTER TABLE restore_t ADD CONSTRAINT restore_t_short CHECK (char_length(email) < 3)')
  const restoreFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run(${JSON.stringify(pgRestore17)}, ["--data-only", "--exit-on-error", "--dbname", ${JSON.stringify(errUrl)}, ${JSON.stringify(restoreDump)}]);
  `)
  assertNoRowLeak('pg_restore data-load failure', restoreFail)

  const raiseTok = 'rowtok-do-raise'
  pinnedPsql(errUrl, `
    CREATE OR REPLACE FUNCTION boom_raise() RETURNS void AS $$
    BEGIN
      RAISE EXCEPTION '${raiseTok}';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TABLE IF NOT EXISTS trig_t (id int, note text);
    CREATE OR REPLACE FUNCTION boom_trig() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '${raiseTok}-trig';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS boom_trig ON trig_t;
    CREATE TRIGGER boom_trig BEFORE INSERT ON trig_t FOR EACH ROW EXECUTE FUNCTION boom_trig();
  `)
  const plpgsqlFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run, psqlArgv } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run("psql", psqlArgv("-d", ${JSON.stringify(errUrl)}, "-c", "SELECT boom_raise()"));
  `)
  const plpgsqlOut = assertNoRowLeak('plpgsql RAISE', plpgsqlFail)
  ok(!plpgsqlOut.includes(raiseTok), 'plpgsql RAISE omits the exception text')

  const triggerFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run, psqlArgv } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run("psql", psqlArgv("-d", ${JSON.stringify(errUrl)}, "-c", "INSERT INTO trig_t VALUES (1, '${raiseTok}')"));
  `)
  const triggerOut = assertNoRowLeak('trigger RAISE', triggerFail)
  ok(!triggerOut.includes(raiseTok), 'trigger RAISE omits the exception text')

  const doFail = spawnSafeModule(`
    import { installSafeErrorHandlers, run, psqlArgv } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    run("psql", psqlArgv("-d", ${JSON.stringify(errUrl)}, "-c", "DO $$ BEGIN RAISE EXCEPTION '${raiseTok}-do'; END $$;"));
  `)
  const doOut = assertNoRowLeak('DO-block RAISE', doFail)
  ok(!doOut.includes(raiseTok), 'DO-block RAISE omits the exception text')

  let tuplesMsg = ''
  try {
    psqlTuples(errUrl, `DO $$ BEGIN RAISE EXCEPTION '${raiseTok}-tuples'; END $$;`)
  } catch (err) {
    tuplesMsg = err instanceof Error ? err.message : String(err)
  }
  ok(tuplesMsg === GENERIC_SAFE_ERROR, 'psqlTuples RAISE is generic')
  ok(!tuplesMsg.includes(raiseTok), 'psqlTuples RAISE omits the exception text')

  let snapMsg = ''
  try {
    await withSourceSnapshot(errUrl, async ({ client }) => {
      await client.query('SELECT $1::int AS n', ['rowtok-snap'])
    })
  } catch (err) {
    snapMsg = err instanceof Error ? err.message : String(err)
  }
  ok(!snapMsg.includes('rowtok-snap'), 'node-pg snapshot error omits the bound value')
  ok(/snapshot failed|omitted|SQLSTATE 22P02|data exception/.test(snapMsg), 'node-pg snapshot error is allowlisted')

  const timerTok = 'rowtok-timer\\'
  const timerFail = spawnSafeModule(`
    import { installSafeErrorHandlers } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    setTimeout(() => { throw new Error(${JSON.stringify(`ERROR:  boom ${timerTok}`)}); }, 0);
    await new Promise((r) => setTimeout(r, 250));
  `)
  const timerOut = assertNoRowLeak('uncaught timer', timerFail)
  ok(!timerOut.includes('rowtok-timer'), 'uncaught timer omits the value')

  const rejTok = 'rowtok-reject\\'
  const rejFail = spawnSafeModule(`
    import { installSafeErrorHandlers } from ${JSON.stringify(join(here, 'migrate-supabase-to-neon.mjs'))};
    installSafeErrorHandlers();
    Promise.reject(new Error(${JSON.stringify(`ERROR:  boom ${rejTok}`)}));
    await new Promise((r) => setTimeout(r, 250));
  `)
  const rejOut = assertNoRowLeak('unhandledRejection', rejFail)
  ok(!rejOut.includes('rowtok-reject'), 'unhandledRejection omits the value')

  const badMap = join(tmpPg, 'bad.json')
  writeFileSync(badMap, '{ "email": "phil@example.com",')
  const badMapRun = spawnMigrate(['--dry-run', '--skip-auth-users', '--auth-users-file', badMap], {
    SUPABASE_READONLY_URL: sourceUrl,
  })
  assertNoRowLeak('malformed auth-map JSON', badMapRun)

  const dryLive = spawnMigrate(['--dry-run', '--skip-auth-users', '--auth-users-file', mapPath], {
    SUPABASE_READONLY_URL: sourceUrl,
    NEON_DIRECT_URL: targetUrl,
  })
  const dryLiveOut = `${dryLive.stdout}\n${dryLive.stderr}`
  if (dryLive.status !== 0) console.error(redactSecrets(dryLiveOut))
  eq(dryLive.status, 0, 'connected dry-run exits 0 (source-only; empty Neon is ok)')
  ok(/source counts:/.test(dryLiveOut), 'connected dry-run prints source counts')
  ok(/workout:/.test(dryLiveOut), 'connected dry-run reports the workout count')
  ok(/pg_restore --list ok/.test(dryLiveOut), 'connected dry-run runs pg_restore --list sanity')
  ok(!/src_md5=/.test(dryLiveOut), 'connected dry-run does not print hashes')
  ok(!/postgresql:\/\//i.test(dryLiveOut), 'connected dry-run does not print a URL')
  eq(
    Number(pinnedPsql(sourceUrl, 'SELECT COUNT(*) FROM public.athlete').trim()),
    athletesBefore,
    'connected dry-run leaves source athlete rows unchanged',
  )

  const srcFp = readFingerprint(sourceUrl)
  const dstFp = readFingerprint(targetUrl)
  eq(refuseTargetFingerprintReason(dstFp, srcFp), '', 'different-server fingerprints are allowed')
  eq(await checkSourceLockAbsentOnTarget(sourceUrl, targetUrl), '', 'different-server advisory lock is not visible')
  releaseHeldAdvisoryLocks()

  const proceed = spawnMigrate([
    '--skip-auth-users',
    `--confirm-drop=${postgresUrlParts(targetUrl).dbname}`,
    '--auth-users-file',
    mapPath,
  ], {
    SUPABASE_READONLY_URL: sourceUrl,
    NEON_DIRECT_URL: targetUrl,
  })
  const proceedOut = `${proceed.stdout}\n${proceed.stderr}`
  if (proceed.status !== 0) console.error(redactSecrets(proceedOut))
  eq(proceed.status, 0, 'different server live restore proceeds')
  ok(/migration ok/.test(proceedOut), 'different server prints migration ok')
  ok(/workout: source=/.test(proceedOut), 'live restore reports workout counts')
  ok(!/src_md5=/.test(proceedOut), 'live restore does not print hashes')
  eq(
    Number(pinnedPsql(sourceUrl, 'SELECT COUNT(*) FROM public.athlete').trim()),
    athletesBefore,
    'different-server restore leaves source athlete rows unchanged',
  )

  const dryAfter = spawnMigrate(['--dry-run', '--skip-auth-users', '--auth-users-file', mapPath], {
    SUPABASE_READONLY_URL: sourceUrl,
    NEON_DIRECT_URL: targetUrl,
  })
  const dryAfterOut = `${dryAfter.stdout}\n${dryAfter.stderr}`
  if (dryAfter.status !== 0) console.error(redactSecrets(dryAfterOut))
  eq(dryAfter.status, 0, 'connected dry-run still exits 0 after a live restore')
  ok(/source-only succeeded/.test(dryAfterOut), 'post-restore dry-run stays source-only')

  // Invalid month/day/time plus a trailing backslash — a near-ISO value
  // (2026-01-15T00:00:00\) can be accepted by timestamptz input.
  const slashCreated = '2026-13-40T99:99:99\\'
  const slashMap = join(tmpPg, 'slash.json')
  writeFileSync(slashMap, JSON.stringify([
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'preview.athlete@zeroed.invalid', created_at: slashCreated },
  ]))
  const slashRun = spawnMigrate([
    '--skip-auth-users',
    `--confirm-drop=${postgresUrlParts(targetUrl).dbname}`,
    '--auth-users-file',
    slashMap,
  ], {
    SUPABASE_READONLY_URL: sourceUrl,
    NEON_DIRECT_URL: targetUrl,
  })
  const slashOut = `${slashRun.stdout}\n${slashRun.stderr}`
  ok(slashRun.status !== 0, 'main restore with created_at trailing backslash fails')
  ok(!slashOut.includes(slashCreated), 'main restore omits created_at trailing backslash')
  ok(!slashOut.includes('2026-13-40T99:99:99\\'), 'main restore omits the backslash timestamp')
  ok(!logLooksLikeRowData(slashOut), 'main restore log is not row data')
  ok(/failed|omitted|SQLSTATE|command/i.test(slashOut), 'main restore logs a safe failure')

  const hostRun = spawnMigrate(['--dry-run', '--skip-auth-users', '--auth-users-file', mapPath], {
    SUPABASE_READONLY_URL: `${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}host=evil.example`,
  })
  const hostOut = `${hostRun.stdout}\n${hostRun.stderr}`
  eq(hostRun.status, 2, 'main refuses source ?host= override')
  ok(/host=/.test(hostOut), 'main host= refuse mentions host=')
  ok(!/evil\.example/.test(hostOut), 'main host= refuse omits the override host')

  const alias = spawnMigrate([
    '--skip-auth-users',
    `--confirm-drop=${postgresUrlParts(aliasUrl).dbname}`,
    '--auth-users-file',
    mapPath,
  ], {
    SUPABASE_READONLY_URL: sourceUrl,
    NEON_DIRECT_URL: aliasUrl,
  })
  const aliasOut = `${alias.stdout}\n${alias.stderr}`
  eq(alias.status, 2, 'same server via alias exits 2')
  ok(!/resetting/i.test(aliasOut), 'same-server alias does not reset')
  eq((aliasOut.match(/DROP SCHEMA/gi) || []).length, 0, 'same-server alias emits 0 DROPs')
  eq(
    Number(pinnedPsql(sourceUrl, 'SELECT COUNT(*) FROM public.athlete').trim()),
    athletesBefore,
    'same-server alias leaves source athlete rows unchanged',
  )

  const errored = spawnMigrate([
    '--skip-auth-users',
    `--confirm-drop=${postgresUrlParts(targetUrl).dbname}`,
    '--auth-users-file',
    mapPath,
  ], {
    SUPABASE_READONLY_URL: sourceUrl.replace(/\/[^/]+$/, '/no_such_db'),
    NEON_DIRECT_URL: targetUrl,
  })
  eq(errored.status, 2, 'errored fingerprint exits 2')
  ok(
    /could not read source fingerprint/.test(`${errored.stdout}\n${errored.stderr}`),
    'errored fingerprint says the source could not be read',
  )
  ok(!/resetting/i.test(`${errored.stdout}\n${errored.stderr}`), 'errored fingerprint does not reset')

  pinnedPsql(sourceUrl, `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'src_ro') THEN
        CREATE ROLE src_ro LOGIN PASSWORD 'dummy';
      END IF;
    END $$;
    GRANT CONNECT ON DATABASE ${postgresUrlParts(sourceUrl).dbname} TO src_ro;
    GRANT USAGE ON SCHEMA public TO src_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO src_ro;
    REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION pg_control_system() FROM src_ro;
  `)
  const roUrl = sourceUrl.replace(/\/\/[^@]+@/, '//src_ro:dummy@')
  const roFp = readFingerprint(roUrl)
  eq(roFp.sysid, '', 'revoked pg_control_system leaves sysid empty')
  eq(refuseTargetFingerprintReason(dstFp, roFp), '', 'no pg_control_system privilege still allows a different server')
  eq(await checkSourceLockAbsentOnTarget(roUrl, targetUrl), '', 'no pg_control_system privilege still passes the lock check')
  releaseHeldAdvisoryLocks()

  const sig = spawn(process.execPath, [
    'scripts/migrate-supabase-to-neon.mjs',
    '--skip-auth-users',
    `--confirm-drop=${postgresUrlParts(targetUrl).dbname}`,
    '--auth-users-file',
    mapPath,
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '/usr/bin',
      HOME: process.env.HOME || '',
      SUPABASE_READONLY_URL: sourceUrl,
      NEON_DIRECT_URL: targetUrl,
      ZEROED_TEST_HOLD_LOCK_MS: '12000',
    },
  })
  let sigOut = ''
  sig.stdout.on('data', (c) => { sigOut += c })
  sig.stderr.on('data', (c) => { sigOut += c })
  const started = Date.now()
  while (!/probing target identity/.test(sigOut) && Date.now() - started < 15000) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await new Promise((r) => setTimeout(r, 1500))
  ok(/probing target identity/.test(sigOut), 'SIGINT test reached the identity probe')
  sig.kill('SIGINT')
  const sigCode = await new Promise((resolve) => sig.on('close', resolve))
  ok(sigCode === 130 || sigCode === 2, `SIGINT exits 130 (got ${sigCode})`)
  const afterSig = sourceResidue(sourceUrl)
  eq(afterSig.schemas, 0, 'SIGINT leaves no zeroed_cutover_guard schema')
  eq(afterSig.locks, 0, 'SIGINT leaves no advisory lock residue')

  const after = sourceResidue(sourceUrl)
  eq(after.schemas, 0, 'source has no zeroed_cutover_guard schema afterward')
  eq(after.locks, 0, 'source has no advisory lock residue afterward')
  eq(
    pinnedPsql(sourceUrl, `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY 1`),
    nspBefore,
    'source namespaces are unchanged afterward',
  )
  rmSync(tmpPg, { recursive: true, force: true })
}

await runLivePostgresChecks()

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} migrate checks failed:`)
  for (const f of fails) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✓ all ${checks} migrate / neon-schema checks passed`)
