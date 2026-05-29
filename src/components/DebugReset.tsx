import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

/**
 * DEV-ONLY floating reset button.
 * Wipes the current athlete's onboarding state (diagnostic, insights, program,
 * profile, workouts) via the reset_athlete_orientation() RPC, so the funnel
 * restarts at the diagnostic intake. Never rendered in production builds.
 */
export function DebugReset({ onReset }: { onReset: () => void }) {
  const [busy, setBusy] = useState(false)

  if (!import.meta.env.DEV) return null

  async function handleReset() {
    if (busy) return
    if (!window.confirm('Reset orientation? This wipes your diagnostic, insights, program and workouts and sends you back to the start.')) {
      return
    }
    setBusy(true)
    const { error } = await supabase.rpc('reset_athlete_orientation')
    setBusy(false)
    if (error) {
      console.error('reset_athlete_orientation failed', error)
      window.alert(`Reset failed: ${error.message}`)
      return
    }
    onReset()
  }

  return (
    <button
      type="button"
      className="debug-reset"
      onClick={handleReset}
      disabled={busy}
      title="DEV: reset orientation"
      aria-label="Reset orientation"
    >
      <RotateCcw size={14} strokeWidth={2} />
      <span className="debug-reset__label">{busy ? 'Resetting…' : 'Reset'}</span>
    </button>
  )
}
