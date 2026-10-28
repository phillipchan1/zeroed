import { useEffect, useRef, useState, type ReactNode } from 'react'
import { lastSignInEmail, sendSignInCode, verifySignInCode } from '../../lib/authClient'
import { BackButton, Button, Input } from '../../components/ui'
import { FunnelFrame } from '../../components/layout/FunnelFrame'

const CODE_LENGTH = 6
const RESEND_AFTER_S = 30
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Phase = 'email' | 'sending' | 'code' | 'verifying'

/**
 * The one sign-in, used by both doors: "I have an account" (`returning`) and the
 * end of the intake (`save`). Email, then a 6-digit code — no password, no link
 * to chase into another browser. The code field takes iOS's one-time-code
 * autofill and a paste, and verifies itself on the sixth digit.
 *
 * On success the global auth listener moves the app on; this screen only
 * surfaces errors. Whether the email already has a plan is the router's call,
 * so either door works for either kind of athlete.
 */
export function SignInScreen({
  intent,
  onBack,
  onGetStarted,
  summary,
}: {
  intent: 'returning' | 'save'
  onBack: () => void
  /** Returning door only: the "new here?" way out. */
  onGetStarted?: () => void
  /** Save door only: what they're saving, above the field. */
  summary?: ReactNode
}) {
  const [email, setEmail] = useState(lastSignInEmail)
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<Phase>('email')
  const [error, setError] = useState<string | null>(null)
  const [sentAt, setSentAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState<string | null>(null)
  const codeRef = useRef<HTMLInputElement>(null)

  const onCode = phase === 'code' || phase === 'verifying'
  const resendIn = Math.max(0, RESEND_AFTER_S - Math.floor((now - sentAt) / 1000))

  // Tick the resend countdown only while it's counting.
  useEffect(() => {
    if (!onCode || resendIn === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [onCode, resendIn])

  async function send(e?: React.FormEvent) {
    e?.preventDefault()
    const addr = email.trim()
    if (!EMAIL_RE.test(addr)) return
    setError(null)
    setNotice(null)
    setPhase(onCode ? 'code' : 'sending')
    const { error: err } = await sendSignInCode(addr)
    if (err) {
      setError(friendlySendError(err.message))
      setPhase(onCode ? 'code' : 'email')
      return
    }
    setSentAt(Date.now())
    setNow(Date.now())
    setCode('')
    setPhase('code')
    if (onCode) setNotice('New code sent.')
    requestAnimationFrame(() => codeRef.current?.focus())
  }

  async function verify(token: string) {
    if (token.length !== CODE_LENGTH || phase === 'verifying') return
    setError(null)
    setNotice(null)
    setPhase('verifying')
    const { error: err } = await verifySignInCode(email.trim(), token)
    if (err) {
      setError(friendlyCodeError(err.message))
      setCode('')
      setPhase('code')
      requestAnimationFrame(() => codeRef.current?.focus())
    }
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH)
    setCode(digits)
    if (error) setError(null)
    if (digits.length === CODE_LENGTH) void verify(digits)
  }

  const save = intent === 'save'

  return (
    <FunnelFrame>
      <div className="signin">
        <BackButton
          onClick={onCode ? () => { setPhase('email'); setCode(''); setError(null); setNotice(null) } : onBack}
        />

        {!onCode ? (
          <form className="signin__body fade-rise" onSubmit={send}>
            <p className="eyebrow">{save ? 'Save your plan' : 'Sign in'}</p>
            <h1 className="hero-headline signin__title">
              {save ? 'Keep it on every device.' : 'Welcome back.'}
            </h1>
            <p className="text-sm text-dim signin__sub">
              {save
                ? 'Your email, then a 6-digit code. No password.'
                : "We'll email you a 6-digit code. No password."}
            </p>
            {summary}
            <Input
              type="email"
              inputMode="email"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(null) }}
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              disabled={phase === 'sending'}
              aria-label="Email"
            />
            {error && <p className="signin__error" role="alert">{error}</p>}
            <Button type="submit" variant="primary" full disabled={phase === 'sending' || !EMAIL_RE.test(email.trim())}>
              {phase === 'sending' ? 'Sending…' : 'Send code'}
            </Button>
            {onGetStarted && (
              <button type="button" className="signin__link" onClick={onGetStarted}>
                New here? Get started
              </button>
            )}
          </form>
        ) : (
          <div className="signin__body fade-rise">
            <p className="eyebrow">Check your email</p>
            <h1 className="hero-headline signin__title">Enter the code</h1>
            <p className="text-sm text-dim signin__sub">
              Sent to <span className="signin__email">{email.trim()}</span>. It's good for 5 minutes.
            </p>

            <label className={`otp${phase === 'verifying' ? ' otp--busy' : ''}${error ? ' otp--error' : ''}`}>
              <input
                ref={codeRef}
                className="otp__input"
                value={code}
                onChange={(e) => onCodeChange(e.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                autoFocus
                disabled={phase === 'verifying'}
                aria-label={`${CODE_LENGTH}-digit code`}
              />
              <span className="otp__cells" aria-hidden>
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <span
                    key={i}
                    className={`otp__cell${code[i] ? ' otp__cell--filled' : ''}${i === code.length ? ' otp__cell--next' : ''}`}
                  >
                    {code[i] ?? ''}
                  </span>
                ))}
              </span>
            </label>

            <p className={`signin__status${error ? ' signin__error' : ''}`} role={error ? 'alert' : 'status'}>
              {error ?? (phase === 'verifying' ? 'Signing you in…' : notice ?? ' ')}
            </p>

            <div className="signin__row">
              <button
                type="button"
                className="signin__link"
                onClick={() => void send()}
                disabled={resendIn > 0 || phase === 'verifying'}
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
              <button
                type="button"
                className="signin__link"
                onClick={() => { setPhase('email'); setCode(''); setError(null); setNotice(null) }}
                disabled={phase === 'verifying'}
              >
                Use a different email
              </button>
            </div>
          </div>
        )}
      </div>
    </FunnelFrame>
  )
}

function friendlySendError(message: string): string {
  const m = message.toLowerCase()
  if (/too many|rate/.test(m)) return 'Too many codes asked for. Wait a minute, then try again.'
  if (/fetch|network|load failed|offline/.test(m)) return "Can't reach Zeroed. Check your connection and try again."
  return message
}

function friendlyCodeError(message: string): string {
  const m = message.toLowerCase()
  if (/expired/.test(m)) return 'That code has expired. Tap Resend for a new one.'
  if (/too many|attempt/.test(m)) return 'Too many tries. Tap Resend for a new code.'
  if (/fetch|network|load failed|offline/.test(m)) return "Can't reach Zeroed. Check your connection and try again."
  if (/invalid|incorrect|match|otp|token|code/.test(m)) return "That code didn't match. Check the newest email."
  return message
}
