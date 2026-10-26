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
  BONE, FLOOR, DEFAULT_VIEW, frameAt, frontFrameAt, beatAt, loadPath, solvePose, solveFront,
  type AnyDemo, type MovementDemo as Demo, type FrontDemo, type FrontFigure,
  type Pt, type Prop, type Load, type Figure,
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
    case 'box':
      return <rect className="demo-prop" x={prop.x} y={prop.top} width={prop.w} height={FLOOR - prop.top} rx={1.5} />
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

// ---- the body ---------------------------------------------------------------
// An athlete's build, not a stick: every segment is a tapered shape with its
// muscle belly where it sits on a real limb (quads high on the thigh, calves
// high on the shin, delts capping the shoulder), and the torso is a V-taper
// with chest in front and glutes behind. Radii are in view units.

type Profile = [number, number][]   // [t along the segment 0..1, radius]

const UPPER_ARM: Profile = [[0, 4.8], [0.3, 4.3], [0.55, 4.1], [1, 2.8]]
const FOREARM: Profile = [[0, 2.9], [0.25, 3.3], [1, 2.0]]
const THIGH: Profile = [[0, 5.6], [0.3, 5.7], [0.7, 4.6], [1, 3.6]]
const SHIN: Profile = [[0, 3.3], [0.3, 3.7], [0.75, 2.4], [1, 2.1]]
const FOOT: Profile = [[0, 2.4], [1, 1.5]]
const NECK: Profile = [[0, 3.6], [1, 3.0]]

function radiusAt(prof: Profile, t: number): number {
  for (let i = 1; i < prof.length; i++) {
    const [t1, r1] = prof[i]
    const [t0, r0] = prof[i - 1]
    if (t <= t1) return r0 + ((r1 - r0) * (t - t0)) / (t1 - t0 || 1)
  }
  return prof[prof.length - 1][1]
}

/** A segment from a to b swelled to the profile, rounded at both ends. */
function taper(a: Pt, b: Pt, prof: Profile): string {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
  const n: Pt = [-d[1], d[0]]
  const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const ts = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]
  const left: Pt[] = ts.map((t) => { const p = at(t), r = radiusAt(prof, t); return [p[0] + n[0] * r, p[1] + n[1] * r] })
  const right: Pt[] = ts.map((t) => { const p = at(t), r = radiusAt(prof, t); return [p[0] - n[0] * r, p[1] - n[1] * r] })
  const cap = (c: Pt, r: number, u: Pt, v: Pt): Pt[] =>
    Array.from({ length: 7 }, (_, i) => {
      const th = ((i + 1) / 8) * Math.PI
      return [c[0] + r * (Math.cos(th) * u[0] + Math.sin(th) * v[0]), c[1] + r * (Math.cos(th) * u[1] + Math.sin(th) * v[1])]
    })
  const rEnd = radiusAt(prof, 1)
  const rStart = radiusAt(prof, 0)
  const pts = [
    ...left,
    ...cap(b, rEnd, n, d),
    ...right.reverse(),
    ...cap(a, rStart, [-n[0], -n[1]], [-d[0], -d[1]]),
  ]
  return `M${line(pts).replace(/ /g, 'L')}Z`
}

/** A closed Catmull-Rom curve through the points — the torso's outline. */
function smoothClosed(pts: Pt[]): string {
  const n = pts.length
  const f = (v: number) => v.toFixed(2)
  let path = `M${f(pts[0][0])},${f(pts[0][1])}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    path += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`
  }
  return path + 'Z'
}

// Torso outline in its own frame: u runs hip (0) → shoulder (1) as a fraction
// of the torso; v is the offset toward the chest (+) or the back (−).
const TORSO: Pt[] = [
  [-0.04, 5.0], [0.3, 5.4], [0.56, 7.8], [0.78, 9.0], [0.95, 7.2], [1.07, 3.4],    // front: abs → pec
  [1.07, -3.6], [0.95, -7.6], [0.7, -8.2], [0.44, -5.6], [0.16, -6.4], [-0.02, -8.0], [-0.18, -4.0], // back: traps → glutes
]

function torsoPath(fig: Figure): string {
  const L = BONE.torso
  const d: Pt = [(fig.shoulder[0] - fig.hip[0]) / L, (fig.shoulder[1] - fig.hip[1]) / L]
  // The chest side: the torso's direction turned toward the figure's front.
  const front: Pt = [-d[1], d[0]]
  return smoothClosed(TORSO.map(([u, v]) => [
    fig.hip[0] + d[0] * u * L + front[0] * v,
    fig.hip[1] + d[1] * u * L + front[1] * v,
  ]))
}

function Limbs({ fig, side, part }: { fig: Figure; side: 0 | 1; part: 'legs' | 'arms' }) {
  const cls = side === 0 ? 'demo-body' : 'demo-body demo-body--far'
  if (part === 'legs') {
    const [hip, knee, ankle, toe] = fig.legs[side]
    return (
      <g className={cls}>
        <path d={taper(ankle, toe, FOOT)} />
        <path d={taper(knee, ankle, SHIN)} />
        <path d={taper(hip, knee, THIGH)} />
      </g>
    )
  }
  const [shoulder, elbow, hand] = fig.arms[side]
  return (
    <g className={cls}>
      <path d={taper(elbow, hand, FOREARM)} />
      <path d={taper(shoulder, elbow, UPPER_ARM)} />
    </g>
  )
}

