#!/usr/bin/env node
/**
 * Local cutover smoke: sign-in is Better Auth; load/save workout is /api/data.
 *
 * Always proves load+save against PGlite (same predicates as wrangler).
 * When wrangler is already on :8787, also hits /api/health, unauthenticated
 * /api/data (401), OTP send (sign-in), and — with a signed SMOKE_BEARER
 * (`set-auth-token`, not the raw session.token) — load/save of a workout
 * against the live Worker.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const origin = process.env.SMOKE_ORIGIN || 'http://localhost:8787'
const unauth = await fetch(`${base}/api/data`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ table: 'workout', op: 'select', columns: 'id' }),
})
if (unauth.status !== 401) throw new Error(`POST /api/data without session expected 401, got ${unauth.status}`)
console.log('POST /api/data unauthenticated → 401')

const bearer = process.env.SMOKE_BEARER
if (bearer && !bearer.includes('.')) {
  throw new Error('SMOKE_BEARER must be the signed set-auth-token value (token.signature), not session.token')
}
const email = process.env.SMOKE_EMAIL || 'smoke@example.com'

async function requestOtp() {
  let lastStatus = 0
  let lastBody = ''
  for (let i = 0; i < 6; i++) {
    const send = await fetch(`${base}/api/auth/email-otp/send-verification-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, type: 'sign-in' }),
    })
    lastStatus = send.status
    if (send.ok) {
      console.log(`OTP requested for ${email} — check wrangler logs (RESEND unset) or inbox`)
      return true
    }
    lastBody = await send.text()
    if (send.status !== 500) break
    await sleep(800)
  }
  throw new Error(`send otp failed ${lastStatus}: ${lastBody.slice(0, 200)}`)
}

if (!bearer) {
  await requestOtp()
  console.log('wrangler load/save skipped (set SMOKE_BEARER to a signed set-auth-token).')
  console.log('PGlite already covered load + save of a workout under the same owner filters.')
  console.log('wrangler smoke: health + sign-in OTP + unauthorized data gate ok')
  process.exit(0)
}

const headers = {
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
  origin,
}

async function call(label, path, opts = {}, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const res = await fetch(`${base}${path}`, {
        ...opts,
        signal: controller.signal,
        headers: { ...headers, ...(opts.headers || {}) },
      })
      const text = await res.text()
      let body
      try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 240) } }
      last = { status: res.status, body }
      if (res.status === 500 && i < tries - 1) {
        await sleep(800)
        continue
      }
      if (!res.ok) throw new Error(`${label} ${res.status}: ${text.slice(0, 240)}`)
      return last
    } catch (err) {
      last = err
      if (i === tries - 1) throw err
      await sleep(400)
    } finally {
      clearTimeout(timer)
    }
  }
  throw last instanceof Error ? last : new Error(`${label} failed`)
}

function data(body) {
  return call('data', '/api/data', { method: 'POST', body: JSON.stringify(body) })
}

const athlete = await data({ table: 'athlete', op: 'select', columns: 'id, name', single: 'maybe' })
let athleteId = athlete.body?.data?.id
if (!athleteId) {
  const created = await data({
    table: 'athlete',
    op: 'insert',
    values: { name: 'Smoke', sessions_per_week: 3 },
    returning: '*',
    single: 'one',
  })
  athleteId = created.body?.data?.id
}
if (!athleteId) throw new Error('could not load or create athlete')
console.log(`athlete ${athleteId}`)

const existingProg = await data({
  table: 'program',
  op: 'select',
  columns: 'id',
  filters: [{ column: 'status', op: 'eq', value: 'active' }],
  single: 'maybe',
})
let programId = existingProg.body?.data?.id
if (!programId) {
  const prog = await data({
    table: 'program',
    op: 'insert',
    values: { goal: 'smoke', status: 'active', start_date: '2026-10-20' },
    returning: '*',
    single: 'one',
  })
  programId = prog.body?.data?.id
}
if (!programId) throw new Error('could not load or create program')

const phase = await data({
  table: 'phase',
  op: 'insert',
  values: {
    program_id: programId,
    name: 'Strength',
    week_start: '2026-10-20',
    week_end: '2026-10-26',
    status: 'active',
  },
  returning: '*',
  single: 'one',
})
const phaseId = phase.body?.data?.id
if (!phaseId) throw new Error(`phase insert failed: ${JSON.stringify(phase.body)}`)

const routine = await data({
  table: 'routine',
  op: 'insert',
  values: {
    program_id: programId,
    phase_id: phaseId,
    name: 'Smoke A',
    session_type: 'strength',
    exercises: [],
  },
  returning: '*',
  single: 'one',
})
const routineId = routine.body?.data?.id
if (!routineId) throw new Error(`routine insert failed: ${JSON.stringify(routine.body)}`)

const saved = await data({
  table: 'workout',
  op: 'insert',
  values: {
    routine_id: routineId,
    performed_at: '2026-10-26T12:00:00Z',
    rpe: 6,
    duration_mins: 40,
  },
  returning: '*',
  single: 'one',
})
const workoutId = saved.body?.data?.id
if (!workoutId) throw new Error(`workout save failed: ${JSON.stringify(saved.body)}`)
console.log(`saved workout ${workoutId}`)

const loaded = await data({
  table: 'workout',
  op: 'select',
  columns: 'id, rpe, routine!inner(program_id)',
  filters: [{ column: 'id', op: 'eq', value: workoutId }],
  single: 'maybe',
})
if (loaded.body?.data?.id !== workoutId) throw new Error(`load mismatch: ${JSON.stringify(loaded.body)}`)
if (loaded.body?.data?.routine?.program_id !== programId) {
  throw new Error(`embed mismatch: ${JSON.stringify(loaded.body)}`)
}
console.log('loaded workout with routine.program_id embed')

try {
  await requestOtp()
} catch (err) {
  console.log(`OTP after load/save: ${err instanceof Error ? err.message.slice(0, 120) : err}`)
}

console.log('SMOKE_OK wrangler sign-in + load + save workout')
