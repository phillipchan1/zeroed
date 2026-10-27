// Run: node --experimental-strip-types worker/src/mail.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CF_EMAIL_FROM,
  OtpSendError,
  emailAllowed,
  otpLogModeAllowed,
  parseFrom,
  sendOtpEmail,
  type SendEmailBinding,
} from './mail.ts'
import type { Env } from './env.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const EMAIL = 'Athlete@Example.com'
const OTP = '493817'
const sent: unknown[] = []
const good: SendEmailBinding = { async send(m) { sent.push(m); return {} } }
const bad: SendEmailBinding = { async send() { throw new Error(`rejected ${EMAIL.toLowerCase()}`) } }
const logs: string[] = []
const log = (m: string, d?: Record<string, unknown>) => { logs.push(m + JSON.stringify(d ?? {})) }
const origLog = console.log
const stdout: string[] = []
console.log = (...a: unknown[]) => { stdout.push(a.join(' ')) }

async function main() {
  // Parsing and defaults
  const f = parseFrom(DEFAULT_CF_EMAIL_FROM)
  ok(typeof f === 'object' && f.email === 'login@zeroed.madeforgreatnesslabs.com' && f.name === 'Zeroed', 'parseFrom name <addr>')
  ok(parseFrom('a@b.co') === 'a@b.co', 'parseFrom bare address')
  ok(otpLogModeAllowed({ ENVIRONMENT: 'dev' }) && otpLogModeAllowed({ ENVIRONMENT: 'local' }), 'log mode on dev/local')
  ok(!otpLogModeAllowed({}) && !otpLogModeAllowed({ ENVIRONMENT: 'production' }), 'no log mode in prod')
  ok(emailAllowed({}, EMAIL), 'no allowlist allows all')
  ok(emailAllowed({ ALLOWED_EMAILS: ' athlete@example.com , x@y.z' }, EMAIL), 'allowlist is case/space-insensitive')
  ok(!emailAllowed({ ALLOWED_EMAILS: 'x@y.z' }, EMAIL), 'allowlist blocks others')

  // Primary: Cloudflare binding
  let r = await sendOtpEmail({ EMAIL: good } as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log })
  const m = sent[0] as { to: string; text: string; from: unknown }
  ok(r === 'cloudflare' && m.to === 'athlete@example.com' && m.text.includes(OTP), 'binding sends lowercased with code')
  ok(JSON.stringify(m.from) === JSON.stringify(parseFrom(DEFAULT_CF_EMAIL_FROM)), 'default from used')

  // Binding fails -> Resend fallback; log has no recipient or code
  let fetched: { body?: string } = {}
  const fakeFetch = (async (_u: string, init: { body: string }) => { fetched = init; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
  r = await sendOtpEmail({ EMAIL: bad, RESEND_API_KEY: 'k', RESEND_FROM: 'Zeroed <z@usedayspring.app>' } as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log, fetch: fakeFetch })
  ok(r === 'resend' && String(fetched.body).includes(OTP), 'falls back to resend')
  ok(logs.every((l) => !l.toLowerCase().includes('athlete@example.com') && !l.includes(OTP)), 'logs never carry recipient or code')

  // Binding fails, no Resend -> fail closed, error text clean
  let err: unknown
  try { await sendOtpEmail({ EMAIL: bad } as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log }) } catch (e) { err = e }
  ok(err instanceof OtpSendError && err.kind === 'cf_email', 'binding failure without fallback throws')
  ok(err instanceof Error && !err.message.toLowerCase().includes('athlete') && !err.message.includes(OTP), 'error text clean')

  // Resend HTTP error: status only, no body
  const failFetch = (async () => new Response(`bad ${EMAIL}`, { status: 422 })) as unknown as typeof fetch
  err = undefined
  try { await sendOtpEmail({ RESEND_API_KEY: 'k', RESEND_FROM: 'z@usedayspring.app' } as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log, fetch: failFetch }) } catch (e) { err = e }
  ok(err instanceof OtpSendError && err.kind === 'resend_http' && err.status === 422 && !err.message.includes('Example'), 'resend error: status only')

  // Prod with no sender: fail closed, nothing printed
  stdout.length = 0
  err = undefined
  try { await sendOtpEmail({} as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log }) } catch (e) { err = e }
  ok(err instanceof OtpSendError && err.kind === 'no_sender', 'prod without sender fails closed')
  ok(stdout.every((l) => !l.includes(OTP)), 'prod never logs the code')

  // Dev log mode prints the code, never the email
  stdout.length = 0
  r = await sendOtpEmail({ ENVIRONMENT: 'dev' } as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log })
  ok(r === 'log' && stdout.some((l) => l.includes(OTP)) && stdout.every((l) => !l.toLowerCase().includes('athlete@')), 'dev log mode: code only')

  // Allowlist skip sends nothing
  const before = sent.length
  r = await sendOtpEmail({ EMAIL: good, ALLOWED_EMAILS: 'x@y.z' } as Env, { email: EMAIL, otp: OTP, type: 'sign-in' }, { log })
  ok(r === 'skipped' && sent.length === before, 'allowlist skip sends nothing')

  // Config: prod sends from the onboarded address, dev never sends, no localhost from
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const cfg = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  ok(cfg.includes('"allowed_sender_addresses": ["login@zeroed.madeforgreatnesslabs.com"]'), 'prod EMAIL binding locked to login@')
  ok(!cfg.includes('noreply@localhost'), 'no localhost from address')
  ok(/"dev":\s*{[\s\S]*"send_email": \[\]/.test(cfg), 'dev env has no EMAIL binding')
  ok(!/"vars":\s*{[^}]*"ENVIRONMENT"[^}]*}[\s\S]*"env":/.test(cfg), 'top-level vars never set ENVIRONMENT')
  ok(/"keep_vars": true/.test(cfg), 'keep_vars on')
}

main().then(() => {
  console.log = origLog
  if (fails.length) {
    console.error(`mail.check: ${fails.length}/${checks} failed`)
    for (const f of fails) console.error(' -', f)
    process.exit(1)
  }
  console.log(`mail.check: ${checks} ok`)
})
