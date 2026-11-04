import { useState } from 'react'
import { Chip, Skeleton } from '../../components/ui'
import { useCachedLoader } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { unitContext } from '../../lib/units'
import {
  CALL_LABEL, CALL_TONE, TREND_MARK, checkinLine, complianceLine, isEmptyWeek, liftLine, liftName,
  painLine, regionLabel, sessionLoadLine, weekChoices, weekRangeLabel, whyLine, type WeeklyReview,
} from '../../lib/weeklyReview'
import { fetchWeeklyReview } from '../../lib/weeklyReviewClient'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wreview__sec">
      <p className="wreview__h">{title}</p>
      {children}
    </div>
  )
}

function ReviewBody({ review }: { review: WeeklyReview }) {
  const u = unitContext()
  const c = complianceLine(review.compliance)
  const empty = isEmptyWeek(review)
  return (
    <>
      <div className={`wreview__call wreview__call--${review.call}`}>
        <p className="wreview__k">
          <Chip tone={CALL_TONE[review.call]}>{CALL_LABEL[review.call]}</Chip>
          <span className="wreview__range">{weekRangeLabel(review.week_start, review.week_end)}</span>
        </p>
        <p className="wreview__why">
          {whyLine(review)}
          {review.rule_refs.map((r) => <span key={r} className="change__rule num">{r}</span>)}
        </p>
      </div>

      {empty && (
        <p className="wreview__empty">Nothing logged this week yet. The review fills in as you train and check in.</p>
      )}

      <Section title="Compliance">
        <p className="wreview__line">
          <span className="num">{c.main}</span>
          <span className={`wreview__aside${review.compliance.met === false ? ' wreview__aside--under' : ''}`}>{c.target}</span>
        </p>
      </Section>

      {review.priority_lifts.length > 0 && (
        <Section title="Priority lifts · e1RM">
          {review.priority_lifts.map((l) => {
            const line = liftLine(l, u.fmt, u.unit)
            return (
              <p key={l.lift} className={`wreview__line wreview__trend--${l.trend}`}>
                <span className="wreview__mark" aria-hidden>{TREND_MARK[l.trend]}</span>
                <span className="wreview__name">{liftName(l.lift)}</span>
                <span className="wreview__detail num">{line.value}{line.change ? ` · ${line.change}` : ''}</span>
              </p>
            )
          })}
        </Section>
      )}

      {review.maintenance.length > 0 && (
        <Section title="Maintenance held">
          {review.maintenance.map((m) => (
            <p key={m.exercise} className="wreview__line">
              <span className="wreview__name">{m.exercise}</span>
              <span className="wreview__detail">
                {m.held == null ? 'Not trained' : m.held ? 'Held' : 'Not held'} · {m.why}
              </span>
            </p>
          ))}
        </Section>
      )}

      {review.pain && (review.pain.regions.length > 0 || review.pain.blocked.length > 0) && (
        <Section title={`Pain · cap ${review.pain.cap}/10`}>
          {review.pain.regions.map((p) => (
            <p key={p.region} className={`wreview__line${p.max > review.pain!.cap ? ' wreview__line--over' : ''}`}>
              <span className="wreview__name">{regionLabel(p.region)}</span>
              <span className="wreview__detail num">{painLine(p)}</span>
            </p>
          ))}
          {review.pain.blocked.length > 0 && (
            <p className="wreview__line wreview__line--over">
              Blocked: {review.pain.blocked.map(regionLabel).join(', ')}. No loading there until a clinician clears it (U7).
            </p>
          )}
        </Section>
      )}

      {review.checkins && (
        <Section title="Check-ins">
          <p className="wreview__line num">{checkinLine(review.checkins)}</p>
        </Section>
      )}

      {review.session_load && (
        <Section title="Session load">
          <p className="wreview__line num">{sessionLoadLine(review.session_load)}</p>
        </Section>
      )}

      <p className="wreview__foot">Methodology {review.methodology_version}. Any change it suggests comes to you as a proposal first.</p>
    </>
  )
}

/**
 * The weekly review (tracks_v1, G8 / U15) under Program: the engine's own
 * read of the week — compliance, priority-lift e1RM trend, maintenance,
 * pain, check-ins, session load — and its progress / hold / deload call with
 * the why and the rules behind it. This week or last week.
 */
export function WeeklyReviewCard({ athleteId, thisWeekStart }: { athleteId: string; thisWeekStart: string }) {
  const choices = weekChoices(thisWeekStart)
  const [pick, setPick] = useState<'this' | 'previous'>('this')
  const chosen = choices.find((c) => c.key === pick) ?? choices[0]
  const { data, loading, refetch } = useCachedLoader(
    cacheKeys.weeklyReview(athleteId, chosen.week ?? 'this'),
    () => fetchWeeklyReview(chosen.week),
  )

  return (
    <div className="wreview">
      <div className="tabseg" role="tablist" aria-label="Which week">
        <span className="tabseg__ind" style={{ transform: pick === 'previous' ? 'translateX(100%)' : undefined }} aria-hidden />
        {choices.map((c) => (
          <button key={c.key} type="button" role="tab" aria-selected={pick === c.key} className="tabseg__opt" onClick={() => setPick(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
      {loading || !data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={56} />
          <Skeleton height={16} width="70%" />
          <Skeleton height={16} width="55%" />
        </div>
      ) : data.status === 'ok' ? (
        <ReviewBody review={data.review} />
      ) : data.status === 'off' ? (
        <p className="wreview__empty">The weekly review isn’t available here yet.</p>
      ) : (
        <div>
          <p className="wreview__empty">{data.text}</p>
          <button type="button" className="change__undo" onClick={refetch}>Try again</button>
        </div>
      )}
    </div>
  )
}
