import type { ExerciseTemplate } from '../../supabase/functions/_shared/engine/types.ts'
import { readLoggedExercises, type LoggedWorkoutLike } from '../../supabase/functions/_shared/engine/loggedSets.ts'
import { formatSet, isoDay, shortDate, topWorkingSet } from '../../supabase/functions/_shared/zeroedFormat.ts'
import {
  addDays, e1rmFromSet, liftNameMatcher, localDay, mondayOf, parseLiftId,
  type LiftModelSources, type MainLiftId, type ModelWorkout, type TmOverride,
} from '../../supabase/functions/_shared/engine/liftModel.ts'
import { asJson, type Sql } from './db.ts'

export interface ConnectedStore {
  sql: Sql
  athleteId: string
  unit: string
}

export interface AthleteRow {
  id: string
  auth_user_id: string
  name: string | null
  sport: string | null
  goals: string | null
  obstacle: string | null
  training_age: number | null
  sessions_per_week: number | null
  training_preferences: string | null
  arena_type: string | null
  arena_raw: string | null
  limiter_choice: string | null
}

export interface LiveProgram {
  programId: string
  goal: string | null
  phaseId: string
  phaseName: string
  weekStart: string
  weekEnd: string
  nonNegotiables: string[]
  advancementCriteria: string[]
  sessionsPerWeek: number
  standingPreferences: string | null
  sessions: Array<{
    routineId: string
    name: string
    intent: string
    sessionType: string
    intendedDow: number | null
    exercises: ExerciseTemplate[]
  }>
  scheduledPhase: { id: string; name: string; weekStart: string } | null
  scheduledSessions: Array<{
    routineId: string
    name: string
    intent: string
    sessionType: string
    intendedDow: number | null
    exercises: ExerciseTemplate[]
  }>
}

export interface WorkoutRowView extends LoggedWorkoutLike {
  id: string
  routine_id: string
  performed_at: string
  rpe: number | null
  duration_mins: number | null
  routine: { id: string; name: string; exercises: ExerciseTemplate[]; program_id: string }
}

export interface InsightView {
  id: string
  priority: string
  category: string
  claim: string
  confidence: number
  status: string
  program_impact: string | null
}

export function makeStore(sql: Sql, athleteId: string, unit = 'lb'): ConnectedStore {
  return { sql, athleteId, unit: unit === 'kg' ? 'kg' : 'lb' }
}

export async function programIds(store: ConnectedStore): Promise<string[]> {
  const rows = await store.sql<{ id: string }[]>`
    SELECT id FROM program WHERE athlete_id = ${store.athleteId}
  `
  return rows.map((p) => p.id)
}

export async function workoutProgramOwned(
  store: ConnectedStore,
  programId: string,
): Promise<boolean> {
  return (await programIds(store)).includes(programId)
}

