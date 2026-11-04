/* GET /api/weekly-review?week= — the athlete's own session (tracks_v1, G8).
 * 404 (flag off, or an older Worker) reads as "off"; anything else that isn't
 * a review reads as an error the card can retry.
 */
import { weeklyReviewUrl } from './api'
import { getAccessToken } from './authClient'
import type { ReviewResult, WeeklyReview } from './weeklyReview'

/** The review for the week holding `week` (YYYY-MM-DD), or this week. */
export async function fetchWeeklyReview(week?: string): Promise<ReviewResult> {
  const url = weeklyReviewUrl()
  if (!url) return { status: 'off' }
  const headers: Record<string, string> = {}
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  try {
    const res = await fetch(week ? `${url}?week=${encodeURIComponent(week)}` : url, { credentials: 'include', headers })
    if (res.status === 404) return { status: 'off' }
    const out = await res.json().catch(() => null) as (WeeklyReview & { error?: string }) | null
    if (!res.ok || !out || typeof out.call !== 'string') {
      return { status: 'error', text: out?.error ? String(out.error) : 'Couldn’t load the review.' }
    }
    return { status: 'ok', review: out }
  } catch {
    return { status: 'error', text: 'Couldn’t reach the server. Try again when you’re online.' }
  }
}
