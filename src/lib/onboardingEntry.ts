import type { OnboardingStep } from '../types/database'

/**
 * The onboarding entry the router should render. Pure so a .check.ts can prove
 * flag-off parity against today's `ONBOARDING_FUNNEL_STEPS` mapping.
 *
 * Flag off = today's machine: signed-out is always `hook` (even if a stale
 * athlete is still in memory); signed-in with no row is `bootstrap`; otherwise
 * the athlete's `onboarding_step` (`hook` / `orientation`) or `loop`.
 */
export type OnboardingEntry = 'hook' | 'orientation' | 'pack_picker' | 'bootstrap' | 'loop'

export function resolveOnboardingEntry({
  flagOn,
  user,
  athlete,
}: {
  flagOn: boolean
  user: { id: string } | null
  athlete: { onboarding_step: OnboardingStep } | null
}): OnboardingEntry {
  // Matches OnboardingRouter: no session → pre-auth funnel, regardless of any
  // athlete still in memory (sign-out clears `user` a render before `athlete`).
  if (!user) return flagOn ? 'pack_picker' : 'hook'
  if (!athlete) return 'bootstrap'
  if (athlete.onboarding_step === 'hook') return flagOn ? 'pack_picker' : 'hook'
  if (athlete.onboarding_step === 'orientation') return 'orientation'
  return 'loop'
}
