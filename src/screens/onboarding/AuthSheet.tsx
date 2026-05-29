import { useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Button, Input } from '../../components/ui'

type Phase = 'idle' | 'sending' | 'sent' | 'error'

/**
 * Auth lives here — after the first reframe (Screen 03), not before. By this
 * point the athlete has felt the product. A bottom sheet, one email field,
 * magic link. On confirm the athlete returns authenticated and resumes.
 */
export function AuthSheet({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
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

        {phase !== 'sent' ? (
          <>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
              Your read's done. Drop your email and I'll build your first session — no password, a link lands in your inbox.
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
                {phase === 'sending' ? 'Sending…' : 'Send the link →'}
              </Button>
            </form>
          </>
        ) : (
          <div className="fade-rise">
            <p className="text-lg" style={{ marginBottom: 8 }}>Link sent.</p>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.6 }}>
              Check {email} — open it and your first session is ready.
            </p>
            <button
              className="btn btn--ghost"
              style={{ marginTop: 20, width: '100%' }}
              onClick={() => { setPhase('idle'); setEmail('') }}
            >
              Use a different address
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