export async function loadAthlete(
  store: ConnectedStore,
): Promise<AthleteRow & { current_phase: string | null; retest_date: string | null }> {
  const [athlete] = await store.sql<AthleteRow[]>`
    SELECT id, auth_user_id, name, sport, goals, obstacle, training_age,
           sessions_per_week, training_preferences, arena_type, arena_raw, limiter_choice
    FROM athlete
    WHERE id = ${store.athleteId}
    LIMIT 1
  `
  if (!athlete) throw new Error('Athlete row missing')
  const [profile] = await store.sql<{ current_phase: string | null; retest_date: string | null }[]>`
    SELECT current_phase, retest_date::text FROM athlete_profile
    WHERE athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return {
    ...athlete,
    current_phase: profile?.current_phase ?? null,
    retest_date: profile?.retest_date ?? null,
  }
}

export async function loadLiveProgram(store: ConnectedStore): Promise<LiveProgram | null> {
  const [prog] = await store.sql<{ id: string; goal: string | null }[]>`
    SELECT id, goal FROM program
    WHERE athlete_id = ${store.athleteId} AND status = 'active'
    LIMIT 1
  `
  if (!prog?.id) return null

  const [phaseRow] = await store.sql<{
    id: string
    name: string
    week_start: string
    week_end: string
    non_negotiables: unknown
    advancement_criteria: unknown
  }[]>`
    SELECT id, name, week_start::text, week_end::text, non_negotiables, advancement_criteria
    FROM phase
    WHERE program_id = ${prog.id} AND status = 'active'
    LIMIT 1
  `
  if (!phaseRow) return null

  let routineRows = await store.sql<{
    id: string
    name: string
    intent: string | null
    session_type: string | null
    intended_dow: number | null
    exercises: unknown
  }[]>`
    SELECT id, name, intent, session_type, intended_dow, exercises
    FROM routine
    WHERE program_id = ${prog.id} AND phase_id = ${phaseRow.id}
    ORDER BY name
  `
  if (routineRows.length === 0) {
    routineRows = await store.sql<{
      id: string
      name: string
      intent: string | null
      session_type: string | null
      intended_dow: number | null
      exercises: unknown
    }[]>`
      SELECT id, name, intent, session_type, intended_dow, exercises
      FROM routine
      WHERE program_id = ${prog.id}
      ORDER BY name
    `
  }

  const [queued] = await store.sql<{ id: string; name: string; week_start: string }[]>`
    SELECT id, name, week_start::text
    FROM phase
    WHERE program_id = ${prog.id} AND status = 'pending'
    ORDER BY week_start
    LIMIT 1
  `
  const [athlete] = await store.sql<{ sessions_per_week: number | null; training_preferences: string | null }[]>`
    SELECT sessions_per_week, training_preferences FROM athlete WHERE id = ${store.athleteId} LIMIT 1
  `

  const mapSession = (r: {
    id: string
    name: string
    intent: string | null
    session_type: string | null
    intended_dow: number | null
    exercises: unknown
  }) => ({
    routineId: r.id,
    name: r.name,
    intent: r.intent ?? '',
    sessionType: r.session_type ?? 'strength',
    intendedDow: r.intended_dow ?? null,
    exercises: asJson<ExerciseTemplate[]>(r.exercises, []),
  })

  const queuedRoutines = queued
    ? await store.sql<{
      id: string
      name: string
      intent: string | null
      session_type: string | null
      intended_dow: number | null
      exercises: unknown
    }[]>`
      SELECT id, name, intent, session_type, intended_dow, exercises
      FROM routine
      WHERE program_id = ${prog.id} AND phase_id = ${queued.id}
      ORDER BY intended_dow NULLS LAST, name
    `
    : []

  return {
    programId: prog.id,
    goal: prog.goal ?? null,
    phaseId: phaseRow.id,
    phaseName: phaseRow.name,
    weekStart: phaseRow.week_start,
    weekEnd: phaseRow.week_end,
    nonNegotiables: asJson<string[]>(phaseRow.non_negotiables, []),
    advancementCriteria: asJson<string[]>(phaseRow.advancement_criteria, []),
    sessionsPerWeek: Number(athlete?.sessions_per_week) || Math.max(1, routineRows.length),
    standingPreferences: athlete?.training_preferences ?? null,
    sessions: routineRows.map(mapSession),
    scheduledPhase: queued
      ? { id: queued.id, name: queued.name, weekStart: queued.week_start }
      : null,
    scheduledSessions: queuedRoutines.map(mapSession),
  }
}

export async function loadInsights(store: ConnectedStore, includeSettled = false): Promise<InsightView[]> {
  const rows = includeSettled
    ? await store.sql<InsightView[]>`
        SELECT id, priority, category, claim, confidence, status, program_impact
        FROM insight
        WHERE athlete_id = ${store.athleteId}
        ORDER BY priority
      `
    : await store.sql<InsightView[]>`
        SELECT id, priority, category, claim, confidence, status, program_impact
        FROM insight
        WHERE athlete_id = ${store.athleteId}
          AND status NOT IN ('resolved', 'disproved')
        ORDER BY priority
      `
  return rows
}

export async function loadWorkouts(
  store: ConnectedStore,
  opts: { limit?: number; since?: string; until?: string; exercise?: string } = {},
): Promise<WorkoutRowView[]> {
  const ids = await programIds(store)
  if (!ids.length) return []
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 120))
  const rows = await store.sql<{
    id: string
    routine_id: string
    performed_at: string
    rpe: number | null
    duration_mins: number | null
    actual_weights: unknown
    exercises_snapshot: unknown
    r_id: string
    r_name: string
    r_exercises: unknown
    r_program_id: string
  }[]>`
    SELECT w.id, w.routine_id, to_json(w.performed_at) #>> '{}' AS performed_at, w.rpe, w.duration_mins,
           w.actual_weights, w.exercises_snapshot,
           r.id AS r_id, r.name AS r_name, r.exercises AS r_exercises, r.program_id AS r_program_id
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId}
      AND (${opts.since ?? null}::timestamptz IS NULL OR w.performed_at >= ${opts.since ?? null}::timestamptz)
      AND (${opts.until ?? null}::timestamptz IS NULL OR w.performed_at <= ${opts.until ?? null}::timestamptz)
    ORDER BY w.performed_at DESC
    LIMIT ${limit}
  `
  let mapped: WorkoutRowView[] = rows.map((w) => ({
    id: w.id,
    routine_id: w.routine_id,
    performed_at: w.performed_at,
    rpe: w.rpe,
    duration_mins: w.duration_mins,
    actual_weights: asJson(w.actual_weights, null),
    exercises_snapshot: asJson(w.exercises_snapshot, null),
    routine: {
      id: w.r_id,
      name: w.r_name,
      exercises: asJson<ExerciseTemplate[]>(w.r_exercises, []),
      program_id: w.r_program_id,
    },
  }))
  if (opts.exercise) {
    const matches = liftNameMatcher(opts.exercise)
    mapped = mapped.filter((w) => readLoggedExercises(w).some((e) => matches(e.name)))
  }
  return mapped
}

export async function selectOwnedWorkout(store: ConnectedStore, workoutId: string): Promise<{
  id: string
  routine_id: string
  performed_at: string
  rpe: number | null
  duration_mins: number | null
  actual_weights: unknown
  exercises_snapshot: unknown
  r_id: string
  r_name: string
  r_exercises: unknown
  r_program_id: string
} | null> {
  const [row] = await store.sql<{
    id: string
    routine_id: string
    performed_at: string
    rpe: number | null
    duration_mins: number | null
    actual_weights: unknown
    exercises_snapshot: unknown
    r_id: string
    r_name: string
    r_exercises: unknown
    r_program_id: string
  }[]>`
    SELECT w.id, w.routine_id, to_json(w.performed_at) #>> '{}' AS performed_at, w.rpe, w.duration_mins,
           w.actual_weights, w.exercises_snapshot,
           r.id AS r_id, r.name AS r_name, r.exercises AS r_exercises, r.program_id AS r_program_id
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE w.id = ${workoutId}
      AND p.athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return row ?? null
}

