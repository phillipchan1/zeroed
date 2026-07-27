/* Connectivity surface — a quiet bar that tells the athlete when they're
 * offline (so cached data isn't mistaken for live), and a one-tap prompt when a
 * new build is ready. Both are unobtrusive; the app stays fully usable offline.
 */
import { CloudOff, RefreshCw } from 'lucide-react'
import { useOnline, useServiceWorkerUpdate } from '../lib/useOnline'

export function OfflineBar() {
  const online = useOnline()
  const { updateReady, applyUpdate } = useServiceWorkerUpdate()

  if (updateReady) {
    return (
      <button type="button" className="conn-bar conn-bar--update" onClick={applyUpdate}>
        <RefreshCw size={13} strokeWidth={1.75} />
        <span>New version — tap to refresh</span>
      </button>
    )
  }

  if (!online) {
    return (
      <div className="conn-bar conn-bar--offline" role="status">
        <CloudOff size={13} strokeWidth={1.75} />
        <span>Offline — showing saved data</span>
      </div>
    )
  }

  return null
}
