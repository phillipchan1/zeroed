import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { Button, Input, Sheet } from '../../components/ui'

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

  if (!isSent) {
    return (
      <Sheet
        title="Unlock your first session"
        subtitle="No password — a code lands in your inbox."
        onClose={onClose}
      >
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          {error && <p className="text-sm" style={{ color: 'var(--veto)' }}>{error}</p>}
          <Button type="submit" variant="primary" full disabled={phase === 'sending' || !email.trim()}>
            {phase === 'sending' ? 'Sending…' : 'Send the code →'}
          </Button>
        </form>
      </Sheet>
    )
  }

  return (
    <Sheet title={`Check ${email}`} subtitle="Enter the code to finish." onClose={onClose}>
      <form onSubmit={verifyCode} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="Code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
          maxLength={10}
          autoFocus
          disabled={phase === 'verifying'}
          style={{ textAlign: 'center', letterSpacing: '0.4em', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)', height: 60 }}
        />
        {error && <p className="text-sm" style={{ color: 'var(--veto)' }}>{error}</p>}
        <Button type="submit" variant="primary" full disabled={phase === 'verifying' || code.trim().length < 6}>
          {phase === 'verifying' ? 'Verifying…' : 'Verify code'}
        </Button>
      </form>

      <Button
        variant="ghost"
        full
        style={{ marginTop: 12 }}
        onClick={() => { setPhase('idle'); setEmail(''); setCode(''); setError(null) }}
      >
        Use a different address
      </Button>
    </Sheet>
  )
}
