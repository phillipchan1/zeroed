/* Session RPE, the app's side (tracks_v1, G9).
 *
 * One CR-10 tap (0–10) for the whole session at the finish. The Worker stores
 * it in session_rpe, apart from the set RPEs (workout.rpe is their mean, and
 * stays that), logs it, and lets the athlete change it the same day (or last
 * night's until 04:00). This only sends and reads. A tap goes through the
 * queue (sessionRpeQueue.ts) so one that can't be sent waits on the device and
 * syncs later. With the flag off the route answers 404, no tap is queued and
 * nothing here is called.
 */
import { useEffect, useState } from 'react'
import { sessionRpeUrl } from './api'
import { getAccessToken } from './authClient'
import { enqueueTap, flushTapQueue, queuedTaps, subscribeTapQueue, tapOutcome, type QueuedTap, type TapOutcome } from './sessionRpeQueue'
import { isKnownOffline, subscribeOnline } from './useOnline'

export interface SessionRpeRating {
  date: string
  session_id: string
  rating: number
  duration_min: number | null
}

async function send(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
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
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const res = await send(body)
  if (res.status < 200 || res.status >= 300) throw new Error(`session rpe ${res.status}`)
  return res.body
}

/** Send one queued tap. A fetch that never got an answer is "later". */
async function sendTap(tap: QueuedTap): Promise<TapOutcome> {
  if (!sessionRpeUrl()) return { kind: 'later' }
  try {
    const res = await send({
      action: 'log',
      client_id: tap.client_id,
      tapped_at: tap.tapped_at,
      session_id: tap.session_id,
      date: tap.date,
      rating: tap.rating,
      duration_min: tap.duration_min,
      ...(tap.workout_id ? { workout_id: tap.workout_id } : {}),
    })
    return tapOutcome(res.status, res.body)
  } catch {
    return tapOutcome(null, null)
  }
}

/** Send whatever taps are waiting. Safe to call any time; a no-op on an empty queue. */
export function syncSessionRpe(): Promise<void> {
  if (!queuedTaps().length) return Promise.resolve()
  return flushTapQueue(sendTap)
}

/**
 * Log (or change) the session's rating: queued on the device first, then sent.
 * One that can't be sent now waits and syncs on reconnect or resume.
 */
export function logSessionRpe(input: { session_id: string; rating: number; duration_min: number | null; date: string; workout_id?: string | null }): Promise<void> {
  enqueueTap(input)
  return syncSessionRpe()
}

/** Sync queued taps on mount, on reconnect and on resume. Mount once near the app root. */
export function useSessionRpeSync(): void {
  useEffect(() => {
    const flush = () => { void syncSessionRpe() }
    flush()
    const onVisible = () => { if (document.visibilityState === 'visible') flush() }
    window.addEventListener('online', flush)
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = subscribeOnline(() => { if (!isKnownOffline()) flush() })
    return () => {
      window.removeEventListener('online', flush)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [])
}

/** How many taps are waiting to sync, live. */
export function useQueuedSessionRpe(): number {
  const [n, setN] = useState(() => queuedTaps().length)
  useEffect(() => {
    setN(queuedTaps().length)
    return subscribeTapQueue(() => setN(queuedTaps().length))
  }, [])
  return n
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
