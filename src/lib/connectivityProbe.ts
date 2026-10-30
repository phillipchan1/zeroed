/* The fetch the connectivity store sends to prove the API is reachable,
 * plus the classification that turns a probe (or a real request) into a
 * connectivity state.
 *
 * Isolated so the check file can import it without pulling React / the cache
 * layer (those modules use extensionless specifiers Node cannot resolve).
 */

export const PROBE_PARAM = 'zeroed-ping'     // sw.js passes these straight to the network
export const PROBE_TIMEOUT_MS = 6_000
export const PROBE_STRIKES = 2
/** A successful API response in this window is proof the network is up. */
export const RECENT_SUCCESS_MS = 60_000

/**
 * Fetch init for the connectivity probe. Must stay a CORS-simple GET.
 *
 * `cache: 'no-store'` is forbidden here. The Fetch spec appends
 * `Cache-Control: no-cache` (and WebKit also sends `Pragma: no-cache`) for
 * that cache mode. `Cache-Control` is not a CORS-safelisted request header, so
 * `mode: 'no-cors'` becomes a network error — the probe fails even though
 * GET /api/health is 200. On iOS (WKWebView) that flipped the badge to Offline
 * and the cache layer then skipped every revalidation.
 *
 * The `zeroed-ping` query param is the cache buster.
 */
export const CONNECTIVITY_PROBE_INIT = {
  method: 'GET',
  mode: 'no-cors',
} as const satisfies RequestInit

/** True when `init` would stay a CORS-simple GET that no-cors is allowed to send. */
export function isSimpleConnectivityProbe(init: RequestInit): boolean {
  if ((init.method ?? 'GET').toUpperCase() !== 'GET') return false
  if (init.mode != null && init.mode !== 'no-cors') return false
  if (init.cache != null && init.cache !== 'default') return false
  if (init.headers) return false
  return true
}

export function connectivityProbeUrl(base: string, seq: number): string {
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${PROBE_PARAM}=${seq}`
}

export type ProbeKind = 'ok' | 'timeout' | 'hard-fail'
export type Connectivity = 'online' | 'degraded' | 'offline'
export type ConnectivityBadge = 'offline' | 'slow' | null

/** What the corner pill should say for a connectivity state. */
export function connectivityBadge(status: Connectivity): ConnectivityBadge {
  if (status === 'offline') return 'offline'
  if (status === 'degraded') return 'slow'
  return null
}

export function connectivityBadgeLabel(badge: ConnectivityBadge): string | null {
  if (badge === 'offline') return 'Offline'
  if (badge === 'slow') return 'Slow connection'
  return null
}

export function classifyProbeFailure(err: unknown, timedOut: boolean): ProbeKind {
  if (timedOut) return 'timeout'
  const name = err && typeof err === 'object' && 'name' in err
    ? String((err as { name: unknown }).name)
    : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  return 'hard-fail'
}

/**
 * Run one probe. A response of any HTTP status is `ok`. Our own abort after
 * `timeoutMs` is `timeout`. A fetch that rejects with no response (typical
 * TypeError: Failed to fetch) is `hard-fail`.
 */
export async function runConnectivityProbe(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<ProbeKind> {
  const ctrl = new AbortController()
  let timedOut = false
  const bail = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  try {
    await fetchFn(url, { ...CONNECTIVITY_PROBE_INIT, signal: ctrl.signal })
    return 'ok'
  } catch (err) {
    return classifyProbeFailure(err, timedOut)
  } finally {
    clearTimeout(bail)
  }
}

export interface ConnectivityInput {
  current: Connectivity
  strikes: number
  outcome: ProbeKind
  navigatorOnline: boolean
  recentlyReachable: boolean
  strikeLimit?: number
}

export interface ConnectivityNext {
  status: Connectivity
  strikes: number
  badge: ConnectivityBadge
}

/**
 * Online is the default. Offline is only a hard network failure (fetch rejects
 * with no response) after the strike count. A slow or timed-out probe — while
 * `navigator.onLine` is true, any request recently succeeded, or we still
 * believe we are online/degraded — is `degraded`, never offline.
 */
export function nextConnectivity(input: ConnectivityInput): ConnectivityNext {
  const limit = input.strikeLimit ?? PROBE_STRIKES
  if (input.outcome === 'ok') {
    return { status: 'online', strikes: 0, badge: null }
  }

  if (input.outcome === 'timeout') {
    const stillHaveANetwork = input.navigatorOnline
      || input.recentlyReachable
      || input.current === 'online'
      || input.current === 'degraded'
    if (stillHaveANetwork) {
      return { status: 'degraded', strikes: 0, badge: 'slow' }
    }
    const strikes = input.strikes + 1
    const status: Connectivity = strikes >= limit ? 'offline' : input.current
    return { status, strikes, badge: connectivityBadge(status) }
  }

  const strikes = input.strikes + 1
  if (strikes >= limit) {
    return { status: 'offline', strikes, badge: 'offline' }
  }
  return {
    status: input.current,
    strikes,
    badge: connectivityBadge(input.current),
  }
}
