import { useEffect, useRef, useState } from 'react'
import { Logo, Button, TypeOn, PresenceDot } from '../../components/ui'
import { ConvergenceReticle } from '../../components/convergence/ConvergenceReticle'
import { synthesizeRead, type ReadSynthesis } from '../../engine'
import type { ArenaType, ReadAxis } from '../../engine/demandTables'

/**
 * The Probe / First Read (Act 2) — the multi-axis synthesis, ~30s in.
 *
 * Three answers (arena, limiter, + the obstacle feeder) → a multi-axis read
 * stack: heading / primary limiter / secondary suspect / durability / capacity.
 * Deterministic code (buildReadSkeleton) owns the structure; the agent drafts the
 * claim language on top. synthesizeRead never throws and always falls back to a
 * coherent table-only read — so this screen always advances, and the read is
 * always framed as still-sharpening, never as certainty.
 */

type Phase = 'reading' | 'followup' | 'sharpening' | 'reveal'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ProbeScreen({
  arenaType,
  arenaRaw,
  limiterChoice,
  obstacle,
  arenaConfidence,
  onSaveRead,
}: {
  arenaType: ArenaType
  arenaRaw: string | null
  limiterChoice: string | null
  obstacle: string
  arenaConfidence: 'high' | 'low'
  onSaveRead: (read: ReadSynthesis, followupAnswer: string | null) => void
}) {
  const [phase, setPhase] = useState<Phase>('reading')
  const [firstRead, setFirstRead] = useState<ReadSynthesis | null>(null)
  const [finalRead, setFinalRead] = useState<ReadSynthesis | null>(null)
  const [answer, setAnswer] = useState('')
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      const [read] = await Promise.all([safeSynthesize(), delay(1900)])
      setFirstRead(read)
      if (read.followupQuestion) {
        setPhase('followup')
      } else {
        setFinalRead(read)
        setPhase('reveal')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function safeSynthesize(followupAnswer?: string): Promise<ReadSynthesis> {
    try {
      return await synthesizeRead({
        arenaType, arenaRaw, limiterChoice, obstacle, arenaConfidence, followupAnswer,
      })
    } catch {
      // Last-ditch belt-and-braces — synthesizeRead already falls back internally.
      return {
        source: 'fallback',
        followupQuestion: null,
        axes: [],
        aggregateConfidence: 0.2,
        hypothesis: {
          claim: "We'll start conservative and sharpen the read as you train.",
          category: 'Lower Chain',
          confidence: 0.2,
          rationale: 'Could not reach the read just now; defaulting to a safe starting point.',
        },
      }
    }
  }

  async function sharpen(followupAnswer: string) {
    setPhase('sharpening')
    const [read] = await Promise.all([safeSynthesize(followupAnswer), delay(1600)])
    // The refined read should never read as less sure than the first pass.
    const merged =
      firstRead && read.aggregateConfidence < firstRead.aggregateConfidence ? firstRead : read
    setFinalRead(merged)
    setPhase('reveal')
  }

  function skip() {
    setFinalRead(firstRead)
    setPhase('reveal')
  }

  if (phase === 'reading' || phase === 'sharpening') {
    return (
      <ReadingBeat
        lines={
          phase === 'reading'
            ? ['Reading your arena and limiter', 'Collapsing the read across axes']
            : ['Factoring in your answer', 'Sharpening the read']
        }
      />
    )
  }

  if (phase === 'followup' && firstRead?.followupQuestion) {
    return (
      <FollowupQuestion
        question={firstRead.followupQuestion}
        value={answer}
        onChange={setAnswer}
        onContinue={() => sharpen(answer.trim())}
        onSkip={skip}
      />
    )
  }

  const read = finalRead ?? firstRead
  if (!read) return <ReadingBeat lines={['Reading what you told me']} />

  return <Reveal read={read} onSave={() => onSaveRead(read, answer.trim() || null)} />
}

// ---- sub-views -------------------------------------------------------------

function ReadingBeat({ lines }: { lines: string[] }) {
  const [visible, setVisible] = useState(0)
  useEffect(() => {
    const timers = lines.map((_, i) => setTimeout(() => setVisible(i + 1), i * 900))
    return () => timers.forEach(clearTimeout)
  }, [lines.length])

  return (
    <div
      className="thinking-shimmer"
      style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--ground)' }}
    >
      <div className="telemetry-strip">
        <span className="telemetry-strip__item"><PresenceDot /></span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">READING</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 24px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {lines.slice(0, visible).map((line, i) => (
            <p key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-base)', letterSpacing: '0.02em', color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <span style={{ color: 'var(--signal)' }}>{'> '}</span>
              <TypeOn text={line} delay={60} />
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}

