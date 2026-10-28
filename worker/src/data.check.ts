// Run: node --experimental-strip-types worker/src/data.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSignature } from 'better-auth/crypto'
import { serializeSignedCookie } from 'better-call'
import {
  BETTER_AUTH_SNAKE_CASE,
  FIND_ADOPTED_USER_SQL,
  FIND_MIXED_CASE_USER_SQL,
  PERSIST_ADOPTED_EMAIL_SQL,
  authFailureMessage,
  persistAdoptedUserEmail,
  rewriteUserEmailLookup,
  shouldPersistAdoptedEmail,
  stripSessionToken,
} from './auth.ts'
import {
  CHECKSUM_TABLES,
  assertCountsMatch,
  assertNoBlankEmails,
  assertNoEmailDupes,
  assertSourceUsersReady,
  filterRestoreToc,
  findBlankEmails,
  findCaseInsensitiveEmailDupes,
  formatBlankEmailAbort,
  formatSourceUsersAbort,
  migrateAuthUsers,
  parseCounts,
} from '../../scripts/migrate-users.lib.mjs'
import {
  bindOwner,
  executeDataQuery,
  ownerPredicate,
  parseSelectList,
  SESSION_LOOKUP_SQL,
  safeClientMessage,
  sessionTokenFromRequest,
  signSessionToken,
  unsignedSessionToken,
  verifySessionSignature,
} from './data.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const items = parseSelectList('performed_at, rpe, actual_weights, routine!inner(program_id)')
ok(items.some((i) => i.kind === 'col' && i.name === 'performed_at'), 'parse: root columns')
ok(items.some((i) => i.kind === 'embed' && i.alias === 'routine' && i.inner), 'parse: routine!inner embed')

const nested = parseSelectList('severity, workout!inner(routine!inner(program_id))')
const workout = nested.find((i) => i.kind === 'embed')
ok(workout?.kind === 'embed' && workout.items.some((i) => i.kind === 'embed'), 'parse: nested workout.routine embed')

const hinted = parseSelectList('*, program:program_id(athlete_id)')
ok(hinted.some((i) => i.kind === 'star'), 'parse: star plus fk hint')
ok(hinted.some((i) => i.kind === 'embed' && i.fkHint && i.alias === 'program'), 'parse: program:program_id hint')

ok(ownerPredicate('athlete').includes('id = ${athleteId}'), 'owner: athlete self id')
ok(ownerPredicate('insight') === 'athlete_id = ${athleteId}', 'owner: insight athlete_id')
ok(ownerPredicate('phase').includes('athlete_id = ${athleteId}'), 'owner: phase via program')
ok(ownerPredicate('workout').includes('p.athlete_id = ${athleteId}'), 'owner: workout via program join')
ok(ownerPredicate('session_observation').includes('p.athlete_id = ${athleteId}'), 'owner: observation via workout join')

const bound = bindOwner('insight', '11111111-1111-1111-1111-111111111111', 3)
ok(bound.text === 'athlete_id = $3', 'bindOwner: $n replacement')
ok(bound.params[0] === '11111111-1111-1111-1111-111111111111', 'bindOwner: athlete id param')
const qualified = bindOwner('phase', '11111111-1111-1111-1111-111111111111', 1, 'phase')
ok(qualified.text.startsWith('phase.program_id IN'), 'bindOwner: qualify program_id for joins')
ok(unsignedSessionToken('tok.signature') === 'tok', 'cookie token strips Better Auth signature')
ok(unsignedSessionToken('tok') === 'tok', 'token without a signature stays the token')
ok(unsignedSessionToken('tok%2Esig') === 'tok', 'url-encoded cookie signature is stripped')
ok(SESSION_LOOKUP_SQL.includes('s.user_id') && SESSION_LOOKUP_SQL.includes('s.expires_at'), 'session SQL matches better-auth.sql')
ok(!SESSION_LOOKUP_SQL.includes('"userId"') && !SESSION_LOOKUP_SQL.includes('"expiresAt"'), 'session SQL is not camelCase')
ok(safeClientMessage(new Error('column xmin does not exist')) === 'request failed', 'raw DB errors are generic')
ok(safeClientMessage(new Error('unknown column routine.xmin')) === 'unknown column routine.xmin', 'allowlist errors stay specific')

