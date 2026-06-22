/* Zeroed service worker — offline-first shell + runtime caching.
 *
 * Loading doctrine (the fix for "takes a while to load on low connectivity"):
 *  - Navigations: CACHE-FIRST. Serve the cached app shell instantly, then
 *    revalidate in the background. The UI paints with zero network round-trips
 *    once installed; a fresh build is picked up on the next launch.
 *  - Built JS/CSS + icons + fonts: cache-first with background revalidate
 *    (stale-while-revalidate) — instant, self-healing.
 *  - The full build is PRECACHED on install, so the very first offline launch
 *    after an install/update works without ever having visited those URLs.
 *  - Supabase API / auth and any other cross-origin non-font request bypass the
 *    cache entirely (data freshness is the app's job, via its own cache layer).
 *
 * __SW_VERSION__ and __PRECACHE_MANIFEST__ are replaced at build time by the
 * Vite plugin in vite.config.ts. In dev (unbuilt) they fall back to safe stubs.
 */
const BUILD_VERSION = '__SW_VERSION__'
const CACHE_VERSION = BUILD_VERSION.startsWith('__') ? 'dev' : BUILD_VERSION
const SHELL_CACHE = `zeroed-shell-${CACHE_VERSION}`
const RUNTIME_CACHE = `zeroed-runtime-${CACHE_VERSION}`

// Always-present shell URLs. The built (hashed) assets are appended by the
// build step; the placeholder is an empty array in dev.
const BUILD_ASSETS = self.__PRECACHE_MANIFEST__ || []
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]
const PRECACHE_URLS = Array.from(new Set([...SHELL_ASSETS, ...BUILD_ASSETS]))

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Tolerate individual 404s (e.g. an asset path drift) — one bad URL must
      // not abort the whole precache and leave the app uninstalled.
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      )
      await self.skipWaiting()
    }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

// The page tells a waiting worker to take over immediately (update flow).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

function isFontRequest(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'
}

// Cache-first with background revalidate. Returns cached instantly when present
// and refreshes the entry for next time; otherwise waits on the network.
function staleWhileRevalidate(cacheName, request, fallback) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(request, response.clone())
          }
          return response
        })
        .catch(() => cached || (fallback ? caches.match(fallback) : undefined))
      return cached || network
    }),
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin

  // Cross-origin: only web fonts are cached; everything else (Supabase API,
  // auth, edge functions) goes straight to the network.
  if (!sameOrigin && !isFontRequest(url)) return

  // Navigations → cache-first shell for instant paint, revalidate in the
  // background, fall back to the cached shell when the network is down.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = (await cache.match('/index.html')) || (await cache.match('/'))
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put('/index.html', response.clone())
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    )
    return
  }

  // Same-origin assets + fonts → stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(RUNTIME_CACHE, request))
})
