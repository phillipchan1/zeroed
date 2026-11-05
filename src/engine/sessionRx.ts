/**
 * Client fetch for the Worker session prescription. The phone never computes
 * TM / lift-model math for display — it renders this payload, or the last
 * cached copy when offline.
 */
import { sessionRxUrl } from '../lib/api.ts'
import { getAccessToken } from '../lib/authClient.ts'
import type { UnitContext } from '../lib/units.ts'
import type { ExerciseTemplate } from '../types/database.ts'
import type { DayOf } from './liftModel.ts'
import type { SessionPrescription } from './sessionRxCompute.ts'

export type { SessionPrescription, ExerciseRx, IntelligenceRule, ClearanceView } from './sessionRxCompute.ts'
export { displayedSessionLoad, computeSessionPrescription } from './sessionRxCompute.ts'

export interface SessionRxRequest {
  routine_id?: string
  routine_ids?: string[]
  exercises?: ExerciseTemplate[]
  exercises_by_id?: Record<string, ExerciseTemplate[]>
  day_of?: DayOf | null
  unit?: 'lb' | 'kg'
  storage_unit?: 'lb' | 'kg'
  version_only?: boolean
  /** tracks_v1: the session's date, so that day's week-only override applies. */
  date?: string
}

export interface SessionRxPayload {
  prescription: SessionPrescription
  version: string
  program_version: string
}

export interface SessionRxBatchPayload {
  prescriptions: Record<string, SessionPrescription>
  versions: Record<string, string>
  program_version: string
}

async function postSessionRx(body: SessionRxRequest): Promise<unknown> {
  const url = sessionRxUrl()
  if (!url) throw new Error('session-rx unavailable')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    throw new Error(`session-rx ${res.status}`)
  }
  if (!res.ok) {
    const err = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error ?? res.status)
      : `session-rx ${res.status}`
    throw new Error(err)
  }
  return parsed
}

export async function fetchSessionPrescription(
  _athleteId: string,
  routineId: string,
  exercises: ExerciseTemplate[],
  u: UnitContext,
  opts: { dayOf?: DayOf | null; date?: string | null } = {},
): Promise<SessionPrescription> {
  const parsed = await postSessionRx({
    routine_id: routineId,
    exercises,
    day_of: opts.dayOf ?? null,
    unit: u.unit,
    storage_unit: u.storage,
    // Sent only when asked for, so every other caller's request is unchanged.
    ...(opts.date ? { date: opts.date } : {}),
  }) as SessionRxPayload
  const rx = parsed.prescription
  if (!rx || typeof rx !== 'object') throw new Error('session-rx missing prescription')
  return { ...rx, version: parsed.version ?? rx.version }
}

export async function fetchSessionPrescriptions(
  _athleteId: string,
  routines: Array<{ id: string; exercises: ExerciseTemplate[] }>,
  u: UnitContext,
  opts: { dayOf?: DayOf | null } = {},
): Promise<Record<string, SessionPrescription>> {
  if (!routines.length) return {}
  const parsed = await postSessionRx({
    routine_ids: routines.map((r) => r.id),
    exercises_by_id: Object.fromEntries(routines.map((r) => [r.id, r.exercises])),
    day_of: opts.dayOf ?? null,
    unit: u.unit,
    storage_unit: u.storage,
  }) as SessionRxBatchPayload
  const out: Record<string, SessionPrescription> = {}
  for (const r of routines) {
    const rx = parsed.prescriptions?.[r.id]
    if (rx) out[r.id] = { ...rx, version: parsed.versions?.[r.id] ?? rx.version }
  }
  return out
}

export async function fetchProgramRxVersion(u: UnitContext): Promise<string | null> {
  try {
    const parsed = await postSessionRx({
      version_only: true,
      unit: u.unit,
      storage_unit: u.storage,
    }) as { program_version?: string }
    return parsed.program_version ?? null
  } catch {
    return null
  }
}
