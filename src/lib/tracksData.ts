import { useCachedLoader } from './cache'
import { cacheKeys } from './loopCache'
import { supabase } from './supabaseClient'
import { tracksOn } from './tracksFlag'
import { computeGoalStatus, pairKey, type GoalMeasurement } from '../engine/goals'
import type { AutoregRule } from '../engine/autoreg'
import type { TrackRef } from '../engine/tracks'
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
  pair: string
  history: GoalMeasurement[]
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
    list.push({ date: row.measured_on, value: Number(row.value), side: row.side, source: row.source, note: row.note })
    byGoal.set(row.goal_id, list)
  }
  const today = new Date().toISOString().slice(0, 10)
  return ((goals ?? []) as AthleteGoalRow[]).map((g) => {
    const history = byGoal.get(g.id) ?? []
    return {
      ...g,
      computed: computeGoalStatus(g, history, today),
      pair: pairKey(g.name),
      history,
    }
  })
}

export async function ensureGeneralTrack(programId: string): Promise<void> {
  const { data } = await supabase
    .from('track')
    .select('id')
    .eq('program_id', programId)
    .eq('name', 'General')
    .maybeSingle()
  if (data) return
  const { error } = await supabase.from('track').insert({
    program_id: programId,
    name: 'General',
    color: '#9A9A9A',
    icon: 'circle',
    sort_order: 0,
    purpose: 'Default track for unassigned work',
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
  const best = values.length ? Math.max(...values) : input.value
  await supabase.from('athlete_goal').update({ current, best, updated_at: new Date().toISOString() }).eq('id', input.goalId)
}
