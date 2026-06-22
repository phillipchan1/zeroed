import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { runLoopTriggers, isRetestDue } from '../../engine'
import { loadActiveDraft, type ActiveDraft } from '../../lib/workoutDraft'
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

// A quiet, link-styled toggle that reveals the session picker. Kept subtle so the
// recommended session stays the focal action and picking another is a deliberate,
// secondary move.
function PickerToggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginTop: 12, padding: 0, background: 'none', border: 'none', cursor: 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em',
        color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 6,
      }}
    >
      {label}
      <span style={{ opacity: 0.6 }}>{open ? '▴' : '▾'}</span>
    </button>
  )
}

// The cached Today view. Everything here is serializable (ISO strings, plain
// numbers) so it round-trips through localStorage; the date-derived week strip
// is recomputed at render from `loggedDates` against "now".
interface TodayView {
  loggedDates: string[]          // ISO timestamps of workouts logged this week
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
      .select('performed_at, routine_id, routine!inner(program!inner(athlete_id))')
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
    loggedDates: (workoutRes.data ?? []).map((w) => w.performed_at as string),
    totalInsights: all.length,
    likelyCount: all.filter((i) => i.status === 'likely').length,
    p1Count: active.filter((i) => i.priority === 'P1').length,
    lastSignalAt: all.reduce<string | null>((max, i) => (!max || i.updated_at > max ? i.updated_at : max), null),
    goal: (ath?.goals as string | null) || (ath?.obstacle as string | null) || null,
    p1: top ? { category: top.category, confidence: top.confidence } : null,
    retestDate: (profileRes.data?.retest_date as string | null) ?? null,
  }
}

/**
 * TRAIN — the calm surface: what you're chasing, the one read moving underneath
 * it, and the session to do. The depth (the weak-link stack, the "why") lives in
 * Coach; the plan and rules live in Program. Show the conclusion, hide the
 * working — the feeling of intelligence is the confidence number that moves.
 */
