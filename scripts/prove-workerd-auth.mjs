#!/usr/bin/env node
/**
 * Boot the Worker under workerd and prove /api/auth/get-session is 200
 * ten times in a row. Catches pg-pool allowExitOnIdle (`tid.unref`).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { refuseUnsafeTestUrl } from '../worker/src/authUrl.ts'
import { unstable_dev } from 'wrangler'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required for check:workerd-auth')
refuseUnsafeTestUrl(url, 'DATABASE_URL')

const secret = process.env.BETTER_AUTH_SECRET || 'ci-better-auth-secret-must-be-32b!!'
const port = Number(process.env.WORKERD_AUTH_PORT || 8791)
const origin = `http://127.0.0.1:${port}`
const email = 'workerd-auth@example.com'
const schemaPath = join(root, 'worker/schema/better-auth.sql')

const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
if (!existsSync(join(dist, 'index.html'))) {
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>zeroed</title>')
}

const client = new Client({ connectionString: url })
await client.connect()
await client.query('DROP TABLE IF EXISTS verification, session, account, "user" CASCADE')
await client.query(readFileSync(schemaPath, 'utf8'))

const worker = await unstable_dev(join(root, 'worker/src/index.ts'), {
  config: join(root, 'wrangler.jsonc'),
  ip: '127.0.0.1',
  port,
  local: true,
  persist: false,
  inspectorPort: 0,
  logLevel: 'error',
  vars: {
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: origin,
    ENVIRONMENT: 'local',
  },
  experimental: { disableExperimentalWarning: true },
})

try {
  const send = await worker.fetch(`${origin}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  const sendText = await send.text()
  if (!send.ok) throw new Error(`workerd send otp ${send.status}: ${sendText.slice(0, 240)}`)

  const otpRow = await client.query(
    `SELECT split_part(value, ':', 1) AS otp FROM verification
     WHERE identifier = $1 ORDER BY created_at DESC LIMIT 1`,
    [`sign-in-otp-${email}`],
  )
  const otp = otpRow.rows[0]?.otp
  if (!otp) throw new Error('workerd OTP was not stored on verification')

  const signIn = await worker.fetch(`${origin}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, otp }),
  })
  const signText = await signIn.text()
  if (!signIn.ok) throw new Error(`workerd sign-in ${signIn.status}: ${signText.slice(0, 240)}`)
  const cookie = signIn.headers.getSetCookie?.().find((c) => c.includes('session_token'))
    ?? signIn.headers.get('set-cookie')
  if (!cookie) throw new Error('workerd sign-in did not set a session cookie')

  for (let i = 1; i <= 10; i++) {
    const session = await worker.fetch(`${origin}/api/auth/get-session`, {
      headers: { cookie, origin },
    })
    const text = await session.text()
    if (!session.ok) {
      throw new Error(`workerd get-session ${i}/10 failed ${session.status}: ${text.slice(0, 240)}`)
    }
    let body
    try { body = JSON.parse(text) } catch {
      throw new Error(`workerd get-session ${i}/10 was not JSON: ${text.slice(0, 240)}`)
    }
    if (!body?.user?.id) throw new Error(`workerd get-session ${i}/10 missing user`)
    if (/tid\.unref is not a function/i.test(text)) {
      throw new Error(`workerd get-session ${i}/10 hit tid.unref`)
    }
    console.log(`workerd get-session ${i}/10 ok`)
  }
  console.log('workerd auth: get-session 10/10 ok')
} finally {
  await worker.stop()
  await client.end()
}
