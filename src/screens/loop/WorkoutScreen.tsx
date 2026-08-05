import { useEffect, useState, useRef, useCallback, type ReactNode } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Check, Plus, Info, X, MessageCircle } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import {
  restoreDraft, loadDraftLocal, saveDraftLocal, saveDraftRemote, clearDraft, type DraftPayload,
} from '../../lib/workoutDraft'
import { loadCache, saveCache, useCachedLoader } from '../../lib/cache'
import { workoutBootKey, type WorkoutBootstrap } from '../../lib/workoutBoot'
import { invalidateLoopViews, cacheKeys } from '../../lib/loopCache'
import {
  enqueueSession, commitPending, parsePendingRef, pendingSessionById, committedWorkoutIdFor,
} from '../../lib/workoutOutbox'
import {
  gatherSessionPrescription, actualsFromPending, coachStarterPrompts, runCoachChat,
  type SessionPrescription, type SessionActuals,
  type PendingSession, type PendingDebrief, type DebriefExerciseInput,
} from '../../engine'
import { resolveTrackingType } from '../../engine/exerciseLibrary'
import { getCoachingNote, type CoachingNote } from '../../engine/coachingNotes'
import { getWeightUnit, getDistanceUnit } from '../../lib/units'
import { fetchCoachView } from './CoachScreen'
import type { CoachChatTurn } from '../../engine/agentClient'
import {
  Button, Spinner, Sheet, Chip, Markdown, ChatComposer, TypingDots,
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
// On the last field, blur instead so the keyboard dismisses naturally.
function advanceField(el: EventTarget & HTMLInputElement) {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.set-row__input'))
  const i = inputs.indexOf(el)
  if (i >= 0 && i + 1 < inputs.length) inputs[i + 1].focus()
  else el.blur()
}

// ---- Column header (prescribed target as a labelled column) ----------------

interface SetHeaderProps {
  trackingType: TrackingType
  unit: string
  distanceUnit: string
  prescribedReps: string         // raw prescription, e.g. "8-10" or "30s"
  prescribedLoad: string | null  // raw load, e.g. "225 lbs" or "bodyweight"
}

// A column label with the prescribed target under it. Columns with no
// prescription (RPE) get an invisible target line rather than an em-dash: the
// dash read as a value you were somehow failing to hit, and dropping the line
// entirely bottom-aligned the RPE label out of step with the others.
function headCell(label: string, target: string | null) {
  return (
    <div className="set-head__cell">
      <span className="set-head__label">{label}</span>
      <span className="set-head__target" aria-hidden={!target}>{target || '\u00A0'}</span>
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

// Numeric metric fields that the check-to-complete autofill can touch.
type MetricField = 'weight' | 'reps' | 'rpe' | 'duration' | 'distance'

interface SetRowProps {
  setNum: number
  log: SetLog
  trackingType: TrackingType
  unit: string
  distanceUnit: string
  prescribedReps: number | null
  prescribedDuration: number | null
  prescribedLoad: number | null   // parsed prescribed weight, e.g. "225 lbs" → 225
  carry: Partial<SetLog>          // values to carry forward (prev set this/last session)
  prevText: string | null  // last session's result for this set (desktop column)
  onChange: (updated: SetLog) => void
  onComplete: () => void   // fires when a set is newly marked done (→ rest timer)
  onActivate: () => void   // a field here was focused → drives the desktop rail
}

function SetRow({
  setNum, log, trackingType, unit, distanceUnit,
  prescribedReps, prescribedDuration, prescribedLoad, carry,
  prevText, onChange, onComplete, onActivate,
}: SetRowProps) {
  const [rpeOpen, setRpeOpen] = useState(false)
  const rpeRef = useRef<HTMLDivElement>(null)

  // Dismiss the RPE popover on any interaction outside it — tapping
  // elsewhere in the set row shouldn't leave it hanging open.
  useEffect(() => {
    if (!rpeOpen) return
    function onOutside(e: PointerEvent) {
      if (!rpeRef.current?.contains(e.target as Node)) setRpeOpen(false)
    }
    document.addEventListener('pointerdown', onOutside)
    return () => document.removeEventListener('pointerdown', onOutside)
  }, [rpeOpen])

  // Which fields *this row's* check auto-filled — so un-checking can revert
  // exactly those, while anything the athlete typed by hand is left alone.
  const [autofilled, setAutofilled] = useState<MetricField[]>([])

  const num = (v: string) => (v === '' ? null : Number(v))

  // Any manual edit means the athlete owns that field now: drop it from the
  // autofill set so a later un-check won't wipe their number.
  function setField(field: MetricField, value: number | null) {
    setAutofilled((a) => (a.includes(field) ? a.filter((f) => f !== field) : a))
    onChange({ ...log, [field]: value })
  }

  // Tap-to-complete: toggling a set ON carries the previous set's numbers into
  // any empty metric — weight, reps and RPE — so repeating a load (25 lb every
  // set) is one tap, not a retype. Where there's nothing to carry we fall back
  // to the prescription. Un-checking reverts only what we filled.
  function toggleDone() {
    if (log.done) {
      const reverted: SetLog = { ...log, done: false }
      autofilled.forEach((f) => { reverted[f] = null })
      setAutofilled([])
      onChange(reverted)
      return
    }
    const next: SetLog = { ...log, done: true }
    const filled: MetricField[] = []
    const fill = (field: MetricField, value: number | null | undefined) => {
      if (value != null && next[field] == null) { next[field] = value; filled.push(field) }
    }
    if (trackingType === 'weight_reps') {
      fill('weight', carry.weight ?? prescribedLoad)
      fill('reps', carry.reps ?? prescribedReps)
      fill('rpe', carry.rpe)
    } else if (trackingType === 'bodyweight_reps') {
      fill('reps', carry.reps ?? prescribedReps)
      fill('weight', carry.weight)
      fill('rpe', carry.rpe)
    } else if (trackingType === 'time') {
      fill('duration', carry.duration ?? prescribedDuration)
      fill('rpe', carry.rpe)
    } else if (trackingType === 'distance') {
      fill('distance', carry.distance)
    }
    setAutofilled(filled)
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
      {log.done && <Check size={22} strokeWidth={2.5} color="var(--signal)" />}
    </button>
  )

  // RPE cell — a tap-scale, not a keyboard (JuggernautAI). Shared by the loaded types.
  const rpeCell = (
    <div style={{ position: 'relative' }} ref={rpeRef}>
      <button
        type="button"
        className="set-row__rpe"
        onClick={() => setRpeOpen((o) => !o)}
      >
        {log.rpe ?? 'RPE'}
      </button>
      {rpeOpen && (
        <div className="rpe-pop">
          <span className="rpe-pop__label">RPE — how hard?</span>
          <div className="rpe-pop__scale">
            {RPE_SCALE.map((v) => (
              <button
                key={v}
                type="button"
                className={`rpe-pop__btn${log.rpe === v ? ' rpe-pop__btn--on' : ''}`}
                onClick={() => { setField('rpe', v); setRpeOpen(false) }}
              >
                {v}
              </button>
            ))}
            <button
              type="button"
              className="rpe-pop__btn rpe-pop__btn--clear"
              onClick={() => { setField('rpe', null); setRpeOpen(false) }}
            >
              –
            </button>
          </div>
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
      enterKeyHint="next"
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
        {numInput(log.duration, 'sec', (n) => setField('duration', n))}
        {rpeCell}
      </>
    )
  } else if (trackingType === 'distance') {
    cells = numInput(log.distance, distanceUnit, (n) => setField('distance', n), 'decimal')
  } else if (trackingType === 'bodyweight_reps') {
    cells = (
      <>
        {numInput(log.reps, 'reps', (n) => setField('reps', n))}
        {numInput(log.weight, `+${unit}`, (n) => setField('weight', n), 'decimal')}
        {rpeCell}
      </>
    )
  } else {
    // weight_reps (default)
    cells = (
      <>
        {numInput(log.weight, unit, (n) => setField('weight', n), 'decimal')}
        {numInput(log.reps, 'reps', (n) => setField('reps', n))}
        {rpeCell}
      </>
    )
  }

  return (
    <div className={`set-row ${gridClass(trackingType)}${log.done ? ' set-row--done' : ''}`}>
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

// The note field is folded away until it's wanted. With seven exercises on a
// screen, seven always-open textareas were most of the page's height and most
// of its visual noise — for a field almost nobody fills in mid-session.
function FeltChips({ value, note, onFelt, onNote }: FeltChipsProps) {
  const [noteOpen, setNoteOpen] = useState(() => note.trim().length > 0)
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

      {noteOpen ? (
        <textarea
          className="input felt__note"
          rows={2}
          autoFocus={!note}
          placeholder="Anything the coach should know?"
          value={note}
          onChange={(e) => onNote(e.target.value)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setNoteOpen(true)}
          style={{
            marginTop: 10, minHeight: 40, padding: 0, background: 'none', border: 'none',
            color: 'var(--text-dim)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
          }}
        >
          + Add a note
        </button>
      )}
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

  // 1. The read this session is built around. One sentence, not three.
  if (primaryInsight) {
    const pct = Math.round(primaryInsight.confidence * 100)
    lines.push(
      `Built around your ${primaryInsight.category.toLowerCase()} — ${pct}% confident. It's the read I'm watching closest.`,
    )
  } else if (routine.intent) {
    lines.push(routine.intent)
  }

  // 2. The working half — what the opener actually is.
  if (leadExercise) {
    const working = leadExercise.load === 'moderate' || leadExercise.sets >= 4
    lines.push(
      working
        ? `Open with ${leadExercise.name} — real working sets, not a warm-up.`
        : `Open with ${leadExercise.name} — controlled and clean before we add load.`,
    )
  }

  // 3. The diagnostic half — the planted read, already written in voice.
  if (readingWhy) lines.push(readingWhy)

  // 4. The close — what makes today count.
  lines.push(
    isFirst
      ? `At the end I'll ask how it went. That's what turns today into a read.`
      : `Log how it felt at the end — honest signal moves the read.`,
  )

  return lines
}

function SessionBrief({
  lines, ctaLabel, onClose,
}: { lines: string[]; ctaLabel: string; onClose: () => void }) {
  return (
    <Sheet
      title="Why this session"
      onClose={onClose}
      actions={<Button variant="primary" full onClick={onClose}>{ctaLabel}</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {lines.map((l, i) => (
          <p key={i} className="text-base" style={{ lineHeight: 1.55 }}>{l}</p>
        ))}
      </div>
    </Sheet>
  )
}

// ---- Coach's notes sheet (how-to + what to watch for) ----------------------
// The "I don't know how to do this" surface. Universal how-to/watch-for comes
// from the hardcoded coaching library; the program-specific cue the coach wrote
// for THIS lift is folded in underneath, so it reads as guidance for your plan,
// not a generic wiki entry.

interface ExerciseSheetProps {
  name: string
  note: CoachingNote | null
  cue: string | null
  insight: InsightRow | null
  reading: string | null
  onClose: () => void
}

/**
 * ONE sheet per exercise. This used to be three separate tap targets crammed
 * beside the exercise name — an (i) for the insight, a READING chip, and a
 * How-to tag — each opening its own sheet. They're all "tell me more about this
 * lift", so they're one surface now, sectioned.
 */
function ExerciseSheet({ name, note, cue, insight, reading, onClose }: ExerciseSheetProps) {
  const hasAnything = note || cue || insight || reading
  return (
    <Sheet title={name} onClose={onClose}>
      {note && (
        <div style={{ marginBottom: 24 }}>
          <p className="section-header" style={{ marginBottom: 12 }}>How to</p>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {note.howTo.map((step, i) => (
              <li key={i} style={{ display: 'flex', gap: 12 }}>
                <span className="num text-signal" style={{ fontSize: 'var(--fs-sm)', flexShrink: 0, lineHeight: 1.6, fontWeight: 700 }}>
                  {i + 1}
                </span>
                <span className="text-base" style={{ lineHeight: 1.55 }}>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {note && note.watchFor.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <p className="section-header" style={{ marginBottom: 12 }}>Watch for</p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {note.watchFor.map((fault, i) => (
              <li key={i} style={{ display: 'flex', gap: 12 }}>
                <span style={{ color: 'var(--pending)', flexShrink: 0, lineHeight: 1.55, fontWeight: 700 }}>!</span>
                <span className="text-base" style={{ lineHeight: 1.55 }}>{fault}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cue && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="section-header" style={{ marginBottom: 6 }}>Your cue</p>
          <p className="text-base" style={{ lineHeight: 1.55 }}>{cue}</p>
        </div>
      )}

      {insight && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--signal)' }}>
          <p className="section-header" style={{ marginBottom: 6 }}>Why it's in your program</p>
          <p className="text-base" style={{ lineHeight: 1.55 }}>{insight.claim}</p>
        </div>
      )}

      {reading && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--computing)' }}>
          <p className="section-header" style={{ marginBottom: 6, color: 'var(--computing)' }}>We're reading this one</p>
          <p className="text-base" style={{ lineHeight: 1.55 }}>{reading}</p>
        </div>
      )}

      {!hasAnything && (
        <p className="text-base text-dim">No notes for this one yet — train it clean and controlled.</p>
      )}
    </Sheet>
  )
}

// ---- Mid-workout coach chat (what/how/why, no program edits) ---------------
// A quick-question surface the athlete can open without leaving the session —
// today the only way to reach Coach mid-workout was to fully navigate off this
// screen. Deliberately dumber than CoachScreen: it shares the same read-only
// question/answer plumbing (gatherCoachContext, runCoachChat) but has NO
// "Proposed changes / Apply" affordance at all, so a program edit is simply
// not reachable from here — that still lives only in Coach (post-session) or
// the program editor. `mid_workout: true` also tells the model itself to keep
// `actions` empty and answers to a sentence or two (see schemas.ts).

interface WorkoutCoachTurn {
  role: 'athlete' | 'coach'
  content: string
  fresh?: boolean
}

function WorkoutCoachSheet({ athleteId, onClose }: { athleteId: string; onClose: () => void }) {
  // Same cache key as CoachScreen — if the athlete has opened Coach recently
  // this paints instantly from the held view instead of a fresh round-trip.
  const { data: view } = useCachedLoader(`coach:${athleteId}`, () => fetchCoachView(athleteId))
  const context = view?.context ?? null

  const [turns, setTurns] = useState<WorkoutCoachTurn[]>([])
  const [suggestionsOverride, setSuggestionsOverride] = useState<string[] | null>(null)
  const suggestions = suggestionsOverride ?? (context ? coachStarterPrompts(context) : [])
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState('')
  const threadEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, pending])

  async function send(question: string) {
    const q = question.trim()
    if (!q || pending || !context) return
    setDraft('')
    setSuggestionsOverride([])
    const history: CoachChatTurn[] = turns.map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), { role: 'athlete', content: q }])
    setPending(true)
    // midWorkout: true — the reply is strictly Q&A; any `actions` the model
    // returns are discarded unread, there's nothing here that could apply them.
    const res = await runCoachChat(context, history, q, { midWorkout: true })
    setTurns((prev) => [...prev, { role: 'coach', content: res.reply, fresh: true }])
    setSuggestionsOverride(res.followups.length ? res.followups : [])
    setPending(false)
  }

  return (
    <Sheet
      title="Coach"
      subtitle="Quick questions — the clock keeps running"
      onClose={onClose}
      actions={
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void send(draft)}
          placeholder={context ? 'What, how, or why…' : 'Loading your read…'}
          disabled={!context || pending}
          ariaLabel="Ask the coach"
          sendLabel="Ask"
        />
      }
    >
      <div className="coach-chat">
        {context && turns.length === 0 && (
          <div className="coach-msg coach-msg--coach fade-rise">
            <Markdown className="coach-msg__body" text="What's up? Ask about this lift, this session, or the read behind it." />
          </div>
        )}

        {turns.map((t, i) =>
          t.role === 'athlete' ? (
            <div key={i} className="coach-msg coach-msg--athlete fade-rise">
              <p className="coach-msg__body">{t.content}</p>
            </div>
          ) : (
            <div key={i} className={`coach-msg coach-msg--coach fade-rise${t.fresh ? ' coach-msg--fresh' : ''}`}>
              <Markdown className="coach-msg__body" text={t.content} />
            </div>
          ),
        )}

        {pending && (
          <div className="coach-msg coach-msg--coach">
            <TypingDots />
          </div>
        )}

        <div ref={threadEndRef} />

        {!pending && suggestions.length > 0 && (
          <div className="coach-suggestions">
            {suggestions.map((s, i) => (
              <button key={i} className="coach-suggestion" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-dim" style={{ marginTop: 12, lineHeight: 1.5 }}>
        Answers only, no changes here — program adjustments happen in Coach after you finish.
      </p>
    </Sheet>
  )
}

// ---- Session debrief sheet (the prose the agent mines) ---------------------

interface DebriefSheetProps {
  reading: { name: string; question: string } | null
  saving: boolean
  // What was written the first time round, when this is an edit of a session
  // that hasn't synced — editing shouldn't ask for the story again.
  initial: { reflection: string; readingAnswer: string } | null
  onSave: (reflection: string, readingAnswer: string) => void
  onSkip: () => void
}

function DebriefSheet({ reading, saving, initial, onSave, onSkip }: DebriefSheetProps) {
  const [reflection, setReflection] = useState(initial?.reflection ?? '')
  const [readingAnswer, setReadingAnswer] = useState(initial?.readingAnswer ?? '')
  return (
    <Sheet
      title="How did that go?"
      subtitle="A sentence is plenty. I read the words, not just the numbers."
      onClose={onSkip}
      dismissOnBackdrop={false}
      // No ×: the session is already finished at this point, so a "dismiss"
      // would silently commit it without a debrief. Log it or Skip, explicitly.
      hideClose
      actions={
        <>
          <Button
            variant="primary"
            full
            disabled={saving}
            onClick={() => onSave(reflection.trim(), readingAnswer.trim())}
          >
            {saving ? <Spinner /> : 'Log it →'}
          </Button>
          <Button variant="ghost" full style={{ marginTop: 6 }} onClick={onSkip} disabled={saving}>
            Skip
          </Button>
        </>
      }
    >
      {reading && (
        <div style={{ marginBottom: 18 }}>
          <p className="text-sm" style={{ color: 'var(--computing)', marginBottom: 8, lineHeight: 1.45 }}>
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
        style={{ minHeight: 120, resize: 'none', lineHeight: 1.55, fontSize: 'var(--fs-base)' }}
        placeholder="Felt strong on the second set, knee was quiet, left side still lagging…"
        value={reflection}
        onChange={(e) => setReflection(e.target.value)}
      />
    </Sheet>
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

// ---- offline-first bootstrap -----------------------------------------------
// The cached-per-routine bootstrap (see lib/workoutBoot) is what lets a session
// open instantly and fully offline; the network fetch below revalidates it in
// the background.

const bootKey = workoutBootKey

// A fresh, empty set-log grid sized to the routine's exercises.
function buildTemplate(routine: RoutineRow): Record<number, SetLog[]> {
  const exs = routine.exercises as ExerciseTemplate[]
  const initial: Record<number, SetLog[]> = {}
  exs.forEach((ex, i) => { initial[i] = Array.from({ length: ex.sets }, (_, j) => newSetLog(j + 1)) })
  return initial
}

// Overlay a saved draft's logs onto a fresh template by exercise index, so a
// routine that has since gained or lost an exercise still loads cleanly.
function overlayDraft(
  base: Record<number, SetLog[]>,
  draftSetLogs: Record<number, SetLog[]>,
): Record<number, SetLog[]> {
  const merged: Record<number, SetLog[]> = { ...base }
  Object.entries(draftSetLogs).forEach(([k, v]) => { if (v && v.length) merged[Number(k)] = v })
  return merged
}

// The felt chips / notes back out of a queued session's debrief. Its exercise
// list is built in template order, so the index is the exercise index.
function feedbackFromDebrief(debrief: PendingDebrief | null): Record<number, ExerciseFeedback> {
  const out: Record<number, ExerciseFeedback> = {}
  ;(debrief?.exercises ?? []).forEach((ex, i) => {
    if (!ex.felt && !ex.note) return
    out[i] = { name: ex.name, felt: ex.felt, note: ex.note ?? '' }
  })
  return out
}

export function WorkoutScreen({ onCommitted }: { onCommitted?: () => void } = {}) {
  const { routineId } = useParams<{ routineId: string }>()
  const navigate      = useNavigate()
  const [searchParams] = useSearchParams()
  // ?w=<id> → editing an already-logged session (re-runs the coach on save).
  // A session finished in the last few seconds — or offline, or one the server
  // refused — has no `workout` row yet, so it's referenced as `pending:<id>` and
  // edited straight out of the outbox. Querying the database for that id was how
  // "Review / edit" on a just-finished session came up blank.
  const editRef      = searchParams.get('w')
  const pendingRefId = parsePendingRef(editRef)
  // That reference can go stale under the athlete's thumb: the commit finishes
  // while the sheet is open. A queued session that has already become a row is
  // edited as the row, so saving updates it instead of logging it twice. Resolved
  // once, at mount, so the screen doesn't change mode mid-session; the save path
  // re-resolves (see buildPending) for a commit that lands while editing.
  const modeRef = useRef<{ pendingEditId: string | null; editWorkoutId: string | null }>()
  if (!modeRef.current) {
    const promoted = pendingRefId && !pendingSessionById(pendingRefId)
      ? committedWorkoutIdFor(pendingRefId)
      : null
    modeRef.current = {
      pendingEditId: promoted ? null : pendingRefId,
      editWorkoutId: promoted ?? (editRef && !pendingRefId ? editRef : null),
    }
  }
  const { pendingEditId, editWorkoutId } = modeRef.current
  const isEdit = !!editRef

  const unit = getWeightUnit()
  const distanceUnit = getDistanceUnit(unit)

  // Offline-first seed: read the cached bootstrap and the (synchronous, local)
  // draft exactly once, so the very first paint already shows the session — no
  // spinner, no network round-trip. An edit seeds from what the session actually
  // was instead of from a draft.
  const seedRef = useRef<{
    boot: WorkoutBootstrap | null
    draft: DraftPayload | null
    pending: PendingSession | null
    actuals: SessionActuals | null
  }>()
  if (!seedRef.current) {
    // The outbox is localStorage, so an uncommitted session hydrates on the
    // first frame — no network, works offline, no blank grid to type into.
    const pending = pendingEditId ? pendingSessionById(pendingEditId) : null
    seedRef.current = {
      boot: routineId ? loadCache<WorkoutBootstrap>(bootKey(routineId)) : null,
      draft: routineId && !isEdit ? loadDraftLocal(routineId) : null,
      pending,
      // A COMMITTED session's numbers are held too — the as-performed cache,
      // written when the session committed and refreshed every time the Train
      // sheet previews it. Reading it here is what stops "Review / edit" on a
      // synced session from opening on an empty grid: the workout row is ten
      // sequential round trips away (routine, athlete, previous session,
      // insights, prescription), and the athlete is looking at the screen now.
      actuals: pending
        ? actualsFromPending(pending)
        : editWorkoutId ? loadCache<SessionActuals>(cacheKeys.sessionActuals(editWorkoutId)) : null,
    }
  }
  const seedBoot = seedRef.current.boot
  const seedDraft = seedRef.current.draft
  const seedPending = seedRef.current.pending
  const seedActuals = seedRef.current.actuals

  // The day the session happened. For a new session this is just whenever the
  // athlete hits Complete — no picker, no real estate spent on it. Editing a
  // past log is the one case that still needs a picker (§ footer), since
  // there the date itself may be what's being corrected.
  const [performedAt, setPerformedAt] = useState<string>(() => toDateInput(
    seedActuals?.performedAt ? new Date(seedActuals.performedAt) : new Date(),
  ))
  // An edit with nothing to edit — the row is gone, the queued session was
  // dropped, or we're offline and the log only exists on the server. Say so
  // instead of showing an empty session that looks like the log was lost.
  const [editMissing, setEditMissing] = useState(false)
  // An edit whose numbers aren't in hand yet. It holds the spinner rather than
  // painting the empty template: a blank grid over a logged session reads as
  // lost work, and anything typed into it suppresses the hydration that would
  // have filled it (see startedLoggingRef) — one Save from overwriting the log
  // with nothing. Seeded above → already hydrated, so no spinner.
  const [editHydrating, setEditHydrating] = useState<boolean>(() => isEdit && !seedActuals)

  const [routine, setRoutine]     = useState<RoutineRow | null>(() => seedBoot?.routine ?? null)
  const [athleteId, setAthleteId] = useState<string | null>(() => seedBoot?.athleteId ?? null)
  const [athleteName, setAthleteName] = useState<string | null>(() => seedBoot?.athleteName ?? null)
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(() => seedBoot?.onboardingStep ?? null)
  // Cache hit → paint immediately (no spinner). Cold open still shows one.
  const [loading, setLoading]     = useState<boolean>(() => !seedBoot)
  const [elapsed, setElapsed]     = useState<number>(
    () => (seedActuals ? (seedActuals.durationMins ?? 0) * 60 : seedDraft?.elapsedSeconds ?? 0),
  )
  const [showDebrief, setShowDebrief] = useState(false)
  const [savingDebrief, setSavingDebrief] = useState(false)
  // Elapsed frozen at the moment "Complete" was tapped — the debrief sheet can
  // sit open for a while, so the committed duration is this, not the live clock.
  const finalElapsedRef = useRef(0)

  // "Why this session" brief — opened on demand from the header's "Why"
  // button, not auto-shown, so starting a workout is a single tap. Resuming a
  // seeded draft still drops straight into training.
  const [briefOpen, setBriefOpen] = useState(false)
  const [hasStarted, setHasStarted] = useState<boolean>(() => !!seedDraft || !!seedActuals)

  // Mid-workout coach chat — quick what/how/why questions without leaving the
  // session. No program-edit path exists from here (see WorkoutCoachSheet).
  const [coachOpen, setCoachOpen] = useState(false)

  // Per-exercise felt signal (exIdx → feedback).
  const [feedback, setFeedback] = useState<Record<number, ExerciseFeedback>>(
    () => (seedPending
      ? feedbackFromDebrief(seedPending.debrief)
      : (seedDraft?.feedback ?? {}) as Record<number, ExerciseFeedback>),
  )

  // Rest timer (epoch ms when rest ends, or null).
  const [restEndsAt, setRestEndsAt] = useState<number | null>(null)
  const [, setNowTick] = useState(0)

  // insight_id → insight, for the per-exercise "why" surface
  const [insightMap, setInsightMap] = useState<Record<string, InsightRow>>(() => seedBoot?.insightMap ?? {})
  // The single per-exercise detail sheet (how-to + cue + why + reading).
  const [openExercise, setOpenExercise] = useState<{
    name: string
    note: CoachingNote | null
    cue: string | null
    insight: InsightRow | null
    reading: string | null
  } | null>(null)

  const [setLogs, setSetLogs] = useState<Record<number, SetLog[]>>(() => {
    if (!seedBoot) return {}
    const base = buildTemplate(seedBoot.routine)
    if (seedActuals) return overlayDraft(base, seedActuals.setLogs)
    return seedDraft ? overlayDraft(base, seedDraft.setLogs) : base
  })

  // Per-exercise prescription — last week's top set + the week's directive (§4.4).
  const [prescription, setPrescription] = useState<SessionPrescription | null>(() => seedBoot?.prescription ?? null)

  // Last session's results per exercise index, for the desktop Previous column.
  const [prevByExercise, setPrevByExercise] = useState<Record<number, SetLog[]>>(() => seedBoot?.prevByExercise ?? {})
  // Which exercise is in focus — drives the "why" panel in the desktop rail.
  const [activeExIdx, setActiveExIdx] = useState(0)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Seed the clock from the resumed draft so the timer continues where it left
  // off (true stop/continue — time away isn't counted).
  const startRef = useRef<number>(
    seedActuals ? Date.now() - (seedActuals.durationMins ?? 0) * 60_000
    : seedDraft ? Date.now() - seedDraft.elapsedSeconds * 1000
    : Date.now(),
  )

  // Draft persistence (§ start/stop/continue). With an offline seed the draft is
  // already restored before first paint, so autosave is safe to arm immediately
  // on a warm open (the hasDraftSignal guard still prevents persisting an empty
  // session). A cold open arms it once the network restore has run.
  // sessionStartRef is the real session start (the week-window anchor); payloadRef
  // always mirrors current state so the flush handlers can read it cheaply.
  const [draftReady, setDraftReady] = useState<boolean>(() => !!seedBoot)
  const sessionStartRef = useRef<string>(seedDraft?.startedAt ?? new Date().toISOString())
  const payloadRef = useRef<DraftPayload | null>(null)
  const completedRef = useRef(isEdit)   // true once promoted to a workout (or editing) → stop persisting
  // Flips once the athlete edits anything this open, so a late network draft
  // restore can't clobber numbers they've already entered.
  const startedLoggingRef = useRef(false)

  useEffect(() => {
    if (!routineId) return
    // A read that blows up mid-flight must not strand an edit on a spinner that
    // never clears — or, worse, on the empty grid behind it.
    void loadRoutine().catch(() => {
      if (isEdit && !seedActuals) setEditMissing(true)
      setEditHydrating(false)
      setLoading(false)
    })
    // startRef is seeded above (fresh now, or now minus a resumed draft's
    // elapsed) — don't reset it here or a resumed clock would jump back to 0.
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

  // Background revalidation. On a warm (cached) open the screen is already
  // painted and interactive from the seed — this just refreshes the routine,
  // prescription, Previous column and insights, and re-caches them for next
  // time. It never resets the athlete's in-progress numbers: the set grid is
  // only (re)seeded on a cold open, or from a draft they haven't yet touched.
  async function loadRoutine() {
    if (!routineId) return
    const cold = !seedRef.current!.boot

    // The template and — on an edit — the session's own numbers, together and
    // ahead of everything else. They're what the athlete came here to see; the
    // Previous column, the insights and the prescription are context and can
    // land behind the screen. Hydrating the edit LAST, after five sequential
    // reads, is what left a logged session sitting blank for seconds at a time.
    const [{ data }, editRow] = await Promise.all([
      supabase
        .from('routine')
        .select('*, program:program_id(athlete_id)')
        .eq('id', routineId)
        .single(),
      editWorkoutId
        ? supabase
            .from('workout')
            .select('actual_weights, duration_mins, performed_at, rpe, exercises_snapshot')
            .eq('id', editWorkoutId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    if (!data) {
      // Offline with nothing cached is the only way here — leave the seed (if
      // any) on screen and stop the spinner. The edit can still go ahead when
      // this device already holds what was logged; it's only unopenable when the
      // session exists nowhere but the server.
      if (isEdit && !seedActuals) setEditMissing(true)
      setEditHydrating(false)
      setLoading(false)
      return
    }

    const r = data as RoutineRow
    setRoutine(r)
    const exs = r.exercises as ExerciseTemplate[]
    const initial = buildTemplate(r)
    // Cold open only: no cached template was seeded, so lay down the empty grid
    // now. A warm open already painted it (plus any local draft) synchronously.
    if (cold) setSetLogs(initial)

    if (isEdit && !hydrateEdit(initial, editRow.data)) {
      setEditHydrating(false)
      setLoading(false)
      return
    }
    setEditHydrating(false)

    let nextAthleteId: string | null = null
    let nextAthleteName: string | null = null
    let nextOnboardingStep: OnboardingStep | null = null
    const programData = (data as unknown as { program: { athlete_id: string } | null }).program
    if (programData) {
      nextAthleteId = programData.athlete_id
      setAthleteId(programData.athlete_id)
      const { data: ath } = await supabase
        .from('athlete')
        .select('name, onboarding_step')
        .eq('id', programData.athlete_id)
        .maybeSingle()
      if (ath) {
        nextAthleteName = (ath as { name: string | null }).name ?? null
        nextOnboardingStep = (ath as { onboarding_step: OnboardingStep }).onboarding_step
        setAthleteName(nextAthleteName)
        setOnboardingStep(nextOnboardingStep)
      }
    }

    // Most recent prior session of this same routine → the Previous column.
    // Same routine_id means the exercise list (and ordering) matches, so the
    // index keys line up with this session's exercises.
    let nextPrev: Record<number, SetLog[]> = {}
    const { data: prevWorkout } = await supabase
      .from('workout')
      .select('actual_weights')
      .eq('routine_id', routineId)
      .order('performed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const prevWeights = (prevWorkout as { actual_weights: Record<string, SetLog[]> | null } | null)?.actual_weights
    if (prevWeights) {
      Object.entries(prevWeights).forEach(([k, v]) => { nextPrev[Number(k)] = v })
      setPrevByExercise(nextPrev)
    }

    let nextInsightMap: Record<string, InsightRow> = {}
    const insightIds = [...new Set(exs.map((ex) => ex.insight_id).filter(Boolean))] as string[]
    if (insightIds.length > 0) {
      const { data: insightRows } = await supabase
        .from('insight')
        .select('*')
        .in('id', insightIds)
      ;(insightRows ?? []).forEach((ins) => { nextInsightMap[(ins as InsightRow).id] = ins as InsightRow })
      setInsightMap(nextInsightMap)
    }

    // Prescription hints — best-effort; the session loads regardless. Keep the
    // seeded value if the recompute fails (offline mid-revalidation).
    let nextPresc: SessionPrescription | null = seedRef.current!.boot?.prescription ?? null
    if (programData && routineId) {
      try {
        nextPresc = await gatherSessionPrescription(programData.athlete_id, routineId, exs, unit)
        setPrescription(nextPresc)
      } catch { /* non-fatal */ }
    }

    // Re-cache the whole bootstrap so the next open is instant and offline-ready.
    saveCache<WorkoutBootstrap>(bootKey(routineId), {
      routine: r,
      athleteId: nextAthleteId,
      athleteName: nextAthleteName,
      onboardingStep: nextOnboardingStep,
      prevByExercise: nextPrev,
      insightMap: nextInsightMap,
      prescription: nextPresc,
    })

    if (!isEdit && programData && routineId && !startedLoggingRef.current) {
      // Resume an in-progress session if one was autosaved this week. restoreDraft
      // merges the local (already seeded) and remote tiers by recency, so this
      // also picks up a session continued on another device. Skipped once the
      // athlete has started logging here, so it can't overwrite live input.
      const draft = await restoreDraft(programData.athlete_id, routineId)
      if (draft && !startedLoggingRef.current) {
        setSetLogs(overlayDraft(initial, draft.setLogs))
        setFeedback((draft.feedback ?? {}) as Record<number, ExerciseFeedback>)
        setElapsed(draft.elapsedSeconds)
        startRef.current = Date.now() - draft.elapsedSeconds * 1000
        sessionStartRef.current = draft.startedAt
        setHasStarted(true)
        setBriefOpen(false)   // resuming → drop straight back into training
      }
    }
    setDraftReady(true)
    setLoading(false)
  }

  /**
   * Put the session being edited on screen, over the routine's empty template.
   * Returns false when there's nothing to edit — the caller stops there rather
   * than leaving a blank grid up, which reads as lost work and is one Save away
   * from becoming it.
   *
   * Both sources are already applied by the first-frame seed; this is the cold
   * open (no cached bootstrap, so no grid existed until the routine arrived) and
   * the revalidation of what the seed showed.
   */
  function hydrateEdit(
    initial: Record<number, SetLog[]>,
    row: unknown,
  ): boolean {
    completedRef.current = true   // an edit never autosaves a draft
    setHasStarted(true)
    setBriefOpen(false)

    if (pendingEditId) {
      // Still in the outbox — it has no `workout` row to read, so the queue IS
      // the record.
      const p = pendingSessionById(pendingEditId)
      if (!p) {
        // Gone from the queue since mount means it committed while the screen
        // was opening — the numbers seeded on the first frame are still the
        // right ones, and buildPending re-resolves the row to update. Only a
        // session we never had is actually missing.
        if (seedActuals) return true
        setEditMissing(true)
        return false
      }
      if (!startedLoggingRef.current) {
        setSetLogs(overlayDraft(initial, p.actualWeights as Record<number, SetLog[]>))
        setFeedback(feedbackFromDebrief(p.debrief))
        setElapsed(p.durationMins * 60)
        startRef.current = Date.now() - p.durationMins * 60_000
        if (p.performedAt) setPerformedAt(toDateInput(new Date(p.performedAt)))
      }
      return true
    }

    const w = row as {
      actual_weights: Record<string, SetLog[]> | null
      duration_mins: number | null
      performed_at: string | null
      rpe: number | null
      exercises_snapshot: ExerciseTemplate[] | null
    } | null
    if (!w) {
      // The row is gone, unreadable, or we never reached the server. The seed is
      // the session if we have one; otherwise refuse the edit.
      if (seedActuals) return true
      setEditMissing(true)
      return false
    }

    const setLogsFromRow: Record<number, SetLog[]> = {}
    Object.entries(w.actual_weights ?? {}).forEach(([k, v]) => { setLogsFromRow[Number(k)] = v })
    if (w.actual_weights && !startedLoggingRef.current) {
      setSetLogs(overlayDraft(initial, setLogsFromRow))
    }
    const dur = w.duration_mins ?? 0
    setElapsed(dur * 60)
    startRef.current = Date.now() - dur * 60 * 1000
    if (w.performed_at) setPerformedAt(toDateInput(new Date(w.performed_at)))

    // Hold what we just read, so the next open of this session — Train's preview
    // or another edit — paints from the first frame, offline included. The
    // snapshot rides along: it's what these set indices are indexed into, and a
    // reader handed the numbers without it would label them off the routine's
    // live list.
    if (editWorkoutId && w.performed_at) {
      saveCache<SessionActuals>(cacheKeys.sessionActuals(editWorkoutId), {
        workoutId: editWorkoutId,
        performedAt: w.performed_at,
        durationMins: w.duration_mins,
        rpe: w.rpe,
        setLogs: setLogsFromRow,
        exercisesSnapshot: Array.isArray(w.exercises_snapshot) && w.exercises_snapshot.length
          ? w.exercises_snapshot
          : null,
      })
    }
    return true
  }

  function handleSetChange(exIdx: number, setIdx: number, updated: SetLog) {
    startedLoggingRef.current = true
    setSetLogs((prev) => {
      const sets = [...(prev[exIdx] ?? [])]
      sets[setIdx] = updated
      return { ...prev, [exIdx]: sets }
    })
  }

  function addSet(exIdx: number) {
    startedLoggingRef.current = true
    setSetLogs((prev) => {
      const sets = prev[exIdx] ?? []
      return { ...prev, [exIdx]: [...sets, newSetLog(sets.length + 1)] }
    })
  }

  function setFelt(exIdx: number, name: string, felt: FeltLabel | null) {
    startedLoggingRef.current = true
    setFeedback((prev) => ({ ...prev, [exIdx]: { name, felt, note: prev[exIdx]?.note ?? '' } }))
  }
  function setFeltNote(exIdx: number, name: string, note: string) {
    startedLoggingRef.current = true
    setFeedback((prev) => ({ ...prev, [exIdx]: { name, felt: prev[exIdx]?.felt ?? null, note } }))
  }

  const allSetsFlat = Object.values(setLogs).flat()
  const hasAnyLog = allSetsFlat.some(isLogged)

  // "Complete" no longer writes — it freezes the clock and opens the debrief.
  // The actual server commit happens at finishSession (after debrief or skip), so
  // the whole session, debrief included, lands in one durable, replayable unit.
  function handleCompleteWorkout() {
    if (!routine) return
    // Dismiss any open keyboard before the debrief sheet slides up, so it isn't
    // hidden behind a keyboard the user has no way to close.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
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

    // Editing a queued session REPLACES its outbox entry rather than adding one:
    // same id, so there's still exactly one record of the session. Its target is
    // re-resolved here because the original may have committed while the athlete
    // was editing — in which case this save has to update that row.
    const base = pendingEditId ? pendingSessionById(pendingEditId) : null
    const pendingTarget = pendingEditId
      ? base?.editWorkoutId ?? committedWorkoutIdFor(pendingEditId)
      : null

    return {
      id: pendingEditId ?? crypto.randomUUID(),
      athleteId: athleteId!,
      routineId: routineId!,
      actualWeights,
      actualReps,
      rpe: avgRpe,
      durationMins: Math.ceil(finalElapsedRef.current / 60),
      setsDone: allSetsFlat.filter((s) => s.done).length,
      athleteName,
      // A queued first-ever session keeps its transition — editing it before it
      // syncs mustn't be what strands onboarding half-finished.
      onboardingTransition: pendingEditId
        ? base?.onboardingTransition ?? null
        : isEdit ? null : onboardingTransition,
      debrief,
      editWorkoutId: pendingEditId ? pendingTarget : isEdit ? editWorkoutId : null,
      performedAt: isEdit ? dateInputToISO(performedAt) : dateInputToISO(toDateInput(new Date())),
      queuedAt: new Date().toISOString(),
      // Freeze the prescription these set indices were logged against. The
      // program editor rewrites routine.exercises in place, so a session read
      // back through the routine's LIVE list is one edit away from being
      // relabeled with movements the athlete never did.
      exercisesSnapshot: (routine!.exercises as ExerciseTemplate[]) ?? null,
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

    const pending = buildPending(debrief)
    enqueueSession(pending)                       // durable before any network
    if (!isEdit) clearDraft(athleteId, routineId!) // the outbox is its home now

    // A finished session moves nearly every view: the week strip, the schedule,
    // the training log, the program map, the read the coach works from, the
    // convergence reticle. Mark them all due — nothing is dropped, so every
    // screen still paints instantly; they just refresh behind what they show.
    invalidateLoopViews()

    // An edit of a session that already has a row: hold the corrected numbers
    // under that row's key now, so re-opening it shows the edit rather than the
    // pre-edit copy while the commit (AI debrief included) is still in flight.
    // Seeded AFTER the sweep above, or it would be marked stale on arrival.
    if (pending.editWorkoutId) {
      const edited = actualsFromPending(pending)
      if (edited) {
        saveCache<SessionActuals>(cacheKeys.sessionActuals(pending.editWorkoutId), {
          ...edited, workoutId: pending.editWorkoutId,
        })
      }
    }

    // First session with debrief: wait for the commit so the revelation screen
    // gets the AI-generated insight data for the "moved" animation. This path
    // happens once ever per athlete so the wait is acceptable.
    if (!isEdit && pending.onboardingTransition === 'first_session_complete') {
      setSavingDebrief(true)
      let result = null
      try {
        result = await commitPending(pending)
      } catch { /* stays queued, outbox retries on next online event */ }
      setSavingDebrief(false)
      onCommitted?.()

      if (result) {
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
      } else {
        navigate('/app/today', { replace: true, state: { queuedOffline: true } })
      }
      return
    }

    // All other cases — optimistic: navigate immediately, commit in background.
    // The session is durably in the outbox the moment enqueueSession() returns;
    // the UI doesn't need to wait for the server write (or the AI debrief agent)
    // to feel complete. The commit removes the session from the queue on success;
    // the outbox retries on the next `online` event if it fails.
    onCommitted?.()

    if (isEdit) {
      navigate('/app/today', { replace: true })
    } else if (debrief) {
      // Navigate to profile without waiting for the AI agent; the category
      // pulse is skipped but the session is saved.
      navigate('/app/profile', { replace: true })
    } else {
      navigate('/app/today', { replace: true })
    }

    void commitPending(pending).catch(() => { /* stays queued */ })
  }

  // What the athlete wrote the first time, when the session being edited is still
  // in the outbox (a committed one's words live in session_observation).
  const priorDebrief = seedPending?.debrief ?? null

  function handleDebrief(reflection: string, readingAnswer: string) {
    if (!routine) return
    void finishSession(buildDebrief(reflection, readingAnswer))
  }

  // Skipping still re-runs the coach on an edit (the chosen behaviour: every edit
  // re-reads the session), just with no fresh reflection text. Editing a session
  // that hasn't synced carries its original words forward instead of blanking
  // them — skipping the debrief means "leave it as it was", not "delete it".
  // A brand-new session skips the debrief entirely (workout numbers only).
  function handleDebriefSkip() {
    if (!routine) return
    if (!isEdit) { void finishSession(null); return }
    void finishSession(buildDebrief(priorDebrief?.reflection ?? '', priorDebrief?.readingAnswer ?? ''))
  }

  // ---- loading / error ------------------------------------------------------

  // editHydrating: an edit whose numbers haven't arrived. The template alone is
  // not this session, so it waits rather than showing an empty one.
  if (loading || editHydrating) {
    return <div className="screen--centered"><Spinner /></div>
  }
  // An edit we can't load. Showing the empty grid here is what made a logged
  // session read as blank — and one Save away from overwriting it with nothing.
  if (editMissing) {
    return (
      <div className="screen--centered">
        <p className="text-base" style={{ fontWeight: 700 }}>Couldn&apos;t open that session</p>
        <p className="text-sm text-dim" style={{ marginTop: 8, maxWidth: 300, lineHeight: 1.5 }}>
          Its log isn&apos;t on this device and we couldn&apos;t reach the server. Nothing has
          been changed — try again once you&apos;re back online.
        </p>
        <Button variant="ghost" onClick={() => navigate('/app/today')} style={{ marginTop: 16 }}>Back</Button>
      </div>
    )
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

  const restLeft = restEndsAt ? Math.max(0, Math.ceil((restEndsAt - Date.now()) / 1000)) : 0

  // Desktop rail context: the exercise whose field was last focused.
  const activeEx = exercises[activeExIdx]
  const activeInsight = activeEx?.insight_id ? insightMap[activeEx.insight_id] : undefined

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      {/* Session header. The old version crammed four mono telemetry fields into
          a 28px strip; this is the same information as a title, one metadata
          line, and a progress bar you can read without stopping. */}
      <div
        style={{
          borderBottom: '1px solid var(--line)',
          position: 'sticky', top: 0, background: 'var(--ground)', zIndex: 10,
          // Workout is a full-screen route (no app-shell), so it reserves the
          // status-bar inset itself — the ground-filled padding sits behind the
          // translucent bar while the controls clear it.
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 10px' }}>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 0 }}
            onClick={() => navigate(-1)}
            aria-label="Back"
          >
            <ChevronLeft size={24} strokeWidth={2} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 'var(--fs-base)', fontWeight: 700, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {routine.name}
            </p>
            <p className="num text-xs text-dim" style={{ marginTop: 2 }}>
              {formatElapsed(elapsed)} · {setsDone}/{setsTotal} sets
              {avgRpeLive !== null ? ` · RPE ${avgRpeLive}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="howto-tag"
            style={{ color: 'var(--computing)', borderColor: 'rgba(90,143,184,0.35)' }}
            onClick={() => setBriefOpen(true)}
            aria-label="Why this session"
          >
            <Info size={14} strokeWidth={2} style={{ marginRight: 5 }} /> Why
          </button>
          {athleteId && (
            <button
              type="button"
              className="howto-tag"
              onClick={() => setCoachOpen(true)}
              aria-label="Ask the coach"
            >
              <MessageCircle size={14} strokeWidth={2} style={{ marginRight: 5 }} /> Coach
            </button>
          )}
        </div>
        {/* Progress — the session's completion, drawn. */}
        <div className="meter" style={{ height: 3, borderRadius: 0 }}>
          <div
            className="meter__fill"
            style={{ width: `${setsTotal ? (setsDone / setsTotal) * 100 : 0}%`, borderRadius: 0 }}
          />
        </div>
      </div>

      {/* Exercise list (left) + desktop context rail (right) */}
      <div className="workout-panes">
       <div className="workout-list">
        <div className="workout-col">
        {/* Intelligence Rule in effect — stated out loud (the felt difference) */}
        {prescription?.rule && (
          <div
            className="card"
            style={{ marginTop: 20, borderLeft: '3px solid var(--signal)' }}
          >
            <p className="section-header text-signal" style={{ marginBottom: 8 }}>
              {prescription.rule.name}
            </p>
            <p className="text-base" style={{ lineHeight: 1.5 }}>{prescription.rule.reasoning}</p>
          </div>
        )}

        {exercises.map((ex, exIdx) => {
          const logs = setLogs[exIdx] ?? []
          const trackingType = ex.tracking_type ?? resolveTrackingType(ex.name, ex.reps, ex.load)
          const pReps = leadingInt(ex.reps)
          const pDur  = trackingType === 'time' ? leadingInt(ex.reps) : null
          const pLoad = leadingInt(ex.load ?? undefined)
          // Details sheet: the hardcoded how-to library, the program-specific
          // cue, the insight this lift serves, and the reading note. Show the
          // affordance whenever any of them exists.
          const coachNote = getCoachingNote(ex.name)
          const hasDetails =
            !!coachNote || !!ex.cue || !!(ex.insight_id && insightMap[ex.insight_id]) || !!ex.reading

          return (
            <div key={exIdx} style={{ paddingTop: 26, paddingBottom: 16, borderBottom: '1px solid var(--line)' }}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <h2 style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 'var(--fs-xl)', lineHeight: 1.25, letterSpacing: '-0.01em' }}>
                    {ex.name}
                  </h2>
                  {/* One affordance, not three. Everything about this lift —
                      how-to, faults, your cue, the read it serves — is behind it. */}
                  {hasDetails && (
                    <button
                      type="button"
                      className="howto-tag"
                      style={{ flexShrink: 0 }}
                      aria-label={`About ${ex.name}`}
                      onClick={() => setOpenExercise({
                        name: ex.name,
                        note: coachNote,
                        cue: ex.cue ?? null,
                        insight: (ex.insight_id ? insightMap[ex.insight_id] : null) ?? null,
                        reading: ex.reading ? (ex.reading_why ?? '') : null,
                      })}
                    >
                      <Info size={14} strokeWidth={2} style={{ marginRight: 5 }} /> Details
                    </button>
                  )}
                </div>
                {(ex.reading || prescription?.hints[exIdx]) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    {ex.reading && <Chip tone="info">Reading</Chip>}
                    {prescription?.hints[exIdx] && (
                      <Chip tone={prescription.held[exIdx] ? 'pending' : 'doing'}>
                        {prescription.hints[exIdx]}
                      </Chip>
                    )}
                  </div>
                )}
              </div>

              <SetHeader
                trackingType={trackingType}
                unit={unit}
                distanceUnit={distanceUnit}
                prescribedReps={ex.reps}
                prescribedLoad={ex.load ?? null}
              />

              {logs.map((log, setIdx) => {
                // What "check to complete" carries into empty fields: the set
                // before it this session wins (you usually repeat a load), with
                // last session's matching set as the fallback for set 1. RPE is
                // in-session only — it's the read we're measuring, not a default.
                const inSessionPrev = setIdx > 0 ? logs[setIdx - 1] : null
                const lastSame = (prevByExercise[exIdx] ?? [])[setIdx]
                const carry: Partial<SetLog> = {
                  weight:   inSessionPrev?.weight   ?? lastSame?.weight   ?? null,
                  reps:     inSessionPrev?.reps     ?? lastSame?.reps     ?? null,
                  rpe:      inSessionPrev?.rpe      ?? null,
                  duration: inSessionPrev?.duration ?? lastSame?.duration ?? null,
                  distance: inSessionPrev?.distance ?? lastSame?.distance ?? null,
                }
                return (
                  <SetRow
                    key={setIdx}
                    setNum={setIdx + 1}
                    log={log}
                    trackingType={trackingType}
                    unit={unit}
                    distanceUnit={distanceUnit}
                    prescribedReps={pReps}
                    prescribedDuration={pDur}
                    prescribedLoad={pLoad}
                    carry={carry}
                    prevText={formatPrev(trackingType, (prevByExercise[exIdx] ?? [])[setIdx], unit, distanceUnit)}
                    onChange={(updated) => handleSetChange(exIdx, setIdx, updated)}
                    onComplete={() => setRestEndsAt(Date.now() + REST_SECONDS * 1000)}
                    onActivate={() => setActiveExIdx(exIdx)}
                  />
                )
              })}

              <button
                type="button"
                className="btn btn--ghost"
                style={{ marginTop: 10, padding: '0 8px', color: 'var(--text-dim)' }}
                onClick={() => addSet(exIdx)}
              >
                <Plus size={16} strokeWidth={2} style={{ marginRight: 6 }} />
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
          {/* A new session is just logged as today, the instant Complete is
              tapped — no picker, no real estate spent on it. Editing a past
              log is the one place the date itself might need correcting. */}
          {isEdit && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span className="text-xs text-dim">Day</span>
              <input
                type="date"
                className="num"
                value={performedAt}
                max={toDateInput(new Date())}
                onChange={(e) => setPerformedAt(e.target.value || toDateInput(new Date()))}
                style={{
                  background: 'transparent', border: '1px solid var(--line)', borderRadius: 8,
                  color: 'var(--text)', padding: '6px 10px', fontSize: 'var(--fs-xs)',
                }}
              />
            </label>
          )}
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
          initial={priorDebrief ? { reflection: priorDebrief.reflection, readingAnswer: priorDebrief.readingAnswer } : null}
          onSave={handleDebrief}
          onSkip={handleDebriefSkip}
        />
      )}

      {/* The one per-exercise detail sheet */}
      {openExercise && (
        <ExerciseSheet
          name={openExercise.name}
          note={openExercise.note}
          cue={openExercise.cue}
          insight={openExercise.insight}
          reading={openExercise.reading}
          onClose={() => setOpenExercise(null)}
        />
      )}

      {/* Mid-workout coach chat — quick questions, no program edits */}
      {coachOpen && athleteId && (
        <WorkoutCoachSheet athleteId={athleteId} onClose={() => setCoachOpen(false)} />
      )}
    </div>
  )
}
