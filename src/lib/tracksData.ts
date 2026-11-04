import { invalidateCache, useCachedLoader } from './cache'
import { cacheKeys } from './loopCache'
import { supabase } from './supabaseClient'
import { tracksOn } from './tracksFlag'
import { tracksV1Enabled } from './flags'
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
  /** The lane this goal sits on, by its track id even when that track is last block's. */
  lane: Pick<TrackRow, 'id' | 'name' | 'icon' | 'sort_order'> | null
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
  const trackIds = [...new Set(((goals ?? []) as AthleteGoalRow[]).map((g) => g.track_id).filter((id): id is string => !!id))]
  const { data: laneRows } = trackIds.length
    ? await supabase.from('track').select('id, name, icon, sort_order').in('id', trackIds)
    : { data: [] }
  const laneById = new Map(((laneRows ?? []) as Array<GoalView['lane'] & object>).map((t) => [t.id, t]))
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
      lane: (g.track_id && laneById.get(g.track_id)) || null,
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

/**
 * A new block keeps its lanes. Tracks belong to a program, so a fresh program
 * starts with only General while every goal still points at last block's
 * tracks. This copies the named tracks from the athlete's previous program
 * (by name, skipping any the new one already has) and moves each goal onto the
 * same-named lane. Progression rules stay with their program: they name that
 * block's exercises. Best-effort; never throws.
 */
export async function carryLanesForward(athleteId: string, programId: string): Promise<void> {
  if (!tracksOn()) return
  try {
    const { data: programs } = await supabase
      .from('program').select('id, status, start_date')
      .eq('athlete_id', athleteId).neq('id', programId)
      .order('start_date', { ascending: false }).limit(6)
    const prior = ((programs ?? []) as Array<{ id: string; status: string | null }>).find((p) => wantsGeneralTrack(p.status))
    if (!prior) return
    const [{ data: oldRows }, { data: newRows }] = await Promise.all([
      supabase.from('track')
        .select('id, name, color, icon, sort_order, purpose, methodology_text, sources, deload_policy, retest_policy')
        .eq('program_id', prior.id),
      supabase.from('track').select('id, name').eq('program_id', programId),
    ])
    const oldTracks = (oldRows ?? []) as TrackRow[]
    const here = new Map(((newRows ?? []) as Array<{ id: string; name: string }>).map((t) => [t.name.toLowerCase(), t.id]))
    for (const t of oldTracks) {
      const key = t.name.toLowerCase()
      if (here.has(key)) continue
      const { data: row } = await supabase.from('track').insert({
        program_id: programId,
        name: t.name,
        color: t.color,
        icon: t.icon,
        sort_order: t.sort_order,
        purpose: t.purpose,
        methodology_text: t.methodology_text,
        sources: t.sources ?? [],
        deload_policy: t.deload_policy ?? null,
        retest_policy: t.retest_policy ?? null,
      }).select('id').single()
      if (row) here.set(key, (row as { id: string }).id)
    }
    const oldName = new Map(oldTracks.map((t) => [t.id, t.name.toLowerCase()]))
    const { data: goalRows } = await supabase.from('athlete_goal').select('id, track_id').eq('athlete_id', athleteId)
    for (const g of (goalRows ?? []) as Array<{ id: string; track_id: string | null }>) {
      const name = g.track_id ? oldName.get(g.track_id) : undefined
      const next = name ? here.get(name) : undefined
      if (next && next !== g.track_id) await supabase.from('athlete_goal').update({ track_id: next }).eq('id', g.id)
    }
  } catch { /* the goals keep their old lane; the next block can carry it */ }
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
 * Whether goals are on for this athlete, from the row itself when the screens
 * haven't resolved the flag yet: the outbox flushes on launch, before the
 * athlete row loads, and a session synced then must still move its goals.
 */
async function tracksOnFor(athleteId: string): Promise<boolean> {
  if (tracksOn()) return true
  const { data } = await supabase.from('athlete').select('flags').eq('id', athleteId).maybeSingle()
  return tracksV1Enabled(import.meta.env, (data as { flags?: unknown } | null)?.flags, '')
}

/** current is the latest measurement, best the best one, baseline the first. */
async function refreshGoalMarks(goal: Pick<GoalForSource, 'id' | 'direction' | 'baseline'>): Promise<void> {
  const { data } = await supabase
    .from('goal_measurement').select('value, measured_on')
    .eq('goal_id', goal.id).order('measured_on', { ascending: false }).limit(60)
  const values = ((data ?? []) as Array<{ value: number | string }>).map((r) => Number(r.value)).filter(Number.isFinite)
  if (!values.length) return
  const best = goal.direction === 'lower' ? Math.min(...values) : Math.max(...values)
  await supabase.from('athlete_goal').update({
    current: values[0],
    best,
    ...(goal.baseline == null ? { baseline: values[values.length - 1] } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', goal.id)
}

/**
 * A committed session moves the goals it trained: each goal whose source the
 * session matched gets a workout_log measurement, keyed per workout and goal
 * (wl:{workout}:{goal}) so an outbox retry never doubles it. A new session
 * writes only when it holds or beats the goal's mark. An edit corrects: the
 * row this workout already wrote takes the new value (even a lower one, so a
 * typo can be taken back), a goal the session no longer feeds loses its row,
 * and a goal it newly feeds is judged like a new session. The goal's current
 * and best are then recomputed from its measurements. Best-effort, like
 * everything after the workout row in commitSession: it never throws.
 */
export async function recordSessionGoals(input: {
  athleteId: string
  workoutId: string
  performedOn: string
  exercises: LoggedExercise[]
  units: SourceUnits
  isEdit: boolean
}): Promise<DerivedMeasurement[]> {
  try {
    if (!(await tracksOnFor(input.athleteId))) return []
    const goals = await fetchGoalsForSources(input.athleteId)
    const gated = deriveGoalMeasurements(input.exercises, goals, input.units)
    const all = input.isEdit
      ? deriveGoalMeasurements(input.exercises, goals, input.units, { requireHold: false })
      : gated
    const { data: ownRows } = await supabase
      .from('goal_measurement').select('id, goal_id, client_key')
      .eq('athlete_id', input.athleteId).eq('workout_id', input.workoutId)
    const own = new Map(((ownRows ?? []) as Array<{ id: string; goal_id: string; client_key: string | null }>)
      .filter((r) => r.client_key?.startsWith('wl:'))
      .map((r) => [r.client_key as string, r]))
    const written: DerivedMeasurement[] = []
    const touched = new Set<string>()
    for (const m of all) {
      const client_key = workoutMeasurementKey(input.workoutId, m.goal_id)
      const existing = own.get(client_key)
      if (existing) {
        // The Worker answers a duplicate insert with success, so a correction
        // has to update the row it already holds.
        await supabase.from('goal_measurement')
          .update({ value: m.value, measured_on: input.performedOn, note: m.exercise })
          .eq('id', existing.id)
        own.delete(client_key)
      } else {
        if (!gated.some((g) => g.goal_id === m.goal_id)) continue
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
        if (error && !/duplicate|unique/i.test(error.message ?? '')) continue
      }
      written.push(m)
      touched.add(m.goal_id)
    }
    if (input.isEdit) {
      for (const stale of own.values()) {
        await supabase.from('goal_measurement').delete().eq('id', stale.id)
        touched.add(stale.goal_id)
      }
    }
    for (const id of touched) {
      const goal = goals.find((g) => g.id === id)
      if (goal) await refreshGoalMarks(goal)
    }
    if (touched.size) invalidateCache(cacheKeys.goals(input.athleteId))
    return written
  } catch {
    return []
  }
}
