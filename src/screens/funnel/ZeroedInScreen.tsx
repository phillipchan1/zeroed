import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { generateInitialProgram } from '../../engine'
import {
  Logo, Button, InsightCard, Spinner, SectionHeader, TypeOn, BracketFrame,
} from '../../components/ui'
import type { InsightRow } from '../../types/database'

interface ZeroedInProps {
  athleteId: string
  onComplete: () => void
}

function weeksBetween(startStr: string, endStr: string): number {
  const start = new Date(startStr).getTime()
  const end   = new Date(endStr).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return 4
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24) / 7) + 1)
}

type BuildPhase = 'loading' | 'building' | 'ready' | 'error'

export function ZeroedInScreen({ athleteId, onComplete }: ZeroedInProps) {
  const navigate = useNavigate()
  const [buildPhase, setBuildPhase] = useState<BuildPhase>('loading')
  const [insights, setInsights]     = useState<InsightRow[]>([])
  const [p1Category, setP1Category] = useState<string>('Lower Chain')
  const [programId, setProgramId]   = useState<string | null>(null)
  const [athleteName, setAthleteName] = useState<string | null>(null)
  const [phaseName, setPhaseName]   = useState<string>('Stability')
  const [retestDate, setRetestDate] = useState<string | null>(null)
  const [weeksTotal, setWeeksTotal] = useState<number>(4)
  const [error, setError]           = useState<string | null>(null)

  useEffect(() => {
    buildProgram()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  async function buildProgram() {
    setBuildPhase('loading')

    // 0. Load athlete so we can address them by name in the warm headline
    const { data: athleteRow } = await supabase
      .from('athlete')
      .select('name')
      .eq('id', athleteId)
      .maybeSingle()

    if (athleteRow) {
      setAthleteName(athleteRow.name ?? null)
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

    const rankedRows = insightRows as InsightRow[]
    setP1Category(rankedRows[0]?.category ?? 'Lower Chain')

    // 2. Check if program already exists (idempotent on re-render)
    const { data: existingProgram } = await supabase
      .from('program')
      .select('id, retest_date')
      .eq('athlete_id', athleteId)
      .eq('status', 'active')
      .maybeSingle()

    if (existingProgram) {
      setProgramId(existingProgram.id)
      setRetestDate(existingProgram.retest_date ?? null)
      const { data: ph } = await supabase
        .from('phase')
        .select('name, week_start, week_end')
        .eq('program_id', existingProgram.id)
        .eq('status', 'active')
        .maybeSingle()
      if (ph) {
        setPhaseName(ph.name as string)
        setWeeksTotal(weeksBetween(ph.week_start as string, ph.week_end as string))
      }
      setBuildPhase('ready')
      return
    }

    // 3. Build program — brief loading beat
    setBuildPhase('building')
    await new Promise((r) => setTimeout(r, 1400))  // perceptible beat, not a fake delay

    const rows = rankedRows
    const today = new Date().toISOString().split('T')[0]
    // Pass the full ranked list so each exercise is stamped with its insight_id.
    const plan  = generateInitialProgram(rows, today)
    setPhaseName(plan.phase.name)
    setRetestDate(plan.retest_date)
    setWeeksTotal(weeksBetween(plan.phase.week_start, plan.phase.week_end))

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
        {/* Thinking shimmer fires only here — a real generation event */}
        <div
          className={buildPhase === 'building' ? 'thinking-shimmer' : ''}
          style={{ textAlign: 'center', padding: '24px 40px', borderRadius: 8 }}
        >
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
  const p2Insight = insights[1] ?? null

  const daysToRetest = retestDate
    ? Math.max(0, Math.ceil((new Date(retestDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 28

  // Layer 3 — warm characterization, deterministic for now (Prompt 3: real agent).
  let characterization: string
  if (p1Insight && p2Insight && p1Insight.category !== p2Insight.category) {
    characterization = `Your ${p1Insight.category.toLowerCase()}'s the bigger story than your ${p2Insight.category.toLowerCase()}. The program starts there.`
  } else if (p1Insight) {
    characterization = `${p1Insight.category} is the limiter. Everything builds from there.`
  } else {
    characterization = 'You move clean. Program goes straight to building strength.'
  }

  const weakLinkLabel = `${insights.length} weak link${insights.length === 1 ? '' : 's'}`

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
        {/* Hero — canonical 3-layer: warm headline → cold telemetry → warm characterization */}
        <div className="fade-rise" style={{ marginBottom: 40 }}>
          {/* Layer 1: warm headline */}
          <h1 className="hero-headline">
            You're zeroed in{athleteName ? `, ${athleteName}` : ''}.
          </h1>

          {/* Layer 2: cold telemetry */}
          <p className="hero-telemetry" style={{ marginTop: 12 }}>
            {weakLinkLabel} · phase: {phaseName.toUpperCase()} · session 1 ready · {daysToRetest}d to retest
          </p>

          {/* Layer 3: warm characterization */}
          <p className="hero-characterization" style={{ marginTop: 16 }}>
            <TypeOn text={characterization} delay={40} />
          </p>
        </div>

        {/* Phase assignment — telemetric, the one bracketed surface */}
        <BracketFrame className="fade-rise fade-rise-delay-1" style={{ padding: 'var(--sp-4)', marginBottom: 32 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: 40,
              fontWeight: 700,
              lineHeight: 1,
              color: 'var(--signal)',
              display: 'block',
            }}
          >
            {weeksTotal}
          </span>
          <span className="hero-number__label">
            WEEKS · {phaseName.toUpperCase()} PHASE
          </span>
          <p className="text-xs text-dim" style={{ marginTop: 12, lineHeight: 1.6 }}>
            3 sessions/week · gated on {p1Category} pattern improvement
          </p>
        </BracketFrame>

        {/* Weak link stack — below the hero block */}
        {insights.length > 0 && (
          <div className="fade-rise fade-rise-delay-2" style={{ marginBottom: 32 }}>
            <SectionHeader>WEAK LINKS — RANKED</SectionHeader>
            <div style={{ marginTop: 12 }}>
              {insights.map((ins) => (
                <InsightCard key={ins.id} insight={ins} />
              ))}
            </div>
          </div>
        )}

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
