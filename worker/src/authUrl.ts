import type { Env } from './env.ts'

const LOCAL_FALLBACK = 'http://localhost:8787'

export function isLocalAuthHost(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export function isLocalAuthRuntime(env: Pick<Env, 'DATABASE_URL' | 'HYPERDRIVE' | 'ENVIRONMENT'>): boolean {
  const envName = env.ENVIRONMENT?.trim().toLowerCase()
  if (envName === 'development' || envName === 'dev' || envName === 'local') return true
  const db = `${env.DATABASE_URL ?? ''} ${env.HYPERDRIVE?.connectionString ?? ''}`
  return /(?:localhost|127\.0\.0\.1)/.test(db)
}

/** Secure cookies unless the auth origin is loopback. */
export function authCookieSecure(baseURL: string): boolean {
  return !isLocalAuthHost(baseURL)
}

/**
 * Public Better Auth origin.
 * Unset is allowed only in local wrangler/dev (localhost DB or ENVIRONMENT=dev).
 * Production must set BETTER_AUTH_URL — no silent localhost fallback.
 */
export function resolveAuthBaseURL(env: Pick<Env, 'BETTER_AUTH_URL' | 'DATABASE_URL' | 'HYPERDRIVE' | 'ENVIRONMENT'>): string {
  const configured = env.BETTER_AUTH_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (isLocalAuthRuntime(env)) return LOCAL_FALLBACK
  throw new Error('BETTER_AUTH_URL must be set to the public Worker origin')
}
