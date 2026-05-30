import { useEffect, useState, useRef, type ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronLeft, Check, Plus, Info, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { runSessionDebriefAgent, gatherSessionPrescription, type DebriefInput, type SessionPrescription } from '../../engine'
import { resolveTrackingType } from '../../engine/exerciseLibrary'
import { getWeightUnit, getDistanceUnit } from '../../lib/units'
import {
  Button, Spinner, ExerciseInsightSheet, TelemetryStrip,
} from '../../components/ui'
import type {
  RoutineRow, ExerciseTemplate, SetLog, InsightRow, TrackingType,
  SessionObservationInsert, OnboardingStep, FeltLabel, ExerciseFeedback, Readiness,
} from '../../types/database'
import { FELT_CHIPS } from '../../types/database'

// ---- small parse helpers ---------------------------------------------------

// First integer in a prescription string: "8-10" → 8, "30s" → 30, "8 each side" → 8.
function leadingInt(s: string | undefined): number | null {
  if (!s) return null
  const m = s.match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

const REST_SECONDS = 90
const RPE_SCALE = [6, 7, 8, 9, 10]

// Column layout per tracking type, as a CSS class so the grid template can be
// overridden by media query (desktop slots in an extra "Previous" column that
// mobile hides). Shared by the header and every set row so columns stay aligned.
function gridClass(t: TrackingType): string {
  if (t === 'time')     return 'set-grid--time'
  if (t === 'distance') return 'set-grid--dist'
  return 'set-grid--wr' // weight_reps & bodyweight_reps
}

// Compact "what you hit last session" string for the desktop Previous column.
function formatPrev(
  t: TrackingType, prev: SetLog | undefined, unit: string, distanceUnit: string,
): string | null {
  if (!prev) return null
  if (t === 'time')     return prev.duration != null ? `${prev.duration}s` : null
  if (t === 'distance') return prev.distance != null ? `${prev.distance}${distanceUnit}` : null
  if (t === 'bodyweight_reps') {
    if (prev.reps == null) return null
    return prev.weight ? `${prev.reps}+${prev.weight}` : `${prev.reps}`
  }
  if (prev.weight == null && prev.reps == null) return null
  return `${prev.weight != null ? `${prev.weight}${unit}` : 'BW'}×${prev.reps ?? '?'}`
}

// Enter flies the cursor to the next numeric field, across rows and exercises —
// spreadsheet-speed entry on a physical keyboard, harmless under a thumb.
function advanceField(el: EventTarget & HTMLInputElement) {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.set-row__input'))
  const i = inputs.indexOf(el)
  if (i >= 0 && i + 1 < inputs.length) inputs[i + 1].focus()
}

// ---- Column header (prescribed target as a labelled column) ----------------

interface SetHeaderProps {
  trackingType: TrackingType
  unit: string
  distanceUnit: string
  prescribedReps: string         // raw prescription, e.g. "8-10" or "30s"
  prescribedLoad: string | null  // raw load, e.g. "225 lbs" or "bodyweight"
}

function headCell(label: string, target: string | null) {
  return (
    <div className="set-head__cell">
      <span className="set-head__label">{label}</span>
      <span className="set-head__target">{target || '—'}</span>
    </div>
  )
}

// A header that labels each input column and parks the prescribed target right
// above the field you type into — so "what to hit" sits next to "what you did".
function SetHeader({
  trackingType, unit, distanceUnit, prescribedReps, prescribedLoad,
}: SetHeaderProps) {
  let cells: ReactNode
  if (trackingType === 'time') {
    cells = (
      <>
        {headCell('Time', prescribedReps)}
        {headCell('RPE', null)}
      </>
    )
  } else if (trackingType === 'distance') {
    cells = headCell(distanceUnit, prescribedReps)
  } else if (trackingType === 'bodyweight_reps') {
    cells = (
      <>
        {headCell('Reps', prescribedReps)}
        {headCell(`+${unit}`, prescribedLoad)}
        {headCell('RPE', null)}
      </>
    )
  } else {
    cells = (
      <>
        {headCell(unit, prescribedLoad)}
        {headCell('Reps', prescribedReps)}
        {headCell('RPE', null)}
      </>
    )
  }
  return (
    <div className={`set-head ${gridClass(trackingType)}`}>
      <span className="set-head__set">Set</span>
      <span className="set-head__label set-head__prev">Prev</span>
      {cells}
      <span aria-hidden />
    </div>
  )
}

// ---- Set row (tracking-type aware) -----------------------------------------

interface SetRowProps {
  setNum: number
  log: SetLog
  trackingType: TrackingType
  unit: string
  distanceUnit: string
  prescribedReps: number | null
  prescribedDuration: number | null
  prevText: string | null  // last session's result for this set (desktop column)
  onChange: (updated: SetLog) => void
  onComplete: () => void   // fires when a set is newly marked done (→ rest timer)
  onActivate: () => void   // a field here was focused → drives the desktop rail
}

function SetRow({
  setNum, log, trackingType, unit, distanceUnit,
  prescribedReps, prescribedDuration, prevText, onChange, onComplete, onActivate,
}: SetRowProps) {
  const [rpeOpen, setRpeOpen] = useState(false)

  const num = (v: string) => (v === '' ? null : Number(v))

  // Tap-to-complete: toggling a set ON prefills the prescribed target into any
  // empty metric, so "did it as written" is one tap (TrainHeroic pattern).
  function toggleDone() {
    if (log.done) {
      onChange({ ...log, done: false })
      return
    }
    const next: SetLog = { ...log, done: true }
    if (trackingType === 'weight_reps' || trackingType === 'bodyweight_reps') {
      if (next.reps == null && prescribedReps != null) next.reps = prescribedReps
    } else if (trackingType === 'time') {
      if (next.duration == null && prescribedDuration != null) next.duration = prescribedDuration
    }
    onChange(next)
    onComplete()
  }

  const doneBtn = (
    <button
      type="button"
      className={`set-row__done${log.done ? ' set-row__done--checked' : ''}`}
      onClick={toggleDone}
      aria-label={log.done ? 'Mark set not done' : 'Complete set'}
    >
      {log.done && <Check size={14} strokeWidth={2.5} color="var(--signal)" />}
    </button>
  )

  // RPE cell — a tap-scale, not a keyboard (JuggernautAI). Shared by the loaded types.
  const rpeCell = (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="set-row__rpe"
        onClick={() => setRpeOpen((o) => !o)}
      >
        {log.rpe ?? 'RPE'}
      </button>
      {rpeOpen && (
        <div className="rpe-pop">
          {RPE_SCALE.map((v) => (
            <button
              key={v}
              type="button"
              className={`rpe-pop__btn${log.rpe === v ? ' rpe-pop__btn--on' : ''}`}
              onClick={() => { onChange({ ...log, rpe: v }); setRpeOpen(false) }}
            >
              {v}
            </button>
          ))}
          <button
            type="button"
            className="rpe-pop__btn rpe-pop__btn--clear"
            onClick={() => { onChange({ ...log, rpe: null }); setRpeOpen(false) }}
          >
            –
          </button>
        </div>
      )}
    </div>
  )

  const numInput = (
    value: number | null | undefined,
    placeholder: string,
    onVal: (n: number | null) => void,
    mode: 'decimal' | 'numeric' = 'numeric',
  ) => (
    <input
      className="set-row__input"
      type="number"
      inputMode={mode}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onVal(num(e.target.value))}
      onFocus={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); advanceField(e.currentTarget) } }}
    />
  )

  // Per-type column contents. Set number + done button are constant; the grid
  // template itself is shared with the header via gridFor().
  let cells: ReactNode

  if (trackingType === 'time') {
    cells = (
      <>
        {numInput(log.duration, 'sec', (n) => onChange({ ...log, duration: n }))}
        {rpeCell}
      </>
    )
  } else if (trackingType === 'distance') {
    cells = numInput(log.distance, distanceUnit, (n) => onChange({ ...log, distance: n }), 'decimal')
  } else if (trackingType === 'bodyweight_reps') {
    cells = (
      <>
        {numInput(log.reps, 'reps', (n) => onChange({ ...log, reps: n }))}
        {numInput(log.weight, `+${unit}`, (n) => onChange({ ...log, weight: n }), 'decimal')}
        {rpeCell}
      </>
    )
  } else {
    // weight_reps (default)
    cells = (
      <>
        {numInput(log.weight, unit, (n) => onChange({ ...log, weight: n }), 'decimal')}
        {numInput(log.reps, 'reps', (n) => onChange({ ...log, reps: n }))}
        {rpeCell}
      </>
    )
  }

  return (
    <div className={`set-row ${gridClass(trackingType)}`}>
      <span className="set-row__num">{setNum}</span>
      <span className="set-row__prev num">{prevText ?? '·'}</span>
      {cells}
      {doneBtn}
    </div>
  )
}

