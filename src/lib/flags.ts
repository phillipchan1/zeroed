/**
 * Client feature flags. Pure so `flags.check.ts` can run under node
 * (`--experimental-strip-types`) without Vite.
 *
 * `onboarding_agent_v1` is OFF unless the build-time env is the string `'1'`.
 * A `?flag=onboarding_agent_v1` query override exists for DEV builds only —
 * production builds ignore it. Never set the env in wrangler, `.env*`, or CI.
 */

export interface FlagEnv {
  VITE_ONBOARDING_AGENT_V1?: string
  DEV?: boolean
}

export function onboardingAgentV1Enabled(env: FlagEnv, search: string): boolean {
  if (env.VITE_ONBOARDING_AGENT_V1 === '1') return true
  if (env.DEV !== true) return false
  const q = search.startsWith('?') ? search.slice(1) : search
  return new URLSearchParams(q).get('flag') === 'onboarding_agent_v1'
}
