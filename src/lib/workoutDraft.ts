// Workout-session persistence — the staging layer behind start / stop / continue.
//
// OFFLINE-FIRST: every read resolves from localStorage alone, so a session can be
// discovered, resumed, and kept going with no network at all. The Supabase mirror
// is a pure enhancement layered on top (cross-device, survives a cleared browser):
//   • localStorage  — instant, synchronous, the source of truth offline.
//   • workout_draft — a debounced server mirror; consulted when online and merged
//     by recency, never required.
//
// On "Complete workout" the draft is promoted to a real `workout` row and both
// tiers are cleared. A draft is recoverable only within its own week (started_at
// >= this Monday); stale ones are filtered out and swept from both tiers, matching
// the Mon–Sun cadence the rest of the loop runs on.

import { supabase } from './supabaseClient'
import type { SetLog, ExerciseFeedback, WorkoutDraftRow } from '../types/database'
import { weekWindowInZone, upcomingWeekWindow, isoInWeek } from '../engine/weekDates'

export interface DraftPayload {
  setLogs: Record<number, SetLog[]>
  feedback: Record<number, ExerciseFeedback>
  elapsedSeconds: number
  startedAt: string   // ISO — the real session start (for the week-window check)
}

// What we actually persist locally: the payload plus the routine it belongs to
// and when it was last saved, so the whole draft set can be scanned and ranked
// without the server.
interface StoredDraft extends DraftPayload {
  routineId: string
  savedAt: string     // ISO of the most recent local save
}

// Start of the current training week (Monday 00:00, local). Mirrors the Monday
// math in useAppState / TodayScreen so the draft window lines up with the strip.
export function weekStart(now = new Date()): Date {
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return monday
}

function withinThisWeek(startedAt: string, now = new Date()): boolean {
  const cur = weekWindowInZone(now)
  const next = upcomingWeekWindow(now)
  return isoInWeek(startedAt, cur.weekStart, cur.weekEnd)
    || isoInWeek(startedAt, next.weekStart, next.weekEnd)
}

function setsLoggedIn(setLogs: Record<string, SetLog[]> | null | undefined): number {
  return Object.values(setLogs ?? {}).flat().filter((s) => s.done).length
}

// ---- local tier (source of truth offline) ---------------------------------

const LOCAL_PREFIX = 'zeroed:workout-draft:'
const localKey = (routineId: string) => `${LOCAL_PREFIX}${routineId}`

export function saveDraftLocal(routineId: string, payload: DraftPayload): void {
  try {
    const stored: StoredDraft = { ...payload, routineId, savedAt: new Date().toISOString() }
    localStorage.setItem(localKey(routineId), JSON.stringify(stored))
  } catch { /* quota / private mode — non-fatal, remote tier still covers it */ }
}

function readStored(routineId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(localKey(routineId))
    if (!raw) return null
    const s = JSON.parse(raw) as StoredDraft
    if (!s.startedAt || !withinThisWeek(s.startedAt)) {
      localStorage.removeItem(localKey(routineId))
      return null
    }
    return s
  } catch {
    return null
  }
}

export function loadDraftLocal(routineId: string): DraftPayload | null {
  return readStored(routineId)
}

export function clearDraftLocal(routineId: string): void {
  try { localStorage.removeItem(localKey(routineId)) } catch { /* non-fatal */ }
}

// Drop every local draft — used on sign-out so a new account on this device never
// inherits the previous athlete's in-progress sessions.
export function clearAllDraftsLocal(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(LOCAL_PREFIX)) doomed.push(k)
    }
    doomed.forEach((k) => localStorage.removeItem(k))
  } catch { /* non-fatal */ }
}

// The freshest live local draft, sweeping any from a past week as it scans. Fully
// synchronous — this is what keeps the resume entry alive offline.
function loadActiveDraftLocal(): ActiveDraft | null {
  let best: StoredDraft | null = null
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(LOCAL_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      const routineId = k.slice(LOCAL_PREFIX.length)
      const s = readStored(routineId)   // removes it if stale
      if (!s) continue
      if (!best || s.savedAt > best.savedAt) best = s
    }
  } catch {
    return null
  }
  if (!best) return null
  return {
    routineId:      best.routineId,
    setsLogged:     setsLoggedIn(best.setLogs as Record<string, SetLog[]>),
    elapsedSeconds: best.elapsedSeconds,
    updatedAt:      best.savedAt,
  }
}

// ---- remote tier (enhancement when online) --------------------------------

export async function saveDraftRemote(
  athleteId: string,
  routineId: string,
  payload: DraftPayload,
): Promise<void> {
  await supabase
    .from('workout_draft')
    .upsert(
      {
        athlete_id:      athleteId,
        routine_id:      routineId,
        set_logs:        payload.setLogs,
        feedback:        payload.feedback,
        elapsed_seconds: payload.elapsedSeconds,
        started_at:      payload.startedAt,
        updated_at:      new Date().toISOString(),
      },
      { onConflict: 'athlete_id,routine_id' },
    )
}

