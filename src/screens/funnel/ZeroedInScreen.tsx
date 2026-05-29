import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { generateInitialProgram } from '../../engine'
import {
  Logo, Button, InsightCard, Spinner, SectionHeader,
} from '../../components/ui'
import type { InsightRow } from '../../types/database'

interface ZeroedInProps {
  athleteId: string
  onComplete: () => void
}

type BuildPhase = 'loading' | 'building' | 'ready' | 'error'

export function ZeroedInScreen({ athleteId, onComplete }: ZeroedInProps) {
  const navigate = useNavigate()
  const [buildPhase, setBuildPhase] = useState<BuildPhase>('loading')
  const [insights, setInsights]     = useState<InsightRow[]>([])
  const [p1Category, setP1Category] = useState<string>('Lower Chain')
  const [programId, setProgramId]   = useState<string | null>(null)
  const [athleteName, setAthleteName] = useState<string | null>(null)
  const [sport, setSport]           = useState<string | null>(null)
  const [goals, setGoals]           = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)

  useEffect(() => {
    buildProgram()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  async function buildProgram() {
    setBuildPhase('loading')

    // 0. Load athlete so we can frame the result against their goal & sport
    const { data: athleteRow } = await supabase
      .from('athlete')
      .select('name, sport, goals')
      .eq('id', athleteId)
      .maybeSingle()

    if (athleteRow) {
      setAthleteName(athleteRow.name ?? null)
      setSport(athleteRow.sport ?? null)
      setGoals(athleteRow.goals ?? null)
    }

    // 1. Load insights to display
    const { data: insightRows, error: insightErr } = await supabase
      .from('insight')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('priority')

    if (insightErr || !insightRows) {
      setError('Could not load assessment results.')
      setBuildPhase('error')
      return
    }

    setInsights(insightRows as InsightRow[])

    // 2. Check if program already exists (idempotent on re-render)
    const { data: existingProgram } = await supabase
      .from('program')
      .select('id')
      .eq('athlete_id', athleteId)
      .eq('status', 'active')
      .maybeSingle()

    if (existingProgram) {
      setProgramId(existingProgram.id)
      setBuildPhase('ready')
      return
    }

    // 3. Build program — brief loading beat
    setBuildPhase('building')
    await new Promise((r) => setTimeout(r, 1400))  // perceptible beat, not a fake delay

    const rows = insightRows as InsightRow[]
    const p1 = rows[0]
    const category = p1?.category ?? 'Lower Chain'
    setP1Category(category)

    const today = new Date().toISOString().split('T')[0]
    // Pass the full ranked list so each exercise is stamped with its insight_id.
    const plan  = generateInitialProgram(rows, today)

    // 4. Write program
    const { data: prog, error: progErr } = await supabase
      .from('program')
      .insert({
        athlete_id:  athleteId,
        goal:        plan.goal,
        start_date:  today,
        retest_date: plan.retest_date,
        status:      'active',
      })
      .select()
      .single()

    if (progErr || !prog) {
      setError('Failed to generate program.')
      setBuildPhase('error')
      return
    }

    // 5. Write phase
    const { data: phase, error: phaseErr } = await supabase
      .from('phase')
      .insert({
        program_id:           prog.id,
        name:                 plan.phase.name,
        week_start:           plan.phase.week_start,
        week_end:             plan.phase.week_end,
        non_negotiables:      plan.phase.non_negotiables,
        advancement_criteria: plan.phase.advancement_criteria,
        status:               'active',
      })
      .select()
      .single()

    if (phaseErr || !phase) {
      setError('Failed to generate phase.')
      setBuildPhase('error')
      return
    }

    // 6. Write routines
    const routineInserts = plan.routines.map((r) => ({
      program_id:   prog.id,
      phase_id:     phase.id,
      name:         r.name,
      session_type: r.session_type,
      exercises:    r.exercises,
      intent:       r.intent,
    }))

    const { error: routineErr } = await supabase.from('routine').insert(routineInserts)

    if (routineErr) {
      setError('Failed to generate routines.')
      setBuildPhase('error')
      return
    }

    // 7. Write athlete_profile — this signals "Zeroed In" is complete
    await supabase
      .from('athlete_profile')
      .upsert({
        athlete_id:    athleteId,
        current_phase: plan.phase.name,
        retest_date:   plan.retest_date,
        last_updated:  new Date().toISOString(),
      }, { onConflict: 'athlete_id' })

    setProgramId(prog.id)
    setBuildPhase('ready')
  }

  async function handleStart() {
    onComplete()
    navigate('/app/today')
  }

  // ---- Render states -------------------------------------------------------

  if (buildPhase === 'loading' || buildPhase === 'building') {
    return (
      <div className="screen--centered">
        <div style={{ textAlign: 'center' }}>
          <Spinner />
          <p className="text-dim" style={{ marginTop: 16, fontSize: 13 }}>
            {buildPhase === 'building' ? 'Building your program…' : 'Loading…'}
          </p>
        </div>
      </div>
    )
  }

  if (buildPhase === 'error') {
    return (
      <div className="screen--centered">
        <p className="text-dim" style={{ marginBottom: 16 }}>{error}</p>
        <Button variant="outline" onClick={buildProgram}>Retry</Button>
      </div>
    )
  }

  // ---- Ready ---------------------------------------------------------------

  const p1Insight = insights[0] ?? null

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      {/* Header */}
      <div
        style={{
          padding: '24px 20px 0',
          borderBottom: '1px solid var(--line)',
          paddingBottom: 20,
        }}
      >
        <Logo />
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          padding: '32px 20px',
          maxWidth: 480,
          margin: '0 auto',
          width: '100%',
        }}
      >
        {/* Hero */}
        <div className="fade-rise" style={{ marginBottom: 40 }}>
          <p
            className="text-dim section-header"
            style={{ marginBottom: 12 }}
          >
            Diagnostic complete
          </p>
          <h1
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 28,
              fontWeight: 700,
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
            }}
          >
            {athleteName ? `You're Zeroed In, ${athleteName}.` : "You're Zeroed In."}
          </h1>
          <p className="text-dim" style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>
            {goals
              ? `We screened how you move against your goal — ${goals.trim().replace(/\.$/, '')}.`
              : sport
                ? `We screened how you move against the demands of ${sport}.`
                : 'We screened how you move.'}
            {' '}
            {insights.length > 0
              ? `Here's what's standing in the way, ranked by what to fix first. Your Stability phase starts today and targets exactly these.`
              : 'No movement limiters are holding you back — so your program goes straight to building strength.'}
          </p>
        </div>

        {/* Weak link stack */}
        {insights.length > 0 && (
          <div className="fade-rise fade-rise-delay-1" style={{ marginBottom: 32 }}>
            <SectionHeader>Weak links — ranked</SectionHeader>
            <div style={{ marginTop: 12 }}>
              {insights.map((ins) => (
                <InsightCard key={ins.id} insight={ins} />
              ))}
            </div>
          </div>
        )}

        {/* Phase assignment */}
        <div className="fade-rise fade-rise-delay-2 card" style={{ marginBottom: 32 }}>
          <SectionHeader>Assigned phase</SectionHeader>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 18,
                fontWeight: 600,
                color: 'var(--signal)',
              }}
            >
              Stability
            </span>
            <span className="text-dim text-sm">4 weeks · 3 sessions/week</span>
          </div>
          {p1Insight && (
            <p className="text-xs text-dim" style={{ marginTop: 8, lineHeight: 1.6 }}>
              Focus: {p1Category} quality. Load progression gated on pattern improvement.
            </p>
          )}
        </div>

        {/* Image slot — placeholder for Prompt 2 */}
        {/* TODO: one diagnostic image slot goes here */}

        {/* Primary CTA */}
        <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 8 }}>
          <Button
            variant="primary"
            full
            onClick={handleStart}
            disabled={!programId}
          >
            Start Session 1 →
          </Button>
        </div>
      </div>
    </div>
  )
}
