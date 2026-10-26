#!/usr/bin/env node
/**
 * Real Better Auth against worker/schema/better-auth.sql on real Postgres.
 * OTP send/verify, get-session, re-sign-in, signed bearer, raw DB token 401.
 * Fails if the snake_case mapping is removed from auth.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const authPath = join(root, 'worker/src/auth.ts')
const schemaPath = join(root, 'worker/schema/better-auth.sql')

const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required for check:better-auth-schema')

const secret = process.env.BETTER_AUTH_SECRET || 'ci-better-auth-secret-must-be-32b!!'
const origin = 'http://localhost:8787'
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: origin,
  ENVIRONMENT: 'local',
}

async function resetAuthTables() {
  const client = new Client({ connectionString: url })
  await client.connect()
  await client.query('DROP TABLE IF EXISTS verification, session, account, "user" CASCADE')
  await client.query(readFileSync(schemaPath, 'utf8'))
  await client.end()
}

function captureOtp() {
  const otps = []
  const orig = console.log
  console.log = (...args) => {
    const line = args.map(String).join(' ')
    const match = /OTP for \S+ \([^)]+\): (\d+)/.exec(line)
    if (match) otps.push(match[1])
    orig.apply(console, args)
  }
  return {
    otps,
    restore() {
      console.log = orig
    },
  }
}

async function withAuthHandler(req) {
  const { withAuth } = await import('../worker/src/auth.ts')
  return withAuth(env, (auth) => auth.handler(req))
}

async function post(path, body, headers = {}) {
  return withAuthHandler(new Request(`http://localhost:8787${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  }))
}

function cookiePair(setCookie) {
  if (!setCookie) return ''
  return String(setCookie).split(';')[0]
}

async function runFlow(email, { reset = true } = {}) {
  if (reset) await resetAuthTables()
  const cap = captureOtp()
  try {
    const send = await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })
    const sendText = await send.text()
    if (!send.ok) throw new Error(`send otp ${send.status}: ${sendText.slice(0, 240)}`)
    const otp = cap.otps.at(-1)
    if (!otp) throw new Error('OTP was not logged (RESEND unset should console.log the code)')

    const signIn = await post('/api/auth/sign-in/email-otp', { email, otp })
    const signText = await signIn.text()
    if (!signIn.ok) throw new Error(`sign-in ${signIn.status}: ${signText.slice(0, 240)}`)
    const cookie = signIn.headers.getSetCookie?.().find((c) => c.includes('session_token'))
      ?? signIn.headers.get('set-cookie')
    if (!cookie) throw new Error('sign-in did not set a session cookie')
    const cookieHeader = cookiePair(cookie)
    const signed = signIn.headers.get('set-auth-token')
    if (!signed || !signed.includes('.')) {
      throw new Error('sign-in did not expose a signed set-auth-token')
    }

    const session = await withAuthHandler(new Request('http://localhost:8787/api/auth/get-session', {
      headers: { cookie, origin },
    }))
    if (!session.ok) throw new Error(`get-session ${session.status}: ${(await session.text()).slice(0, 240)}`)
    const body = await session.json()
    if (!body?.user?.id) throw new Error('get-session missing user')

    const viaSigned = await withAuthHandler(new Request('http://localhost:8787/api/auth/get-session', {
      headers: { authorization: `Bearer ${signed}`, origin },
    }))
    if (!viaSigned.ok) throw new Error(`signed bearer get-session ${viaSigned.status}`)
    const viaSignedBody = await viaSigned.json()
    if (!viaSignedBody?.user?.id) throw new Error('signed bearer get-session missing user')

    const client = new Client({ connectionString: url })
    await client.connect()
    const user = await client.query(
      'SELECT email_verified, created_at FROM "user" WHERE lower(email) = lower($1)',
      [email],
    )
    if (!user.rows[0]) throw new Error('user row missing snake_case columns')
    const sess = await client.query('SELECT token, user_id, expires_at FROM session LIMIT 1')
    if (!sess.rows[0]) throw new Error('session row missing snake_case columns')
    const rawToken = sess.rows[0].token
    if (!rawToken || String(rawToken).includes('.')) {
      throw new Error('session.token should be the raw unsigned DB token')
    }

    const viaRaw = await withAuthHandler(new Request('http://localhost:8787/api/auth/get-session', {
      headers: { authorization: `Bearer ${rawToken}`, origin },
    }))
    const viaRawBody = viaRaw.ok ? await viaRaw.json() : null
    if (viaRawBody?.user?.id) throw new Error('raw DB token authenticated via Better Auth')

    const { handleData } = await import('../worker/src/data.ts')
    const { sessionUser } = await import('../worker/src/auth.ts')
    const dataEnv = {
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: origin,
      ENVIRONMENT: 'local',
    }
    const query = JSON.stringify({ table: 'athlete', op: 'select', columns: 'id' })
    const tampered = `${signed.slice(0, signed.lastIndexOf('.'))}.not-the-real-signature==`

    async function dataReq(headers) {
      return handleData(new Request('http://localhost:8787/api/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...headers },
        body: query,
      }), dataEnv)
    }

    const cookieData = await dataReq({ cookie: cookieHeader })
    if (cookieData.status === 401) throw new Error('signed cookie rejected by /api/data')
    const bearerData = await dataReq({ authorization: `Bearer ${signed}` })
    if (bearerData.status === 401) throw new Error('signed bearer rejected by /api/data')
    const rawData = await dataReq({ authorization: `Bearer ${rawToken}` })
    if (rawData.status !== 401) throw new Error(`raw DB token expected 401 from /api/data, got ${rawData.status}`)
    const tamperedData = await dataReq({ authorization: `Bearer ${tampered}` })
    if (tamperedData.status !== 401) throw new Error(`tampered bearer expected 401 from /api/data, got ${tamperedData.status}`)
    const tamperedCookie = await dataReq({ cookie: `better-auth.session_token=${tampered}` })
    if (tamperedCookie.status !== 401) throw new Error(`tampered cookie expected 401 from /api/data, got ${tamperedCookie.status}`)

    const cookieUser = await sessionUser(dataEnv, new Request('http://localhost:8787/api/agent', {
      headers: { cookie: cookieHeader },
    }))
    if (!cookieUser?.id) throw new Error('signed cookie rejected by sessionUser')
    const bearerUser = await sessionUser(dataEnv, new Request('http://localhost:8787/api/agent', {
      headers: { authorization: `Bearer ${signed}` },
    }))
    if (!bearerUser?.id) throw new Error('signed bearer rejected by sessionUser')
    const rawUser = await sessionUser(dataEnv, new Request('http://localhost:8787/api/agent', {
      headers: { authorization: `Bearer ${rawToken}` },
    }))
    if (rawUser) throw new Error('raw DB token authenticated via sessionUser')
    const tamperedUser = await sessionUser(dataEnv, new Request('http://localhost:8787/api/agent', {
      headers: { authorization: `Bearer ${tampered}` },
    }))
    if (tamperedUser) throw new Error('tampered bearer authenticated via sessionUser')

    await client.end()

    cap.otps.length = 0
    const send2 = await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })
    if (!send2.ok) throw new Error(`re-send otp ${send2.status}`)
    const otp2 = cap.otps.at(-1)
    if (!otp2) throw new Error('re-sign-in OTP was not logged')
    const signIn2 = await post('/api/auth/sign-in/email-otp', { email, otp: otp2 })
    if (!signIn2.ok) throw new Error(`re-sign-in ${signIn2.status}: ${(await signIn2.text()).slice(0, 240)}`)
    if (!signIn2.headers.get('set-auth-token')?.includes('.')) {
      throw new Error('re-sign-in did not expose a signed set-auth-token')
    }

    return body.user.id
  } finally {
    cap.restore()
  }
}

if (process.argv.includes('--expect-mapping-removed')) {
  try {
    await runFlow('nomap@example.com')
    console.error('mapping removal still created a user/session')
    process.exit(1)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/emailVerified|does not exist|column|schema mismatch/i.test(msg)) {
      console.error(`mapping removal failed for the wrong reason: ${msg}`)
      process.exit(1)
    }
    console.log(`mapping removal failed as expected: ${msg.slice(0, 200)}`)
    process.exit(0)
  }
}

const userId = await runFlow('ok@example.com')
console.log(`better-auth schema: OTP + get-session + re-sign-in ok (user ${userId})`)

await resetAuthTables()
const migratedId = crypto.randomUUID()
{
  const client = new Client({ connectionString: url })
  await client.connect()
  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Phil', $2, true, NOW(), NOW())`,
    [migratedId, 'Phillip@Example.com'],
  )
  await client.end()
}
const adoptedId = await runFlow('phillip@example.com', { reset: false })
if (adoptedId !== migratedId) {
  throw new Error(`adoption created a new user (${adoptedId}) instead of ${migratedId}`)
}
{
  const client = new Client({ connectionString: url })
  await client.connect()
  const count = await client.query('SELECT count(*)::int AS n FROM "user"')
  await client.end()
  if (Number(count.rows[0].n) !== 1) {
    throw new Error(`adoption duplicated the user (count=${count.rows[0].n})`)
  }
}
console.log(`better-auth schema: mixed-case email adoption ok (user ${migratedId})`)

const original = readFileSync(authPath, 'utf8')
const mutated = original
  .replace(/\n\s+user: BETTER_AUTH_SNAKE_CASE\.user,/, '')
  .replace(/\n\s+session: BETTER_AUTH_SNAKE_CASE\.session,/, '')
  .replace(/\n\s+account: BETTER_AUTH_SNAKE_CASE\.account,/, '')
  .replace(/\n\s+verification: BETTER_AUTH_SNAKE_CASE\.verification,/, '')
if (mutated === original) throw new Error('could not strip BETTER_AUTH_SNAKE_CASE from auth.ts')
writeFileSync(authPath, mutated)
try {
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(here, 'prove-better-auth-schema.mjs'), '--expect-mapping-removed'],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', DATABASE_URL: url, BETTER_AUTH_SECRET: secret },
    },
  )
  const out = `${child.stdout || ''}\n${child.stderr || ''}`.trim()
  console.log(out)
  if (child.status === 0) {
    console.log('better-auth schema: mapping-removal mutation detected')
  } else {
    throw new Error(`mapping-removal child failed (exit ${child.status})`)
  }
} finally {
  writeFileSync(authPath, original)
}
