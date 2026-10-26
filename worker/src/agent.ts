import { TASKS, type TaskName } from '../../supabase/functions/agent/schemas.ts'
import { sessionUser } from './auth.ts'
import { AGENT_CORS, json } from './cors.ts'
import { getSql } from './db.ts'
import type { Env } from './env.ts'
import { checkProbeQuota } from './quota.ts'

function validate(value: unknown, schema: Record<string, unknown>): string | null {
  const types = ([] as string[]).concat(schema.type as string | string[])

  const matches = (t: string): boolean => {
    switch (t) {
      case 'null': return value === null
      case 'string': return typeof value === 'string'
      case 'number': return typeof value === 'number'
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'boolean': return typeof value === 'boolean'
      case 'array': return Array.isArray(value)
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      default: return false
    }
  }
  if (!types.some(matches)) return `expected ${types.join('|')}`
  if (value === null) return null

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `below minimum ${schema.minimum}`
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `above maximum ${schema.maximum}`
  }

  if (typeof value === 'string' && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `"${value}" not in enum`
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const r = validate(value[i], schema.items as Record<string, unknown>)
      if (r) return `[${i}] ${r}`
    }
  }

  if (matches('object') && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>
    const required = (schema.required as string[]) ?? []
    const obj = value as Record<string, unknown>
    for (const key of required) {
      if (!(key in obj)) return `missing "${key}"`
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        const r = validate(obj[key], sub)
        if (r) return `${key}: ${r}`
      }
    }
  }

  return null
}

function extractResponseText(body: unknown): string | null {
  const b = body as {
    output_text?: string
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
  }
  if (typeof b.output_text === 'string' && b.output_text.length > 0) return b.output_text

  if (Array.isArray(b.output)) {
    for (const item of b.output) {
      if (!Array.isArray(item.content)) continue
      for (const c of item.content) {
        if (c.type === 'refusal') return null
        if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
          return c.text
        }
      }
    }
  }
  return null
}

async function callOpenAI(
  env: Env,
  task: TaskName,
  payload: unknown,
  corrective: string | null,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  const spec = TASKS[task]
  const model = spec.heavy
    ? (env.OPENAI_MODEL_HEAVY || env.OPENAI_MODEL || 'gpt-5.4-nano')
    : (env.OPENAI_MODEL || 'gpt-5.4-nano')
  const key = env.OPENAI_API_KEY ?? ''

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: spec.system },
    { role: 'user', content: JSON.stringify(payload ?? {}) },
  ]
  if (corrective) {
    messages.push({
      role: 'user',
      content: `Your previous response failed validation: ${corrective}. Return ONLY valid JSON matching the schema.`,
    })
  }

  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: messages,
        text: {
          format: { type: 'json_schema', name: spec.schemaName, strict: true, schema: spec.schema },
        },
        reasoning: { effort: spec.effort ?? 'low' },
      }),
    })
  } catch (e) {
    return { ok: false, reason: `network: ${String(e)}` }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, reason: `openai ${res.status}: ${text.slice(0, 200)}` }
  }

  let raw: unknown
  try {
    const body = await res.json()
    const content = extractResponseText(body)
    if (content === null) return { ok: false, reason: 'no content / refusal' }
    raw = JSON.parse(content)
  } catch (e) {
    return { ok: false, reason: `parse: ${String(e)}` }
  }

  const violation = validate(raw, spec.schema)
  if (violation) return { ok: false, reason: violation }
  return { ok: true, data: raw }
}

export async function handleAgent(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: AGENT_CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, AGENT_CORS)
  if (!env.OPENAI_API_KEY) return json({ ok: false, error: 'server not configured' }, 500, AGENT_CORS)

  let body: { task?: string; payload?: unknown; device_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid json body' }, 400, AGENT_CORS)
  }

  const task = body.task as TaskName
  if (!task || !(task in TASKS)) {
    return json({ ok: false, error: `unknown task "${body.task}"` }, 400, AGENT_CORS)
  }
  const spec = TASKS[task]

  if (spec.preAuth) {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('cf-connecting-ip') ??
      req.headers.get('x-real-ip') ??
      null
    const deviceId = body.device_id ?? null
    try {
      const sql = getSql(env)
      const allowed = await checkProbeQuota(sql, deviceId, ip)
      if (!allowed) return json({ ok: false, error: 'rate_limited' }, 429, AGENT_CORS)
    } catch (err) {
      console.error('check_probe_quota failed:', err)
    }
  } else {
    const user = await sessionUser(env, req)
    if (!user) return json({ ok: false, error: 'unauthorized' }, 401, AGENT_CORS)
  }

  let result = await callOpenAI(env, task, body.payload, null)
  if (!result.ok) {
    result = await callOpenAI(env, task, body.payload, result.reason)
  }

  if (!result.ok) {
    console.error(`agent task=${task} failed:`, result.reason)
    return json({ ok: false, error: 'model_failed', reason: result.reason }, 200, AGENT_CORS)
  }

  return json({ ok: true, task, data: result.data }, 200, AGENT_CORS)
}
