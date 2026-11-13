// =============================================================================
// A sport log's outbox row (log_session_v1). Durable on the device before any
// network call, like a finished session: the sheet enqueues it, the outbox
// commits it through the Worker (lib/sportSessionApi.ts) with its pain and
// session RPE riding along. Client side only; the rules are in sportLog.ts.
//
// Pure, no I/O (see sportLog.check.ts).
// =============================================================================

import type { PendingSession } from './index.ts'
import { performedAtForDate, sportSnapshot, type SportLogFields } from './sportLog.ts'

export interface SportLogInput {
  id: string
  athleteId: string
  athleteName: string | null
  fields: SportLogFields & { session_rpe: number }
  plannedRoutineId: string | null
  today: string
  queuedAt: string
  now?: Date
}

/**
 * The queued session for one log. Off-plan (no card) it carries `outsidePlan`
 * and no routine, like arc_load_v1's logs, so nothing folds it into a planned
 * slot. From a card it carries that card's routine, so the week ring counts it
 * while it waits; the Worker files a second same-day log as external anyway.
 */
export function buildSportLogPending(input: SportLogInput): PendingSession {
  const f = input.fields
  const snap = sportSnapshot(f.activity, f.duration_min)
  return {
    id: input.id,
    athleteId: input.athleteId,
    routineId: input.plannedRoutineId ?? '',
    actualWeights: snap.weights,
    actualReps: snap.reps,
    rpe: null,
    durationMins: f.duration_min,
    setsDone: 0,
    athleteName: input.athleteName,
    onboardingTransition: null,
    debrief: null,
    editWorkoutId: null,
    performedAt: performedAtForDate(f.date, input.today, input.now),
    queuedAt: input.queuedAt,
    exercisesSnapshot: snap.exercises,
    sessionRpe: f.session_rpe,
    outsidePlan: input.plannedRoutineId ? null : { activity: f.activity, minutes: f.duration_min, exposure: {} },
    sportLog: {
      activity: f.activity,
      date: f.date,
      minutes: f.duration_min,
      sessionRpe: f.session_rpe,
      pain: f.pain,
      notes: f.notes,
      plannedRoutineId: input.plannedRoutineId,
    },
  }
}

/** The body the Worker's /api/sport-session takes for a queued log. */
export function sportLogBody(p: PendingSession): Record<string, unknown> | null {
  const s = p.sportLog
  if (!s) return null
  return {
    action: 'log',
    client_key: p.id,
    logged_at: p.queuedAt,
    activity: s.activity,
    date: s.date,
    duration_min: s.minutes,
    session_rpe: s.sessionRpe,
    pain: s.pain,
    notes: s.notes,
    ...(s.plannedRoutineId ? { session_id: s.plannedRoutineId } : {}),
  }
}