export async function hydrateOwnedWorkout(
  store: ConnectedStore,
  row: Awaited<ReturnType<typeof selectOwnedWorkout>>,
  workoutId: string,
): Promise<{
  workout: WorkoutRowView
  observations: Array<{ category: string; signal: string; severity: number }>
} | null> {
  if (!row) return null
  if (!(await workoutProgramOwned(store, row.r_program_id))) return null
  const obs = await store.sql<{ category: string; signal: string; severity: number }[]>`
    SELECT category, signal, severity
    FROM session_observation
    WHERE workout_id = ${workoutId}
    ORDER BY logged_at
  `
  return {
    workout: {
      id: row.id,
      routine_id: row.routine_id,
      performed_at: row.performed_at,
      rpe: row.rpe,
      duration_mins: row.duration_mins,
      actual_weights: asJson(row.actual_weights, null),
      exercises_snapshot: asJson(row.exercises_snapshot, null),
      routine: {
        id: row.r_id,
        name: row.r_name,
        exercises: asJson<ExerciseTemplate[]>(row.r_exercises, []),
        program_id: row.r_program_id,
      },
    },
    observations: obs,
  }
}

export async function loadWorkout(store: ConnectedStore, workoutId: string): Promise<{
  workout: WorkoutRowView
  observations: Array<{ category: string; signal: string; severity: number }>
} | null> {
  return hydrateOwnedWorkout(store, await selectOwnedWorkout(store, workoutId), workoutId)
}

