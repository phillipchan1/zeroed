// arc_load_v1 on the client: is it on for this athlete, and which calendar do
// the week boundaries use.
//
// The flag itself is pure (lib/flags.ts). This module holds its resolved value
// for the screens to read during render, and owns the one side effect the flag
// has outside them: with it on, the week runs on the device's zone, and that
// zone is written to athlete.time_zone so the MCP servers use the same week.

import { useEffect, useMemo } from 'react'
import { arcLoadV1Enabled } from './flags'
import { invalidateLoopViews } from './loopCache'
import { supabase } from './supabaseClient'
import { deviceTimeZone, setAthleteTimeZone } from '../engine/weekDates'
import type { AthleteRow } from '../types/database'

const DEV_FLAGS_KEY = 'zeroed.dev_flags'

let on = false

// DEV's ?flag= override has to survive the SPA navigating away from the URL
// that carried it, so the last search that named a flag is kept for the tab.
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
export function arcLoadOn(): boolean {
  return on
}

/**
 * Resolve the flag from the athlete row, before the screens under the shell
 * render. Calendar moved → every cached view was bucketed on the old week, so
 * they're all marked due.
 */
export function useArcLoad(athlete: Pick<AthleteRow, 'id' | 'flags' | 'time_zone'> | null): boolean {
  const flags = athlete?.flags
  const { enabled, moved } = useMemo(() => {
    on = arcLoadV1Enabled(import.meta.env, flags, devSearch())
    return { enabled: on, moved: setAthleteTimeZone(on ? deviceTimeZone() : null) }
  }, [flags])

  useEffect(() => {
    if (moved) invalidateLoopViews()
  }, [moved])

  const athleteId = athlete?.id
  const stored = athlete?.time_zone ?? null
  useEffect(() => {
    if (!enabled || !athleteId) return
    const tz = deviceTimeZone()
    if (!tz || tz === stored) return
    // Best effort: offline or a database without the column (it ships by hand)
    // just tries again on the next launch.
    void supabase.from('athlete').update({ time_zone: tz }).eq('id', athleteId).then(() => undefined, () => undefined)
  }, [enabled, athleteId, stored])

  return enabled
}
