import { Logo, Button, TypeOn } from '../../components/ui'

/**
 * Orientation · The Acknowledgment
 * Proves the system READ what they entered, then hands off to the provisional
 * build. No movement screen — the next thing is a real session, calibrated to
 * the training context and the early read. Built deterministically (name +
 * context + the verbatim obstacle quote).
 */
export function AcknowledgmentScreen({
  name,
  trainingAge,
  sessions,
  obstacle,
  onRun,
  onBack,
}: {
  name: string
  trainingAge: number
  sessions: number
  obstacle: string
  onRun: () => void
  onBack: () => void
}) {
  const opener = `OK${name.trim() ? ` ${name.trim()}` : ''}.`
  const ageStr = `${trainingAge} ${trainingAge === 1 ? 'year' : 'years'} training`
  const sessionStr = `${sessions} sessions/week`
  const dataSentence = [ageStr, sessionStr].join(', ')
  const obstacleQuote = obstacle.trim()

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--line)' }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '40px 20px', maxWidth: 480, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div className="fade-rise">
          <h1 className="hero-headline" style={{ marginBottom: 20 }}>
            <TypeOn text={opener} delay={50} />
          </h1>

          <p className="hero-characterization" style={{ marginBottom: 4 }}>
            {dataSentence},
          </p>
          {obstacleQuote && (
            <p className="hero-characterization" style={{ color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 24 }}>
              “<TypeOn text={obstacleQuote} delay={28} />”
            </p>
          )}

          <p className="hero-characterization" style={{ marginTop: obstacleQuote ? 0 : 24 }}>
            I'll build your first session around that — light, and aimed at the early read. You'll
            train; I'll keep sharpening the read underneath. No screen to sit through first.
          </p>
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 36, display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
          <Button variant="primary" onClick={onRun} style={{ flex: 2 }}>Build my first session →</Button>
        </div>
      </div>
    </div>
  )
}
