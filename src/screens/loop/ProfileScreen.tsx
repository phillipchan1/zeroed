import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { SectionHeader, Skeleton, Button, Input } from '../../components/ui'

interface ProfileScreenProps {
  athleteId: string
  athleteName: string | null
}

/**
 * PROFILE — you. Identity, training context, and the durable TARGET (editable);
 * account actions. The read (weak-link stack) lives in Coach; the plan lives in
 * Program. This stays a calm "who you are + what you're chasing" surface.
 */
export function ProfileScreen({ athleteId, athleteName }: ProfileScreenProps) {
  const [meta, setMeta] = useState<{ sessions_per_week: number | null; training_age: number | null; goals: string | null } | null>(null)
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      // Local scope clears this device's session with no network round-trip, so
      // sign-out is instant even on the flaky signal you often have right after
      // a workout. Global scope used to hang here, leaving the button spinning.
      await supabase.auth.signOut({ scope: 'local' })
      // SIGNED_OUT propagates through useAuth and swaps the app to onboarding.
    } catch {
      // Never strand the athlete on a dead button — force a clean reload.
      window.location.href = '/'
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('athlete')
      .select('sessions_per_week, training_age, goals')
      .eq('id', athleteId)
      .maybeSingle()
    setMeta(data as typeof meta)
    setLoading(false)
  }, [athleteId])

  useEffect(() => { void load() }, [load])

  async function saveTarget() {
    setSaving(true)
    const value = draft.trim() || null
    await supabase.from('athlete').update({ goals: value }).eq('id', athleteId)
    setMeta((m) => (m ? { ...m, goals: value } : m))
    setSaving(false)
    setEditing(false)
  }

  const target = meta?.goals ?? null

  return (
    <div className="screen with-nav">
      <div className="page page--split">
       <div className="page__main">

        {/* Header */}
        <div className="fade-rise" style={{ marginBottom: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>{athleteName ?? 'Profile'}</h2>
            {!loading && (
              <p className="text-dim" style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {meta?.sessions_per_week ? `${meta.sessions_per_week}× weekly` : 'athlete'}
                {meta?.training_age != null && ` · training age ${meta.training_age}y`}
              </p>
            )}
          </div>
          <button
            className="btn btn--ghost text-xs"
            style={{ height: 32, padding: '0 8px', marginTop: 4 }}
            onClick={handleSignOut}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
       </div>

       {/* Target — the durable anchor, editable. Right column on desktop. */}
       <div className="page__main">
        <div className="fade-rise" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <SectionHeader>Chasing</SectionHeader>
            {!loading && !editing && (
              <button
                className="btn btn--ghost text-xs"
                style={{ height: 26, padding: '0 6px', color: 'var(--text-dim)' }}
                onClick={() => { setDraft(target ?? ''); setEditing(true) }}
              >
                {target ? 'Edit' : 'Set'}
              </button>
            )}
          </div>

          {loading ? (
            <Skeleton height={26} width={200} />
          ) : editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Input
                type="text"
                placeholder="e.g. 285 lb bench"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                style={{ fontSize: 16 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="ghost" onClick={() => setEditing(false)} style={{ flex: 1 }}>Cancel</Button>
                <Button variant="primary" onClick={saveTarget} disabled={saving} style={{ flex: 2 }}>
                  {saving ? 'Saving…' : 'Save target'}
                </Button>
              </div>
            </div>
          ) : (
            <h3 style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
              {target ?? <span className="text-dim" style={{ fontWeight: 400 }}>No target set yet.</span>}
            </h3>
          )}
        </div>
       </div>
      </div>
    </div>
  )
}
