import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import {
  InsightCard, SectionHeader, Skeleton, StatusCounts, TelemetryStrip, PresenceDot,
} from '../../components/ui'
import { countInsightsByStatus } from '../../engine'
import type { InsightRow } from '../../types/database'

/**
 * COACH — the intelligence. What the system believes about the athlete and why:
 * the weak-link stack (each claim, its status, its confidence), the read state,
 * and the seam for the future conversation. This is where the depth that used to
 * crowd Today and Profile lives — one tap from Train's read line.
 */
export function CoachScreen({ athleteId }: { athleteId: string }) {
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const { data } = await supabase
        .from('insight')
        .select('*')
        .eq('athlete_id', athleteId)
        .order('priority')
      setInsights((data ?? []) as InsightRow[])
      setLoading(false)
    })()
  }, [athleteId])

  const active = insights.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const statusCounts = countInsightsByStatus(insights)
  const lastSignalAt = insights.reduce<string | null>((max, i) =>
    !max || i.updated_at > max ? i.updated_at : max, null)

  const countBy = (s: string) => insights.filter((i) => i.status === s).length
  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: String(countBy('confirmed')), value: 'CONFIRMED' },
    { label: String(countBy('likely')), value: 'LIKELY' },
    { label: String(countBy('hypothesis')), value: 'HYP' },
  ]

  return (
    <div className="screen with-nav">
      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
          The read
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>Coach</h2>

        <p className="hero-characterization fade-rise" style={{ marginBottom: 20 }}>
          Here's what I'm tracking about you — and how sure I am. Every session you log sharpens it.
        </p>

        {!loading && statusCounts.length > 0 && (
          <div className="fade-rise" style={{ marginBottom: 20 }}>
            <StatusCounts counts={statusCounts} />
          </div>
        )}

        {/* The weak-link stack — the read in depth */}
        <div className="fade-rise fade-rise-delay-1">
          <SectionHeader>Weak-link stack</SectionHeader>
          <div style={{ marginTop: 12 }}>
            {loading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="card" style={{ marginBottom: 8 }}>
                  <Skeleton height={10} width={80} /><div style={{ height: 8 }} />
                  <Skeleton height={14} width="90%" /><div style={{ height: 4 }} />
                  <Skeleton height={11} width="70%" />
                </div>
              ))
            ) : active.length > 0 ? (
              active.map((ins) => <InsightCard key={ins.id} insight={ins} />)
            ) : (
              <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
                Nothing tracked yet. Your first read appears after the probe; it sharpens as you train.
              </p>
            )}
          </div>
        </div>

        {/* Conversation seam — intentional, not a dead stub */}
        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 28 }}>
          <div
            className="card"
            style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.7 }}
          >
            <PresenceDot />
            <span className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
              Ask why — conversation coming soon
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
