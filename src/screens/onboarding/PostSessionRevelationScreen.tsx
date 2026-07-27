import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { Button, InsightCard, TypeOn, Spinner, Stat, StatGrid } from '../../components/ui'
import type { InsightRow } from '../../types/database'

/**
 * Screen 21 · Post-Session Revelation (Act 6 — The First Win)
 * The proof of the loop. Without this, Session 1 just shows "logged" and the
 * athlete has no idea anything happened. With it, the system visibly gets
 * smarter from their data — the conversion moment from tried-it to using-it.
 * Same canonical 3-layer structure as Zeroed In: the Read is recurring.
 */

interface RevelationState {
  movedInsightId: string | null
  category: string
  previousConfidence: number | null
  newConfidence: number | null
  isNew: boolean
  movedCount?: number          // how many insights the debrief moved this session
  summary?: string | null      // the agent's warm one-line session summary
  durationMins: number
  setsLogged: number
  name: string | null
}

interface RevelationProps {
  athleteId: string
  /** Re-read app state so onboarding_step flips to 'complete'. */
  onComplete: () => void
}

export function PostSessionRevelationScreen({ athleteId, onComplete }: RevelationProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as RevelationState | null

  const [movedInsight, setMovedInsight] = useState<InsightRow | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!state) {
      navigate('/app/today', { replace: true })
      return
    }
    let cancelled = false
    async function load() {
      if (state?.movedInsightId) {
        const { data } = await supabase
          .from('insight')
          .select('*')
          .eq('id', state.movedInsightId)
          .maybeSingle()
        if (!cancelled) setMovedInsight((data as InsightRow | null) ?? null)
      }
      if (!cancelled) setLoading(false)
    }
    void load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleBackToToday() {
    await supabase
      .from('athlete')
      .update({ onboarding_step: 'complete' })
      .eq('id', athleteId)
    onComplete()
    navigate('/app/today', { replace: true })
  }

  if (!state) return null
  if (loading) {
    return <div className="screen--centered"><Spinner /></div>
  }

  const { category, previousConfidence, newConfidence, isNew, durationMins, setsLogged, name } = state
  const lowerCategory = category.toLowerCase()

  // The agent's own read of the session leads when present; otherwise the
  // deterministic characterization.
  const characterization = state.summary
    ? state.summary
    : isNew
      ? `Your ${lowerCategory} just showed up in the read. Every session sharpens it.`
      : `Your ${lowerCategory} now has more behind it. Every session sharpens the read.`

  const confPct = Math.round((newConfidence ?? 0) * 100)
  const prevPct = previousConfidence != null ? Math.round(previousConfidence * 100) : null

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ flex: 1, padding: '40px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise" style={{ marginBottom: 28 }}>
          <h1 className="hero-headline">
            First session logged{name ? `, ${name}` : ''}.
          </h1>
          <p className="hero-characterization" style={{ marginTop: 16 }}>
            <TypeOn text={characterization} delay={40} />
          </p>
        </div>

        {/* The session, as numbers. This was a two-line block of uppercase mono
            telemetry ("DURATION 42 MIN · 18 SETS · 1 INSIGHT MOVED · CONFIDENCE
            0.41 → 0.58") that read as a machine log, not an achievement. */}
        <div className="fade-rise fade-rise-delay-1" style={{ marginBottom: 28 }}>
          <StatGrid>
            <Stat value={`${durationMins}m`} label="Duration" />
            <Stat value={setsLogged} label="Sets" />
            <Stat
              value={prevPct != null && !isNew ? `${prevPct}→${confPct}%` : `${confPct}%`}
              label={isNew || prevPct == null ? 'New signal' : 'Confidence'}
              tone="var(--signal)"
            />
          </StatGrid>
        </div>

        {/* The insight card that moved — pulse + transition pill */}
        {movedInsight && <InsightCard insight={movedInsight} pulse />}

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 32 }}>
          <Button variant="primary" full onClick={handleBackToToday}>
            Back to Today →
          </Button>
        </div>
      </div>
    </div>
  )
}
