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
          className="eyebrow"
          style={{ marginTop: 26, display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <PresenceDot />
          Instrument ready
        </p>
        <p
          className="text-lg"
          style={{ marginTop: 20, color: 'var(--text-dim)', maxWidth: 300, lineHeight: 1.5 }}
        >
          A read in 30 seconds, then your first session.
        </p>
      </div>

      <p
        className="eyebrow"
        style={{
          position: 'fixed',
          bottom: 'calc(40px + env(safe-area-inset-bottom, 0px))',
          left: 0,
          right: 0,
          textAlign: 'center',
          opacity: 0.6,
        }}
      >
        Tap to begin
      </p>
    </div>
  )
}
