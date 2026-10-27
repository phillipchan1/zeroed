import { Check, Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import {
  roundsFromLogs, blockSeconds, describePlan, fmtClock, type IntervalPlan,
} from '../engine/intervals'
import { primeCueAudio } from '../lib/intervalCues'
import type { SetLog } from '../types/database'

/**
 * An interval block in the session list. Where a lift shows a set grid, a block
 * shows what it is (8 × 20s / 40s, 8:00), every round as a segment, and one
 * button — the coach's prescription already IS the timer's setup, so starting
 * it is the whole interaction. Done, it says what was banked.
 */
export function IntervalBlock({
  plan, logs, onStart, onAdjust,
}: {
  plan: IntervalPlan
  logs: SetLog[]
  /** Called inside the tap (audio is unlocked before this runs). */
  onStart: () => void
  onAdjust: () => void
}) {
  const done = roundsFromLogs(plan, logs)
  const banked = done.reduce((a, b) => a + b, 0)
  const total = plan.rounds * plan.sets
  const complete = banked >= total
  const rpes = logs.map((l) => l.rpe).filter((r): r is number => r != null)
  const rpe = rpes.length ? Math.round(rpes.reduce((a, b) => a + b, 0) / rpes.length) : null
  const workTotal = banked * plan.work

  const start = () => { primeCueAudio(); onStart() }

  return (
    <div className={`ivl-block${complete ? ' ivl-block--done' : ''}`}>
      <div className="ivl-block__head">
        <span className="ivl-block__dose num">{describePlan(plan)}</span>
        <span className="ivl-block__total num">{fmtClock(blockSeconds(plan))}</span>
      </div>

      <div className="ivl-block__rounds" aria-label={`${banked} of ${total} rounds done`}>
        {Array.from({ length: plan.sets }, (_, s) => (
          <div key={s} className="ivl__set">
            {Array.from({ length: plan.rounds }, (_, r) => (
              <span
                key={r}
                className={`ivl__seg${r < done[s] ? ' ivl__seg--done' : ''}`}
                style={r < done[s] ? { animationDelay: `${Math.min(r, 12) * 30}ms` } : undefined}
              />
            ))}
          </div>
        ))}
      </div>

      <p className={`ivl-block__status${complete ? ' ivl-block__status--done' : ''}`}>
        {complete && <Check size={14} strokeWidth={2.75} style={{ marginRight: 6, flexShrink: 0 }} />}
        {banked === 0
          ? `${total} rounds · ${fmtClock(plan.work * total)} of work`
          : complete
            ? `All ${total} rounds · ${fmtClock(workTotal)} of work${rpe != null ? ` · RPE ${rpe}` : ''}`
            : `${banked} of ${total} rounds · ${fmtClock(workTotal)} of work${rpe != null ? ` · RPE ${rpe}` : ''}`}
      </p>

      <div className="ivl-block__actions">
        {complete ? (
          <button type="button" className="btn btn--outline" style={{ flex: 1 }} onClick={start}>
            <RotateCcw size={16} strokeWidth={2.2} style={{ marginRight: 8 }} /> Run again
          </button>
        ) : (
          <button type="button" className="btn btn--primary ivl-block__go" style={{ flex: 1 }} onClick={start}>
            <Play size={18} strokeWidth={2.2} fill="currentColor" style={{ marginRight: 8 }} />
            {banked > 0 ? 'Run it again' : 'Start intervals'}
          </button>
        )}
        <button type="button" className="btn btn--outline ivl-block__adjust" onClick={onAdjust} aria-label="Adjust intervals">
          <SlidersHorizontal size={18} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
