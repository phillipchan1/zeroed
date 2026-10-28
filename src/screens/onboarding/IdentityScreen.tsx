import { Logo, Button, Input } from '../../components/ui'

/**
 * Orientation · Name (optional)
 * One field, optional. Name is warmth, not data — the read doesn't need it. The
 * athlete can skip straight through.
 */
export function IdentityScreen({
  name,
  onChange,
  onNext,
  onBack,
}: {
  name: string
  onChange: (value: string) => void
  onNext: () => void
  onBack: () => void
}) {
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--line)' }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <p className="eyebrow" style={{ marginBottom: 10 }}>Calibrating your session</p>
          <h1 className="hero-headline" style={{ marginBottom: 10 }}>
            What should I call you?
          </h1>
          <p className="text-sm text-dim" style={{ marginBottom: 28 }}>Optional — skip it if you'd rather.</p>
        </div>

        <div className="fade-rise fade-rise-delay-1">
          <Input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => onChange(e.target.value)}
            autoCapitalize="words"
            autoFocus
          />
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 32, display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
          <Button variant="primary" onClick={onNext} style={{ flex: 2 }}>
            {name.trim() ? 'Continue →' : 'Skip →'}
          </Button>
        </div>
      </div>
    </div>
  )
}
