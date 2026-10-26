// Streamable HTTP JSON-RPC helpers for Zeroed MCP.
export const MCP_PROTOCOL_VERSION = '2025-03-26'
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}

export interface JsonRpcResult {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export type JsonRpcResponse = JsonRpcError | JsonRpcResult

export function isNotification(msg: JsonRpcRequest): boolean {
  return !('id' in msg) || msg.id === undefined
}

function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } }
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResult {
  return { jsonrpc: '2.0', id, result }
}

export const SERVER_INSTRUCTIONS = [
  "Zeroed is the athlete's live training log and program.",
  'Start almost every conversation with get_training_brief so you have the current week, open insights, and recent sessions.',
  'For what a main lift (squat, bench, deadlift, ohp) should be this week, call get_lift_model — working max, training max, trend, all-time best, last qualifying sets, and the next prescription with its reason line. Quote its numbers; never compute a load yourself.',
  'If the athlete tells you how they slept, how ready they feel, or how their knees are today, pass it to get_lift_model so the modifiers apply. A training-max change goes through set_training_max: preview first, confirm=true only after the athlete agrees.',
  'Chat against the record: list_workouts, get_workout, search_lifts, get_program_journey, get_coach_notes.',
  'To change the program: propose surgical edits (add/update/remove exercise or session), call preview_program_edits, show the diff, then apply_program_edits with confirm=true only after the athlete agrees.',
  'Never dump a whole new week. Code — not you — clamps sets, loads, and tracking types. Sessions cannot be deleted; drop work by removing exercises.',
  'Use timing=next_week when sessions this week have already been logged and should stay as written.',
  'The bearer token selected this athlete; you cannot switch users or pass an athlete id.',
].join(' ')

const ACTOR_KEYS = new Set(['user_id', 'userId', 'actingUserId', 'acting_user_id', 'athlete_id', 'athleteId'])

export function stripActorOverrides(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (ACTOR_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<string>

export async function handleMcpMethod(
  msg: JsonRpcRequest,
  tools: McpTool[],
  call: ToolCaller,
  athleteLabel?: string | null,
): Promise<JsonRpcResponse | null> {
  const id = (msg.id ?? null) as JsonRpcId
  const method = typeof msg.method === 'string' ? msg.method : ''

  if (isNotification(msg)) return null

  switch (method) {
    case 'initialize': {
      const params = (msg.params ?? {}) as { protocolVersion?: string }
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const protocolVersion = SUPPORTED_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION
      const who = athleteLabel
        ? ` You are connected as ${athleteLabel}. That is the only athlete this token can see.`
        : ''
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'zeroed', version: '1.0.0' },
        instructions: SERVER_INSTRUCTIONS + who,
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools })
    case 'resources/list':
      return ok(id, { resources: [] })
    case 'prompts/list':
      return ok(id, {
        prompts: [{
          name: 'coach',
          description: 'Open a coaching session against the live Zeroed log and current program.',
        }],
      })
    case 'prompts/get': {
      const params = (msg.params ?? {}) as { name?: string }
      if (params.name !== 'coach') return err(id, -32602, `Unknown prompt: ${params.name ?? ''}`)
      return ok(id, {
        description: 'Open a coaching session against the live Zeroed log and current program.',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: 'Call get_training_brief first. Then help me review my training from the record — lifts, sessions, insights, and the live week. Do not change the program unless I ask. If I ask to change it, preview_program_edits first and wait for my confirm before apply_program_edits.',
          },
        }],
      })
    }
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) return err(id, -32602, 'tools/call requires params.name')
      if (!tools.some((t) => t.name === name)) {
        return err(id, -32602, `Unknown tool: ${name}`)
      }
      const rawArgs =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      const args = stripActorOverrides(rawArgs)
      try {
        const text = await call(name, args)
        return ok(id, { content: [{ type: 'text', text }], isError: false })
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e)
        return ok(id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    default:
      return err(id, -32601, `Method not found: ${method || '(missing)'}`)
  }
}
