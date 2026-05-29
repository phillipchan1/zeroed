import { Logo, PresenceDot } from '../../components/ui'

/**
 * Screen 01 · Instrument Ready
 * Black screen. Wordmark, presence dot, one dim mono line. Tap anywhere to begin.
 * The first frame establishes genre — no welcome banner, no value-prop copy.
 */
export function SplashScreen({ onBegin }: { onBegin: () => void }) {
  return (
    <div
      className="screen--centered"
      style={{ cursor: 'pointer' }}
      onClick={onBegin}
      role="button"
      aria-label="Begin"
    >
      <div className="fade-rise" style={{ textAlign: 'center' }}>
        <Logo />
        <p
          style={{
            marginTop: 24,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
          }}
        >
          <PresenceDot />
          Instrument ready
        </p>
        <p
          style={{
            marginTop: 18,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.7,
            letterSpacing: '0.02em',
            color: 'var(--text-dim)',
            maxWidth: 300,
          }}
        >
          Tell me what's in your way.
          <br />
          A read in ~30 seconds — then your first session.
        </p>
      </div>

      <p
        className="text-xs text-dim"
        style={{
          position: 'fixed',
          bottom: 'calc(32px + env(safe-area-inset-bottom, 0px))',
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em',
          opacity: 0.5,
        }}
      >
        tap to begin
      </p>
    </div>
  )
}
