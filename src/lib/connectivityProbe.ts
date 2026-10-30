/* The fetch the connectivity store sends to prove the API is reachable.
 *
 * Isolated so the check file can import it without pulling React / the cache
 * layer (those modules use extensionless specifiers Node cannot resolve).
 */

export const PROBE_PARAM = 'zeroed-ping'     // sw.js passes these straight to the network

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