export async function loadLiftHistory(store: ConnectedStore, exerciseName: string): Promise<{
  name: string
  matches: string[]
  canonical: MainLiftId | null
  points: Array<{ date: string; top: string; e1rm: number | null; rpe: number | null }>
  bestWeight: number | null
  bestE1rm: number | null
}> {
  const rows = await loadWorkouts(store, { limit: 120 })
  const matches = liftNameMatcher(exerciseName)
  const names = new Set<string>()
  const points: Array<{ date: string; top: string; e1rm: number | null; rpe: number | null; weight: number | null }> = []
  for (const w of [...rows].reverse()) {
    for (const { name, sets } of readLoggedExercises(w)) {
      if (!matches(name)) continue
      names.add(name)
      const top = topWorkingSet(sets)
      if (!top) continue
      // Off the RPE chart, not Epley: the same 115×5 is a different max at @6
      // than at @9. A set with no RPE reads at 10 — the floor it proves.
      const e1rm = top.weight != null && top.reps != null ? e1rmFromSet(top.weight, top.reps, top.rpe ?? null) : null
      const cell = formatSet(top, store.unit)
      if (!cell) continue
      points.push({
        date: isoDay(w.performed_at),
        top: cell,
        e1rm: e1rm != null ? Math.round(e1rm) : null,
        rpe: top.rpe ?? w.rpe,
        weight: top.weight ?? null,
      })
    }
  }
  return {
    name: exerciseName,
    matches: [...names],
    canonical: parseLiftId(exerciseName),
    points: points.map(({ date, top, e1rm, rpe }) => ({ date, top, e1rm, rpe })),
    bestWeight: points.reduce<number | null>((m, p) => (p.weight != null && (m == null || p.weight > m) ? p.weight : m), null),
    bestE1rm: points.reduce<number | null>((m, p) => (p.e1rm != null && (m == null || p.e1rm > m) ? p.e1rm : m), null),
  }
}

/**
 * Everything the lift model reads, in one pass: the whole log (every program —
 * the all-time best has to see all of it), recent pain reports, hand-set TMs,
 * and the live week the recommendation is for.
 */
export async function loadLiftModelSources(store: ConnectedStore): Promise<LiftModelSources> {
  const rows = await store.sql<{
    id: string
    performed_at: string
    actual_weights: unknown
    exercises_snapshot: unknown
    r_exercises: unknown
    knee_pain_l: number | null
    knee_pain_r: number | null
    sleep_hours: string | number | null
    readiness: number | null
    bodyweight: string | number | null
  }[]>`
    SELECT w.id, to_json(w.performed_at) #>> '{}' AS performed_at, w.actual_weights, w.exercises_snapshot,
           w.knee_pain_l, w.knee_pain_r, w.sleep_hours, w.readiness, w.bodyweight,
           r.exercises AS r_exercises
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId}
    ORDER BY w.performed_at ASC
    LIMIT 5000
  `
  const workouts: ModelWorkout[] = rows.map((w) => ({
    id: w.id,
    performed_at: w.performed_at,
    actual_weights: asJson(w.actual_weights, null),
    exercises_snapshot: asJson(w.exercises_snapshot, null),
    routine: { exercises: asJson<ExerciseTemplate[]>(w.r_exercises, []) },
    knee_pain_l: w.knee_pain_l,
    knee_pain_r: w.knee_pain_r,
    sleep_hours: w.sleep_hours,
    readiness: w.readiness,
    bodyweight: w.bodyweight,
  }))
  const today = localDay(new Date().toISOString())
  const weekStart = mondayOf(today)
  const recentIds = workouts.filter((w) => localDay(w.performed_at) >= addDays(weekStart, -14)).map((w) => w.id as string)
  const observations = recentIds.length
    ? await store.sql<{ signal: string; severity: number; logged_at: string }[]>`
        SELECT signal, severity, to_json(logged_at) #>> '{}' AS logged_at
        FROM session_observation
        WHERE workout_id = ANY(${store.sql.array(recentIds)}) AND severity >= 4
      `
    : []
  const [athlete] = await store.sql<{ training_max_overrides: unknown }[]>`
    SELECT training_max_overrides FROM athlete WHERE id = ${store.athleteId} LIMIT 1
  `
  const ids = await programIds(store)
  const [review] = ids.length
    ? await store.sql<{ week_ending: string; next_week_prescription: unknown }[]>`
        SELECT week_ending::text, next_week_prescription
        FROM weekly_review
        WHERE program_id = ANY(${store.sql.array(ids)})
        ORDER BY week_ending DESC
        LIMIT 1
      `
    : []
  const live = await loadLiveProgram(store)
  const presc = review ? asJson<{ directive?: string } | null>(review.next_week_prescription, null) : null
  return {
    workouts,
    observations,
    overrides: asJson<Record<string, unknown> | null>(athlete?.training_max_overrides, null),
    sessions: (live?.sessions ?? []).slice().sort((a, b) => (a.intendedDow ?? 7) - (b.intendedDow ?? 7) || a.name.localeCompare(b.name)),
    phaseName: live?.phaseName ?? null,
    directive: review && review.week_ending === addDays(weekStart, -1) ? presc?.directive ?? null : null,
    today,
    unit: store.unit === 'kg' ? 'kg' : 'lb',
  }
}

