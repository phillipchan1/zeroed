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

export function trustedAuthOrigins(env: Env): string[] {
  const base = (env.BETTER_AUTH_URL || 'http://localhost:8787').replace(/\/+$/, '')
  return [...new Set([
    base,
    'http://localhost:5173',
    'http://localhost:8787',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8787',
  ])]
}

/** Credentialed auth: echo an allowlisted Origin. Never ACAO * + credentials. */
export function authCors(origin: string | null | undefined, env: Env): Record<string, string> {
  const allowed = trustedAuthOrigins(env)
  const echoed = origin && allowed.includes(origin) ? origin : allowed[0]
  return {
    'Access-Control-Allow-Origin': echoed,
    'Access-Control-Allow-Headers':
      'authorization, content-type, cookie, x-zeroed-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
    ...API_SECURITY,
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
