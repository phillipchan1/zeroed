import { useEffect, useState } from 'react'
import { Check, Pause, Play, RotateCcw, Timer } from 'lucide-react'
import {
  fmtElapsed, readRest, skillDone, skillView, STOPWATCH_IDLE, stopwatchSeconds, toggleStopwatch,
  type SkillFields, type Stopwatch,
} from '../engine/skillBlock'
import type { SetLog } from '../types/database'

/**
 * A skill block in the session list (skill_blocks_v1, spec §12). Where a lift
 * shows a set grid and an interval block shows its timer, a station shows its
 * quality target, the suggested window and rest as copy, and Done / Next.
 *
 * Time is never the boss here. The count-up clock and the rest clock run only
 * when the athlete taps them, and neither one ends anything: the only way off
 * this station is the athlete's own Done / Next.
 */
export function SkillBlock({
  ex, logs, onDone, onUndo,
}: {
  ex: SkillFields
  logs: SetLog[]
  /** Mark the station complete and move to the next exercise. */
  onDone: () => void
  /** Take the mark back off. */
  onUndo: () => void
}) {
  const view = skillView(ex)
  const complete = skillDone(logs)
  const [watch, setWatch] = useState<Stopwatch>(STOPWATCH_IDLE)
  const [restFrom, setRestFrom] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // A display tick while either clock runs; it only re-renders.
  const ticking = watch.runningSince != null || restFrom != null
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [ticking])

  const elapsed = stopwatchSeconds(watch, now)
  const rest = restFrom != null ? readRest(restFrom, ex.rest_s, now) : null

  const done = () => {
    setWatch((w) => (w.runningSince != null ? toggleStopwatch(w, Date.now()) : w))
    setRestFrom(null)
    onDone()
  }

  return (
    <div className={`ivl-block${complete ? ' ivl-block--done' : ''}`} data-kind="skill">
      <div className="ivl-block__head">
        <span className="ivl-block__dose num">{view.target}</span>
        <span className="ivl-block__total num" aria-label="Elapsed">{fmtElapsed(elapsed)}</span>
      </div>

      {(view.window || view.rest) && (
        <p className="text-xs text-dim" style={{ marginTop: 6 }}>
          {[view.window && `Suggested ${view.window} for the station`, view.rest && `${view.rest} rest`].filter(Boolean).join(' · ')}
          {' — a guide, not a clock.'}
        </p>
      )}
      {view.cue && (
        <p className="text-sm" style={{ marginTop: 8 }}>{view.cue}</p>
      )}

      <p className={`ivl-block__status${complete ? ' ivl-block__status--done' : ''}`}>
        {complete && <Check size={14} strokeWidth={2.75} style={{ marginRight: 6, flexShrink: 0 }} />}
        {complete
          ? 'Station done'
          : rest
            ? `Resting ${fmtElapsed(rest.elapsed)}${rest.pastSuggestion ? ' — go when you are ready' : ''}`
            : 'Tap Done when the station is done'}
      </p>

      <div className="ivl-block__actions">
        {complete ? (
          <button type="button" className="btn btn--outline" style={{ flex: 1 }} onClick={onUndo}>
            <RotateCcw size={16} strokeWidth={2.2} style={{ marginRight: 8 }} /> Not done yet
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--primary ivl-block__go" style={{ flex: 1 }} onClick={done}>
              <Check size={18} strokeWidth={2.4} style={{ marginRight: 8 }} /> Done / Next
            </button>
            <button
              type="button"
              className="btn btn--outline ivl-block__adjust"
              onClick={() => setWatch((w) => toggleStopwatch(w, Date.now()))}
              aria-label={watch.runningSince != null ? 'Pause elapsed timer' : 'Start elapsed timer'}
              aria-pressed={watch.runningSince != null}
            >
              {watch.runningSince != null
                ? <Pause size={18} strokeWidth={2} />
                : <Play size={18} strokeWidth={2} />}
            </button>
            <button
              type="button"
              className="btn btn--outline ivl-block__adjust"
              onClick={() => setRestFrom((r) => (r != null ? null : Date.now()))}
              aria-label={restFrom != null ? 'Stop rest timer' : 'Start rest timer'}
              aria-pressed={restFrom != null}
            >
              <Timer size={18} strokeWidth={2} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
