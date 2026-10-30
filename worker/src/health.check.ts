// Run: node --experimental-strip-types worker/src/health.check.ts
import app from './index.ts'
import { HEALTH_CORS } from './cors.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(HEALTH_CORS['Access-Control-Allow-Origin'] === '*', 'health CORS allows any origin')
ok(
  (HEALTH_CORS['Access-Control-Allow-Methods'] ?? '').includes('OPTIONS'),
  'health CORS allows OPTIONS',
)
ok(
  (HEALTH_CORS['Access-Control-Allow-Methods'] ?? '').includes('GET'),
  'health CORS allows GET',
)

const options = await app.request('http://localhost/api/health', {
  method: 'OPTIONS',
  headers: { Origin: 'capacitor://localhost' },
})
ok(options.status === 204, `OPTIONS /api/health is 204 (got ${options.status})`)
ok(
  options.headers.get('access-control-allow-origin') === '*',
  'OPTIONS /api/health sends ACAO',
)
ok(
  (options.headers.get('access-control-allow-methods') ?? '').includes('GET'),
  'OPTIONS /api/health allows GET',
)

const get = await app.request('http://localhost/api/health', {
  method: 'GET',
  headers: { Origin: 'capacitor://localhost' },
})
ok(get.status === 200, `GET /api/health is 200 (got ${get.status})`)
ok(get.headers.get('access-control-allow-origin') === '*', 'GET /api/health sends ACAO')
const body = await get.json() as { ok?: boolean; service?: string }
ok(body.ok === true && body.service === 'zeroed', 'GET /api/health body is the health payload')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('health CORS: ok')
