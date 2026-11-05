/* Week-only session overrides, the app's side (tracks_v1).
 *
 * A coach (or the athlete) changed one dated session without touching the
 * plan. The Worker owns them: /api/session-rx applies one when asked for that
 * date, and /api/session-override lists what is active so Train and Program
 * can show a "This week only" badge. With the flag off the route answers 404
 * and every reader here degrades to "nothing overridden".
 */
import { sessionOverrideUrl } from './api'
import { getAccessToken } from './authClient'

export { WEEK_ONLY_LABEL } from '../engine/sessionOverride'
export type { OverrideMark, SessionOverrideView } from '../engine/sessionOverride'

export interface WeekOverride {
  id: string
  date: string
  routine_id: string
  session: string
  expires_on: string
  active: boolean
  moved_out_to: string | null
  moved_in_from: string | null
  rationale: string | null
}

/** Active overrides dated inside [from, to], oldest first. Empty on any failure. */
export async function fetchWeekOverrides(from: string, to: string): Promise<WeekOverride[]> {
  const url = sessionOverrideUrl()
  if (!url) return []
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ action: 'list', from, to }),
    })
    if (!res.ok) return []
    const out = await res.json() as { overrides?: WeekOverride[] | null }
    return Array.isArray(out?.overrides) ? out.overrides.filter((o) => o.active) : []
  } catch {
    return []
  }
}

/** Overrides by routine. A session can carry more than one dated override in a week. */
export function overridesByRoutine(list: WeekOverride[] | null | undefined): Record<string, WeekOverride[]> {
  const out: Record<string, WeekOverride[]> = {}
  for (const o of list ?? []) (out[o.routine_id] ??= []).push(o)
  return out
}

/**
 * The date to show a session's override for: today's if it has one, else the
 * next one coming, else the latest one this week.
 */
export function overrideDateFor(rows: WeekOverride[] | undefined, today: string): string | null {
  if (!rows?.length) return null
  const dates = [...new Set(rows.map((r) => r.date))].sort()
  return dates.find((d) => d >= today) ?? dates[dates.length - 1]
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function weekdayOf(date: string): string {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]
}
