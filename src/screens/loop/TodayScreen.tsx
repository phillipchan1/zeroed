import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { runLoopTriggers, isRetestDue } from '../../engine'
import { loadDraftRoutineIds } from '../../lib/workoutDraft'
import { pendingCount } from '../../lib/workoutOutbox'
import { Button, SectionHeader, Skeleton, TelemetryStrip } from '../../components/ui'
import type { RoutineRow, InsightRow, OnboardingStep } from '../../types/database'

interface TodayScreenProps {
  athleteId: string
  todayRoutine: RoutineRow | null
  routines: RoutineRow[]
  onboardingStep?: OnboardingStep
}

interface LoopContext {
  refresh: () => void
}

// Athletes whose lazy triggers have already run this page-session. Module-level
// (not a ref) so it survives the brief unmount/remount a refresh() causes —
// otherwise the trigger effect would re-fire on every remount and loop.
const triggeredThisSession = new Set<string>()

interface WeekDayStatus {
  date: Date
  logged: boolean
  isToday: boolean
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getWeekDays(): Date[] {
  const today = new Date()
  const dow   = today.getDay()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((dow + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  )
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })

// The cached Today view. Everything here is serializable (ISO strings, plain
// numbers) so it round-trips through localStorage; the date-derived week strip
// is recomputed at render from the workouts against "now".
interface WeekWorkout {
  id: string
  routineId: string
  performedAt: string
}
interface TodayView {
  weekWorkouts: WeekWorkout[]    // every workout logged this week (for status + strip)
  totalInsights: number
  likelyCount: number
  p1Count: number
  lastSignalAt: string | null
  goal: string | null
  p1: { category: string; confidence: number } | null
  retestDate: string | null
}

async function fetchTodayView(athleteId: string): Promise<TodayView> {
  const days = getWeekDays()
  const weekEnd = new Date(days[6].getFullYear(), days[6].getMonth(), days[6].getDate(), 23, 59, 59)

  const [workoutRes, insightRes, athRes, profileRes] = await Promise.all([
    supabase
      .from('workout')
      .select('id, performed_at, routine_id, routine!inner(program!inner(athlete_id))')
      .gte('performed_at', days[0].toISOString())
      .lte('performed_at', weekEnd.toISOString()),
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
    supabase.from('athlete').select('goals, obstacle').eq('id', athleteId).maybeSingle(),
    supabase.from('athlete_profile').select('retest_date').eq('athlete_id', athleteId).maybeSingle(),
  ])
  if (workoutRes.error) throw workoutRes.error
  if (insightRes.error) throw insightRes.error
  if (athRes.error) throw athRes.error
  if (profileRes.error) throw profileRes.error

  const all = (insightRes.data ?? []) as InsightRow[]
  const active = all.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const top = active[0] ?? null
  const ath = athRes.data as { goals: string | null; obstacle: string | null } | null

  return {
    weekWorkouts: (workoutRes.data ?? []).map((w) => ({
      id: w.id as string,
      routineId: w.routine_id as string,
      performedAt: w.performed_at as string,
    })),
    totalInsights: all.length,
    likelyCount: all.filter((i) => i.status === 'likely').length,
    p1Count: active.filter((i) => i.priority === 'P1').length,
    lastSignalAt: all.reduce<string | null>((max, i) => (!max || i.updated_at > max ? i.updated_at : max), null),
    goal: (ath?.goals as string | null) || (ath?.obstacle as string | null) || null,
    p1: top ? { category: top.category, confidence: top.confidence } : null,
    retestDate: (profileRes.data?.retest_date as string | null) ?? null,
  }
}

// ---- one session row in the week list -------------------------------------

type SessionState =
  | { kind: 'todo' }
  | { kind: 'in_progress' }
  | { kind: 'done'; lastWorkout: WeekWorkout; count: number }

function SessionCard({
  routine, recommended, state, onStart, onResume, onEdit, onLogAgain,
}: {
  routine: RoutineRow
  recommended: boolean
  state: SessionState
  onStart: () => void
  onResume: () => void
  onEdit: () => void
  onLogAgain: () => void
}) {
  const exCount = (routine.exercises as unknown[]).length
  const done = state.kind === 'done'
  const inProg = state.kind === 'in_progress'
  const borderColor = inProg ? 'var(--signal)' : done ? 'var(--confirmed)' : undefined

  return (
    <div className="card fade-rise" style={{ marginBottom: 10, borderColor }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          {routine.name}
          {recommended && state.kind === 'todo' && (
            <span className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Recommended
            </span>
          )}
        </h3>
        <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>{exCount} ex</span>
      </div>

      {/* Status line */}
      <p
        className="text-xs"
        style={{
          marginTop: 6, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase',
          color: done ? 'var(--confirmed)' : inProg ? 'var(--signal)' : 'var(--text-dim)',
        }}
      >
        {state.kind === 'done'
          ? `✓ Logged · ${shortDay(state.lastWorkout.performedAt)}${state.count > 1 ? ` · ×${state.count}` : ''}`
          : inProg ? '● In progress' : '○ To do'}
      </p>

      {routine.intent && state.kind === 'todo' && (
        <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{routine.intent}</p>
      )}

      {/* Action */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        {state.kind === 'todo' && (
          <Button variant={recommended ? 'primary' : 'ghost'} full onClick={onStart}>
            Start session →
          </Button>
        )}
        {state.kind === 'in_progress' && (
          <Button variant="primary" full onClick={onResume}>Resume →</Button>
        )}
        {state.kind === 'done' && (
          <>
            <Button variant="ghost" style={{ flex: 1 }} onClick={onEdit}>Edit</Button>
            <Button variant="ghost" style={{ flex: 1 }} onClick={onLogAgain}>Log again</Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * TRAIN — the week, in full. Every session for the week is on the surface with
 * its state (to-do / in-progress / done), startable, resumable, and editable in
 * any order. Sessions aren't pinned to days — you pick what fits the gym, the
 * gear, the time you've got. The read sharpens underneath as you train; the
 * end-of-week recap lives in Coach.
 */
export function TodayScreen({ athleteId, todayRoutine, routines, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const { refresh } = (useOutletContext<LoopContext>() ?? { refresh: () => {} })
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [draftRoutineIds, setDraftRoutineIds] = useState<string[]>([])
  // Sessions finished offline, waiting to sync. Re-checked when connectivity
  // returns so the note clears itself once the outbox drains.
  const [pendingSync, setPendingSync] = useState(pendingCount())

  const { data: view, loading, refetch } = useCachedLoader(
    `today:${athleteId}`,
    () => fetchTodayView(athleteId),
  )

  const totalInsights = view?.totalInsights ?? 0
  const likelyCount   = view?.likelyCount ?? 0
  const p1Count       = view?.p1Count ?? 0
  const lastSignalAt  = view?.lastSignalAt ?? null
  const goal          = view?.goal ?? null
  const p1            = view?.p1 ?? null
  const retestDue     = isRetestDue(view?.retestDate ?? null)
  const weekWorkouts  = view?.weekWorkouts ?? []

  // Week strip — recomputed from the workouts against the current day, so "today"
  // and the Mon–Sun window are always correct even from a stale cache.
  const today = new Date()
  const loggedDates = weekWorkouts.map((w) => new Date(w.performedAt))
  const weekDays: WeekDayStatus[] = getWeekDays().map((d) => ({
    date: d,
    logged: loggedDates.some((ld) => isSameDay(ld, d)),
    isToday: isSameDay(d, today),
  }))

  // Which sessions are mid-flight (a live draft). Offline-tolerant — the local
  // scan alone is enough, so the markers show with no connection.
  useEffect(() => {
    void loadDraftRoutineIds(athleteId).then(setDraftRoutineIds).catch(() => setDraftRoutineIds([]))
  }, [athleteId, view])

  // Keep the pending-sync note honest: the outbox flushes on `online`, so recount
  // shortly after connectivity returns (and on focus) to clear it when drained.
  useEffect(() => {
    const recount = () => setTimeout(() => setPendingSync(pendingCount()), 1500)
    window.addEventListener('online', recount)
    window.addEventListener('focus', recount)
    return () => {
      window.removeEventListener('online', recount)
      window.removeEventListener('focus', recount)
    }
  }, [])

  // Lazy outer-cadence triggers (§4.2, §5): run the weekly review + phase
  // advancement once per page-session, then refresh ONLY if something changed.
  useEffect(() => {
    if (triggeredThisSession.has(athleteId)) return
    triggeredThisSession.add(athleteId)
    void (async () => {
      const changed = await runLoopTriggers(athleteId)
      if (changed) {
        refetch()
        refresh()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  // Per-routine status for the week list.
  function statusFor(routineId: string): SessionState {
    const ws = weekWorkouts
      .filter((w) => w.routineId === routineId)
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
    if (ws.length) return { kind: 'done', lastWorkout: ws[0], count: ws.length }
    if (draftRoutineIds.includes(routineId)) return { kind: 'in_progress' }
    return { kind: 'todo' }
  }

  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: 'INSIGHTS', value: totalInsights },
    { label: String(likelyCount), value: 'LIKELY' },
    { label: String(p1Count), value: 'P1', signal: p1Count > 0 },
  ]

  const confidencePct = p1 ? Math.round(p1.confidence * 100) : null
  const doneCount = routines.filter((r) => statusFor(r.id).kind === 'done').length

  return (
    <div className="screen with-nav">
      {isFirstVisit && (
        <p
          className="fade-rise"
          style={{ padding: '12px 16px', fontSize: 14, color: 'var(--text)', lineHeight: 1.5, borderBottom: '1px solid var(--line)' }}
        >
          This is your week. Every session's here — start any of them, in any order, and pick up where you left off. The read sharpens underneath as you train.
        </p>
      )}

      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div className="page page--rail">
       <div className="page__main">

        {/* Offline-completed sessions waiting to sync. */}
        {pendingSync > 0 && (
          <div
            className="fade-rise"
            style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--line)',
            }}
          >
            <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
              {pendingSync} session{pendingSync === 1 ? '' : 's'} saved offline — {pendingSync === 1 ? 'it syncs' : 'they sync'} and the coach reads {pendingSync === 1 ? 'it' : 'them'} when you're back online.
            </p>
          </div>
        )}

        {/* Goal anchor — the durable thing. The read moves underneath, and taps
            through to Coach for the why. */}
        <div className="fade-rise" style={{ marginBottom: 24 }}>
          <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            {goal ? 'Chasing' : 'This week'}
          </p>
          <h2 style={{ marginTop: goal ? 6 : 4, fontSize: goal ? 21 : 22, fontWeight: 600, lineHeight: 1.25 }}>
            {goal ?? 'This week'}
          </h2>
          {!loading && p1 && confidencePct !== null && (
            <button
              type="button"
              onClick={() => navigate('/app/coach')}
              style={{
                marginTop: 10, padding: 0, background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em',
                color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              THE READ · {p1.category.toUpperCase()} ·{' '}
              <span className="num text-signal">{confidencePct}%</span> CONFIDENT
              <span style={{ opacity: 0.6 }}>›</span>
            </button>
          )}
        </div>

        {/* Retest due — the program cadence CTA (§6). Routes into the rescreen. */}
        {!loading && retestDue && (
          <div className="card fade-rise" style={{ marginBottom: 16, borderColor: 'var(--signal)' }}>
            <SectionHeader>Retest due</SectionHeader>
            <p className="text-sm" style={{ marginTop: 8, lineHeight: 1.5 }}>
              Time to re-read where you are. A quick movement rescreen shows what's moved since baseline and re-scopes the program.
            </p>
            <Button variant="primary" full style={{ marginTop: 14 }} onClick={() => navigate('/app/retest')}>
              Start retest →
            </Button>
          </div>
        )}

        {/* THE WEEK — every session, on the surface. */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <SectionHeader>This week's sessions</SectionHeader>
            {!loading && routines.length > 0 && (
              <span className="num text-xs text-dim">{doneCount}/{routines.length} done</span>
            )}
          </div>
          <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 12, lineHeight: 1.5 }}>
            Do whichever fits — gym, gear, time. Tap a logged one to edit, or log a session for a past day.
          </p>

          {loading && routines.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Skeleton height={14} width={160} /><Skeleton height={10} width={90} /><Skeleton height={36} width="100%" />
                </div>
              ))}
            </div>
          ) : routines.length === 0 ? (
            <div className="card">
              <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
                No sessions in this phase yet. Finish onboarding and your program builds here.
              </p>
            </div>
          ) : (
            routines.map((r) => (
              <SessionCard
                key={r.id}
                routine={r}
                recommended={todayRoutine?.id === r.id}
                state={statusFor(r.id)}
                onStart={() => navigate(`/app/workout/${r.id}`)}
                onResume={() => navigate(`/app/workout/${r.id}`)}
                onLogAgain={() => navigate(`/app/workout/${r.id}`)}
                onEdit={() => {
                  const s = statusFor(r.id)
                  if (s.kind === 'done') navigate(`/app/workout/${r.id}?w=${s.lastWorkout.id}`)
                }}
              />
            ))
          )}
        </div>
       </div>

       {/* Week strip — cadence, de-emphasised. Right rail on desktop. */}
       <aside className="page__rail">
        <div className="fade-rise fade-rise-delay-2 today-week">
          <SectionHeader>This week</SectionHeader>
          <div className="week-strip" style={{ marginTop: 10, opacity: 0.7, padding: 0 }}>
            {loading
              ? Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="week-day" style={{ minWidth: 36 }}>
                    <Skeleton height={9} width={24} />
                    <Skeleton height={12} width={18} />
                    <div style={{ width: 4, height: 4 }} />
                  </div>
                ))
              : weekDays.map((day, i) => (
                  <div
                    key={i}
                    className={`week-day${day.isToday ? ' week-day--today' : ''}${day.logged ? ' week-day--logged' : ''}`}
                  >
                    <span className="week-day__label">{DAY_LABELS[(day.date.getDay() + 6) % 7]}</span>
                    <span className="week-day__num">{day.date.getDate()}</span>
                    <div className="week-day__dot" />
                  </div>
                ))
            }
          </div>
        </div>
       </aside>
      </div>
    </div>
  )
}
