import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useCachedLoader } from '../../lib/cache'
import { gatherTrainingLog, gatherExerciseHistory, type LogSession, type ExerciseHistory } from '../../engine'
import { pendingSessionsRaw } from '../../lib/workoutOutbox'
import { getWeightUnit, getDistanceUnit } from '../../lib/units'
import { SectionHeader, Skeleton } from '../../components/ui'
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

function fmtSet(s: SetLog, unit: string, distanceUnit: string): string {
  if (s.weight != null) return `${s.weight}${unit}×${s.reps ?? '?'}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}${distanceUnit}`
  return `${s.reps ?? '?'} reps`
}

// ---- One logged session in the week list ----------------------------------

function LogSessionCard({
  s, unit, distanceUnit, onOpen, onExercise,
}: {
  s: LogSession
  unit: string
  distanceUnit: string
  onOpen: () => void
  onExercise: (name: string) => void
}) {
  return (
    <div
      className="card"
      style={{ marginBottom: 8, cursor: s.pending ? 'default' : 'pointer', borderColor: s.pending ? 'var(--line)' : undefined }}
      onClick={s.pending ? undefined : onOpen}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>{s.routineName}</h3>
        <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
          {dayAndDate(s.performedAt)}
        </span>
      </div>
      <p
        className="text-xs"
        style={{
          marginTop: 6, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase',
          color: s.pending ? 'var(--pending)' : 'var(--text-dim)',
        }}
      >
        {s.pending ? '⟳ Saved offline · syncing' : `✓ ${s.setsDone} set${s.setsDone === 1 ? '' : 's'}`}
        {!s.pending && s.rpe != null ? ` · RPE ${s.rpe}` : ''}
        {s.phaseName ? ` · ${s.phaseName}` : ''}
      </p>
      {s.highlights.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }} onClick={(e) => e.stopPropagation()}>
          {s.highlights.map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onExercise(h.name)}
              className="num text-xs"
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--text-dim)', borderBottom: '1px dotted var(--line)', lineHeight: 1.4,
              }}
            >
              {h.name} {fmtSet(h.set, unit, distanceUnit)}
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
  const w = 240, h = 48, pad = 4
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
      <polyline points={pts.join(' ')} fill="none" stroke="var(--signal)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--signal)" />
    </svg>
  )
}

function ExerciseHistorySheet({ athleteId, name, onClose }: { athleteId: string; name: string; onClose: () => void }) {
  const unit = getWeightUnit()
  const { data, loading } = useCachedLoader(`exhist:${athleteId}:${name}`, () => gatherExerciseHistory(athleteId, name))
  const hist = data as ExerciseHistory | null
  const series = (hist?.points ?? []).map((p) => p.e1rm ?? p.topWeight).filter((v): v is number => v != null)

  return (
    <div className="obs-sheet" onClick={onClose}>
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
          <p className="section-header">{name}</p>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
        </div>

        {loading && !hist ? (
          <Skeleton height={48} width="100%" />
        ) : !hist || hist.points.length === 0 ? (
          <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>No logged sets for this lift yet.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
              {hist.bestWeight != null && (
                <div>
                  <p className="num" style={{ fontSize: 20, fontWeight: 600 }}>{hist.bestWeight}{unit}</p>
                  <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Top set</p>
                </div>
              )}
              {hist.bestE1rm != null && (
                <div>
                  <p className="num" style={{ fontSize: 20, fontWeight: 600, color: 'var(--signal)' }}>{hist.bestE1rm}{unit}</p>
                  <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Est. 1RM</p>
                </div>
              )}
            </div>

            {series.length >= 2 && (
              <div style={{ marginBottom: 14 }}>
                <Sparkline values={series} />
                <p className="text-xs text-dim" style={{ marginTop: 4, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
                  {hist.points[0].e1rm != null ? 'Est. 1RM' : 'Top set'} over {hist.points.length} sessions
                </p>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...hist.points].reverse().map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)' }}>{dayAndDate(p.performedAt)}</span>
                  <span className="num text-xs">
                    {p.topWeight != null ? `${p.topWeight}${unit}×${p.topReps ?? '?'}` : `${p.topReps ?? '?'} reps`}
                    {p.e1rm != null ? `  ·  ${p.e1rm}${unit} e1RM` : ''}
                    {p.rpe != null ? `  ·  RPE ${p.rpe}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
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
  const unit = getWeightUnit()
  const distanceUnit = getDistanceUnit(unit)
  const [exercise, setExercise] = useState<string | null>(null)

  const { data, loading } = useCachedLoader(
    `history:${athleteId}`,
    () => gatherTrainingLog(athleteId, pendingSessionsRaw()),
  )
  const weeks = data?.weeks ?? []

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

  return (
    <div className="screen with-nav">
      <div className="page"><div className="page__main">
        {back}
        <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
          The log
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginTop: 4, marginBottom: 20 }}>History</h2>

        {loading && weeks.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Skeleton height={14} width={140} /><Skeleton height={10} width={90} />
              </div>
            ))}
          </div>
        ) : weeks.length === 0 ? (
          <div className="card">
            <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
              Nothing logged yet. Once you finish a session it lands here — every week, every lift, kept.
            </p>
          </div>
        ) : (
          weeks.map((wk) => (
            <div key={wk.weekEnding} style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <SectionHeader>{fmtRange(wk.weekStart, wk.weekEnding)}</SectionHeader>
                <span className="num text-xs text-dim">
                  {wk.sessions.length} session{wk.sessions.length === 1 ? '' : 's'} · {wk.totalSets} sets
                </span>
              </div>
              {wk.sessions.map((s) => (
                <LogSessionCard
                  key={s.workoutId}
                  s={s}
                  unit={unit}
                  distanceUnit={distanceUnit}
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
