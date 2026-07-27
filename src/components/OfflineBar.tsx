/* Connectivity surface — a small status pill in the top corner, not a banner.
 *
 * Two states, both deliberately quiet. "Offline" exists so cached data isn't
 * mistaken for live; it's a badge, not an alert — the app is fully usable
 * offline, so a full-width strip across the top overstated a condition the
 * athlete can't act on and doesn't need to think about mid-session. The update
 * prompt is the only tappable one, since it's the only one that asks for
 * anything.
 *
 * The offline state comes from the verified connectivity store (useOnline.ts),
 * so it appears only when a probe has actually failed — never off a stale
 * `navigator.onLine` reading.
 */
import { RefreshCw } from 'lucide-react'
import { useOnline, useServiceWorkerUpdate } from '../lib/useOnline'

export function OfflineBar() {
  const online = useOnline()
  const { updateReady, applyUpdate } = useServiceWorkerUpdate()

  if (updateReady) {
    return (
      <button
        type="button"
        className="conn-pill conn-pill--update"
        onClick={applyUpdate}
        title="A new version is ready — tap to refresh"
      >
        <RefreshCw size={11} strokeWidth={2} />
        <span>Update</span>
      </button>
    )
  }

  if (!online) {
    return (
      <div className="conn-pill conn-pill--offline" role="status" aria-live="polite">
        <span className="conn-pill__dot" aria-hidden="true" />
        <span>Offline</span>
      </div>
    )
  }

  return null
}
