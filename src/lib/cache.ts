/* Offline-first data store — a two-tier, subscription-backed cache with
 * stale-while-revalidate reads.
 *
 * The doctrine here is "the screen never waits": every read resolves from a
 * value we already hold and paints on the FIRST frame, then a network fetch
 * revalidates in the background and swaps in fresh data when (and only when) it
 * lands. On a slow or dead connection the held value simply stays — the UI never
 * blocks on the wire, and no screen in the loop shows a spinner for data it has
 * seen before.
 *
 * Two tiers:
 *   L1 — a module-level Map. Survives unmount/remount, so tab-to-tab navigation
 *        is a synchronous object lookup: no JSON.parse, no re-render churn, no
 *        refetch. This is what makes navigation feel instant rather than merely
 *        fast.
 *   L2 — localStorage. Survives a cold launch / the PWA being killed, so the
 *        first paint after a relaunch is also from cache. Hydrated into L1 on
 *        first touch of a key, written through on every update.
 *
 * Three rules keep the network off the critical path:
 *   1. FRESHNESS WINDOW — a key fetched within `freshMs` is not refetched. Tab
 *      switching inside that window costs zero requests.
 *   2. DEDUPE — concurrent readers of one key share a single in-flight promise.
 *   3. OFFLINE SKIP — revalidation isn't attempted while the browser reports
 *      offline; it runs on the `online` event instead.
 *
 * Writes that change data the cache holds should call `mutateCache` (paint the
 * new truth immediately) and/or `invalidateCache` (let the next reader refetch).
 *
 * Scope: Zeroed holds a small amount of per-athlete data, so persisting whole
 * composed view objects under a handful of keys is plenty — no IndexedDB, no
 * query engine. Keys are namespaced by a schema version so a shape change in a
 * new deploy transparently invalidates everything stale.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isKnownOffline, reportReachable, reportUnreachable, subscribeOnline } from './useOnline'

// Bump when a cached object's SHAPE changes incompatibly — old entries under
// the prior version are ignored (and swept on next write).
const CACHE_SCHEMA = 'v1'
const PREFIX = `zeroed:cache:${CACHE_SCHEMA}:`

// How long a fetched value is treated as fresh enough to skip revalidation.
// Long enough that moving between tabs never hits the network; short enough
// that returning to the app after a while catches up on its own.
const DEFAULT_FRESH_MS = 60_000

interface Envelope<T> {
  v: string
  at: number
  data: T
}

/** A held value plus when it was last known-good. `at: 0` ⇒ due for refetch. */
interface Entry<T> {
  data: T
  at: number
}

// ---- the store -------------------------------------------------------------

// `null` records a known miss (disk already checked) so a cold key doesn't
// re-parse localStorage on every render.
const memory = new Map<string, Entry<unknown> | null>()
const inflight = new Map<string, Promise<unknown>>()
const listeners = new Map<string, Set<() => void>>()

function storageKey(key: string): string {
  return `${PREFIX}${key}`
}

function readDisk<T>(key: string): Entry<T> | null {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return null
    const env = JSON.parse(raw) as Envelope<T>
    if (env.v !== CACHE_SCHEMA) return null
    return { data: env.data, at: typeof env.at === 'number' ? env.at : 0 }
  } catch {
    return null
  }
}

function writeDisk<T>(key: string, entry: Entry<T>): void {
  try {
    const env: Envelope<T> = { v: CACHE_SCHEMA, at: entry.at, data: entry.data }
    localStorage.setItem(storageKey(key), JSON.stringify(env))
  } catch {
    /* storage full or unavailable — L1 still serves this session */
  }
}

/** The held entry for a key, hydrating from disk on first touch. */
function getEntry<T>(key: string): Entry<T> | null {
  if (memory.has(key)) return memory.get(key) as Entry<T> | null
  const disk = readDisk<T>(key)
  memory.set(key, disk)
  return disk
}

function notify(key: string): void {
  listeners.get(key)?.forEach((fn) => fn())
}

function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(key)
  }
}

/** Store a value and stamp its freshness. Wakes every mounted reader. */
function setEntry<T>(key: string, data: T, at = Date.now()): void {
  const entry: Entry<T> = { data, at }
  memory.set(key, entry as Entry<unknown>)
  writeDisk(key, entry)
  notify(key)
}

