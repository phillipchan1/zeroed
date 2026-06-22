/* Connectivity awareness — a tiny store over the browser's online/offline
 * signal, plus events the service worker raises when a new build is ready.
 *
 * `navigator.onLine` is only a coarse hint (it goes false when the radio is
 * off, but can read true on a connected-but-dead network). It's good enough to
 * drive an honest "you're offline" banner; the real source of truth for data is
 * whether a revalidation succeeded, which the cache layer tracks separately.
 */
import { useEffect, useState } from 'react'

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  return online
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