ok(BETTER_AUTH_SNAKE_CASE.user.fields.emailVerified === 'email_verified', 'auth map: user.emailVerified')
ok(BETTER_AUTH_SNAKE_CASE.session.fields.userId === 'user_id', 'auth map: session.userId')
ok(BETTER_AUTH_SNAKE_CASE.session.fields.expiresAt === 'expires_at', 'auth map: session.expiresAt')
ok(BETTER_AUTH_SNAKE_CASE.account.fields.userId === 'user_id', 'auth map: account.userId')
ok(BETTER_AUTH_SNAKE_CASE.account.fields.accountId === 'account_id', 'auth map: account.accountId')
ok(BETTER_AUTH_SNAKE_CASE.verification.fields.expiresAt === 'expires_at', 'auth map: verification.expiresAt')

const here = dirname(fileURLToPath(import.meta.url))
const authSrc = readFileSync(join(here, 'auth.ts'), 'utf8')
ok(authSrc.includes('user: BETTER_AUTH_SNAKE_CASE.user'), 'auth.ts applies user snake_case map')
ok(authSrc.includes('session: BETTER_AUTH_SNAKE_CASE.session'), 'auth.ts applies session snake_case map')
ok(authSrc.includes('account: BETTER_AUTH_SNAKE_CASE.account'), 'auth.ts applies account snake_case map')
ok(authSrc.includes('verification: BETTER_AUTH_SNAKE_CASE.verification'), 'auth.ts applies verification snake_case map')
ok(authSrc.includes('bearer({ requireSignature: true })'), 'auth.ts requires signed bearers')
ok(!authSrc.includes('allowExitOnIdle'), 'auth.ts does not use pg-pool allowExitOnIdle')
ok(authSrc.includes('installEmailAdoption'), 'auth.ts installs case-insensitive email adoption')
ok(authSrc.includes('persistAdoptedUserEmail'), 'auth.ts persists the BA user id after verified sign-in')
ok(authSrc.includes('shouldPersistAdoptedEmail'), 'auth.ts does not persist on unauthenticated send-code')
ok(
  authSrc.indexOf('emailFromAuthRequest(req)') < authSrc.indexOf('fn(createAuth'),
  'email is cloned before auth.handler consumes the body',
)
ok(authSrc.includes('FIND_ADOPTED_USER_SQL'), 'auth.ts looks up the persisted BA user id first')
ok(rewriteUserEmailLookup('select * from "user" where "email" = $1') === 'select * from "user" where lower("email") = lower($1)', 'adoption lookup uses lower(email)')
ok(
  rewriteUserEmailLookup('select "primary".* from (select * from "user" where "user"."email" = $1) as "primary"')
    === 'select "primary".* from (select * from "user" where lower("user"."email") = lower($1)) as "primary"',
  'Better Auth 1.7 qualified "user"."email" is wrapped in lower()',
)
ok(
  !rewriteUserEmailLookup('select * from "user" where "user"."email" = $1').includes('"user".lower'),
  'qualified rewrite does not produce schema "user".lower',
)
ok(rewriteUserEmailLookup('select * from session where token = $1') === 'select * from session where token = $1', 'adoption rewrite leaves session SQL alone')
const updateEmailSql = 'update "user" set "email" = $1 where id = $2'
ok(rewriteUserEmailLookup(updateEmailSql) === updateEmailSql, 'email rewrite does not break UPDATE email SQL')
ok(
  rewriteUserEmailLookup('UPDATE "user" SET "email" = $1 WHERE "email" = $2') === 'UPDATE "user" SET "email" = $1 WHERE "email" = $2',
  'email rewrite skips UPDATE even when WHERE mentions email',
)
const stripped = stripSessionToken({
  token: 'raw-top-level',
  session: { id: 's', token: 'raw-db-token', userId: 'u' },
  user: { id: 'u' },
}) as { token?: string; session: { token?: string }; user: { id: string } }
ok(stripped.user.id === 'u' && stripped.session.token === undefined, 'get-session body strips session.token')
ok(stripped.token === undefined, 'sign-in body strips the top-level raw token')
ok(
  shouldPersistAdoptedEmail(
    new Request('http://localhost/api/auth/sign-in/email-otp', { method: 'POST' }),
    new Response('{}', { status: 200 }),
  ),
  'verified sign-in may persist lowercase email',
)
ok(
  !shouldPersistAdoptedEmail(
    new Request('http://localhost/api/auth/email-otp/send-verification-otp', { method: 'POST' }),
    new Response('{}', { status: 200 }),
  ),
  'send-code does not persist lowercase email',
)
ok(
  !shouldPersistAdoptedEmail(
    new Request('http://localhost/api/auth/sign-in/email-otp', { method: 'POST' }),
    new Response('{}', { status: 401 }),
  ),
  'failed sign-in does not persist lowercase email',
)
ok(authFailureMessage(new Error('The server does not support SSL connections')) === 'request failed', 'ssl errors stay generic')
ok(authFailureMessage(new Error('BETTER_AUTH_SECRET is not set')) === 'BETTER_AUTH_SECRET is not set', 'auth config errors stay specific')