// ---- public reads / writes -------------------------------------------------

/** Synchronously read a cached value, or null on miss. */
export function loadCache<T>(key: string): T | null {
  const entry = getEntry<T>(key)
  return entry ? entry.data : null
}

/** Persist a value and wake every reader of the key. */
export function saveCache<T>(key: string, data: T): void {
  setEntry(key, data)
}

/**
 * Rewrite a held value in place — the optimistic-write path. The entry keeps its
 * original freshness stamp, so the change paints instantly AND the next reader
 * still revalidates against the server. Returns false when nothing is held yet
 * (nothing on screen to correct, so there's nothing to do).
 */
export function mutateCache<T>(key: string, update: (current: T) => T): boolean {
  const entry = getEntry<T>(key)
  if (!entry) return false
  let next: T
  try {
    next = update(entry.data)
  } catch {
    return false
  }
  setEntry(key, next, entry.at)
  return true
}

/**
 * Mark keys due for revalidation without dropping what they hold — the next
 * reader paints the (now known-stale) value immediately and refetches behind it.
 * Pass a key, or a predicate to sweep a family of keys.
 */
export function invalidateCache(target: string | ((key: string) => boolean)): void {
  const match = typeof target === 'string' ? (k: string) => k === target : target
  for (const [key, entry] of memory) {
    if (!entry || !match(key)) continue
    const stale: Entry<unknown> = { data: entry.data, at: 0 }
    memory.set(key, stale)
    writeDisk(key, stale)
    notify(key)
  }
}

/** Drop one cached entry. */
export function dropCache(key: string): void {
  memory.delete(key)
  try {
    localStorage.removeItem(storageKey(key))
  } catch {
    /* ignore */
  }
  notify(key)
}

/** Wipe every Zeroed cache entry — used on sign-out so a new account never
 *  sees the previous athlete's cached view. */
export function clearAllCache(): void {
  const keys = [...memory.keys()]
  memory.clear()
  inflight.clear()
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(`zeroed:cache:`)) doomed.push(k)
    }
    doomed.forEach((k) => localStorage.removeItem(k))
  } catch {
    /* ignore */
  }
  keys.forEach(notify)
}

// ---- revalidation ----------------------------------------------------------

/**
 * Fetch and store a key, subject to the three rules above. Resolves with the
 * value now held (fetched or skipped); rejects only when a fetch was actually
 * attempted and failed.
 */
export function revalidate<T>(
  key: string,
  loader: () => Promise<T>,
  opts: { force?: boolean; freshMs?: number } = {},
): Promise<T | null> {
  const { force = false, freshMs = DEFAULT_FRESH_MS } = opts
  const existing = inflight.get(key)

  if (!force) {
    // An unforced read is happy with whatever is already coming.
    if (existing) return existing as Promise<T | null>
    const entry = getEntry<T>(key)
    if (entry && Date.now() - entry.at < freshMs) return Promise.resolve(entry.data)
    // Offline: don't burn a request that can only fail. The `online` listener in
    // useCachedLoader picks this back up the moment connectivity returns.
    //
    // This gate asks the connectivity store, NOT `navigator.onLine` — the flag
    // reads false on a healthy iOS PWA often enough that trusting it here meant
    // skipping every revalidation and serving stale data indefinitely. The store
    // only reports offline once a probe has actually failed.
    if (isKnownOffline()) return Promise.resolve(entry ? entry.data : null)
  }

  // A FORCED read follows a write, so it must not be answered by a request that
  // was already in flight before that write — it would hand back pre-write data
  // and, in onboarding, silently stall the step it's waiting on. Queue behind
  // the in-flight one instead, so the last word is always the freshest read.
  const run: Promise<T> = (existing ? existing.catch(() => undefined) : Promise.resolve())
    .then(() => loader())
    .then((fresh) => {
      setEntry(key, fresh)
      // A completed read is the strongest connectivity evidence there is.
      reportReachable()
      return fresh
    })
    .catch((err) => {
      // Could be offline, could be a bad request — hand it to the connectivity
      // store to verify, and rethrow so callers still see the failure.
      reportUnreachable()
      throw err
    })
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key)
    })

  inflight.set(key, run)
  return run
}

