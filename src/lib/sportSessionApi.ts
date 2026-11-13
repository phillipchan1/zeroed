/* Sport / conditioning logs, the app's side (log_session_v1, spec section 13).
 *
 * A new log is queued in the workout outbox first (engine/sportLog.ts builds
 * it, the sheet enqueues it) and committed here, by the outbox, against the
 * Worker's /api/sport-session: the Worker decides whether it closes the
 * planned card it came from, writes its pain reports through the check-in's
 * U7 path, and logs the change. A committed log is edited or deleted here,
 * online. With the flag off the route answers 404 and nothing here is called.
 */
import { sportSessionUrl } from './api'
import { getAccessToken } from './authClient'
import { type SportPain } from '../engine/sportLog'
import { sportLogBody } from '../engine/sportLogPending'
import type { PendingSession } from '../engine'

/** A committed log as the Worker returns it. */
export interface SportLogView {
  workout_id: string
  client_key: string | null
  activity: string
  date: string
  duration_min: number
  session_rpe: number | null
  session_load: number | null
  pain: SportPain[]
  notes: string | null
  /** The planned card it closed, or null for a log on the external program. */
  planned: { session_id: string; session: string } | null
}

/** A failure the outbox can classify: a code is a rejection, none is "couldn't reach it". */
export class SportSessionError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

async function send(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const url = sportSessionUrl()
  if (!url) throw new SportSessionError('Sport logging needs the Worker API.', 'SPORT_RETRY')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  // A fetch that never lands throws a plain error (no code): the outbox keeps the row and stops the pass.
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

type Answer = { ok?: boolean; text?: string; retry?: boolean; log?: SportLogView }

async function call(body: Record<string, unknown>): Promise<Answer> {
  const res = await send(body)
  const out = (res.body ?? {}) as Answer
  // Off for this athlete, or a server hiccup: try again later, a few times.
  if (res.status === 404 || res.status >= 500) throw new SportSessionError(`sport session ${res.status}`, 'SPORT_RETRY')
  if (res.status < 200 || res.status >= 300) throw new SportSessionError(`sport session ${res.status}`, 'SPORT_REFUSED')
  if (out.ok !== true) throw new SportSessionError(out.text ?? 'Refused.', out.retry ? 'SPORT_RETRY' : 'SPORT_REFUSED')
  return out
}

/** Commit one queued log (idempotent on its outbox id). Returns the workout id. */
export async function commitSportLog(p: PendingSession): Promise<string> {
  const body = sportLogBody(p)
  if (!body) throw new SportSessionError('not a sport log', 'SPORT_REFUSED')
  const out = await call(body)
  if (!out.log?.workout_id) throw new SportSessionError('no workout id', 'SPORT_RETRY')
  return out.log.workout_id
}

/** Committed logs dated [from, to]. Empty on any failure (History still shows the workout rows). */
export async function listSportLogs(from: string, to: string): Promise<SportLogView[]> {
  if (!sportSessionUrl()) return []
  try {
    const res = await send({ action: 'list', from, to })
    if (res.status !== 200) return []
    return ((res.body as { logs?: SportLogView[] } | null)?.logs) ?? []
  } catch {
    return []
  }
}

/** Change a committed log. Resolves with the Worker's answer text; throws with it when refused. */
export async function updateSportLog(workoutId: string, patch: Record<string, unknown>): Promise<string> {
  return (await call({ action: 'update', workout_id: workoutId, ...patch })).text ?? 'Updated.'
}

/** Delete a committed log (it is voided, never erased). */
export async function deleteSportLog(workoutId: string): Promise<string> {
  return (await call({ action: 'delete', workout_id: workoutId })).text ?? 'Deleted.'
}