const persistCalls: string[] = []
const exactId = await persistAdoptedUserEmail(async (text) => {
  persistCalls.push(text)
  if (text === FIND_ADOPTED_USER_SQL) return { rows: [{ id: 'persisted-ba-id' }] }
  return { rows: [] }
}, 'Phil@Example.com')
ok(exactId === 'persisted-ba-id', 'adoption looks up the persisted BA user id first')
ok(persistCalls[0] === FIND_ADOPTED_USER_SQL, 'exact lowercase email is queried first')
ok(!persistCalls.includes(PERSIST_ADOPTED_EMAIL_SQL), 'exact hit does not rewrite the row')

const mixedCalls: string[] = []
const mixedId = await persistAdoptedUserEmail(async (text, params) => {
  mixedCalls.push(text)
  if (text === FIND_ADOPTED_USER_SQL) return { rows: [] }
  if (text === FIND_MIXED_CASE_USER_SQL) return { rows: [{ id: 'migrated-id' }] }
  if (text === PERSIST_ADOPTED_EMAIL_SQL) {
    ok(params[0] === 'migrated-id', 'persist writes lowercase email onto the BA user id row')
    return { rows: [] }
  }
  return { rows: [] }
}, 'phillip@example.com')
ok(mixedId === 'migrated-id', 'mixed-case email adopts the existing BA user id')
ok(mixedCalls.includes(PERSIST_ADOPTED_EMAIL_SQL), 'first-time adoption persists lowercase email')

const dupeUsers = [
  { id: 'id-dup', email: 'dup@example.com' },
  { id: 'id-DUP', email: 'DUP@example.com' },
]
const dupeGroups = findCaseInsensitiveEmailDupes(dupeUsers)
ok(dupeGroups.length === 1 && dupeGroups[0].rows.length === 2, 'lower(email) groups source dupes')
try {
  assertNoEmailDupes(dupeUsers)
  ok(false, 'assertNoEmailDupes must abort on dup@ / DUP@')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(msg.includes('id-dup') && msg.includes('id-DUP'), 'dupe abort lists ids')
  ok(msg.includes('dup@example.com') && msg.includes('DUP@example.com'), 'dupe abort lists emails')
  ok(msg.includes('wrote nothing'), 'dupe abort says it wrote nothing')
}
ok(formatSourceUsersAbort({ blanks: [], dupes: dupeGroups }).includes('wrote nothing'), 'dupe abort formatter is explicit')
let migrateWrites = 0
try {
  await migrateAuthUsers(async () => {
    migrateWrites += 1
    return { rows: [] }
  }, dupeUsers)
  ok(false, 'migrateAuthUsers must abort before writing')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(!/must abort before writing/.test(msg), 'migrateAuthUsers aborted on source dupes')
}
ok(migrateWrites === 0, 'source dupe pre-check writes nothing')

