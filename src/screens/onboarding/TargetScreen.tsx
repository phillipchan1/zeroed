import { useEffect, useRef, useState } from 'react'
import { Logo, Button, PresenceDot } from '../../components/ui'
import { generateTargetPrompt } from '../../engine'

/**
 * Orientation · The Target ("what are you chasing?")
 *
 * The durable anchor. Not a blank field — the agent infers a tailored question
 * and a concrete suggestion from the obstacle + the working hypothesis, so the
 * system looks like it was listening ("Your bench is stuck around 265 — what
 * number are you chasing?" → pre-filled "285 lb bench"). The athlete confirms or
 * edits. On model failure, a plain question with no pre-fill.
 */
export function TargetScreen({
  obstacle,
  hypothesis,
  initial,
  onNext,
}: {
  obstacle: string
  hypothesis?: { claim: string; category: string } | null
  initial?: string
  onNext: (target: string) => void
}) {
  const [loading, setLoading] = useState(true)
  const [question, setQuestion] = useState('What are you chasing?')
  const [value, setValue] = useState(initial ?? '')
  const ranRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      const prompt = await generateTargetPrompt(obstacle, hypothesis)
      setQuestion(prompt.question)
      if (!initial && prompt.suggested) setValue(prompt.suggested)
      setLoading(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="screen--centered">
        <p className="eyebrow fade-rise" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <PresenceDot />
          Reading what you're after
        </p>
      </div>
    )
  }

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--line)' }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <p className="eyebrow" style={{ marginBottom: 10 }}>What you're chasing</p>
          <h1 className="hero-headline" style={{ marginBottom: 24 }}>
            {question}
          </h1>
        </div>

        <div className="fade-rise fade-rise-delay-1">
          <input
            ref={inputRef}
            className="input"
            type="text"
            placeholder="e.g. 285 lb bench"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 28 }}>
          <Button variant="primary" full disabled={!value.trim()} onClick={() => onNext(value.trim())}>
            That's the target →
          </Button>
        </div>
      </div>
    </div>
  )
}
