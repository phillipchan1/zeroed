import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { readLoggedExercises, type LoggedWorkoutLike } from './engine/loggedSets.ts'
import {
  e1rmFromSet, liftNameMatcher, localDay, mondayOf, addDays, parseLiftId,
  type LiftModelSources, type MainLiftId, type ModelWorkout,
} from './engine/liftModel.ts'
import type { ExerciseTemplate } from './engine/types.ts'
import { formatSet, isoDay, shortDate, topWorkingSet } from './zeroedFormat.ts'

export type Db = SupabaseClient

export interface ConnectedStore {
  supabase: Db
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

export function makeStore(supabase: Db, athleteId: string, unit = 'lb'): ConnectedStore {
  return { supabase, athleteId, unit: unit === 'kg' ? 'kg' : 'lb' }
}

export async function programIds(store: ConnectedStore): Promise<string[]> {
  const { data, error } = await store.supabase
    .from('program').select('id').eq('athlete_id', store.athleteId)
  if (error) throw new Error(error.message)
  return (data ?? []).map((p) => p.id)
}

export async function loadAthlete(store: ConnectedStore): Promise<AthleteRow & { current_phase: string | null; retest_date: string | null }> {
  const [{ data: athlete, error }, { data: profile }] = await Promise.all([
    store.supabase.from('athlete').select(
      'id, auth_user_id, name, sport, goals, obstacle, training_age, sessions_per_week, training_preferences, arena_type, arena_raw, limiter_choice',
    ).eq('id', store.athleteId).maybeSingle(),
    store.supabase.from('athlete_profile').select('current_phase, retest_date').eq('athlete_id', store.athleteId).maybeSingle(),
  ])
  if (error) throw new Error(error.message)
  if (!athlete) throw new Error('Athlete row missing')
  return {
    ...(athlete as AthleteRow),
    current_phase: (profile?.current_phase as string | null) ?? null,
    retest_date: (profile?.retest_date as string | null) ?? null,
  }
}

export async function loadLiveProgram(store: ConnectedStore): Promise<LiveProgram | null> {
  const { data: prog, error: progErr } = await store.supabase
    .from('program').select('id, goal').eq('athlete_id', store.athleteId).eq('status', 'active').maybeSingle()
  if (progErr) throw new Error(progErr.message)
  if (!prog?.id) return null

  const { data: phaseRow, error: phaseErr } = await store.supabase
    .from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
  if (phaseErr) throw new Error(phaseErr.message)
  if (!phaseRow) return null

  const [routineRes, queuedRes, athleteRes] = await Promise.all([
    store.supabase.from('routine').select('*').eq('program_id', prog.id).eq('phase_id', phaseRow.id).order('name'),
    store.supabase.from('phase').select('id, name, week_start').eq('program_id', prog.id).eq('status', 'pending').order('week_start').limit(1).maybeSingle(),
    store.supabase.from('athlete').select('sessions_per_week, training_preferences').eq('id', store.athleteId).maybeSingle(),
  ])
  if (routineRes.error) throw new Error(routineRes.error.message)

  let routineRows = routineRes.data ?? []
  if (routineRows.length === 0) {
    const { data, error } = await store.supabase.from('routine').select('*').eq('program_id', prog.id).order('name')
    if (error) throw new Error(error.message)
    routineRows = data ?? []
  }

  const mapSession = (r: {
    id: string; name: string; intent: string | null; session_type: string | null
    intended_dow: number | null; exercises: ExerciseTemplate[]
  }) => ({
    routineId: r.id,
    name: r.name,
    intent: r.intent ?? '',
    sessionType: r.session_type ?? 'strength',
    intendedDow: r.intended_dow ?? null,
    exercises: Array.isArray(r.exercises) ? r.exercises : [],
  })

  let scheduledSessions: LiveProgram['scheduledSessions'] = []
  if (queuedRes.data) {
    const queuedRoutines = await store.supabase
      .from('routine').select('*').eq('program_id', prog.id).eq('phase_id', queuedRes.data.id)
    if (queuedRoutines.error) throw new Error(queuedRoutines.error.message)
    scheduledSessions = ((queuedRoutines.data ?? []) as Array<{
      id: string; name: string; intent: string | null; session_type: string | null
      intended_dow: number | null; exercises: ExerciseTemplate[]
    }>).map(mapSession)
      .sort((a, b) => (a.intendedDow ?? 7) - (b.intendedDow ?? 7) || a.name.localeCompare(b.name))
  }

  return {
    programId: prog.id,
    goal: (prog.goal as string | null) ?? null,
    phaseId: phaseRow.id,
    phaseName: phaseRow.name,
    weekStart: phaseRow.week_start,
    weekEnd: phaseRow.week_end,
    nonNegotiables: Array.isArray(phaseRow.non_negotiables) ? phaseRow.non_negotiables as string[] : [],
    advancementCriteria: Array.isArray(phaseRow.advancement_criteria) ? phaseRow.advancement_criteria as string[] : [],
    sessionsPerWeek: Number(athleteRes.data?.sessions_per_week) || Math.max(1, routineRows.length),
    standingPreferences: (athleteRes.data?.training_preferences as string | null) ?? null,
    sessions: (routineRows as Array<{
      id: string; name: string; intent: string | null; session_type: string | null
      intended_dow: number | null; exercises: ExerciseTemplate[]
    }>).map(mapSession),
    scheduledPhase: queuedRes.data
      ? { id: queuedRes.data.id, name: queuedRes.data.name, weekStart: queuedRes.data.week_start }
      : null,
    scheduledSessions,
  }
}

export async function loadInsights(store: ConnectedStore, includeSettled = false): Promise<InsightView[]> {
  let q = store.supabase
    .from('insight')
    .select('id, priority, category, claim, confidence, status, program_impact')
    .eq('athlete_id', store.athleteId)
    .order('priority')
  if (!includeSettled) q = q.not('status', 'in', '("resolved","disproved")')
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as InsightView[]
}

export async function loadWorkouts(
  store: ConnectedStore,
  opts: { limit?: number; since?: string; until?: string; exercise?: string } = {},
): Promise<WorkoutRowView[]> {
  const ids = await programIds(store)
  if (!ids.length) return []
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 120))
  let q = store.supabase
    .from('workout')
    .select('id, routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot, routine!inner(id, name, exercises, program_id)')
    .in('routine.program_id', ids)
    .order('performed_at', { ascending: false })
    .limit(limit)
  if (opts.since) q = q.gte('performed_at', opts.since)
  if (opts.until) q = q.lte('performed_at', opts.until)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  let rows = (data ?? []) as unknown as WorkoutRowView[]
  if (opts.exercise) {
    const matches = liftNameMatcher(opts.exercise)
    rows = rows.filter((w) => readLoggedExercises(w).some((e) => matches(e.name)))
  }
  return rows
}

