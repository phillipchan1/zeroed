/* Zeroed service worker — offline shell + runtime caching.
 *
 * Strategy:
 *  - Navigations: network-first, fall back to cached app shell when offline.
 *  - Static assets (built JS/CSS, icons, fonts): stale-while-revalidate.
 *  - Anything cross-origin that isn't a font, and all non-GET requests
 *    (e.g. Supabase API / auth), bypass the cache entirely.
 *
 * Bump CACHE_VERSION to force old caches to be discarded on the next load.
 */
const CACHE_VERSION = 'v2'
const SHELL_CACHE = `zeroed-shell-${CACHE_VERSION}`
const RUNTIME_CACHE = `zeroed-runtime-${CACHE_VERSION}`

// Minimal app shell — known, unhashed URLs. Built JS/CSS are cached at runtime.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
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

// Allow the page to trigger an immediate activation after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

function isFontRequest(url) {
  return (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin

  // Bypass cross-origin requests except web fonts (e.g. Supabase, analytics).
  if (!sameOrigin && !isFontRequest(url)) return

  // Navigations → network-first so the freshest HTML wins; offline → shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match('/index.html')),
        ),
    )
    return
  }

  // Static assets → stale-while-revalidate.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              cache.put(request, response.clone())
            }
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    ),
  )
})
