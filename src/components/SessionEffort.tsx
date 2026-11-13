import { SESSION_RPE_VALUES, sessionRpeWord } from '../engine/outsidePlan'

// =============================================================================
// Session effort — the one tap that makes session load (RPE × minutes).
//
// Foster's CR-10: how hard the WHOLE session was, 0 to 10. Deliberately not the
// set-RPE picker: that one asks how close a set came to failure, and averaging
// it is what workout.rpe already holds. Same question after a lift, a Tabata, a
// run or a BJJ class, so every kind of session lands in one currency.
// =============================================================================

interface Props {
  value: number | null
  onChange: (rpe: number) => void
  disabled?: boolean
  /** Lowest rating offered. 0 (rest) by default; a sport log (log_session_v1) starts at 1. */
  min?: number
}

export function SessionEffort({ value, onChange, disabled, min = 0 }: Props) {
  return (
    <div className="effort">
      <div className="effort__head">
        <span className="text-sm" id="effort-label">How hard was the whole session?</span>
        <span className="num text-xs text-dim" aria-live="polite">
          {value != null ? `${value} · ${sessionRpeWord(value)}` : min > 0 ? `${min} ${sessionRpeWord(min).toLowerCase()} · 10 max` : '0 rest · 10 max'}
        </span>
      </div>
      <div className="effort__grid" role="radiogroup" aria-labelledby="effort-label">
        {SESSION_RPE_VALUES.filter((v) => v >= min).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            aria-label={`${v}, ${sessionRpeWord(v)}`}
            className="score-btn effort__btn"
            disabled={disabled}
            onClick={() => onChange(v)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}