// ---- Per-exercise "felt" chips ---------------------------------------------

interface FeltChipsProps {
  value: FeltLabel | null
  note: string
  onFelt: (f: FeltLabel | null) => void
  onNote: (n: string) => void
}

function FeltChips({ value, note, onFelt, onNote }: FeltChipsProps) {
  return (
    <div className="felt">
      <div className="felt__row">
        <span className="felt__label">Felt</span>
        {FELT_CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            className={`felt__chip felt__chip--${c.tone}${value === c.label ? ' felt__chip--on' : ''}`}
            onClick={() => onFelt(value === c.label ? null : c.label)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {value && (
        <input
          className="input felt__note"
          type="text"
          placeholder="Add a note — e.g. weaker on the left side"
          value={note}
          onChange={(e) => onNote(e.target.value)}
        />
      )}
    </div>
  )
}

// ---- Pre-session readiness gate (JuggernautAI) -----------------------------

const READINESS_ROWS: Array<{ key: keyof Readiness; label: string }> = [
  { key: 'sleep',    label: 'Sleep' },
  { key: 'energy',   label: 'Energy' },
  { key: 'soreness', label: 'Soreness' },
]

function ReadinessGate({
  onStart, onSkip,
}: { onStart: (r: Readiness) => void; onSkip: () => void }) {
  const [r, setR] = useState<Readiness>({ sleep: null, energy: null, soreness: null })
  return (
    <div className="obs-sheet">
      <div className="obs-sheet__inner">
        <p className="section-header" style={{ marginBottom: 4 }}>Before you start</p>
        <p className="text-xs text-dim" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          A quick read on today — it tunes how I weigh what happens. All optional.
        </p>
        {READINESS_ROWS.map((row) => (
          <div key={row.key} className="readiness__row">
            <span className="readiness__label">{row.label}</span>
            <div className="readiness__scale">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`readiness__dot${r[row.key] === n ? ' readiness__dot--on' : ''}`}
                  onClick={() => setR((prev) => ({ ...prev, [row.key]: n }))}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button variant="ghost" style={{ flex: 1 }} onClick={onSkip}>Skip</Button>
          <Button variant="primary" style={{ flex: 2 }} onClick={() => onStart(r)}>Start session →</Button>
        </div>
      </div>
    </div>
  )
}

// ---- Session debrief sheet (the prose the agent mines) ---------------------

interface DebriefSheetProps {
  reading: { name: string; question: string } | null
  saving: boolean
  onSave: (reflection: string, readingAnswer: string) => void
  onSkip: () => void
}

function DebriefSheet({ reading, saving, onSave, onSkip }: DebriefSheetProps) {
  const [reflection, setReflection] = useState('')
  const [readingAnswer, setReadingAnswer] = useState('')
  return (
    <div className="obs-sheet">
      <div className="obs-sheet__inner">
        <p className="section-header" style={{ marginBottom: 4 }}>Debrief</p>
        <p className="text-xs text-dim" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          How did that go? Talk freely — I read the whole thing, not just the numbers.
        </p>

        {reading && (
          <div style={{ marginBottom: 14 }}>
            <p className="text-xs" style={{ color: 'var(--computing)', marginBottom: 6, lineHeight: 1.4 }}>
              {reading.question}
            </p>
            <input
              className="input"
              type="text"
              placeholder={`On ${reading.name}…`}
              value={readingAnswer}
              onChange={(e) => setReadingAnswer(e.target.value)}
            />
          </div>
        )}

        <textarea
          className="input"
          style={{ minHeight: 96, resize: 'none', lineHeight: 1.5 }}
          placeholder="Felt strong on the second set, knee was quiet, left side still lagging…"
          value={reflection}
          onChange={(e) => setReflection(e.target.value)}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button variant="ghost" style={{ flex: 1 }} onClick={onSkip} disabled={saving}>
            Skip
          </Button>
          <Button
            variant="primary"
            style={{ flex: 2 }}
            disabled={saving}
            onClick={() => onSave(reflection.trim(), readingAnswer.trim())}
          >
            {saving ? <Spinner /> : 'Log it →'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- main ------------------------------------------------------------------

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function newSetLog(setNum: number): SetLog {
  return { set: setNum, weight: null, reps: null, rpe: null, done: false, duration: null, distance: null }
}

// Short "what they actually did" summary per exercise, for the debrief agent.
function performedSummary(t: TrackingType, logs: SetLog[], unit: string, distanceUnit: string): string {
  const done = logs.filter((l) => l.done || l.reps != null || l.duration != null || l.distance != null)
  if (!done.length) return 'not logged'
  if (t === 'time') return done.map((l) => `${l.duration ?? '?'}s`).join(', ')
  if (t === 'distance') return done.map((l) => `${l.distance ?? '?'}${distanceUnit}`).join(', ')
  if (t === 'bodyweight_reps') return done.map((l) => `${l.reps ?? '?'}${l.weight ? `+${l.weight}${unit}` : ''}`).join(', ')
  return done.map((l) => `${l.reps ?? '?'}×${l.weight != null ? `${l.weight}${unit}` : 'BW'}`).join(', ')
}

export function WorkoutScreen() {
  const { routineId } = useParams<{ routineId: string }>()
  const navigate      = useNavigate()

  const unit = getWeightUnit()
  const distanceUnit = getDistanceUnit(unit)

  const [routine, setRoutine]     = useState<RoutineRow | null>(null)
  const [athleteId, setAthleteId] = useState<string | null>(null)
  const [athleteName, setAthleteName] = useState<string | null>(null)
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(null)
  const [loading, setLoading]     = useState(true)
  const [elapsed, setElapsed]     = useState(0)
  const [saving, setSaving]       = useState(false)
  const [showDebrief, setShowDebrief] = useState(false)
  const [savingDebrief, setSavingDebrief] = useState(false)
  const [workoutId, setWorkoutId] = useState<string | null>(null)

  // Readiness gate (shown once on open).
  const [showReadiness, setShowReadiness] = useState(true)
  const [readiness, setReadiness] = useState<Readiness | null>(null)

  // Per-exercise felt signal (exIdx → feedback).
  const [feedback, setFeedback] = useState<Record<number, ExerciseFeedback>>({})

  // Rest timer (epoch ms when rest ends, or null).
  const [restEndsAt, setRestEndsAt] = useState<number | null>(null)
  const [, setNowTick] = useState(0)

  // insight_id → insight, for the per-exercise "why" surface
  const [insightMap, setInsightMap] = useState<Record<string, InsightRow>>({})
  const [openInsight, setOpenInsight] = useState<InsightRow | null>(null)
  const [openReading, setOpenReading] = useState<{ name: string; why: string } | null>(null)

  const [setLogs, setSetLogs] = useState<Record<number, SetLog[]>>({})

  // Per-exercise prescription — last week's top set + the week's directive (§4.4).
  const [prescription, setPrescription] = useState<SessionPrescription | null>(null)

  // Last session's results per exercise index, for the desktop Previous column.
  const [prevByExercise, setPrevByExercise] = useState<Record<number, SetLog[]>>({})
  // Which exercise is in focus — drives the "why" panel in the desktop rail.
  const [activeExIdx, setActiveExIdx] = useState(0)

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

  // Rest-timer ticker — only runs while a rest is active.
  useEffect(() => {
    if (restEndsAt == null) return
    const id = setInterval(() => {
      setNowTick((t) => t + 1)
      if (Date.now() >= restEndsAt) setRestEndsAt(null)
    }, 250)
    return () => clearInterval(id)
  }, [restEndsAt])

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
      const exs = r.exercises as ExerciseTemplate[]
      const initial: Record<number, SetLog[]> = {}
      exs.forEach((ex, i) => {
        initial[i] = Array.from({ length: ex.sets }, (_, j) => newSetLog(j + 1))
      })
      setSetLogs(initial)

      // Most recent prior session of this same routine → the Previous column.
      // Same routine_id means the exercise list (and ordering) matches, so the
      // index keys line up with this session's exercises.
      const { data: prevWorkout } = await supabase
        .from('workout')
        .select('actual_weights')
        .eq('routine_id', routineId)
        .order('performed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const prevWeights = (prevWorkout as { actual_weights: Record<string, SetLog[]> | null } | null)?.actual_weights
      if (prevWeights) {
        const map: Record<number, SetLog[]> = {}
        Object.entries(prevWeights).forEach(([k, v]) => { map[Number(k)] = v })
        setPrevByExercise(map)
      }

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

      // Prescription hints — best-effort; the session loads regardless.
      if (programData && routineId) {
        try {
          const presc = await gatherSessionPrescription(programData.athlete_id, routineId, exs, unit)
          setPrescription(presc)
        } catch { /* non-fatal */ }
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

  function setFelt(exIdx: number, name: string, felt: FeltLabel | null) {
    setFeedback((prev) => ({ ...prev, [exIdx]: { name, felt, note: prev[exIdx]?.note ?? '' } }))
  }
  function setFeltNote(exIdx: number, name: string, note: string) {
    setFeedback((prev) => ({ ...prev, [exIdx]: { name, felt: prev[exIdx]?.felt ?? null, note } }))
  }

  const allSetsFlat = Object.values(setLogs).flat()
  const hasAnyLog = allSetsFlat.some(
    (s) => s.done || s.reps != null || s.duration != null || s.distance != null,
  )

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

    const rpeValues = allSetsFlat.filter((s) => s.rpe !== null).map((s) => s.rpe!)
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
    setRestEndsAt(null)
    setSaving(false)
    setShowDebrief(true)
  }

  async function handleDebrief(reflection: string, readingAnswer: string) {
    if (!workoutId || !athleteId || !routine) return
    setSavingDebrief(true)

    const exercises = routine.exercises as ExerciseTemplate[]
    const readingEx = exercises.find((e) => e.reading)

    // Build the debrief input from everything the session produced.
    const debriefExercises: DebriefInput['exercises'] = exercises.map((ex, i) => {
      const t = ex.tracking_type ?? resolveTrackingType(ex.name, ex.reps, ex.load)
      const fb = feedback[i]
      return {
        name: ex.name,
        felt: fb?.felt ?? null,
        note: fb?.note ?? '',
        prescribed: `${ex.sets}×${ex.reps}${ex.load ? ` ${ex.load}` : ''}`,
        performed: performedSummary(t, setLogs[i] ?? [], unit, distanceUnit),
      }
    })

    // 1. Load existing insights so the engine can decide update vs create.
    const { data: existingInsights } = await supabase
      .from('insight')
      .select('*')
      .eq('athlete_id', athleteId)
      .neq('status', 'resolved')
      .neq('status', 'disproved')

    // 2. Agent classifies the whole session → many bounded actions (or fallback).
    const debrief = await runSessionDebriefAgent(
      athleteId,
      workoutId,
      {
        reflection,
        readiness,
        exercises: debriefExercises,
        reading: readingEx
          ? { name: readingEx.name, question: readingEx.reading_why ?? '', answer: readingAnswer }
          : null,
      },
      (existingInsights as InsightRow[]) ?? [],
    )

    // 3. Persist the raw signal as append-only observation rows (durable record,
    //    independent of the agent). Severity must be 1–5.
    const obsRows: SessionObservationInsert[] = []
    for (const ex of debriefExercises) {
      if (!ex.felt) continue
      const sev = FELT_CHIPS.find((c) => c.label === ex.felt)?.severity ?? 2
      obsRows.push({
        workout_id: workoutId,
        category: 'Felt',
        signal: `${ex.name} — ${ex.felt}${ex.note ? ` — ${ex.note}` : ''}`,
        severity: sev,
      })
    }
    if (reflection) obsRows.push({ workout_id: workoutId, category: 'Reflection', signal: reflection, severity: 1 })
    if (readingAnswer && readingEx) {
      obsRows.push({ workout_id: workoutId, category: 'Reading', signal: `${readingEx.name} — ${readingAnswer}`, severity: 2 })
    }
    if (readiness && (readiness.sleep || readiness.energy || readiness.soreness)) {
      obsRows.push({
        workout_id: workoutId,
        category: 'Readiness',
        signal: `sleep ${readiness.sleep ?? '–'} · energy ${readiness.energy ?? '–'} · soreness ${readiness.soreness ?? '–'}`,
        severity: 1,
      })
    }
    if (obsRows.length) await supabase.from('session_observation').insert(obsRows)

    // 4. Execute each insight action; collect candidates and pick the most-moved
    //    insight for the reveal afterward (avoids closure-mutation narrowing).
    interface Move {
      movedInsightId: string | null
      category: string
      previousConfidence: number | null
      newConfidence: number | null
      isNew: boolean
      delta: number
    }
    const moves: Move[] = []

    for (const action of debrief.actions) {
      if (action.action === 'update' && action.existingInsightId) {
        const updatePayload: Record<string, unknown> = {
          confidence: action.updatedConfidence,
          evidence:   action.updatedEvidence,
        }
        if (action.updatedStatus) updatePayload.status = action.updatedStatus
        await supabase.from('insight').update(updatePayload).eq('id', action.existingInsightId)

        const prior = ((existingInsights as InsightRow[]) ?? []).find((i) => i.id === action.existingInsightId)
        moves.push({
          movedInsightId: action.existingInsightId,
          category: action.insightCategory,
          previousConfidence: prior?.confidence ?? null,
          newConfidence: action.updatedConfidence,
          isNew: false,
          delta: (action.updatedConfidence ?? 0) - (prior?.confidence ?? 0),
        })
      } else if (action.action === 'create' && action.newInsight) {
        const { data: created } = await supabase.from('insight').insert(action.newInsight).select().single()
        if (created) {
          moves.push({
            movedInsightId: (created as InsightRow).id,
            category: action.insightCategory,
            previousConfidence: null,
            newConfidence: (created as InsightRow).confidence,
            isNew: true,
            delta: 0.0001, // new signals rank below a real positive move, above nothing
          })
        }
      }
    }

    const best = moves.length
      ? moves.reduce((a, b) => (b.delta > a.delta ? b : a))
      : null

    setSavingDebrief(false)

    const movedCount = debrief.actions.length
    const primaryCategory = best?.category ?? 'Recovery'

    // 5. First session ever → the post-session revelation (Act 6). Else profile pulse.
    if (onboardingStep === 'first_session_pending') {
      await supabase.from('athlete').update({ onboarding_step: 'first_session_complete' }).eq('id', athleteId)
      navigate('/onboarding/revelation', {
        replace: true,
        state: {
          movedInsightId: best?.movedInsightId ?? null,
          category: primaryCategory,
          previousConfidence: best?.previousConfidence ?? null,
          newConfidence: best?.newConfidence ?? null,
          isNew: best?.isNew ?? true,
          movedCount,
          summary: debrief.summary,
          durationMins: Math.ceil(elapsed / 60),
          setsLogged: allSetsFlat.filter((s) => s.done).length,
          name: athleteName,
        },
      })
      return
    }

    navigate('/app/profile', { state: { pulsedCategory: primaryCategory }, replace: true })
  }

  async function handleDebriefSkip() {
    if (onboardingStep === 'first_session_pending' && athleteId) {
      await supabase.from('athlete').update({ onboarding_step: 'complete' }).eq('id', athleteId)
    }
    navigate('/app/today', { replace: true })
  }

  // ---- loading / error ------------------------------------------------------

  if (loading) {
    return <div className="screen--centered"><Spinner /></div>
  }
  if (!routine) {
    return (
      <div className="screen--centered">
        <p className="text-dim">Session not found.</p>
        <Button variant="ghost" onClick={() => navigate('/app/today')} style={{ marginTop: 16 }}>Back</Button>
      </div>
    )
  }

  const exercises = routine.exercises as ExerciseTemplate[]
  const readingEx = exercises.find((e) => e.reading)

  const setsTotal = allSetsFlat.length
  const setsDone  = allSetsFlat.filter((s) => s.done).length
  const rpeLive   = allSetsFlat.filter((s) => s.rpe !== null).map((s) => s.rpe!)
  const avgRpeLive = rpeLive.length ? Math.round(rpeLive.reduce((a, b) => a + b, 0) / rpeLive.length) : null

  const workoutStripItems: Array<{ label: string; value: string | number }> = [
    { label: 'WORKOUT', value: routine.name },
    { label: 'ELAPSED', value: formatElapsed(elapsed) },
    { label: 'SETS', value: `${setsDone}/${setsTotal}` },
  ]
  if (avgRpeLive !== null) workoutStripItems.push({ label: 'RPE', value: avgRpeLive })

  const restLeft = restEndsAt ? Math.max(0, Math.ceil((restEndsAt - Date.now()) / 1000)) : 0

  // Desktop rail context: the exercise whose field was last focused.
  const activeEx = exercises[activeExIdx]
  const activeInsight = activeEx?.insight_id ? insightMap[activeEx.insight_id] : undefined

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div
        style={{
          display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--line)',
          position: 'sticky', top: 0, background: 'var(--ground)', zIndex: 10,
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

      {/* Exercise list (left) + desktop context rail (right) */}
      <div className="workout-panes">
       <div className="workout-list">
        <div className="workout-col">
        {exercises.map((ex, exIdx) => {
          const logs = setLogs[exIdx] ?? []
          const trackingType = ex.tracking_type ?? resolveTrackingType(ex.name, ex.reps, ex.load)
          const pReps = leadingInt(ex.reps)
          const pDur  = trackingType === 'time' ? leadingInt(ex.reps) : null

          return (
            <div key={exIdx} style={{ paddingTop: 20, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
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
                  <p className="text-xs text-dim" style={{ marginTop: 3, lineHeight: 1.5 }}>{ex.cue}</p>
                )}
                {prescription?.hints[exIdx] && (
                  <p
                    className="num text-xs text-signal"
                    style={{ marginTop: 4, letterSpacing: '0.02em' }}
                  >
                    {prescription.hints[exIdx]}
                  </p>
                )}
              </div>

              <SetHeader
                trackingType={trackingType}
                unit={unit}
                distanceUnit={distanceUnit}
                prescribedReps={ex.reps}
                prescribedLoad={ex.load ?? null}
              />

              {logs.map((log, setIdx) => (
                <SetRow
                  key={setIdx}
                  setNum={setIdx + 1}
                  log={log}
                  trackingType={trackingType}
                  unit={unit}
                  distanceUnit={distanceUnit}
                  prescribedReps={pReps}
                  prescribedDuration={pDur}
                  prevText={formatPrev(trackingType, (prevByExercise[exIdx] ?? [])[setIdx], unit, distanceUnit)}
                  onChange={(updated) => handleSetChange(exIdx, setIdx, updated)}
                  onComplete={() => setRestEndsAt(Date.now() + REST_SECONDS * 1000)}
                  onActivate={() => setActiveExIdx(exIdx)}
                />
              ))}

              <button
                type="button"
                className="btn btn--ghost"
                style={{ marginTop: 8, height: 44, fontSize: 13, padding: '0 8px', color: 'var(--text-dim)' }}
                onClick={() => addSet(exIdx)}
              >
                <Plus size={12} strokeWidth={2} style={{ marginRight: 4 }} />
                Add set
              </button>

              <FeltChips
                value={feedback[exIdx]?.felt ?? null}
                note={feedback[exIdx]?.note ?? ''}
                onFelt={(f) => setFelt(exIdx, ex.name, f)}
                onNote={(n) => setFeltNote(exIdx, ex.name, n)}
              />
            </div>
          )
        })}
        </div>
       </div>

       {/* Desktop-only context rail: live rest clock + why-this-exercise.
           Hidden under the breakpoint, where these stay as the pill + sheet. */}
       <aside className="workout-rail">
         <div className="rail__block">
           <p className="rail__head">Rest</p>
           {restEndsAt != null && restLeft > 0 ? (
             <>
               <p className="num rail__timer">{formatElapsed(restLeft)}</p>
               <button
                 type="button"
                 className="btn btn--ghost"
                 style={{ height: 32, fontSize: 12, padding: '0 8px', color: 'var(--text-dim)' }}
                 onClick={() => setRestEndsAt(null)}
               >
                 Skip rest
               </button>
             </>
           ) : (
             <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
               Idle. Completing a set starts the {REST_SECONDS}s clock.
             </p>
           )}
         </div>

         {activeEx && (
           <div className="rail__block">
             <p className="rail__head">Why this</p>
             <p className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{activeEx.name}</p>
             {activeEx.cue && (
               <p className="text-xs text-dim" style={{ lineHeight: 1.5, marginBottom: activeInsight ? 10 : 0 }}>
                 {activeEx.cue}
               </p>
             )}
             {activeInsight ? (
               <p className="text-sm" style={{ lineHeight: 1.5 }}>{activeInsight.claim}</p>
             ) : !activeEx.cue ? (
               <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
                 Tap into a set to see the read on that lift.
               </p>
             ) : null}
           </div>
         )}
       </aside>
      </div>

      {/* Rest timer pill (mobile; desktop surfaces it in the rail instead) */}
      {restEndsAt != null && restLeft > 0 && (
        <button type="button" className="rest-pill" onClick={() => setRestEndsAt(null)}>
          <span className="rest-pill__label">REST</span>
          <span className="num rest-pill__time">{formatElapsed(restLeft)}</span>
          <X size={13} strokeWidth={2} />
        </button>
      )}

      {/* Bottom complete bar */}
      <div
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px',
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          background: 'var(--ground)', borderTop: '1px solid var(--line)',
        }}
      >
        <div className="workout-footer__inner">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div>
              <span className="text-xs text-dim">Duration  </span>
              <span className="num text-xs">{formatElapsed(elapsed)}</span>
            </div>
            <div>
              <span className="text-xs text-dim">Sets logged  </span>
              <span className="num text-xs">{setsDone}</span>
            </div>
          </div>
          <Button variant="primary" full onClick={handleCompleteWorkout} disabled={saving || !hasAnyLog}>
            {saving ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Spinner /> Saving…</span>
            ) : 'Complete workout →'}
          </Button>
        </div>
      </div>

      {/* Pre-session readiness gate */}
      {showReadiness && (
        <ReadinessGate
          onStart={(r) => { setReadiness(r); setShowReadiness(false) }}
          onSkip={() => setShowReadiness(false)}
        />
      )}

      {/* Debrief sheet (post-save) */}
      {showDebrief && (
        <DebriefSheet
          reading={readingEx ? { name: readingEx.name, question: readingEx.reading_why ?? 'How did the read item feel?' } : null}
          saving={savingDebrief}
          onSave={handleDebrief}
          onSkip={handleDebriefSkip}
        />
      )}

      {/* Exercise "why" sheet */}
      {openInsight && <ExerciseInsightSheet insight={openInsight} onClose={() => setOpenInsight(null)} />}

      {openReading && (
        <div className="obs-sheet" onClick={() => setOpenReading(null)}>
          <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
            <p className="section-header" style={{ color: 'var(--computing)', marginBottom: 10 }}>
              READING · {openReading.name}
            </p>
            <p className="text-sm" style={{ lineHeight: 1.5, marginBottom: 12 }}>{openReading.why}</p>
            <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
              How this one goes feeds the read — no need to score it, just train it honestly.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
