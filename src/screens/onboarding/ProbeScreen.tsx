import { useEffect, useRef, useState } from 'react'
import { Logo, Button, TypeOn, PresenceDot } from '../../components/ui'
import { runDiagnosticAnalysisAgent, type ProbeOutcome } from '../../engine'

/**
 * The Probe (Act 2) — the new agentic surface, ~30s in.
 *
 * obstacle text → ONE adaptive follow-up question → an early, falsifiable
 * HYPOTHESIS insight with a live confidence number. This is the first felt
 * value, and it lands BEFORE auth. The model proposes (via the `probe` Edge
 * Function); deterministic code disposes — confidence is clamped low and the
 * read is always framed as still-sharpening, never as certainty.
 *
 * The agent call (runDiagnosticAnalysisAgent) can never throw: on model failure
 * it returns a deterministic fallback read, so this screen always advances.
 */

type Phase = 'reading' | 'followup' | 'sharpening' | 'reveal'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ProbeScreen({
  obstacle,
  onSaveRead,
}: {
  obstacle: string
  onSaveRead: (outcome: ProbeOutcome, followupAnswer: string | null) => void
}) {
  const [phase, setPhase] = useState<Phase>('reading')
  const [firstOutcome, setFirstOutcome] = useState<ProbeOutcome | null>(null)
  const [finalOutcome, setFinalOutcome] = useState<ProbeOutcome | null>(null)
  const [answer, setAnswer] = useState('')
  const ranRef = useRef(false)

  // First pass: read the obstacle alone. Hold a short visual beat so the
  // instrument reads deliberately rather than flashing.
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      const [outcome] = await Promise.all([
        safeProbe(obstacle),
        delay(1900),
      ])
      setFirstOutcome(outcome)
      if (outcome.followupQuestion) {
        setPhase('followup')
      } else {
        setFinalOutcome(outcome)
        setPhase('reveal')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function sharpen(followupAnswer: string) {
    setPhase('sharpening')
    const [outcome] = await Promise.all([
      safeProbe(obstacle, followupAnswer),
      delay(1600),
    ])
    // The refined read should never read as less sure than the first pass.
    const merged =
      firstOutcome && outcome.hypothesis.confidence < firstOutcome.hypothesis.confidence
        ? firstOutcome
        : outcome
    setFinalOutcome(merged)
    setPhase('reveal')
  }

  function skip() {
    setFinalOutcome(firstOutcome)
    setPhase('reveal')
  }

  if (phase === 'reading' || phase === 'sharpening') {
    return (
      <ReadingBeat
        lines={
          phase === 'reading'
            ? ['Reading what you told me', 'Finding the likely limiter']
            : ['Factoring in your answer', 'Sharpening the read']
        }
      />
    )
  }

  if (phase === 'followup' && firstOutcome?.followupQuestion) {
    return (
      <FollowupQuestion
        question={firstOutcome.followupQuestion}
        value={answer}
        onChange={setAnswer}
        onContinue={() => sharpen(answer.trim())}
        onSkip={skip}
      />
    )
  }

  // reveal
  const outcome = finalOutcome ?? firstOutcome
  if (!outcome) return <ReadingBeat lines={['Reading what you told me']} />

  return (
    <Reveal
      outcome={outcome}
      onSave={() => onSaveRead(outcome, answer.trim() || null)}
    />
  )
}

// runDiagnosticAnalysisAgent already falls back deterministically; this is a
// belt-and-braces guard so a thrown error still yields a usable read.
async function safeProbe(obstacle: string, followupAnswer?: string): Promise<ProbeOutcome> {
  try {
    return await runDiagnosticAnalysisAgent(obstacle, followupAnswer)
  } catch {
    return {
      source: 'fallback',
      followupQuestion: null,
      hypothesis: {
        claim: "We'll start conservative and sharpen the read as you train.",
        category: 'Lower Chain',
        confidence: 0.2,
        rationale: 'Could not reach the read just now; defaulting to a safe starting point.',
      },
    }
  }
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
            <p key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 14, letterSpacing: '0.02em', color: 'var(--text-dim)', lineHeight: 1.4 }}>
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
        <p className="section-header fade-rise" style={{ marginBottom: 16, textAlign: 'center' }}>
          ONE MORE THING
        </p>
        <h1
          className="fade-rise fade-rise-delay-1"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.3, textAlign: 'center', marginBottom: 24 }}
        >
          {question}
        </h1>
        <textarea
          className="input fade-rise fade-rise-delay-2"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          autoFocus
          placeholder="A sentence is plenty."
          style={{ fontSize: 15, lineHeight: 1.5 }}
        />
        <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 24 }}>
          <Button variant="primary" full disabled={!value.trim()} onClick={onContinue}>
            Continue →
          </Button>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ width: '100%', marginTop: 8, color: 'var(--text-dim)' }}
            onClick={onSkip}
          >
            Skip — go on the read so far
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfidenceMeter({ confidence }: { confidence: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100)
  const [w, setW] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => setW(pct), 80)
    return () => clearTimeout(id)
  }, [pct])
  return (
    <div className="confidence-meter">
      <div className="confidence-meter__head">
        <span className="confidence-meter__label">CONFIDENCE</span>
        <span className="num confidence-meter__pct">{pct}% · STILL SHARPENING</span>
      </div>
      <div className="confidence-meter__track">
        <div className="confidence-meter__fill" style={{ width: `${w}%` }} />
      </div>
    </div>
  )
}

function Reveal({ outcome, onSave }: { outcome: ProbeOutcome; onSave: () => void }) {
  const { hypothesis } = outcome
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px 0', borderBottom: '1px solid var(--line)', paddingBottom: 20 }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '40px 20px', maxWidth: 480, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <p className="section-header fade-rise" style={{ marginBottom: 12 }}>YOUR FIRST READ</p>

        {/* Layer 1 — warm headline */}
        <h1 className="hero-headline fade-rise fade-rise-delay-1">Here's where I'd look first.</h1>

        {/* Layer 2 — the hypothesis as cold telemetry */}
        <div className="card--data fade-rise fade-rise-delay-2" style={{ marginTop: 20 }}>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: 8 }}>
            {hypothesis.category.toUpperCase()} · HYPOTHESIS
          </p>
          <p className="text-sm" style={{ lineHeight: 1.5, marginBottom: 14 }}>{hypothesis.claim}</p>
          <ConfidenceMeter confidence={hypothesis.confidence} />
        </div>

        {/* Layer 3 — warm characterization */}
        <p className="hero-characterization fade-rise fade-rise-delay-3" style={{ marginTop: 20 }}>
          {hypothesis.rationale} This is an early read — every session you log sharpens it.
        </p>

        <div className="fade-rise fade-rise-delay-4" style={{ marginTop: 28 }}>
          <Button variant="primary" full onClick={onSave}>
            Save your read →
          </Button>
        </div>
      </div>
    </div>
  )
}
