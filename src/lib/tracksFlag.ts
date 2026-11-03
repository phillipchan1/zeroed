// tracks_v1 on the client: is it on for this athlete.
//
// The flag itself is pure (lib/flags.ts). This module holds its resolved value
// for the screens to read during render. No calendar side-effect — unlike
// arc_load_v1, turning this on does not move the week.

import { useMemo } from 'react'
import { tracksV1Enabled } from './flags'
import type { AthleteRow } from '../types/database'

const DEV_FLAGS_KEY = 'zeroed.dev_flags'

let on = false

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

/**
 * Resolve the flag from the athlete row before the screens under the shell
 * render. Missing column / null / non-true all read as off.
 */
export function useTracksV1(athlete: Pick<AthleteRow, 'flags'> | null): boolean {
  const flags = athlete?.flags
  return useMemo(() => {
    on = tracksV1Enabled(import.meta.env, flags, devSearch())
    return on
  }, [flags])
}
