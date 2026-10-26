// Run: node --experimental-strip-types worker/src/data.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BETTER_AUTH_SNAKE_CASE } from './auth.ts'
import {
  bindOwner,
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
ok(unsignedSessionToken('tok') === 'tok', 'unsigned bearer is unchanged')
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

const schemaSql = readFileSync(join(here, '../schema/better-auth.sql'), 'utf8')
ok(schemaSql.includes('email_verified') && schemaSql.includes('user_id') && schemaSql.includes('expires_at'), 'better-auth.sql is snake_case')
ok(!schemaSql.includes('emailVerified') && !schemaSql.includes('"userId"'), 'better-auth.sql is not camelCase')
const migrateSrc = readFileSync(join(here, '../../scripts/migrate-supabase-to-neon.mjs'), 'utf8')
ok(migrateSrc.includes('email_verified BOOLEAN') && migrateSrc.includes('user_id TEXT'), 'migrate script Better Auth SQL is snake_case')

const secret = 's'.repeat(32)
const signed = await signSessionToken('tok', secret)
const signature = signed.slice(signed.indexOf('.') + 1)
ok(signature.length > 10, 'signSessionToken writes an HMAC')
ok(await verifySessionSignature('tok', signature, secret, true), 'valid cookie HMAC is accepted')
ok(!(await verifySessionSignature('tok', 'not-the-real-signature', secret, true)), 'tampered cookie HMAC is rejected')
ok(await verifySessionSignature('tok', null, secret, false), 'unsigned bearer is allowed')
ok(!(await verifySessionSignature('tok', null, secret, true)), 'cookie without signature is rejected')

const cookieReq = new Request('http://local/api/data', {
  headers: { cookie: `better-auth.session_token=${signed}` },
})
ok(await sessionTokenFromRequest(cookieReq, secret) === 'tok', 'signed cookie authenticates')
const badCookie = new Request('http://local/api/data', {
  headers: { cookie: 'better-auth.session_token=tok.not-the-real-signature' },
})
ok(await sessionTokenFromRequest(badCookie, secret) === null, 'tampered cookie is rejected')
const bearerReq = new Request('http://local/api/data', {
  headers: { authorization: 'Bearer tok' },
})
ok(await sessionTokenFromRequest(bearerReq, secret) === 'tok', 'unsigned bearer still works')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('data query parser: ok')