// Facing the viewer: the same build seen from the front — shoulders wider than
// the hips, lats flaring under the arms. Mirrored about the torso's axis.
const FRONT_TORSO_HALF: Pt[] = [[-0.08, 7.8], [0.15, 7.4], [0.38, 6.6], [0.62, 8.8], [0.82, 10.8], [0.95, 9.4], [1.03, 4.6]]
const FRONT_TORSO: Pt[] = [
  [-0.14, 0],
  ...FRONT_TORSO_HALF,
  ...FRONT_TORSO_HALF.slice().reverse().map(([u, v]): Pt => [u, -v]),
]
const FOOT_FRONT: Profile = [[0, 2], [1, 2]]

function FrontBody({ fig }: { fig: FrontFigure }) {
  const L = BONE.torso
  const torso = smoothClosed(FRONT_TORSO.map(([u, v]) => [
    fig.pelvis[0] + fig.up[0] * u * L + fig.side[0] * v,
    fig.pelvis[1] + fig.up[1] * u * L + fig.side[1] * v,
  ]))
  return (
    <g className="demo-body">
      {fig.legs.map(([hip, knee, ankle], i) => (
        <g key={`l${i}`}>
          <path d={taper([ankle[0] - 2.4, ankle[1] + 1.4], [ankle[0] + 2.4, ankle[1] + 1.4], FOOT_FRONT)} />
          <path d={taper(knee, ankle, SHIN)} />
          <path d={taper(hip, knee, THIGH)} />
        </g>
      ))}
      <path d={taper(fig.neck, fig.head, NECK)} />
      <path d={torso} />
      <circle cx={fig.head[0]} cy={fig.head[1]} r={BONE.head - 0.3} />
      {fig.arms.map(([shoulder, elbow, hand], i) => (
        <g key={`a${i}`}>
          <path d={taper(elbow, hand, FOREARM)} />
          <path d={taper(shoulder, elbow, UPPER_ARM)} />
        </g>
      ))}
    </g>
  )
}

function Ground({ demo }: { demo: AnyDemo }) {
  const [vx, vy, vw, vh] = demo.view ?? DEFAULT_VIEW
  return (
    <>
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
    </>
  )
}

function FrontFigureSvg({ demo, seconds }: { demo: FrontDemo; seconds: number }) {
  const [vx, vy, vw, vh] = demo.view ?? DEFAULT_VIEW
  const fig = solveFront(frontFrameAt(demo, seconds).pose)
  return (
    <svg className="demo__svg" viewBox={`${vx} ${vy} ${vw} ${vh}`} aria-hidden="true">
      <Ground demo={demo} />
      <FrontBody fig={fig} />
    </svg>
  )
}

export function DemoFigure({ demo, seconds, trace }: { demo: AnyDemo; seconds: number; trace: Pt[] }) {
  if (demo.facing === 'front') return <FrontFigureSvg demo={demo} seconds={seconds} />
  return <SideFigureSvg demo={demo} seconds={seconds} trace={trace} />
}

function SideFigureSvg({ demo, seconds, trace }: { demo: Demo; seconds: number; trace: Pt[] }) {
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
      <Ground demo={demo} />
      {demo.props?.map((p, i) => <PropShape key={i} prop={p} />)}
      {trace.length > 1 && <polyline className="demo-trace" points={line(trace)} />}
      {cable && fig.load && (
        <line className="demo-cable" x1={cable.from[0]} y1={cable.from[1]} x2={fig.load[0]} y2={fig.load[1]} />
      )}

      <Limbs fig={fig} side={1} part="legs" />
      <Limbs fig={fig} side={1} part="arms" />
      <g className="demo-body">
        <path d={taper(fig.shoulder, fig.head, NECK)} />
        <path d={torsoPath(fig)} />
        <circle cx={fig.head[0]} cy={fig.head[1]} r={BONE.head - 0.3} />
      </g>
      <Limbs fig={fig} side={0} part="legs" />
      <Limbs fig={fig} side={0} part="arms" />
      {demo.load && fig.load && <LoadShape load={demo.load} at={fig.load} forearm={fig.forearm} />}
    </svg>
  )
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function MovementDemo({ demo }: { demo: AnyDemo }) {
  const still = useMemo(prefersReducedMotion, [])
  // The still frame is the first beat's hold run out — the bottom of the rep
  // for every demo, which is the position worth looking at.
  const stillAt = demo.beats[0].hold + demo.beats[0].move
  const [seconds, setSeconds] = useState(still ? stillAt : 0)
  const [paused, setPaused] = useState(false)
  const clock = useRef({ last: 0, t: still ? stillAt : 0 })
  const trace = useMemo(() => (demo.facing !== 'front' && demo.trace ? loadPath(demo) : []), [demo])

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

  const beat = beatAt(demo, seconds)

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
