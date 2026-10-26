// Runtime/build-time API target. Empty keeps today's Vercel + Supabase path.
// Cutover: set VITE_API_BASE_URL to the Worker origin + `/api` (or `/api` when
// the SPA is served from the same Worker). Rollback: point it back at
// `https://<project>.supabase.co/functions/v1`.

function clean(v: string | undefined): string {
  return (v ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim()
}

export function apiBaseUrl(): string | null {
  const raw = clean(import.meta.env.VITE_API_BASE_URL)
  if (!raw) return null
  return raw.replace(/\/+$/, '')
}

/** True when the build talks to the Cloudflare Worker, not Supabase functions. */
export function isCloudflareApi(): boolean {
  const base = apiBaseUrl()
  if (!base) return false
  return !base.includes('supabase.co')
}

export function agentUrl(): string | null {
  const base = apiBaseUrl()
  return base ? `${base}/agent` : null
}

export function mcpUrl(): string | null {
  const base = apiBaseUrl()
  return base ? `${base}/mcp` : null
}

export function authBaseUrl(): string | null {
  const base = apiBaseUrl()
  if (!base || !isCloudflareApi()) return null
  // `/api` → origin; Better Auth is mounted at `/api/auth`.
  if (base.endsWith('/api')) return base.slice(0, -4) || window.location.origin
  return base
}

export function healthUrl(): string | null {
  const base = apiBaseUrl()
  if (!base) return null
  if (base.includes('supabase.co')) return `${base.replace(/\/functions\/v1$/, '')}/auth/v1/health`
  return `${base}/health`
}