const blankUsers = [
  { id: 'id-null', email: null },
  { id: 'id-empty', email: '' },
  { id: 'id-ws', email: '  \t' },
]
ok(findBlankEmails(blankUsers).length === 3, 'pre-check finds null, empty, and whitespace emails')
try {
  assertNoBlankEmails(blankUsers)
  ok(false, 'assertNoBlankEmails must abort on null/empty/whitespace')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(msg.includes('id-null') && msg.includes('id-empty') && msg.includes('id-ws'), 'blank abort lists ids')
  ok(msg.includes('wrote nothing'), 'blank abort says it wrote nothing')
}
ok(formatBlankEmailAbort(blankUsers).includes('id-null'), 'blank abort formatter lists ids')
try {
  assertSourceUsersReady([{ id: 'ok', email: 'ok@example.com' }, { id: 'id-null', email: null }])
  ok(false, 'assertSourceUsersReady must abort on a null email')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(!/must abort on a null/.test(msg), 'assertSourceUsersReady aborted on a null email')
  ok(msg.includes('id-null'), 'source ready abort lists the blank id')
}
let blankWrites = 0
try {
  await migrateAuthUsers(async () => {
    blankWrites += 1
    return { rows: [] }
  }, blankUsers)
  ok(false, 'migrateAuthUsers must abort before writing blank emails')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(!/must abort before writing blank/.test(msg), 'migrateAuthUsers aborted on blank emails')
}
ok(blankWrites === 0, 'blank email pre-check writes nothing')

try {
  assertSourceUsersReady([...dupeUsers, ...blankUsers])
  ok(false, 'assertSourceUsersReady must report blanks and dupes together')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(!/must report blanks/.test(msg), 'mixed source abort threw')
  ok(msg.includes('id-dup') && msg.includes('id-null'), 'mixed abort lists dupe and blank ids')
  ok(msg.includes('blank source emails') && msg.includes('case-insensitive email duplicates'), 'mixed abort lists both checks')
}

const spaced = parseCounts(' athlete   |     2\n program    |     0\n')
ok(spaced.athlete === 2 && spaced.program === 0, 'parseCounts reads leading-space psql output')
ok(parseCounts('athlete|2\ninsight|3').insight === 3, 'parseCounts reads psql -tA output')
try {
  assertCountsMatch({}, { athlete: 1 }, ['athlete'])
  ok(false, 'assertCountsMatch must fail when a count is missing')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(msg.includes('missing or unparsable'), 'missing count is a hard fail')
}
try {
  assertCountsMatch({ athlete: 2 }, { athlete: 0 }, ['athlete'])
  ok(false, 'assertCountsMatch must fail on a mismatch')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  ok(msg.includes('source=2') && msg.includes('target=0'), 'mismatch lists both counts')
}