export function TodayScreen({ athleteId, todayRoutine, routines, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const { refresh } = (useOutletContext<LoopContext>() ?? { refresh: () => {} })
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [showPicker, setShowPicker] = useState(false)
  const [resume, setResume] = useState<ActiveDraft | null>(null)
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

  // Week strip — recomputed from cached logged-dates against the current day, so
  // "today" and the Mon–Sun window are always correct even from a stale cache.
  const today = new Date()
  const loggedDates = (view?.loggedDates ?? []).map((s) => new Date(s))
  const weekDays: WeekDayStatus[] = getWeekDays().map((d) => ({
    date: d,
    logged: loggedDates.some((ld) => isSameDay(ld, d)),
    isToday: isSameDay(d, today),
  }))

  // A live draft surfaces a "Resume session" entry. Best-effort and offline-
  // tolerant — the WorkoutScreen can still resume from its localStorage tier even
  // if this lookup can't reach the server.
  useEffect(() => {
    void loadActiveDraft(athleteId).then(setResume).catch(() => setResume(null))
  }, [athleteId])

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
  // (refresh() flips global loading → remounts this screen; an unconditional
  // refresh would reset a local guard and loop, so the guard is module-level and
  // we refresh only on a real change.)
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

  function handleStartWorkout() {
    if (todayRoutine) navigate(`/app/workout/${todayRoutine.id}`)
  }

  // Free picking — start any session in the phase, not just the recommended one.
  // The plan still recommends where the week left off, but equipment/energy/time
  // can send you to a different session, so any of them is one tap away.
  function startRoutine(routineId: string) {
    navigate(`/app/workout/${routineId}`)
  }

  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: 'INSIGHTS', value: totalInsights },
    { label: String(likelyCount), value: 'LIKELY' },
    { label: String(p1Count), value: 'P1', signal: p1Count > 0 },
  ]

  const confidencePct = p1 ? Math.round(p1.confidence * 100) : null

  return (
    <div className="screen with-nav">
      {isFirstVisit && (
        <p
          className="fade-rise"
          style={{ padding: '12px 16px', fontSize: 14, color: 'var(--text)', lineHeight: 1.5, borderBottom: '1px solid var(--line)' }}
        >
          This is Today. Open it before each session — it shows you what to do, and the read sharpens underneath as you train.
        </p>
      )}

      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div className="page page--rail">
       <div className="page__main">

        {/* Offline-completed sessions waiting to sync. They're saved locally; the
            coach reads them (the AI debrief) as soon as you're back online. */}
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
        <div className="fade-rise" style={{ marginBottom: 28 }}>
          <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            {goal ? 'Chasing' : 'Today'}
          </p>
          <h2 style={{ marginTop: goal ? 6 : 4, fontSize: goal ? 21 : 22, fontWeight: 600, lineHeight: 1.25 }}>
            {goal ?? 'Today'}
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

        {/* Resume — a session was started this week but not completed. Sits above
            the session card so picking it back up is the obvious next move. */}
        {!loading && resume && (() => {
          const r = routines.find((x) => x.id === resume.routineId)
          const mins = Math.round(resume.elapsedSeconds / 60)
          return (
            <div className="card fade-rise" style={{ marginBottom: 16, borderColor: 'var(--signal)' }}>
              <SectionHeader>In progress</SectionHeader>
              <h3 style={{ marginTop: 8, fontSize: 18, fontWeight: 600 }}>{r?.name ?? 'Your session'}</h3>
              <p className="text-dim" style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {resume.setsLogged} set{resume.setsLogged === 1 ? '' : 's'} logged
                {mins > 0 ? ` · ${mins} min in` : ''}
              </p>
              <Button variant="primary" full style={{ marginTop: 14 }} onClick={() => navigate(`/app/workout/${resume.routineId}`)}>
                Resume session →
              </Button>
            </div>
          )
        })()}

        {/* Session card — the one action */}
        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Skeleton height={12} width={80} />
            <Skeleton height={20} width={160} />
            <Skeleton height={12} width={120} />
          </div>
        ) : todayRoutine ? (
          <div className="card fade-rise fade-rise-delay-1" style={{ marginBottom: 16 }}>
            <SectionHeader>Session ready</SectionHeader>
            <h3 style={{ marginTop: 8, fontSize: 18, fontWeight: 600 }}>{todayRoutine.name}</h3>
            {p1 && (
              <p className="text-dim" style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                targeting P1 · {p1.category}
              </p>
            )}
            {todayRoutine.intent && (
              <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{todayRoutine.intent}</p>
            )}
            <div style={{ display: 'flex', gap: 20, margin: '16px 0' }}>
              <div>
                <span className="num text-signal" style={{ fontSize: 20, fontWeight: 600 }}>
                  {(todayRoutine.exercises as unknown[]).length}
                </span>
                <span className="text-xs text-dim" style={{ marginLeft: 4 }}>exercises</span>
              </div>
              <div>
                <span className="num text-dim" style={{ fontSize: 20 }}>~{(todayRoutine.exercises as unknown[]).length * 8}</span>
                <span className="text-xs text-dim" style={{ marginLeft: 4 }}>min</span>
              </div>
            </div>
            <Button variant="primary" full onClick={handleStartWorkout}>Start session →</Button>
            {routines.length > 1 && (
              <PickerToggle
                open={showPicker}
                onClick={() => setShowPicker((v) => !v)}
                label={showPicker ? 'Hide other sessions' : 'Choose a different session'}
              />
            )}
          </div>
        ) : (
          <div className="card fade-rise fade-rise-delay-1" style={{ marginBottom: 16 }}>
            <p className="text-dim" style={{ fontSize: 14 }}>No session scheduled today. Rest day.</p>
            {routines.length > 0 && (
              <PickerToggle
                open={showPicker}
                onClick={() => setShowPicker((v) => !v)}
                label={showPicker ? 'Hide sessions' : 'Train anyway — pick a session'}
              />
            )}
          </div>
        )}

        {/* The picker — any session, any day. Equipment/energy/time can send you to
            a different session than the one the week left off on, so all of them
            sit one tap away. The recommendation is just the default, not a lock. */}
        {!loading && showPicker && routines.length > 0 && (
          <div className="card fade-rise" style={{ marginBottom: 16 }}>
            <SectionHeader>All sessions</SectionHeader>
            <p className="text-xs text-dim" style={{ marginTop: 6, lineHeight: 1.5 }}>
              Do whichever fits today — the equipment you've got, the time you have. The recommendation just picks up where the week left off.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {routines.map((r) => {
                const isRecommended = todayRoutine?.id === r.id
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => startRoutine(r.id)}
                    className="card"
                    style={{ textAlign: 'left', cursor: 'pointer', width: '100%', background: 'none' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        {r.name}
                        {isRecommended && (
                          <span className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                            Recommended
                          </span>
                        )}
                      </h3>
                      <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
                        {(r.exercises as unknown[]).length} ex ›
                      </span>
                    </div>
                    {r.intent && <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{r.intent}</p>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
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
