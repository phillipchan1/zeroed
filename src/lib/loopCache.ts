/* The loop's cache keys, its warm-up, and its invalidation.
 *
 * Every screen in the daily loop reads one composed view object out of the
 * shared store in lib/cache.ts. Naming those keys in one place buys two things
 * the screens can't do individually:
 *
 *  1. WARM-UP — after the first screen paints, the tabs the athlete hasn't
 *     opened yet are fetched in the background, one at a time. By the time a tab
 *     is tapped its data is already held, so the FIRST visit is instant too, not
 *     just the second. This is the difference between "cached app" and "app with
 *     no loading".
 *
 *  2. INVALIDATION — finishing or editing a session moves almost everything: the
 *     week strip, the schedule, the training log, the program map, the read the
 *     coach is working from, the convergence reticle. Rather than have each
 *     screen guess what the others need, a commit marks the whole athlete's view
 *     set due for revalidation. Nothing is dropped, so nothing blanks — the next
 *     reader just paints what it has and refreshes behind it.
 */
import { useEffect } from 'react'
import { invalidateCache, prefetch } from './cache'

export const cacheKeys = {
  appState:    (userId: string)    => `app-state:${userId}`,
  today:       (athleteId: string) => `today:${athleteId}`,
  weekPager:   (athleteId: string) => `weekpager:${athleteId}`,
  program:     (athleteId: string) => `program:${athleteId}`,
  programMap:  (athleteId: string) => `programmap:${athleteId}`,
  history:     (athleteId: string) => `history:${athleteId}`,
  coach:       (athleteId: string) => `coach:${athleteId}`,
  profile:     (athleteId: string) => `profile:${athleteId}`,
  goals:       (athleteId: string) => `goals:${athleteId}`,
  goalExtras:  (goalId: string)    => `goal-extras:${goalId}`,
  proposals:   (athleteId: string) => `proposals:${athleteId}`,
  tracks:      (programId: string) => `tracks:${programId}`,
  convergence: (athleteId: string) => `convergence:${athleteId}`,
  recap:       (athleteId: string, reviewId?: string) => `recap:${athleteId}:${reviewId ?? 'latest'}`,
  workoutBoot: (routineId: string) => `workout:${routineId}`,
  // The per-routine session prescription on its own — what the Train screen's
  // session sheet reads to show concrete lb/kg targets without the full bootstrap.
  sessionRx:   (routineId: string) => `rx:${routineId}`,
  // tracks_v1: the same prescription for one dated session with its week-only
  // override applied. Kept apart from the bootstrap's copy, whose indexes follow
  // the template.
  sessionRxOn: (routineId: string, date: string) => `rx:${routineId}@${date}`,
  overrides:   (athleteId: string, weekStart: string) => `overrides:${athleteId}:${weekStart}`,
  // tracks_v1: the Changes feed under Program — every recorded write, newest first.
  changes:     (athleteId: string) => `changes:${athleteId}`,
  rxVersion:   (athleteId: string) => `rxver:${athleteId}`,
  // tracks_v1: today's check-in, pain and blocked regions (G4), and who read what.
  readiness:   (athleteId: string) => `readiness:${athleteId}`,
  coachAccess: (athleteId: string) => `coach-access:${athleteId}`,
  ageStatus: (athleteId: string) => `age-status:${athleteId}`,
  // tracks_v1: the engine's weekly review (G8), this week or a dated one.
  weeklyReview: (athleteId: string, week: string) => `wreview:${athleteId}:${week}`,
  // One finished session as performed — what the preview of a DONE session reads
  // instead of the prescription.
  sessionActuals: (workoutId: string) => `actuals:${workoutId}`,
}

/**
 * Mark every held view due for revalidation. Called after a session commits (or
 * any write that ripples across screens). Data is kept, so screens keep painting
 * instantly; they just refresh on next read instead of trusting the freshness
 * window.
 */
export function invalidateLoopViews(): void {
  invalidateCache(() => true)
}

// One warm-up per athlete per page-session. Module-level so the brief
// unmount/remount a refresh() causes doesn't re-trigger the sweep.
const warmed = new Set<string>()

/**
 * Pre-load the tabs the athlete hasn't opened yet, sequentially and off the
 * critical path, so the first tap on each is instant.
 *
 * Deliberately serial with a gap between fetches: these are multi-query reads,
 * and firing them all at once would compete with whatever screen the athlete is
 * actually looking at. Each is freshness-gated, so an already-warm key costs
 * nothing.
 */
export function useWarmLoopCaches(
  athleteId: string | null,
  loaders: Array<{ key: string; load: () => Promise<unknown> }>,
): void {
  useEffect(() => {
    if (!athleteId) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (warmed.has(athleteId)) return
    warmed.add(athleteId)

    let cancelled = false
    const queue = [...loaders]

    const pump = () => {
      if (cancelled) return
      const next = queue.shift()
      if (!next) return
      prefetch(next.key, next.load)
      // Space the warm-up out so it stays behind the athlete's own screen.
      window.setTimeout(pump, 400)
    }

    // Wait for the first screen to settle before spending anything on tabs the
    // athlete isn't looking at.
    const start = window.setTimeout(pump, 600)
    return () => {
      cancelled = true
      window.clearTimeout(start)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])
}
