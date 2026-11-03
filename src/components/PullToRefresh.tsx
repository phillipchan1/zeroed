import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from 'react'
import { tick } from '../lib/haptics'

// Rubber band: the indicator travels at most MAX_PULL px, approaching it
// asymptotically (shown = MAX · (1 − e^(−dy/K))), so the first centimetre
// tracks the finger almost 1:1 and the rest gets heavier. THRESHOLD is in
// shown px — about 110px of finger travel arms it.
const MAX_PULL = 128
const K = 133
const THRESHOLD = 72
/** Where the content rests while the refetch runs. */
const HOLD = 64
/** A refetch that answers instantly (all of Today's are fire-and-forget) still
 *  gets one lap of the loop, so the gesture reads as "it did something". */
const MIN_LOOP_MS = 650
const SETTLE_MS = 380

/** settling = springing back from a short pull; landing = settling after a
 *  refresh, when the cloud collapses into the zero point on the way out. */
type Phase = 'idle' | 'pulling' | 'refreshing' | 'settling' | 'landing'

// Deterministic scatter — same picture every pull, like the reticle itself.
function seed(i: number): number {
  const x = Math.sin((i + 1) * 99.137) * 43758.5453
  return x - Math.floor(x)
}
const RING_R = 9
const DOTS = Array.from({ length: 10 }, (_, i) => {
  const angle = i * Math.PI * (3 - Math.sqrt(5)) + seed(i) * 0.6
  const scatter = RING_R + 6 + seed(i + 100) * 9 // 15–24px out, before the lock
  return {
    x: RING_R * Math.cos(angle),
    y: RING_R * Math.sin(angle),
    dx: (scatter - RING_R) * Math.cos(angle),
    dy: (scatter - RING_R) * Math.sin(angle),
  }
})

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Native-feeling pull-to-refresh for Today and Program. Fires only from the
 * top of the scroll, so it never steals a mid-list swipe.
 *
 * The indicator is the app mark — the Convergence reticle — and the pull is
 * the read tightening: scattered points collapse onto the lock ring as you
 * drag, the crosshair draws in, and at the threshold the ring goes solid and
 * the zero point lights (one light tick). While the refetch runs the locked
 * cloud orbits; when it lands the cloud collapses into the center and the
 * page settles back.
 *
 * Pull distance is written straight to the DOM (a CSS variable and a
 * transform) rather than through React state, so a drag never re-renders the
 * screen underneath — only phase changes do.
 */
export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void> | void
  children: ReactNode
}) {
  const startY = useRef<number | null>(null)
  const pullRef = useRef(0)
  const armedRef = useRef(false)
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [armed, setArmed] = useState(false)
  // Touch handlers read the phase before React has re-rendered, so the ref is
  // the source of truth and the state only drives the classes.
  const phaseRef = useRef<Phase>('idle')
  const setPhase = (next: Phase) => { phaseRef.current = next; setPhaseState(next) }
  const host = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const timers = useRef<number[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  function later(fn: () => void, ms: number) {
    timers.current.push(window.setTimeout(fn, ms))
  }

  function scrollTop(): number {
    const el = host.current
    if (!el) return 0
    const scroller = el.closest('.app-main') ?? el.closest('#root') ?? el
    return (scroller as HTMLElement).scrollTop ?? 0
  }

  /** Paint a pull distance. Transform + one custom property: compositor-only
   *  for the page, a tiny style recalc for the 44px indicator. */
  function paint(shown: number, progress = Math.min(1, shown / THRESHOLD)) {
    pullRef.current = shown
    const ind = indicator.current
    const body = content.current
    if (ind) {
      ind.style.setProperty('--ptr-p', String(progress))
      ind.style.setProperty('--ptr-y', `${shown}px`)
    }
    if (body) body.style.transform = shown > 0 ? `translate3d(0, ${shown}px, 0)` : ''
  }

  function setArmedOnce(next: boolean) {
    if (armedRef.current === next) return
    armedRef.current = next
    setArmed(next)
    if (next) tick()
  }

  function onTouchStart(e: TouchEvent) {
    // A full-screen overlay (the finish moment, a sheet) sits inside the tree
    // but isn't the page — dragging on it must not move the page.
    const inOverlay = (e.target as Element | null)?.closest?.('.zeroed-moment, [role="dialog"]')
    if (phaseRef.current !== 'idle' || inOverlay || scrollTop() > 0) {
      startY.current = null
      return
    }
    startY.current = e.touches[0].clientY
  }

  function onTouchMove(e: TouchEvent) {
    if (startY.current == null || (phaseRef.current !== 'idle' && phaseRef.current !== 'pulling')) return
    if (scrollTop() > 0) {
      startY.current = null
      release()
      return
    }
    const dy = e.touches[0].clientY - startY.current
    const shown = dy > 0 ? MAX_PULL * (1 - Math.exp(-dy / K)) : 0
    if (shown > 0 && phaseRef.current === 'idle') setPhase('pulling')
    paint(shown)
    setArmedOnce(shown >= THRESHOLD)
  }

  /** Let go short of the threshold: spring back, no refresh. */
  function release() {
    setArmedOnce(false)
    if (pullRef.current === 0) { setPhase('idle'); return }
    setPhase('settling')
    paint(0)
    later(() => setPhase('idle'), SETTLE_MS)
  }

  function onTouchEnd() {
    if (startY.current == null) return
    startY.current = null
    if (phaseRef.current !== 'pulling') return
    if (!armedRef.current) { release(); return }

    setPhase('refreshing')
    paint(HOLD, 1)
    const started = Date.now()
    // Called synchronously, exactly as before — the animation only decides
    // how long the indicator stays, never when the refetch starts.
    new Promise<void>((resolve) => resolve(onRefresh()))
      .catch(() => { /* the screen's own error state owns failures */ })
      .finally(() => {
        const wait = reducedMotion() ? 0 : Math.max(0, MIN_LOOP_MS - (Date.now() - started))
        later(() => {
          setPhase('landing')
          paint(0, 1)
          later(() => { setArmedOnce(false); setPhase('idle') }, SETTLE_MS)
        }, wait)
      })
  }

  /** The system took the touch (a call, a gesture): never refresh on that. */
  function onTouchCancel() {
    if (startY.current == null) return
    startY.current = null
    if (phaseRef.current === 'pulling') release()
  }

  const busy = phase === 'refreshing'
  return (
    <div
      ref={host}
      className={`ptr ptr--${phase}${armed ? ' ptr--armed' : ''}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div ref={indicator} className="ptr__indicator" style={{ '--ptr-p': 0, '--ptr-y': '0px' } as CSSProperties} aria-hidden>
        <svg className="ptr__mark" width="56" height="56" viewBox="-28 -28 56 56">
          <line className="ptr__hair ptr__hair--v" x1="0" y1="-20" x2="0" y2="20" />
          <line className="ptr__hair ptr__hair--h" x1="-20" y1="0" x2="20" y2="0" />
          <circle className="ptr__ring" r={RING_R} pathLength={100} />
          <g className="ptr__cloud">
            {DOTS.map((d, i) => (
              <circle
                key={i}
                className="ptr__dot"
                cx={d.x}
                cy={d.y}
                r={1.6}
                style={{ '--dx': `${d.dx}px`, '--dy': `${d.dy}px`, '--i': i } as CSSProperties}
              />
            ))}
          </g>
          <circle className="ptr__zero" r={3} />
        </svg>
      </div>
      <span className="ptr__sr" role="status" aria-live="polite">{busy ? 'Refreshing' : ''}</span>
      <div ref={content} className="ptr__content">
        {children}
      </div>
    </div>
  )
}
