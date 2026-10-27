// Zeroed remote MCP — Streamable HTTP for Claude web/mobile custom connectors.
// Auth: opaque mcp_token bearer (verify_jwt off). Token → athlete_id.
// Tools match the local stdio MCP; no nested call into /agent.
import { admin } from '../_shared/admin.ts'
import { resolveMcpToken, tokenFrom, touchMcpToken } from '../_shared/mcpToken.ts'
import {
  handleMcpMethod,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../_shared/mcpProtocol.ts'
import { executeZeroedTool, ZEROED_TOOLS } from '../_shared/zeroedTools.ts'
import {
  ONBOARDING_SERVER_INSTRUCTIONS,
  listedZeroedTools,
  onboardingAgentV1On,
} from '../_shared/onboardingTools.ts'

const RATE_LIMIT_PER_MIN = 120

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-zeroed-token, mcp-session-id, last-event-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors, ...extra },
  })
}

function unauthorized(message = 'Invalid or revoked token'): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="zeroed"',
      ...cors,
    },
  })
}

const hits = new Map<string, number[]>()
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
      ...cors,
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const token = tokenFrom(req)
    if (!token) return unauthorized('Missing bearer token')
    const conn = await resolveMcpToken(token)
    if (!conn) return unauthorized()

    const { data: athlete } = await admin
      .from('athlete')
      .select('name')
      .eq('id', conn.athlete_id)
      .maybeSingle()
    const athleteLabel = (athlete?.name as string | null) ?? conn.name

    if (req.method === 'GET') {
      return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS', ...cors } })
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

    if (tooFast(conn.id)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded — slow down' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...cors },
      })
    }

    const raw = await req.json().catch(() => null)
    const extra = sessionHeaders(req)

    const onboardingOn = onboardingAgentV1On(Deno.env.get('ONBOARDING_AGENT_V1'))
    const tools = listedZeroedTools(ZEROED_TOOLS, onboardingOn)
    const run = async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
      return await handleMcpMethod(msg, tools, async (name, args) => {
        await touchMcpToken(conn.id)
        return await executeZeroedTool(conn.athlete_id, name, args, { onboardingAgentV1: onboardingOn })
      }, athleteLabel, onboardingOn ? ONBOARDING_SERVER_INSTRUCTIONS : undefined)
    }

    if (Array.isArray(raw)) {
      const replies: JsonRpcResponse[] = []
      for (const msg of raw) {
        if (!msg || typeof msg !== 'object') continue
        const reply = await run(msg as JsonRpcRequest)
        if (reply) replies.push(reply)
      }
      if (replies.length === 0) return new Response(null, { status: 202, headers: { ...cors, ...extra } })
      return wantsSse(req) ? sse(replies, extra) : json(replies, 200, extra)
    }

    if (!raw || typeof raw !== 'object') return json({ error: 'Expected a JSON-RPC object' }, 400)
    const reply = await run(raw as JsonRpcRequest)
    if (!reply) return new Response(null, { status: 202, headers: { ...cors, ...extra } })
    return wantsSse(req) ? sse(reply, extra) : json(reply, 200, extra)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[mcp]', msg)
    return json({ error: msg }, 500)
  }
})
