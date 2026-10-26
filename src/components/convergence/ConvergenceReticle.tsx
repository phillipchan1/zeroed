import { useEffect, useRef, useState } from 'react'
import { deriveConvergenceState, CONVERGENCE_LABEL, type ConvergenceContext } from './state'

/**
 * The Convergence visual — the brand organism (Convergence §6). A reticle of
 * points whose TIGHTNESS is a live readout of how dialed-in the read is right now.
 * The wordmark made literal: zeroing in.
 *
 * HARD RULE (§6): tightness is driven by REAL confidence state, never a timer.
 * Point positions are a PURE function of confidence (+ a deterministic per-point
 * seed). The only motion is a CSS transition that fires when confidence CHANGES
 * (reactive) and a one-shot collapse on mount (the answer just landed) — there is
 * no setInterval/RAF loop animating tightness. Feed the same confidence twice and
 * you get the same picture. If it can't be state-driven, it isn't shipped.
 *
 * Multi-axis ready NOW (§6): each point belongs to an axis and is driven by THAT
 * axis's confidence when `axes` is supplied, so axes narrow independently. v1
 * still derives the headline STATE from the aggregate; v2 can animate per-axis
 * without repainting — the data shape is already here.
 *
 * The state machine itself lives in ./state (pure, no JSX) — imported by the loop
 * (Phase F) and unit-tested without React.
 */

// Deterministic per-point seed in [0,1) — NOT Math.random (positions must be a
// pure function of index so the same state always renders identically).
function seed(i: number): number {
  const x = Math.sin((i + 1) * 99.137) * 43758.5453
  return x - Math.floor(x)
}

interface Point { angle: number; jitter: number; axis: number }

function buildPoints(count: number, axisCount: number): Point[] {
  const golden = Math.PI * (3 - Math.sqrt(5)) // golden angle — even angular spread
  return Array.from({ length: count }, (_, i) => ({
    angle: i * golden + seed(i) * 0.6,
    jitter: 0.55 + seed(i + 100) * 0.45, // [0.55, 1.0]
    axis: i % Math.max(1, axisCount),
  }))
}

export interface ConvergenceReticleProps {
  confidence: number                 // aggregate [0,1] — drives the headline state
  axes?: number[]                    // per-axis confidences — drive per-point tightness (multi-axis now)
  size?: number                      // px (square). Default 160.
  animateInFrom?: number | null      // collapse on mount from this confidence (default: scattered=0). null = no mount animation.
  showLabel?: boolean                // render the state label + aggregate %
  context?: ConvergenceContext       // loop context (Phase F): { loop, surprise, reZero } — event-driven names
}

