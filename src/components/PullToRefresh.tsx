import { useRef, useState, type ReactNode, type TouchEvent } from 'react'

const THRESHOLD = 64

/**
 * Native-feeling pull-to-refresh for Today and Program. Fires only from the
 * top of the scroll, so it never steals a mid-list swipe.
 */
export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void> | void
  children: ReactNode
}) {
  const startY = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const host = useRef<HTMLDivElement>(null)

  function scrollTop(): number {
    const el = host.current
    if (!el) return 0
    const scroller = el.closest('.app-main') ?? el.closest('#root') ?? el
    return (scroller as HTMLElement).scrollTop ?? 0
  }

  function onTouchStart(e: TouchEvent) {
    if (busy || scrollTop() > 0) {
      startY.current = null
      return
    }
    startY.current = e.touches[0].clientY
  }

  function onTouchMove(e: TouchEvent) {
    if (startY.current == null || busy) return
    if (scrollTop() > 0) {
      startY.current = null
      setPull(0)
      return
    }
    const dy = e.touches[0].clientY - startY.current
    setPull(dy > 0 ? Math.min(dy, THRESHOLD * 1.4) : 0)
  }

  function onTouchEnd() {
    if (startY.current == null) return
    const should = pull >= THRESHOLD
    startY.current = null
    setPull(0)
    if (!should || busy) return
    setBusy(true)
    Promise.resolve(onRefresh()).finally(() => setBusy(false))
  }

  const shown = busy ? THRESHOLD : pull
  return (
    <div
      ref={host}
      className="ptr"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div
        className={`ptr__indicator${busy || pull >= THRESHOLD ? ' ptr__indicator--ready' : ''}`}
        style={{ height: shown, opacity: shown ? 1 : 0 }}
        aria-hidden
      >
        {busy ? 'Refreshing' : 'Pull to refresh'}
      </div>
      {children}
    </div>
  )
}
