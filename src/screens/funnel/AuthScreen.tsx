import { useState } from 'react'
import { sendSignInCode, verifySignInCode } from '../../lib/authClient'
import { Logo, Button, Input } from '../../components/ui'

type Phase = 'idle' | 'sending' | 'sent' | 'verifying' | 'error'

export function AuthScreen() {
  const [email, setEmail] = useState('')
  const [code, setCode]   = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError]  = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return

    setPhase('sending')
    setError(null)

    const { error: authErr } = await sendSignInCode(trimmed)

    if (authErr) {
      setError(authErr.message)
      setPhase('error')
    } else {
      setPhase('sent')
    }
  }

  // Code path — works where a clicked link can't (installed PWA, or when the
  // link opens a different browser than the app). On success, the global auth
  // listener (useAuth) routes us forward; nothing to do here.
  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    const token = code.trim()
    if (!token) return

    setError(null)
    setPhase('verifying')

    const { error: vErr } = await verifySignInCode(email.trim(), token)

    if (vErr) {
      setError(vErr.message)
      setPhase('sent')
    }
  }

  const isSent = phase === 'sent' || phase === 'verifying'

  return (
    <div className="screen--centered">
      <div style={{ width: '100%', maxWidth: 360 }}>
        {/* Wordmark */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <Logo />
        </div>

        {!isSent ? (
          <>
            {/* Brand promise */}
            <p
              className="text-dim"
              style={{ textAlign: 'center', marginBottom: 40, fontSize: 15, lineHeight: 1.6 }}
            >
              Know your zero.
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                disabled={phase === 'sending'}
                required
              />

              {error && (
                <p className="text-xs" style={{ color: 'var(--veto)' }}>{error}</p>
              )}

              <Button
                type="submit"
                variant="primary"
                full
                disabled={phase === 'sending' || !email.trim()}
              >
                {phase === 'sending' ? 'Sending…' : 'Send sign-in code'}
              </Button>
            </form>

            <p
              className="text-xs text-dim"
              style={{ textAlign: 'center', marginTop: 24 }}
            >
              No password. A code (and a link) arrive in your inbox.
            </p>
          </>
        ) : (
          <div className="fade-rise" style={{ textAlign: 'center' }}>
            <p className="text-lg" style={{ marginBottom: 8 }}>Check {email}.</p>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 20 }}>
              Enter the code from the email below — or tap the link if it opens in this same browser.
            </p>

            <form onSubmit={verifyCode} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Enter code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
                maxLength={10}
                autoFocus
                disabled={phase === 'verifying'}
                style={{ textAlign: 'center', letterSpacing: '0.3em', fontFamily: 'var(--font-mono)' }}
              />

              {error && (
                <p className="text-xs" style={{ color: 'var(--veto)' }}>{error}</p>
              )}

              <Button
                type="submit"
                variant="primary"
                full
                disabled={phase === 'verifying' || code.trim().length < 6}
              >
                {phase === 'verifying' ? 'Verifying…' : 'Verify code'}
              </Button>
            </form>

            <button
              className="btn btn--ghost"
              style={{ marginTop: 24, width: '100%' }}
              onClick={() => { setPhase('idle'); setEmail(''); setCode(''); setError(null) }}
            >
              Use a different address
            </button>
          </div>
        )}

        {/* System status — cold telemetry footer */}
        <p
          style={{
            textAlign: 'center',
            marginTop: 48,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.08em',
            color: 'var(--text-dim)',
          }}
        >
          SYSTEM READY · v0.1
        </p>
      </div>
    </div>
  )
}
