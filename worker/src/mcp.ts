import {
  handleMcpMethod,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../supabase/functions/_shared/mcpProtocol.ts'
import { MCP_CORS, json } from './cors.ts'
import { getSql } from './db.ts'
import type { Env } from './env.ts'
import { resolveMcpToken, tokenFrom, touchMcpToken } from './mcpToken.ts'
import { executeZeroedTool, ZEROED_TOOLS } from './tools.ts'

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

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: MCP_CORS })

  try {
    const token = tokenFrom(req)
    if (!token) return unauthorized('Missing bearer token')
    const sql = getSql(env)
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
    const extra = sessionHeaders(req)

    const run = async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
      return await handleMcpMethod(msg, ZEROED_TOOLS, async (name, args) => {
        await touchMcpToken(sql, conn.id)
        return await executeZeroedTool(sql, conn.athlete_id, name, args)
      }, athleteLabel)
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[mcp]', msg)
    return json({ error: msg }, 500, MCP_CORS)
  }
}
