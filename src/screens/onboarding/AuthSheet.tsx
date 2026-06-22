import { useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Button, Input } from '../../components/ui'

type Phase = 'idle' | 'sending' | 'sent' | 'verifying' | 'error'

/**
 * Auth lives here — after the first reframe (Screen 03), not before. By this
 * point the athlete has felt the product. A bottom sheet, one email field.
 * We send BOTH a magic link and a 6-digit code: the code path is what works in
 * an installed PWA (or when the link opens a different browser than the app),
 * since a clicked link always lands in the OS default browser.
 */
export function AuthSheet({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode]   = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

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

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    const token = code.trim()
    if (!token) return

    setError(null)
    setPhase('verifying')

    const { error: vErr } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'email',
    })

    // On success the global auth listener resumes the funnel; only surface errors.
    if (vErr) {
      setError(vErr.message)
      setPhase('sent')
    }
  }

  const isSent = phase === 'sent' || phase === 'verifying'

  return (
    <div className="obs-sheet" onClick={onClose}>
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <p className="section-header">Unlock your first session</p>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: 0, height: 24, minWidth: 24, color: 'var(--text-dim)' }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {!isSent ? (
          <>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
              Your read's done. Drop your email and I'll build your first session — no password, a code lands in your inbox.
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

              {error && <p className="text-xs" style={{ color: 'var(--veto)' }}>{error}</p>}

              <Button type="submit" variant="primary" full disabled={phase === 'sending' || !email.trim()}>
                {phase === 'sending' ? 'Sending…' : 'Send the code →'}
              </Button>
            </form>
          </>
        ) : (
          <div className="fade-rise">
            <p className="text-lg" style={{ marginBottom: 8 }}>Check {email}.</p>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
              Enter the code from the email to finish — works right here in the app.
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

              {error && <p className="text-xs" style={{ color: 'var(--veto)' }}>{error}</p>}

              <Button type="submit" variant="primary" full disabled={phase === 'verifying' || code.trim().length < 6}>
                {phase === 'verifying' ? 'Verifying…' : 'Verify code'}
              </Button>
            </form>

            <button
              className="btn btn--ghost"
              style={{ marginTop: 20, width: '100%' }}
              onClick={() => { setPhase('idle'); setEmail(''); setCode(''); setError(null) }}
            >
              Use a different address
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