const schemaSql = readFileSync(join(here, '../schema/better-auth.sql'), 'utf8')
ok(schemaSql.includes('email_verified') && schemaSql.includes('user_id') && schemaSql.includes('expires_at'), 'better-auth.sql is snake_case')
ok(!schemaSql.includes('emailVerified') && !schemaSql.includes('"userId"'), 'better-auth.sql is not camelCase')
ok(schemaSql.includes('user_email_lower_uidx') && schemaSql.includes('lower(email)'), 'better-auth.sql has case-insensitive email uniqueness')
ok(schemaSql.includes('cannot create unique index user_email_lower_uidx'), 'better-auth.sql index migration names existing dupes')
const migrateSrc = readFileSync(join(here, '../../scripts/migrate-supabase-to-neon.mjs'), 'utf8')
ok(migrateSrc.includes('refuseSourceWipeReason'), 'migrate refuses source-wipe aliases before a write')
ok(migrateSrc.includes('confirmDropMismatchReason'), 'migrate requires --confirm-drop on a live run')
ok(migrateSrc.includes('wrapRestoreTransaction'), 'migrate restores users + data in one transaction')
ok(migrateSrc.includes('DROP SCHEMA IF EXISTS public CASCADE'), 'migrate drops public so a rerun starts empty')
ok(migrateSrc.includes('missingMappedAuthUserIds'), 'migrate matches auth mappings by id, not counts')
ok(migrateSrc.includes('pg_export_snapshot'), 'migrate dumps under pg_export_snapshot')
ok(migrateSrc.includes('--snapshot='), 'migrate passes --snapshot to pg_dump')
ok(migrateSrc.includes('to_jsonb(t)'), 'migrate hashes row content as to_jsonb')
ok(migrateSrc.includes('uncoveredPublicTablesQuery'), 'migrate refuses uncovered public tables')
ok(migrateSrc.includes('source-only succeeded'), 'dry-run is source-only')
ok(migrateSrc.includes('sourcePgClientConfig'), 'source pg clients use sourcePgClientConfig')
ok(!/ssl:\s*\{[^}]*rejectUnauthorized:\s*false/.test(migrateSrc), 'migrate never sets rejectUnauthorized: false')
ok(!/uselibpqcompat\s*[:=]/.test(migrateSrc), 'migrate does not enable uselibpqcompat')
ok(migrateSrc.includes('isForbiddenSourceUrlParam'), 'migrate refuses ssl* and uselibpqcompat URL params')
ok(migrateSrc.includes('prod-ca-2021'), 'migrate references the committed Supabase CA')
ok(migrateSrc.includes('READ ONLY'), 'snapshot transaction is READ ONLY')
ok(migrateSrc.includes('PGSSLMODE') && migrateSrc.includes('PGSSLROOTCERT'), 'source libpq uses PGSSLMODE/PGSSLROOTCERT')
ok(migrateSrc.includes('formatSafeCommandError'), 'migrate sanitizes subprocess errors')
ok(migrateSrc.includes('checksumPgOptions') && migrateSrc.includes('PGOPTIONS'), 'psqlTuples pins checksum GUCs via PGOPTIONS')
ok(migrateSrc.includes("SET TimeZone = 'UTC'"), 'snapshot client pins TimeZone=UTC')
ok(migrateSrc.includes('refuseTransactionPoolerReason'), 'migrate refuses a transaction-pooler source')
ok(migrateSrc.includes('idle_in_transaction_session_timeout = 0'), 'snapshot session clears idle-in-transaction timeout')
ok(migrateSrc.includes('skip-auth-users'), 'migrate can skip auth.users and use a provided mapping')
ok(migrateSrc.includes('ON_ERROR_STOP'), 'migrate psql is not error-tolerant')
ok(migrateSrc.includes("'-At'"), 'migrate tuples use psql -At')
ok(migrateSrc.includes('refuseTargetFingerprintReason'), 'migrate fingerprints source and target before DROP')
ok(migrateSrc.includes('checkSourceLockAbsentOnTarget'), 'migrate proves source and target differ with an advisory lock')
ok(
  migrateSrc.indexOf('refuseSourceWipeReason') < migrateSrc.indexOf('resetting Neon'),
  'wipe refuse runs before DROP',
)
ok(
  migrateSrc.indexOf('probing target identity before drop') < migrateSrc.indexOf('DROP SCHEMA IF EXISTS public CASCADE'),
  'fingerprint probe runs before DROP',
)
ok(CHECKSUM_TABLES.length === 16, 'checksum covers all 16 public tables')
ok(CHECKSUM_TABLES.includes('coach_message') && CHECKSUM_TABLES.includes('weekly_review'), 'checksum includes coach_message and weekly_review')
const toc = '1; 3079 1 EXTENSION - pgcrypto\n2; 1259 2 TABLE public athlete\n'
ok(!filterRestoreToc(toc).includes('EXTENSION') && filterRestoreToc(toc).includes('TABLE public athlete'), 'restore TOC drops EXTENSION')
const migrateLib = readFileSync(join(here, '../../scripts/migrate-users.lib.mjs'), 'utf8')
ok(migrateLib.includes('email_verified BOOLEAN') && migrateLib.includes('user_id TEXT'), 'migrate lib Better Auth SQL is snake_case')
ok(migrateLib.includes('user_email_lower_uidx'), 'migrate lib adds case-insensitive email uniqueness')
ok(migrateLib.includes('lower(email)'), 'migrate lib lowercases adopted emails')
ok(migrateLib.includes('BEGIN'), 'migrate lib wraps the user load in a transaction')
ok(!migrateLib.includes('pg_tables'), 'cleanup does not walk every public table')
ok(migrateLib.includes('dropCreatedSql'), 'cleanup lists only objects this run created')
ok(migrateLib.includes('DROP EXTENSION'), 'cleanup can drop an extension this run created')
ok(migrateLib.includes('typtype'), 'empty-target check treats public enums/types as dirty')
ok(migrateLib.includes('objectHash'), 'cleanup proves the object hash is unchanged')
ok(migrateLib.includes('auth.uid()'), 'auth stub includes auth.uid() for a fresh restore')
const corsSrc = readFileSync(join(here, 'cors.ts'), 'utf8')
ok(corsSrc.includes("'Access-Control-Expose-Headers': 'set-auth-token'"), 'CORS exposes set-auth-token')
const dataSrc = readFileSync(join(here, 'data.ts'), 'utf8')
ok(!dataSrc.includes('requireSignature: false'), 'data.ts has no unsigned-bearer fallback')
ok(dataSrc.includes("op === 'in' ? 'FALSE' : 'TRUE'"), 'empty in[] short-circuits to FALSE')
ok(dataSrc.includes("from 'better-auth/crypto'"), 'session HMAC reuses better-auth/crypto')
ok(dataSrc.includes('STANDARD_PADDED_HMAC') && dataSrc.includes('atob(signature)'), 'session HMAC verifies standard padded base64')
ok(!dataSrc.includes('bytesToBase64UrlNoPad'), 'session HMAC does not use unpadded url-safe encoding')
const workflow = readFileSync(join(here, '../../.github/workflows/checks.yml'), 'utf8')
ok(workflow.includes('postgres:17'), 'CI postgres/isolation services are 17')
ok(
  /migrate-pg:[\s\S]*postgres:17/.test(workflow) && /migrate-pg:[\s\S]*docker run/.test(workflow),
  'migrate-pg uses Postgres 17 so the dump path matches Supabase',
)
ok(/migrate-pg:[\s\S]*postgresql-client-17/.test(workflow), 'migrate-pg installs postgresql-client-17 from PGDG')
ok(workflow.includes('/usr/lib/postgresql/17/bin'), 'CI puts the Postgres 17 client first on PATH')
const migrateWf = readFileSync(join(here, '../../.github/workflows/migrate-supabase-to-neon.yml'), 'utf8')
ok(migrateWf.includes('postgresql-client-17'), 'manual migrate installs postgresql-client-17')
ok(migrateWf.includes('apt.postgresql.org'), 'manual migrate uses the PGDG apt repo')
ok(migrateWf.includes('B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'), 'manual migrate pins the PGDG signing key')
ok(migrateWf.includes('server_version_num'), 'manual migrate matches client major to the source server')
ok(
  migrateWf.includes('PGSERVICEFILE=/dev/null') && migrateWf.includes("PGOPTIONS='-c default_transaction_read_only=on'"),
  'manual migrate version probe uses a clean read-only libpq env',
)
ok(
  workflow.includes("PGSERVICEFILE=/dev/null PGOPTIONS='-c default_transaction_read_only=on' psql"),
  'migrate-pg version probe uses a clean read-only libpq env',
)
ok(migrateWf.includes('PGPASSFILE=/dev/null'), 'manual migrate version probe nulls PGPASSFILE')
ok(workflow.includes('PGPASSFILE=/dev/null'), 'migrate-pg version probe nulls PGPASSFILE')
ok(migrateWf.includes('PGSSLMODE=verify-full') && migrateWf.includes('PGSSLROOTCERT'), 'manual migrate version probe sets verify-full + pinned CA')
ok(workflow.includes('-u PGSSLMODE') && workflow.includes('-u PGHOSTADDR'), 'migrate-pg version probe unsets PGSSLMODE and PGHOSTADDR')
ok(migrateWf.includes('GITHUB_PATH'), 'manual migrate puts the matching client first on PATH')

