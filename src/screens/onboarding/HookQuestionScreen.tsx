import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui'

/**
 * Screen 02 · The Question
 * "What's getting in your way?" — obstacles are concrete where goals are
 * aspirational. One sentence in, and we have a goldmine of intelligence.
 */

const GHOST_PROMPTS = [
  'Hit a plateau',
  "Knee's been off",
  'Coming back from a break',
  'Want to be stronger by August',
]

const SEEDS: Array<{ pill: string; seed: string }> = [
  { pill: 'PLATEAU',    seed: 'Hit a plateau — ' },
  { pill: 'INJURY',     seed: "Something's been bothering me — " },
  { pill: 'RETURN',     seed: 'Coming back after time off — ' },
  { pill: 'SPORT PREP', seed: 'Getting ready for my season — ' },
]

export function HookQuestionScreen({
  initial,
  onSubmit,
}: {
  initial?: string
  onSubmit: (obstacle: string) => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [ghostIdx, setGhostIdx] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Cycle the ghost prompt only while the field is empty.
  useEffect(() => {
    if (value.trim()) return
    const id = setInterval(() => setGhostIdx((i) => (i + 1) % GHOST_PROMPTS.length), 2500)
    return () => clearInterval(id)
  }, [value])

  function applySeed(seed: string) {
    setValue(seed)
    // Drop the cursor at the end so the athlete keeps typing the specifics.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(seed.length, seed.length)
      }
    })
  }

  const canSubmit = value.trim().length > 0

  return (
    <div className="screen--centered">
      <div style={{ width: '100%', maxWidth: 420 }}>
        <h1
          className="fade-rise"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
            textAlign: 'center',
            marginBottom: 28,
          }}
        >
          What's getting in your way?
        </h1>

        <textarea
          ref={textareaRef}
          className="input fade-rise fade-rise-delay-1"
          placeholder={GHOST_PROMPTS[ghostIdx]}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          autoFocus
          style={{ lineHeight: 1.5 }}
        />

        <div
          className="fade-rise fade-rise-delay-2"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}
        >
          {SEEDS.map(({ pill, seed }) => (
            <button
              key={pill}
              type="button"
              onClick={() => applySeed(seed)}
              style={{
                height: 30,
                padding: '0 12px',
                borderRadius: 999,
                background: 'transparent',
                border: '1px solid var(--line)',
                color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.08em',
                cursor: 'pointer',
                transition: 'color .15s ease, border-color .15s ease',
              }}
            >
              {pill}
            </button>
          ))}
        </div>

        <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 28 }}>
          <Button
            variant="primary"
            full
            disabled={!canSubmit}
            onClick={() => onSubmit(value.trim())}
          >
            Continue →
          </Button>
        </div>
      </div>
    </div>
  )
}
