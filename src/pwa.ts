/* Registers the service worker for PWA / offline support and wires the
 * update flow. No-ops during `vite dev`, in browsers without SW support,
 * and inside the Capacitor iOS shell (WKWebView loads capacitor:// and a
 * service worker would fight the native asset copy).
 *
 * Update flow: when a new worker finishes installing while an old one still
 * controls the page, we raise SW_UPDATE_EVENT so the UI can offer a refresh.
 * Calling applyUpdate() posts SKIP_WAITING; the new worker activates and the
 * `controllerchange` listener reloads the page exactly once.
 */
import { Capacitor } from '@capacitor/core'
import { SW_UPDATE_EVENT } from './lib/useOnline'

export function registerServiceWorker() {
  if (import.meta.env.DEV) return
  if (Capacitor.isNativePlatform()) return
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // A worker already waiting (installed before this page loaded).
        if (reg.waiting && navigator.serviceWorker.controller) {
          window.dispatchEvent(new Event(SW_UPDATE_EVENT))
        }

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // Installed + an existing controller ⇒ this is an update, not the
            // first install. Surface it so the user can refresh to the new build.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new Event(SW_UPDATE_EVENT))
            }
          })
        })
      })
      .catch((err) => {
        console.error('Service worker registration failed:', err)
      })

    // When the controlling worker changes (after SKIP_WAITING), reload once so
    // the page runs the freshly-activated build.
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    })
  })
}