const secret = 's'.repeat(32)
const official = await makeSignature('tok', secret)
const signed = await signSessionToken('tok', secret)
const signature = signed.slice(signed.indexOf('.') + 1)
ok(signed === `tok.${official}`, 'signSessionToken matches better-auth makeSignature')
ok(/^[A-Za-z0-9+/]+={1,2}$/.test(official), 'Better Auth HMAC is standard padded base64')
ok(signature.length > 10, 'signSessionToken writes an HMAC')
ok(await verifySessionSignature('tok', official, secret), 'Better Auth makeSignature verifies')
ok(await verifySessionSignature('tok', signature, secret), 'valid cookie HMAC is accepted')
ok(!(await verifySessionSignature('tok', 'not-the-real-signature', secret)), 'tampered cookie HMAC is rejected')
ok(!(await verifySessionSignature('tok', null, secret)), 'unsigned token is rejected')
const urlSafe = official.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
ok(urlSafe !== official, 'base64url-nopad differs from the Better Auth signature')
ok(!(await verifySessionSignature('tok', urlSafe, secret)), 'base64url-nopad HMAC is rejected')

const cookieReq = new Request('http://local/api/data', {
  headers: { cookie: `better-auth.session_token=${signed}` },
})
ok(await sessionTokenFromRequest(cookieReq, secret) === 'tok', 'signed cookie authenticates')
const badCookie = new Request('http://local/api/data', {
  headers: { cookie: 'better-auth.session_token=tok.not-the-real-signature' },
})
ok(await sessionTokenFromRequest(badCookie, secret) === null, 'tampered cookie is rejected')
const rawBearer = new Request('http://local/api/data', {
  headers: { authorization: 'Bearer tok' },
})
ok(await sessionTokenFromRequest(rawBearer, secret) === null, 'raw DB bearer is rejected')
const signedBearer = new Request('http://local/api/data', {
  headers: { authorization: `Bearer ${signed}` },
})
ok(await sessionTokenFromRequest(signedBearer, secret) === 'tok', 'signed bearer authenticates')
const encodedBearer = new Request('http://local/api/data', {
  headers: { authorization: `Bearer ${encodeURIComponent(signed)}` },
})
ok(await sessionTokenFromRequest(encodedBearer, secret) === 'tok', 'url-encoded signed bearer authenticates')
const baCookie = await serializeSignedCookie('better-auth.session_token', 'tok', secret)
ok(await sessionTokenFromRequest(new Request('http://local/api/data', {
  headers: { cookie: baCookie.split(';')[0] ?? baCookie },
}), secret) === 'tok', 'better-call signed cookie authenticates')

