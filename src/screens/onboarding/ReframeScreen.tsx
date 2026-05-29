import { Logo, Button, BracketFrame } from '../../components/ui'

/**
 * Screen 03 · The Reframe
 * First appearance of the cold-instrument / warm-voice formula in canonical
 * 3-layer form: warm headline → cold telemetry contract → warm characterization.
 * The system absorbs what they typed; it does not parrot it.
 */
export function ReframeScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px 0', borderBottom: '1px solid var(--line)', paddingBottom: 20 }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '40px 20px', maxWidth: 480, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div className="fade-rise" style={{ marginBottom: 32 }}>
          {/* Layer 1 — warm headline */}
          <h1 className="hero-headline">OK. Let's find out what's holding you back.</h1>

          {/* Layer 2 — cold telemetry contract */}
          <BracketFrame className="fade-rise fade-rise-delay-1" style={{ padding: 'var(--sp-4)', marginTop: 20 }}>
            <p className="hero-telemetry" style={{ margin: 0 }}>
              THE READ — 4 MIN MOVEMENT SCREEN · RANKED WEAK LINKS · YOUR PROGRAM · SESSION 1 READY
            </p>
          </BracketFrame>

          {/* Layer 3 — warm characterization */}
          <p className="hero-characterization fade-rise fade-rise-delay-2" style={{ marginTop: 20 }}>
            The screen shows us what your sport profile won't — how you'd actually hold up under load.
            We score honest, and rank what to fix first.
          </p>
        </div>

        <div className="fade-rise fade-rise-delay-3">
          <Button variant="primary" full onClick={onStart}>
            Start the Read →
          </Button>
        </div>
      </div>
    </div>
  )
}
