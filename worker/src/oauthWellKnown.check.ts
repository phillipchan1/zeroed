// MCP is bearer-token only. /.well-known/oauth-* must be JSON 404, never SPA HTML.
// Run: node --experimental-strip-types worker/src/oauthWellKnown.check.ts
import app from './index.ts'
import type { Env } from './env.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const spaHtml = '<!doctype html><html><body>spa</body></html>'
const spaEnv = {
  ASSETS: {
    fetch: async () => new Response(spaHtml, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  },
} as Env

async function get(path: string, env: Env = spaEnv): Promise<Response> {
  return app.request(`http://localhost${path}`, { method: 'GET' }, env)
}

async function assertJson404(path: string, label: string): Promise<void> {
  const res = await get(path)
  const type = res.headers.get('content-type') ?? ''
  ok(res.status === 404, `${label}: 404 (got ${res.status})`)
  ok(type.includes('application/json'), `${label}: application/json (got ${type})`)
  ok(!type.includes('text/html'), `${label}: not HTML`)
  const body = await res.json() as { error?: string }
  ok(body.error === 'not_found', `${label}: JSON { error: "not_found" }`)
}

await assertJson404('/.well-known/oauth-protected-resource', 'oauth-protected-resource')
await assertJson404('/.well-known/oauth-protected-resource/mcp', 'oauth-protected-resource/mcp')
await assertJson404('/.well-known/oauth-authorization-server', 'oauth-authorization-server')
await assertJson404('/.well-known/oauth-authorization-server/mcp', 'oauth-authorization-server/mcp')

const spa = await get('/app/today')
ok(spa.status === 200, `SPA /app/today is 200 (got ${spa.status})`)
ok((spa.headers.get('content-type') ?? '').includes('text/html'), 'SPA /app/today is HTML')
ok((await spa.text()) === spaHtml, 'SPA /app/today still falls through to index.html')

const other = await get('/.well-known/openid-configuration')
ok(other.status === 200, `openid-configuration still hits assets (got ${other.status})`)
ok((other.headers.get('content-type') ?? '').includes('text/html'), 'openid-configuration is not intercepted')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('oauth well-known: ok')
