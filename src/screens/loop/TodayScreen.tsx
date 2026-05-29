import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Button, SectionHeader, TelemetryStrip } from '../../components/ui'
import type { RoutineRow, InsightRow, OnboardingStep } from '../../types/database'
import type { WeekState } from '../../lib/week'

interface TodayScreenProps {
  athleteId: string
  todayRoutine: RoutineRow | null   // next un-done session (or first, when week complete)
  week: WeekState | null
  onboardingStep?: OnboardingStep
}

/**
 * TRAIN — the calm surface + the weekly loop. What you're chasing, the one read
 * moving underneath it, and THIS WEEK: how many sessions done, which one's next,
 * the rest waiting. A repeating template — missing a session is just data, never
 * a penalty (see lib/week.ts). Show the conclusion; the depth lives in Coach.
 */
export function TodayScreen({ athleteId, todayRoutine, week, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [loading, setLoading]   = useState(true)
  const [totalInsights, setTotalInsights] = useState(0)
  const [likelyCount, setLikelyCount]     = useState(0)
  const [p1Count, setP1Count]             = useState(0)
  const [lastSignalAt, setLastSignalAt]   = useState<string | null>(null)
  const [goal, setGoal]                   = useState<string | null>(null)
  const [p1, setP1] = useState<{ category: string; confidence: number } | null>(null)

  useEffect(() => {
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
    setLoading(false)
  }

  async function loadGoal() {
    const { data: ath } = await supabase
      .from('athlete')
      .select('goals, obstacle')
      .eq('id', athleteId)
      .maybeSingle()
    setGoal((ath?.goals as string | null) || (ath?.obstacle as string | null) || null)
  }

  function startWorkout(routineId: string) {
    navigate(`/app/workout/${routineId}`)
  }

  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: 'INSIGHTS', value: totalInsights },
    { label: String(likelyCount), value: 'LIKELY' },
    { label: String(p1Count), value: 'P1', signal: p1Count > 0 },
  ]

  const confidencePct = p1 ? Math.round(p1.confidence * 100) : null
  const nextIndex = week ? week.sessions.findIndex((s) => s.isNext) : -1

  return (
    <div className="screen with-nav">
      {isFirstVisit && (
        <p
          className="fade-rise"
          style={{ padding: '12px 16px', fontSize: 14, color: 'var(--text)', lineHeight: 1.5, borderBottom: '1px solid var(--line)' }}
        >
          This is Today. Open it before each session — it shows what's next, and the read sharpens underneath as you train.
        </p>
      )}

      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>

        {/* Goal anchor — the durable thing. The read moves underneath, taps to Coach. */}
        <div className="fade-rise" style={{ marginBottom: 28 }}>
          <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            {goal ? 'Chasing' : 'Today'}
          </p>
          <h2 style={{ marginTop: goal ? 6 : 4, fontSize: goal ? 21 : 22, fontWeight: 600, lineHeight: 1.25 }}>
            {goal ?? 'Today'}
          </h2>
          {!loading && p1 && confidencePct !== null && (
            <>
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
              <div className="confidence-meter__track" style={{ maxWidth: 240, marginTop: 8 }}>
                <div className="confidence-meter__fill" style={{ width: `${confidencePct}%` }} />
              </div>
            </>
          )}
        </div>

        {/* THIS WEEK — the loop. Count + next session + the rest as a checklist. */}
        <div className="fade-rise fade-rise-delay-1">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <SectionHeader>This week</SectionHeader>
            {week && week.total > 0 && (
              <span className={`num text-xs${week.complete ? ' text-signal' : ' text-dim'}`} style={{ letterSpacing: '0.04em' }}>
                {week.doneCount}/{week.total} done
              </span>
            )}
          </div>

          {!week || week.total === 0 ? (
            <div className="card">
              <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
                Your week builds after onboarding. Hang tight.
              </p>
            </div>
          ) : !week.complete && todayRoutine ? (
            // Next session card — the one action
            <div className="card" style={{ marginBottom: 16 }}>
              <SectionHeader>{nextIndex >= 0 ? `Next · session ${nextIndex + 1} of ${week.total}` : 'Next session'}</SectionHeader>
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
                  <span className="num text-signal" style={{ fontSize: 20, fontWeight: 600 }}>{todayRoutine.exercises.length}</span>
                  <span className="text-xs text-dim" style={{ marginLeft: 4 }}>exercises</span>
                </div>
                <div>
                  <span className="num text-dim" style={{ fontSize: 20 }}>~{todayRoutine.exercises.length * 8}</span>
                  <span className="text-xs text-dim" style={{ marginLeft: 4 }}>min</span>
                </div>
              </div>
              <Button variant="primary" full onClick={() => startWorkout(todayRoutine.id)}>Start session →</Button>
            </div>
          ) : (
            // Week complete — no guilt, just done. Train-again stays available.
            <div className="card" style={{ marginBottom: 16 }}>
              <SectionHeader>Week complete</SectionHeader>
              <p className="text-sm" style={{ marginTop: 8, lineHeight: 1.5 }}>
                All {week.total} sessions logged this week. Rest is part of the plan.
              </p>
              {todayRoutine && (
                <button
                  className="btn btn--ghost"
                  style={{ marginTop: 12, width: '100%' }}
                  onClick={() => startWorkout(todayRoutine.id)}
                >
                  Run an extra session →
                </button>
              )}
            </div>
          )}

          {/* Session checklist — fills in as the week goes */}
          {week && week.total > 0 && (
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {week.sessions.map((s) => (
                <li
                  key={s.routine.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 0', borderBottom: '1px solid var(--line)',
                  }}
                >
                  <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                    {s.done ? (
                      <Check size={14} strokeWidth={2.5} color="var(--confirmed)" />
                    ) : s.isNext ? (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--signal)' }} />
                    ) : (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1px solid var(--line)' }} />
                    )}
                  </span>
                  <span
                    style={{
                      flex: 1, fontSize: 14,
                      color: s.done ? 'var(--text-dim)' : 'var(--text)',
                    }}
                  >
                    {s.routine.name}
                  </span>
                  {s.isNext && !s.done && (
                    <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', color: 'var(--signal)' }}>NEXT</span>
                  )}
                  {s.done && (
                    <span className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em' }}>DONE</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
