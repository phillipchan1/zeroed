// Workout-session persistence — the staging layer behind start / stop / continue.
//
// Two tiers, by design (see migration 20260604000001_workout_draft.sql):
//   • localStorage  — instant, synchronous, survives a route change (e.g. ducking
//     into the Coach chat and back), a reload, or the PWA being backgrounded.
//   • workout_draft — a debounced Supabase mirror, so the session also survives
//     switching devices or clearing the browser.
//
// On "Complete workout" the draft is promoted to a real `workout` row and both
// tiers are cleared. A draft is recoverable only within its own week (started_at
// >= this Monday); stale ones are filtered out and opportunistically deleted,
// matching the Mon–Sun cadence the rest of the loop runs on.

import { supabase } from './supabaseClient'
import type { SetLog, ExerciseFeedback, WorkoutDraftRow } from '../types/database'

export interface DraftPayload {
  setLogs: Record<number, SetLog[]>
  feedback: Record<number, ExerciseFeedback>
  elapsedSeconds: number
  startedAt: string   // ISO — the real session start (for the week-window check)
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
  return new Date(startedAt).getTime() >= weekStart(now).getTime()
}

// ---- local tier -----------------------------------------------------------

const localKey = (routineId: string) => `zeroed:workout-draft:${routineId}`

export function saveDraftLocal(routineId: string, payload: DraftPayload): void {
  try {
    localStorage.setItem(localKey(routineId), JSON.stringify(payload))
  } catch { /* quota / private mode — non-fatal, remote tier still covers it */ }
}

export function loadDraftLocal(routineId: string): DraftPayload | null {
  try {
    const raw = localStorage.getItem(localKey(routineId))
    if (!raw) return null
    const p = JSON.parse(raw) as DraftPayload
    if (!p.startedAt || !withinThisWeek(p.startedAt)) {
      localStorage.removeItem(localKey(routineId))
      return null
    }
    return p
  } catch {
    return null
  }
}

export function clearDraftLocal(routineId: string): void {
  try { localStorage.removeItem(localKey(routineId)) } catch { /* non-fatal */ }
}

// ---- remote tier ----------------------------------------------------------

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

// Restore both tiers for a routine, preferring whichever was saved more recently.
// Local wins ties (it's always at least as fresh as the debounced remote).
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
  updatedAt: string
}

// The most recently touched live draft for this athlete, used to surface a
// "Resume session" entry. Opportunistically deletes drafts from a past week.
export async function loadActiveDraft(athleteId: string): Promise<ActiveDraft | null> {
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

  const setLogs = (live.set_logs ?? {}) as Record<string, SetLog[]>
  const setsLogged = Object.values(setLogs).flat().filter((s) => s.done).length

  return {
    routineId:      live.routine_id,
    setsLogged,
    elapsedSeconds: live.elapsed_seconds ?? 0,
    updatedAt:      live.updated_at,
  }
}
