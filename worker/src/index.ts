import { Hono } from 'hono'
import { handleAgent } from './agent.ts'
import { API_SECURITY, AUTH_CORS } from './cors.ts'
import { getAuth } from './auth.ts'
import type { Env } from './env.ts'
import { handleMcp } from './mcp.ts'

const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  await next()
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/api/') || path.startsWith('/functions/v1/')) {
    for (const [key, value] of Object.entries(API_SECURITY)) {
      c.res.headers.set(key, value)
    }
  }
})

function missingAsset(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      ...API_SECURITY,
    },
  })
}

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

// Hashed Vite assets must 404 when missing — SPA fallback would serve
// index.html and the browser would try to execute HTML as JS.
app.all('/assets/*', async (c) => {
  const assets = c.env.ASSETS
  if (!assets) return missingAsset()
  const res = await assets.fetch(c.req.raw)
  const contentType = res.headers.get('content-type') ?? ''
  if (res.status === 404 || contentType.includes('text/html')) return missingAsset()
  return res
})

export default app
