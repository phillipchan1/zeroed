import { isLocalAuthHost, resolveAuthBaseURL } from './authUrl.ts'
import type { Env } from './env.ts'

export const API_SECURITY = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
}

export const AGENT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  ...API_SECURITY,
}

export const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-zeroed-token, mcp-session-id, last-event-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
  ...API_SECURITY,
}

const AUTH_CORS_ALLOW = {
  'Access-Control-Allow-Headers':
    'authorization, content-type, cookie, x-zeroed-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Expose-Headers': 'set-auth-token',
  Vary: 'Origin',
} as const

/** Capacitor / Ionic WebView origins. Relative `/api` does not work there. */
export const NATIVE_APP_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
] as const

export function trustedAuthOrigins(env: Env): string[] {
  const base = resolveAuthBaseURL(env)
  const native = [...NATIVE_APP_ORIGINS]
  if (!isLocalAuthHost(base)) return [...new Set([base, ...native])]
  return [...new Set([
    base,
    'http://localhost:5173',
    'http://localhost:8787',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8787',
    'http://[::1]:5173',
    'http://[::1]:8787',
    ...native,
  ])]
}

function credentialedCors(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    ...AUTH_CORS_ALLOW,
    ...API_SECURITY,
  }
}

/** Credentialed auth: echo an allowlisted Origin. Never ACAO * + credentials. */
export function authCors(origin: string | null | undefined, env: Env): Record<string, string> {
  const allowed = trustedAuthOrigins(env)
  const echoed = origin && allowed.includes(origin) ? origin : allowed[0]
  return credentialedCors(echoed)
}

/** JSON 500 when auth config throws. Echo ACAO+credentials only for loopback Origins. */
export function authConfigErrorResponse(
  origin: string | null | undefined,
  err: unknown,
): Response {
  const message = err instanceof Error ? err.message : String(err)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...API_SECURITY,
  }
  if (origin && isLocalAuthHost(origin)) {
    Object.assign(headers, credentialedCors(origin))
  }
  return new Response(JSON.stringify({ error: message }), { status: 500, headers })
}

export function beginAuthCors(
  origin: string | null | undefined,
  env: Env,
): { ok: true; cors: Record<string, string> } | { ok: false; response: Response } {
  try {
    return { ok: true, cors: authCors(origin, env) }
  } catch (err) {
    return { ok: false, response: authConfigErrorResponse(origin, err) }
  }
}

export function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...API_SECURITY, ...extra },
  })
}
