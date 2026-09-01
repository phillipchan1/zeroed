import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCachedLoader } from '../../lib/cache'
import { gatherTrainingLog, gatherExerciseHistory, type LogSession, type ExerciseHistory } from '../../engine'
import { pendingSessionsRaw } from '../../lib/workoutOutbox'
import { unitContext, type UnitContext } from '../../lib/units'
import { prLabel } from '../../engine/prs'
import { SectionHeader, Skeleton, PageHeader, Sheet, Chip, Stat, StatGrid } from '../../components/ui'
import type { SetLog } from '../../types/database'

function fmtRange(startISO: string, endISO: string): string {
  const s = new Date(`${startISO}T12:00:00`)
  const e = new Date(`${endISO}T12:00:00`)
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return mon(s) === mon(e)
    ? `${mon(s)} ${s.getDate()}–${e.getDate()}`
    : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`
}
const dayAndDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

function fmtSet(s: SetLog, u: UnitContext): string {
  if (s.weight != null) return `${u.fmt(s.weight)}${u.unit}×${s.reps ?? '?'}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}${u.distance}`
  return `${s.reps ?? '?'} reps`
}

// ---- One logged session in the week list ----------------------------------

function LogSessionCard({
  s, u, onOpen, onExercise,
}: {
  s: LogSession
  u: UnitContext
  onOpen: () => void
  onExercise: (name: string) => void
}) {
  return (
    // A not-yet-synced session opens too: it's edited straight out of the outbox,
    // so there's no reason to make the athlete wait for a round trip to fix a
    // number they just mistyped.
    <div
      className="card card--tap"
      style={{ marginBottom: 10 }}
      onClick={onOpen}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, minWidth: 0 }}>{s.routineName}</h3>
        <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
          {dayAndDate(s.performedAt)}
        </span>
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {s.pending
          ? <Chip tone="pending">Syncing</Chip>
          : <Chip tone="done">{s.setsDone} sets</Chip>}
        {/* Load moved, not just how many times you stopped. A session of 3x5 at
            315 and one of 3x12 at 95 both read as "3 sets" without it. */}
        {s.volume.load > 0 && <Chip tone="todo">{u.volume(s.volume.load)}{u.unit}</Chip>}
        {/* Phase is constant across a block, so it was repeating on every row
            for no information. It stays in the week header's context. */}
        {!s.pending && s.rpe != null && <Chip tone="todo">RPE {s.rpe}</Chip>}
      </div>
      {s.highlights.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }} onClick={(e) => e.stopPropagation()}>
          {s.highlights.map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onExercise(h.name)}
              className="num"
              style={{
                minHeight: 36, padding: '6px 12px', cursor: 'pointer',
                background: 'var(--ground)', border: '1px solid var(--line)', borderRadius: 999,
                color: 'var(--text-dim)', fontSize: 'var(--fs-xs)',
              }}
            >
              {h.name} {fmtSet(h.set, u)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Per-exercise progression sheet ---------------------------------------

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 240, h = 80, pad = 6
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / span) * (h - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = pts[pts.length - 1].split(',')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: 'block' }} preserveAspectRatio="none">
      <polyline points={pts.join(' ')} fill="none" stroke="var(--signal)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={4} fill="var(--signal)" />
    </svg>
  )
}

function ExerciseHistorySheet({ athleteId, name, onClose }: { athleteId: string; name: string; onClose: () => void }) {
  const u = unitContext()
  const { data, loading } = useCachedLoader(`exhist:${athleteId}:${name}`, () => gatherExerciseHistory(athleteId, name, u))
  const hist = data as ExerciseHistory | null
  const series = (hist?.points ?? []).map((p) => p.e1rm ?? p.topWeight).filter((v): v is number => v != null)

  return (
    <Sheet title={name} onClose={onClose}>
      {loading && !hist ? (
        <Skeleton height={60} width="100%" />
      ) : !hist || hist.points.length === 0 ? (
        <p className="text-base text-dim">No logged sets for this lift yet.</p>
      ) : (
        <>
          {(hist.bestWeight != null || hist.bestE1rm != null) && (
            <div style={{ marginBottom: 20 }}>
              <StatGrid>
                {hist.bestWeight != null && <Stat value={`${hist.bestWeight}${u.unit}`} label="Top set" />}
                {hist.bestE1rm != null && <Stat value={`${hist.bestE1rm}${u.unit}`} label="Est. 1RM" tone="var(--signal)" />}
                <Stat value={hist.points.length} label="Sessions" />
                {hist.prCount > 0 && <Stat value={hist.prCount} label={hist.prCount === 1 ? 'PR' : 'PRs'} tone="var(--signal)" />}
              </StatGrid>
            </div>
          )}

          {/* The trend, drawn. This is the whole reason to open this sheet. */}
          {series.length >= 2 && (
            <div style={{ marginBottom: 22 }}>
              <Sparkline values={series} />
              <p className="text-xs text-dim" style={{ marginTop: 8, fontFamily: 'var(--font-mono)' }}>
                {hist.points[0].e1rm != null ? 'Est. 1RM' : 'Top set'} · {hist.points.length} sessions
              </p>
            </div>
          )}

          <SectionHeader>Every session</SectionHeader>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column' }}>
            {[...hist.points].reverse().map((p, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line)',
                }}
              >
                <span className="text-sm text-dim" style={{ fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {dayAndDate(p.performedAt)}
                  {/* Which sessions actually beat something, marked on the day
                      they did it — a best-ever number at the top of a sheet
                      never said WHICH session earned it. */}
                  {p.prs.length > 0 && (
                    <span
                      className="text-micro"
                      style={{ color: 'var(--signal)', fontWeight: 700, letterSpacing: '0.08em' }}
                      title={`${prLabel(p.prs)} at the time`}
                    >
                      PR
                    </span>
                  )}
                </span>
                <span className="num text-sm" style={{ textAlign: 'right' }}>
                  {p.topWeight != null ? `${p.topWeight}${u.unit}×${p.topReps ?? '?'}` : `${p.topReps ?? '?'} reps`}
                  {/* Above ~12 reps an Epley estimate stops being a strength
                      number, so it is not printed as one. */}
                  {p.e1rm != null && p.e1rmReliable ? `  ·  ${p.e1rm}${u.unit} e1RM` : ''}
                  {p.rpe != null ? `  ·  RPE ${p.rpe}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Sheet>
  )
}