export async function loadWorkout(store: ConnectedStore, workoutId: string): Promise<{
  workout: WorkoutRowView
  observations: Array<{ category: string; signal: string; severity: number }>
} | null> {
  const ids = await programIds(store)
  if (!ids.length) return null
  const { data, error } = await store.supabase
    .from('workout')
    .select('id, routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot, routine!inner(id, name, exercises, program_id)')
    .eq('id', workoutId)
    .in('routine.program_id', ids)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const { data: obs, error: obsErr } = await store.supabase
    .from('session_observation')
    .select('category, signal, severity')
    .eq('workout_id', workoutId)
    .order('logged_at')
  if (obsErr) throw new Error(obsErr.message)
  return {
    workout: data as unknown as WorkoutRowView,
    observations: (obs ?? []) as Array<{ category: string; signal: string; severity: number }>,
  }
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
  const ids = await programIds(store)
  const workouts: ModelWorkout[] = []
  for (let from = 0; ids.length && from < 5000; from += 1000) {
    const { data, error } = await store.supabase
      .from('workout')
      .select('id, performed_at, actual_weights, exercises_snapshot, knee_pain_l, knee_pain_r, sleep_hours, readiness, bodyweight, routine!inner(exercises, program_id)')
      .in('routine.program_id', ids)
      .order('performed_at', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    workouts.push(...((data ?? []) as unknown as ModelWorkout[]))
    if ((data ?? []).length < 1000) break
  }
  const today = localDay(new Date().toISOString())
  const weekStart = mondayOf(today)
  const recentIds = workouts.filter((w) => localDay(w.performed_at) >= addDays(weekStart, -14)).map((w) => w.id).filter((id): id is string => !!id)
  const [athleteRes, live, obsRes, reviewRes] = await Promise.all([
    store.supabase.from('athlete').select('training_max_overrides').eq('id', store.athleteId).maybeSingle(),
    loadLiveProgram(store),
    recentIds.length
      ? store.supabase.from('session_observation').select('signal, severity, logged_at').in('workout_id', recentIds).gte('severity', 4)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? store.supabase.from('weekly_review').select('week_ending, next_week_prescription').in('program_id', ids).order('week_ending', { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (athleteRes.error) throw new Error(athleteRes.error.message)
  if (obsRes.error) throw new Error(obsRes.error.message)
  const review = reviewRes.data as { week_ending: string; next_week_prescription: { directive?: string } | null } | null
  return {
    workouts,
    observations: (obsRes.data ?? []) as Array<{ signal: string; severity: number; logged_at: string }>,
    overrides: (athleteRes.data?.training_max_overrides as Record<string, number> | null) ?? null,
    sessions: (live?.sessions ?? []).slice().sort((a, b) => (a.intendedDow ?? 7) - (b.intendedDow ?? 7) || a.name.localeCompare(b.name)),
    phaseName: live?.phaseName ?? null,
    directive: review && review.week_ending === addDays(weekStart, -1) ? review.next_week_prescription?.directive ?? null : null,
    today,
    unit: store.unit === 'kg' ? 'kg' : 'lb',
  }
}

/** Write (or clear, with null) one lift's hand-set training max. */
export async function saveTrainingMax(store: ConnectedStore, lift: MainLiftId, value: number | null): Promise<Record<string, number>> {
  const { data, error } = await store.supabase.from('athlete').select('training_max_overrides').eq('id', store.athleteId).maybeSingle()
  if (error) throw new Error(error.message)
  const next: Record<string, number> = { ...((data?.training_max_overrides as Record<string, number> | null) ?? {}) }
  if (value == null) delete next[lift]
  else next[lift] = value
  const { error: upErr } = await store.supabase.from('athlete').update({ training_max_overrides: next }).eq('id', store.athleteId)
  if (upErr) throw new Error(upErr.message)
  return next
}

export async function loadJourney(store: ConnectedStore): Promise<{
  blocks: Array<{ name: string; start: string; end: string; status: string }>
  revisions: Array<{ date: string; trigger: string; summary: string | null; requests: string[] }>
}> {
  const { data: prog } = await store.supabase
    .from('program').select('id').eq('athlete_id', store.athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return { blocks: [], revisions: [] }
  const [{ data: phases, error: pErr }, { data: revs, error: rErr }] = await Promise.all([
    store.supabase.from('phase').select('name, week_start, week_end, status').eq('program_id', prog.id).order('week_start', { ascending: false }),
    store.supabase.from('program_revision').select('effective_on, trigger, summary, requests').eq('program_id', prog.id).order('created_at', { ascending: false }).limit(40),
  ])
  if (pErr) throw new Error(pErr.message)
  if (rErr) throw new Error(rErr.message)
  return {
    blocks: ((phases ?? []) as Array<{ name: string; week_start: string; week_end: string; status: string }>).map((p) => ({
      name: p.name, start: p.week_start, end: p.week_end, status: p.status,
    })),
    revisions: ((revs ?? []) as Array<{ effective_on: string; trigger: string; summary: string | null; requests: string[] | null }>).map((r) => ({
      date: r.effective_on,
      trigger: r.trigger,
      summary: r.summary,
      requests: Array.isArray(r.requests) ? r.requests : [],
    })),
  }
}

export async function loadNotes(store: ConnectedStore, limit = 12): Promise<{
  weekly: Array<{ week_ending: string; coach_notes: string | null }>
  coach: Array<{ created_at: string; role: string; kind: string; body: string }>
}> {
  const ids = await programIds(store)
  const cap = Math.max(1, Math.min(limit, 40))
  const [weeklyRes, coachRes] = await Promise.all([
    ids.length
      ? store.supabase.from('weekly_review').select('week_ending, coach_notes').in('program_id', ids).order('week_ending', { ascending: false }).limit(cap)
      : Promise.resolve({ data: [], error: null }),
    store.supabase.from('coach_message').select('created_at, role, kind, body').eq('athlete_id', store.athleteId).order('created_at', { ascending: false }).limit(cap),
  ])
  if (weeklyRes.error) throw new Error(weeklyRes.error.message)
  if (coachRes.error) throw new Error(coachRes.error.message)
  return {
    weekly: (weeklyRes.data ?? []) as Array<{ week_ending: string; coach_notes: string | null }>,
    coach: (coachRes.data ?? []) as Array<{ created_at: string; role: string; kind: string; body: string }>,
  }
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
