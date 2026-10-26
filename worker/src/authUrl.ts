import type { Env } from './env.ts'

const LOCAL_FALLBACK = 'http://localhost:8787'

/** 127.0.0.0/8, including short forms like 127.1. */
function isIpv4Loopback(host: string): boolean {
  if (!/^\d+(?:\.\d+){0,3}$/.test(host)) return false
  const parts = host.split('.').map(Number)
  return parts[0] === 127 && parts.every((n) => n <= 255)
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || isIpv4Loopback(host)
}

export function isLocalAuthHost(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Hostname only — never a substring of user, db name, or query. */
export function connectionHostname(connectionString: string): string | null {
  try {
    const host = new URL(connectionString).hostname
    return host || null
  } catch {
    return null
  }
}

export function isLocalAuthRuntime(
  env: Pick<Env, 'DATABASE_URL' | 'HYPERDRIVE' | 'ENVIRONMENT'>,
): boolean {
  if (env.ENVIRONMENT?.trim().toLowerCase() === 'local') return true
  for (const raw of [env.DATABASE_URL, env.HYPERDRIVE?.connectionString]) {
    if (!raw?.trim()) continue
    const host = connectionHostname(raw.trim())
    if (host && isLoopbackHostname(host)) return true
  }
  return false
}

/** Secure cookies unless the auth origin is loopback. */
export function authCookieSecure(baseURL: string): boolean {
  return !isLocalAuthHost(baseURL)
}

/**
 * Public Better Auth origin.
 * Unset is allowed only when ENVIRONMENT=local or the DB/Hyperdrive
 * hostname (parsed, not substring-matched) is loopback.
 * Production must set BETTER_AUTH_URL — no silent localhost fallback.
 */
export function resolveAuthBaseURL(
  env: Pick<Env, 'BETTER_AUTH_URL' | 'DATABASE_URL' | 'HYPERDRIVE' | 'ENVIRONMENT'>,
): string {
  const configured = env.BETTER_AUTH_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (isLocalAuthRuntime(env)) return LOCAL_FALLBACK
  throw new Error('BETTER_AUTH_URL must be set to the public Worker origin')
}
