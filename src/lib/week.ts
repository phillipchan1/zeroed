import type { RoutineRow } from '../types/database'

// =============================================================================
// The weekly loop — a repeating template, no guilt.
//
// A "week" is the active phase's routines (the program's sessions). A session is
// DONE when a workout exists for that routine this calendar week. There's always
// a clear "next" (first not-done). When the calendar week turns over, done-state
// resets — the template comes around again. Missing a session is just the
// absence of a log: no streak, no penalty (Design Language: "the system observes;
// it does not punish skips"). Adherence becomes input for the weekly review,
// never a guilt surface.
//
// Derived entirely from data we already store (workout.performed_at +
// routine_id) — no schema, no per-session "status" column.
// =============================================================================

export interface WeekSession {
  routine: RoutineRow
  done: boolean
  isNext: boolean
}

export interface WeekState {
  sessions: WeekSession[]
  doneCount: number
  total: number
  complete: boolean
  next: RoutineRow | null   // first not-done session, or null when the week is done
}

// Monday 00:00 (local) of the week containing `now`.
export function getWeekStart(now: Date = new Date()): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const dow = d.getDay()                 // 0 = Sun
  d.setDate(d.getDate() - ((dow + 6) % 7)) // rewind to Monday
  return d
}

/**
 * Build this week's state from the program's routines and the workouts logged
 * this week. `workoutsThisWeek` only needs each row's routine_id.
 */
export function computeWeekState(
  routines: RoutineRow[],
  workoutsThisWeek: Array<{ routine_id: string }>,
): WeekState {
  const doneIds = new Set(workoutsThisWeek.map((w) => w.routine_id))
  const nextIdx = routines.findIndex((r) => !doneIds.has(r.id))

  const sessions: WeekSession[] = routines.map((r, i) => ({
    routine: r,
    done: doneIds.has(r.id),
    isNext: i === nextIdx,
  }))

  const doneCount = sessions.filter((s) => s.done).length
  const total = sessions.length
  return {
    sessions,
    doneCount,
    total,
    complete: total > 0 && doneCount >= total,
    next: nextIdx >= 0 ? routines[nextIdx] : null,
  }
}
