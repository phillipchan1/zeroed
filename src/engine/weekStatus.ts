// =============================================================================
// WEEK STATUS — completion, drafts, and adherence for ONE week instance.
//
// A session id is reused across weeks (apply_program_edits writes in place).
// Done / in-progress / the header count / adherence may only look at logs whose
// performed date falls in the week being shown. Last week's Tuesday must not
// mark this week's renamed session DONE, and must not pad adherence to 100%.
// =============================================================================

import { addDaysISO, isoDateInZone, isoInWeek, ATHLETE_TIME_ZONE } from './weekDates.ts'

export interface WeekWorkoutLike {
  routineId: string
  performedAt: string
}

export type WeekSessionKind = 'todo' | 'in_progress' | 'done'

export interface WeekSessionState {
  kind: WeekSessionKind
  lastPerformedAt: string | null
  count: number
}

export function workoutsInWeek(
  workouts: WeekWorkoutLike[],
  weekStart: string,
  weekEnd: string,
  timeZone = ATHLETE_TIME_ZONE,
): WeekWorkoutLike[] {
  return workouts.filter((w) => isoInWeek(w.performedAt, weekStart, weekEnd, timeZone))
}

/** Distinct calendar days with a log inside the week — the Train header count. */
export function weekLoggedDays(
  workouts: WeekWorkoutLike[],
  weekStart: string,
  weekEnd: string,
  timeZone = ATHLETE_TIME_ZONE,
): number {
  const days = new Set<string>()
  for (const w of workoutsInWeek(workouts, weekStart, weekEnd, timeZone)) {
    days.add(isoDateInZone(new Date(w.performedAt), timeZone))
  }
  return days.size
}

/**
 * Adherence for a week instance: distinct in-week days / planned, never above 1.
 * Duplicate rows and logs from any other week do not count.
 */
export function weekAdherence(
  planned: number,
  workouts: WeekWorkoutLike[],
  weekStart: string,
  weekEnd: string,
  timeZone = ATHLETE_TIME_ZONE,
): { done: number; adherence: number } {
  const done = weekLoggedDays(workouts, weekStart, weekEnd, timeZone)
  const adherence = planned > 0 ? Math.min(1, done / planned) : 0
  return { done, adherence }
}

export function sessionStateForWeek(opts: {
  routineId: string
  weekStart: string
  weekEnd: string
  workouts: WeekWorkoutLike[]
  draftStartedAt?: string | null
  timeZone?: string
}): WeekSessionState {
  const tz = opts.timeZone ?? ATHLETE_TIME_ZONE
  const logs = workoutsInWeek(opts.workouts, opts.weekStart, opts.weekEnd, tz)
    .filter((w) => w.routineId === opts.routineId)
    .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
  if (logs.length) {
    return { kind: 'done', lastPerformedAt: logs[0].performedAt, count: logs.length }
  }
  if (opts.draftStartedAt && isoInWeek(opts.draftStartedAt, opts.weekStart, opts.weekEnd, tz)) {
    return { kind: 'in_progress', lastPerformedAt: null, count: 0 }
  }
  return { kind: 'todo', lastPerformedAt: null, count: 0 }
}

/** Retest the current block is aiming at: the Monday after it ends, unless the program date is still on this block. */
export function activeBlockRetestDate(opts: {
  programRetest?: string | null
  phaseStart?: string | null
  phaseEnd?: string | null
}): string | null {
  const start = opts.phaseStart?.slice(0, 10) ?? null
  const end = opts.phaseEnd?.slice(0, 10) ?? null
  const prog = opts.programRetest?.slice(0, 10) ?? null
  if (start && prog && prog >= start) return prog
  if (end) return addDaysISO(end, 1)
  return prog
}
