import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabaseClient'
import { Spinner } from '../../components/ui'
import { HookAct, OBSTACLE_STORAGE_KEY } from './HookAct'
import { OrientationAct, type OrientationFields } from './OrientationAct'
import { ComputeScreen } from './ComputeScreen'
import { DiagnosticIntake } from '../funnel/DiagnosticIntake'
import { ZeroedInScreen } from '../funnel/ZeroedInScreen'
import type { AthleteRow, DiagnosticResults, OnboardingStep } from '../../types/database'

const DIAGNOSTIC_DRAFT_KEY = 'zeroed.diagnostic'

function readDraft(): DiagnosticResults | null {
  try {
    const raw = sessionStorage.getItem(DIAGNOSTIC_DRAFT_KEY)
    return raw ? (JSON.parse(raw) as DiagnosticResults) : null
  } catch {
    return null
  }
}

/**
 * The six-act onboarding state machine. Renders the right screen for the
 * athlete's onboarding_step. Stays mounted across the funnel steps so the
 * diagnostic draft survives the screening → computing handoff. The daily-loop
 * steps (first_session_*, complete) are routed by App, not here.
 */
export function OnboardingRouter({
  user,
  athlete,
  refresh,
}: {
  user: User | null
  athlete: AthleteRow | null
  refresh: () => void
}) {
  const navigate = useNavigate()
  const [diagnosticResults, setDiagnosticResults] = useState<DiagnosticResults | null>(null)
  const bootstrappedRef = useRef(false)

  // --- Bootstrap: just signed in, no athlete row yet -------------------------
  // Create it from the stashed obstacle and drop straight into orientation.
  useEffect(() => {
    if (!user || athlete || bootstrappedRef.current) return
    bootstrappedRef.current = true
    void (async () => {
      let obstacle: string | null = null
      try { obstacle = localStorage.getItem(OBSTACLE_STORAGE_KEY) } catch { /* ignore */ }
      await supabase.from('athlete').insert({
        auth_user_id: user.id,
        obstacle,
        onboarding_step: 'orientation',
      })
      try { localStorage.removeItem(OBSTACLE_STORAGE_KEY) } catch { /* ignore */ }
      refresh()
    })()
  }, [user, athlete, refresh])

  async function advance(step: OnboardingStep, fields?: Partial<AthleteRow>) {
    if (!athlete) return
    await supabase.from('athlete').update({ onboarding_step: step, ...fields }).eq('id', athlete.id)
    refresh()
  }

  // --- Pre-auth / bootstrap states ------------------------------------------
  // No athlete yet: pre-auth hook (no user) or the brief create-athlete beat.
  if (!athlete) {
    if (!user) {
      return (
        <HookAct
          authed={false}
          initialObstacle=""
          onAuthedAdvance={() => { /* unreachable while unauthenticated */ }}
        />
      )
    }
    return <div className="screen--centered"><Spinner /></div>
  }

  // --- Funnel steps ----------------------------------------------------------
  switch (athlete.onboarding_step) {
    case 'hook':
      return (
        <HookAct
          authed={!!user}
          initialObstacle={athlete.obstacle ?? ''}
          onAuthedAdvance={(obstacle) => advance('orientation', { obstacle })}
        />
      )

    case 'orientation':
      return (
        <OrientationAct
          athlete={athlete}
          obstacle={athlete.obstacle ?? ''}
          onComplete={(f: OrientationFields) =>
            advance('screening', {
              name: f.name.trim() || null,
              sport: f.sport.trim() || null,
              training_age: f.trainingAge,
              sessions_per_week: f.sessions,
            })
          }
        />
      )

    case 'screening':
      return (
        <DiagnosticIntake
          obstacle={athlete.obstacle ?? ''}
          sport={athlete.sport ?? ''}
          trainingAge={athlete.training_age ?? 0}
          sessions={athlete.sessions_per_week ?? 3}
          onComplete={(results) => {
            setDiagnosticResults(results)
            try { sessionStorage.setItem(DIAGNOSTIC_DRAFT_KEY, JSON.stringify(results)) } catch { /* ignore */ }
            void advance('computing')
          }}
        />
      )

    case 'computing':
      return (
        <ComputeScreen
          athleteId={athlete.id}
          results={diagnosticResults ?? readDraft()}
          onComplete={() => {
            try { sessionStorage.removeItem(DIAGNOSTIC_DRAFT_KEY) } catch { /* ignore */ }
            void advance('zeroed_in')
          }}
        />
      )

    case 'zeroed_in':
      return (
        <ZeroedInScreen
          athleteId={athlete.id}
          onStartSession={() => {
            void advance('first_session_pending')
            navigate('/app/today')
          }}
        />
      )

    default:
      // Loop steps are handled by App; nothing to render here.
      return <div className="screen--centered"><Spinner /></div>
  }
}
