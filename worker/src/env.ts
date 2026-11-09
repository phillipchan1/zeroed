import { isLoopbackHostname } from './authUrl.ts'
import type { SendEmailBinding } from './mail.ts'

export interface HyperdriveBinding {
  connectionString: string
}

export interface Env {
  ASSETS?: Fetcher
  HYPERDRIVE?: HyperdriveBinding
  DATABASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_MODEL_HEAVY?: string
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  /** wrangler / `.dev.vars` only: `local` allows a localhost auth fallback. */
  ENVIRONMENT?: string
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  /** Cloudflare Email Service send_email binding (primary OTP sender). */
  EMAIL?: SendEmailBinding
  /** From for the EMAIL binding. Default `Zeroed <login@zeroed.madeforgreatnesslabs.com>`. */
  CF_EMAIL_FROM?: string
  /** Optional comma-separated allowlist for sign-in code emails (cost/abuse guard). */
  ALLOWED_EMAILS?: string
  /** `1` / `true` enables half-step RPE and the #35 working-max rule. Default off. */
  RPE_HALF_STEPS?: string
  /** `1` enables agent-led onboarding connector tools. Default off. Never set in wrangler. */
  ONBOARDING_AGENT_V1?: string
}

export function databaseUrl(env: Env): string | null {
  const fallback = env.DATABASE_URL?.trim() ?? ''
  // wrangler Hyperdrive local hangs postgres.js connect/end. Prefer a direct
  // loopback URL when this process is marked local.
  if (env.ENVIRONMENT?.trim().toLowerCase() === 'local' && fallback) return fallback
  const fromHyperdrive = env.HYPERDRIVE?.connectionString?.trim() ?? ''
  if (fromHyperdrive && !fromHyperdrive.includes('00000000000000000000000000000000')) {
    return fromHyperdrive
  }
  return fallback || fromHyperdrive || null
}

/**
 * pg Client ssl option. Bound Hyperdrive (`url === env.HYPERDRIVE.connectionString`)
 * is a local proxy — TLS is already terminated. An unbound `*.hyperdrive.local`
 * URL is treated like any other remote host (ssl true).
 */
export function useDatabaseSsl(
  url: string,
  env: Pick<Env, 'ENVIRONMENT' | 'HYPERDRIVE'> = {},
): boolean {
  if (env.ENVIRONMENT?.trim().toLowerCase() === 'local') return false
  const bound = env.HYPERDRIVE?.connectionString?.trim() ?? ''
  if (bound && url.trim() === bound) return false
  try {
    const parsed = new URL(url)
    if (isLoopbackHostname(parsed.hostname)) return false
    const mode = parsed.searchParams.get('sslmode')
    if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return false
  } catch {
    if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('[::1]')) return false
  }
  return true
}

export function pgClientSsl(
  url: string,
  env: Pick<Env, 'ENVIRONMENT' | 'HYPERDRIVE'> = {},
): false | { rejectUnauthorized: true } {
  return useDatabaseSsl(url, env) ? { rejectUnauthorized: true } : false
}
