// Runtime/build-time API target. Empty keeps today's Vercel + Supabase path.
// Cutover: set VITE_API_BASE_URL to the Worker origin + `/api` (or `/api` when
// the SPA is served from the same Worker). iOS / Capacitor MUST use an absolute
// URL — a relative `/api` resolves against capacitor://localhost and misses
// the Worker. Rollback: point it back at
// `https://<project>.supabase.co/functions/v1`.

function clean(v: string | undefined): string {
  return (v ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim()
}

export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() === true
}

export function resolveApiBaseUrl(raw: string | undefined, native = false): {
  url: string | null
  needsAbsolute: boolean
} {
  const trimmed = clean(raw).replace(/\/+$/, '')
  if (!trimmed) return { url: null, needsAbsolute: false }
  const relative = trimmed.startsWith('/')
  return { url: trimmed, needsAbsolute: native && relative }
}

export function resolvedApiBase(raw: string | undefined, native = false): string | null {
  const { url, needsAbsolute } = resolveApiBaseUrl(raw, native)
  if (needsAbsolute) {
    throw new Error(
      '[zeroed] VITE_API_BASE_URL must be absolute on iOS (https://<worker>/api). ' +
      'A relative /api cannot reach the Worker from Capacitor.',
    )
  }
  return url
}

export function apiBaseUrl(): string | null {
  return resolvedApiBase(import.meta.env.VITE_API_BASE_URL, isNativeShell())
}

/** True when the build talks to the Cloudflare Worker, not Supabase functions. */
export function isCloudflareApi(): boolean {
  const base = apiBaseUrl()
  if (!base) return false
  return !base.includes('supabase.co')
}

/**
 * Half-step RPE input and the #35 working-max rule. Off unless
 * `VITE_RPE_HALF_STEPS` is `1` / `true` — including after the Cloudflare
 * cutover. The Worker / edge counterpart is `RPE_HALF_STEPS`.
 */
export function resolveRpeHalfSteps(flag: string | undefined): boolean {
  const v = clean(flag).toLowerCase()
  return v === '1' || v === 'true'
}

export function rpeHalfStepsEnabled(): boolean {
  return resolveRpeHalfSteps(import.meta.env.VITE_RPE_HALF_STEPS)
}

export function agentUrl(): string | null {
  const base = apiBaseUrl()
  return base ? `${base}/agent` : null
}

export function mcpUrl(): string | null {
  const base = apiBaseUrl()
  return base ? `${base}/mcp` : null
}

export function dataUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/data`
}

export function sessionRxUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/session-rx`
}

export function proposalsUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/proposals`
}

export function sessionOverrideUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/session-override`
}

export function changeLogUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/change-log`
}

export function approvalsUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/approvals`
}

export function readinessUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/readiness`
}

export function sessionRpeUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  return `${base}/session-rpe`
}

export function authBaseUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  // `/api` → origin; Better Auth is mounted at `/api/auth`.
  if (base.endsWith('/api')) {
    const origin = base.slice(0, -4)
    if (origin) return origin
    if (typeof window !== 'undefined' && window.location?.origin && !window.location.origin.startsWith('capacitor:')) {
      return window.location.origin
    }
    return null
  }
  return base
}

export function healthUrl(): string | null {
  const base = apiBaseUrl()
  if (!base) return null
  if (base.includes('supabase.co')) return `${base.replace(/\/functions\/v1$/, '')}/auth/v1/health`
  return `${base}/health`
}
