// Run: node --experimental-strip-types src/lib/useOnline.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONNECTIVITY_PROBE_INIT,
  connectivityBadge,
  connectivityBadgeLabel,
  connectivityProbeUrl,
  isSimpleConnectivityProbe,
  nextConnectivity,
  PROBE_STRIKES,
  PROBE_TIMEOUT_MS,
  runConnectivityProbe,
  type Connectivity,
  type ConnectivityBadge,
} from './connectivityProbe.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const probeSrc = readFileSync(join(here, 'connectivityProbe.ts'), 'utf8')
const onlineSrc = readFileSync(join(here, 'useOnline.ts'), 'utf8')
const barSrc = readFileSync(join(here, '../components/OfflineBar.tsx'), 'utf8')

const initBlock = probeSrc.match(/export const CONNECTIVITY_PROBE_INIT = \{[\s\S]*?\} as const/)?.[0] ?? ''
ok(initBlock.includes("method: 'GET'"), 'probe init is GET')
ok(initBlock.includes("mode: 'no-cors'"), 'probe init is no-cors')
ok(!/cache\s*:/.test(initBlock), 'probe init object has no cache field')
ok(!/cache:\s*['"]no-store['"]/.test(onlineSrc), 'useOnline fetch call does not set cache: no-store')
ok(onlineSrc.includes('CONNECTIVITY_PROBE_INIT'), 'useOnline still re-exports the simple-request init')
ok(onlineSrc.includes('connectivityProbeUrl'), 'useOnline cache-busts via the query helper')
ok(onlineSrc.includes('runConnectivityProbe'), 'useOnline runs the shared probe helper')
ok(onlineSrc.includes('nextConnectivity'), 'useOnline applies the shared state machine')
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

ok(onlineSrc.includes("status === 'offline'"), 'isKnownOffline is only the hard-offline state')
ok(onlineSrc.includes('useConnectivity'), 'store exposes the three-state hook')
ok(barSrc.includes('useConnectivity'), 'badge reads the three-state hook')
ok(barSrc.includes('conn-pill--degraded'), 'badge has a degraded surface')
ok(barSrc.includes('Slow connection'), 'degraded label is Slow connection')
ok(barSrc.includes("badge === 'slow'"), 'degraded badge never uses the Offline branch')

function step(
  current: Connectivity,
  strikes: number,
  outcome: Parameters<typeof nextConnectivity>[0]['outcome'],
  extra: Partial<Parameters<typeof nextConnectivity>[0]> = {},
) {
  return nextConnectivity({
    current,
    strikes,
    outcome,
    navigatorOnline: extra.navigatorOnline ?? true,
    recentlyReachable: extra.recentlyReachable ?? false,
    strikeLimit: extra.strikeLimit ?? PROBE_STRIKES,
    ...extra,
  })
}

function badgeFor(status: Connectivity): ConnectivityBadge {
  return connectivityBadge(status)
}

// ---- latency: response arrives after PROBE_TIMEOUT_MS ----------------------
{
  const n = step('online', 0, 'timeout', { navigatorOnline: true })
  ok(n.status === 'degraded', 'latency: timeout while navigator.onLine → degraded')
  ok(n.badge === 'slow', 'latency: badge is slow, not offline')
  ok(connectivityBadgeLabel(n.badge) === 'Slow connection', 'latency: label is Slow connection')
  ok(n.status !== 'offline', 'latency: never Offline on a timed-out probe')
}

{
  const n = step('online', 0, 'timeout', { navigatorOnline: false, recentlyReachable: true })
  ok(n.status === 'degraded', 'latency: timeout after a recent successful request → degraded')
  ok(n.badge === 'slow', 'latency + recent success: Slow connection, not Offline')
}

{
  const n = step('degraded', 0, 'timeout', { navigatorOnline: true })
  ok(n.status === 'degraded', 'another timeout while degraded stays degraded')
  ok(n.badge === 'slow', 'repeated timeout does not escalate to Offline')
}

{
  // Two timeouts from default-online, navigator.onLine true — the gym case.
  const first = step('online', 0, 'timeout', { navigatorOnline: true })
  const second = step(first.status, first.strikes, 'timeout', { navigatorOnline: true })
  ok(first.status === 'degraded' && second.status === 'degraded',
    `gym weak signal: two timeouts stay degraded (got ${first.status} → ${second.status})`)
  ok(second.badge === 'slow', 'gym weak signal badge: Slow connection')
}

// ---- packet loss: intermittent hard rejects --------------------------------
{
  const miss = step('online', 0, 'hard-fail', { navigatorOnline: true })
  ok(miss.status === 'online', 'packet loss: one hard-fail is a strike, still online')
  ok(miss.badge === null, 'packet loss: one miss shows no badge')
  ok(miss.strikes === 1, 'packet loss: first hard-fail increments strikes')
}

{
  const miss = step('online', 0, 'hard-fail')
  const recovered = step(miss.status, miss.strikes, 'ok')
  ok(recovered.status === 'online' && recovered.strikes === 0,
    'packet loss: a later success resets to online')
  ok(recovered.badge === null, 'packet loss + success: no badge')
}

{
  const a = step('online', 0, 'hard-fail')
  const b = step(a.status, a.strikes, 'hard-fail')
  ok(b.status === 'offline', 'packet loss: consecutive hard-fails after PROBE_STRIKES → offline')
  ok(b.badge === 'offline', 'consecutive hard-fails badge: Offline')
  ok(connectivityBadgeLabel(b.badge) === 'Offline', 'offline label is Offline')
}

{
  const miss = step('online', 0, 'hard-fail')
  const timeout = step(miss.status, miss.strikes, 'timeout', { navigatorOnline: true })
  ok(timeout.status === 'degraded', 'hard-fail then timeout (onLine) is degraded, not offline')
  ok(timeout.badge === 'slow', 'hard-fail then timeout badge: Slow connection')
}

// ---- timeout-then-success --------------------------------------------------
{
  const timed = step('online', 0, 'timeout', { navigatorOnline: true })
  const recovered = step(timed.status, timed.strikes, 'ok')
  ok(timed.status === 'degraded' && recovered.status === 'online',
    'timeout-then-success: degraded, then online')
  ok(timed.badge === 'slow' && recovered.badge === null,
    'timeout-then-success badges: Slow connection → (none)')
}

{
  const n = step('offline', 2, 'ok')
  ok(n.status === 'online' && n.strikes === 0, 'any success is proof of online, even from offline')
  ok(n.badge === null, 'success from offline: no badge')
}

{
  // Airplane / no network: navigator offline, no recent success, already offline,
  // a timeout may stay offline. Hard-fail is what actually flips it.
  const fromOnline = step('offline', 0, 'timeout', { navigatorOnline: false, recentlyReachable: false })
  ok(fromOnline.status === 'offline' || fromOnline.strikes >= 1,
    'timeout with no network evidence can count toward offline')
}

{
  const a = step('online', 0, 'hard-fail', { navigatorOnline: false })
  const b = step(a.status, a.strikes, 'hard-fail', { navigatorOnline: false })
  ok(b.status === 'offline' && b.badge === 'offline',
    'airplane-mode hard-fails still reach Offline')
}

ok(PROBE_TIMEOUT_MS === 6000, 'shipped probe timeout stays 6s')
ok(PROBE_STRIKES === 2, 'shipped strike count stays 2')
ok(badgeFor('online') === null, 'online badge is hidden')
ok(badgeFor('degraded') === 'slow', 'degraded badge is slow')
ok(badgeFor('offline') === 'offline', 'offline badge is offline')

// ---- live probe with delayed / rejected fetch ------------------------------
const SHORT = 40

function delayFetch(ms: number): typeof fetch {
  return ((_url, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(null, { status: 204 })), ms)
    const signal = init && 'signal' in init ? init.signal : null
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })) as typeof fetch
}

