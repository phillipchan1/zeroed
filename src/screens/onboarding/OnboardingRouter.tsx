import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AuthUser } from '../../lib/authClient'
import { supabase } from '../../lib/supabaseClient'
import { onboardingAgentV1Enabled } from '../../lib/flags'
import { resolveOnboardingEntry } from '../../lib/onboardingEntry'
import { Spinner } from '../../components/ui'
import { HookAct, OBSTACLE_STORAGE_KEY, PROBE_STORAGE_KEY, type ProbeStash } from './HookAct'
import type { ArenaAnswer } from './ArenaScreen'
import { OrientationAct, type OrientationFields } from './OrientationAct'
import { CalibrateScreen } from './CalibrateScreen'
import { WelcomeScreen } from './WelcomeScreen'
import { SignInScreen } from './SignInScreen'
import { STARTER_PACK_STORAGE_KEY, readStarterPack } from './starterPackStorage'
import type { AthleteRow, OnboardingStep, Priority } from '../../types/database'
import type { ProvisionalProfile } from '../../engine'

const CoachIntake = lazy(() => import('./CoachIntake'))

/**
 * Drop everything the pre-auth funnel stashed for the trip across sign-in. Called
 * once the athlete is in the loop, so a returning athlete who tapped "Get
 * started" by mistake, then signed in, carries nothing into a later reset.
 */
export function clearOnboardingCarry(): void {
  try {
    localStorage.removeItem(PROBE_STORAGE_KEY)
    localStorage.removeItem(OBSTACLE_STORAGE_KEY)
    localStorage.removeItem(STARTER_PACK_STORAGE_KEY)
  } catch { /* private mode */ }
}

/** Signed out, which door they're at. Local: a reload lands back on welcome. */
type Door = 'welcome' | 'sign_in' | 'start'

/**
 * Onboarding state machine (Confidence-Driven Read). Renders the right screen
 * for the athlete's onboarding_step. Signed out, it opens on two doors: "Get
 * started" (the intake, then sign-in to save it) or "I have an account" (sign-in
 * only). Either door works for either athlete — the row decides what's next.
 * After auth, orientation calibrates a provisional first session (an ephemeral
 * build beat, no DB step) and hands it straight over. Loop steps
 * (first_session_*, complete) are routed by App, not here.
 */
