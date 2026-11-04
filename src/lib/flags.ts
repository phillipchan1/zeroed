/**
 * Client feature flags. Pure so `flags.check.ts` can run under node
 * (`--experimental-strip-types`) without Vite.
 *
 * `onboarding_agent_v1` is OFF unless the build-time env is the string `'1'`.
 * A `?flag=onboarding_agent_v1` query override exists for DEV builds only —
 * production builds ignore it. Never set the env in wrangler, `.env*`, or CI.
 *
 * `arc_load_v1` is a runtime flag: the build env is only its ceiling, and the
 * athlete's own row (`athlete.flags`) turns it on, one person at a time. So
 * rolling it back is one UPDATE, not an App Store build:
 *
 *   UPDATE athlete SET flags = flags - 'arc_load_v1';           -- everyone
 *   UPDATE athlete SET flags = flags - 'arc_load_v1' WHERE id = '…';
 */

export interface FlagEnv {
  VITE_ONBOARDING_AGENT_V1?: string
  VITE_ARC_LOAD_V1?: string
  DEV?: boolean
}

function devOverride(name: string, env: FlagEnv, search: string): boolean {
  if (env.DEV !== true) return false
  const q = search.startsWith('?') ? search.slice(1) : search
  return new URLSearchParams(q).getAll('flag').includes(name)
}

export function onboardingAgentV1Enabled(env: FlagEnv, search: string): boolean {
  if (env.VITE_ONBOARDING_AGENT_V1 === '1') return true
  return devOverride('onboarding_agent_v1', env, search)
}

/**
 * `athlete.flags` as the client reads it: only literal `true` counts, so a
 * missing column, a null, a string "true" or a malformed blob all read as off.
 */
export function readAthleteFlags(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === true) out[k] = true
  }
  return out
}

/**
 * Session RPE, logging outside the plan, and the athlete's own calendar zone.
 * On when the build allows it (`VITE_ARC_LOAD_V1=1`) AND this athlete's row
 * says so. DEV builds also take `?flag=arc_load_v1`.
 */
export function arcLoadV1Enabled(env: FlagEnv, athleteFlags: unknown, search: string): boolean {
  if (devOverride('arc_load_v1', env, search)) return true
  if (env.VITE_ARC_LOAD_V1 !== '1') return false
  return readAthleteFlags(athleteFlags).arc_load_v1 === true
}

/**
 * Multi-track programs, structured goals, workout notes.
 * Athlete-row only — no build-time ceiling — so the UI appears the day
 * the flag is written. DEV builds also take `?flag=tracks_v1`.
 *
 *   UPDATE athlete SET flags = flags - 'tracks_v1';
 */
export function tracksV1Enabled(env: FlagEnv, athleteFlags: unknown, search: string): boolean {
  if (devOverride('tracks_v1', env, search)) return true
  return readAthleteFlags(athleteFlags).tracks_v1 === true
}

/**
 * coach_v1 (G6 + G7): intake, activities and the server-side app coach.
 * Athlete-row only, like tracks_v1, and only together with it: coach_v1
 * without tracks_v1 is off. DEV builds also take `?flag=coach_v1` (with
 * `?flag=tracks_v1`).
 *
 *   UPDATE athlete SET flags = flags - 'coach_v1';
 */
export function coachV1Enabled(env: FlagEnv, athleteFlags: unknown, search: string): boolean {
  if (!tracksV1Enabled(env, athleteFlags, search)) return false
  if (devOverride('coach_v1', env, search)) return true
  return readAthleteFlags(athleteFlags).coach_v1 === true
}