function FollowupQuestion({
  question,
  value,
  onChange,
  onContinue,
  onSkip,
}: {
  question: string
  value: string
  onChange: (v: string) => void
  onContinue: () => void
  onSkip: () => void
}) {
  return (
    <div className="screen--centered">
      <div style={{ width: '100%', maxWidth: 420 }}>
        <p className="eyebrow fade-rise" style={{ marginBottom: 16, textAlign: 'center' }}>
          One more thing
        </p>
        <h1 className="fade-rise fade-rise-delay-1 screen-title" style={{ textAlign: 'center', marginBottom: 28 }}>
          {question}
        </h1>
        <textarea
          className="input fade-rise fade-rise-delay-2"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          autoFocus
          placeholder="A sentence is plenty."
          style={{ lineHeight: 1.5 }}
        />
        <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 28 }}>
          <Button variant="primary" full disabled={!value.trim()} onClick={onContinue}>
            Continue →
          </Button>
          <Button variant="ghost" full style={{ marginTop: 8 }} onClick={onSkip}>
            Skip
          </Button>
        </div>
      </div>
    </div>
  )
}

function AxisRow({ axis, index }: { axis: ReadAxis; index: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, axis.confidence)) * 100)
  const [w, setW] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => setW(pct), 120 + index * 90)
    return () => clearTimeout(id)
  }, [pct, index])
  return (
    <div style={{ padding: '16px 0', borderTop: index === 0 ? 'none' : '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 10 }}>
        <span className="section-header">{axis.label}</span>
        <span className="num text-sm text-signal">{pct}%</span>
      </div>
      <p className="text-base" style={{ lineHeight: 1.5, marginBottom: 12 }}>{axis.claim}</p>
      <div className="confidence-meter__track">
        <div className="confidence-meter__fill" style={{ width: `${w}%`, transition: 'width .9s ease' }} />
      </div>
    </div>
  )
}

function Reveal({ read, onSave }: { read: ReadSynthesis; onSave: () => void }) {
  // Order: heading first, then the limiter stack, durability, capacity.
  const order: Record<string, number> = { heading: 0, limiter_p1: 1, limiter_p2: 2, durability: 3, capacity: 4 }
  const axes = [...read.axes].sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))
  // Per-axis confidences feed the reticle's multi-axis data shape (each point
  // narrows by its own axis), while the headline state uses the aggregate.
  const axisConfidences = axes.map((a) => a.confidence)

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px 0', borderBottom: '1px solid var(--line)', paddingBottom: 20 }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '32px 20px 40px', maxWidth: 520, margin: '0 auto', width: '100%' }}>
        <p className="eyebrow fade-rise" style={{ marginBottom: 16, textAlign: 'center' }}>Your first read</p>

        {/* The payoff — the cloud collapses from scattered to the read's real
            tightness on mount (state-driven, not a timer). The convergence visual. */}
        <div className="fade-rise fade-rise-delay-1" style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 24px' }}>
          <ConvergenceReticle
            confidence={read.aggregateConfidence}
            axes={axisConfidences}
            size={180}
            animateInFrom={0}
          />
        </div>

        <h1 className="hero-headline fade-rise fade-rise-delay-2" style={{ marginBottom: 8, textAlign: 'center' }}>
          Here's the read.
        </h1>
        <p className="text-base text-dim fade-rise fade-rise-delay-2" style={{ marginBottom: 24, textAlign: 'center' }}>
          A hypothesis. Every session you log sharpens it.
        </p>

        <div className="card fade-rise fade-rise-delay-3" style={{ padding: '4px 20px' }}>
          {axes.map((axis, i) => (
            <AxisRow key={axis.id} axis={axis} index={i} />
          ))}
        </div>

        <div className="fade-rise fade-rise-delay-4" style={{ marginTop: 32 }}>
          <Button variant="primary" full onClick={onSave}>
            Save your read →
          </Button>
        </div>
      </div>
    </div>
  )
}
