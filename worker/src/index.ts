import { Hono } from 'hono'
import { handleAgent } from './agent.ts'
import { AUTH_CORS } from './cors.ts'
import { getAuth } from './auth.ts'
import type { Env } from './env.ts'
import { handleMcp } from './mcp.ts'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'zeroed',
    runtime: 'cloudflare-workers',
  }),
)

app.all('/api/auth/*', async (c) => {
  if (c.req.method === 'OPTIONS') return new Response('ok', { headers: AUTH_CORS })
  try {
    const auth = getAuth(c.env)
    const res = await auth.handler(c.req.raw)
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(AUTH_CORS)) {
      if (!headers.has(k)) headers.set(k, v)
    }
    return new Response(res.body, { status: res.status, headers })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

app.all('/api/agent', (c) => handleAgent(c.req.raw, c.env))
app.all('/api/mcp', (c) => handleMcp(c.req.raw, c.env))

// Compatibility aliases so VITE_API_BASE_URL can point at either
// `https://<worker>/api` or the old `/functions/v1` prefix.
app.all('/functions/v1/agent', (c) => handleAgent(c.req.raw, c.env))
app.all('/functions/v1/mcp', (c) => handleMcp(c.req.raw, c.env))

export default app
