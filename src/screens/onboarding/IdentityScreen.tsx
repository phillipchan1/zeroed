import { Logo, Button, Input, SectionHeader } from '../../components/ui'

/**
 * Screen 04 · Name + Sport
 * Two fields. Sport has four shortcut pills; everything else is free-text.
 */

const SPORT_PILLS = ['BASKETBALL', 'LIFTING', 'RUNNING', 'GENERAL FITNESS']

export function IdentityScreen({
  name,
  sport,
  onChange,
  onNext,
}: {
  name: string
  sport: string
  onChange: (field: 'name' | 'sport', value: string) => void
  onNext: () => void
}) {
  const complete = name.trim().length > 0 && sport.trim().length > 0

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--line)' }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <SectionHeader>ORIENTATION</SectionHeader>
          <h1 className="hero-headline" style={{ fontSize: 24, marginTop: 10, marginBottom: 28 }}>
            First, the basics.
          </h1>
        </div>

        <div className="fade-rise fade-rise-delay-1" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>Name</label>
            <Input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => onChange('name', e.target.value)}
              autoCapitalize="words"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>Sport or activity</label>
            <Input
              type="text"
              placeholder="e.g. Basketball, lifting, running"
              value={sport}
              onChange={(e) => onChange('sport', e.target.value)}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {SPORT_PILLS.map((pill) => (
                <button
                  key={pill}
                  type="button"
                  onClick={() => onChange('sport', pill.charAt(0) + pill.slice(1).toLowerCase())}
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
                  }}
                >
                  {pill}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 32 }}>
          <Button variant="primary" full disabled={!complete} onClick={onNext}>
            Continue →
          </Button>
        </div>
      </div>
    </div>
  )
}
