// Run: node --experimental-strip-types src/lib/useOnline.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONNECTIVITY_PROBE_INIT,
  connectivityProbeUrl,
  isSimpleConnectivityProbe,
} from './connectivityProbe.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const probeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'connectivityProbe.ts'), 'utf8')
const onlineSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'useOnline.ts'), 'utf8')

const initBlock = probeSrc.match(/export const CONNECTIVITY_PROBE_INIT = \{[\s\S]*?\} as const/)?.[0] ?? ''
ok(initBlock.includes("method: 'GET'"), 'probe init is GET')
ok(initBlock.includes("mode: 'no-cors'"), 'probe init is no-cors')
ok(!/cache\s*:/.test(initBlock), 'probe init object has no cache field')
ok(!/cache:\s*['"]no-store['"]/.test(onlineSrc), 'useOnline fetch call does not set cache: no-store')
ok(onlineSrc.includes('CONNECTIVITY_PROBE_INIT'), 'useOnline sends the shared simple-request init')
ok(onlineSrc.includes('connectivityProbeUrl'), 'useOnline cache-busts via the query helper')
ok(probeSrc.includes('zeroed-ping'), 'probe still cache-busts with zeroed-ping')

ok(isSimpleConnectivityProbe(CONNECTIVITY_PROBE_INIT), 'shipped probe init is a CORS-simple GET')
ok(
  !isSimpleConnectivityProbe({ ...CONNECTIVITY_PROBE_INIT, cache: 'no-store' }),
  'cache: no-store is not a simple probe (WebKit adds Cache-Control)',
)
ok(
  !isSimpleConnectivityProbe({ method: 'GET', mode: 'no-cors', headers: { 'Cache-Control': 'no-cache' } }),
  'an explicit Cache-Control header is not a simple probe',
)
ok(
  connectivityProbeUrl('https://zeroed.example/api/health', 3)
    === 'https://zeroed.example/api/health?zeroed-ping=3',
  'probe URL appends zeroed-ping',
)
ok(
  connectivityProbeUrl('https://zeroed.example/api/health?x=1', 1)
    === 'https://zeroed.example/api/health?x=1&zeroed-ping=1',
  'probe URL uses & when the base already has a query',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('useOnline probe: ok')
