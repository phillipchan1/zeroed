import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { Button, SectionHeader, Skeleton, TelemetryStrip } from '../../components/ui'
import type { RoutineRow, InsightRow, OnboardingStep } from '../../types/database'

interface TodayScreenProps {
  athleteId: string
  todayRoutine: RoutineRow | null
  onboardingStep?: OnboardingStep
}

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

/**
 * TRAIN — the calm surface: what you're chasing, the one read moving underneath
 * it, and the session to do. The depth (the weak-link stack, the "why") lives in
 * Coach; the plan and rules live in Program. Show the conclusion, hide the
 * working — the feeling of intelligence is the confidence number that moves.
 */
export function TodayScreen({ athleteId, todayRoutine, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [weekDays, setWeekDays] = useState<WeekDayStatus[]>([])
  const [loading, setLoading]   = useState(true)
  const [totalInsights, setTotalInsights] = useState(0)
  const [likelyCount, setLikelyCount]     = useState(0)
  const [p1Count, setP1Count]             = useState(0)
  const [lastSignalAt, setLastSignalAt]   = useState<string | null>(null)
  const [goal, setGoal]                   = useState<string | null>(null)
  const [p1, setP1] = useState<{ category: string; confidence: number } | null>(null)

  useEffect(() => {
    loadWeekData()
    loadGoal()
    loadInsights()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  async function loadInsights() {
    const { data } = await supabase
      .from('insight')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('priority')

    const all = (data ?? []) as InsightRow[]
    const active = all.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
    setTotalInsights(all.length)
    setLikelyCount(all.filter((i) => i.status === 'likely').length)
    setP1Count(active.filter((i) => i.priority === 'P1').length)
    const top = active[0] ?? null
    setP1(top ? { category: top.category, confidence: top.confidence } : null)
    setLastSignalAt(all.reduce<string | null>((max, i) =>
      !max || i.updated_at > max ? i.updated_at : max, null))
  }

  // The TARGET is the durable anchor — what the athlete is chasing
  // (athlete.goals), falling back to their obstacle.
  async function loadGoal() {
    const { data: ath } = await supabase
      .from('athlete')
      .select('goals, obstacle')
      .eq('id', athleteId)
      .maybeSingle()
    setGoal((ath?.goals as string | null) || (ath?.obstacle as string | null) || null)
  }

  async function loadWeekData() {
    setLoading(true)
    const days  = getWeekDays()
    const today = new Date()
    const { data: workouts } = await supabase
      .from('workout')
      .select('performed_at, routine_id, routine!inner(program!inner(athlete_id))')
      .gte('performed_at', days[0].toISOString())
      .lte('performed_at', new Date(days[6].getFullYear(), days[6].getMonth(), days[6].getDate(), 23, 59, 59).toISOString())
    const loggedDates = (workouts ?? []).map((w) => new Date(w.performed_at))
    setWeekDays(days.map((d) => ({
      date: d,
      logged: loggedDates.some((ld) => isSameDay(ld, d)),
      isToday: isSameDay(d, today),
    })))
    setLoading(false)
  }

  function handleStartWorkout() {
    if (todayRoutine) navigate(`/app/workout/${todayRoutine.id}`)
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

      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>

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
          </div>
        ) : (
          <div className="card fade-rise fade-rise-delay-1">
            <p className="text-dim" style={{ fontSize: 14 }}>No session scheduled today. Rest day.</p>
          </div>
        )}

        {/* Week strip — cadence, de-emphasised */}
        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 28 }}>
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
      </div>
    </div>
  )
}