/**
 * Write (or clear, with null) one lift's hand-set training max. One UPDATE that
 * merges in SQL: no read-modify-write window for a second writer to fall into,
 * and a single owner filter on the row it touches.
 */
export async function saveTrainingMax(store: ConnectedStore, lift: MainLiftId, entry: TmOverride | null): Promise<Record<string, unknown>> {
  const json = entry ? JSON.stringify(entry) : null
  const [row] = await store.sql<{ training_max_overrides: unknown }[]>`
    UPDATE athlete SET training_max_overrides = CASE
      WHEN ${json}::jsonb IS NULL THEN COALESCE(training_max_overrides, '{}'::jsonb) - ${lift}::text
      ELSE COALESCE(training_max_overrides, '{}'::jsonb) || jsonb_build_object(${lift}::text, ${json}::jsonb)
    END
    WHERE id = ${store.athleteId}
    RETURNING training_max_overrides
  `
  if (!row) throw new Error('Athlete row missing')
  return asJson<Record<string, unknown>>(row.training_max_overrides, {})
}

export async function loadJourney(store: ConnectedStore): Promise<{
  blocks: Array<{ name: string; start: string; end: string; status: string }>
  revisions: Array<{ date: string; trigger: string; summary: string | null; requests: string[] }>
}> {
  const [prog] = await store.sql<{ id: string }[]>`
    SELECT id FROM program WHERE athlete_id = ${store.athleteId} AND status = 'active' LIMIT 1
  `
  if (!prog?.id) return { blocks: [], revisions: [] }
  const phases = await store.sql<{ name: string; week_start: string; week_end: string; status: string }[]>`
    SELECT name, week_start::text, week_end::text, status
    FROM phase WHERE program_id = ${prog.id}
    ORDER BY week_start DESC
  `
  const revs = await store.sql<{
    effective_on: string
    trigger: string
    summary: string | null
    requests: unknown
  }[]>`
    SELECT effective_on::text, trigger, summary, requests
    FROM program_revision
    WHERE program_id = ${prog.id}
    ORDER BY created_at DESC
    LIMIT 40
  `
  return {
    blocks: phases.map((p) => ({ name: p.name, start: p.week_start, end: p.week_end, status: p.status })),
    revisions: revs.map((r) => ({
      date: r.effective_on,
      trigger: r.trigger,
      summary: r.summary,
      requests: asJson<string[]>(r.requests, []),
    })),
  }
}

export async function loadNotes(store: ConnectedStore, limit = 12): Promise<{
  weekly: Array<{ week_ending: string; coach_notes: string | null }>
  coach: Array<{ created_at: string; role: string; kind: string; body: string }>
}> {
  const ids = await programIds(store)
  const cap = Math.max(1, Math.min(limit, 40))
  const weekly = ids.length
    ? await store.sql<{ week_ending: string; coach_notes: string | null }[]>`
        SELECT week_ending::text, coach_notes
        FROM weekly_review
        WHERE program_id = ANY(${store.sql.array(ids)})
        ORDER BY week_ending DESC
        LIMIT ${cap}
      `
    : []
  const coach = await store.sql<{ created_at: string; role: string; kind: string; body: string }[]>`
    SELECT to_json(created_at) #>> '{}' AS created_at, role, kind, body
    FROM coach_message
    WHERE athlete_id = ${store.athleteId}
    ORDER BY created_at DESC
    LIMIT ${cap}
  `
  return { weekly, coach }
}

