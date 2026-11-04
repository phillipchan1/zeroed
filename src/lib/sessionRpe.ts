/* Session RPE, the app's side (tracks_v1, G9).
 *
 * One CR-10 tap (0–10) for the whole session at the finish. The Worker stores
 * it in session_rpe, apart from the set RPEs (workout.rpe is their mean, and
 * stays that), logs it, and lets the athlete change it the same day. This only
 * sends and reads. With the flag off the route answers 404 and nothing here is
 * called.
 */
import { sessionRpeUrl } from './api'
import { getAccessToken } from './authClient'

export interface SessionRpeRating {
  date: string
  session_id: string
  rating: number
  duration_min: number | null
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const url = sessionRpeUrl()
  if (!url) throw new Error('session rpe unavailable')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`session rpe ${res.status}`)
  return parsed
}

/** Log (or, the same day, change) the session's rating. False on any failure. */
export async function logSessionRpe(input: { session_id: string; rating: number; duration_min: number | null; date: string }): Promise<boolean> {
  if (!sessionRpeUrl()) return false
  try {
    const out = await post({ action: 'log', ...input }) as { ok?: boolean } | null
    return out?.ok === true
  } catch {
    return false
  }
}

/** The rating already logged for this session on this date, if any. Null on any failure. */
export async function fetchSessionRpe(sessionId: string, date: string): Promise<SessionRpeRating | null> {
  if (!sessionRpeUrl()) return null
  try {
    const out = await post({ action: 'list', from: date, to: date }) as { ratings?: SessionRpeRating[] } | null
    return out?.ratings?.find((r) => r.session_id === sessionId) ?? null
  } catch {
    return null
  }
}
