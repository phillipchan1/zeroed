import { useNavigate } from 'react-router-dom'
import { Calendar, Clock, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { useCachedLoader } from '../../lib/cache'
import { unitContext } from '../../lib/units'
import {
  gatherProgramJourney, gatherProgramArc,
  type JourneyEntry, type LiftTrajectory, type ProgramHistorySummary,
} from '../../engine'
import { PageHeader, SectionHeader, Skeleton, Chip } from '../../components/ui'

/**
 * YOUR TRAINING SO FAR — the journey, made visible.
 *
 * Before program_revision existed this screen could not have been built. The
 * editor overwrote routine rows in place and left a coach_message carrying
 * counts, so the app could tell you what your program IS and nothing about how
 * it got that way: which blocks you'd run, when you changed something, what you
 * asked for, whether the change stuck.
 *
 * Two halves, in the order they answer questions:
 *   · ARE YOU GETTING STRONGER — each lift's arc, first → best → current, with a
 *     direction the eye can read before the numbers. This is the question the
 *     app is ultimately for, and until now it was only ever answered one lift at
 *     a time, buried in a chart.
 *   · WHAT HAPPENED, AND WHEN — blocks and changes on one timeline, newest
 *     first, each change carrying the athlete's own words for why.
 */
export function ProgramJourneyScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const u = unitContext()

  // One loader, one cache key — the arc and the timeline are two views of the
  // same record and must never render from reads that disagree.
  const { data, loading } = useCachedLoader<{
    entries: JourneyEntry[]
    history: ProgramHistorySummary | null
  }>(`journey:${athleteId}`, async () => {
    const [entries, history] = await Promise.all([
      gatherProgramJourney(athleteId),
      gatherProgramArc(athleteId, u),
    ])
    return { entries, history }
  })

  const entries = data?.entries ?? []
  const trajectories = data?.history?.trajectories ?? []

  return (
    <div className="screen with-nav">
      <div className="page">
        <PageHeader
          eyebrow="Your training"
          title="So far"
          subtitle="Every block you've run, every time you changed the program, and what your lifts have actually done."
          onBack={() => navigate('/app/program')}
        />

        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
            <Skeleton height={12} width={120} />
            <Skeleton height={28} width="100%" />
            <Skeleton height={20} width="70%" />
          </div>
        ) : (
          <>
            {trajectories.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <SectionHeader>Where your lifts have gone</SectionHeader>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                  {trajectories.map((t) => <TrajectoryRow key={t.name} t={t} />)}
                </div>
              </div>
            )}

            <div style={{ marginTop: trajectories.length ? 32 : 24 }}>
              <SectionHeader>What happened, and when</SectionHeader>
              {entries.length === 0 ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <p className="text-base text-dim" style={{ lineHeight: 1.55 }}>
                    Nothing on the timeline yet. Your first block and every change you make to it
                    will land here.
                  </p>
                </div>
              ) : (
                <ol className="journey">
                  {entries.map((e) => <JourneyRow key={`${e.kind}-${e.id}`} entry={e} />)}
                </ol>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const DIRECTION_TONE: Record<LiftTrajectory['direction'], string> = {
  up:   'var(--confirmed)',
  flat: 'var(--text-dim)',
  down: 'var(--veto)',
}

function DirectionIcon({ direction }: { direction: LiftTrajectory['direction'] }) {
  const props = { size: 14, strokeWidth: 2 } as const
  if (direction === 'up')   return <TrendingUp {...props} />
  if (direction === 'down') return <TrendingDown {...props} />
  return <Minus {...props} />
}

/**
 * One lift's arc. first → current reads left to right with best marked, because
 * the shape of the change matters more than any single number: a lift that hit
 * its best months ago and has drifted down since is a different situation from
 * one still climbing, and both look identical if you only show "current".
 */
function TrajectoryRow({ t }: { t: LiftTrajectory }) {
  const tone = DIRECTION_TONE[t.direction]
  const bestIsCurrent = t.best === t.current
  return (
    <div className="card traj">
      <div className="traj__head">
        <h3 className="traj__name">{t.name}</h3>
        <span className="traj__dir" style={{ color: tone }}>
          <DirectionIcon direction={t.direction} />
          {t.direction === 'up' ? 'climbing' : t.direction === 'down' ? 'drifting down' : 'holding'}
        </span>
      </div>
      <div className="traj__arc">
        <span className="traj__cell">
          <span className="traj__label">first</span>
          <span className="num traj__val">{t.first}</span>
        </span>
        <span className="traj__arrow" aria-hidden>→</span>
        <span className="traj__cell">
          <span className="traj__label">now</span>
          <span className="num traj__val" style={{ color: tone }}>{t.current}</span>
        </span>
        {!bestIsCurrent && (
          <span className="traj__cell traj__cell--best">
            <span className="traj__label">best</span>
            <span className="num traj__val">{t.best}</span>
          </span>
        )}
      </div>
      <p className="traj__meta num">{t.sessions} session{t.sessions === 1 ? '' : 's'} logged</p>
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** One entry on the timeline — a block that started, or a change that was made. */
function JourneyRow({ entry }: { entry: JourneyEntry }) {
  const isChange = entry.kind === 'change'
  return (
    <li className={`journey__row${isChange ? ' journey__row--change' : ''}`}>
      <span className="journey__marker" aria-hidden>
        {isChange ? <Clock size={12} strokeWidth={2} /> : <Calendar size={12} strokeWidth={2} />}
      </span>
      <div className="journey__content">
        <div className="journey__head">
          <span className="journey__date num">{formatDate(entry.date)}</span>
          {entry.scheduled && <Chip tone="pending">scheduled</Chip>}
          {entry.phaseStatus === 'active' && <Chip tone="doing">current</Chip>}
        </div>
        <h3 className="journey__title">{entry.title}</h3>
        {entry.detail && <p className="journey__detail">{entry.detail}</p>}

        {/* Their words, kept verbatim. A timeline that only showed counts would
            be the system's changelog; this is what makes it the athlete's. */}
        {entry.requests.length > 0 && (
          <ul className="journey__asks">
            {entry.requests.map((r, i) => <li key={i}>“{r}”</li>)}
          </ul>
        )}

        {entry.diff && entry.diff.sessions.length > 0 && (
          <div className="journey__diff">
            {entry.diff.sessions.map((s, i) => (
              <div key={i} className="journey__session">
                <p className="journey__session-name">{s.name}</p>
                <ul>
                  {s.changes.slice(0, 6).map((c, k) => (
                    <li key={k} style={{ color: c.kind === 'removed' ? 'var(--veto)' : c.kind === 'added' ? 'var(--confirmed)' : 'var(--text-dim)' }}>
                      <span className="num">{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span>{' '}
                      {c.name}
                      {c.kind === 'changed' && c.before && c.after && (
                        <span className="num journey__delta"> {c.before} → {c.after}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}
