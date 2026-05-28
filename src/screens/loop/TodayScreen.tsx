import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { Button, SectionHeader, Skeleton } from '../../components/ui'
import type { RoutineRow } from '../../types/database'

interface TodayScreenProps {
  athleteId: string
  todayRoutine: RoutineRow | null
}

interface WeekDayStatus {
  date: Date
  logged: boolean
  isToday: boolean
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getWeekDays(): Date[] {
  const today = new Date()
  const dow   = today.getDay()                     // 0 = Sun
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((dow + 6) % 7)) // rewind to Monday
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

export function TodayScreen({ athleteId, todayRoutine }: TodayScreenProps) {
  const navigate   = useNavigate()
  const [weekDays, setWeekDays] = useState<WeekDayStatus[]>([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    loadWeekData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  async function loadWeekData() {
    setLoading(true)
    const days   = getWeekDays()
    const today  = new Date()

    const weekStart = days[0]
    const weekEnd   = days[6]

    const { data: workouts } = await supabase
      .from('workout')
      .select('performed_at, routine_id, routine!inner(program!inner(athlete_id))')
      .gte('performed_at', weekStart.toISOString())
      .lte('performed_at', new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate(), 23, 59, 59).toISOString())

    const loggedDates = (workouts ?? []).map((w) => new Date(w.performed_at))

    setWeekDays(days.map((d) => ({
      date:    d,
      logged:  loggedDates.some((ld) => isSameDay(ld, d)),
      isToday: isSameDay(d, today),
    })))

    setLoading(false)
  }

  function handleStartWorkout() {
    if (todayRoutine) {
      navigate(`/app/workout/${todayRoutine.id}`)
    }
  }

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="screen with-nav" style={{ paddingTop: 0 }}>
      {/* Week strip */}
      <div
        style={{
          background: 'var(--surface)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div className="week-strip">
          {loading
            ? Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="week-day" style={{ minWidth: 40 }}>
                  <Skeleton height={10} width={28} />
                  <Skeleton height={14} width={20} />
                  <div style={{ width: 4, height: 4 }} />
                </div>
              ))
            : weekDays.map((day, i) => (
                <div
                  key={i}
                  className={`week-day${day.isToday ? ' week-day--today' : ''}${day.logged ? ' week-day--logged' : ''}`}
                >
                  <span className="week-day__label">
                    {DAY_LABELS[(day.date.getDay() + 6) % 7]}
                  </span>
                  <span className="week-day__num">{day.date.getDate()}</span>
                  <div className="week-day__dot" />
                </div>
              ))
          }
        </div>
      </div>

      {/* Main content */}
      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>

        {/* Date header */}
        <div className="fade-rise" style={{ marginBottom: 24 }}>
          <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            {dateStr}
          </p>
          <h2 style={{ marginTop: 4, fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>
            Today
          </h2>
        </div>

        {/* Session card */}
        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Skeleton height={12} width={80} />
            <Skeleton height={20} width={160} />
            <Skeleton height={12} width={120} />
          </div>
        ) : todayRoutine ? (
          <div className="card fade-rise fade-rise-delay-1" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <SectionHeader>Session ready</SectionHeader>
                <h3 style={{ marginTop: 8, fontSize: 18, fontWeight: 600 }}>
                  {todayRoutine.name}
                </h3>
                {todayRoutine.intent && (
                  <p className="text-sm text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>
                    {todayRoutine.intent}
                  </p>
                )}
              </div>
            </div>

            {/* Exercise count */}
            <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
              <div>
                <span className="num text-signal" style={{ fontSize: 20, fontWeight: 600 }}>
                  {(todayRoutine.exercises as unknown[]).length}
                </span>
                <span className="text-xs text-dim" style={{ marginLeft: 4 }}>exercises</span>
              </div>
              <div>
                <span className="num text-dim" style={{ fontSize: 20 }}>~</span>
                <span className="num text-dim" style={{ fontSize: 20 }}>
                  {(todayRoutine.exercises as unknown[]).length * 8}
                </span>
                <span className="text-xs text-dim" style={{ marginLeft: 4 }}>min</span>
              </div>
            </div>

            <Button variant="primary" full onClick={handleStartWorkout}>
              Start session →
            </Button>
          </div>
        ) : (
          <div className="card fade-rise fade-rise-delay-1">
            <p className="text-dim" style={{ fontSize: 14 }}>No session scheduled today. Rest day.</p>
          </div>
        )}

        {/* Non-negotiables (if profile has them — stubbed for now) */}
        {todayRoutine && (
          <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 20 }}>
            <SectionHeader>Non-negotiables</SectionHeader>
            <p className="text-xs text-dim" style={{ marginTop: 8, lineHeight: 1.7 }}>
              These apply every session regardless of energy level.
            </p>
            {/* TODO Prompt 2: load non_negotiables from active phase */}
          </div>
        )}

        {/* Weekly Review stub — Prompt 2 tier-3 moment */}
        {/* TODO Prompt 2: weekly_review trigger when week_ending passes */}
      </div>
    </div>
  )
}