/**
 * Warm a key in the background — used to pre-load the tabs the athlete hasn't
 * opened yet, so the FIRST visit to each is instant too. Never throws.
 */
export function prefetch<T>(
  key: string,
  loader: () => Promise<T>,
  freshMs = DEFAULT_FRESH_MS,
): void {
  void revalidate(key, loader, { freshMs }).catch(() => {
    /* warming is best-effort — a failure just means the screen loads normally */
  })
}

// ---- the hook --------------------------------------------------------------

export interface CachedLoader<T> {
  /** Last-known value: resolved synchronously from cache, then refreshed. */
  data: T | null
  /** True only on a cold load with no cached value to show. */
  loading: boolean
  /** True while showing cached data that hasn't yet been revalidated. */
  stale: boolean
  /** Set when the most recent revalidation failed (e.g. offline). */
  error: unknown
  /** Force a revalidation, ignoring the freshness window. */
  refetch: () => void
}

export interface CachedLoaderOptions {
  /** How long a fetched value is trusted before a mount will refetch it. */
  freshMs?: number
}

/**
 * Stale-while-revalidate reader. Paints the held value on the first frame (if
 * any), then revalidates subject to the freshness window, dedupe, and the
 * offline skip. A null `key` means "not ready" (e.g. no signed-in athlete yet)
 * and yields an idle, empty result.
 *
 * Every mounted reader of a key shares one entry, so a value refreshed on one
 * screen is already correct on the next — and re-entering a screen inside the
 * freshness window costs nothing at all.
 *
 * `loader` should return a fully-composed view object — keep one cache key per
 * screen/view rather than per row.
 */
export function useCachedLoader<T>(
  key: string | null,
  loader: () => Promise<T>,
  options: CachedLoaderOptions = {},
): CachedLoader<T> {
  const { freshMs = DEFAULT_FRESH_MS } = options

  // Subscribe to the shared entry. useSyncExternalStore keeps every reader of
  // the key on the same object, and re-renders only when it actually changes.
  const entry = useSyncExternalStore(
    useCallback((onChange: () => void) => (key ? subscribe(key, onChange) : () => {}), [key]),
    useCallback(() => (key ? getEntry<T>(key) : null), [key]),
    useCallback(() => (key ? getEntry<T>(key) : null), [key]),
  )

  // A cold key whose only fetch failed must stop reading as "loading", or the
  // screen would sit on a skeleton forever while offline.
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // Keep the latest loader without making it a dependency of the effect.
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const run = useCallback(
    (force: boolean) => {
      if (!key) return
      revalidate(key, () => loaderRef.current(), { force, freshMs })
        .then(() => {
          if (!aliveRef.current) return
          setError(null)
          setFailed(false)
        })
        .catch((err) => {
          // Revalidation failed (offline / server error): keep showing cache.
          if (!aliveRef.current) return
          setError(err)
          setFailed(true)
        })
    },
    [key, freshMs],
  )

  const refetch = useCallback(() => run(true), [run])

  // A write elsewhere in the app marked this key due (invalidateCache stamps
  // `at: 0`). Every mounted reader picks that up here and refreshes behind the
  // value it's already showing — so finishing a session updates the screens
  // around it without any of them knowing about each other. Offline this is a
  // no-op: revalidate skips, the entry is untouched, and the effect settles.
  useEffect(() => {
    if (!key || !entry || entry.at !== 0) return
    run(false)
  }, [key, entry, run])

  useEffect(() => {
    if (!key) return
    setFailed(false)
    run(false)

    // Catch up when the app comes back: connectivity returning, or the athlete
    // switching back to the tab / re-opening the PWA. All are freshness-gated, so
    // a quick detour costs nothing.
    //
    // Both connectivity signals are wired up because they fail in opposite ways:
    // the browser's `online` event can be missing entirely (iOS PWA), and the
    // store only fires on a *verified* transition, which never happens if we
    // never believed we were offline.
    const onOnline = () => run(false)
    const onVisible = () => { if (document.visibilityState === 'visible') run(false) }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = subscribeOnline(() => { if (!isKnownOffline()) run(false) })
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [key, run])

  return {
    data: entry ? entry.data : null,
    loading: !!key && entry === null && !failed,
    stale: entry !== null && Date.now() - entry.at >= freshMs,
    error,
    refetch,
  }
}
