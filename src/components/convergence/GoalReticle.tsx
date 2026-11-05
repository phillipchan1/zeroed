import { useEffect, useMemo, useState } from 'react'
import type { GoalDisplay } from '../../engine/goals'

/**
 * The reticle, read per goal. Each target owns a sector of points; how close a
 * sector sits to the center is how far that goal has come from its baseline to
 * its target, and its color is its status (zeroed confirmed, off course the
 * signal, needs a test pending, on course plain). A zeroed goal's points sit on
 * the core.
 *
 * Same hard rule as ConvergenceReticle: tightness is real state, never a timer.
 * Positions are a pure function of each goal's progress plus a deterministic
 * per-point seed. The only motion is one collapse on mount (and a transition
 * when progress changes); nothing loops.
 */

export interface GoalAxis {
  id: string
  label: string
  /** Baseline → target, in [0, 1]. Null (no measurement) sits scattered. */
  progress: number | null
  display: GoalDisplay
}

function seed(i: number): number {
  const x = Math.sin((i + 1) * 99.137) * 43758.5453
  return x - Math.floor(x)
}

const MAX_SECTORS = 8

export function GoalReticle({ goals, size = 240, labels = true, onOpen, perGoal = 9 }: {
  goals: GoalAxis[]
  size?: number
  labels?: boolean
  onOpen?: (goalId: string) => void
  perGoal?: number
}) {
  const shown = goals.slice(0, MAX_SECTORS)
  const n = Math.max(1, shown.length)
  const cx = size / 2
  const maxR = size * (labels ? 0.34 : 0.42)
  const coreR = size * 0.045
  const sector = (Math.PI * 2) / n

  // Collapse onto the real state on the frame after mount.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)))
    return () => cancelAnimationFrame(id)
  }, [])

  const points = useMemo(() => shown.flatMap((g, gi) => {
    const a0 = -Math.PI / 2 + gi * sector
    return Array.from({ length: perGoal }, (_, k) => {
      const i = gi * perGoal + k
      return {
        key: `${g.id}-${k}`,
        gi,
        angle: a0 + sector * (0.1 + 0.8 * ((k + seed(i) * 0.7) / perGoal)),
        jitter: 0.5 + seed(i + 100) * 0.5,
      }
    })
  }), [shown, sector, perGoal])

  const avg = shown.reduce((s, g) => s + (g.progress ?? 0), 0) / n
  const allZeroed = shown.length > 0 && shown.every((g) => g.display === 'zeroed')
  const ringR = coreR + maxR * 0.55 * (1 - (settled ? avg : 0))

  function radius(gi: number, jitter: number): number {
    const t = settled ? (shown[gi].progress ?? 0) : 0
    return coreR + (maxR - coreR) * (1 - t) * jitter
  }

  const counts = shown.reduce<Record<GoalDisplay, number>>((c, g) => {
    c[g.display] += 1
    return c
  }, { zeroed: 0, confirm: 0, on_course: 0, off_course: 0, needs_test: 0 })
  const summary = [
    counts.zeroed ? `${counts.zeroed} zeroed` : null,
    counts.confirm ? `${counts.confirm} to confirm` : null,
    counts.on_course ? `${counts.on_course} on course` : null,
    counts.off_course ? `${counts.off_course} off course` : null,
    counts.needs_test ? `${counts.needs_test} need${counts.needs_test === 1 ? 's' : ''} a test` : null,
  ].filter(Boolean).join(', ')

  return (
    <svg
      className="goal-reticle"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Goals: ${summary || 'none yet'}`}
    >
      <line className="goal-reticle__x" x1={cx} y1={cx - maxR * 1.12} x2={cx} y2={cx + maxR * 1.12} />
      <line className="goal-reticle__x" x1={cx - maxR * 1.12} y1={cx} x2={cx + maxR * 1.12} y2={cx} />
      {n > 1 && shown.map((g, gi) => {
        const a = -Math.PI / 2 + gi * sector
        return (
          <line
            key={`tick-${g.id}`}
            className="goal-reticle__tick"
            x1={cx + (maxR + 4) * Math.cos(a)} y1={cx + (maxR + 4) * Math.sin(a)}
            x2={cx + (maxR + 10) * Math.cos(a)} y2={cx + (maxR + 10) * Math.sin(a)}
          />
        )
      })}
      <circle
        className={`goal-reticle__ring${allZeroed ? ' goal-reticle__ring--locked' : ''}`}
        cx={cx} cy={cx} r={Math.max(coreR, ringR)}
      />
      {points.map((p) => {
        const r = radius(p.gi, p.jitter)
        return (
          <circle
            key={p.key}
            className={`goal-reticle__p goal-reticle__p--${shown[p.gi].display}`}
            r={size > 160 ? 1.9 : 1.3}
            cx={0}
            cy={0}
            style={{
              transform: `translate(${(cx + r * Math.cos(p.angle)).toFixed(2)}px, ${(cx + r * Math.sin(p.angle)).toFixed(2)}px)`,
              transitionDelay: `${p.gi * 70}ms`,
            }}
          />
        )
      })}
      <circle className="goal-reticle__core" cx={cx} cy={cx} r={Math.max(2, size * 0.012)} />
      {labels && shown.map((g, gi) => {
        const mid = -Math.PI / 2 + (gi + 0.5) * sector
        const lr = maxR + 18
        const x = cx + lr * Math.cos(mid)
        const y = cx + lr * Math.sin(mid) + 3.5
        const anchor = Math.abs(Math.cos(mid)) < 0.25 ? 'middle' : Math.cos(mid) > 0 ? 'start' : 'end'
        const a0 = -Math.PI / 2 + gi * sector
        const a1 = a0 + sector
        const R = maxR + 24
        const wedge = n === 1
          ? `M${cx - R} ${cx}a${R} ${R} 0 1 0 ${R * 2} 0a${R} ${R} 0 1 0 ${-R * 2} 0`
          : `M${cx} ${cx}L${(cx + R * Math.cos(a0)).toFixed(1)} ${(cx + R * Math.sin(a0)).toFixed(1)}A${R} ${R} 0 0 1 ${(cx + R * Math.cos(a1)).toFixed(1)} ${(cx + R * Math.sin(a1)).toFixed(1)}Z`
        return (
          <g key={`label-${g.id}`}>
            {onOpen && (
              <path
                className="goal-reticle__hit"
                d={wedge}
                role="button"
                tabIndex={0}
                aria-label={`Open ${g.label}`}
                onClick={() => onOpen(g.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(g.id) }
                }}
              />
            )}
            <text className={`goal-reticle__label goal-reticle__label--${g.display}`} x={x.toFixed(1)} y={y.toFixed(1)} textAnchor={anchor}>
              {g.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
