import { isLoopbackHostname } from './authUrl.ts'

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

/** postgres.js `ssl: 'require'` hangs on wrangler Hyperdrive local / loopback. */
export function useDatabaseSsl(url: string, env: Pick<Env, 'ENVIRONMENT'> = {}): boolean {
  if (env.ENVIRONMENT?.trim().toLowerCase() === 'local') return false
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
