import { useState } from 'react'
import { SplashScreen } from './SplashScreen'
import { HookQuestionScreen } from './HookQuestionScreen'
import { ProbeScreen } from './ProbeScreen'
import { AuthSheet } from './AuthSheet'
import type { ProbeOutcome } from '../../engine'

export const OBSTACLE_STORAGE_KEY = 'zeroed.obstacle'
export const PROBE_STORAGE_KEY = 'zeroed.probe'

export interface ProbeStash {
  obstacle: string
  followupAnswer: string | null
  hypothesis: ProbeOutcome['hypothesis']
}

type HookSub = 'splash' | 'question' | 'probe'

/**
 * Act 1+2 — Hook + Probe. Runs before auth for first-timers, and again after a
 * DebugReset for an already-authed athlete. Sequencing (Confidence-Driven Read):
 *   splash → obstacle question → PROBE (adaptive Q + hypothesis insight) → auth.
 *
 * The auth seam now fires AFTER the first insight, not before it. The obstacle
 * and the probe read are stashed in localStorage so they survive the magic-link
 * round trip; OnboardingRouter's bootstrap writes the hypothesis as the first
 * insight once the athlete row exists.
 *   • authed (e.g. post-reset)  → persist the read + advance to orientation
 *   • not authed                → slide up the auth sheet; bootstrap picks it up
 */
export function HookAct({
  authed,
  initialObstacle,
  onAuthedAdvance,
}: {
  authed: boolean
  initialObstacle: string
  onAuthedAdvance: (obstacle: string) => void
}) {
  const [sub, setSub] = useState<HookSub>('splash')
  const [obstacle, setObstacle] = useState(initialObstacle)
  const [showAuth, setShowAuth] = useState(false)

  function handleQuestionSubmit(answer: string) {
    setObstacle(answer)
    try { localStorage.setItem(OBSTACLE_STORAGE_KEY, answer) } catch { /* private mode */ }
    setSub('probe')
  }

  function handleSaveRead(outcome: ProbeOutcome, followupAnswer: string | null) {
    // Stash the read so it survives auth / the magic-link reload. The athlete
    // row may not exist yet (pre-auth), so the actual insight write happens in
    // OnboardingRouter (bootstrap, or the authed-advance path).
    try {
      const stash: ProbeStash = { obstacle, followupAnswer, hypothesis: outcome.hypothesis }
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
      {sub === 'splash'   && <SplashScreen onBegin={() => setSub('question')} />}
      {sub === 'question' && <HookQuestionScreen initial={obstacle} onSubmit={handleQuestionSubmit} />}
      {sub === 'probe'    && <ProbeScreen obstacle={obstacle} onSaveRead={handleSaveRead} />}

      {showAuth && <AuthSheet onClose={() => setShowAuth(false)} />}
    </>
  )
}
