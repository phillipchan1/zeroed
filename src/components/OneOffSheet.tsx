import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ChatComposer, Markdown, Sheet, TypingDots } from './ui'
import { planOneOff, startOneOff } from '../engine/oneOff'
import { ONE_OFF_EXAMPLES } from '../engine/outsidePlan'
import { estimateSessionMinutes, type DraftSession } from '../engine/programDraft'
import { fmtDose, isIntervalBlock } from '../engine/intervals'
import { seedWorkoutBootstrap } from '../lib/workoutBoot'
import { unitContext } from '../lib/units'
import { isKnownOffline } from '../lib/useOnline'
import type { ProgramEditTurn } from '../engine/agentClient'
import type { ExerciseTemplate, OnboardingStep } from '../types/database'

// =============================================================================
// Plan a one-off session. "Easy run with my wife." "Hotel gym, dumbbells, 45
// minutes." The athlete says what they've got, the coach builds one session for
// today, the athlete can ask for changes, then Start runs it in the workout
// screen like any session. It never joins the week, and the program is never
// touched: the coach's edits land on this one session only, through the same
// bounds the program editor uses.
// =============================================================================

interface Props {
  athleteId: string
  athleteName: string | null
  onboardingStep: OnboardingStep | null
  onClose: () => void
}

interface Turn {
  role: 'athlete' | 'coach'
  content: string
}

function dose(ex: ExerciseTemplate): string {
  if (isIntervalBlock(ex)) return fmtDose(ex)
  return `${ex.sets}×${ex.reps}${ex.load ? ` · ${ex.load}` : ''}${ex.target_rpe ? ` · RPE ${ex.target_rpe}` : ''}`
}

export function OneOffSheet({ athleteId, athleteName, onboardingStep, onClose }: Props) {
  const navigate = useNavigate()
  const [turns, setTurns] = useState<Turn[]>([])
  const [session, setSession] = useState<DraftSession | null>(null)
  const [followups, setFollowups] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, thinking, session])

  async function send(text: string) {
    const said = text.trim()
    if (!said || thinking || starting) return
    setDraft('')
    setFollowups([])
    setStartError(null)
    const history: ProgramEditTurn[] = turns.map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev, { role: 'athlete', content: said }])
    // Planning needs the coach. Known offline: say so now rather than after a
    // string of reads time out.
    if (isKnownOffline()) {
      setTurns((prev) => [...prev, { role: 'coach', content: "You're offline, so I can't plan it right now. Try again when you're back on, or log it afterwards from Today." }])
      return
    }
    setThinking(true)
    const res = await planOneOff(athleteId, unitContext(), session, history, said)
    setTurns((prev) => [...prev, { role: 'coach', content: res.reply }])
    setSession(res.session)
    setFollowups(res.followups.slice(0, 3))
    setThinking(false)
  }

  async function start() {
    if (!session || starting) return
    setStarting(true)
    setStartError(null)
    try {
      const routine = await startOneOff(athleteId, session)
      // Paint the workout screen from what we already hold, as Today does for
      // its own sessions, instead of spinning on a fetch of the row we just wrote.
      seedWorkoutBootstrap(routine, athleteId, athleteName, onboardingStep)
      navigate(`/app/workout/${routine.id}`, { viewTransition: true })
    } catch {
      setStartError("Couldn't start it just now. Check your connection and tap Start again.")
      setStarting(false)
    }
  }

  const minutes = session ? estimateSessionMinutes(session.exercises) : null

  return (
    <Sheet
      title="Plan a one-off session"
      subtitle="Tell me what you've got. It runs today and stays out of your plan."
      onClose={onClose}
      actions={
        <>
          {session && (
            <Button variant="primary" full disabled={thinking || starting} onClick={() => void start()} style={{ marginBottom: 8 }}>
              {starting ? 'Starting…' : 'Start it'}
            </Button>
          )}
          <ChatComposer
            value={draft}
            onChange={setDraft}
            onSend={() => void send(draft)}
            placeholder={session ? 'Change anything: shorter, no running…' : 'Time, kit, who with, how you feel…'}
            disabled={thinking || starting}
            ariaLabel={session ? 'Ask for a change' : 'Describe the session'}
            sendLabel={session ? 'Change' : 'Plan it'}
          />
        </>
      }
    >
      <div className="coach-chat">
        {turns.length === 0 && (
          <div className="coach-suggestions">
            {ONE_OFF_EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="coach-suggestion" onClick={() => void send(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}

        {turns.map((t, i) =>
          t.role === 'athlete' ? (
            <div key={i} className="coach-msg coach-msg--athlete fade-rise">
              <p className="coach-msg__body">{t.content}</p>
            </div>
          ) : (
            <div key={i} className="coach-msg coach-msg--coach fade-rise">
              <Markdown className="coach-msg__body" text={t.content} />
            </div>
          ),
        )}

        {thinking && (
          <div className="coach-msg coach-msg--coach">
            <TypingDots label="Planning it" />
          </div>
        )}

        {session && !thinking && (
          <div className="card oneoff fade-rise" aria-live="polite">
            <div className="oneoff__head">
              <h3 className="oneoff__name">{session.name}</h3>
              {minutes != null && <span className="num text-xs text-dim">~{minutes} min</span>}
            </div>
            {session.intent && <p className="text-sm text-dim" style={{ marginTop: 4 }}>{session.intent}</p>}
            <ol className="oneoff__list">
              {session.exercises.map((ex, i) => (
                <li key={`${ex.name}-${i}`} className="oneoff__row">
                  <span>{ex.name}</span>
                  <span className="num text-xs text-dim">{dose(ex)}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-dim" style={{ marginTop: 10 }}>
              Loads come from your own numbers when you start it.
            </p>
          </div>
        )}

        {startError && <p className="text-sm" style={{ color: 'var(--veto)', marginTop: 8 }}>{startError}</p>}

        {!thinking && followups.length > 0 && (
          <div className="coach-suggestions">
            {followups.map((f, i) => (
              <button key={i} type="button" className="coach-suggestion" onClick={() => void send(f)}>
                {f}
              </button>
            ))}
          </div>
        )}

        <div ref={endRef} />
      </div>
    </Sheet>
  )
}
