import { useState } from 'react'
import { SplashScreen } from './SplashScreen'
import { ArenaScreen, type ArenaAnswer } from './ArenaScreen'
import { LimiterScreen, type LimiterAnswer } from './LimiterScreen'
import { ProbeScreen } from './ProbeScreen'
import { AuthSheet } from './AuthSheet'
import { FunnelFrame } from '../../components/layout/FunnelFrame'
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

type HookSub = 'splash' | 'arena' | 'limiter' | 'probe'

/**
 * Act 1+2 — Hook + Probe. Runs before auth for first-timers, and again after a
 * DebugReset for an already-authed athlete. Sequencing (Convergence Model):
 *   splash → ARENA (Move 1) → LIMITER (Move 2, w/ obstacle feeder) → PROBE → auth.
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
 *   • not authed                → slide up the auth sheet; bootstrap picks it up
 */
export function HookAct({
  authed,
  initialObstacle,
  initialArena,
  initialLimiterChoice,
  onAuthedAdvance,
}: {
  authed: boolean
  initialObstacle: string
  initialArena: ArenaAnswer | null
  initialLimiterChoice: string | null
  onAuthedAdvance: (obstacle: string) => void
}) {
  const [sub, setSub] = useState<HookSub>('splash')
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
      {sub === 'splash'  && <SplashScreen onBegin={() => setSub('arena')} />}
      {sub === 'arena'   && (
        <FunnelFrame><ArenaScreen initial={arena} onSubmit={handleArenaSubmit} /></FunnelFrame>
      )}
      {sub === 'limiter' && arena && (
        <FunnelFrame>
          <LimiterScreen
            arenaType={arena.type}
            arenaRaw={arena.raw}
            initialChoice={limiterChoice}
            initialObstacle={obstacle}
            onSubmit={handleLimiterSubmit}
          />
        </FunnelFrame>
      )}
      {sub === 'probe'   && arena && (
        <ProbeScreen
          arenaType={arena.type}
          arenaRaw={arena.raw}
          limiterChoice={limiterChoice}
          obstacle={obstacle}
          arenaConfidence={arena.confidence}
          onSaveRead={handleSaveRead}
        />
      )}

      {showAuth && <AuthSheet onClose={() => setShowAuth(false)} />}
    </>
  )
}
