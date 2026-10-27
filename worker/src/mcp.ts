import {
  handleMcpMethod,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../supabase/functions/_shared/mcpProtocol.ts'
import { MCP_CORS, json } from './cors.ts'
import { withSql, type Sql, type WaitUntilArg } from './db.ts'
import type { Env } from './env.ts'
import { parseRpeHalfStepsFlag } from '../../src/engine/rpeScale.ts'
import { resolveMcpToken, tokenFrom, touchMcpToken } from './mcpToken.ts'
import { executeZeroedTool, ZEROED_TOOLS } from './tools.ts'
import { isMcpUserError } from './userError.ts'
import {
  ONBOARDING_SERVER_INSTRUCTIONS,
  listedZeroedTools,
  onboardingAgentV1On,
} from '../../supabase/functions/_shared/onboardingTools.ts'

/** Only McpUserError messages are shown. DB / runtime errors stay generic. */
export function publicMcpError(err: unknown): string {
  if (isMcpUserError(err)) return err.message
  return 'request failed'
}

export function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000')
  if (Array.isArray(value)) return value.some(containsNul)
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsNul)
  }
  return false
}

const RATE_LIMIT_PER_MIN = 120
const hits = new Map<string, number[]>()

function unauthorized(message = 'Invalid or revoked token'): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="zeroed"',
      ...MCP_CORS,
    },
  })
}

function tooFast(id: string): boolean {
  const now = Date.now()
  const recent = (hits.get(id) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    hits.set(id, recent)
    return true
  }
  recent.push(now)
  hits.set(id, recent)
  return false
}

function sse(payload: unknown, extra: Record<string, string> = {}): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...MCP_CORS,
      ...extra,
    },
  })
}

function wantsSse(req: Request): boolean {
  const accept = req.headers.get('Accept') ?? ''
  return accept.includes('text/event-stream') && !accept.includes('application/json')
}

function sessionHeaders(req: Request): Record<string, string> {
  const incoming = req.headers.get('mcp-session-id')?.trim()
  return {
    'mcp-protocol-version': req.headers.get('mcp-protocol-version')?.trim() || '2025-03-26',
    'mcp-session-id': incoming || crypto.randomUUID(),
  }
}

export type McpHandleOpts = {
  sql?: Sql
  ctx?: WaitUntilArg
}

function mcpWaitUntil(opts?: McpHandleOpts | WaitUntilArg): WaitUntilArg | undefined {
  if (!opts) return undefined
  if (typeof opts === 'function') return opts
  if ('waitUntil' in opts) return opts
  return opts.ctx
}

async function serveMcp(req: Request, sql: Sql, env?: Env): Promise<Response> {
  const token = tokenFrom(req)
  if (!token) return unauthorized('Missing bearer token')
  const conn = await resolveMcpToken(sql, token)
  if (!conn) return unauthorized()

  const [athlete] = await sql<{ name: string | null }[]>`
    SELECT name FROM athlete WHERE id = ${conn.athlete_id} LIMIT 1
  `
  const athleteLabel = athlete?.name ?? conn.name

  if (req.method === 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS', ...MCP_CORS } })
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, MCP_CORS)

  if (tooFast(conn.id)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded — slow down' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...MCP_CORS },
    })
  }

  const raw = await req.json().catch(() => null)
  if (containsNul(raw)) return json({ error: 'invalid input' }, 400, MCP_CORS)
  const extra = sessionHeaders(req)

  const onboardingOn = onboardingAgentV1On(env?.ONBOARDING_AGENT_V1)
  const tools = listedZeroedTools(ZEROED_TOOLS, onboardingOn)
  const run = async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    return await handleMcpMethod(msg, tools, async (name, args) => {
      await touchMcpToken(sql, conn.id)
      try {
        return await executeZeroedTool(sql, conn.athlete_id, name, args, {
          rpeHalfSteps: parseRpeHalfStepsFlag(env?.RPE_HALF_STEPS),
          onboardingAgentV1: onboardingOn,
        })
      } catch (err) {
        console.error('[mcp] tool', name, err instanceof Error ? err.message : String(err))
        throw new Error(publicMcpError(err))
      }
    }, athleteLabel, onboardingOn ? ONBOARDING_SERVER_INSTRUCTIONS : undefined)
  }

  if (Array.isArray(raw)) {
    const replies: JsonRpcResponse[] = []
    for (const msg of raw) {
      if (!msg || typeof msg !== 'object') continue
      const reply = await run(msg as JsonRpcRequest)
      if (reply) replies.push(reply)
    }
    if (replies.length === 0) return new Response(null, { status: 202, headers: { ...MCP_CORS, ...extra } })
    return wantsSse(req) ? sse(replies, extra) : json(replies, 200, { ...MCP_CORS, ...extra })
  }

  if (!raw || typeof raw !== 'object') return json({ error: 'Expected a JSON-RPC object' }, 400, MCP_CORS)
  const reply = await run(raw as JsonRpcRequest)
  if (!reply) return new Response(null, { status: 202, headers: { ...MCP_CORS, ...extra } })
  return wantsSse(req) ? sse(reply, extra) : json(reply, 200, { ...MCP_CORS, ...extra })
}

export async function handleMcp(
  req: Request,
  env: Env,
  opts?: McpHandleOpts | WaitUntilArg,
): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: MCP_CORS })

  try {
    if (opts && typeof opts === 'object' && 'sql' in opts && opts.sql) return await serveMcp(req, opts.sql, env)
    return await withSql(env, (sql) => serveMcp(req, sql, env), mcpWaitUntil(opts))
  } catch (e) {
    console.error('[mcp]', e instanceof Error ? e.message : String(e))
    return json({ error: 'request failed' }, 500, MCP_CORS)
  }
}
