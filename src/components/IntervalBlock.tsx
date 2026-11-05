import { useState } from 'react'
import { Check, Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { OUTPUT_UNITS, normalizeOutputUnit, type OutputUnit } from '../engine/evidence'
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
  plan, logs, onStart, onAdjust, outputUnit = null, onOutput,
}: {
  plan: IntervalPlan
  logs: SetLog[]
  /** The unit a goal on this block reads output in; the athlete can change it. */
  outputUnit?: OutputUnit | null
  /**
   * Log what the erg showed for one row (a round, or a set of rounds). Output
   * per round is the engine's e1RM: same RPE, more output, better engine; and
   * last round over first is how much the efforts fade.
   */
  onOutput?: (rowIdx: number, value: number | null, unit: OutputUnit) => void
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
  const loggedUnit = normalizeOutputUnit(logs.find((l) => l.output_unit)?.output_unit)
  const [unit, setUnit] = useState<OutputUnit>(loggedUnit ?? outputUnit ?? 'cal')
  const [showOutput, setShowOutput] = useState(outputUnit != null || logs.some((l) => l.output != null))
  const rows = logs.map((l, i) => ({ l, i })).filter(({ l }) => l.done || (l.duration ?? 0) > 0)

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

      {onOutput && rows.length > 0 && (
        showOutput ? (
          <div className="ivl-output">
            <div className="ivl-output__units" role="group" aria-label="Output unit">
              <span className="text-xs text-dim" style={{ marginRight: 4 }}>Output per {plan.rows === 'round' ? 'round' : 'set'}</span>
              {OUTPUT_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  className={`chip ${unit === u ? 'chip--doing' : 'chip--todo'}`}
                  aria-pressed={unit === u}
                  onClick={() => {
                    setUnit(u)
                    rows.forEach(({ l, i }) => { if (l.output != null) onOutput(i, l.output, u) })
                  }}
                >
                  {u}
                </button>
              ))}
            </div>
            <div className="ivl-output__grid">
              {rows.map(({ l, i }) => (
                <input
                  key={i}
                  className="set-row__input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  placeholder={`${plan.rows === 'round' ? 'R' : 'S'}${i + 1}`}
                  aria-label={`${plan.rows === 'round' ? 'Round' : 'Set'} ${i + 1} output in ${unit}`}
                  value={l.output ?? ''}
                  onChange={(e) => {
                    const n = e.target.value === '' ? null : Math.max(0, Number(e.target.value))
                    onOutput(i, n != null && Number.isFinite(n) ? n : null, unit)
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn--ghost text-xs" style={{ alignSelf: 'flex-start', padding: '0 4px', color: 'var(--text-dim)' }} onClick={() => setShowOutput(true)}>
            + Log output (cal, m or W)
          </button>
        )
      )}

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
