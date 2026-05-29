import { Logo, Button, TypeOn } from '../../components/ui'

/**
 * Screen 06 · The Acknowledgment
 * Where the system proves it READ what they entered, not just stored it. Built
 * deterministically — name + context + the verbatim obstacle quote. The opening
 * line and the quote type on for a beat of presence; the data and instruction
 * render plainly. (Prompt 3 replaces the concatenation with a real agent.)
 */
export function AcknowledgmentScreen({
  name,
  sport,
  trainingAge,
  sessions,
  obstacle,
  onRun,
  onBack,
}: {
  name: string
  sport: string
  trainingAge: number
  sessions: number
  obstacle: string
  onRun: () => void
  onBack: () => void
}) {
  const opener = `OK${name.trim() ? ` ${name.trim()}` : ''}.`
  const ageStr = `${trainingAge} ${trainingAge === 1 ? 'year' : 'years'} training`
  const sessionStr = `${sessions} sessions/week`
  const sportStr = sport.trim() ? `${sport.trim().toLowerCase()} right now` : ''
  const dataSentence = [ageStr, sessionStr, sportStr].filter(Boolean).join(', ')
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
            We're going to run 7 movement patterns next. Each one tells us something specific about how
            you'd hold up under load. Score honest — the goal is to find what's limiting you, not to look good.
          </p>
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 36, display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
          <Button variant="primary" onClick={onRun} style={{ flex: 2 }}>Run the screen →</Button>
        </div>
      </div>
    </div>
  )
}