export async function loadDraftRemote(
  athleteId: string,
  routineId: string,
): Promise<DraftPayload | null> {
  const { data } = await supabase
    .from('workout_draft')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('routine_id', routineId)
    .maybeSingle()
  const row = data as WorkoutDraftRow | null
  if (!row || !withinThisWeek(row.started_at)) return null
  return {
    setLogs:        (row.set_logs ?? {}) as Record<number, SetLog[]>,
    feedback:       (row.feedback ?? {}) as Record<number, ExerciseFeedback>,
    elapsedSeconds: row.elapsed_seconds ?? 0,
    startedAt:      row.started_at,
  }
}

export async function clearDraftRemote(athleteId: string, routineId: string): Promise<void> {
  await supabase
    .from('workout_draft')
    .delete()
    .eq('athlete_id', athleteId)
    .eq('routine_id', routineId)
}

async function loadActiveDraftRemote(athleteId: string): Promise<ActiveDraft | null> {
  const { data } = await supabase
    .from('workout_draft')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('updated_at', { ascending: false })
  const rows = (data ?? []) as WorkoutDraftRow[]
  if (rows.length === 0) return null

  const monday = weekStart()
  const stale = rows.filter((r) => new Date(r.started_at).getTime() < monday.getTime())
  if (stale.length) {
    void supabase.from('workout_draft').delete().in('id', stale.map((r) => r.id)).then(
      () => {}, () => {},
    )
  }

  const live = rows.find((r) => new Date(r.started_at).getTime() >= monday.getTime())
  if (!live) return null

  return {
    routineId:      live.routine_id,
    setsLogged:     setsLoggedIn(live.set_logs as Record<string, SetLog[]>),
    elapsedSeconds: live.elapsed_seconds ?? 0,
    updatedAt:      live.updated_at,
  }
}

// ---- combined reads (offline-first, remote-enhanced) ----------------------

// Restore a routine's session: local is authoritative offline; when the server
// is reachable, whichever tier was saved more recently wins.
export async function restoreDraft(
  athleteId: string,
  routineId: string,
): Promise<DraftPayload | null> {
  const local = loadDraftLocal(routineId)
  let remote: DraftPayload | null = null
  try { remote = await loadDraftRemote(athleteId, routineId) } catch { /* offline — local covers it */ }
  if (local && remote) return local.elapsedSeconds >= remote.elapsedSeconds ? local : remote
  return local ?? remote
}

export function clearDraft(athleteId: string, routineId: string): void {
  clearDraftLocal(routineId)
  void clearDraftRemote(athleteId, routineId).catch(() => { /* non-fatal */ })
}

// ---- resume entry (TodayScreen) -------------------------------------------

export interface ActiveDraft {
  routineId: string
  setsLogged: number
  elapsedSeconds: number
  updatedAt: string   // ISO — last save (local savedAt or remote updated_at)
}

// The most recently touched live draft for this athlete. Resolves from
// localStorage first so the resume entry always appears offline; the remote tier
// is merged in by recency when reachable (cross-device).
export async function loadActiveDraft(athleteId: string): Promise<ActiveDraft | null> {
  const local = loadActiveDraftLocal()
  let remote: ActiveDraft | null = null
  try { remote = await loadActiveDraftRemote(athleteId) } catch { /* offline — local covers it */ }
  if (local && remote) {
    return new Date(local.updatedAt).getTime() >= new Date(remote.updatedAt).getTime() ? local : remote
  }
  return local ?? remote
}

// Every routine with a live (this-week) draft, for the week view's "In progress"
// markers. Offline-first: the local scan alone is enough; the remote set is
// merged in when reachable (cross-device drafts).
export async function loadDraftStarts(athleteId: string): Promise<Record<string, string>> {
  const starts: Record<string, string> = {}
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(LOCAL_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      const routineId = k.slice(LOCAL_PREFIX.length)
      const s = readStored(routineId)
      if (s?.startedAt) starts[routineId] = s.startedAt
    }
  } catch { /* non-fatal */ }

  try {
    const { data } = await supabase
      .from('workout_draft')
      .select('routine_id, started_at')
      .eq('athlete_id', athleteId)
    for (const r of (data ?? []) as { routine_id: string; started_at: string }[]) {
      if (r.started_at) starts[r.routine_id] = starts[r.routine_id] ?? r.started_at
    }
  } catch { /* offline — local set covers it */ }

  return starts
}

export async function loadDraftRoutineIds(athleteId: string): Promise<string[]> {
  return Object.keys(await loadDraftStarts(athleteId))
}
