import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useCachedLoader } from '../../lib/cache'
import { gatherWeeklyRecap, type RecapSession } from '../../engine'
import { getWeightUnit, getDistanceUnit } from '../../lib/units'
import { Button, SectionHeader, Skeleton } from '../../components/ui'
import type { SetLog, WeeklyDirective, WeeklyPrescription, WeeklyReviewAdjustments } from '../../types/database'

// Directive → colour + plain-language gist for the recap banner.
const DIRECTIVE_TONE: Record<WeeklyDirective, { color: string; gist: string }> = {
  PROGRESS:        { color: 'var(--confirmed)', gist: 'Earned more load' },
  HOLD:            { color: 'var(--text-dim)',  gist: 'Holding the line' },
  'HOLD (missed)': { color: 'var(--pending)',   gist: 'Resetting the week' },
  DELOAD:          { color: 'var(--pending)',   gist: 'Backing off to recover' },
}

function fmtRange(startISO: string, endISO: string): string {
  const s = new Date(`${startISO}T12:00:00`)
  const e = new Date(`${endISO}T12:00:00`)
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return mon(s) === mon(e)
    ? `${mon(s)} ${s.getDate()}–${e.getDate()}`
    : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })

function fmtSet(s: SetLog, unit: string, distanceUnit: string): string {
  if (s.weight != null) return `${s.weight}${unit}×${s.reps ?? '?'}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}${distanceUnit}`
  return `${s.reps ?? '?'} reps`
}

function StatTile({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 72 }}>
      <p className="num" style={{ fontSize: 22, fontWeight: 600, color: tone ?? 'var(--text)' }}>{value}</p>
      <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
        {label}
      </p>
    </div>
  )
}

function SessionRow({ s }: { s: RecapSession }) {
  const unit = getWeightUnit()
  const distanceUnit = getDistanceUnit(unit)
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>{s.routineName}</h3>
        <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
          {shortDay(s.performedAt)} · {s.setsDone} set{s.setsDone === 1 ? '' : 's'}{s.rpe != null ? ` · RPE ${s.rpe}` : ''}
        </span>
      </div>
      {s.highlights.length > 0 && (
        <p className="num text-xs text-dim" style={{ marginTop: 6, lineHeight: 1.5 }}>
          {s.highlights.map((h) => `${h.name} ${fmtSet(h.set, unit, distanceUnit)}`).join('  ·  ')}
        </p>
      )}
    </div>
  )
}

/**
 * WEEKLY RECAP — the end-of-week review. What you did (sessions, sets, RPE,
 * adherence), what the coach saw (the reads that moved, the flags), and the call
 * for next week (PROGRESS / HOLD / DELOAD with the why). The week's payoff.
 */
export function RecapScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const { reviewId } = useParams<{ reviewId?: string }>()

  const { data: recap, loading } = useCachedLoader(
    `recap:${athleteId}:${reviewId ?? 'latest'}`,
    () => gatherWeeklyRecap(athleteId, reviewId),
  )

  const back = (
    <button
      type="button"
      className="btn btn--ghost"
      style={{ padding: '0 8px', height: 32, minWidth: 36, marginBottom: 8 }}
      onClick={() => navigate('/app/today')}
      aria-label="Back"
    >
      <ChevronLeft size={20} strokeWidth={1.5} />
    </button>
  )

  if (loading) {
    return (
      <div className="screen with-nav">
        <div className="page"><div className="page__main">
          {back}
          <Skeleton height={12} width={90} /><div style={{ height: 10 }} />
          <Skeleton height={26} width={180} /><div style={{ height: 18 }} />
          <div className="card"><Skeleton height={60} width="100%" /></div>
        </div></div>
      </div>
    )
  }

  if (!recap) {
    return (
      <div className="screen with-nav">
        <div className="page"><div className="page__main">
          {back}
          <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>Weekly recap</h2>
          <div className="card">
            <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
              No recap yet — your first one lands after a full week of training. Log a few sessions and check back.
            </p>
          </div>
        </div></div>
      </div>
    )
  }

  const adj = (recap.review.adjustments ?? null) as WeeklyReviewAdjustments | null
  const presc = (recap.review.next_week_prescription ?? null) as WeeklyPrescription | null
  const directive = presc?.directive ?? 'HOLD'
  const tone = DIRECTIVE_TONE[directive] ?? DIRECTIVE_TONE.HOLD
  const adherencePct = adj ? Math.round(adj.adherence * 100) : null
  const delta = presc?.load_delta_pct ?? 0

  return (
    <div className="screen with-nav">
      <div className="page page--rail">
       <div className="page__main">
        {back}
        <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
          Weekly recap
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginTop: 4, marginBottom: 20 }}>
          {fmtRange(recap.weekStart, recap.weekEnd)}
        </h2>

        {/* The call — the directive for next week, the headline of the recap. */}
        <div className="card fade-rise" style={{ marginBottom: 20, borderColor: tone.color }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, letterSpacing: '0.04em', color: tone.color }}>
              {directive}
            </span>
            {delta !== 0 && (
              <span className="num text-xs" style={{ color: tone.color }}>
                {delta > 0 ? '+' : ''}{delta}% load
              </span>
            )}
          </div>
          <p className="text-xs text-dim" style={{ marginTop: 2, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Next week · {tone.gist}
          </p>
          {presc?.rationale && (
            <p className="text-sm" style={{ marginTop: 10, lineHeight: 1.5 }}>{presc.rationale}</p>
          )}
          {presc?.rpe_target != null && (
            <p className="num text-xs text-dim" style={{ marginTop: 8 }}>Target RPE {presc.rpe_target}</p>
          )}
        </div>

        {/* What you did — the week's training tally. */}
        <SectionHeader>The week</SectionHeader>
        <div className="card fade-rise" style={{ marginTop: 10, marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatTile value={`${recap.sessions.length}/${recap.planned}`} label="Sessions" />
          {adherencePct !== null && <StatTile value={`${adherencePct}%`} label="Adherence" />}
          <StatTile value={recap.totalSets} label="Sets" />
          <StatTile value={adj?.avgRPE ?? '—'} label="Avg RPE" />
          {adj && adj.painCount > 0 && <StatTile value={adj.painCount} label="Pain flags" tone="var(--pending)" />}
          {adj && adj.positiveCount > 0 && <StatTile value={adj.positiveCount} label="Strong sets" tone="var(--confirmed)" />}
        </div>

        {/* What moved — the reads that shifted this week. */}
        {recap.movements.length > 0 && (
          <>
            <SectionHeader>What the coach saw</SectionHeader>
            <div style={{ marginTop: 10, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recap.movements.map((m) => (
                <div key={m.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                    <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--computing)' }}>
                      {m.category}
                    </span>
                    <span className="num text-xs text-dim">
                      {m.prevStatus && m.prevStatus !== m.status ? `${m.prevStatus} → ${m.status}` : `${Math.round(m.confidence * 100)}%`}
                    </span>
                  </div>
                  <p className="text-sm" style={{ marginTop: 6, lineHeight: 1.5 }}>{m.claim}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* The sessions themselves. */}
        <SectionHeader>Sessions logged</SectionHeader>
        <div style={{ marginTop: 10 }}>
          {recap.sessions.length > 0 ? (
            recap.sessions.map((s) => <SessionRow key={s.workoutId} s={s} />)
          ) : (
            <p className="text-sm text-dim">No sessions logged this week.</p>
          )}
        </div>

        <Button variant="ghost" full style={{ marginTop: 16 }} onClick={() => navigate('/app/coach')}>
          Ask the coach about this week →
        </Button>
       </div>
      </div>
    </div>
  )
}
