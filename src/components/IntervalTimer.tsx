import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Pause, Play, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { LockOn, TickingNumber } from './ui'
import {
  buildTimeline, readClock, roundsDone, blockSeconds, fmtClock, fmtDuration, describePlan,
  READY_SECONDS, type IntervalPlan, type Phase, type PhaseKind,
} from '../engine/intervals'
import {
  cueCount, cueGo, cueRest, cueDone, cueHalf, intervalSoundOn, setIntervalSound, releaseCueAudio, primeCueAudio,
} from '../lib/intervalCues'
import { useWakeLock } from '../lib/wakeLock'

// =============================================================================
// The interval timer — HIIT inside the session, not in another app.
//
// It opens already running: a five-second ready beat, then the block. There is
// no setup screen here on purpose — the plan arrives from the coach's
// prescription or from the one-sheet builder, and the only decisions left are
// pause, skip and end.
//
// Time is wall-clock against a start stamp, never a counter: a locked phone, a
// backgrounded app or a throttled tab comes back to exactly the right second,
// with the rounds it slept through already banked. Rounds are reported as they
// finish (onProgress), so the set grid behind this screen — and the draft that
// autosaves it — holds the work even if the phone dies mid-block.
//
// Motion follows the brand's one idea, things converge on the answer: every
// phase change locks the brackets back on and the phase word tightens onto
// itself. The last three seconds of any phase pulse with the count. Nothing
// loops that isn't the clock itself.
// =============================================================================

export interface IntervalResult {
  rpe: number | null
  /** The athlete chose to finish the whole session from here. */
  finishSession: boolean
}

interface Props {
  name: string
  plan: IntervalPlan
  /** Nothing else in the session is waiting to be logged once this is done. */
  lastInSession: boolean
  onProgress: (done: number[]) => void
  onClose: (result: IntervalResult) => void
}

const PHASE_WORD: Record<PhaseKind, string> = {
  ready: 'Get ready',
  work: 'Work',
  rest: 'Rest',
  break: 'Set break',
}

const RPE_SCALE = [6, 7, 8, 9, 10]

// The ring. Big enough to read from across a turf lane, inside a 320px phone.
const R = 128
const CIRC = 2 * Math.PI * R

function nextLine(timeline: Phase[], index: number): string {
  const next = timeline[index + 1]
  if (!next) return 'Last one — empty the tank'
  if (next.kind === 'work') return `Next · round ${next.round}`
  if (next.kind === 'rest') return `Next · rest ${fmtDuration(next.secs)}`
  return `Next · ${fmtDuration(next.secs)} break`
}

