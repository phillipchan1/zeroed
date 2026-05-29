import { Logo, Button, Input, SectionHeader } from '../../components/ui'

/**
 * Orientation · Name (optional)
 * One field, optional. Name is warmth, not data — the read doesn't need it. The
 * athlete can skip straight through.
 */
export function IdentityScreen({
  name,
  onChange,
  onNext,
}: {
  name: string
  onChange: (value: string) => void
  onNext: () => void
}) {
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--line)' }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <SectionHeader>CALIBRATING YOUR SESSION</SectionHeader>
          <h1 className="hero-headline" style={{ fontSize: 24, marginTop: 10, marginBottom: 28 }}>
            What should I call you?
          </h1>
        </div>

        <div className="fade-rise fade-rise-delay-1">
          <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>Name (optional)</label>
          <Input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => onChange(e.target.value)}
            autoCapitalize="words"
            autoFocus
          />
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 32 }}>
          <Button variant="primary" full onClick={onNext}>
            {name.trim() ? 'Continue →' : 'Skip →'}
          </Button>
        </div>
      </div>
    </div>
  )
}