/**
 * HISTORY — everything you've trained, newest first, grouped by week. The
 * backward half of the program timeline: tap a session to review/edit it, or tap
 * any lift to see its progression. Reads fold in the outbox so a session finished
 * seconds ago shows here before its row syncs.
 */
export function HistoryScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const u = unitContext()
  const [exercise, setExercise] = useState<string | null>(null)

  const { data, loading } = useCachedLoader(
    `history:${athleteId}`,
    () => gatherTrainingLog(athleteId, pendingSessionsRaw()),
  )
  const weeks = data?.weeks ?? []

  return (
    <div className="screen with-nav">
      <div className="page"><div className="page__main">
        <PageHeader
          eyebrow="The log"
          title="History"
          subtitle="Tap a session to review it, or a lift to see its progression."
          onBack={() => navigate('/app/today')}
        />

        {loading && weeks.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Skeleton height={18} width={160} /><Skeleton height={12} width={100} />
              </div>
            ))}
          </div>
        ) : weeks.length === 0 ? (
          <div className="card">
            <p className="text-base text-dim">
              Nothing logged yet. Finish a session and it lands here.
            </p>
          </div>
        ) : (
          weeks.map((wk) => (
            <div key={wk.weekEnding} style={{ marginBottom: 28 }}>
              <div className="section__head">
                <SectionHeader>{fmtRange(wk.weekStart, wk.weekEnding)}</SectionHeader>
                <span className="num text-xs text-dim">
                  {wk.sessions.length} session{wk.sessions.length === 1 ? '' : 's'} · {wk.totalSets} sets
                  {wk.totalVolume.load > 0 && ` · ${u.volume(wk.totalVolume.load)}${u.unit}`}
                </span>
              </div>
              {wk.sessions.map((s) => (
                <LogSessionCard
                  key={s.workoutId}
                  s={s}
                  u={u}
                  onOpen={() => navigate(`/app/workout/${s.routineId}?w=${s.workoutId}`)}
                  onExercise={setExercise}
                />
              ))}
            </div>
          ))
        )}
      </div></div>

      {exercise && <ExerciseHistorySheet athleteId={athleteId} name={exercise} onClose={() => setExercise(null)} />}
    </div>
  )
}
