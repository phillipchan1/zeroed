import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { generateInsightsFromDiagnostic, generateInitialProgram } from '../../engine'
import { Button, TypeOn, TickingNumber, PresenceDot } from '../../components/ui'
import type { DiagnosticResults, InsightRow } from '../../types/database'
import { MOVEMENT_PATTERNS } from '../../types/database'

/**
 * Screen 17 · Building Your Read (Act 4 — The Compute)
 * The single highest-leverage moment for selling intelligence. Most apps skip
 * this or fake it; we make it earnest, specific, observable. The visual beat
 * runs ~20s while the real engine work (insights → program → profile) runs
 * behind it. This is the one canonical use of `.thinking-shimmer` in onboarding.
 */

const LINES = [
  'Reading movement screen',
  'Cross-referencing strength baselines',
  'Ranking limiters by impact',
  'Matching to Stability phase',
  'Building week 1',
  'Ready',
]

const LINE_GAP = 3400    // ms between lines starting to type
const FINAL_HOLD = 2500  // hold after the last line before advancing
const RETEST_DAYS = 28

interface ComputeProps {
  athleteId: string
  results: DiagnosticResults | null
  onComplete: () => void
}

export function ComputeScreen({ athleteId, results, onComplete }: ComputeProps) {
  const [visibleLines, setVisibleLines] = useState(0)
  const [beatDone, setBeatDone] = useState(false)
  const [engineDone, setEngineDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [targets, setTargets] = useState<{ insights: number; p1: number; showRetest: boolean }>({
    insights: 0, p1: 0, showRetest: false,
  })
  const ranRef = useRef(false)

  // --- Visual beat: six lines type on sequentially, then hold ---------------
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (let i = 0; i < LINES.length; i++) {
      timers.push(setTimeout(() => setVisibleLines(i + 1), i * LINE_GAP))
    }
    const doneTimer = setTimeout(
      () => setBeatDone(true),
      (LINES.length - 1) * LINE_GAP + FINAL_HOLD,
    )
    timers.push(doneTimer)
    return () => timers.forEach(clearTimeout)
  }, [])

  // --- Real engine work (runs once) -----------------------------------------
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void runEngine()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runEngine() {
    setError(null)
    try {
      // Idempotent recovery: if a program already exists (e.g. reload mid-compute),
      // skip the build and just resolve the telemetry counts.
      const { data: existingProgram } = await supabase
        .from('program')
        .select('id')
        .eq('athlete_id', athleteId)
        .eq('status', 'active')
        .maybeSingle()

      if (existingProgram) {
        await resolveTargets()
        setEngineDone(true)
        return
      }

      if (!results) {
        setError('Lost the screening data. Tap to run it again.')
        return
      }

      // 1. Persist the diagnostic
      const { data: diagRow, error: diagErr } = await supabase
        .from('diagnostic')
        .insert({
          athlete_id: athleteId,
          test_battery: {
            movement_patterns: MOVEMENT_PATTERNS.map((p) => p.label),
            strength_tests: ['Squat', 'Hip Hinge', 'Push', 'Pull', 'Core'],
            subjective: ['sleep', 'energy', 'stress', 'pain'],
          },
          raw_results: results,
          version: 1,
        })
        .select()
        .single()

      if (diagErr || !diagRow) throw diagErr ?? new Error('diagnostic insert failed')

      // 2. Generate + persist insights
      const generated = generateInsightsFromDiagnostic(athleteId, diagRow.id, results)
      if (generated.length > 0) {
        const { error: insErr } = await supabase.from('insight').insert(generated)
        if (insErr) throw insErr
      }

      // 3. Reload ranked insights and build the program
      const { data: insightRows, error: loadErr } = await supabase
        .from('insight')
        .select('*')
        .eq('athlete_id', athleteId)
        .order('priority')

      if (loadErr) throw loadErr
      const ranked = (insightRows ?? []) as InsightRow[]

      const today = new Date().toISOString().split('T')[0]
      const plan = generateInitialProgram(ranked, today)

      const { data: prog, error: progErr } = await supabase
        .from('program')
        .insert({
          athlete_id: athleteId,
          goal: plan.goal,
          start_date: today,
          retest_date: plan.retest_date,
          status: 'active',
        })
        .select()
        .single()
      if (progErr || !prog) throw progErr ?? new Error('program insert failed')

      const { data: phase, error: phaseErr } = await supabase
        .from('phase')
        .insert({
          program_id: prog.id,
          name: plan.phase.name,
          week_start: plan.phase.week_start,
          week_end: plan.phase.week_end,
          non_negotiables: plan.phase.non_negotiables,
          advancement_criteria: plan.phase.advancement_criteria,
          status: 'active',
        })
        .select()
        .single()
      if (phaseErr || !phase) throw phaseErr ?? new Error('phase insert failed')

      const routineInserts = plan.routines.map((r) => ({
        program_id: prog.id,
        phase_id: phase.id,
        name: r.name,
        session_type: r.session_type,
        exercises: r.exercises,
        intent: r.intent,
      }))
      const { error: routineErr } = await supabase.from('routine').insert(routineInserts)
      if (routineErr) throw routineErr

      // 4. Write the profile — this is the durable "Zeroed In" record
      await supabase.from('athlete_profile').upsert({
        athlete_id: athleteId,
        current_phase: plan.phase.name,
        retest_date: plan.retest_date,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'athlete_id' })

      setTargets({
        insights: ranked.length,
        p1: ranked.filter((i) => i.priority === 'P1').length,
        showRetest: true,
      })
      setEngineDone(true)
    } catch (err) {
      console.error('compute failed', err)
      setError('Something broke building your read. Tap to retry.')
    }
  }

  async function resolveTargets() {
    const { data } = await supabase
      .from('insight')
      .select('priority')
      .eq('athlete_id', athleteId)
    const rows = (data ?? []) as Array<{ priority: string }>
    setTargets({
      insights: rows.length,
      p1: rows.filter((r) => r.priority === 'P1').length,
      showRetest: true,
    })
  }

  // --- Advance once both the beat and the engine are done -------------------
  useEffect(() => {
    if (beatDone && engineDone && !error) onComplete()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatDone, engineDone, error])

  function handleRetry() {
    ranRef.current = false
    setEngineDone(false)
    void runEngine()
  }

  if (error) {
    return (
      <div className="screen--centered">
        <p className="text-dim" style={{ marginBottom: 16, textAlign: 'center', maxWidth: 320 }}>{error}</p>
        <Button variant="outline" onClick={handleRetry}>Retry</Button>
      </div>
    )
  }

  return (
    <div
      className="thinking-shimmer"
      style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--ground)' }}
    >
      {/* Telemetry strip — numbers tick from 0 to their final values */}
      <div className="telemetry-strip">
        <span className="telemetry-strip__item"><PresenceDot /></span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">
          INSIGHTS <TickingNumber value={targets.insights} className="num" />
        </span>
        <span className="telemetry-strip__sep">·</span>
        <span className={`telemetry-strip__item${targets.p1 > 0 ? ' telemetry-strip__signal' : ''}`}>
          P1 <TickingNumber value={targets.p1} className="num" />
        </span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">
          RETEST <span className="num">{targets.showRetest ? `${RETEST_DAYS}d` : '—'}</span>
        </span>
      </div>

      {/* Compute log — earnest, specific, observable */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 24px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {LINES.slice(0, visibleLines).map((line, i) => (
            <p
              key={i}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 14,
                letterSpacing: '0.02em',
                color: 'var(--text-dim)',
                lineHeight: 1.4,
              }}
            >
              <span style={{ color: 'var(--signal)' }}>{'> '}</span>
              <TypeOn text={line} delay={60} />
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
