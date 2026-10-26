/**
 * App-layer stand-in for Supabase RLS.
 *
 * Every public table is owned by an athlete (directly, or through program →
 * routine → workout). The Worker never runs `SET ROLE` / `auth.uid()`; callers
 * resolve the signed-in (or MCP-token) athlete first, then every query is
 * filtered by that id. These helpers are the single list of ownership rules
 * and are unit-tested with two athletes so a leaked foreign id cannot read
 * another user's rows.
 */

export type TableName =
  | 'athlete'
  | 'athlete_profile'
  | 'diagnostic'
  | 'insight'
  | 'insight_draft'
  | 'program'
  | 'coach_message'
  | 'workout_draft'
  | 'mcp_token'
  | 'phase'
  | 'routine'
  | 'weekly_review'
  | 'program_revision'
  | 'workout'
  | 'session_observation'

export type AthleteOwnedTable =
  | 'athlete'
  | 'athlete_profile'
  | 'diagnostic'
  | 'insight'
  | 'insight_draft'
  | 'program'
  | 'coach_message'
  | 'workout_draft'
  | 'mcp_token'

export type ProgramOwnedTable = 'phase' | 'routine' | 'weekly_review' | 'program_revision'

export interface AthleteRow {
  id: string
  auth_user_id: string
}

export interface OwnershipIndex {
  athletes: AthleteRow[]
  programs: Array<{ id: string; athlete_id: string }>
  routines: Array<{ id: string; program_id: string }>
  workouts: Array<{ id: string; routine_id: string }>
}

export const ATHLETE_OWNED: readonly AthleteOwnedTable[] = [
  'athlete',
  'athlete_profile',
  'diagnostic',
  'insight',
  'insight_draft',
  'program',
  'coach_message',
  'workout_draft',
  'mcp_token',
] as const

export const PROGRAM_OWNED: readonly ProgramOwnedTable[] = [
  'phase',
  'routine',
  'weekly_review',
  'program_revision',
] as const

export function athleteIdColumn(table: AthleteOwnedTable): 'id' | 'athlete_id' {
  return table === 'athlete' ? 'id' : 'athlete_id'
}

/** True when `row` belongs to `athleteId` given the ownership graph. */
export function athleteOwnsRow(
  athleteId: string,
  table: TableName,
  row: Record<string, unknown>,
  index: OwnershipIndex,
): boolean {
  if (table === 'athlete') {
    return row.id === athleteId
  }
  if ((ATHLETE_OWNED as readonly string[]).includes(table)) {
    return row.athlete_id === athleteId
  }
  if ((PROGRAM_OWNED as readonly string[]).includes(table)) {
    const programId = String(row.program_id ?? '')
    return index.programs.some((p) => p.id === programId && p.athlete_id === athleteId)
  }
  if (table === 'workout') {
    const routineId = String(row.routine_id ?? '')
    const routine = index.routines.find((r) => r.id === routineId)
    if (!routine) return false
    return index.programs.some((p) => p.id === routine.program_id && p.athlete_id === athleteId)
  }
  if (table === 'session_observation') {
    const workoutId = String(row.workout_id ?? '')
    const workout = index.workouts.find((w) => w.id === workoutId)
    if (!workout) return false
    return athleteOwnsRow(athleteId, 'workout', workout, index)
  }
  return false
}

/** Filter a result set the way RLS would. Used by tests and defensive reads. */
export function restrictToAthlete<T extends Record<string, unknown>>(
  athleteId: string,
  table: TableName,
  rows: T[],
  index: OwnershipIndex,
): T[] {
  return rows.filter((row) => athleteOwnsRow(athleteId, table, row, index))
}

export function athleteForUser(index: OwnershipIndex, userId: string): AthleteRow | null {
  return index.athletes.find((a) => a.auth_user_id === userId) ?? null
}

/**
 * SQL WHERE fragment for an athlete-owned table. The caller still binds
 * `athleteId` — this only names the column so a query cannot "forget" the
 * owner check by using a different identifier.
 */
export function ownerWhere(table: AthleteOwnedTable, athleteId: string): { column: string; athleteId: string } {
  return { column: athleteIdColumn(table), athleteId }
}

export class AccessDenied extends Error {
  constructor(message = 'not found') {
    super(message)
    this.name = 'AccessDenied'
  }
}

/** Refuse to return a row that failed the ownership check (do not leak existence). */
export function takeOwned<T extends Record<string, unknown>>(
  athleteId: string,
  table: TableName,
  row: T | null | undefined,
  index: OwnershipIndex,
): T | null {
  if (!row) return null
  return athleteOwnsRow(athleteId, table, row, index) ? row : null
}