export function IntervalTimer({ name, plan, lastInSession, onProgress, onClose }: Props) {
  const timeline = useMemo(() => buildTimeline(plan), [plan])
  const totalRounds = plan.rounds * plan.sets

  // Clock state lives in refs: the frame loop reads it sixty times a second and
  // must never wait on a render.
  const startRef = useRef(Date.now())
  const pausedAtRef = useRef<number | null>(null)
  const pausedTotalRef = useRef(0)
  const skipRef = useRef(0)

  const elapsed = useCallback(() => {
    const now = Date.now()
    const paused = pausedTotalRef.current + (pausedAtRef.current != null ? now - pausedAtRef.current : 0)
    return (now - startRef.current - paused) / 1000 + skipRef.current
  }, [])

  const [view, setView] = useState(() => ({ index: 0, secs: READY_SECONDS }))
  const [paused, setPaused] = useState(false)
  const [sound, setSound] = useState(() => intervalSoundOn())
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [finished, setFinished] = useState<{ done: number[]; complete: boolean; spent: number } | null>(null)
  const [rpe, setRpe] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)

  const ringRef = useRef<SVGCircleElement | null>(null)
  const lastIndexRef = useRef(0)
  const lastCountRef = useRef('')
  const lastHalfRef = useRef(-1)
  const lastDoneRef = useRef('')
  const finishedRef = useRef(false)
  const progressRef = useRef(onProgress)
  progressRef.current = onProgress

  useWakeLock(!finished)

  // The page under the timer must not scroll — same lock a Sheet takes.
  useEffect(() => {
    const root = document.getElementById('root')
    const prevBody = document.body.style.overflow
    const prevRoot = root?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (root) root.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevBody
      if (root) root.style.overflow = prevRoot
      releaseCueAudio()
    }
  }, [])

  const report = useCallback((done: number[]) => {
    const key = done.join(',')
    if (key === lastDoneRef.current) return
    lastDoneRef.current = key
    progressRef.current(done)
  }, [])

  const finish = useCallback((complete: boolean) => {
    if (finishedRef.current) return
    finishedRef.current = true
    const t = elapsed()
    const done = roundsDone(plan, timeline, t)
    report(done)
    if (done.every((n) => n === 0)) {
      // Ended before a single round landed: nothing to file, nothing to celebrate.
      onClose({ rpe: null, finishSession: false })
      return
    }
    cueDone()
    setFinished({ done, complete, spent: Math.min(blockSeconds(plan), Math.max(0, t - READY_SECONDS)) })
    setTimeout(() => setCounting(true), 380)
  }, [elapsed, onClose, plan, report, timeline])

  // One step of the clock. Called from the frame loop and from a slow interval
  // (frames stop when the tab is hidden; a throttled interval keeps the cues
  // going on the platforms that allow it). Idempotent: a step that finds
  // nothing new does nothing.
  const step = useCallback(() => {
    if (finishedRef.current) return
    const t = elapsed()
    const read = readClock(timeline, t)
    if (read.done) { finish(true); return }

    const ring = ringRef.current
    if (ring) {
      const frac = read.phase.secs > 0 ? read.remaining / read.phase.secs : 0
      ring.style.strokeDashoffset = String(CIRC * (1 - frac))
    }

    const secs = Math.ceil(read.remaining - 1e-6)
    if (read.index !== lastIndexRef.current) {
      lastIndexRef.current = read.index
      const k = read.phase.kind
      // The last round's go locks a chord: you hear it's the final push.
      if (k === 'work') cueGo(!timeline.slice(read.index + 1).some((p) => p.kind === 'work'))
      else if (k === 'rest' || k === 'break') cueRest()
      report(roundsDone(plan, timeline, t))
    }
    if (pausedAtRef.current == null && secs <= 3 && secs >= 1 && read.phase.secs > 3) {
      const key = `${read.index}:${secs}`
      if (lastCountRef.current !== key) {
        lastCountRef.current = key
        cueCount(secs)
      }
    }
    // Halfway through a round long enough to need telling — once per round.
    if (pausedAtRef.current == null && read.phase.kind === 'work' && read.phase.secs >= 20
      && secs === Math.ceil(read.phase.secs / 2) && lastHalfRef.current !== read.index) {
      lastHalfRef.current = read.index
      cueHalf()
    }
    setView((v) => (v.index === read.index && v.secs === secs ? v : { index: read.index, secs }))
  }, [elapsed, finish, plan, report, timeline])

  useEffect(() => {
    let raf = 0
    const loop = () => { step(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    const iv = setInterval(step, 250)
    document.addEventListener('visibilitychange', step)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(iv)
      document.removeEventListener('visibilitychange', step)
    }
  }, [step])

  const togglePause = useCallback(() => {
    if (finishedRef.current) return
    primeCueAudio()   // a tap: re-unlock in case iOS let the context lapse
    if (pausedAtRef.current == null) {
      pausedAtRef.current = Date.now()
      setPaused(true)
    } else {
      pausedTotalRef.current += Date.now() - pausedAtRef.current
      pausedAtRef.current = null
      setPaused(false)
    }
  }, [])

  // Skip moves the clock to the start of the next phase. Skipping the rest of a
  // work phase banks the round — the athlete decided it was done.
  const skip = useCallback(() => {
    if (finishedRef.current) return
    primeCueAudio()
    const read = readClock(timeline, elapsed())
    skipRef.current += read.remaining + 0.001
    step()
  }, [elapsed, step, timeline])

  // Space pauses on a keyboard; the timer is used on a laptop on a bike too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !finishedRef.current) { e.preventDefault(); togglePause() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [togglePause])

  useEffect(() => {
    if (!confirmEnd) return
    const t = setTimeout(() => setConfirmEnd(false), 3000)
    return () => clearTimeout(t)
  }, [confirmEnd])

  // ---- finished ---------------------------------------------------------------

  if (finished) {
    const doneRounds = finished.done.reduce((a, b) => a + b, 0)
    const workSecs = doneRounds * plan.work
    return (
      <div className="ivl ivl--finished" role="dialog" aria-modal="true" aria-label={`${name} intervals done`}>
        <div className="ivl__glow ivl__glow--done" aria-hidden />
        <div className="ivl__finish">
          <LockOn style={{ '--lock-gap': '-14px', '--lock-from': '22px' } as React.CSSProperties}>
            <span className="zeroed-moment__mark">
              <Check size={36} strokeWidth={2.75} style={{ color: 'var(--signal)' }} />
            </span>
          </LockOn>
          <p className="eyebrow zeroed-moment__eyebrow converge">
            {finished.complete ? 'Intervals zeroed' : 'Intervals logged'}
          </p>
          <h1 className="screen-title zeroed-moment__title">{name}</h1>

          <div className="zeroed-moment__stats">
            <div>
              <span className="zeroed-moment__stat-value">
                <TickingNumber value={counting ? doneRounds : 0} duration={600} />
                <span className="ivl__of">/{totalRounds}</span>
              </span>
              <span className="eyebrow zeroed-moment__stat-label">rounds</span>
            </div>
            <div>
              <span className="zeroed-moment__stat-value">{fmtClock(workSecs)}</span>
              <span className="eyebrow zeroed-moment__stat-label">work</span>
            </div>
            <div>
              <span className="zeroed-moment__stat-value">{fmtClock(finished.spent)}</span>
              <span className="eyebrow zeroed-moment__stat-label">total</span>
            </div>
          </div>

          <div className="ivl__rpe">
            <p className="eyebrow" style={{ marginBottom: 10 }}>How hard? <span className="text-dim">optional</span></p>
            <div className="ivl__rpe-row" role="radiogroup" aria-label="Effort, RPE">
              {RPE_SCALE.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={rpe === v}
                  className={`rpe-pop__btn${rpe === v ? ' rpe-pop__btn--on' : ''}`}
                  onClick={() => setRpe(rpe === v ? null : v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="ivl__finish-actions">
            {lastInSession ? (
              <>
                <button type="button" className="btn btn--primary btn--full" onClick={() => onClose({ rpe, finishSession: true })}>
                  Finish session →
                </button>
                <button type="button" className="btn btn--ghost btn--full" style={{ marginTop: 6 }} onClick={() => onClose({ rpe, finishSession: false })}>
                  Back to session
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--primary btn--full" onClick={() => onClose({ rpe, finishSession: false })}>
                Done →
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ---- running ------------------------------------------------------------------

  const phase = timeline[view.index]
  const kind: PhaseKind | 'paused' = paused ? 'paused' : phase.kind
  const final = !paused && view.secs <= 3 && phase.secs > 3
  const doneNow = roundsDone(plan, timeline, phase.start)   // rounds banked before this phase
  const bigText = view.secs >= 60 ? fmtClock(view.secs) : String(view.secs)
  const left = Math.max(0, timeline[timeline.length - 1].start + timeline[timeline.length - 1].secs - (phase.start + phase.secs - view.secs))

  return (
    <div
      className={`ivl ivl--${kind}${final ? ' ivl--final' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} intervals`}
    >
      <div className="ivl__glow ivl__glow--ready" aria-hidden />
      <div className="ivl__glow ivl__glow--work" aria-hidden />
      <div className="ivl__glow ivl__glow--rest" aria-hidden />
      {/* A full-screen wash in the new phase's colour — the change you catch in
          your peripheral vision with your head down on the bike. */}
      {!paused && view.index > 0 && <div key={`flash-${view.index}`} className="ivl__flash" aria-hidden />}

      <div className="ivl__top">
        <button
          type="button"
          className={`ivl__end${confirmEnd ? ' ivl__end--armed' : ''}`}
          onClick={() => (confirmEnd ? finish(false) : setConfirmEnd(true))}
        >
          {confirmEnd ? 'Tap to end' : 'End'}
        </button>
        <span className="ivl__left num" aria-label={`${fmtClock(left)} left`}>{fmtClock(left)} left</span>
        <button
          type="button"
          className="ivl__icon"
          aria-label={sound ? 'Mute cues' : 'Unmute cues'}
          aria-pressed={!sound}
          onClick={() => { const next = !sound; setSound(next); setIntervalSound(next); if (next) primeCueAudio() }}
        >
          {sound ? <Volume2 size={22} strokeWidth={1.9} /> : <VolumeX size={22} strokeWidth={1.9} />}
        </button>
      </div>

      <div className="ivl__head">
        <p className="ivl__name">{name}</p>
        <p className="ivl__round num">
          {phase.kind === 'ready'
            ? describePlan(plan)
            : <>Round {phase.round}<span className="text-dim">/{plan.rounds}</span>{plan.sets > 1 && <> · Set {phase.set}<span className="text-dim">/{plan.sets}</span></>}</>}
        </p>
      </div>

      <button
        type="button"
        className="ivl__dial"
        onClick={togglePause}
        aria-label={paused ? 'Resume' : 'Pause'}
      >
        <svg className="ivl__ring" viewBox="0 0 300 300" aria-hidden>
          {/* Reticle ticks — the instrument the wordmark is named for. */}
          {Array.from({ length: 48 }, (_, i) => {
            const a = (i / 48) * Math.PI * 2
            const major = i % 12 === 0
            const r1 = major ? 140 : 143
            const r2 = 148
            return (
              <line
                key={i}
                className={major ? 'ivl__tick ivl__tick--major' : 'ivl__tick'}
                x1={150 + r1 * Math.sin(a)} y1={150 - r1 * Math.cos(a)}
                x2={150 + r2 * Math.sin(a)} y2={150 - r2 * Math.cos(a)}
              />
            )
          })}
          <circle className="ivl__track" cx="150" cy="150" r={R} />
          <circle
            ref={ringRef}
            className="ivl__arc"
            cx="150" cy="150" r={R}
            strokeDasharray={CIRC}
            strokeDashoffset={0}
            transform="rotate(-90 150 150)"
          />
        </svg>
        <LockOn
          key={`lock-${view.index}-${paused ? 'p' : 'r'}`}
          className="ivl__lock"
          style={{ '--lock-gap': '-26px', '--lock-from': '30px', '--lock-size': '18px', '--lock-color': 'var(--ivl-color)' } as React.CSSProperties}
        >
          <span className="ivl__readout">
            <span key={final ? `n-${view.index}-${view.secs}` : 'n'} className={`ivl__num num${bigText.length > 2 ? ' ivl__num--long' : ''}${final ? ' ivl__num--count' : ''}`}>
              {bigText}
            </span>
            <span key={`w-${view.index}-${kind}`} className="ivl__word">
              {paused ? 'Paused' : PHASE_WORD[phase.kind]}
            </span>
          </span>
        </LockOn>
      </button>

      <p className="ivl__next">{paused ? 'Tap the dial to resume' : nextLine(timeline, view.index)}</p>

      {/* Every round in the block, banked ones filled. Sets sit apart. */}
      <div className="ivl__track-rounds" aria-label={`${doneNow.reduce((a, b) => a + b, 0)} of ${totalRounds} rounds done`}>
        {Array.from({ length: plan.sets }, (_, s) => (
          <div key={s} className="ivl__set">
            {Array.from({ length: plan.rounds }, (_, r) => {
              const banked = r < doneNow[s]
              const current = phase.kind === 'work' && phase.set === s + 1 && phase.round === r + 1
              return (
                <span
                  key={r}
                  className={`ivl__seg${banked ? ' ivl__seg--done' : ''}${current ? ' ivl__seg--now' : ''}`}
                />
              )
            })}
          </div>
        ))}
      </div>

      <div className="ivl__controls">
        <span className="ivl__ctl-spacer" aria-hidden />
        <button
          type="button"
          className="ivl__ctl ivl__ctl--main"
          onClick={togglePause}
          aria-label={paused ? 'Resume' : 'Pause'}
        >
          {paused ? <Play size={30} strokeWidth={2.2} fill="currentColor" /> : <Pause size={30} strokeWidth={2.2} fill="currentColor" />}
        </button>
        <button type="button" className="ivl__ctl" onClick={skip} aria-label="Skip to the next phase">
          <SkipForward size={22} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