export function OnboardingRouter({
  user,
  athlete,
  refresh,
}: {
  user: AuthUser | null
  athlete: AthleteRow | null
  refresh: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const flagOn = onboardingAgentV1Enabled(
    { VITE_ONBOARDING_AGENT_V1: import.meta.env.VITE_ONBOARDING_AGENT_V1, DEV: import.meta.env.DEV },
    location.search,
  )
  const entry = resolveOnboardingEntry({ flagOn, user, athlete })
  const [door, setDoor] = useState<Door>('welcome')
  // Ephemeral "calibrating your first session" beat — holds the orientation
  // fields while buildProvisionalProgram runs. Not a DB step.
  const [calibrating, setCalibrating] = useState<ProvisionalProfile | null>(null)
  // The athlete's current P1 read (claim+category), threaded into orientation so
  // the Target question is inferred from the actual hypothesis, not raw obstacle
  // text. Stays null until loaded — orientation never blocks on it.
  const [hypothesis, setHypothesis] = useState<{ claim: string; category: string } | null>(null)
  const bootstrappedRef = useRef(false)

  // --- Bootstrap: just signed in, no athlete row yet -------------------------
  // Create it from the stashed obstacle, write the probe read as the first
  // insight, and drop into orientation. No stash means they came through "I
  // have an account" with an email that has no plan yet: start them at the
  // intake, already signed in, rather than in orientation with nothing to go on.
  useEffect(() => {
    if (!user || athlete || bootstrappedRef.current) return
    bootstrappedRef.current = true
    void (async () => {
      if (flagOn) {
        const pack = readStarterPack()
        if (pack) {
          const { data: created } = await supabase
            .from('athlete')
            .insert({
              auth_user_id: user.id,
              obstacle: pack.obstacle,
              arena_type: null,
              arena_raw: null,
              limiter_choice: null,
              onboarding_step: 'orientation',
              name: pack.name.trim() || null,
              goals: pack.goals,
              training_age: pack.trainingAge,
              sessions_per_week: pack.sessions,
            })
            .select('id')
            .single()
          if (created) await persistProbeInsight(created.id)
          refresh()
          return
        }
      }
      const stash = readProbeStash()
      let obstacle: string | null = stash?.obstacle ?? null
      try { obstacle = obstacle ?? localStorage.getItem(OBSTACLE_STORAGE_KEY) } catch { /* ignore */ }
      const { data: created } = await supabase
        .from('athlete')
        .insert({
          auth_user_id: user.id,
          obstacle,
          arena_type: stash?.arenaType ?? null,
          arena_raw: stash?.arenaRaw ?? null,
          limiter_choice: stash?.limiterChoice ?? null,
          onboarding_step: stash || obstacle ? 'orientation' : 'hook',
        })
        .select('id')
        .single()
      try { localStorage.removeItem(OBSTACLE_STORAGE_KEY) } catch { /* ignore */ }
      if (created) await persistProbeInsight(created.id)
      refresh()
    })()
  }, [user, athlete, refresh, flagOn])

  // --- Load the current P1 read for orientation -----------------------------
  // The highest-priority active insight (the same one persistProbeInsight wrote).
  // Fire-and-forget: orientation renders with hypothesis=null until this lands,
  // and a null result (model fell back / not yet readable) is a fine final state.
  useEffect(() => {
    if (!athlete) return
    void (async () => {
      const { data } = await supabase
        .from('insight')
        .select('claim, category')
        .eq('athlete_id', athlete.id)
        .not('status', 'in', '(resolved,disproved)')
        .order('priority')
        .limit(1)
        .maybeSingle()
      if (data) setHypothesis({ claim: data.claim, category: data.category })
    })()
  }, [athlete])

  // Flag-on pack path: orientation already has sessions/goals/name from the
  // stash, so skip the classic OrientationAct and run the existing calibrate beat.
  useEffect(() => {
    if (!flagOn || !athlete || athlete.onboarding_step !== 'orientation') return
    if (calibrating) return
    const pack = readStarterPack()
    if (!pack) return
    setCalibrating({
      name: pack.name.trim() || null,
      trainingAge: pack.trainingAge,
      sessions: pack.sessions,
      obstacle: pack.obstacle,
      effectiveTrainingAge: pack.effectiveTrainingAge,
      timeBoxMinutes: pack.timeBoxMinutes ?? undefined,
    })
  }, [flagOn, athlete, calibrating])

  async function advance(step: OnboardingStep, fields?: Partial<AthleteRow>) {
    if (!athlete) return
    await supabase.from('athlete').update({ onboarding_step: step, ...fields }).eq('id', athlete.id)
    refresh()
  }

  // Read the single pre-auth carry (arena + obstacle + hypothesis). Pure read —
  // does NOT clear; persistProbeInsight owns the one-time clear.
  function readProbeStash(): ProbeStash | null {
    try {
      const raw = localStorage.getItem(PROBE_STORAGE_KEY)
      return raw ? (JSON.parse(raw) as ProbeStash) : null
    } catch { return null }
  }

  // Write the stashed multi-axis read as the athlete's first insight STACK. The
  // limiter axes + durability become tracked insights (P1/P2/P3); heading and
  // capacity are read-display/visual only, not weak-link insights. Status
  // 'hypothesis', confidence from the (clamped) read. Clears the stash after.
  async function persistProbeInsight(athleteId: string) {
    const stash = readProbeStash()
    if (!stash) return

    // Map read axes → insight rows. Order fixes priority; only the persisted
    // axes (limiter_p1 → P1, limiter_p2 → P2, durability → P3) are weak links.
    const PRIORITY_BY_AXIS: Record<string, Priority> = {
      limiter_p1: 'P1', limiter_p2: 'P2', durability: 'P3',
    }
    const loggedAt = new Date().toISOString()
    const rows = (stash.read?.axes ?? [])
      .filter((a) => a.id in PRIORITY_BY_AXIS)
      .map((a) => ({
        athlete_id: athleteId,
        source_id: null,
        claim: a.claim,
        category: a.category as string,
        priority: PRIORITY_BY_AXIS[a.id],
        confidence: a.confidence,
        status: 'hypothesis' as const,
        evidence: [{
          source: 'probe',
          axis: a.id,
          arena_type: stash.arenaType,
          arena_raw: stash.arenaRaw,
          limiter_choice: stash.limiterChoice,
          obstacle: stash.obstacle,
          followup_answer: stash.followupAnswer,
          rationale: a.id === 'limiter_p1' ? stash.read.hypothesis.rationale : a.tilt,
          read_source: stash.read.source,
          logged_at: loggedAt,
        }],
        source: 'probe',
        program_impact: a.tilt ?? null,
      }))

    // Fallback: a stash with no axes (legacy/edge) still writes the P1 hypothesis.
    if (rows.length === 0 && stash.read?.hypothesis) {
      rows.push({
        athlete_id: athleteId,
        source_id: null,
        claim: stash.read.hypothesis.claim,
        category: stash.read.hypothesis.category,
        priority: 'P1',
        confidence: stash.read.hypothesis.confidence,
        status: 'hypothesis' as const,
        evidence: [{
          source: 'probe', axis: 'limiter_p1',
          arena_type: stash.arenaType, arena_raw: stash.arenaRaw,
          limiter_choice: stash.limiterChoice, obstacle: stash.obstacle,
          followup_answer: stash.followupAnswer, rationale: stash.read.hypothesis.rationale,
          read_source: stash.read.source, logged_at: loggedAt,
        }],
        source: 'probe',
        program_impact: null,
      })
    }

    try {
      if (rows.length) await supabase.from('insight').insert(rows)
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
      goals: f.target.trim() || null,
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
  // No session → always the pre-auth funnel, regardless of any athlete still in
  // memory. On sign-out `user` clears a render before the cached athlete does;
  // without this guard we'd briefly render an authed onboarding step (several
  // carry an autoFocus input), which popped the keyboard over the splash in the
  // weird in-between frame during logout.
  if (!user) {
    if (door === 'welcome') {
      return <WelcomeScreen onGetStarted={() => setDoor('start')} onSignIn={() => setDoor('sign_in')} />
    }
    if (door === 'sign_in') {
      return (
        <SignInScreen
          intent="returning"
          onBack={() => setDoor('welcome')}
          onGetStarted={() => setDoor('start')}
        />
      )
    }
    if (entry === 'pack_picker') {
      return (
        <Suspense fallback={<div className="screen--centered"><Spinner /></div>}>
          <CoachIntake
            authed={false}
            onExit={() => setDoor('welcome')}
            onAuthedComplete={() => { /* unreachable while unauthenticated */ }}
          />
        </Suspense>
      )
    }
    return (
      <HookAct
        authed={false}
        initialObstacle=""
        initialArena={null}
        initialLimiterChoice={null}
        onAuthedAdvance={() => { /* unreachable while unauthenticated */ }}
        onExit={() => setDoor('welcome')}
      />
    )
  }
  if (!athlete) {
    return <div className="screen--centered"><Spinner /></div>
  }

  // Rehydrate the Arena + Limiter into HookAct on re-entry (e.g. an authed 'hook'
  // user). Both survive the magic-link reload via the row, not just the stash.
  const initialArena: ArenaAnswer | null = athlete.arena_type
    ? { type: athlete.arena_type, raw: athlete.arena_raw ?? '', confidence: 'high' }
    : null
  const initialLimiterChoice: string | null = athlete.limiter_choice ?? null

  // --- Funnel steps ----------------------------------------------------------
  switch (athlete.onboarding_step) {
    case 'hook':
      if (entry === 'pack_picker') {
        return (
          <Suspense fallback={<div className="screen--centered"><Spinner /></div>}>
            <CoachIntake
              authed
              signedInAs={user.email}
              onAuthedComplete={() => {
                const pack = readStarterPack()
                void (async () => {
                  const stash = readProbeStash()
                  await persistProbeInsight(athlete.id)
                  await advance('orientation', {
                    obstacle: pack?.obstacle ?? stash?.obstacle ?? athlete.obstacle,
                    arena_type: stash?.arenaType ?? null,
                    arena_raw: stash?.arenaRaw ?? null,
                    limiter_choice: stash?.limiterChoice ?? null,
                    name: pack?.name.trim() || athlete.name,
                    goals: pack?.goals ?? athlete.goals,
                    training_age: pack?.trainingAge ?? athlete.training_age,
                    sessions_per_week: pack?.sessions ?? athlete.sessions_per_week,
                  })
                })()
              }}
            />
          </Suspense>
        )
      }
      return (
        <HookAct
          authed={!!user}
          initialObstacle={athlete.obstacle ?? ''}
          initialArena={initialArena}
          initialLimiterChoice={initialLimiterChoice}
          onAuthedAdvance={(obstacle) => {
            void (async () => {
              // Read the carry BEFORE persistProbeInsight clears it.
              const stash = readProbeStash()
              await persistProbeInsight(athlete.id)
              await advance('orientation', {
                obstacle,
                arena_type: stash?.arenaType ?? null,
                arena_raw: stash?.arenaRaw ?? null,
                limiter_choice: stash?.limiterChoice ?? null,
              })
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
          hypothesis={hypothesis}
          onComplete={handleOrientationComplete}
        />
      )

    default:
      // Loop steps are handled by App; nothing to render here.
      return <div className="screen--centered"><Spinner /></div>
  }
}
