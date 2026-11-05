import { GOAL_DISPLAY_LABEL, goalNumber, progressRatio, type GoalDisplay, type GoalFields } from '../../engine/goals'
import { CAPACITY_TIER_LABEL, type GoalCapacity, type TestReason } from '../../engine/capacity'
import type { WeakLink } from '../../engine/weakLinks'
import type { Signal } from '../../engine/signals'

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

/**
 * Will this goal get there: real measurements as a line, the target as a dashed
 * rule, the due date as a dashed post, and a cone from the latest point to
 * where the trend lands on the due date. The cone's color is the status, so an
 * off-course goal's cone visibly misses the target. Clocks don't ease here:
 * the line draws once on arrival, then holds.
 */
export function ForecastChart({ history, target, due, forecast, display, unit, direction }: {
  history: Array<{ date: string; value: number }>
  target: number | null
  due: string | null
  forecast: { value: number } | null
  display: GoalDisplay
  unit: string | null
  direction: string
}) {
  const W = 320
  const H = 150
  const pad = { l: 34, r: 40, t: 12, b: 22 }
  const day = (d: string) => Math.round(Date.parse(`${d.slice(0, 10)}T12:00:00Z`) / 86_400_000)
  const pts = history.filter((h) => Number.isFinite(h.value)).map((h) => ({ x: day(h.date), y: h.value, date: h.date }))
  if (pts.length < 2 && !(pts.length === 1 && due)) {
    return <p className="text-xs text-dim">Two measurements draw a trend.</p>
  }
  const dueX = due ? day(due) : null
  const x0 = pts[0].x - 2
  const x1 = Math.max(pts[pts.length - 1].x, dueX ?? pts[pts.length - 1].x) + 2
  const ys = pts.map((p) => p.y).concat(target != null ? [target] : []).concat(forecast ? [forecast.value] : [])
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1)
  lo -= span * 0.18
  hi += span * 0.18
  const X = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r)
  const Y = (y: number) => pad.t + (1 - (y - lo) / (hi - lo)) * (H - pad.t - pad.b)
  const last = pts[pts.length - 1]
  const width = (hi - lo) * 0.06
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ')
  const fmtDay = (d: string) => shortDate(d)
  const towardBand = target != null
    ? direction === 'lower' ? { y: Y(target), h: H - pad.b - Y(target) } : { y: pad.t, h: Y(target) - pad.t }
    : null
  return (
    <svg className="forecast-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`History${forecast ? `, forecast ${goalValue(forecast.value, unit)}` : ''}${target != null ? `, target ${goalValue(target, unit)}` : ''}`}>
      {towardBand && towardBand.h > 0 && <rect className="forecast-chart__band" x={pad.l} y={towardBand.y} width={W - pad.l - pad.r} height={towardBand.h} />}
      {target != null && (
        <>
          <line className="forecast-chart__target" x1={pad.l} x2={W - pad.r} y1={Y(target)} y2={Y(target)} />
          <text className="forecast-chart__label forecast-chart__label--strong" x={pad.l - 6} y={Y(target) + 3} textAnchor="end">{target}</text>
        </>
      )}
      {dueX != null && (
        <>
          <line className="forecast-chart__due" x1={X(dueX)} x2={X(dueX)} y1={pad.t} y2={H - pad.b} />
          <text className="forecast-chart__label" x={X(dueX)} y={H - 6} textAnchor="middle">{fmtDay(due!)}</text>
        </>
      )}
      <text className="forecast-chart__label" x={X(pts[0].x)} y={H - 6} textAnchor="start">{fmtDay(pts[0].date)}</text>
      {forecast && dueX != null && display !== 'zeroed' && (
        <>
          <polygon
            className={`forecast-chart__cone forecast-chart__cone--${display}`}
            points={`${X(last.x)},${Y(last.y)} ${X(dueX)},${Y(forecast.value + width)} ${X(dueX)},${Y(forecast.value - width)}`}
          />
          <text className={`forecast-chart__label forecast-chart__fc--${display}`} x={X(dueX) + 6} y={Y(forecast.value) + 3}>{forecast.value}</text>
        </>
      )}
      {pts.length > 1 && <path className="forecast-chart__line" pathLength={1} d={line} />}
      {pts.map((p, i) => (
        <circle
          key={`${p.date}-${i}`}
          className={`forecast-chart__dot${i === pts.length - 1 ? ' forecast-chart__dot--last' : ''}`}
          cx={X(p.x)} cy={Y(p.y)} r={i === pts.length - 1 ? 3.6 : 2.8}
          style={{ animationDelay: `${i * 70}ms` }}
        />
      ))}
    </svg>
  )
}

function rounded(n: number): number {
  return Math.abs(n) >= 20 ? Math.round(n) : Math.round(n * 10) / 10
}

/**
 * How sure the number is: a tier and a range. "Estimated · 296–318 lb ·
 * Nov 2". A tested number shows no range worth reading, so it shows the date.
 */
export function CapacityLine({ capacity, unit }: { capacity: GoalCapacity | null; unit: string | null }) {
  if (!capacity) return null
  const range = capacity.tier === 'tested'
    ? null
    : `${rounded(capacity.lo)}–${goalValue(rounded(capacity.hi), unit)}`
  return (
    <p className={`capacity-line capacity-line--${capacity.tier}`}>
      <span className="capacity-line__tier">{CAPACITY_TIER_LABEL[capacity.tier]}</span>
      {range && <span className="num">{range}</span>}
      <span className="text-dim">{capacity.tier === 'stale' ? `last ${shortDate(capacity.last_evidence)}` : shortDate(capacity.last_evidence)}</span>
    </p>
  )
}

/** Why the goal wants a test, when it does. Silence means the log is answering. */
export function TestReasonNote({ reason, display }: { reason: TestReason | null; display: GoalDisplay }) {
  if (!reason) return null
  return (
    <p className={`test-reason test-reason--${display}`}>
      {reason.text}
    </p>
  )
}

/**
 * The biggest weak link and the cross-domain reads, as plain sentences. Only
 * the top weak link leads; the rest are a tap away, so the card names one
 * thing to act on, not a report.
 */
export function WeakLinksCard({ links, signals }: { links: WeakLink[]; signals: Signal[] }) {
  if (!links.length && !signals.length) return null
  const [lead, ...rest] = links
  return (
    <div className="card fade-rise weak-links">
      <div className="weak-links__h">
        <span>Weak links</span>
        <span className="text-xs text-dim">read from your training</span>
      </div>
      {lead && (
        <div className="weak-link weak-link--lead">
          <p className="text-sm">{lead.text}</p>
          <p className="text-xs text-dim">
            {lead.basis === 'own' ? 'Against your own earlier ratio.' : lead.basis === 'prior' ? 'Against the usual ratio; your build can move it.' : 'Side against side.'}
          </p>
        </div>
      )}
      {rest.length > 0 && (
        <details className="weak-links__more">
          <summary className="text-xs">{rest.length} more</summary>
          {rest.map((l, i) => <p key={i} className="text-sm weak-link">{l.text}</p>)}
        </details>
      )}
      {signals.length > 0 && (
        <div className="weak-links__signals">
          {signals.map((s) => (
            <p key={s.kind} className="text-sm weak-link weak-link--signal" title={s.evidence}>{s.text}</p>
          ))}
        </div>
      )}
    </div>
  )
}