const authClientSrc = readFileSync(join(here, '../../src/lib/authClient.ts'), 'utf8')
ok(authClientSrc.includes("res.headers.get('set-auth-token')"), 'auth client captures set-auth-token')
ok(authClientSrc.includes("if (!token || !token.includes('.'))"), 'auth client refuses unsigned bearers')
ok(!/return data\?\.session\?\.token/.test(authClientSrc), 'auth client does not send the raw session token')
ok(authClientSrc.includes('return persistedSignedBearer()'), 'auth client sends the persisted signed bearer')

// The loop reticle names trigger-kept insight columns on every loop load. Run its
// exact select through the allow-list (stub sql, no DB) so an unregistered column
// fails here instead of as a 400 on Profile/Today.
const reticleSrc = readFileSync(join(here, '../../src/components/convergence/MonitorReticle.tsx'), 'utf8')
const reticleColumns = /from\('insight'\)\s*\.select\('([^']+)'\)/.exec(reticleSrc)?.[1]
ok(reticleColumns?.includes('prev_status') === true, 'reticle select found and names prev_status')
const issued: string[] = []
const stubSql = {
  unsafe: async (text: string) => { issued.push(text); return [] },
} as unknown as Parameters<typeof executeDataQuery>[0]
const reticle = await executeDataQuery(stubSql, { userId: 'u', athleteId: '11111111-1111-1111-1111-111111111111' }, {
  table: 'insight',
  op: 'select',
  columns: reticleColumns,
  filters: [{ column: 'athlete_id', op: 'eq', value: '11111111-1111-1111-1111-111111111111' }],
})
ok(reticle.error == null, `reticle select: insight columns are allowed (${reticle.error?.message ?? 'ok'})`)
ok(issued.some((t) => t.includes('insight.prev_status') && t.includes('insight.updated_at')), 'reticle select: prev_status and updated_at reach SQL')
const unlisted = await executeDataQuery(stubSql, { userId: 'u', athleteId: '11111111-1111-1111-1111-111111111111' }, {
  table: 'insight',
  op: 'select',
  columns: 'status, xmin',
})
ok(unlisted.error?.message === 'unknown column insight.xmin', 'insight allow-list still rejects unlisted columns')
const appSql = readFileSync(join(here, '../schema/app.sql'), 'utf8')
ok(appSql.includes('NEW.prev_status := OLD.status'), 'app.sql keeps the trigger that maintains insight.prev_status')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('data query parser: ok')
