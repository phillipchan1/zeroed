import { useState } from 'react'
import { SplashScreen } from './SplashScreen'
import { HookQuestionScreen } from './HookQuestionScreen'
import { ReframeScreen } from './ReframeScreen'
import { AuthSheet } from './AuthSheet'

export const OBSTACLE_STORAGE_KEY = 'zeroed.obstacle'

type HookSub = 'splash' | 'question' | 'reframe'

/**
 * Act 1 — Hook (Screens 01–03). Runs before auth for first-timers, and again
 * after a DebugReset for an already-authed athlete. The obstacle is stashed in
 * localStorage so it survives the magic-link round trip; on reframe → Start:
 *   • authed (e.g. post-reset)  → write obstacle + advance to orientation
 *   • not authed                → slide up the auth sheet; bootstrap picks up
 *                                 the stashed obstacle when they return
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
    setSub('reframe')
  }

  function handleStart() {
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
      {sub === 'reframe'  && <ReframeScreen onStart={handleStart} />}

      {showAuth && <AuthSheet onClose={() => setShowAuth(false)} />}
    </>
  )
}
