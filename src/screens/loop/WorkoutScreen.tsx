import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronLeft, Check, Plus, Info } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { runSessionReviewAgent } from '../../engine'
import {
  Button, Spinner, ExerciseInsightSheet, TelemetryStrip,
} from '../../components/ui'
import type {
  RoutineRow, ExerciseTemplate, SetLog, InsightRow,
  OBSERVATION_CATEGORIES, SessionObservationInsert, OnboardingStep,
} from '../../types/database'

type ObsCat = typeof OBSERVATION_CATEGORIES[number]

// ---- Set row component -----------------------------------------------------

interface SetRowProps {
  setNum: number
  log: SetLog
  prevLog?: SetLog
  onChange: (updated: SetLog) => void
}

function SetRow({ setNum, log, prevLog, onChange }: SetRowProps) {
  return (
    <div className="set-row">
      <span className="set-row__num">{setNum}</span>

      {/* Weight */}
      <input
        className="set-row__input"
        type="number"
        inputMode="decimal"
        placeholder={prevLog?.weight != null ? String(prevLog.weight) : 'kg'}
        value={log.weight ?? ''}
        onChange={(e) => onChange({ ...log, weight: e.target.value ? parseFloat(e.target.value) : null })}
      />

      {/* Reps */}
      <input
        className="set-row__input"
        type="number"
        inputMode="numeric"
        placeholder={prevLog?.reps != null ? String(prevLog.reps) : 'reps'}
        value={log.reps ?? ''}
        onChange={(e) => onChange({ ...log, reps: e.target.value ? parseInt(e.target.value) : null })}
      />

      {/* RPE */}
      <input
        className="set-row__input"
        type="number"
        inputMode="numeric"
        min={1}
        max={10}
        placeholder="RPE"
        value={log.rpe ?? ''}
        onChange={(e) => onChange({ ...log, rpe: e.target.value ? parseInt(e.target.value) : null })}
        style={{ fontSize: 12 }}
      />

      {/* Done check */}
      <button
        type="button"
        className={`set-row__done${log.done ? ' set-row__done--checked' : ''}`}
        onClick={() => onChange({ ...log, done: !log.done })}
      >
        {log.done && (
          <Check size={14} strokeWidth={2.5} color="var(--signal)" />
        )}
      </button>
    </div>
  )
}

// ---- Observation capture sheet ---------------------------------------------

const OBS_OPTIONS: Array<{ label: ObsCat; severity: number }> = [
  { label: 'Felt strong',       severity: 1 },
  { label: 'PR hit',            severity: 1 },
  { label: 'Energy flag',       severity: 2 },
  { label: 'Struggled with load', severity: 3 },
  { label: 'Form breakdown',    severity: 4 },
  { label: 'Pain signal',       severity: 5 },
]

interface ObsSheetProps {
  onSave: (category: string, signal: string, severity: number) => void
  onSkip: () => void
  saving: boolean
}

