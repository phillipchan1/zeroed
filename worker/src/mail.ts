import type { Env } from './env.ts'

/**
 * Sign-in code email.
 *
 * Primary sender: Cloudflare Email Service via the `EMAIL` send_email binding
 * (Workers Paid, 3,000 sends/month included per account), from CF_EMAIL_FROM
 * (default `Zeroed <login@zeroed.madeforgreatnesslabs.com>`).
 * Fallback: Resend when RESEND_API_KEY and RESEND_FROM are both set.
 * Log mode (code printed to the Worker log, no email) runs only when
 * ENVIRONMENT is `local` or `dev`. Anywhere else, no sender means fail closed:
 * a prod Worker must never write sign-in codes to its logs.
 *
 * Error and log text never includes the recipient, the code or a provider
 * response body.
 */

/** Minimal shape of the Cloudflare `send_email` binding builder API. */
export interface SendEmailBinding {
  send(message: {
    from: string | { email: string; name: string }
    to: string
    subject: string
    text: string
    html?: string
  }): Promise<unknown>
}

export const DEFAULT_CF_EMAIL_FROM = 'Zeroed <login@zeroed.madeforgreatnesslabs.com>'
const RESEND_URL = 'https://api.resend.com/emails'

export type OtpSendFailureKind = 'cf_email' | 'resend_http' | 'resend_network' | 'no_sender'

export class OtpSendError extends Error {
  readonly kind: OtpSendFailureKind
  readonly status?: number
  constructor(kind: OtpSendFailureKind, status?: number) {
    super(status ? `otp email send failed (${kind} ${status})` : `otp email send failed (${kind})`)
    this.name = 'OtpSendError'
    this.kind = kind
    this.status = status
  }
}

/** Parse `Name <addr>` or `addr` into the Email Service builder shape. */
export function parseFrom(raw: string): string | { email: string; name: string } {
  const m = raw.trim().match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/)
  if (m) {
    const name = m[1].trim().replace(/^"|"$/g, '')
    return name ? { email: m[2], name } : m[2]
  }
  return raw.trim()
}

export function cfEmailFrom(env: Pick<Env, 'CF_EMAIL_FROM'>): string {
  return env.CF_EMAIL_FROM?.trim() || DEFAULT_CF_EMAIL_FROM
}

export function otpLogModeAllowed(env: Pick<Env, 'ENVIRONMENT'>): boolean {
  const e = env.ENVIRONMENT?.trim().toLowerCase()
  return e === 'local' || e === 'dev'
}

/**
 * Optional cost/abuse guard. When ALLOWED_EMAILS is set (comma-separated),
 * codes are only sent to those addresses; others are skipped silently so the
 * endpoint does not reveal which emails are allowed.
 */
export function emailAllowed(env: Pick<Env, 'ALLOWED_EMAILS'>, email: string): boolean {
  const raw = env.ALLOWED_EMAILS?.trim()
  if (!raw) return true
  const want = email.trim().toLowerCase()
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(want)
}

export function otpEmailBody(otp: string, type: string): { subject: string; text: string; html: string } {
  const subject = type === 'forget-password' ? 'Reset your Zeroed sign-in' : 'Your Zeroed sign-in code'
  const text = `Your code is ${otp}. It expires in 5 minutes.\n\nNo password. If you did not request this, ignore the email.`
  const html = `<p>Your code is <strong style="font-size:20px;letter-spacing:2px">${otp}</strong>. It expires in 5 minutes.</p><p>No password. If you did not request this, ignore the email.</p>`
  return { subject, text, html }
}

export type OtpSendResult = 'cloudflare' | 'resend' | 'log' | 'skipped'

export async function sendOtpEmail(
  env: Env,
  opts: { email: string; otp: string; type: string },
  deps: { fetch?: typeof fetch; log?: (message: string, detail?: Record<string, unknown>) => void } = {},
): Promise<OtpSendResult> {
  const log = deps.log ?? ((m: string, d?: Record<string, unknown>) => console.error(m, d ?? {}))
  const to = opts.email.trim().toLowerCase()
  if (!emailAllowed(env, to)) {
    log('[auth] otp send skipped', { kind: 'not_allowed' })
    return 'skipped'
  }
  const body = otpEmailBody(opts.otp, opts.type)

  if (env.EMAIL) {
    try {
      await env.EMAIL.send({ from: parseFrom(cfEmailFrom(env)), to, subject: body.subject, text: body.text, html: body.html })
      return 'cloudflare'
    } catch {
      // Never surface the binding error text: it can echo the recipient.
      log('[auth] otp cloudflare send failed', { kind: 'cf_email' })
    }
  }

  const key = env.RESEND_API_KEY?.trim()
  const from = env.RESEND_FROM?.trim()
  if (key && from) {
    let res: Response
    try {
      res = await (deps.fetch ?? fetch)(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject: body.subject, text: body.text, html: body.html }),
      })
    } catch {
      throw new OtpSendError('resend_network')
    }
    if (!res.ok) throw new OtpSendError('resend_http', res.status)
    return 'resend'
  }

  if (env.EMAIL) throw new OtpSendError('cf_email')
  if (otpLogModeAllowed(env)) {
    // Dev/local only. Never reached in prod (ENVIRONMENT unset there).
    console.log(`[auth] dev OTP (${opts.type}): ${opts.otp}`)
    return 'log'
  }
  throw new OtpSendError('no_sender')
}
