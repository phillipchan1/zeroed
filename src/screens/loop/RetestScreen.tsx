import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { runRetest, type RetestSummary } from '../../engine'
import { DiagnosticIntake } from '../funnel/DiagnosticIntake'
import { Button, Spinner } from '../../components/ui'
import type { DiagnosticResults } from '../../types/database'

/**
 * RETEST (§6) — the program cadence. Re-runs the movement rescreen (+ key
 * strength lifts via the existing battery) without re-asking the static profile
 * fields, then hands the results to runRetest, which writes the v+1 diagnostic,
 * resolves cleared weak links, re-scopes the program, and logs the delta.
 */
export function RetestScreen({ athleteId, onDone }: { athleteId: string; onDone: () => void }) {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<{ obstacle: string; sport: string; trainingAge: number; sessions: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [summary, setSummary] = useState<RetestSummary | null>(null)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('athlete')
        .select('goals, obstacle, sport, training_age, sessions_per_week')
        .eq('id', athleteId)
        .maybeSingle()
      setProfile({
        obstacle: (data?.goals as string | null) || (data?.obstacle as string | null) || '',
        sport: (data?.sport as string | null) || '',
        trainingAge: (data?.training_age as number | null) ?? 0,
        sessions: (data?.sessions_per_week as number | null) ?? 3,
      })
    })()
  }, [athleteId])

  async function handleComplete(results: DiagnosticResults) {
    setSaving(true)
    const result = await runRetest(athleteId, results)
    setSummary(result)
    onDone()
    setSaving(false)
  }

  if (!profile) {
    return <div className="screen--centered"><Spinner /></div>
  }

  if (saving) {
    return (
      <div className="screen--centered">
        <div className="thinking-shimmer" style={{ textAlign: 'center', padding: '24px 40px', borderRadius: 8 }}>
          <Spinner />
          <p className="text-dim" style={{ marginTop: 16, fontSize: 13 }}>Re-reading where you are…</p>
        </div>
      </div>
    )
  }

  if (summary) {
    const improvedStr = summary.improved.length
      ? summary.improved.map((i) => `${i.pattern.replace(/_/g, ' ')} ${i.from}→${i.to}`).join(' · ')
      : 'No pattern gains yet — the block re-scoped to keep the pressure on.'
    return (
      <div className="screen--centered" style={{ padding: '0 24px' }}>
        <div style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
          <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
            Retest v{summary.version}
          </p>
          <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>
            {summary.resolvedCount > 0
              ? `Cleared ${summary.resolvedCount} weak link${summary.resolvedCount === 1 ? '' : 's'}.`
              : 'Re-scoped.'}
          </h2>
          <p className="text-sm text-dim" style={{ lineHeight: 1.6, marginBottom: 28 }}>{improvedStr}</p>
          <Button variant="primary" full onClick={() => navigate('/app/today', { replace: true })}>
            Back to Today →
          </Button>
        </div>
      </div>
    )
  }

  return (
    <DiagnosticIntake
      obstacle={profile.obstacle}
      sport={profile.sport}
      trainingAge={profile.trainingAge}
      sessions={profile.sessions}
      onComplete={handleComplete}
    />
  )
}
