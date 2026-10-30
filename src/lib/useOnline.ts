/* Connectivity awareness — a *verified* online / degraded / offline store, plus
 * the events the service worker raises when a new build is ready.
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
 *   - A probe *timeout* (slow gym signal) is `degraded`, not offline, while
 *     `navigator.onLine` is true or any request recently succeeded.
 *   - We flip to offline only after PROBE_STRIKES consecutive *hard* failures
 *     (fetch rejects with no response).
 *   - Any single successful API response anywhere flips straight back to online.
 *   - While offline or degraded we keep probing — on a timer and on every resume
 *     signal (visibility, focus, pageshow) — so recovery never depends on an
 *     `online` event that may never fire.
 *
 * The bias is deliberate: a missed "offline" costs nothing (the app is offline
 * first — cached data keeps painting, writes queue in the outbox), while a false
 * "offline" is a lie on screen and a stalled data layer behind it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { supabaseUrl } from './supabaseClient'
import { healthUrl } from './api'
import {
  connectivityProbeUrl,
  nextConnectivity,
  PROBE_STRIKES,
  PROBE_TIMEOUT_MS,
  RECENT_SUCCESS_MS,
  runConnectivityProbe,
  type Connectivity,
  type ProbeKind,
} from './connectivityProbe'

export { CONNECTIVITY_PROBE_INIT, connectivityProbeUrl, isSimpleConnectivityProbe, PROBE_PARAM } from './connectivityProbe'
export type { Connectivity } from './connectivityProbe'

// Reaching the app's own origin proves very little (a service worker or the
// bundled native shell can answer it), so the probe targets the API the loop
// actually needs. Supabase's auth health endpoint is unauthenticated and tiny;
// `no-cors` means we never depend on its CORS headers — an opaque response still
// tells us the request reached a server, which is the only thing we're asking.
const PROBE_URL = healthUrl()
  ?? (supabaseUrl.includes('placeholder')
    ? '/favicon.ico'
    : `${supabaseUrl}/auth/v1/health`)
const CONFIRM_MS = 1_500              // gap between the first strike and the next probe
const RECHECK_MS = 8_000              // how often we re-probe while believed offline

// ---- the store -------------------------------------------------------------

let status: Connectivity = 'online'
let strikes = 0
let lastReachableAt = 0
let probing: Promise<boolean> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let probeSeq = 0

const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((fn) => fn())
}

function setStatus(next: Connectivity): void {
  if (next === status) return
  status = next
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

function applyOutcome(outcome: ProbeKind): boolean {
  const navigatorOnline = typeof navigator === 'undefined' || navigator.onLine !== false
  const recentlyReachable = lastReachableAt > 0 && Date.now() - lastReachableAt < RECENT_SUCCESS_MS
  const next = nextConnectivity({
    current: status,
    strikes,
    outcome,
    navigatorOnline,
    recentlyReachable,
    strikeLimit: PROBE_STRIKES,
  })
  strikes = next.strikes
  if (outcome === 'ok') lastReachableAt = Date.now()
  setStatus(next.status)
  if (outcome === 'ok') clearTimer()
  else scheduleRecheck(strikes > 0 && strikes < PROBE_STRIKES ? CONFIRM_MS : RECHECK_MS)
  return outcome === 'ok'
}

/** True only when we have PROVEN we can't reach the API. Never a guess.
 *  Degraded (slow / timed-out probe) is not offline — revalidation still runs. */
export function isKnownOffline(): boolean {
  return status === 'offline'
}

export function getConnectivity(): Connectivity {
  return status
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
  lastReachableAt = Date.now()
  applyOutcome('ok')
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

/**
 * Confirm reachability. Concurrent callers share one probe. Resolves true when we
 * reached the API. A timeout is degraded (never offline while the browser still
 * says we have a network, or any request recently succeeded). A hard failure
 * only counts as offline once it has happened PROBE_STRIKES times in a row.
 */
export function verifyReachable(): Promise<boolean> {
  if (probing) return probing
  probing = runConnectivityProbe(fetch, connectivityProbeUrl(PROBE_URL, ++probeSeq), PROBE_TIMEOUT_MS)
    .then((outcome) => applyOutcome(outcome))
    .finally(() => { probing = null })
  return probing
}

// ---- global watchers -------------------------------------------------------

// Re-probe on resume when we don't currently believe we're cleanly online:
// degraded may recover, and offline must not wait for an `online` event that
// iOS often never fires.
function onResume(): void {
  if (status !== 'online') void verifyReachable()
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

/** Subscribe to verified connectivity. `true` until proven offline.
 *  Degraded (slow connection) still reads as online so the cache keeps trying. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => status !== 'offline',
    () => true,
  )
}

/** Three-state connectivity for the badge. */
export function useConnectivity(): Connectivity {
  return useSyncExternalStore(
    subscribeOnline,
    () => status,
    () => 'online',
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
