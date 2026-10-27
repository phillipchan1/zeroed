import { useEffect } from 'react'

// Keep the screen on while `active`. An interval timer that dims the phone to
// black between rounds is one you have to keep tapping awake with chalk on your
// hands — the thing it exists to spare you.
//
// The Screen Wake Lock API (Safari 16.4+, Chrome; WKWebView on recent iOS). The
// system drops the lock whenever the page is hidden, so it is re-requested on
// every return. Best-effort throughout: where it isn't supported the timer
// still keeps time, it just can't keep the lights on.

interface WakeLockSentinelLike { release: () => Promise<void> }
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const wl = (navigator as NavigatorWithWakeLock).wakeLock
    if (!wl) return
    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      wl.request('screen')
        .then((s) => {
          if (cancelled) void s.release().catch(() => {})
          else sentinel = s
        })
        .catch(() => { /* refused (low battery, policy) — non-fatal */ })
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', acquire)
      void sentinel?.release().catch(() => {})
    }
  }, [active])
}
