/* Offline-first data cache — a thin localStorage-backed store with a
 * stale-while-revalidate loader hook.
 *
 * The doctrine here is "show last-known, then catch up": every read renders
 * instantly from the last synced value (works fully offline), then a network
 * fetch revalidates in the background and swaps in fresh data when it lands. On
 * a slow or dead connection the cached value simply stays — the UI never blocks
 * on the wire.
 *
 * Scope: Zeroed holds a small amount of per-athlete data, so persisting whole
 * composed view objects under a handful of keys is plenty — no IndexedDB, no
 * query engine. Keys are namespaced by a schema version so a shape change in a
 * new deploy transparently invalidates everything stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// Bump when a cached object's SHAPE changes incompatibly — old entries under
// the prior version are ignored (and swept on next write).
const CACHE_SCHEMA = 'v1'
const PREFIX = `zeroed:cache:${CACHE_SCHEMA}:`

interface Envelope<T> {
  v: string
  at: number
  data: T
}

function storageKey(key: string): string {
  return `${PREFIX}${key}`
}

/** Synchronously read a cached value, or null on miss / parse failure. */
export function loadCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return null
    const env = JSON.parse(raw) as Envelope<T>
    if (env.v !== CACHE_SCHEMA) return null
    return env.data
  } catch {
    return null
  }
}

/** Persist a value. Best-effort — quota / private-mode errors are swallowed. */
export function saveCache<T>(key: string, data: T): void {
  try {
    const env: Envelope<T> = { v: CACHE_SCHEMA, at: Date.now(), data }
    localStorage.setItem(storageKey(key), JSON.stringify(env))
  } catch {
    /* storage full or unavailable — degrade to network-only */
  }
}

/** Drop one cached entry. */
export function dropCache(key: string): void {
  try {
    localStorage.removeItem(storageKey(key))
  } catch {
    /* ignore */
  }
}

/** Wipe every Zeroed cache entry — used on sign-out so a new account never
 *  sees the previous athlete's cached view. */
export function clearAllCache(): void {
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
}

export interface CachedLoader<T> {
  /** Last-known value: hydrated synchronously from cache, then refreshed. */
  data: T | null
  /** True only on a cold load with no cached value to show. */
  loading: boolean
  /** True while showing cached data that hasn't yet been revalidated. */
  stale: boolean
  /** Set when the most recent revalidation failed (e.g. offline). */
  error: unknown
  /** Force a revalidation. */
  refetch: () => void
}

/**
 * Stale-while-revalidate loader. Renders the cached value immediately (if any),
 * then runs `loader` to revalidate. A null `key` means "not ready" (e.g. no
 * signed-in user yet) and yields an idle, empty result.
 *
 * `loader` should return a fully-composed view object — keep one cache key per
 * screen/view rather than per row.
 */
export function useCachedLoader<T>(
  key: string | null,
  loader: () => Promise<T>,
): CachedLoader<T> {
  const [data, setData] = useState<T | null>(() => (key ? loadCache<T>(key) : null))
  const [loading, setLoading] = useState<boolean>(() => (key ? loadCache<T>(key) === null : false))
  const [stale, setStale] = useState<boolean>(() => (key ? loadCache<T>(key) !== null : false))
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)

  // Keep the latest loader without making it a dependency of the effect.
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const refetch = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!key) {
      setData(null)
      setLoading(false)
      setStale(false)
      return
    }

    let cancelled = false
    const cached = loadCache<T>(key)
    if (cached !== null) {
      setData(cached)
      setLoading(false)
      setStale(true)
    } else {
      setLoading(true)
      setStale(false)
    }

    loaderRef
      .current()
      .then((fresh) => {
        if (cancelled) return
        saveCache(key, fresh)
        setData(fresh)
        setError(null)
        setStale(false)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        // Revalidation failed (offline / server error): keep showing cache.
        setError(err)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [key, tick])

  return { data, loading, stale, error, refetch }
}