function ObservationSheet({ onSave, onSkip, saving }: ObsSheetProps) {
  const [selected, setSelected] = useState<typeof OBS_OPTIONS[number] | null>(null)
  const [note, setNote]         = useState('')

  return (
    <div className="obs-sheet">
      <div className="obs-sheet__inner">
        <p className="section-header" style={{ marginBottom: 4 }}>Observation</p>
        <p className="text-xs text-dim" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          One signal from this session.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
          {OBS_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              className={`btn${selected?.label === opt.label ? ' btn--outline' : ' btn--ghost'}`}
              style={{
                height: 40,
                fontSize: 12,
                borderColor: selected?.label === opt.label
                  ? opt.severity >= 4 ? 'var(--veto)' : opt.severity >= 3 ? '#8A8A8A' : 'var(--signal)'
                  : 'var(--line)',
                color: selected?.label === opt.label
                  ? opt.severity >= 4 ? 'var(--veto)' : opt.severity >= 3 ? 'var(--text)' : 'var(--signal)'
                  : 'var(--text-dim)',
              }}
              onClick={() => setSelected(opt)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {selected && (
          <div style={{ marginBottom: 16 }}>
            <input
              className="input"
              type="text"
              placeholder="Optional: add a note (e.g. left knee, exercise name)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            style={{ flex: 1 }}
            onClick={onSkip}
            disabled={saving}
          >
            Skip
          </Button>
          <Button
            variant="primary"
            style={{ flex: 2 }}
            disabled={!selected || saving}
            onClick={() => {
              if (selected) {
                const signal = [selected.label, note].filter(Boolean).join(' — ')
                onSave(selected.label, signal, selected.severity)
              }
            }}
          >
            {saving ? <Spinner /> : 'Log it →'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- Main component --------------------------------------------------------

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function newSetLog(setNum: number): SetLog {
  return { set: setNum, weight: null, reps: null, rpe: null, done: false }
}

export function WorkoutScreen() {
  const { routineId } = useParams<{ routineId: string }>()
  const navigate      = useNavigate()

  const [routine, setRoutine]     = useState<RoutineRow | null>(null)
  const [athleteId, setAthleteId] = useState<string | null>(null)
  const [athleteName, setAthleteName] = useState<string | null>(null)
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(null)
  const [loading, setLoading]     = useState(true)
  const [elapsed, setElapsed]     = useState(0)
  const [saving, setSaving]       = useState(false)
  const [showObs, setShowObs]     = useState(false)
  const [savingObs, setSavingObs] = useState(false)
  const [workoutId, setWorkoutId] = useState<string | null>(null)

  // insight_id → insight, for the per-exercise "why" surface (Shift 5)
  const [insightMap, setInsightMap] = useState<Record<string, InsightRow>>({})
  const [openInsight, setOpenInsight] = useState<InsightRow | null>(null)
  const [openReading, setOpenReading] = useState<{ name: string; why: string } | null>(null)

  // Set logs: exerciseIndex → SetLog[]
  const [setLogs, setSetLogs] = useState<Record<number, SetLog[]>>({})

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startRef = useRef<number>(Date.now())

  useEffect(() => {
    if (!routineId) return
    loadRoutine()
    startRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineId])

  async function loadRoutine() {
    if (!routineId) return
    setLoading(true)
    const { data } = await supabase
      .from('routine')
      .select('*, program:program_id(athlete_id)')
      .eq('id', routineId)
      .single()

    if (data) {
      const r = data as RoutineRow
      setRoutine(r)
      // Grab athlete_id for the observation → insight writeback, plus the
      // athlete's name + onboarding step (drives the Act 6 first-win redirect).
      const programData = (data as unknown as { program: { athlete_id: string } | null }).program
      if (programData) {
        setAthleteId(programData.athlete_id)
        const { data: ath } = await supabase
          .from('athlete')
          .select('name, onboarding_step')
          .eq('id', programData.athlete_id)
          .maybeSingle()
        if (ath) {
          setAthleteName((ath as { name: string | null }).name ?? null)
          setOnboardingStep((ath as { onboarding_step: OnboardingStep }).onboarding_step)
        }
      }
      // Initialise set logs
      const exs = r.exercises as ExerciseTemplate[]
      const initial: Record<number, SetLog[]> = {}
      exs.forEach((ex, i) => {
        initial[i] = Array.from({ length: ex.sets }, (_, j) => newSetLog(j + 1))
      })
      setSetLogs(initial)

      // Load the insights that placed these exercises, for the "why" surface
      const insightIds = [...new Set(exs.map((ex) => ex.insight_id).filter(Boolean))] as string[]
      if (insightIds.length > 0) {
        const { data: insightRows } = await supabase
          .from('insight')
          .select('*')
          .in('id', insightIds)
        const map: Record<string, InsightRow> = {}
        ;(insightRows ?? []).forEach((ins) => { map[(ins as InsightRow).id] = ins as InsightRow })
        setInsightMap(map)
      }
    }
    setLoading(false)
  }

  function handleSetChange(exIdx: number, setIdx: number, updated: SetLog) {
    setSetLogs((prev) => {
      const sets = [...(prev[exIdx] ?? [])]
      sets[setIdx] = updated
      return { ...prev, [exIdx]: sets }
    })
  }

  function addSet(exIdx: number) {
    setSetLogs((prev) => {
      const sets = prev[exIdx] ?? []
      return { ...prev, [exIdx]: [...sets, newSetLog(sets.length + 1)] }
    })
  }

  const allDone = Object.values(setLogs)
    .flat()
    .filter((s) => s.reps !== null)
    .length > 0

  async function handleCompleteWorkout() {
    if (!routine) return
    setSaving(true)
    if (timerRef.current) clearInterval(timerRef.current)

    const actualWeights: Record<string, SetLog[]> = {}
    const actualReps: Record<string, number[]>    = {}

    Object.entries(setLogs).forEach(([idx, logs]) => {
      actualWeights[idx] = logs
      actualReps[idx]    = logs.map((l) => l.reps ?? 0)
    })

    // Average RPE across all logged sets
    const rpeValues = Object.values(setLogs).flat().filter((s) => s.rpe !== null).map((s) => s.rpe!)
    const avgRpe    = rpeValues.length ? Math.round(rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) : null

    const { data: workout, error } = await supabase
      .from('workout')
      .insert({
        routine_id:     routineId!,
        actual_weights: actualWeights,
        actual_reps:    actualReps,
        rpe:            avgRpe,
        duration_mins:  Math.ceil(elapsed / 60),
      })
      .select()
      .single()

    if (error || !workout) {
      console.error('Failed to save workout', error)
      setSaving(false)
      return
    }

    setWorkoutId(workout.id)
    setSaving(false)
    setShowObs(true)
  }

  async function handleObsSave(observationLabel: string, signal: string, severity: number) {
    if (!workoutId || !athleteId) return
    setSavingObs(true)

    // 1. Load existing insights so the engine can decide update vs create
    const { data: existingInsights } = await supabase
      .from('insight')
      .select('*')
      .eq('athlete_id', athleteId)
      .neq('status', 'resolved')
      .neq('status', 'disproved')

    // 2. Engine resolves the action — the agent CLASSIFIES the observation,
    //    deterministic code applies the bounded confidence delta. Falls back to
    //    the rule-based resolver on model failure (same return contract).
    const action = await runSessionReviewAgent(
      athleteId,
      workoutId,
      observationLabel,
      signal,
      severity,
      existingInsights ?? [],
    )

    // 3. Save the observation using the resolved insight category
    const obs: SessionObservationInsert = {
      workout_id: workoutId,
      category:   action.insightCategory,   // insight category, not the label
      signal,
      severity,
    }
    await supabase.from('session_observation').insert(obs)

    // 4. Execute update or create on the insight table. Capture the moved
    //    insight + its confidence shift for the post-session revelation.
    let movedInsightId: string | null = null
    let previousConfidence: number | null = null
    let newConfidence: number | null = null

    if (action.action === 'update' && action.existingInsightId) {
      const updatePayload: Record<string, unknown> = {
        confidence: action.updatedConfidence,
        evidence:   action.updatedEvidence,
      }
      // Advance status if the engine crossed a confidence threshold.
      // (updated_at / prev_status are maintained by the DB trigger.)
      if (action.updatedStatus) updatePayload.status = action.updatedStatus

      await supabase
        .from('insight')
        .update(updatePayload)
        .eq('id', action.existingInsightId)

      const prior = (existingInsights ?? []).find((i) => i.id === action.existingInsightId)
      movedInsightId = action.existingInsightId
      previousConfidence = prior?.confidence ?? null
      newConfidence = action.updatedConfidence
    } else if (action.action === 'create' && action.newInsight) {
      const { data: created } = await supabase
        .from('insight')
        .insert(action.newInsight)
        .select()
        .single()
      if (created) {
        movedInsightId = (created as InsightRow).id
        newConfidence = (created as InsightRow).confidence
      }
    }

    setSavingObs(false)

    // 5. First session ever → the post-session revelation (Act 6, Screen 21).
    //    Every session after → the existing profile pulse.
    if (onboardingStep === 'first_session_pending') {
      await supabase
        .from('athlete')
        .update({ onboarding_step: 'first_session_complete' })
        .eq('id', athleteId)

      navigate('/onboarding/revelation', {
        replace: true,
        state: {
          movedInsightId,
          category: action.insightCategory,
          previousConfidence,
          newConfidence,
          isNew: action.action === 'create',
          durationMins: Math.ceil(elapsed / 60),
          setsLogged: Object.values(setLogs).flat().filter((s) => s.done).length,
          name: athleteName,
        },
      })
      return
    }

    navigate('/app/profile', {
      state: { pulsedCategory: action.insightCategory },
      replace: true,
    })
  }

  async function handleObsSkip() {
    // First-session skip still completes onboarding — there's just no revelation.
    if (onboardingStep === 'first_session_pending' && athleteId) {
      await supabase
        .from('athlete')
        .update({ onboarding_step: 'complete' })
        .eq('id', athleteId)
    }
    navigate('/app/today', { replace: true })
  }

  // ---- Loading / error states ----------------------------------------------

  if (loading) {
    return (
      <div className="screen--centered">
        <Spinner />
      </div>
    )
  }

  if (!routine) {
    return (
      <div className="screen--centered">
        <p className="text-dim">Session not found.</p>
        <Button variant="ghost" onClick={() => navigate('/app/today')} style={{ marginTop: 16 }}>
          Back
        </Button>
      </div>
    )
  }

  const exercises = routine.exercises as ExerciseTemplate[]

  // Telemetry header values
  const allSets   = Object.values(setLogs).flat()
  const setsTotal = allSets.length
  const setsDone  = allSets.filter((s) => s.done).length
  const rpeLive   = allSets.filter((s) => s.rpe !== null).map((s) => s.rpe!)
  const avgRpeLive = rpeLive.length ? Math.round(rpeLive.reduce((a, b) => a + b, 0) / rpeLive.length) : null

  const workoutStripItems: Array<{ label: string; value: string | number }> = [
    { label: 'WORKOUT', value: routine.name },
    { label: 'ELAPSED', value: formatElapsed(elapsed) },
    { label: 'SETS', value: `${setsDone}/${setsTotal}` },
  ]
  if (avgRpeLive !== null) workoutStripItems.push({ label: 'RPE', value: avgRpeLive })

  // ---- Full-screen workout (no nav) ----------------------------------------

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      {/* Header bar — back affordance + always-on telemetry strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          borderBottom: '1px solid var(--line)',
          position: 'sticky',
          top: 0,
          background: 'var(--ground)',
          zIndex: 10,
        }}
      >
        <button
          type="button"
          className="btn btn--ghost"
          style={{ padding: '0 8px', height: 28, minWidth: 36 }}
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <ChevronLeft size={20} strokeWidth={1.5} />
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <TelemetryStrip items={workoutStripItems} lastSignalAt={new Date(startRef.current)} />
        </div>
      </div>

      {/* Column headers */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '28px 1fr 1fr 52px 40px',
          gap: 6,
          padding: '6px 16px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        {['Set', 'kg', 'Reps', 'RPE', ''].map((h, i) => (
          <span
            key={i}
            className="text-xs text-dim"
            style={{ fontFamily: 'var(--font-mono)', textAlign: 'center', fontSize: 10 }}
          >
            {h}
          </span>
        ))}
      </div>

      {/* Exercise list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 120px' }}>
        {exercises.map((ex, exIdx) => {
          const logs = setLogs[exIdx] ?? []

          return (
            <div
              key={exIdx}
              style={{
                paddingTop: 20,
                paddingBottom: 12,
                borderBottom: '1px solid var(--line)',
              }}
            >
              {/* Exercise header */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <p style={{ fontWeight: 600, fontSize: 15 }}>{ex.name}</p>
                  {ex.insight_id && insightMap[ex.insight_id] && (
                    <button
                      type="button"
                      className="exercise-info-btn"
                      aria-label="Why this exercise"
                      onClick={() => setOpenInsight(insightMap[ex.insight_id!])}
                    >
                      <Info size={12} strokeWidth={2} />
                    </button>
                  )}
                  {ex.reading && (
                    <button
                      type="button"
                      className="reading-tag"
                      aria-label="Why we're reading this"
                      onClick={() => setOpenReading({ name: ex.name, why: ex.reading_why ?? '' })}
                    >
                      READING
                    </button>
                  )}
                </div>
                {ex.cue && (
                  <p className="text-xs text-dim" style={{ marginTop: 3, lineHeight: 1.5 }}>
                    {ex.cue}
                  </p>
                )}
                <p className="num text-xs text-dim" style={{ marginTop: 3 }}>
                  {ex.sets} × {ex.reps}
                  {ex.load ? ` · ${ex.load}` : ''}
                </p>
              </div>

              {/* Set rows */}
              {logs.map((log, setIdx) => (
                <SetRow
                  key={setIdx}
                  setNum={setIdx + 1}
                  log={log}
                  onChange={(updated) => handleSetChange(exIdx, setIdx, updated)}
                />
              ))}

              {/* Add set */}
              <button
                type="button"
                className="btn btn--ghost"
                style={{ marginTop: 6, height: 32, fontSize: 12, padding: '0 4px', color: 'var(--text-dim)' }}
                onClick={() => addSet(exIdx)}
              >
                <Plus size={12} strokeWidth={2} style={{ marginRight: 4 }} />
                Add set
              </button>
            </div>
          )
        })}
      </div>

      {/* Bottom complete bar */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '12px 16px',
          paddingBottom: `calc(12px + env(safe-area-inset-bottom, 0px))`,
          background: 'var(--ground)',
          borderTop: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <span className="text-xs text-dim">Duration  </span>
            <span className="num text-xs">{formatElapsed(elapsed)}</span>
          </div>
          <div>
            <span className="text-xs text-dim">Sets logged  </span>
            <span className="num text-xs">
              {Object.values(setLogs).flat().filter((s) => s.done).length}
            </span>
          </div>
        </div>
        <Button
          variant="primary"
          full
          onClick={handleCompleteWorkout}
          disabled={saving || !allDone}
        >
          {saving ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner /> Saving…
            </span>
          ) : (
            'Complete workout →'
          )}
        </Button>
      </div>

      {/* Observation sheet (appears post-save) */}
      {showObs && (
        <ObservationSheet
          onSave={handleObsSave}
          onSkip={handleObsSkip}
          saving={savingObs}
        />
      )}

      {/* Exercise "why" sheet (Shift 5) */}
      {openInsight && (
        <ExerciseInsightSheet
          insight={openInsight}
          onClose={() => setOpenInsight(null)}
        />
      )}

      {openReading && (
        <div className="obs-sheet" onClick={() => setOpenReading(null)}>
          <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
            <p
              className="section-header"
              style={{ color: 'var(--computing)', marginBottom: 10 }}
            >
              READING · {openReading.name}
            </p>
            <p className="text-sm" style={{ lineHeight: 1.5, marginBottom: 12 }}>
              {openReading.why}
            </p>
            <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
              How this one goes feeds the read — no need to score it, just train it honestly.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