export function ConvergenceReticle({
  confidence,
  axes,
  size = 160,
  animateInFrom = 0,
  showLabel = true,
  context,
}: ConvergenceReticleProps) {
  const agg = Math.max(0, Math.min(1, confidence))
  const state = deriveConvergenceState(agg, context)
  const POINT_COUNT = 30
  const axisCount = axes && axes.length ? axes.length : 1
  const pointsRef = useRef<Point[]>(buildPoints(POINT_COUNT, axisCount))
  const points = pointsRef.current

  // Mount collapse: render at animateInFrom, then flip to the real confidence on
  // the next frame so the CSS transition plays the cloud collapsing inward.
  const [shown, setShown] = useState(animateInFrom == null ? agg : Math.max(0, Math.min(1, animateInFrom)))
  useEffect(() => {
    if (animateInFrom == null) { setShown(agg); return }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(agg)))
    return () => cancelAnimationFrame(id)
  }, [agg, animateInFrom])

  const cx = size / 2
  const cy = size / 2
  const maxR = size * 0.44   // scattered edge
  const coreR = size * 0.045 // tightest core

  // Mount-collapse progress in [0,1]: 0 at the scattered start, 1 once `shown`
  // has eased to the real aggregate. Drives every point's ease-in together.
  const from = animateInFrom == null ? agg : Math.max(0, Math.min(1, animateInFrom))
  const progress = Math.abs(agg - from) < 1e-6 ? 1 : Math.max(0, Math.min(1, (shown - from) / (agg - from)))

  // A point's TARGET tightness = its axis confidence if axes are supplied
  // (per-axis narrowing, v2-ready), else the aggregate. Displayed tightness eases
  // from the scattered start to that target by the mount progress.
  function radiusFor(p: Point): number {
    const target = axes && axes.length ? Math.max(0, Math.min(1, axes[p.axis] ?? agg)) : agg
    const t = from + (target - from) * progress
    const spread = (maxR - coreR) * (1 - t) * p.jitter
    return coreR + spread
  }

  // brightness rises as the read tightens: dim grey scattered → signal zeroed.
  const brightness = from + (agg - from) * progress
  const ringR = coreR + (maxR * 0.5) * (1 - brightness) // the lock ring shrinks inward
  const locked = state === 'zeroed_in' || state === 'holding_zero'

  // State accent — drawn from the five-color system. off_zero borrows the veto
  // tint (the read wobbled), holding_zero the confirmed green (lock held), the
  // rest signal-yellow. Color names the state without changing the geometry.
  const accent =
    state === 'off_zero' ? 'var(--veto)'
    : state === 'holding_zero' ? 'var(--confirmed)'
    : state === 're_zero' ? 'var(--computing)'
    : 'var(--signal)'
  const dotLit = brightness > 0.28 || state === 'off_zero'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Read convergence: ${CONVERGENCE_LABEL[state].toLowerCase()}, ${Math.round(agg * 100)} percent`}
        style={{ overflow: 'visible' }}
      >
        {/* crosshair — the reticle frame, faint */}
        <line x1={cx} y1={cy - maxR * 1.05} x2={cx} y2={cy + maxR * 1.05} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
        <line x1={cx - maxR * 1.05} y1={cy} x2={cx + maxR * 1.05} y2={cy} style={{ stroke: 'var(--line)' }} strokeWidth={1} />

        {/* the lock ring — shrinks toward the core as confidence rises */}
        <circle
          cx={cx}
          cy={cy}
          r={Math.max(coreR, ringR)}
          fill="none"
          strokeWidth={1}
          strokeDasharray={locked ? 'none' : '3 4'}
          style={{
            stroke: locked ? accent : 'var(--text-dim)',
            opacity: 0.25 + brightness * 0.5,
            transition: 'r .9s var(--ease), stroke .6s var(--ease), opacity .9s var(--ease)',
          }}
        />

        {/* the cloud */}
        {points.map((p, i) => {
          const r = radiusFor(p)
          const x = cx + r * Math.cos(p.angle)
          const y = cy + r * Math.sin(p.angle)
          const dotOpacity = 0.3 + brightness * 0.6
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={1.7}
              style={{
                fill: dotLit ? accent : 'var(--text-dim)',
                opacity: dotOpacity,
                transition: 'cx .9s var(--ease), cy .9s var(--ease), fill .6s var(--ease), opacity .9s var(--ease)',
              }}
            />
          )
        })}

        {/* the center — the zero point */}
        <circle cx={cx} cy={cy} r={2.4} style={{ fill: accent, opacity: 0.4 + brightness * 0.6, transition: 'opacity .9s var(--ease), fill .6s var(--ease)' }} />
      </svg>

      {showLabel && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontFamily: 'var(--font-mono)' }}>
          <span style={{ fontSize: 'var(--fs-micro)', letterSpacing: '0.12em', color: locked ? accent : 'var(--text-dim)' }}>
            {CONVERGENCE_LABEL[state]}
          </span>
          <span className="num" style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-dim)' }}>
            {Math.round(agg * 100)}%{state === 'zeroed_in' ? ' · STILL SHARPENING' : ''}
          </span>
        </div>
      )}
    </div>
  )
}
