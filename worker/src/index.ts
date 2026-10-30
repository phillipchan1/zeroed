import { Hono } from 'hono'
import { handleAgent } from './agent.ts'
import { API_SECURITY, HEALTH_CORS, beginAuthCors, json } from './cors.ts'
import { handleData } from './data.ts'
import { authFailureMessage, handleAuthRequest } from './auth.ts'
import type { Env } from './env.ts'
import { handleMcp } from './mcp.ts'
import type { WaitUntil } from './db.ts'

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

app.on(['OPTIONS', 'GET'], '/api/health', (c) => {
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEALTH_CORS })
  return json({
    ok: true,
    service: 'zeroed',
    runtime: 'cloudflare-workers',
  }, 200, HEALTH_CORS)
})

function waitUntilOf(c: { executionCtx?: { waitUntil?: WaitUntil } }): WaitUntil | undefined {
  const wait = c.executionCtx?.waitUntil
  return wait ? (task) => wait.call(c.executionCtx, task) : undefined
}

app.all('/api/auth/*', async (c) => {
  const started = beginAuthCors(c.req.header('Origin'), c.env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (c.req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const res = await handleAuthRequest(c.env, c.req.raw, waitUntilOf(c))
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors)) {
      if (k === 'Access-Control-Allow-Origin' || !headers.has(k)) headers.set(k, v)
    }
    headers.delete('Access-Control-Allow-Credentials')
    if (cors['Access-Control-Allow-Credentials']) {
      headers.set('Access-Control-Allow-Credentials', 'true')
    }
    if (headers.get('Access-Control-Allow-Origin') === '*' && headers.get('Access-Control-Allow-Credentials') === 'true') {
      headers.set('Access-Control-Allow-Origin', cors['Access-Control-Allow-Origin'])
    }
    return new Response(res.body, { status: res.status, headers })
  } catch (err) {
    return new Response(JSON.stringify({ error: authFailureMessage(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    })
  }
})

app.all('/api/agent', (c) => handleAgent(c.req.raw, c.env, waitUntilOf(c)))
app.all('/api/mcp', (c) => handleMcp(c.req.raw, c.env, waitUntilOf(c)))
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, waitUntilOf(c)))
app.all('/api/data', (c) => handleData(c.req.raw, c.env, waitUntilOf(c)))

// Compatibility aliases so VITE_API_BASE_URL can point at either
// `https://<worker>/api` or the old `/functions/v1` prefix.
app.all('/functions/v1/agent', (c) => handleAgent(c.req.raw, c.env, waitUntilOf(c)))
app.all('/functions/v1/mcp', (c) => handleMcp(c.req.raw, c.env, waitUntilOf(c)))

// Hashed Vite assets must 404 when missing — SPA fallback would serve
// index.html and the browser would try to execute HTML as JS.
function hasFileExtension(path: string): boolean {
  return /\.[A-Za-z0-9]{1,16}$/.test(path)
}

async function fromAssets(c: { env: Env; req: { raw: Request; url: string } }): Promise<Response> {
  const assets = c.env.ASSETS
  if (!assets) return missingAsset()
  const res = await assets.fetch(c.req.raw)
  const path = new URL(c.req.url).pathname
  const contentType = res.headers.get('content-type') ?? ''
  if (hasFileExtension(path) && (res.status === 404 || contentType.includes('text/html'))) {
    return missingAsset()
  }
  return res
}

app.all('/assets/*', (c) => fromAssets(c))

// Unknown paths with a file extension are real 404s. Extensionless deep
// links still fall through to the SPA document.
app.all('*', (c) => fromAssets(c))

export default app
