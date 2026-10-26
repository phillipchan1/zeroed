// Per-device memory for exercise swaps — the two things worth not re-asking:
//
//   · what gear this gym has (the chips the athlete last left on), so the second
//     swap of a hotel-week session is already filtered to dumbbells;
//   · what they picked last time in place of a given movement, so the gym with
//     no T-bar puts "chest-supported row" first next week too.
//
// Conveniences only. localStorage, every access guarded: a private window or a
// cleared site just means the sheet opens on its defaults. Nothing here is a
// record — the swap itself lives in the session's exercises_snapshot.

import type { Equipment } from '../engine/exerciseLibrary'

const GEAR_KEY = 'zeroed:swap-gear'
const RECENT_KEY = 'zeroed:swap-recent'
const RECENT_PER_MOVEMENT = 5

export function loadSwapGear(): Equipment[] {
  try {
    const raw = localStorage.getItem(GEAR_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as Equipment[]) : []
  } catch {
    return []
  }
}

export function saveSwapGear(gear: Equipment[]): void {
  try { localStorage.setItem(GEAR_KEY, JSON.stringify(gear)) } catch { /* non-fatal */ }
}

function readRecent(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const v = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string[]> : {}
  } catch {
    return {}
  }
}

/** Stand-ins picked for this movement before, most recent first. */
export function recentSwapsFor(programmed: string): string[] {
  const list = readRecent()[programmed]
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
}

export function rememberSwap(programmed: string, substitute: string): void {
  try {
    const all = readRecent()
    const prior = Array.isArray(all[programmed]) ? all[programmed] : []
    all[programmed] = [substitute, ...prior.filter((n) => n !== substitute)].slice(0, RECENT_PER_MOVEMENT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(all))
  } catch { /* non-fatal */ }
}
