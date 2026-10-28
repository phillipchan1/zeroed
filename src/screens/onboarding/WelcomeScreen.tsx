import { Button, LockOn, PresenceDot } from '../../components/ui'

const LANES = ['Lift', 'Run', 'Sport', 'Intervals', 'Mobility']

/**
 * The first frame, signed out. Two doors and nothing else: start, or sign in.
 * A returning athlete is never made to answer a question to reach their log.
 *
 * The wordmark still arrives the way the product works — spread out, then
 * tightening onto the mark while the brackets lock on — but it no longer hides
 * the way forward behind "tap anywhere".
 */
export function WelcomeScreen({
  onGetStarted,
  onSignIn,
}: {
  onGetStarted: () => void
  onSignIn: () => void
}) {
  return (
    <div className="welcome">
      <div className="welcome__hero">
        <LockOn style={{ padding: '14px 22px', '--lock-gap': '0px', '--lock-from': '28px' } as React.CSSProperties}>
          <span className="wordmark splash__mark converge">Zeroed</span>
        </LockOn>
        <p className="eyebrow splash__status">
          <PresenceDot />
          Instrument ready
        </p>
        <h1 className="welcome__line splash__line">One coach for everything you train.</h1>
        <p className="welcome__lanes splash__line" aria-label={LANES.join(', ')}>
          {LANES.map((l, i) => (
            <span key={l}>
              {i > 0 && <span className="welcome__sep" aria-hidden>·</span>}
              {l}
            </span>
          ))}
        </p>
      </div>

      <div className="welcome__actions">
        <Button variant="primary" full onClick={onGetStarted}>Get started</Button>
        <Button variant="ghost" full onClick={onSignIn}>I have an account</Button>
      </div>
    </div>
  )
}
