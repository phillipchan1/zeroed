import { invalidateCache, useCachedLoader } from './cache'
import { cacheKeys } from './loopCache'
import { supabase } from './supabaseClient'
import { tracksOn } from './tracksFlag'
import { computeGoalStatus, forecastAtDue, goalDisplayStatus, lastMeasuredOn, pairKey, type GoalDisplay, type GoalForecast, type GoalMeasurement } from '../engine/goals'
import type { AutoregRule } from '../engine/autoreg'
import {
  deriveGoalMeasurements, workoutMeasurementKey,
  type DerivedMeasurement, type GoalForSource, type LoggedExercise, type SourceUnits,
} from '../engine/goalSources'
import { GENERAL_TRACK_SEED, wantsGeneralTrack, type TrackRef } from '../engine/tracks'
import type { AthleteGoalRow, GoalMeasurementRow, TrackRow } from '../types/database'

export function useProgramTracks(programId: string | null | undefined) {
  const id = programId ?? ''
  const { data } = useCachedLoader<TrackRef[]>(
    id ? cacheKeys.tracks(id) : 'tracks:none',
    () => (id && tracksOn() ? fetchTracks(id) : Promise.resolve([])),
  )
  return tracksOn() ? (data ?? []) : []
}

export async function fetchTracks(programId: string): Promise<TrackRef[]> {
  const { data, error } = await supabase
    .from('track')
    .select('id, name, color, icon, sort_order, purpose')
    .eq('program_id', programId)
    .order('sort_order', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Array<Pick<TrackRow, 'id' | 'name' | 'color' | 'icon' | 'sort_order' | 'purpose'>>).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color || '#9A9A9A',
    icon: t.icon || 'circle',
    order: t.sort_order,
    purpose: t.purpose,
  }))
}

export async function fetchAutoregRules(athleteId: string): Promise<AutoregRule[]> {
  const { data, error } = await supabase
    .from('autoreg_rule')
    .select('id, scope_type, scope_id, scope_name, signal, op, value, action, action_params, message')
    .eq('athlete_id', athleteId)
  if (error) throw error
  return (data ?? []) as AutoregRule[]
}

export interface GoalView extends AthleteGoalRow {
  computed: ReturnType<typeof computeGoalStatus>
  display: GoalDisplay
  forecast: GoalForecast | null
  pair: string
  history: GoalMeasurement[]
  last_measured: string | null
}

export async function fetchGoalsView(athleteId: string): Promise<GoalView[]> {
  const [{ data: goals, error: gErr }, { data: meas, error: mErr }] = await Promise.all([
    supabase.from('athlete_goal').select('*').eq('athlete_id', athleteId).order('name'),
    supabase.from('goal_measurement').select('*').eq('athlete_id', athleteId).order('measured_on', { ascending: true }),
  ])
  if (gErr) throw gErr
  if (mErr) throw mErr
  const byGoal = new Map<string, GoalMeasurement[]>()
  for (const row of (meas ?? []) as GoalMeasurementRow[]) {
    const list = byGoal.get(row.goal_id) ?? []
    list.push({
      date: row.measured_on,
      value: Number(row.value),
      side: row.side,
      source: row.source,
      note: row.note,
      client_key: row.client_key,
    })
    byGoal.set(row.goal_id, list)
  }
  const today = new Date().toLocaleDateString('en-CA')
  return ((goals ?? []) as AthleteGoalRow[]).map((g) => {
    const history = byGoal.get(g.id) ?? []
    const computed = computeGoalStatus(g, history, today)
    const last_measured = lastMeasuredOn(history)
    return {
      ...g,
      computed,
      display: goalDisplayStatus(computed, last_measured, { cadence: g.cadence, today }),
      forecast: forecastAtDue(g, history),
      pair: pairKey(g.name),
      history,
      last_measured,
    }
  })
}

export interface GoalMove {
  id: string
  body: string
  created_at: string
}

export interface GoalExtras {
  track: Pick<TrackRow, 'id' | 'name' | 'icon'> | null
  moves: GoalMove[]
}

/**
 * The goal's lane and the coach's trail on it. A confirmed MCP write records a
 * coach_message note whose ref_id is the goal or track it touched, so the
 * moves for a goal are the notes pinned to it or to its lane.
 */
