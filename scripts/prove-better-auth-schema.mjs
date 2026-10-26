#!/usr/bin/env node
/**
 * Real Better Auth against worker/schema/better-auth.sql on real Postgres.
 * OTP send/verify, get-session, re-sign-in. Fails if the snake_case mapping
 * is removed from auth.ts.
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

async function post(auth, path, body, headers = {}) {
  return auth.handler(new Request(`http://localhost:8787${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  }))
}

async function runFlow(email) {
  await resetAuthTables()
  const { createAuth } = await import('../worker/src/auth.ts')
  const auth = createAuth(env)
  const cap = captureOtp()
  try {
    const send = await post(auth, '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })
    const sendText = await send.text()
    if (!send.ok) throw new Error(`send otp ${send.status}: ${sendText.slice(0, 240)}`)
    const otp = cap.otps.at(-1)
    if (!otp) throw new Error('OTP was not logged (RESEND unset should console.log the code)')

    const signIn = await post(auth, '/api/auth/sign-in/email-otp', { email, otp })
    const signText = await signIn.text()
    if (!signIn.ok) throw new Error(`sign-in ${signIn.status}: ${signText.slice(0, 240)}`)
    const cookie = signIn.headers.getSetCookie?.().find((c) => c.includes('session_token'))
      ?? signIn.headers.get('set-cookie')
    if (!cookie) throw new Error('sign-in did not set a session cookie')

    const session = await auth.handler(new Request('http://localhost:8787/api/auth/get-session', {
      headers: { cookie, origin },
    }))
    if (!session.ok) throw new Error(`get-session ${session.status}: ${(await session.text()).slice(0, 240)}`)
    const body = await session.json()
    if (!body?.user?.id) throw new Error('get-session missing user')

    cap.otps.length = 0
    const send2 = await post(auth, '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })
    if (!send2.ok) throw new Error(`re-send otp ${send2.status}`)
    const otp2 = cap.otps.at(-1)
    if (!otp2) throw new Error('re-sign-in OTP was not logged')
    const signIn2 = await post(auth, '/api/auth/sign-in/email-otp', { email, otp: otp2 })
    if (!signIn2.ok) throw new Error(`re-sign-in ${signIn2.status}: ${(await signIn2.text()).slice(0, 240)}`)

    const client = new Client({ connectionString: url })
    await client.connect()
    const user = await client.query('SELECT email_verified, created_at FROM "user" WHERE email = $1', [email])
    if (!user.rows[0]) throw new Error('user row missing snake_case columns')
    const sess = await client.query('SELECT user_id, expires_at FROM session LIMIT 1')
    if (!sess.rows[0]) throw new Error('session row missing snake_case columns')
    await client.end()
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
