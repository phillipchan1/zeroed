// tracks_v1 on the client: is it on for this athlete.
//
// The flag itself is pure (lib/flags.ts). This module holds its resolved value
// for the screens to read during render. No calendar side-effect — unlike
// arc_load_v1, turning this on does not move the week.

import { useMemo } from 'react'
import { coachV1Enabled, skillBlocksV1Enabled, tracksV1Enabled } from './flags'
import type { AthleteRow } from '../types/database'

const DEV_FLAGS_KEY = 'zeroed.dev_flags'

let on = false
let coach = false
let skill = false

function devSearch(): string {
  if (!import.meta.env.DEV) return ''
  try {
    const now = window.location.search
    if (new URLSearchParams(now).getAll('flag').length) sessionStorage.setItem(DEV_FLAGS_KEY, now)
    return sessionStorage.getItem(DEV_FLAGS_KEY) ?? now
  } catch {
    return ''
  }
}

/** Read during render by any screen below the app shell. */
export function tracksOn(): boolean {
  return on
}

/** coach_v1 (with tracks_v1): intake and the server-side app coach. Read during render. */
export function coachOn(): boolean {
  return coach
}

/** skill_blocks_v1 (spec §12), on its own: skill blocks never run the interval timer. Read during render. */
export function skillBlocksOn(): boolean {
  return skill
}

/**
 * Resolve the flag from the athlete row before the screens under the shell
 * render. Missing column / null / non-true all read as off. coach_v1 is
 * resolved alongside it (it only counts with tracks_v1), and so is
 * skill_blocks_v1 (which doesn't need it).
 */
export function useTracksV1(athlete: Pick<AthleteRow, 'flags'> | null): boolean {
  const flags = athlete?.flags
  return useMemo(() => {
    const search = devSearch()
    on = tracksV1Enabled(import.meta.env, flags, search)
    coach = coachV1Enabled(import.meta.env, flags, search)
    skill = skillBlocksV1Enabled(import.meta.env, flags, search)
    return on
  }, [flags])
}