export function renderAthlete(a: Awaited<ReturnType<typeof loadAthlete>>): string {
  const lines = [
    `# ${a.name ?? 'Athlete'}`,
    a.sport ? `Sport: ${a.sport}` : null,
    a.goals ? `Target: ${a.goals}` : null,
    a.obstacle ? `Obstacle: ${a.obstacle}` : null,
    a.arena_raw ? `Arena: ${a.arena_raw}${a.arena_type ? ` (${a.arena_type})` : ''}` : null,
    a.limiter_choice ? `Named limiter: ${a.limiter_choice}` : null,
    a.training_age != null ? `Training age: ${a.training_age} years` : null,
    a.sessions_per_week != null ? `Sessions / week: ${a.sessions_per_week}` : null,
    a.current_phase ? `Current phase: ${a.current_phase}` : null,
    a.retest_date ? `Retest: ${a.retest_date}` : null,
    a.training_preferences ? `\nStanding preferences:\n${a.training_preferences}` : null,
  ]
  return lines.filter(Boolean).join('\n')
}

export function renderInsights(rows: InsightView[]): string {
  if (!rows.length) return 'No open insights.'
  return rows.map((i) =>
    `- ${i.priority} ${i.category} [${i.status}, ${(Number(i.confidence) * 100).toFixed(0)}%]: ${i.claim}` +
    (i.program_impact ? `\n  impact: ${i.program_impact}` : ''),
  ).join('\n')
}

export function renderJourney(j: Awaited<ReturnType<typeof loadJourney>>): string {
  const blocks = j.blocks.length
    ? j.blocks.map((b) => `- ${b.name} ${shortDate(b.start)} → ${shortDate(b.end)} (${b.status})`).join('\n')
    : 'No blocks on the active program.'
  const revs = j.revisions.length
    ? j.revisions.map((r) => {
        const ask = r.requests.length ? ` — asked: ${r.requests.join('; ')}` : ''
        return `- ${shortDate(r.date)} [${r.trigger}] ${r.summary ?? 'changed'}${ask}`
      }).join('\n')
    : 'No recorded reprogramming events.'
  return `## Blocks\n${blocks}\n\n## Changes\n${revs}`
}

export function renderNotes(n: Awaited<ReturnType<typeof loadNotes>>): string {
  const weekly = n.weekly.filter((w) => w.coach_notes).map((w) =>
    `### Week ending ${shortDate(w.week_ending)}\n${w.coach_notes}`,
  )
  const coach = n.coach.map((m) =>
    `- ${shortDate(m.created_at)} [${m.role}/${m.kind}] ${m.body}`,
  )
  return [
    weekly.length ? `## Weekly reviews\n${weekly.join('\n\n')}` : '## Weekly reviews\nNone.',
    coach.length ? `## Coach log\n${coach.join('\n')}` : '## Coach log\nNone.',
  ].join('\n\n')
}

export function renderLift(h: Awaited<ReturnType<typeof loadLiftHistory>>, unit: string): string {
  if (!h.points.length) {
    return h.matches.length
      ? `Matched ${h.matches.join(', ')} but no logged working sets.`
      : `No logged sets matching "${h.name}".`
  }
  const lines = [
    `# ${h.matches.join(', ') || h.name}`,
    h.bestWeight != null ? `Best load: ${h.bestWeight}${unit}` : null,
    h.bestE1rm != null ? `Best e1RM (RPE chart; no RPE reads as @10): ${h.bestE1rm}${unit}` : null,
    h.canonical ? `Matched by lift identity (${h.canonical}) — variations like Cossack, split, close-grip or push press are excluded. get_lift_model has the working max and this week's number.` : null,
    '',
    ...h.points.map((p) => `- ${p.date}: ${p.top}${p.e1rm != null ? ` (e1RM ${p.e1rm})` : ''}`),
  ]
  return lines.filter((l) => l !== null).join('\n')
}
