import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { Logo, Button, Input } from '../../components/ui'

type Phase = 'idle' | 'sending' | 'sent' | 'error'

export function AuthScreen() {
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError]  = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return

    setPhase('sending')
    setError(null)

    const { error: authErr } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { emailRedirectTo: window.location.origin },
    })

    if (authErr) {
      setError(authErr.message)
      setPhase('error')
    } else {
      setPhase('sent')
    }
  }

  return (
    <div className="screen--centered">
      <div style={{ width: '100%', maxWidth: 360 }}>
        {/* Wordmark */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <Logo />
        </div>

        {phase !== 'sent' ? (
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
                {phase === 'sending' ? 'Sending…' : 'Send sign-in link'}
              </Button>
            </form>

            <p
              className="text-xs text-dim"
              style={{ textAlign: 'center', marginTop: 24 }}
            >
              No password. A link arrives in your inbox.
            </p>
          </>
        ) : (
          <div className="fade-rise" style={{ textAlign: 'center' }}>
            <p className="text-lg" style={{ marginBottom: 12 }}>Link sent.</p>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.6 }}>
              Check {email} — open the link to continue.
            </p>
            <button
              className="btn btn--ghost"
              style={{ marginTop: 32, width: '100%' }}
              onClick={() => { setPhase('idle'); setEmail('') }}
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
