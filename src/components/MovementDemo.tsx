// =============================================================================
// MovementDemo — the animated side-view figure in an exercise's Details sheet.
//
// The poses and timing live in engine/movementDemos.ts; this only draws a frame
// and runs the clock. Colours come from CSS classes (.demo-*), never SVG colour
// attributes — WebKit won't resolve var() in those (see svgColors.check.ts).
//
// Tap the figure to pause on a position. Reduced motion shows the bottom of the
// rep, still, with its cue — the readable end state the rest of the app keeps.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BONE, FLOOR, DEFAULT_VIEW, frameAt, loadPath, solvePose,
  type MovementDemo as Demo, type Pt, type Prop, type Load, type Figure,
} from '../engine/movementDemos'

function line(points: Pt[]): string {
  return points.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')
}

function PropShape({ prop }: { prop: Prop }) {
  switch (prop.kind) {
    case 'bench':
      return (
        <g className="demo-prop">
          <rect x={prop.x} y={prop.top} width={prop.w} height={5} rx={1.5} />
          <line x1={prop.x + 6} y1={prop.top + 5} x2={prop.x + 6} y2={FLOOR} />
          <line x1={prop.x + prop.w - 6} y1={prop.top + 5} x2={prop.x + prop.w - 6} y2={FLOOR} />
        </g>
      )
    case 'incline':
      return <line className="demo-prop demo-prop--thick" x1={prop.from[0]} y1={prop.from[1]} x2={prop.to[0]} y2={prop.to[1]} />
    case 'rail':
      return <line className="demo-prop demo-prop--rail" x1={prop.x} y1={prop.y} x2={prop.x + prop.w} y2={prop.y} />
    case 'pad':
      return <rect className="demo-prop" x={prop.at[0] - 6} y={prop.at[1] - 3.5} width={12} height={7} rx={3.5} />
    case 'cable':
      return null   // drawn with the load, which it follows
  }
}

function LoadShape({ load, at, forearm }: { load: Load; at: Pt; forearm: number }) {
  const [x, y] = at
  switch (load.kind) {
    case 'barbell':
      // A plate seen edge-on to the bar: the disc, and the sleeve through it.
      return (
        <g className="demo-load">
          <circle cx={x} cy={y} r={10} />
          <circle className="demo-load__hub" cx={x} cy={y} r={2} />
        </g>
      )
    case 'dumbbell':
      return (
        <g className="demo-load">
          <circle cx={x} cy={y} r={4.5} />
          <circle className="demo-load__hub" cx={x} cy={y} r={1.2} />
        </g>
      )
    case 'kettlebell': {
      // Hangs off the hand along the forearm.
      const r = (forearm * Math.PI) / 180
      const cx = x + Math.sin(r) * 7
      const cy = y + Math.cos(r) * 7
      return (
        <g className="demo-load">
          <line x1={x} y1={y} x2={cx} y2={cy} />
          <circle cx={cx} cy={cy} r={5.5} />
        </g>
      )
    }
    case 'handle':
      return (
        <g className="demo-load">
          <circle cx={x} cy={y} r={2.6} />
        </g>
      )
  }
}

function Limbs({ fig, side }: { fig: Figure; side: 0 | 1 }) {
  return (
    <g className={side === 0 ? 'demo-bone' : 'demo-bone demo-bone--far'}>
      <polyline points={line(fig.legs[side])} />
      <polyline points={line(fig.arms[side])} />
    </g>
  )
}

export function DemoFigure({ demo, seconds, trace }: { demo: Demo; seconds: number; trace: Pt[] }) {
  const { pose } = frameAt(demo, seconds)
  const fig = solvePose(pose, demo.load)
  const [vx, vy, vw, vh] = demo.view ?? DEFAULT_VIEW
  const cable = demo.props?.find((p): p is Extract<Prop, { kind: 'cable' }> => p.kind === 'cable')

  return (
    <svg
      className="demo__svg"
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      aria-hidden="true"
    >
      {/* Faint measurement grid — the instrument the figure is drawn on. */}
      <g className="demo-grid">
        {Array.from({ length: Math.floor(vw / 20) + 1 }, (_, i) => (
          <line key={`v${i}`} x1={vx + i * 20} y1={vy} x2={vx + i * 20} y2={vy + vh} />
        ))}
        {Array.from({ length: Math.floor(vh / 20) + 1 }, (_, i) => (
          <line key={`h${i}`} x1={vx} y1={vy + i * 20} x2={vx + vw} y2={vy + i * 20} />
        ))}
      </g>

      {demo.floor !== false && <line className="demo-floor" x1={vx} y1={FLOOR} x2={vx + vw} y2={FLOOR} />}
      {demo.props?.map((p, i) => <PropShape key={i} prop={p} />)}
      {trace.length > 1 && <polyline className="demo-trace" points={line(trace)} />}
      {cable && fig.load && (
        <line className="demo-cable" x1={cable.from[0]} y1={cable.from[1]} x2={fig.load[0]} y2={fig.load[1]} />
      )}

      <Limbs fig={fig} side={1} />
      <g className="demo-bone">
        <line x1={fig.hip[0]} y1={fig.hip[1]} x2={fig.shoulder[0]} y2={fig.shoulder[1]} />
      </g>
      <circle className="demo-head" cx={fig.head[0]} cy={fig.head[1]} r={BONE.head} />
      <Limbs fig={fig} side={0} />
      {demo.load && fig.load && <LoadShape load={demo.load} at={fig.load} forearm={fig.forearm} />}
    </svg>
  )
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function MovementDemo({ demo }: { demo: Demo }) {
  const still = useMemo(prefersReducedMotion, [])
  // The still frame is the first beat's hold run out — the bottom of the rep
  // for every demo, which is the position worth looking at.
  const stillAt = demo.beats[0].hold + demo.beats[0].move
  const [seconds, setSeconds] = useState(still ? stillAt : 0)
  const [paused, setPaused] = useState(false)
  const clock = useRef({ last: 0, t: still ? stillAt : 0 })
  const trace = useMemo(() => (demo.trace ? loadPath(demo) : []), [demo])

  useEffect(() => {
    if (still || paused) return
    let raf = 0
    clock.current.last = performance.now()
    const tick = (now: number) => {
      clock.current.t += (now - clock.current.last) / 1000
      clock.current.last = now
      setSeconds(clock.current.t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [still, paused])

  const { beat } = frameAt(demo, seconds)

  return (
    <button
      type="button"
      className="demo"
      onClick={() => !still && setPaused((p) => !p)}
      aria-label={paused ? 'Play demo' : 'Pause demo'}
      aria-pressed={paused}
    >
      <DemoFigure demo={demo} seconds={seconds} trace={trace} />
      <span className="demo__cue">
        <span className="demo__step num">{beat + 1}/{demo.beats.length}</span>
        <span>{demo.beats[beat].cue}</span>
        {paused && <span className="demo__paused num">Paused</span>}
      </span>
    </button>
  )
}
