import { NavLink } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { ConvergenceReticle } from './ConvergenceReticle'
import { computeLoopConvergence, CONVERGENCE_LABEL, deriveConvergenceState } from './state'
import type { InsightRow } from '../../types/database'

type ConvergenceRow = Pick<InsightRow, 'priority' | 'confidence' | 'status' | 'prev_status' | 'updated_at'>

async function fetchConvergenceRows(athleteId: string): Promise<ConvergenceRow[]> {
  const { data, error } = await supabase
    .from('insight')
    .select('priority, confidence, status, prev_status, updated_at')
    .eq('athlete_id', athleteId)
  if (error) throw error
  return (data ?? []) as ConvergenceRow[]
}

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
  // The reticle lives in the persistent nav, so it must never make navigation
  // cost a request. It reads the shared cache instead: painted from memory on
  // every tab switch, refreshed on its own cadence (and immediately after a
  // session commit, which invalidates this key). It still breathes off real DB
  // state — just not once per tap.
  const { data: rows } = useCachedLoader(
    athleteId ? `convergence:${athleteId}` : null,
    () => fetchConvergenceRows(athleteId),
  )

  // nowMs injected here (component edge) so the reducer stays pure/testable.
  const conv = rows ? computeLoopConvergence(rows, Date.now()) : null

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
