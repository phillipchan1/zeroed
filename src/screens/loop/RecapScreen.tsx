import { useNavigate, useParams } from 'react-router-dom'
import { useCachedLoader } from '../../lib/cache'
import { gatherWeeklyRecap, type RecapSession } from '../../engine'
import { unitContext, type UnitContext } from '../../lib/units'
import { toneFor } from '../../lib/directive'
import { Button, SectionHeader, Skeleton, PageHeader, Stat, StatGrid } from '../../components/ui'
import type { SetLog, WeeklyPrescription, WeeklyReviewAdjustments } from '../../types/database'

function fmtRange(startISO: string, endISO: string): string {
  const s = new Date(`${startISO}T12:00:00`)
  const e = new Date(`${endISO}T12:00:00`)
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return mon(s) === mon(e)
    ? `${mon(s)} ${s.getDate()}–${e.getDate()}`
    : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })

function fmtSet(s: SetLog, u: UnitContext): string {
  if (s.weight != null) return `${u.fmt(s.weight)}${u.unit}×${s.reps ?? '?'}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}${u.distance}`
  return `${s.reps ?? '?'} reps`
}

function SessionRow({ s }: { s: RecapSession }) {
  const u = unitContext()
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{s.routineName}</h3>
        <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
          {shortDay(s.performedAt)} · {s.setsDone} sets
          {s.volume?.load ? ` · ${u.volume(s.volume.load)}${u.unit}` : ''}
          {s.rpe != null ? ` · RPE ${s.rpe}` : ''}
        </span>
      </div>
      {s.highlights.length > 0 && (
        <p className="num text-xs text-dim" style={{ marginTop: 8, lineHeight: 1.5 }}>
          {s.highlights.map((h) => `${h.name} ${fmtSet(h.set, u)}`).join('  ·  ')}
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

  const back = () => navigate('/app/today')

  if (loading) {
    return (
      <div className="screen with-nav">
        <div className="page"><div className="page__main">
          <PageHeader eyebrow="Weekly recap" title="…" onBack={back} />
          <div className="card"><Skeleton height={70} width="100%" /></div>
        </div></div>
      </div>
    )
  }

  if (!recap) {
    return (
      <div className="screen with-nav">
        <div className="page"><div className="page__main">
          <PageHeader eyebrow="Weekly recap" title="Nothing yet" onBack={back} />
          <div className="card">
            <p className="text-base text-dim">
              Your first recap lands after a full week of training.
            </p>
          </div>
        </div></div>
      </div>
    )
  }

  const u = unitContext()
  const adj = (recap.review.adjustments ?? null) as WeeklyReviewAdjustments | null
  const presc = (recap.review.next_week_prescription ?? null) as WeeklyPrescription | null
  const directive = presc?.directive ?? 'HOLD'
  const tone = toneFor(directive)
  const adherencePct = adj ? Math.round(adj.adherence * 100) : null
  const delta = presc?.load_delta_pct ?? 0

  return (
    <div className="screen with-nav">
      <div className="page page--rail">
       <div className="page__main">
        <PageHeader eyebrow="Weekly recap" title={fmtRange(recap.weekStart, recap.weekEnd)} onBack={back} />

        {/* The call — the directive for next week, the headline of the recap. */}
        <div className="card fade-rise" style={{ marginBottom: 28, borderLeft: `3px solid ${tone.color}` }}>
          <p className="section-header" style={{ marginBottom: 8 }}>Next week</p>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: '-0.01em', color: tone.color }}>
              {directive}
            </span>
            {delta !== 0 && (
              <span className="num text-sm" style={{ color: tone.color }}>
                {delta > 0 ? '+' : ''}{delta}% load
              </span>
            )}
          </div>
          <p className="text-sm text-dim" style={{ marginTop: 4 }}>{tone.gist}</p>
          {presc?.rationale && (
            <p className="text-base" style={{ marginTop: 14, lineHeight: 1.55 }}>{presc.rationale}</p>
          )}
          {presc?.rpe_target != null && (
            <p className="num text-xs text-dim" style={{ marginTop: 12 }}>Target RPE {presc.rpe_target}</p>
          )}
        </div>

        {/* What you did — the week's training tally, as numbers. */}
        <div className="section">
          <SectionHeader>The week</SectionHeader>
          <div className="fade-rise" style={{ marginTop: 10 }}>
            <StatGrid>
              <Stat value={`${recap.sessions.length}/${recap.planned}`} label="Sessions" />
              {adherencePct !== null && <Stat value={`${adherencePct}%`} label="Adherence" />}
              <Stat value={recap.totalSets} label="Sets" />
              {/* Load moved. Sets alone cannot tell the week that added a set
                  while halving the bar from the week that got stronger. */}
              {!!recap.totalVolume?.load && (
                <Stat value={`${u.volume(recap.totalVolume.load)}${u.unit}`} label="Volume" />
              )}
              <Stat value={adj?.avgRPE ?? '—'} label="Avg RPE" />
              {adj && adj.painCount > 0 && <Stat value={adj.painCount} label="Pain flags" tone="var(--pending)" />}
              {adj && adj.positiveCount > 0 && <Stat value={adj.positiveCount} label="Strong sets" tone="var(--confirmed)" />}
            </StatGrid>
          </div>
        </div>

        {/* What moved — the reads that shifted this week. */}
        {recap.movements.length > 0 && (
          <div className="section">
            <SectionHeader>What the coach saw</SectionHeader>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {recap.movements.map((m) => (
                <div key={m.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                    <span className="section-header" style={{ color: 'var(--computing)' }}>{m.category}</span>
                    <span className="num text-xs text-dim">
                      {m.prevStatus && m.prevStatus !== m.status ? `${m.prevStatus} → ${m.status}` : `${Math.round(m.confidence * 100)}%`}
                    </span>
                  </div>
                  <p className="text-base" style={{ marginTop: 8, lineHeight: 1.5 }}>{m.claim}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* The sessions themselves. */}
        <div className="section">
          <SectionHeader>Sessions logged</SectionHeader>
          <div style={{ marginTop: 10 }}>
            {recap.sessions.length > 0 ? (
              recap.sessions.map((s) => <SessionRow key={s.workoutId} s={s} />)
            ) : (
              <p className="text-sm text-dim">No sessions logged this week.</p>
            )}
          </div>
        </div>

        <Button variant="outline" full onClick={() => navigate('/app/coach')}>
          Ask the coach about this week →
        </Button>
       </div>
      </div>
    </div>
  )
}
