/* The app coach and intake, the app's side (coach_v1, G6 + G7).
 *
 * The Worker composes the block, runs the app coach through the same tools as
 * any coach, and keeps the chat. This only sends and reads: intake answers,
 * the athlete's trade-off picks, their Approve tap, and their chat messages
 * (a "yes" to a preview is their chat approval). With the flag off the route
 * answers 404 and nothing here is called.
 */
import { coachUrl } from './api'
import { getAccessToken } from './authClient'

export type Quality = 'max_strength' | 'power' | 'aerobic' | 'alactic' | 'change_of_direction' | 'tissue_capacity' | 'mobility'
export type ModuleKey = 'court' | 'endurance' | 'field' | 'strength' | 'general'
export type TrainingAge = 'lt1' | '1to3' | '3to10' | '10plus'

export const MODULE_OPTIONS: Array<{ key: ModuleKey; label: string; hint: string }> = [
  { key: 'court', label: 'Court sport', hint: 'basketball, volleyball, tennis' },
  { key: 'endurance', label: 'Endurance', hint: 'running, cycling, rowing' },
  { key: 'field', label: 'Field sport', hint: 'soccer, rugby, ultimate' },
  { key: 'strength', label: 'Strength sport', hint: 'powerlifting, weightlifting' },
  { key: 'general', label: 'General fitness', hint: 'classes, hiking' },
]

export const TRAINING_AGE_OPTIONS: Array<{ key: TrainingAge; label: string }> = [
  { key: 'lt1', label: '< 1 yr' },
  { key: '1to3', label: '1–3 yrs' },
  { key: '3to10', label: '3–10 yrs' },
  { key: '10plus', label: '10+ yrs' },
]

export interface TradeOff {
  id: string
  message: string
  options: Array<{ id: string; label: string; effect: string }>
  default: string
  chosen: string | null
}

export interface BlockView {
  start: string
  end: string
  priorities: string[]
  tracks: Array<{ name: string; role: string; added_per_week: number; from_activities: number; why: string }>
  goals: Array<{ name: string; role: string; track: string | null; note: string | null }>
  week: string[]
  deload_week: { start: string; end: string; note: string }
  retest_week: { start: string; end: string; order: string[] }
  prehab: { items: Array<{ name: string; dose: string; minutes: number }>; minutes: number }
  screens: string[]
  held: Array<{ what: string; regions: string[]; note: string }>
  trade_offs: TradeOff[]
  needs_decision: boolean
  warnings: string[]
  minor: boolean
}

export interface ChatMessage { id: string; role: 'athlete' | 'coach'; body: string; created_at: string }

export interface CoachState {
  ok: boolean
  activities: Array<{ id: string; module: ModuleKey; name: string; sessions_per_week: number; season: 'in' | 'off'; days: number[] }>
  block: (BlockView & { id: string; methodology_version: string; modules_version: string }) | null
  recompose: 'no_block' | 'block_boundary' | 'inputs_changed' | null
  intake: { id: string; outcome: string; created_at: string } | null
  birth_date_on_file: boolean
  minor: boolean
  chat: ChatMessage[]
  modules: Array<{ key: ModuleKey; label: string; examples: string[]; screens: Array<{ key: string; name: string; unit: string; sided: boolean }> }>
  regions: string[]
  red_flags: string[]
}

export interface IntakeResult {
  ok: boolean
  text?: string
  errors?: string[]
  needs_consent?: boolean
  stopped?: boolean
  regions?: Array<{ region: string; why: string }>
  refer_out?: string
  preview_id?: string
  block?: BlockView
}

export interface ApplyResult { ok: boolean; applied: boolean; text: string; approval_ref?: string }

export interface TurnResult {
  ok: boolean
  text?: string
  message_id?: string
  reply?: ChatMessage
  previews?: string[]
  escalate?: string | null
  approval?: ApplyResult
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const url = coachUrl()
  if (!url) throw new Error('coach unavailable')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok && res.status !== 400) throw new Error(`coach ${res.status}`)
  return parsed as T
}

export function fetchCoachState(): Promise<CoachState | null> {
  if (!coachUrl()) return Promise.resolve(null)
  return post<CoachState>({ action: 'state' }).catch(() => null)
}

export function submitIntake(answers: Record<string, unknown>): Promise<IntakeResult> {
  return post<IntakeResult>({ action: 'intake', answers }).catch(() => ({ ok: false, errors: ['Could not reach the coach. Try again.'] }))
}

/** The athlete's trade-off picks: a new preview of the same block with them. */
export function repreviewBlock(previewId: string, resolutions: Record<string, string>): Promise<{ ok: boolean; text?: string; preview_id?: string; block?: BlockView }> {
  return post<{ ok: boolean; text?: string; preview_id?: string; block?: BlockView }>({ action: 'repreview', preview_id: previewId, resolutions })
    .catch(() => ({ ok: false, text: 'Could not reach the coach. Try again.' }))
}

/** The athlete's Approve tap: their approval, and the apply when the app can. */
export function approvePreview(previewId: string): Promise<ApplyResult> {
  return post<ApplyResult>({ action: 'approve', preview_id: previewId }).catch(() => ({ ok: false, applied: false, text: 'Could not reach the coach. Try again.' }))
}

/** One message. With `approves`, a yes is the athlete's chat approval of that preview. */
export function sendCoachMessage(message: string, approves?: string): Promise<TurnResult> {
  return post<TurnResult>({ action: 'chat', message, ...(approves ? { approves } : {}) })
    .catch(() => ({ ok: false, text: 'Could not reach the coach. Try again.' }))
}
