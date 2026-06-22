import { useEffect, useState, useRef, useCallback, type ReactNode } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Check, Plus, Info, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import {
  restoreDraft, saveDraftLocal, saveDraftRemote, clearDraft, type DraftPayload,
} from '../../lib/workoutDraft'
import { enqueueSession, commitPending } from '../../lib/workoutOutbox'
import {
  gatherSessionPrescription,
  type SessionPrescription, type PendingSession, type PendingDebrief, type DebriefExerciseInput,
} from '../../engine'
import { resolveTrackingType } from '../../engine/exerciseLibrary'
import { getWeightUnit, getDistanceUnit } from '../../lib/units'
import {
  Button, Spinner, ExerciseInsightSheet, TelemetryStrip,
} from '../../components/ui'
import type {
  RoutineRow, ExerciseTemplate, SetLog, InsightRow, TrackingType,
  OnboardingStep, FeltLabel, ExerciseFeedback,
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
      <textarea
        className="input felt__note"
        rows={2}
        placeholder="Note for coach — e.g. weaker on the left side, shoulder twinge on set 3"
        value={note}
        onChange={(e) => onNote(e.target.value)}
      />
    </div>
  )
}

// ---- "Why this session" brief — the coach's pep talk before you train --------
// Replaces the old readiness questionnaire: instead of asking for input at the
// door, the coach explains, in voice, why today looks the way it does. Composed
// deterministically from real data (the read, the prescription, the planted
// check-in) so it's instant — no model latency at the start of a session.

function sessionBriefLines(opts: {
  routine: RoutineRow
  primaryInsight: InsightRow | null
  leadExercise: ExerciseTemplate | undefined
  readingWhy: string | null
  isFirst: boolean
}): string[] {
  const { routine, primaryInsight, leadExercise, readingWhy, isFirst } = opts
  const lines: string[] = []
  const opener = isFirst ? 'Your first real session. ' : ''

  // 1. The read this session is built around.
  if (primaryInsight) {
    const pct = Math.round(primaryInsight.confidence * 100)
    lines.push(
      `${opener}I built this around your ${primaryInsight.category.toLowerCase()} — ${pct}% confident, ${primaryInsight.status}. It's the read I'm watching closest, so it's where the training teaches us the most.`,
    )
  } else if (routine.intent) {
    lines.push(`${opener}${routine.intent}`)
  } else if (opener) {
    lines.push(opener.trim())
  }

  // 2. The working half — what the opener actually is.
  if (leadExercise) {
    const working = leadExercise.load === 'moderate' || leadExercise.sets >= 4
    lines.push(
      working
        ? `Open with ${leadExercise.name} — real working sets, not a warm-up. Own the pattern, then we keep loading it.`
        : `Open with ${leadExercise.name} — controlled and clean. We earn the pattern before we pile on load.`,
    )
  }

  // 3. The diagnostic half — the planted read, already written in voice.
  if (readingWhy) lines.push(readingWhy)

  // 4. The close — what makes today count.
  lines.push(
    isFirst
      ? `At the end I'll ask how it went — that's what turns today into a read.`
      : `Log how it felt at the end — honest signal is what moves the read.`,
  )

  return lines
}

