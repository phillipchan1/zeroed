import { useEffect, useRef, useState } from 'react'
import { buildProvisionalProgram, type ProvisionalProfile } from '../../engine'
import { Button, TypeOn, TickingNumber, PresenceDot } from '../../components/ui'

/**
 * Calibrating your first session (Confidence-Driven Read).
 *
 * Replaces the legacy ComputeScreen. No diagnostic, no movement screen — the
 * provisional session is built from the probe hypothesis behind a short cyan
 * compute beat (the doctrine's "system working" register). The real work
 * (buildProvisionalProgram: agent → safety validator → deterministic floor →
 * inserts) runs once behind the visual; we advance when both the beat and the
 * build have finished. Idempotent, so a reload mid-build is safe.
 */

const LINES = [
  'Reading your obstacle',
  'Factoring your training age',
  'Designing session one',
  'Clamping load for safety',
  'Ready',
]

const LINE_GAP = 1500
const FINAL_HOLD = 1400

interface CalibrateProps {
  athleteId: string
  profile: ProvisionalProfile
  onComplete: () => void
}

export function CalibrateScreen({ athleteId, profile, onComplete }: CalibrateProps) {
  const [visibleLines, setVisibleLines] = useState(0)
  const [beatDone, setBeatDone] = useState(false)
  const [engineDone, setEngineDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [targets, setTargets] = useState({ insights: 0, p1: 0 })
  const ranRef = useRef(false)

  // Visual beat
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (let i = 0; i < LINES.length; i++) {
      timers.push(setTimeout(() => setVisibleLines(i + 1), i * LINE_GAP))
    }
    timers.push(setTimeout(() => setBeatDone(true), (LINES.length - 1) * LINE_GAP + FINAL_HOLD))
    return () => timers.forEach(clearTimeout)
  }, [])

  // Real build (once)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void runBuild()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runBuild() {
    setError(null)
    try {
      const today = new Date().toISOString().split('T')[0]
      const result = await buildProvisionalProgram(athleteId, profile, today)
      setTargets({ insights: result.insightCount, p1: result.p1Count })
      setEngineDone(true)
    } catch (err) {
      console.error('provisional build failed', err)
      setError('Something broke building your session. Tap to retry.')
    }
  }

  useEffect(() => {
    if (beatDone && engineDone && !error) onComplete()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatDone, engineDone, error])

  function handleRetry() {
    ranRef.current = false
    setEngineDone(false)
    void runBuild()
  }

  if (error) {
    return (
      <div className="screen--centered">
        <p className="text-dim" style={{ marginBottom: 16, textAlign: 'center', maxWidth: 320 }}>{error}</p>
        <Button variant="outline" onClick={handleRetry}>Retry</Button>
      </div>
    )
  }

  return (
    <div
      className="thinking-shimmer"
      style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--ground)' }}
    >
      <div className="telemetry-strip">
        <span className="telemetry-strip__item"><PresenceDot /></span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">CALIBRATING</span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">
          READ <TickingNumber value={targets.insights} className="num" />
        </span>
        <span className="telemetry-strip__sep">·</span>
        <span className={`telemetry-strip__item${targets.p1 > 0 ? ' telemetry-strip__signal' : ''}`}>
          P1 <TickingNumber value={targets.p1} className="num" />
        </span>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 24px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {LINES.slice(0, visibleLines).map((line, i) => (
            <p key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-base)', letterSpacing: '0.02em', color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <span style={{ color: 'var(--computing)' }}>{'> '}</span>
              <TypeOn text={line} delay={60} />
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