export async function fetchGoalExtras(goal: Pick<AthleteGoalRow, 'id' | 'athlete_id' | 'track_id'>): Promise<GoalExtras> {
  const refs = goal.track_id ? [goal.id, goal.track_id] : [goal.id]
  const [trackRes, movesRes] = await Promise.all([
    goal.track_id
      ? supabase.from('track').select('id, name, icon').eq('id', goal.track_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('coach_message')
      .select('id, body, created_at')
      .eq('athlete_id', goal.athlete_id)
      .in('ref_id', refs)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  if (movesRes.error) throw movesRes.error
  return {
    track: (trackRes.data as GoalExtras['track']) ?? null,
    moves: (movesRes.data ?? []) as GoalMove[],
  }
}

export async function ensureGeneralTrack(programId: string): Promise<void> {
  const { data: prog } = await supabase
    .from('program')
    .select('status')
    .eq('id', programId)
    .maybeSingle()
  if (!wantsGeneralTrack(prog?.status)) return
  const { data } = await supabase
    .from('track')
    .select('id')
    .eq('program_id', programId)
    .eq('name', 'General')
    .maybeSingle()
  if (data) return
  const { error } = await supabase.from('track').insert({
    program_id: programId,
    ...GENERAL_TRACK_SEED,
  })
  if (error && !/duplicate|unique/i.test(error.message ?? '')) throw error
}

export function measurementClientKey(goalId: string, date: string, side: string | null): string {
  return `gm:${goalId}:${date}:${side ?? 'none'}`
}

export async function logMeasurement(input: {
  athleteId: string
  goalId: string
  value: number
  date: string
  side?: string | null
  note?: string | null
  direction?: string | null
}): Promise<void> {
  const client_key = measurementClientKey(input.goalId, input.date, input.side ?? null)
  const { error } = await supabase.from('goal_measurement').insert({
    athlete_id: input.athleteId,
    goal_id: input.goalId,
    measured_on: input.date,
    value: input.value,
    side: input.side ?? null,
    source: 'manual',
    note: input.note ?? null,
    client_key,
  })
  if (error && !/duplicate|unique/i.test(error.message ?? '')) throw error
  const { data: rows } = await supabase
    .from('goal_measurement')
    .select('value')
    .eq('goal_id', input.goalId)
    .order('measured_on', { ascending: false })
    .limit(20)
  const values = ((rows ?? []) as Array<{ value: number }>).map((r) => Number(r.value))
  const current = values[0] ?? input.value
  // A lower-is-better goal (a sprint time, a pain score) is best at its minimum.
  const best = !values.length ? input.value
    : input.direction === 'lower' ? Math.min(...values) : Math.max(...values)
  await supabase.from('athlete_goal').update({ current, best, updated_at: new Date().toISOString() }).eq('id', input.goalId)
}

const GOAL_SOURCE_COLUMNS = 'id, name, metric, unit, side, direction, target, target_range_hi, current, best, baseline, source_metric'

/** Goals with what a session needs to judge them, for the finish screen and the commit. */
export async function fetchGoalsForSources(athleteId: string): Promise<GoalForSource[]> {
  const { data, error } = await supabase.from('athlete_goal').select(GOAL_SOURCE_COLUMNS).eq('athlete_id', athleteId)
  if (error) throw error
  return (data ?? []) as GoalForSource[]
}

/**
 * A committed session moves the goals it trained: each goal whose source the
 * session matched gets a workout_log measurement, keyed per workout and goal so
 * an outbox retry or an edit never doubles it. Best-effort, like everything
 * after the workout row in commitSession: it never throws.
 *
 * On an edit the measurement takes the corrected value but the goal's current
 * is left alone, since the edited session may not be the latest one.
 */
export async function recordSessionGoals(input: {
  athleteId: string
  workoutId: string
  performedOn: string
  exercises: LoggedExercise[]
  units: SourceUnits
  isEdit: boolean
}): Promise<DerivedMeasurement[]> {
  if (!tracksOn()) return []
  try {
    const goals = await fetchGoalsForSources(input.athleteId)
    const derived = deriveGoalMeasurements(input.exercises, goals, input.units)
    for (const m of derived) {
      const client_key = workoutMeasurementKey(input.workoutId, m.goal_id)
      const { error } = await supabase.from('goal_measurement').insert({
        athlete_id: input.athleteId,
        goal_id: m.goal_id,
        measured_on: input.performedOn,
        value: m.value,
        side: null,
        source: 'workout_log',
        workout_id: input.workoutId,
        note: m.exercise,
        client_key,
      })
      if (error) {
        if (!/duplicate|unique/i.test(error.message ?? '')) continue
        await supabase.from('goal_measurement').update({ value: m.value })
          .eq('athlete_id', input.athleteId).eq('client_key', client_key)
      }
      if (input.isEdit) continue
      const goal = goals.find((g) => g.id === m.goal_id)
      const lower = goal?.direction === 'lower'
      const priorBest = goal?.best != null ? Number(goal.best) : null
      const best = priorBest == null || !Number.isFinite(priorBest) ? m.value
        : lower ? Math.min(priorBest, m.value) : Math.max(priorBest, m.value)
      await supabase.from('athlete_goal').update({
        current: m.value,
        best,
        ...(goal?.baseline == null ? { baseline: m.value } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', m.goal_id)
    }
    if (derived.length) invalidateCache(cacheKeys.goals(input.athleteId))
    return derived
  } catch {
    return []
  }
}
