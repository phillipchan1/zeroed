/* The daily check-in, the app's side (tracks_v1, G4).
 *
 * The athlete logs sleep, stress, soreness and pain by region; the Worker
 * stores it, decides each region's U7 status and applies readiness to the
 * day's prescription. This only fetches, sends and displays. With the flag off
 * the route answers 404 and every reader here degrades to "nothing to show".
 */
import { readinessUrl } from './api'
import { getAccessToken } from './authClient'

export type RegionStatus = 'ok' | 'capped' | 'blocked'

export interface PainInput {
  region: string
  score: number
  red_flags: string[]
}

export interface CheckinInput {
  sleep_hours: number | null
  stress: number | null
  soreness: number | null
  pain: PainInput[]
}

export interface ReadinessToday {
  date: string
  available: boolean
  checkin: { sleep_hours: number | null; stress: number | null; soreness: number | null } | null
  pain: Array<PainInput & { date: string }>
  readiness: {
    flags: Array<{ kind: string; message: string }>
    level: 'none' | 'trim_accessories' | 'pull_hiit_plyo'
    regions: Array<{ region: string; status: RegionStatus; score: number; reason: string }>
    blocked_regions: string[]
    refer_out: string | null
  }
  blocked: Array<{ region: string; reason: string | null; since: string }>
  regions: string[]
  red_flags: string[]
}

export interface CheckinResult {
  ok: boolean
  text: string
}

export interface CoachAccess {
  coaches: Array<{ id: string; name: string; last_four: string; share_health: boolean }>
  reads: Array<{ id: string; created_at: string; who: string; tool: string }>
}

export const RED_FLAG_LABEL: Record<string, string> = {
  swelling: 'Swelling',
  locking: 'Locking',
  giving_way: 'Giving way',
  numbness_tingling: 'Numbness / tingling',
  radiating: 'Radiating pain',
  chest_pain: 'Chest pain',
  fainting: 'Fainting',
  breathlessness: 'Unusual breathlessness',
  acute_injury: 'Acute injury (pop, sudden sharp pain)',
  worsening: 'Worse each session',
}

export function regionLabel(region: string): string {
  const s = region.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "Read your workouts" from search_lifts / list_workouts, for the access list. */
export function readLabel(tool: string): string {
  return tool.replace(/^(get|list|search)_/, '').replace(/_/g, ' ')
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const url = readinessUrl()
  if (!url) throw new Error('readiness unavailable')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`readiness ${res.status}`)
  return parsed
}

/** Today's check-in and blocks. Null on any failure. */
export async function fetchReadinessToday(): Promise<ReadinessToday | null> {
  if (!readinessUrl()) return null
  try {
    const out = await post({ action: 'today' }) as ReadinessToday | null
    return out && typeof out.date === 'string' ? out : null
  } catch {
    return null
  }
}

export async function submitCheckin(input: CheckinInput): Promise<CheckinResult> {
  try {
    const out = await post({ action: 'checkin', ...input }) as Partial<CheckinResult>
    return { ok: out?.ok === true, text: String(out?.text ?? '') }
  } catch {
    return { ok: false, text: 'Couldn’t reach the server. Nothing was logged; try again when you’re online.' }
  }
}

/** The athlete's own "cleared by a clinician". Only the athlete can; no coach. */
export async function clearRegion(region: string): Promise<CheckinResult> {
  try {
    const out = await post({ action: 'clear_region', region }) as Partial<CheckinResult>
    return { ok: out?.ok === true, text: String(out?.text ?? '') }
  } catch {
    return { ok: false, text: 'Couldn’t reach the server. Nothing changed.' }
  }
}

export async function fetchCoachAccess(): Promise<CoachAccess | null> {
  if (!readinessUrl()) return null
  try {
    const out = await post({ action: 'coach_access', limit: 30 }) as CoachAccess | null
    return out && Array.isArray(out.coaches) ? out : null
  } catch {
    return null
  }
}

export async function setCoachHealth(tokenId: string, on: boolean): Promise<CheckinResult> {
  try {
    const out = await post({ action: 'set_coach_health', token_id: tokenId, on }) as Partial<CheckinResult>
    return { ok: out?.ok === true, text: String(out?.text ?? '') }
  } catch {
    return { ok: false, text: 'Couldn’t reach the server. Nothing changed.' }
  }
}
