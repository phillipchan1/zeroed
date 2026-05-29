import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import {
  Button, SectionHeader, Skeleton, InsightCard, InsightMovementRow,
  TelemetryStrip, TickingNumber, BracketFrame,
} from '../../components/ui'
import { summarizeInsightMovement, type InsightMovementSummary } from '../../engine'
import type { RoutineRow, InsightRow } from '../../types/database'

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
  const [nonNegotiables, setNonNegotiables] = useState<string[]>([])
  const [activeInsights, setActiveInsights] = useState<InsightRow[]>([])
  const [movement, setMovement] = useState<InsightMovementSummary | null>(null)
  const [totalInsights, setTotalInsights] = useState(0)
  const [likelyCount, setLikelyCount]     = useState(0)
  const [p1Count, setP1Count]             = useState(0)
  const [lastSignalAt, setLastSignalAt]   = useState<string | null>(null)
  const [phaseInfo, setPhaseInfo]         = useState<{ name: string; weekCurrent: number; weekTotal: number } | null>(null)
  const [retestDays, setRetestDays]       = useState<number | null>(null)

  useEffect(() => {
    loadWeekData()
    loadPhaseAndProfile()
    loadInsights()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  async function loadInsights() {
    // Load every insight so we can summarise what moved this week, plus keep
    // the active stack for the "your zero" focus when nothing has moved yet.
    const { data } = await supabase
      .from('insight')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('priority')

    const all = (data ?? []) as InsightRow[]
    const active = all.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
    setActiveInsights(active)
    setMovement(summarizeInsightMovement(all, getWeekDays()[0]))

    // Telemetry strip counts (all statuses count toward the total).
    setTotalInsights(all.length)
    setLikelyCount(all.filter((i) => i.status === 'likely').length)
    setP1Count(active.filter((i) => i.priority === 'P1').length)
    const maxUpdated = all.reduce<string | null>((max, i) =>
      !max || i.updated_at > max ? i.updated_at : max, null)
    setLastSignalAt(maxUpdated)
  }

  async function loadPhaseAndProfile() {
    const { data: phase } = await supabase
      .from('phase')
      .select('name, week_start, week_end, non_negotiables, program!inner(athlete_id, status)')
      .eq('program.athlete_id', athleteId)
      .eq('program.status', 'active')
      .eq('status', 'active')
      .maybeSingle()

    setNonNegotiables((phase?.non_negotiables as string[] | null) ?? [])

    if (phase?.week_start && phase?.week_end) {
      const start = new Date(phase.week_start as string)
      const end   = new Date(phase.week_end as string)
      const dayMs = 1000 * 60 * 60 * 24
      const weekTotal   = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs / 7) + 1)
      const elapsedDays = Math.floor((Date.now() - start.getTime()) / dayMs)
      const weekCurrent = Math.min(weekTotal, Math.max(1, Math.floor(elapsedDays / 7) + 1))
      setPhaseInfo({ name: phase.name as string, weekCurrent, weekTotal })
    }

    const { data: profile } = await supabase
      .from('athlete_profile')
      .select('retest_date')
      .eq('athlete_id', athleteId)
      .maybeSingle()

    if (profile?.retest_date) {
      const diff = Math.ceil((new Date(profile.retest_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      setRetestDays(diff)
    }
  }

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

  const p1Insight  = activeInsights[0] ?? null
  const p1Category = p1Insight?.category ?? null
  const movements  = movement?.movements ?? []
  const hasMovement = movements.length > 0
  const movedCount  = movement?.movedCount ?? 0
  const heroValue   = movedCount > 0 ? movedCount : p1Count
  const heroLabel   = movedCount > 0 ? 'INSIGHTS MOVED' : 'P1 ACTIVE'

  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: 'INSIGHTS', value: totalInsights },
    { label: String(likelyCount), value: 'LIKELY' },
    { label: String(p1Count), value: 'P1' },
  ]
  if (phaseInfo) {
    telemetryItems.push({ label: 'PHASE', value: `${phaseInfo.name} w${phaseInfo.weekCurrent}/${phaseInfo.weekTotal}` })
  }
  if (retestDays !== null) {
    telemetryItems.push({ label: 'RETEST', value: `${retestDays}d`, signal: retestDays <= 7 })
  }

  return (
    <div className="screen with-nav">
      {/* Telemetry strip — always-on system state (presence dot, one per screen) */}
      {!loading && (
        <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />
      )}

      {/* Main content */}
      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>

        {/* Date header */}
        <div className="fade-rise" style={{ marginBottom: 20 }}>
          <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            {dateStr}
          </p>
          <h2 style={{ marginTop: 4, fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>
            Today
          </h2>
        </div>

        {/* Hero number — telemetric headline (always present) */}
        {!loading && (
          <div className="fade-rise" style={{ marginBottom: 16 }}>
            <TickingNumber
              value={heroValue}
              className="hero-number text-signal"
              style={{ fontSize: 32, display: 'block' }}
            />
            <span className="hero-number__label">{heroLabel}</span>
          </div>
        )}

        {/* Your zero this week — insights-first (Shift 4 / Shift 6) */}
        <div className="fade-rise" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 12 }}>
            <SectionHeader>Your zero this week</SectionHeader>
            {!loading && movement?.headline && (
              <span className="num text-xs text-signal" style={{ letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
                {movement.headline}
              </span>
            )}
          </div>

          {loading ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Skeleton height={10} width={80} />
              <Skeleton height={14} width="90%" />
              <Skeleton height={11} width="70%" />
            </div>
          ) : (
            <BracketFrame style={{ padding: 8 }}>
              {hasMovement ? (
                movements.slice(0, 3).map((m) => (
                  <InsightMovementRow key={m.insight.id} movement={m} />
                ))
              ) : p1Insight ? (
                <>
                  <p className="text-xs text-dim" style={{ marginBottom: 10, lineHeight: 1.6 }}>
                    No movement this week. The P1 limiter is still the bottleneck.
                  </p>
                  <InsightCard insight={p1Insight} />
                </>
              ) : (
                <p className="text-sm text-dim">
                  No weak links flagged — your program is building strength.
                </p>
              )}
            </BracketFrame>
          )}
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
                {p1Category && (
                  <p
                    className="text-dim"
                    style={{
                      marginTop: 6,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    targeting P1 · {p1Category}
                  </p>
                )}
                {todayRoutine.intent && (
                  <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>
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

        {/* Non-negotiables — phase rules that apply every session */}
        {nonNegotiables.length > 0 && (
          <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 20 }}>
            <SectionHeader>Non-negotiables</SectionHeader>
            <p
              className="text-dim"
              style={{
                marginTop: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              RULES — every session, no skips
            </p>
            <ul style={{ marginTop: 12, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {nonNegotiables.map((rule, i) => (
                <li
                  key={i}
                  style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5 }}
                >
                  <span className="num text-signal" style={{ fontSize: 13, flexShrink: 0 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Week strip — de-emphasised, below the fold (Shift 4) */}
        <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 28 }}>
          <SectionHeader>This week</SectionHeader>
          <div
            className="week-strip"
            style={{ marginTop: 10, opacity: 0.7, padding: 0 }}
          >
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

        {/* Weekly Review stub — Prompt 2 tier-3 moment */}
        {/* TODO Prompt 2: weekly_review trigger when week_ending passes */}
      </div>
    </div>
  )
}
