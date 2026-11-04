import { GOAL_DISPLAY_LABEL, goalNumber, progressRatio, type GoalDisplay, type GoalFields } from '../../engine/goals'

// Each state differs by shape as well as color (dot, diamond, dashed ring,
// square), so none of them depends on telling green from yellow.
export function GoalStatus({ display }: { display: GoalDisplay }) {
  return (
    <span className={`goal-status goal-status--${display}`}>
      <span className="goal-status__mark" aria-hidden />
      {GOAL_DISPLAY_LABEL[display]}
    </span>
  )
}

/** 30 °, 275 lb, 12 rounds. Degrees and percent sit on the number. */
export function goalValue(value: unknown, unit: string | null | undefined): string {
  const n = goalNumber(value)
  if (n == null) return '—'
  const u = unit?.trim()
  if (!u) return String(n)
  return u === '°' || u === '%' ? `${n}${u}` : `${n} ${u}`
}

/** Nov 2, from a YYYY-MM-DD read at noon so no zone can tip it a day. */
export function shortDate(day: string | null | undefined): string {
  if (!day) return ''
  const d = new Date(`${day.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// The labels used to sit inside the 6px track's overflow:hidden and never
// showed. The track clips the fill; the labels live under it. The fill runs
// from the start (baseline, or zero when there is none) to the target tick.
export function GoalBar({ goal, display }: { goal: GoalFields; display: GoalDisplay }) {
  const ratio = progressRatio(goal)
  const pct = ratio == null ? 0 : Math.round(ratio * 100)
  const start = goalNumber(goal.baseline) ?? (goal.direction === 'higher' ? 0 : null)
  const target = goalNumber(goal.target)
  return (
    <div
      className={`goal-bar goal-bar--${display}`}
      role="img"
      aria-label={ratio == null ? 'No measurement yet' : `${pct}% of the way to ${goalValue(target, goal.unit)}`}
    >
      <div className="goal-bar__track">
        {ratio != null && <div className="goal-bar__fill" style={{ width: `${pct}%` }} />}
        <span className="goal-bar__target" />
      </div>
      {goal.direction !== 'pass' && (
        <div className="goal-bar__labels">
          <span>{start ?? '—'}</span>
          <span>{goalValue(target, goal.unit)}</span>
        </div>
      )}
    </div>
  )
}

// History is a text tone, not a status: the line is dim, the latest point is
// the one bright mark.
export function Sparkline({ values, width = 88, height = 28, wide = false }: {
  values: number[]
  width?: number
  height?: number
  wide?: boolean
}) {
  if (values.length < 2) return <span className="text-xs text-dim">No history yet</span>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pad = 3
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (width - pad * 2),
    height - pad - ((v - min) / span) * (height - pad * 2),
  ])
  const last = pts[pts.length - 1]
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={`goal-spark${wide ? ' goal-spark--wide' : ''}`}
    >
      <polyline
        fill="none"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
        style={{ stroke: 'var(--text-dim)' }}
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} style={{ fill: 'var(--text)' }} />
    </svg>
  )
}

/** A goal a session trains, as a chip that opens it. Train's session cards carry these. */
export function GoalChip({ goal, onOpen }: {
  goal: { id: string; name: string; current: unknown; target: unknown; unit: string | null; display: GoalDisplay }
  onOpen: (id: string) => void
}) {
  const current = goalNumber(goal.current)
  const target = goalNumber(goal.target)
  return (
    <button
      type="button"
      className={`goal-chip goal-chip--${goal.display}`}
      onClick={(e) => { e.stopPropagation(); onOpen(goal.id) }}
    >
      <span className="goal-chip__name">{goal.name}</span>
      <span className="goal-chip__val num">
        {current ?? '—'}<span className="text-dim">/{target ?? '—'}</span>
      </span>
    </button>
  )
}
