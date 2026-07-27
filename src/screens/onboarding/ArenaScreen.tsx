import { useState } from 'react'
import { Button } from '../../components/ui'
import {
  ARENA_TYPES, ARENA_META, classifyArena, type ArenaType,
} from '../../engine/demandTables'

/**
 * Move 1 — THE ARENA (Convergence §3). The entry gate. "What do you want to be
 * able to do?" Six tappable archetypes, each a decompression key, with a
 * free-text escape hatch. A tap sets arena_type explicitly; free text is
 * classified deterministically (keyword v1 — agent refinement rides the extended
 * probe in Phase D, never a new pre-auth call).
 *
 * Cold, no hype. The screen captures the heading; the specifics ("basketball",
 * "285 bench") come from the optional own-words field and feed matchSport /
 * matchLift downstream.
 */
export interface ArenaAnswer {
  type: ArenaType
  raw: string
  confidence: 'high' | 'low'   // 'low' ⇒ free text fell through to the default cloud
}

export function ArenaScreen({
  initial,
  onSubmit,
}: {
  initial?: ArenaAnswer | null
  onSubmit: (answer: ArenaAnswer) => void
}) {
  const [selected, setSelected] = useState<ArenaType | null>(initial?.type ?? null)
  const [text, setText] = useState(initial?.raw ?? '')

  const canContinue = selected !== null || text.trim().length > 0

  function handleContinue() {
    const raw = text.trim()
    if (selected) {
      // Explicit tap owns the type; text (if any) carries the specifics.
      onSubmit({ type: selected, raw: raw || ARENA_META[selected].label, confidence: 'high' })
      return
    }
    // No tap — classify the free text (keyword v1). Falls back to all_around.
    const c = classifyArena(raw)
    onSubmit({ type: c.type, raw, confidence: c.confidence })
  }

  const placeholder = selected
    ? `e.g. ${ARENA_META[selected].example}`
    : 'Or say it in your own words'

  return (
    <div className="screen--centered">
      <div style={{ width: '100%', maxWidth: 460 }}>
        <h1
          className="fade-rise screen-title"
          style={{ textAlign: 'center', marginBottom: 28 }}
        >
          What do you want to be able to do?
        </h1>

        <div
          className="fade-rise fade-rise-delay-1"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
          }}
        >
          {ARENA_TYPES.map((type) => {
            const meta = ARENA_META[type]
            const isSel = selected === type
            return (
              <button
                key={type}
                type="button"
                onClick={() => setSelected(isSel ? null : type)}
                style={{
                  textAlign: 'left',
                  minHeight: 88,
                  padding: '16px 16px',
                  borderRadius: 12,
                  background: isSel ? 'rgba(232,204,10,0.06)' : 'var(--surface)',
                  border: `1px solid ${isSel ? 'var(--signal)' : 'var(--line)'}`,
                  cursor: 'pointer',
                  transition: 'border-color .15s ease, background .15s ease',
                }}
              >
                <div
                  style={{
                    fontSize: 'var(--fs-lg)',
                    fontWeight: 700,
                    color: isSel ? 'var(--signal)' : 'var(--text)',
                    marginBottom: 5,
                  }}
                >
                  {meta.label}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                  {meta.example}
                </div>
              </button>
            )
          })}
        </div>

        <input
          className="input fade-rise fade-rise-delay-2"
          type="text"
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          style={{ marginTop: 14 }}
        />

        <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 28 }}>
          <Button variant="primary" full disabled={!canContinue} onClick={handleContinue}>
            Continue →
          </Button>
        </div>
      </div>
    </div>
  )
}
