import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabaseClient'
import { Spinner } from '../../components/ui'
import { HookAct, OBSTACLE_STORAGE_KEY, PROBE_STORAGE_KEY, type ProbeStash } from './HookAct'
import { OrientationAct, type OrientationFields } from './OrientationAct'
import { CalibrateScreen } from './CalibrateScreen'
import type { AthleteRow, OnboardingStep } from '../../types/database'
import type { ProvisionalProfile } from '../../engine'

/**
 * Onboarding state machine (Confidence-Driven Read). Renders the right screen
 * for the athlete's onboarding_step. Gates the SESSION, not the read: the probe
 * runs pre-auth in HookAct; after auth, orientation calibrates a provisional
 * first session (an ephemeral build beat, no DB step) and hands it straight over.
 * Loop steps (first_session_*, complete) are routed by App, not here.
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
  // Ephemeral "calibrating your first session" beat — holds the orientation
  // fields while buildProvisionalProgram runs. Not a DB step.
  const [calibrating, setCalibrating] = useState<ProvisionalProfile | null>(null)
  const bootstrappedRef = useRef(false)

  // --- Bootstrap: just signed in, no athlete row yet -------------------------
  // Create it from the stashed obstacle, write the probe read as the first
  // insight, and drop into orientation.
  useEffect(() => {
    if (!user || athlete || bootstrappedRef.current) return
    bootstrappedRef.current = true
    void (async () => {
      let obstacle: string | null = null
      try { obstacle = localStorage.getItem(OBSTACLE_STORAGE_KEY) } catch { /* ignore */ }
      const { data: created } = await supabase
        .from('athlete')
        .insert({ auth_user_id: user.id, obstacle, onboarding_step: 'orientation' })
        .select('id')
        .single()
      try { localStorage.removeItem(OBSTACLE_STORAGE_KEY) } catch { /* ignore */ }
      if (created) await persistProbeInsight(created.id)
      refresh()
    })()
  }, [user, athlete, refresh])

  async function advance(step: OnboardingStep, fields?: Partial<AthleteRow>) {
    if (!athlete) return
    await supabase.from('athlete').update({ onboarding_step: step, ...fields }).eq('id', athlete.id)
    refresh()
  }

  // Write the stashed Probe hypothesis as the athlete's first insight (P1,
  // hypothesis status, low confidence). Clears the stash after, so it runs once.
  async function persistProbeInsight(athleteId: string) {
    let stash: ProbeStash | null = null
    try {
      const raw = localStorage.getItem(PROBE_STORAGE_KEY)
      stash = raw ? (JSON.parse(raw) as ProbeStash) : null
    } catch { stash = null }
    if (!stash) return

    try {
      await supabase.from('insight').insert({
        athlete_id: athleteId,
        source_id: null,
        claim: stash.hypothesis.claim,
        category: stash.hypothesis.category,
        priority: 'P1',
        confidence: stash.hypothesis.confidence,
        status: 'hypothesis',
        evidence: [{
          source: 'probe',
          obstacle: stash.obstacle,
          followup_answer: stash.followupAnswer,
          rationale: stash.hypothesis.rationale,
          logged_at: new Date().toISOString(),
        }],
        source: 'probe',
        program_impact: null,
      })
    } catch (e) {
      console.error('probe insight write failed', e)
    }
    try { localStorage.removeItem(PROBE_STORAGE_KEY) } catch { /* ignore */ }
  }

  // Orientation done → persist fields, then run the provisional build beat.
  function handleOrientationComplete(f: OrientationFields) {
    if (!athlete) return
    void supabase.from('athlete').update({
      name: f.name.trim() || null,
      training_age: f.trainingAge,
      sessions_per_week: f.sessions,
    }).eq('id', athlete.id)
    setCalibrating({
      name: f.name.trim() || null,
      trainingAge: f.trainingAge,
      sessions: f.sessions,
      obstacle: athlete.obstacle ?? null,
    })
  }

  // --- Pre-auth / bootstrap states ------------------------------------------
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
          onAuthedAdvance={(obstacle) => {
            void (async () => {
              await persistProbeInsight(athlete.id)
              await advance('orientation', { obstacle })
            })()
          }}
        />
      )

    case 'orientation':
      // Ephemeral build beat once orientation is submitted.
      if (calibrating) {
        return (
          <CalibrateScreen
            athleteId={athlete.id}
            profile={calibrating}
            onComplete={() => {
              void advance('first_session_pending')
              navigate('/app/today')
            }}
          />
        )
      }
      return (
        <OrientationAct
          athlete={athlete}
          obstacle={athlete.obstacle ?? ''}
          onComplete={handleOrientationComplete}
        />
      )

    default:
      // Loop steps are handled by App; nothing to render here.
      return <div className="screen--centered"><Spinner /></div>
  }
}