function rejectFetch(): typeof fetch {
  return (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
}

function intermittentFetch(): typeof fetch {
  let n = 0
  return (async () => {
    n += 1
    if (n % 2 === 1) throw new TypeError('Failed to fetch')
    return new Response(null, { status: 204 })
  }) as typeof fetch
}

{
  const kind = await runConnectivityProbe(delayFetch(SHORT * 4), 'https://zeroed.example/api/health', SHORT)
  ok(kind === 'timeout', `delayed past timeout is timeout (got ${kind})`)
  const n = step('online', 0, kind, { navigatorOnline: true })
  ok(n.status === 'degraded' && n.badge === 'slow',
    `delayed probe badge: ${connectivityBadgeLabel(n.badge)} (degraded)`)
}

{
  const kind = await runConnectivityProbe(delayFetch(5), 'https://zeroed.example/api/health', SHORT * 4)
  ok(kind === 'ok', `response inside the window is ok (got ${kind})`)
  const n = step('degraded', 0, kind)
  ok(n.status === 'online' && n.badge === null, 'in-window response: online, no badge')
}

{
  const kind = await runConnectivityProbe(rejectFetch(), 'https://zeroed.example/api/health', SHORT)
  ok(kind === 'hard-fail', `fast reject with no response is hard-fail (got ${kind})`)
}

{
  const flaky = intermittentFetch()
  const first = await runConnectivityProbe(flaky, 'https://zeroed.example/api/health', SHORT)
  const second = await runConnectivityProbe(flaky, 'https://zeroed.example/api/health', SHORT)
  ok(first === 'hard-fail' && second === 'ok',
    `packet-loss fetch: reject then ok (got ${first}, ${second})`)
  const afterMiss = step('online', 0, first)
  const afterOk = step(afterMiss.status, afterMiss.strikes, second)
  ok(afterOk.status === 'online' && afterOk.badge === null,
    'packet-loss then success: online, no badge')
}

ok(onlineSrc.includes('reportReachable'), 'any successful API still reports reachable')
ok(onlineSrc.includes('lastReachableAt'), 'successful requests stamp recent reachability')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('useOnline probe + degraded: ok')
