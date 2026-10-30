/* Connectivity awareness — a *verified* online/offline store, plus the events the
 * service worker raises when a new build is ready.
 *
 * Why this isn't just `navigator.onLine`: that flag is a hint, not a fact, and it
 * lies in exactly the environment Zeroed runs in. A home-screen PWA on iOS can
 * report `onLine === false` on a cold launch, or after being resumed from the
 * background, while every request in flight is succeeding — and because WebKit
 * only fires `online` on a transition it actually observed, no event ever arrives
 * to correct the stale value. Reading the flag directly meant two bugs at once:
 * a permanent "offline" banner on a perfectly good connection, and a cache layer
 * that skipped every revalidation, so the app quietly stopped catching up on real
 * data too.
 *
 * So: online is the default, and offline is a claim that has to be proven.
 *   - Evidence comes from real requests (the cache layer reports success and
 *     failure) and from a tiny probe against the API we actually depend on.
 *   - We flip to offline only after PROBE_STRIKES consecutive failed probes.
 *   - Any single success flips straight back to online.
 *   - While offline we keep probing — on a timer and on every resume signal
 *     (visibility, focus, pageshow) — so recovery never depends on an `online`
 *     event that may never fire.
 *
 * The bias is deliberate: a missed "offline" costs nothing (the app is offline
 * first — cached data keeps painting, writes queue in the outbox), while a false
 * "offline" is a lie on screen and a stalled data layer behind it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { supabaseUrl } from './supabaseClient'
import { healthUrl } from './api'
import {
  CONNECTIVITY_PROBE_INIT,
  connectivityProbeUrl,
} from './connectivityProbe'

export { CONNECTIVITY_PROBE_INIT, connectivityProbeUrl, isSimpleConnectivityProbe, PROBE_PARAM } from './connectivityProbe'

// Reaching the app's own origin proves very little (a service worker or the
// bundled native shell can answer it), so the probe targets the API the loop
// actually needs. Supabase's auth health endpoint is unauthenticated and tiny;
// `no-cors` means we never depend on its CORS headers — an opaque response still
// tells us the request reached a server, which is the only thing we're asking.
const PROBE_URL = healthUrl()
  ?? (supabaseUrl.includes('placeholder')
    ? '/favicon.ico'
    : `${supabaseUrl}/auth/v1/health`)
const PROBE_TIMEOUT_MS = 6_000

// Two failed probes before we say "offline" out loud. The first failure schedules
// the second quickly, so a real disconnection still surfaces in a couple of
// seconds — this only filters out single blips.
const PROBE_STRIKES = 2
const CONFIRM_MS = 1_500              // gap between the first strike and the next probe
const RECHECK_MS = 8_000              // how often we re-probe while believed offline

// ---- the store -------------------------------------------------------------

let online = true
let strikes = 0
let probing: Promise<boolean> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let probeSeq = 0

const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((fn) => fn())
}

function setOnline(next: boolean): void {
  if (next === online) return
  online = next
  emit()
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleRecheck(delay: number): void {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    // Nothing on screen to correct while backgrounded — wait for the resume
    // signal instead of burning the radio on a hidden tab.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      scheduleRecheck(RECHECK_MS)
      return
    }
    void verifyReachable()
  }, delay)
}

/** True only when we have PROVEN we can't reach the API. Never a guess. */
export function isKnownOffline(): boolean {
  return !online
}

export function subscribeOnline(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * A real request succeeded. That's proof of connectivity, whatever
 * `navigator.onLine` claims — so it resets the strike count immediately and
 * cancels any pending re-check.
 */
export function reportReachable(): void {
  strikes = 0
  clearTimer()
  setOnline(true)
}

/**
 * A real request failed. That's a *hint*, not proof — it could equally be a 500,
 * a bad row, or one flaky call — so it triggers verification rather than flipping
 * the state.
 */
export function reportUnreachable(): void {
  void verifyReachable()
}

// ---- probing ---------------------------------------------------------------

async function probeOnce(): Promise<boolean> {
  if (typeof fetch === 'undefined') return true
  const ctrl = new AbortController()
  const bail = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    // Cache-busted via the query param, service-worker-bypassed (sw.js lets
    // `zeroed-ping` through). Any HTTP status counts — even a 404 proves we
    // reached a server. `cache` is omitted on purpose: see CONNECTIVITY_PROBE_INIT.
    await fetch(connectivityProbeUrl(PROBE_URL, ++probeSeq), {
      ...CONNECTIVITY_PROBE_INIT,
      signal: ctrl.signal,
    })
    return true
  } catch {
    return false // network failure or timeout — the only signal we trust for "offline"
  } finally {
    clearTimeout(bail)
  }
}

/**
 * Confirm reachability. Concurrent callers share one probe. Resolves true when we
 * reached the API; a failure only counts as offline once it has happened
 * PROBE_STRIKES times in a row.
 */
export function verifyReachable(): Promise<boolean> {
  if (probing) return probing
  probing = probeOnce()
    .then((ok) => {
      if (ok) {
        reportReachable()
      } else {
        strikes += 1
        if (strikes >= PROBE_STRIKES) setOnline(false)
        scheduleRecheck(strikes < PROBE_STRIKES ? CONFIRM_MS : RECHECK_MS)
      }
      return ok
    })
    .finally(() => { probing = null })
  return probing
}

// ---- global watchers -------------------------------------------------------

// Re-probe on resume, but only when we currently believe we're offline: if we
// think we're online and we're wrong, the next real request will say so, and
// there's no reason to spend a request on every tab switch.
function onResume(): void {
  if (!online) void verifyReachable()
}

if (typeof window !== 'undefined') {
  // Both browser events are treated as hints to verify, not as answers. `online`
  // in particular fires before connectivity is usable often enough that trusting
  // it would just re-introduce the flapping.
  window.addEventListener('online', () => { void verifyReachable() })
  window.addEventListener('offline', () => { void verifyReachable() })
  window.addEventListener('focus', onResume)
  window.addEventListener('pageshow', onResume)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onResume()
  })

  // If the browser insists we're offline at boot, check rather than believe it —
  // this is the exact case that used to pin the banner open for a whole session.
  if (navigator.onLine === false) void verifyReachable()
}

// ---- hooks -----------------------------------------------------------------

/** Subscribe to verified connectivity. `true` until proven otherwise. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => online,
    () => true,
  )
}

// Fired by pwa.ts when a new service worker has installed and is waiting.
export const SW_UPDATE_EVENT = 'zeroed:sw-update'

export function useServiceWorkerUpdate(): { updateReady: boolean; applyUpdate: () => void } {
  const [updateReady, setUpdateReady] = useState(false)

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true)
    window.addEventListener(SW_UPDATE_EVENT, onUpdate)
    return () => window.removeEventListener(SW_UPDATE_EVENT, onUpdate)
  }, [])

  const applyUpdate = () => {
    // The waiting worker is told to take over; pwa.ts reloads on controllerchange.
    navigator.serviceWorker?.getRegistration().then((reg) => {
      reg?.waiting?.postMessage('SKIP_WAITING')
    })
  }

  return { updateReady, applyUpdate }
}
