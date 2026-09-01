import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { runRetest, gatherStrengthBaseline, type RetestSummary } from '../../engine'
import { unitContext } from '../../lib/units'
import type { BaselineLift } from '../../engine/strengthBaseline'
import { invalidateLoopViews } from '../../lib/loopCache'
import { DiagnosticIntake } from '../funnel/DiagnosticIntake'
import { Button, Spinner } from '../../components/ui'
import type { DiagnosticResults } from '../../types/database'

/**
 * RETEST (§6) — the program cadence. Re-runs the movement rescreen without
 * re-asking the static profile fields, then hands the results to runRetest,
 * which writes the v+1 diagnostic, resolves cleared weak links, re-scopes the
 * program, and logs the delta.
 *
 * The strength half is no longer a battery to perform. The athlete's own log
 * already holds a top set on every lift they train, so the step confirms what
 * that log says rather than asking them to go and test four generic patterns.
 */
export function RetestScreen({ athleteId, onDone }: { athleteId: string; onDone: () => void }) {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<{ obstacle: string; sport: string; trainingAge: number; sessions: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [summary, setSummary] = useState<RetestSummary | null>(null)
  // The athlete's lifts as their log has them. Best-effort and non-blocking: an
  // empty baseline just means the strength step falls back to asking, which is
  // the right answer for someone with nothing logged yet.
  const [baseline, setBaseline] = useState<BaselineLift[]>([])
  const u = unitContext()

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
    void gatherStrengthBaseline(athleteId).then(setBaseline).catch(() => setBaseline([]))
  }, [athleteId])

  async function handleComplete(results: DiagnosticResults) {
    setSaving(true)
    const result = await runRetest(athleteId, results)
    setSummary(result)
    // A retest rewrites the whole read (new diagnostic, resolved/new insights)
    // and can re-scope the program — every cached view is now out of date.
    invalidateLoopViews()
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
          <p className="text-base text-dim" style={{ marginTop: 18 }}>Re-reading where you are…</p>
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
          <p className="eyebrow" style={{ marginBottom: 14 }}>Retest v{summary.version}</p>
          <h2 className="screen-title" style={{ marginBottom: 14 }}>
            {summary.resolvedCount > 0
              ? `Cleared ${summary.resolvedCount} weak link${summary.resolvedCount === 1 ? '' : 's'}.`
              : 'Re-scoped.'}
          </h2>
          <p className="text-base text-dim" style={{ marginBottom: 18 }}>{improvedStr}</p>

          {/* What got STRONGER. The retest collected strength numbers at every
              version and never once compared them, so this is the first time it
              can answer the question it exists to ask. */}
          {summary.stronger.length > 0 && (
            <div style={{ marginBottom: summary.deferred ? 18 : 30, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {summary.stronger.map((s) => (
                <div
                  key={s.name}
                  style={{
                    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                    gap: 12, padding: '10px 14px',
                    background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8,
                  }}
                >
                  <span className="text-sm" style={{ fontWeight: 600 }}>{s.name}</span>
                  <span className="num text-sm" style={{ color: 'var(--confirmed)' }}>
                    {u.fmt(s.from)} → {u.fmt(s.to)}{u.unit} · +{s.pct}%
                  </span>
                </div>
              ))}
            </div>
          )}
          {summary.deferred && (
            <p className="text-sm text-dim" style={{ marginBottom: 30 }}>
              Your new block starts Monday — this week's sessions stay as they are.
            </p>
          )}
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
      strengthBaseline={baseline}
      onComplete={handleComplete}
      onExit={() => navigate('/app/today')}
    />
  )
}