function SessionBrief({
  lines, ctaLabel, onClose,
}: { lines: string[]; ctaLabel: string; onClose: () => void }) {
  return (
    <div className="obs-sheet" onClick={onClose}>
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <p className="section-header" style={{ color: 'var(--computing)', marginBottom: 4 }}>Why this session</p>
        <p className="text-xs text-dim" style={{ marginBottom: 14, lineHeight: 1.5 }}>
          The thinking behind today — read it or jump straight in.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lines.map((l, i) => (
            <p key={i} className="text-sm" style={{ lineHeight: 1.55 }}>{l}</p>
          ))}
        </div>
        <Button variant="primary" full style={{ marginTop: 18 }} onClick={onClose}>{ctaLabel}</Button>
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

// <input type="date"> wants local yyyy-mm-dd; we anchor the stored timestamp at
// local noon so the day never slips across a timezone boundary.
function toDateInput(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function dateInputToISO(s: string): string {
  return new Date(`${s}T12:00:00`).toISOString()
}

// A set counts as "logged" once it carries any real signal — the trigger for
// autosaving the draft (so we never persist an untouched, empty session).
function isLogged(s: SetLog): boolean {
  return s.done || s.reps != null || s.duration != null || s.distance != null
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
  const [searchParams] = useSearchParams()
  // ?w=<id> → editing an already-logged session (re-runs the coach on save).
  const editWorkoutId = searchParams.get('w')
  const isEdit = !!editWorkoutId

  const unit = getWeightUnit()
  const distanceUnit = getDistanceUnit(unit)

  // The day the session happened — defaults to today, editable so a forgotten
  // session can be backdated. Stored as a yyyy-mm-dd input string.
  const [performedAt, setPerformedAt] = useState<string>(() => toDateInput(new Date()))

  const [routine, setRoutine]     = useState<RoutineRow | null>(null)
  const [athleteId, setAthleteId] = useState<string | null>(null)
  const [athleteName, setAthleteName] = useState<string | null>(null)
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(null)
  const [loading, setLoading]     = useState(true)
  const [elapsed, setElapsed]     = useState(0)
  const [showDebrief, setShowDebrief] = useState(false)
  const [savingDebrief, setSavingDebrief] = useState(false)
  // Elapsed frozen at the moment "Complete" was tapped — the debrief sheet can
  // sit open for a while, so the committed duration is this, not the live clock.
  const finalElapsedRef = useRef(0)

  // "Why this session" brief — auto-shown on open (the slot the readiness gate
  // used to hold), re-openable any time from the header.
  const [briefOpen, setBriefOpen] = useState(true)
  const [hasStarted, setHasStarted] = useState(false)

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

  // Draft persistence (§ start/stop/continue). draftReady gates autosave until a
  // restore attempt has run, so we never clobber a saved session with empty state.
  // sessionStartRef is the real session start (the week-window anchor); payloadRef
  // always mirrors current state so the flush handlers can read it cheaply.
  const [draftReady, setDraftReady] = useState(false)
  const sessionStartRef = useRef<string>(new Date().toISOString())
  const payloadRef = useRef<DraftPayload | null>(null)
  const completedRef = useRef(false)   // true once promoted to a workout → stop persisting

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

  // ---- draft autosave (start / stop / continue) -----------------------------

  // Keep a live snapshot of the session for the flush handlers. elapsed ticks
  // every second; reading it here (not in the save effects) keeps the debounce
  // from being reset by the clock.
  useEffect(() => {
    payloadRef.current = {
      setLogs, feedback, elapsedSeconds: elapsed, startedAt: sessionStartRef.current,
    }
  }, [setLogs, feedback, elapsed])

  const hasDraftSignal = () =>
    !!payloadRef.current && Object.values(payloadRef.current.setLogs).flat().some(isLogged)

  const persistLocal = useCallback(() => {
    if (!routineId || !draftReady || completedRef.current || !hasDraftSignal()) return
    saveDraftLocal(routineId, payloadRef.current!)
  }, [routineId, draftReady])

  const persistRemote = useCallback(() => {
    if (!routineId || !athleteId || !draftReady || completedRef.current || !hasDraftSignal()) return
    void saveDraftRemote(athleteId, routineId, payloadRef.current!).catch(() => { /* offline — local covers it */ })
  }, [routineId, athleteId, draftReady])

  // Content changes (a set logged, a felt chip) → save locally at once, mirror to
  // Supabase on a short debounce so rapid entry coalesces into one write.
  useEffect(() => {
    if (!draftReady) return
    persistLocal()
    const t = setTimeout(persistRemote, 2500)
    return () => clearTimeout(t)
  }, [setLogs, feedback, draftReady, persistLocal, persistRemote])

  // A periodic mirror so the elapsed clock (and anything mid-debounce) reaches the
  // server even during a long, edit-free stretch.
  useEffect(() => {
    if (!draftReady) return
    const id = setInterval(persistRemote, 20000)
    return () => clearInterval(id)
  }, [draftReady, persistRemote])

  // Backgrounding / leaving the page (the Coach-chat detour, a reload, iOS
  // suspending the PWA) → flush both tiers immediately.
  useEffect(() => {
    const flush = () => { persistLocal(); persistRemote() }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
      // Unmount (e.g. navigating to nuvo) is itself a "leave" — capture it.
      flush()
    }
  }, [persistLocal, persistRemote])

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

      if (isEdit && editWorkoutId) {
        // Editing a logged session: hydrate from the workout row, not a draft.
        // No autosave (completedRef), no brief — straight into the numbers.
        completedRef.current = true
        const { data: w } = await supabase
          .from('workout')
          .select('actual_weights, duration_mins, performed_at')
          .eq('id', editWorkoutId)
          .maybeSingle()
        const aw = (w as { actual_weights: Record<string, SetLog[]> | null } | null)?.actual_weights
        if (aw) {
          const merged: Record<number, SetLog[]> = { ...initial }
          Object.entries(aw).forEach(([k, v]) => { if (v && v.length) merged[Number(k)] = v })
          setSetLogs(merged)
        }
        const dur = (w as { duration_mins: number | null } | null)?.duration_mins ?? 0
        setElapsed(dur * 60)
        startRef.current = Date.now() - dur * 60 * 1000
        const performed = (w as { performed_at: string | null } | null)?.performed_at
        if (performed) setPerformedAt(toDateInput(new Date(performed)))
        setHasStarted(true)
        setBriefOpen(false)
      } else if (programData && routineId) {
        // Resume an in-progress session if one was autosaved this week. We overlay
        // the draft onto the fresh template by exercise index, so a routine that has
        // since gained/lost an exercise still loads cleanly. The timer continues
        // from the saved elapsed (true stop/continue — time away isn't counted).
        const draft = await restoreDraft(programData.athlete_id, routineId)
        if (draft) {
          const merged: Record<number, SetLog[]> = { ...initial }
          Object.entries(draft.setLogs).forEach(([k, v]) => { if (v && v.length) merged[Number(k)] = v })
          setSetLogs(merged)
          setFeedback((draft.feedback ?? {}) as Record<number, ExerciseFeedback>)
          setElapsed(draft.elapsedSeconds)
          startRef.current = Date.now() - draft.elapsedSeconds * 1000
          sessionStartRef.current = draft.startedAt
          setHasStarted(true)
          setBriefOpen(false)   // resuming → drop straight back into training
        }
      }
      setDraftReady(true)
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
  const hasAnyLog = allSetsFlat.some(isLogged)

  // "Complete" no longer writes — it freezes the clock and opens the debrief.
  // The actual server commit happens at finishSession (after debrief or skip), so
  // the whole session, debrief included, lands in one durable, replayable unit.
  function handleCompleteWorkout() {
    if (!routine) return
    if (timerRef.current) clearInterval(timerRef.current)
    finalElapsedRef.current = elapsed
    completedRef.current = true   // stop draft autosave; the outbox owns it now
    setRestEndsAt(null)
    setShowDebrief(true)
  }

  // Assemble the workout numbers + (optional) debrief into a replayable unit.
  function buildPending(debrief: PendingDebrief | null): PendingSession {
    const actualWeights: Record<string, SetLog[]> = {}
    const actualReps: Record<string, number[]>    = {}
    Object.entries(setLogs).forEach(([idx, logs]) => {
      actualWeights[idx] = logs
      actualReps[idx]    = logs.map((l) => l.reps ?? 0)
    })
    const rpeValues = allSetsFlat.filter((s) => s.rpe !== null).map((s) => s.rpe!)
    const avgRpe    = rpeValues.length ? Math.round(rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) : null

    const onboardingTransition =
      onboardingStep === 'first_session_pending'
        ? (debrief ? 'first_session_complete' : 'complete')
        : null

    return {
      id: crypto.randomUUID(),
      athleteId: athleteId!,
      routineId: routineId!,
      actualWeights,
      actualReps,
      rpe: avgRpe,
      durationMins: Math.ceil(finalElapsedRef.current / 60),
      setsDone: allSetsFlat.filter((s) => s.done).length,
      athleteName,
      onboardingTransition: isEdit ? null : onboardingTransition,
      debrief,
      editWorkoutId: isEdit ? editWorkoutId : null,
      performedAt: dateInputToISO(performedAt),
      queuedAt: new Date().toISOString(),
    }
  }

  // Build the debrief payload from the per-exercise feedback + performed numbers.
  function buildDebrief(reflection: string, readingAnswer: string): PendingDebrief {
    const exercises = (routine!.exercises as ExerciseTemplate[])
    const readingEx = exercises.find((e) => e.reading)
    const debriefExercises: DebriefExerciseInput[] = exercises.map((ex, i) => {
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
    return {
      reflection,
      readingAnswer,
      exercises: debriefExercises,
      reading: readingEx ? { name: readingEx.name, readingWhy: readingEx.reading_why ?? '' } : null,
    }
  }

  // The single finish path: enqueue durably, drop the draft, then try to commit
  // right now. Online → we get the reveal data back and route to it. Offline →
  // the commit throws, the session stays queued, and the outbox syncs it (AI
  // debrief included) the moment the connection returns.
  async function finishSession(debrief: PendingDebrief | null) {
    if (!athleteId || !routine) return
    setSavingDebrief(true)

    const pending = buildPending(debrief)
    enqueueSession(pending)                       // durable before any network
    if (!isEdit) clearDraft(athleteId, routineId!) // the outbox is its home now

    let result
    try {
      result = await commitPending(pending)
    } catch {
      result = null                                // offline / failed — stays queued
    }
    setSavingDebrief(false)

    // Editing an existing session → back to Today (no revelation / pulse).
    if (isEdit) {
      navigate('/app/today', { replace: true, state: { queuedOffline: result === null } })
      return
    }

    if (result && result.firstSession) {
      navigate('/onboarding/revelation', {
        replace: true,
        state: {
          movedInsightId: result.best?.movedInsightId ?? null,
          category: result.best?.category ?? 'Recovery',
          previousConfidence: result.best?.previousConfidence ?? null,
          newConfidence: result.best?.newConfidence ?? null,
          isNew: result.best?.isNew ?? true,
          movedCount: result.movedCount,
          summary: result.summary,
          durationMins: result.durationMins,
          setsLogged: result.setsDone,
          name: result.athleteName,
        },
      })
      return
    }

    if (result && debrief) {
      navigate('/app/profile', { state: { pulsedCategory: result.best?.category ?? 'Recovery' }, replace: true })
      return
    }

    // Skipped debrief (committed or not), or an offline finish → back to Today.
    // queuedOffline tells Today to show the "will sync" note.
    navigate('/app/today', { replace: true, state: { queuedOffline: result === null } })
  }

  function handleDebrief(reflection: string, readingAnswer: string) {
    if (!routine) return
    void finishSession(buildDebrief(reflection, readingAnswer))
  }

  // Skipping still re-runs the coach on an edit (the chosen behaviour: every edit
  // re-reads the session), just with no fresh reflection text. A brand-new
  // session skips the debrief entirely (workout numbers only).
  function handleDebriefSkip() {
    if (!routine) return
    void finishSession(isEdit ? buildDebrief('', '') : null)
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

  // The read this session is built around — the insight the most exercises point
  // at, for the "why this session" brief.
  const primaryInsight =
    exercises.map((e) => (e.insight_id ? insightMap[e.insight_id] : undefined)).find(Boolean) ?? null
  const isFirstSession = onboardingStep === 'first_session_pending'
  const briefLines = sessionBriefLines({
    routine,
    primaryInsight,
    leadExercise: exercises[0],
    readingWhy: readingEx?.reading_why ?? null,
    isFirst: isFirstSession,
  })
  const briefCta = hasStarted
    ? 'Back to training →'
    : isFirstSession ? 'Start training →' : 'Start session →'

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
          // Workout is a full-screen route (no app-shell), so it reserves the
          // status-bar inset itself — the ground-filled padding sits behind the
          // translucent bar while the controls clear it.
          paddingTop: 'env(safe-area-inset-top, 0px)',
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
        <button
          type="button"
          className="btn btn--ghost"
          style={{ padding: '0 10px', height: 28, fontSize: 12, color: 'var(--computing)', whiteSpace: 'nowrap' }}
          onClick={() => setBriefOpen(true)}
          aria-label="Why this session"
        >
          <Info size={13} strokeWidth={2} style={{ marginRight: 4 }} /> Why
        </button>
      </div>

      {/* Exercise list (left) + desktop context rail (right) */}
      <div className="workout-panes">
       <div className="workout-list">
        <div className="workout-col">
        {/* Intelligence Rule in effect — stated out loud (the felt difference) */}
        {prescription?.rule && (
          <div
            style={{
              marginTop: 16, padding: '12px 14px', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--signal)',
            }}
          >
            <p className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
              RULE · {prescription.rule.name}
            </p>
            <p className="text-sm" style={{ lineHeight: 1.5 }}>{prescription.rule.reasoning}</p>
          </div>
        )}

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
                    className="num text-xs"
                    style={{
                      marginTop: 4, letterSpacing: '0.02em',
                      color: prescription.held[exIdx] ? 'var(--pending)' : 'var(--signal)',
                    }}
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="text-xs text-dim">Day</span>
              <input
                type="date"
                className="num text-xs"
                value={performedAt}
                max={toDateInput(new Date())}
                onChange={(e) => setPerformedAt(e.target.value || toDateInput(new Date()))}
                style={{
                  background: 'transparent', border: '1px solid var(--line)', borderRadius: 6,
                  color: 'var(--text)', padding: '2px 6px', fontSize: 12,
                }}
              />
            </label>
            <div>
              <span className="text-xs text-dim">Sets  </span>
              <span className="num text-xs">{setsDone}</span>
            </div>
          </div>
          <Button variant="primary" full onClick={handleCompleteWorkout} disabled={!hasAnyLog}>
            {isEdit ? 'Save changes →' : 'Complete workout →'}
          </Button>
        </div>
      </div>

      {/* "Why this session" brief — the coach's pep talk, shown on open */}
      {briefOpen && (
        <SessionBrief
          lines={briefLines}
          ctaLabel={briefCta}
          onClose={() => { setBriefOpen(false); setHasStarted(true) }}
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
