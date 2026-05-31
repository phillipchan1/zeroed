import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { ConvergenceReticle } from './ConvergenceReticle'
import { computeLoopConvergence, CONVERGENCE_LABEL, deriveConvergenceState, type LoopConvergence } from './state'
import type { InsightRow } from '../../types/database'

/**
 * The persistent reticle (Phase F) — the convergence organism lives in the loop
 * nav, replacing the static MONITOR dot. Its tightness is LIVE program fit, read
 * off the insight stack (the same state a logged session writes). It BREATHES:
 * re-reads on every navigation, so a clean session (confidences up) tightens it
 * and a surprise (a disconfirming/pain observation, confidences down + a status
 * regression) loosens it — driven by real state, never a timer.
 *
 * Tap → the Coach stack (what's converged, what's still loose).
 */
export function MonitorReticle({ athleteId, variant }: { athleteId: string; variant: 'bottom' | 'sidebar' }) {
  const location = useLocation()
  const [conv, setConv] = useState<LoopConvergence | null>(null)

  useEffect(() => {
    if (!athleteId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('insight')
        .select('priority, confidence, status, prev_status, updated_at')
        .eq('athlete_id', athleteId)
      if (cancelled) return
      const rows = (data ?? []) as Pick<InsightRow, 'priority' | 'confidence' | 'status' | 'prev_status' | 'updated_at'>[]
      // nowMs injected here (component edge) so the reducer stays pure/testable.
      setConv(computeLoopConvergence(rows, Date.now()))
    })()
    return () => { cancelled = true }
    // re-read on navigation — the reticle breathes off real DB state each visit.
  }, [athleteId, location.pathname])

  // Until loaded (or with no stack yet) fall back to the original static MONITOR
  // marker so the nav never looks broken — matches the prior sidebar markup.
  if (!conv || conv.activeCount === 0) {
    return <div className="sidebar__system"><span className="presence-dot" /><span>MONITOR</span></div>
  }

  const state = deriveConvergenceState(conv.confidence, conv.context)
  const title = `${CONVERGENCE_LABEL[state]} · ${Math.round(conv.confidence * 100)}% — the read. Tap for the stack.`
  const dim = variant === 'sidebar' ? 24 : 20

  return (
    <NavLink to="/app/coach" className="sidebar__system monitor-reticle" title={title} aria-label={title}>
      <ConvergenceReticle
        confidence={conv.confidence}
        axes={conv.axes}
        context={conv.context}
        size={dim}
        animateInFrom={null}
        showLabel={false}
      />
      <span>MONITOR</span>
    </NavLink>
  )
}
