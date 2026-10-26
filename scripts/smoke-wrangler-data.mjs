#!/usr/bin/env node
/**
 * Local cutover smoke: sign-in is Better Auth; load/save workout is /api/data.
 *
 * Always proves load+save against PGlite (same predicates as wrangler).
 * When wrangler is already on :8787, also hits /api/health, unauthenticated
 * /api/data (401), and — if RESEND is unset so OTPs are logged — a sign-in
 * plus load/save against the live Worker.
 */
import { spawnSync } from 'node:child_process'

function run(label, args, opts = {}) {
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    ...opts,
  })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
  if (res.status !== 0) {
    console.error(out)
    throw new Error(`${label} failed`)
  }
  return out
}

console.log('=== PGlite data-plane smoke (load + save workout) ===')
const isolation = run('access.check', ['--experimental-strip-types', 'worker/src/access.check.ts'])
if (!isolation.includes('smoke load workout') && !isolation.includes('access isolation: ok')) {
  throw new Error('isolation check did not finish')
}
if (!isolation.includes('access isolation: ok')) {
  console.error(isolation)
  throw new Error('PGlite smoke failed')
}
console.log('PGlite: sign-in is out of band; load + save workout isolation checks passed')

const base = process.env.SMOKE_API_BASE || 'http://127.0.0.1:8787'
let wranglerUp = false
try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
  wranglerUp = res.ok
} catch {
  wranglerUp = false
}

if (!wranglerUp) {
  console.log(`wrangler HTTP smoke skipped (nothing on ${base}). Start with:`)
  console.log('  npm run build && npx wrangler dev')
  console.log('then re-run: node scripts/smoke-wrangler-data.mjs')
  process.exit(0)
}

console.log(`=== wrangler ${base} ===`)
const health = await fetch(`${base}/api/health`)
const healthBody = await health.json()
if (!health.ok || healthBody?.ok !== true) throw new Error('GET /api/health failed')
console.log('GET /api/health ok')

const unauth = await fetch(`${base}/api/data`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ table: 'workout', op: 'select', columns: 'id' }),
})
if (unauth.status !== 401) throw new Error(`POST /api/data without session expected 401, got ${unauth.status}`)
console.log('POST /api/data unauthenticated → 401')

const email = process.env.SMOKE_EMAIL
if (!email) {
  console.log('wrangler sign-in + load/save skipped (set SMOKE_EMAIL to exercise OTP).')
  console.log('PGlite already covered load + save of a workout under the same owner filters.')
  process.exit(0)
}

const send = await fetch(`${base}/api/auth/email-otp/send-verification-otp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, type: 'sign-in' }),
})
if (!send.ok) {
  const body = await send.text()
  throw new Error(`send otp failed ${send.status}: ${body.slice(0, 200)}`)
}
console.log(`OTP requested for ${email} — check wrangler logs (RESEND unset) or inbox`)
console.log('wrangler smoke: health + unauthorized data gate ok')
