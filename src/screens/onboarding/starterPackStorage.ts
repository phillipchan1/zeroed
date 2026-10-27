import type { PackSettings, ResolvedPack, StarterPackId } from '../../engine/starterPacks'

/** Same localStorage pattern as `PROBE_STORAGE_KEY` in HookAct. */
export const STARTER_PACK_STORAGE_KEY = 'zeroed.starterPack'

export interface StarterPackStash {
  packId: StarterPackId
  settings: PackSettings
  name: string
  trainingAge: number
  sessions: number
  goals: string
  obstacle: string
  effectiveTrainingAge: number
  timeBoxMinutes: number | null
}

export function writeStarterPack(stash: StarterPackStash): void {
  try {
    localStorage.setItem(STARTER_PACK_STORAGE_KEY, JSON.stringify(stash))
  } catch { /* private mode */ }
}

export function readStarterPack(): StarterPackStash | null {
  try {
    const raw = localStorage.getItem(STARTER_PACK_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StarterPackStash) : null
  } catch {
    return null
  }
}

export function stashFromResolved(resolved: ResolvedPack, name: string): StarterPackStash {
  return {
    packId: resolved.id,
    settings: resolved.settings,
    name: name.trim(),
    trainingAge: resolved.trainingAge,
    sessions: resolved.sessions,
    goals: resolved.goal,
    obstacle: resolved.obstacle,
    effectiveTrainingAge: resolved.effectiveTrainingAge,
    timeBoxMinutes: resolved.timeBoxMinutes,
  }
}
