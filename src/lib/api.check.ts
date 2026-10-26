// Run: node --experimental-strip-types src/lib/api.check.ts
import { resolveApiBaseUrl } from './api.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(resolveApiBaseUrl(undefined).url === null, 'empty env keeps the Supabase path')
ok(resolveApiBaseUrl('').url === null, 'blank env keeps the Supabase path')
ok(resolveApiBaseUrl('  /api  ').url === '/api', 'web same-origin /api is accepted')
ok(resolveApiBaseUrl('/api').needsAbsolute === false, 'web relative /api does not need absolute')
ok(resolveApiBaseUrl('/api', true).needsAbsolute === true, 'iOS relative /api is rejected')
ok(resolveApiBaseUrl('https://zeroed.example.workers.dev/api', true).needsAbsolute === false, 'iOS absolute worker URL is ok')
ok(resolveApiBaseUrl('https://zeroed.example.workers.dev/api/', true).url === 'https://zeroed.example.workers.dev/api', 'trailing slash stripped')
ok(resolveApiBaseUrl('"https://zeroed.example.workers.dev/api"').url === 'https://zeroed.example.workers.dev/api', 'quoted paste is cleaned')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('api base url: ok')
