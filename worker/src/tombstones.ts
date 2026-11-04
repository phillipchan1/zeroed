/**
 * change_tombstone (Round 2 item 3, tracks_v1): how a revert hides a row
 * instead of deleting it. 'void' undoes a logging write (check-in, pain
 * report, session RPE tap, goal measurement, workout note); 'retire' undoes a
 * row a change created (track, goal, autoreg rule). The row stays where it is;
 * readers skip it. Redoing the revert lifts the tombstone, once.
 *
 * Readers ask hiddenIds() once per read and exclude those ids. It is empty
 * with tracks_v1 off or before worker/schema/change-tombstone.sql is applied,
 * so every read is then exactly as before.
 */
import { pgArrayLiteral, type Sql } from './db.ts'
import type { ConnectedStore } from './store.ts'

export type TombTable =
  | 'checkin' | 'pain_report' | 'session_rpe' | 'goal_measurement' | 'workout_note'
  | 'track' | 'athlete_goal' | 'autoreg_rule'

/** Tables /api/data filters for the app (the rest are read only by the Worker). */
export const DATA_ROUTE_TOMB_TABLES = new Set<string>(['track', 'athlete_goal', 'autoreg_rule', 'goal_measurement', 'workout_note'])

async function state(sql: Sql, athleteId: string): Promise<{ ready: boolean; on: boolean }> {
  const [row] = await sql<{ ready: boolean; on: boolean | null }[]>`
    SELECT to_regclass('public.change_tombstone') IS NOT NULL AS ready,
           (to_jsonb(a) #> '{flags,tracks_v1}') = 'true'::jsonb AS on
    FROM athlete a WHERE a.id = ${athleteId}
  `
  return { ready: row?.ready === true, on: row?.on === true }
}

/** The table exists on this database (writes need it; reads also need the flag). */
export async function tombstonesReady(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`SELECT to_regclass('public.change_tombstone') IS NOT NULL AS ok`
  return row?.ok === true
}

/** Ids of this athlete's rows in `table` a live tombstone hides. Empty with the flag off. */
export async function hiddenIdsFor(sql: Sql, athleteId: string, table: TombTable): Promise<string[]> {
  const s = await state(sql, athleteId)
  if (!s.ready || !s.on) return []
  // A session RPE void names the tap it voids: a newer tap on the row revives it.
  const rows = table === 'session_rpe'
    ? await sql<{ id: string }[]>`
        SELECT x.row_id::text AS id FROM change_tombstone x
        JOIN session_rpe s ON s.id = x.row_id AND s.athlete_id = x.athlete_id AND s.change_id = x.row_change_id
        WHERE x.athlete_id = ${athleteId} AND x.row_table = 'session_rpe' AND x.lifted_at IS NULL
      `
    : await sql<{ id: string }[]>`
        SELECT row_id::text AS id FROM change_tombstone
        WHERE athlete_id = ${athleteId} AND row_table = ${table} AND lifted_at IS NULL
      `
  return rows.map((r) => r.id)
}

export const hiddenIds = (store: ConnectedStore, table: TombTable) => hiddenIdsFor(store.sql, store.athleteId, table)

/** The id list as a text[] literal for `NOT (x.id::text = ANY(…::text[]))`. */
export const idList = (ids: string[]): string => pgArrayLiteral(ids)

export interface Tombstone {
  table: TombTable
  rowId: string
  kind: 'void' | 'retire'
  /** The revert_change row writing it. */
  changeId: string
  /** The row it undoes. */
  voidsChangeId: string | null
  /** session_rpe: the tap voided. */
  rowChangeId?: string | null
}

/** One live tombstone, or false when the row already has one. */
export async function writeTombstone(store: ConnectedStore, t: Tombstone): Promise<boolean> {
  const rows = await store.sql<{ id: string }[]>`
    INSERT INTO change_tombstone (athlete_id, row_table, row_id, row_change_id, kind, change_id, voids_change_id)
    SELECT ${store.athleteId}, ${t.table}, ${t.rowId}, ${t.rowChangeId ?? null}, ${t.kind}, ${t.changeId}, ${t.voidsChangeId}
    WHERE NOT EXISTS (
      SELECT 1 FROM change_tombstone
      WHERE athlete_id = ${store.athleteId} AND row_table = ${t.table} AND row_id = ${t.rowId} AND lifted_at IS NULL
    )
    RETURNING id::text AS id
  `
  return rows.length > 0
}

export interface LiveTombstone {
  id: string
  row_table: TombTable
  row_id: string
  row_change_id: string | null
  kind: 'void' | 'retire'
}

/** The live tombstones a revert row wrote: what redoing it lifts. */
export async function tombstonesBy(store: ConnectedStore, changeId: string): Promise<LiveTombstone[]> {
  return store.sql<LiveTombstone[]>`
    SELECT id::text AS id, row_table, row_id::text AS row_id, row_change_id::text AS row_change_id, kind
    FROM change_tombstone
    WHERE athlete_id = ${store.athleteId} AND change_id = ${changeId} AND lifted_at IS NULL
    ORDER BY row_table, row_id
  `
}

/** Is this row hidden right now (whatever the flag). */
export async function isTombstoned(store: ConnectedStore, table: TombTable, rowId: string): Promise<boolean> {
  const rows = await store.sql<{ id: string }[]>`
    SELECT id::text AS id FROM change_tombstone
    WHERE athlete_id = ${store.athleteId} AND row_table = ${table} AND row_id = ${rowId} AND lifted_at IS NULL
    LIMIT 1
  `
  return rows.length > 0
}

/** Lift these tombstones (a redo). Returns how many it lifted. */
export async function liftTombstones(store: ConnectedStore, ids: string[], liftedBy: string): Promise<number> {
  if (!ids.length) return 0
  const rows = await store.sql<{ id: string }[]>`
    UPDATE change_tombstone SET lifted_at = NOW(), lifted_by = ${liftedBy}
    WHERE athlete_id = ${store.athleteId} AND lifted_at IS NULL AND id::text = ANY(${pgArrayLiteral(ids)}::text[])
    RETURNING id::text AS id
  `
  return rows.length
}
