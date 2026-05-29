// =============================================================================
// agent — the single server-side surface for every Zeroed model call.
//
// SECURITY: the OpenAI key lives ONLY here (project secret OPENAI_API_KEY). It
// never reaches the browser. Screens call this via supabase.functions.invoke.
//
// CONTRACT: body is { task, payload, device_id? }. Each task has a strict
// json_schema (see schemas.ts). We call OpenAI with that schema, parse, then
// RE-VALIDATE at runtime, retrying once on mismatch. On unrecoverable failure we
// return 200 { ok:false } so the client can fall back to the deterministic
// engine — the app must always function and always be safe.
//
// GATING: only the Probe runs pre-auth, and it is rate-limited per device/IP via
// check_probe_quota(). Every other task requires a valid user JWT.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { TASKS, type TaskName } from './schemas.ts'

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-5.4-nano'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Pre-auth probe budget: at most this many probes per device/IP per window.
const PROBE_MAX = 5
const PROBE_WINDOW_SECS = 3600

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ---- minimal runtime validator (defense in depth behind strict json_schema) --
// Returns null on success, or a short reason string on the first violation.
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

// Pull the model's structured-output text out of a Responses API body. Prefers
// the aggregated output_text; falls back to walking output[].content[]. Returns
// null on a refusal or empty output.
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
  task: TaskName,
  payload: unknown,
  corrective: string | null,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  const spec = TASKS[task]

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

  // GPT-5.x models are served via the Responses API. Structured output is
  // requested through text.format (json_schema, strict). Reasoning kept low —
  // these are classification/drafting tasks, not deep reasoning.
  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: messages,
        text: {
          format: { type: 'json_schema', name: spec.schemaName, strict: true, schema: spec.schema },
        },
        reasoning: { effort: 'low' },
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)

  if (!OPENAI_API_KEY) return json({ ok: false, error: 'server not configured' }, 500)

  let body: { task?: string; payload?: unknown; device_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid json body' }, 400)
  }

  const task = body.task as TaskName
  if (!task || !(task in TASKS)) {
    return json({ ok: false, error: `unknown task "${body.task}"` }, 400)
  }
  const spec = TASKS[task]

  // ---- gating -------------------------------------------------------------
  if (spec.preAuth) {
    // Probe: no JWT required, but rate-limit per device/IP.
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('x-real-ip') ??
      null
    const deviceId = body.device_id ?? null

    if (SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
      const { data: allowed, error } = await admin.rpc('check_probe_quota', {
        p_device: deviceId,
        p_ip: ip,
        p_max: PROBE_MAX,
        p_window_secs: PROBE_WINDOW_SECS,
      })
      if (error) {
        console.error('check_probe_quota failed:', error.message)
        // Fail closed on a throttle error would block all cold starts; the spec
        // wants the app to always function, so we fail OPEN here but log it.
      } else if (allowed === false) {
        return json({ ok: false, error: 'rate_limited' }, 429)
      }
    }
  } else {
    // Every other task requires a valid user JWT.
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ ok: false, error: 'unauthorized' }, 401)
    }
    const authed = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error } = await authed.auth.getUser()
    if (error || !userData?.user) {
      return json({ ok: false, error: 'unauthorized' }, 401)
    }
  }

  // ---- model call with one corrective retry -------------------------------
  let result = await callOpenAI(task, body.payload, null)
  if (!result.ok) {
    result = await callOpenAI(task, body.payload, result.reason)
  }

  if (!result.ok) {
    // Unrecoverable: tell the client to fall back to the deterministic engine.
    console.error(`agent task=${task} failed:`, result.reason)
    return json({ ok: false, error: 'model_failed', reason: result.reason })
  }

  return json({ ok: true, task, data: result.data })
})
