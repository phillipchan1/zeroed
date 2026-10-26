import { LockOn, PresenceDot } from '../../components/ui'

/**
 * Screen 01 · Instrument Ready
 * Black screen. Wordmark, presence dot, one dim mono line. Tap anywhere to begin.
 * The first frame establishes genre — no welcome banner, no value-prop copy.
 *
 * The wordmark arrives the way the product works: spread out, then tightening
 * onto the mark while the brackets lock on. Zeroing in, before a word is read.
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
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <LockOn style={{ padding: '14px 22px', '--lock-gap': '0px', '--lock-from': '28px' } as React.CSSProperties}>
          <span className="wordmark splash__mark converge">Zeroed</span>
        </LockOn>
        <p className="eyebrow splash__status">
          <PresenceDot />
          Instrument ready
        </p>
        <p
          className="text-lg splash__line"
          style={{ marginTop: 20, color: 'var(--text-dim)', maxWidth: 300, lineHeight: 1.5 }}
        >
          A read in 30 seconds, then your first session.
        </p>
      </div>

      <p
        className="eyebrow splash__cta"
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
