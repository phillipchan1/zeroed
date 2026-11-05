import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { LockOn, TickingNumber } from './ui'
import { success } from '../lib/haptics'
import { playZeroed } from '../lib/restAlert'

/** What a just-finished session came to — handed from the workout screen to
 *  Today through router state, so it never outlives the navigation. */
export interface FinishedSession {
  /** The outbox id it was queued under — lets Train tell whether THIS session
   *  is the one that filled the week. */
  pendingId: string
  name: string
  sets: number
  /** Total load in the DISPLAY unit, already converted. 0 = nothing loaded. */
  volume: number
  unit: string
  minutes: number
  /** Lifts that set a record this session, in the order they were done. */
  prLifts: string[]
  /** The goals this session moved or held (tracks_v1). Absent on older entries. */
  goals?: FinishedGoal[]
}

export interface FinishedGoal {
  id: string
  name: string
  unit: string | null
  /** The goal's current before this session; null if it had none. */
  from: number | null
  to: number
  target: number | null
  hit: boolean
  /** An estimate at the target: one set would prove it. */
  confirm?: boolean
  /** How the reading was earned (engine/evidence.ts). */
  tier?: 'tested' | 'strong' | 'estimate' | 'inferred'
}

const HOLD_MS = 4000
// Goals moved is a second beat after the stats, so the moment holds a little
// longer for each goal it names (capped; a tap still skips).
const GOAL_BEAT_MS = 600
const holdFor = (goals: number) => HOLD_MS + Math.min(goals, 3) * GOAL_BEAT_MS
const fmt = (n: number) => n.toLocaleString()
// The count-up runs in JS, so the CSS reduced-motion rule can't reach it.
const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * The finish line. A session used to end on a form and then land on whatever
 * screen was next; the one moment an athlete has earned something passed with no
 * acknowledgment at all. This is that acknowledgment: the check locks on, the
 * numbers count up to what you just did, a record gets named. Then it gets out
 * of the way on its own — tap to skip, or it leaves after a few seconds.
 *
 * It celebrates numbers the athlete actually produced, never a streak or a
 * badge invented to make them come back.
 */
export function SessionZeroed({ session, week, onDone }: {
  session: FinishedSession
  /** Set when this session filled the week's plan. */
  week?: { done: number; planned: number } | null
  onDone: () => void
}) {
  const [counting, setCounting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    // Start the count-up just after the check lands, and leave on our own.
    const start = setTimeout(() => { setCounting(true); success(); playZeroed() }, 450)
    const leave = setTimeout(() => setLeaving(true), holdFor(session.goals?.length ?? 0))
    return () => { clearTimeout(start); clearTimeout(leave) }
  }, [])

  // The exit animation is what hands control back. If it never reports its end
  // (a backgrounded tab throttles animations), don't leave Today covered.
  useEffect(() => {
    if (!leaving) return
    const fallback = setTimeout(() => doneRef.current(), 600)
    return () => clearTimeout(fallback)
  }, [leaving])

  const stats: { value: number; label: string }[] = [
    { value: session.sets, label: session.sets === 1 ? 'set' : 'sets' },
    ...(session.volume > 0 ? [{ value: session.volume, label: `${session.unit} moved` }] : []),
    ...(session.minutes > 0 ? [{ value: session.minutes, label: 'min' }] : []),
  ]
  const prs = session.prLifts
  const goals = (session.goals ?? []).slice(0, 3)

  return (
    <div
      className={`zeroed-moment${leaving ? ' zeroed-moment--out' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`Session logged: ${session.name}`}
      onClick={() => setLeaving(true)}
      onAnimationEnd={(e) => { if (e.animationName === 'zeroed-out') doneRef.current() }}
      style={{ '--zeroed-hold': `${holdFor(session.goals?.length ?? 0)}ms` } as React.CSSProperties}
    >
      <span className="zeroed-moment__timer" aria-hidden />

      <LockOn style={{ '--lock-gap': '-14px', '--lock-from': '22px' } as React.CSSProperties}>
        <span className="zeroed-moment__mark">
          <Check size={36} strokeWidth={2.75} style={{ color: 'var(--signal)' }} />
        </span>
      </LockOn>

      <p className="eyebrow zeroed-moment__eyebrow converge">{week ? 'Week zeroed' : 'Session zeroed'}</p>
      <h1 className="screen-title zeroed-moment__title">{session.name}</h1>

      <div className="zeroed-moment__stats">
        {stats.map((s) => (
          <div key={s.label}>
            <TickingNumber
              className="zeroed-moment__stat-value"
              value={counting ? s.value : 0}
              duration={reducedMotion() ? 1 : 700}
              format={fmt}
            />
            <span className="eyebrow zeroed-moment__stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      {prs.length > 0 && (
        <p className="zeroed-moment__pr">
          <span className="chip chip--pending" style={{ color: 'var(--signal)' }}>
            {prs.length === 1 ? 'PR' : `${prs.length} PRs`}
          </span>
          <span className="text-sm" style={{ marginLeft: 10, color: 'var(--text)' }}>
            {prs.slice(0, 2).join(' · ')}{prs.length > 2 ? ` +${prs.length - 2}` : ''}
          </span>
        </p>
      )}

      {goals.length > 0 && (
        <div className="zeroed-goals">
          <p className="eyebrow zeroed-goals__k">What today told us</p>
          {goals.map((g, i) => {
            const moved = g.from == null || g.to !== g.from
            const row = (
              <div className={`zeroed-goal${g.hit ? ' zeroed-goal--hit' : ''}`} style={{ animationDelay: `${900 + i * 160}ms` }}>
                <span className="zeroed-goal__name">{g.name}</span>
                <span className="zeroed-goal__val num">
                  {moved
                    ? <TickingNumber value={counting ? g.to : (g.from ?? g.to)} duration={reducedMotion() ? 1 : 700} />
                    : g.to}
                  {g.target != null && <span className="text-dim"> / {g.target}{g.unit ? ` ${g.unit}` : ''}</span>}
                </span>
                <span className="zeroed-goal__tag">
                  {g.hit ? 'Zeroed'
                    : g.confirm ? 'Confirm it'
                      : g.tier === 'estimate' || g.tier === 'strong' ? 'Estimate'
                        : g.tier === 'inferred' ? 'Inferred'
                          : moved ? 'Moved' : 'Held'}
                </span>
              </div>
            )
            return g.hit ? (
              <LockOn
                key={g.id}
                className="zeroed-goal__lock"
                style={{ '--lock-gap': '-6px', '--lock-from': '14px', '--lock-size': '9px', '--lock-color': 'var(--confirmed)' } as React.CSSProperties}
              >
                {row}
              </LockOn>
            ) : <div key={g.id}>{row}</div>
          })}
        </div>
      )}

      {week && (
        <p className="zeroed-moment__pr num text-sm" style={{ color: 'var(--confirmed)' }}>
          {week.done} of {week.planned} this week · every session in
        </p>
      )}

      <p className="eyebrow zeroed-moment__hint">Tap to continue</p>
    </div>
  )
}
