/**
 * Readiness reads (G4, tracks_v1): check-ins, pain reports and region status
 * rows, athlete-scoped. Only db and store imports, so the session-rx path,
 * the preview validators and readiness.ts can all use it without a cycle.
 *
 * Before worker/schema/readiness.sql is applied every read here is empty
 * ("no check-ins, nothing blocked"), so prescriptions run as before.
 */
import { mcpStamp } from '../../src/engine/mcpStamp.ts'
import { asJson } from './db.ts'
import { calendarZone, type ConnectedStore } from './store.ts'
import { hiddenIds, idList } from './tombstones.ts'
import type { OverrideActor } from './sessionOverride.ts'
import { isPainRegion, isRedFlag, type CheckinDay, type PainEntry, type RegionState } from './readiness/rules.ts'

/** True once worker/schema/readiness.sql is on this database. Checked, not caught (callers run in transactions). */
export async function readinessTables(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT to_regclass('public.checkin') IS NOT NULL
       AND to_regclass('public.pain_report') IS NOT NULL
       AND to_regclass('public.region_status') IS NOT NULL
       AND to_regclass('public.coach_read_log') IS NOT NULL AS ok
  `
  return row?.ok === true
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

export interface CheckinRow extends CheckinDay {
  id: string
  created_at: string
}

/** The latest check-in per date in [from, to], oldest date first. */
export async function loadCheckins(store: ConnectedStore, from: string, to: string): Promise<CheckinRow[]> {
  if (!(await readinessTables(store))) return []
  // A check-in the athlete undid (tracks_v1) is voided, not deleted: the one before it stands.
  const voided = await hiddenIds(store, 'checkin')
  const rows = await store.sql<{ id: string; date: string; sleep_hours: unknown; stress: unknown; soreness: unknown; created_at: string }[]>`
    SELECT DISTINCT ON (c.date) c.id::text AS id, c.date::text AS date, c.sleep_hours, c.stress, c.soreness,
           to_json(c.created_at) #>> '{}' AS created_at
    FROM checkin c
    WHERE c.athlete_id = ${store.athleteId} AND c.date >= ${from}::date AND c.date <= ${to}::date
      AND NOT (c.id::text = ANY(${idList(voided)}::text[]))
    ORDER BY c.date, c.created_at DESC, c.id DESC
  `
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    sleep_hours: num(r.sleep_hours),
    stress: num(r.stress),
    soreness: num(r.soreness),
    created_at: r.created_at,
  }))
}

export interface PainRow extends PainEntry {
  id: string
  created_at: string
}

/** The latest pain report per (date, region) in [from, to], oldest date first. */
export async function loadPain(store: ConnectedStore, from: string, to: string): Promise<PainRow[]> {
  if (!(await readinessTables(store))) return []
  // Voided with an undone check-in. A block it set stays in region_status until the clinician clear.
  const voided = await hiddenIds(store, 'pain_report')
  const rows = await store.sql<{ id: string; date: string; region: string; score: unknown; red_flags: unknown; created_at: string }[]>`
    SELECT DISTINCT ON (p.date, p.region) p.id::text AS id, p.date::text AS date, p.region, p.score,
           to_jsonb(p.red_flags) AS red_flags, to_json(p.created_at) #>> '{}' AS created_at
    FROM pain_report p
    WHERE p.athlete_id = ${store.athleteId} AND p.date >= ${from}::date AND p.date <= ${to}::date
      AND NOT (p.id::text = ANY(${idList(voided)}::text[]))
    ORDER BY p.date, p.region, p.created_at DESC, p.id DESC
  `
  return rows.flatMap((r) => {
    if (!isPainRegion(r.region)) return []
    return [{
      id: r.id,
      date: r.date,
      region: r.region,
      score: Number(r.score),
      red_flags: asJson<unknown[]>(r.red_flags, []).filter(isRedFlag),
      created_at: r.created_at,
    }]
  })
}

export interface RegionStatusRow {
  id: string
  region: string
  status: RegionState
  reason: string | null
  rule_refs: string[]
  created_at: string
  cleared_at: string | null
  cleared_by: string | null
}

/** Each region's latest status row. */
export async function loadRegionStatus(store: ConnectedStore): Promise<RegionStatusRow[]> {
  if (!(await readinessTables(store))) return []
  const rows = await store.sql<{
    id: string; region: string; status: RegionState; reason: string | null; rule_refs: unknown
    created_at: string; cleared_at: string | null; cleared_by: string | null
  }[]>`
    SELECT DISTINCT ON (s.region) s.id::text AS id, s.region, s.status, s.reason, s.rule_refs,
           to_json(s.created_at) #>> '{}' AS created_at, to_json(s.cleared_at) #>> '{}' AS cleared_at, s.cleared_by
    FROM region_status s
    WHERE s.athlete_id = ${store.athleteId}
    ORDER BY s.region, s.created_at DESC, s.id DESC
  `
  return rows.map((r) => ({ ...r, rule_refs: asJson<string[]>(r.rule_refs, ['U7']) }))
}

/** True while this row blocks its region: blocked and not yet cleared by the athlete. */
export function blocksNow(row: Pick<RegionStatusRow, 'status' | 'cleared_at'> | undefined): boolean {
  return row?.status === 'blocked' && row.cleared_at == null
}

/** Regions blocked at any point in [from, to] (dates): set by then, not cleared before it began. */
export async function blockedDuring(store: ConnectedStore, from: string, to: string): Promise<string[]> {
  if (!(await readinessTables(store))) return []
  const rows = await store.sql<{ region: string }[]>`
    SELECT DISTINCT s.region FROM region_status s
    WHERE s.athlete_id = ${store.athleteId} AND s.status = 'blocked'
      AND s.created_at < (${to}::date + 1)
      AND (s.cleared_at IS NULL OR s.cleared_at >= ${from}::date)
    ORDER BY s.region
  `
  return rows.map((r) => r.region)
}

/**
 * The athlete's local dates with a logged workout in [from, to], sorted. A
 * temporary U7 block (v1.2) lapses once a session has been logged after the
 * day it was set.
 */
export async function workoutDates(store: ConnectedStore, from: string, to: string): Promise<string[]> {
  const [tz] = await store.sql<{ time_zone: string | null }[]>`SELECT time_zone FROM athlete WHERE id = ${store.athleteId}`
  const zone = calendarZone(tz?.time_zone)
  const rows = await store.sql<{ performed_at: string }[]>`
    SELECT to_json(w.performed_at) #>> '{}' AS performed_at
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId}
      AND w.performed_at >= (${from}::date - 1) AND w.performed_at < (${to}::date + 2)
  `
  const dates = rows.map((r) => mcpStamp(new Date(r.performed_at), zone).local_date).filter((d) => d >= from && d <= to)
  return [...new Set(dates)].sort()
}

/** Regions with an open block (U7), sorted. Empty before readiness.sql. */
export async function statusBlockedRegions(store: ConnectedStore): Promise<string[]> {
  return (await loadRegionStatus(store)).filter(blocksNow).map((r) => r.region).sort()
}

// ---- health-data visibility (D3) ----------------------------------------------------------

/**
 * Whether this actor sees pain and check-in data. The athlete and the in-app
 * coach do; an MCP coach only while its toggle is on (default on); nobody else.
 */
export async function seesHealth(store: ConnectedStore, actor: OverrideActor): Promise<boolean> {
  if ((actor.type === 'athlete' && actor.id === store.athleteId) || actor.type === 'app_coach') return true
  if (actor.type !== 'mcp') return false
  const [row] = await store.sql<{ on: boolean | null }[]>`
    SELECT COALESCE((to_jsonb(t) ->> 'share_health')::boolean, true) AS on
    FROM mcp_token t WHERE t.id::text = ${actor.id} AND t.athlete_id = ${store.athleteId}
  `
  return row?.on === true
}

/** Session observations that are health data: the debrief's pain signal (D3). */
export function isHealthObservation(category: string): boolean {
  return /pain/i.test(category)
}

const HIDDEN_INPUT = 'a health input the athlete hasn\'t shared with you'

/**
 * Lift-model text with its health readings taken out (D3): knee pain scores,
 * pain flags, sleep hours and readiness scores, each with its date. The loads
 * they moved stay; only the inputs go.
 */
export function redactHealthText(text: string): string {
  const day = '(?: on [A-Z][a-z]{2} \\d{1,2})?'
  return text
    .replace(new RegExp(`knee pain \\d+(?:\\.\\d+)?/10${day}`, 'g'), HIDDEN_INPUT)
    .replace(new RegExp(`pain flag${day}`, 'g'), HIDDEN_INPUT)
    .replace(/\d+(?:\.\d+)?h sleep/g, HIDDEN_INPUT)
    .replace(/readiness \d+(?:\.\d+)?\/10/g, HIDDEN_INPUT)
}
