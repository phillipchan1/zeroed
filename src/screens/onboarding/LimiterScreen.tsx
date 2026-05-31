import { useState } from 'react'
import { Button } from '../../components/ui'
import {
  getLimiterQuestion, resolveLimiter, matchSport, matchLift,
  type ArenaType,
} from '../../engine/demandTables'

/**
 * Move 2 — THE LIMITER (Convergence §3). The adaptive wedge. A forced choice
 * between the dominant competing hypotheses FOR THIS arena — the question and
 * options are a deterministic lookup keyed on arena_type (the §3 per-arena
 * table). Each option sends convergence down a different heading.
 *
 * The obstacle folds in HERE as the optional free-text feeder (it is no longer
 * its own beat). It refines the §4c keyword→limiter prior and still feeds the
 * downstream probe; leaving it blank is fine — the forced choice alone resolves
 * a limiter.
 *
 * v1 selection is the deterministic map (resolveLimiter). v2 swaps in
 * callInfoGain to pick the highest-information cut: the SEAM is the
 * `options`/`question` source — replace getLimiterQuestion with an agent-chosen
 * spec and the rest of this screen is unchanged (ok:false ⇒ keep this map).
 */
export interface LimiterAnswer {
  choice: string          // the option axis key tapped
  obstacle: string        // the free-text feeder ('' if skipped)
}

export function LimiterScreen({
  arenaType,
  arenaRaw,
  initialChoice,
  initialObstacle,
  onSubmit,
}: {
  arenaType: ArenaType
  arenaRaw: string | null
  initialChoice?: string | null
  initialObstacle?: string
  onSubmit: (answer: LimiterAnswer) => void
}) {
  const q = getLimiterQuestion(arenaType)
  const [choice, setChoice] = useState<string | null>(initialChoice ?? null)
  const [obstacle, setObstacle] = useState(initialObstacle ?? '')

  const sportKey = arenaType === 'sport' ? matchSport(arenaRaw) : null
  const liftKey = arenaType === 'number' ? matchLift(arenaRaw) : null

  function handleContinue() {
    if (!choice) return
    onSubmit({ choice, obstacle: obstacle.trim() })
  }

  return (
    <div className="screen--centered">
      <div style={{ width: '100%', maxWidth: 460 }}>
        <p className="section-header fade-rise" style={{ marginBottom: 14, textAlign: 'center' }}>
          THE WEDGE
        </p>
        <h1
          className="fade-rise fade-rise-delay-1"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            lineHeight: 1.3,
            textAlign: 'center',
            marginBottom: 24,
          }}
        >
          {q.question}
        </h1>

        <div
          className="fade-rise fade-rise-delay-2"
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {q.options.map((opt) => {
            const isSel = choice === opt.axis
            // Preview the resolved limiter so the option reads as a real read,
            // not a bare label (deterministic — the same call the read uses).
            const resolved = resolveLimiter({
              arenaType, optionKey: opt.axis, sportKey, liftKey, obstacle: obstacle.trim() || null,
            })
            return (
              <button
                key={opt.axis}
                type="button"
                onClick={() => setChoice(isSel ? null : opt.axis)}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: isSel ? 'rgba(232,204,10,0.06)' : 'var(--surface)',
                  border: `1px solid ${isSel ? 'var(--signal)' : 'var(--line)'}`,
                  cursor: 'pointer',
                  transition: 'border-color .15s ease, background .15s ease',
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    fontWeight: 700,
                    color: isSel ? 'var(--signal)' : 'var(--text)',
                    marginBottom: 4,
                  }}
                >
                  {opt.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.35 }}>
                  {resolved.label}
                </div>
              </button>
            )
          })}
        </div>

        {/* The obstacle feeder — folded in here, optional. */}
        <textarea
          className="input fade-rise fade-rise-delay-3"
          value={obstacle}
          placeholder="Anything specific getting in the way? (optional)"
          onChange={(e) => setObstacle(e.target.value)}
          rows={2}
          style={{ marginTop: 16, fontSize: 14, lineHeight: 1.5 }}
        />

        <div className="fade-rise fade-rise-delay-4" style={{ marginTop: 20 }}>
          <Button variant="primary" full disabled={!choice} onClick={handleContinue}>
            Continue →
          </Button>
        </div>
      </div>
    </div>
  )
}
