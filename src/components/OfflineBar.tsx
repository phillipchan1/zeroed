/* Connectivity surface — a small status pill in the top corner, not a banner.
 *
 * Three states, all deliberately quiet. "Offline" exists so cached data isn't
 * mistaken for live; it's a badge, not an alert — the app is fully usable
 * offline, so a full-width strip across the top overstated a condition the
 * athlete can't act on and doesn't need to think about mid-session. A timed-out
 * or slow probe is `degraded`: a subtle "Slow connection", never Offline. The
 * update prompt is the only tappable one, since it's the only one that asks for
 * anything.
 *
 * The state comes from the verified connectivity store (useOnline.ts), so
 * Offline appears only after hard network failures — never off a stale
 * `navigator.onLine` reading, and never off a probe timeout.
 */
import { RefreshCw } from 'lucide-react'
import { useConnectivity, useServiceWorkerUpdate } from '../lib/useOnline'
import { connectivityBadge, connectivityBadgeLabel } from '../lib/connectivityProbe'

export function OfflineBar() {
  const status = useConnectivity()
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

  const badge = connectivityBadge(status)
  const label = connectivityBadgeLabel(badge)
  if (badge === 'offline') {
    return (
      <div className="conn-pill conn-pill--offline" role="status" aria-live="polite">
        <span className="conn-pill__dot" aria-hidden="true" />
        <span>{label}</span>
      </div>
    )
  }

  if (badge === 'slow') {
    return (
      <div className="conn-pill conn-pill--degraded" role="status" aria-live="polite">
        <span>{label}</span>
      </div>
    )
  }

  return null
}
