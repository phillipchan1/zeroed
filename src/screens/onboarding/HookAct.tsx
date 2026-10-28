import { useState } from 'react'
import { ArenaScreen, type ArenaAnswer } from './ArenaScreen'
import { LimiterScreen, type LimiterAnswer } from './LimiterScreen'
import { ProbeScreen } from './ProbeScreen'
import { SignInScreen } from './SignInScreen'
import { FunnelFrame } from '../../components/layout/FunnelFrame'
import { BackButton } from '../../components/ui'
import type { ReadSynthesis } from '../../engine'
import type { ArenaType, ReadAxis } from '../../engine/demandTables'

export const OBSTACLE_STORAGE_KEY = 'zeroed.obstacle'
export const PROBE_STORAGE_KEY = 'zeroed.probe'

// The single pre-auth carry. Arena (Move 1) + Limiter choice (Move 2) + obstacle
// (the Limiter's free-text feeder) + the synthesized multi-axis read all cross
// auth in THIS object — same mechanism, no parallel channel. OnboardingRouter
// hydrates the athlete row (arena/limiter columns, obstacle) and the insight
// stack (P1/P2/durability from the axes) from it at bootstrap.
export interface ProbeStash {
  obstacle: string
  arenaType: ArenaType | null
  arenaRaw: string | null
  limiterChoice: string | null
  followupAnswer: string | null
  read: {
    source: string
    aggregateConfidence: number
    axes: ReadAxis[]
    hypothesis: { claim: string; category: string; confidence: number; rationale: string }
  }
}

type HookSub = 'arena' | 'limiter' | 'probe'

/**
 * Act 1+2 — Hook + Probe. Runs before auth for first-timers (after "Get started"
 * on the welcome screen), and again after a DebugReset for an already-authed
 * athlete. Sequencing (Convergence Model):
 *   ARENA (Move 1) → LIMITER (Move 2, w/ obstacle feeder) → PROBE → save (auth).
 *
 * The standalone obstacle question is gone: obstacle is now the optional
 * free-text feeder ON the Limiter screen (Convergence §4c — feeds the limiter
 * prior, not its own beat). The probe still consumes obstacle, so the read stays
 * as rich as before; a blank obstacle just means the forced choice alone drives it.
 *
 * The auth seam fires AFTER the first insight. Arena + Limiter + obstacle + probe
 * read are stashed in localStorage so they survive the magic-link round trip;
 * OnboardingRouter's bootstrap hydrates the row + writes the insight.
 *   • authed (e.g. post-reset)  → persist the read + advance to orientation
 *   • not authed                → the email-code sign-in; bootstrap picks it up
 */
export function HookAct({
  authed,
  initialObstacle,
  initialArena,
  initialLimiterChoice,
  onAuthedAdvance,
  onExit,
}: {
  authed: boolean
  initialObstacle: string
  initialArena: ArenaAnswer | null
  initialLimiterChoice: string | null
  onAuthedAdvance: (obstacle: string) => void
  /** Back from the first question (signed out: to the welcome screen). */
  onExit?: () => void
}) {
  const [sub, setSub] = useState<HookSub>('arena')
  const [arena, setArena] = useState<ArenaAnswer | null>(initialArena)
  const [limiterChoice, setLimiterChoice] = useState<string | null>(initialLimiterChoice)
  const [obstacle, setObstacle] = useState(initialObstacle)
  const [showAuth, setShowAuth] = useState(false)

  function handleArenaSubmit(answer: ArenaAnswer) {
    setArena(answer)
    setSub('limiter')
  }

  function handleLimiterSubmit(answer: LimiterAnswer) {
    setLimiterChoice(answer.choice)
    setObstacle(answer.obstacle)
    try { localStorage.setItem(OBSTACLE_STORAGE_KEY, answer.obstacle) } catch { /* private mode */ }
    setSub('probe')
  }

  function handleSaveRead(read: ReadSynthesis, followupAnswer: string | null) {
    // Stash the whole read so it survives auth / the magic-link reload. The
    // athlete row may not exist yet (pre-auth), so the actual writes happen in
    // OnboardingRouter (bootstrap, or the authed-advance path).
    try {
      const stash: ProbeStash = {
        obstacle,
        arenaType: arena?.type ?? null,
        arenaRaw: arena?.raw ?? null,
        limiterChoice,
        followupAnswer,
        read: {
          source: read.source,
          aggregateConfidence: read.aggregateConfidence,
          axes: read.axes,
          hypothesis: read.hypothesis,
        },
      }
      localStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(stash))
    } catch { /* private mode */ }

    if (authed) {
      onAuthedAdvance(obstacle)
    } else {
      setShowAuth(true)
    }
  }

  return (
    <>
      {sub === 'arena'   && (
        <FunnelFrame>
          {onExit && <BackButton floating onClick={onExit} />}
          <ArenaScreen initial={arena} onSubmit={handleArenaSubmit} />
        </FunnelFrame>
      )}
      {sub === 'limiter' && arena && (
        <FunnelFrame>
          <BackButton floating onClick={() => setSub('arena')} />
          <LimiterScreen
            arenaType={arena.type}
            arenaRaw={arena.raw}
            initialChoice={limiterChoice}
            initialObstacle={obstacle}
            onSubmit={handleLimiterSubmit}
          />
        </FunnelFrame>
      )}
      {/* Kept mounted (hidden) under the sign-in so Back doesn't re-run the read. */}
      {sub === 'probe'   && arena && (
        <div hidden={showAuth}>
          <ProbeScreen
            arenaType={arena.type}
            arenaRaw={arena.raw}
            limiterChoice={limiterChoice}
            obstacle={obstacle}
            arenaConfidence={arena.confidence}
            onSaveRead={handleSaveRead}
            onBack={() => setSub('limiter')}
          />
        </div>
      )}

      {showAuth && <SignInScreen intent="save" onBack={() => setShowAuth(false)} />}
    </>
  )
}
