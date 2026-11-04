/**
 * Coach-read logging (spec section 8, D3; tracks_v1): every read a coach makes
 * of this athlete's data — an MCP read tool call, or an app_coach read — adds
 * one row to coach_read_log (actor, tool, scope). A separate append-only
 * table, so change_log stays a record of writes. The athlete's own reads are
 * never logged. The athlete sees the list under Profile → Coach access.
 *
 * The row is written before the read runs, and the read refuses if it can't
 * be: a coach read that isn't logged doesn't happen.
 */
import { asJson, jsonParam } from './db.ts'
import { readinessTables } from './regionStatus.ts'
import type { OverrideActor } from './sessionOverride.ts'
import type { ConnectedStore } from './store.ts'
import { actorLabel } from './changeSummary.ts'
import { McpUserError } from './userError.ts'

export const coachReadsUnavailable = 'Coach-read logging is not set up on this database yet, and every coach read must be logged. Nothing was read.'

/** get_*, list_* and search_* tools read athlete data. Writes and previews are logged elsewhere. */
export function isReadTool(name: string): boolean {
  return /^(get|list|search)_/.test(name)
}

/** Whose reads are logged: coaches. Never the athlete, never system. */
export function logsReads(actor: OverrideActor): actor is OverrideActor & { type: 'mcp' | 'app_coach' } {
  return actor.type === 'mcp' || actor.type === 'app_coach'
}

/** The call's arguments, as its scope: scalars only, clipped. */
function scopeOf(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args).slice(0, 12)) {
    if (typeof v === 'string') out[k] = v.slice(0, 120)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
  }
  return out
}

export async function logCoachRead(store: ConnectedStore, actor: OverrideActor, tool: string, args: Record<string, unknown>): Promise<void> {
  if (!logsReads(actor)) return
  if (!(await readinessTables(store))) throw new McpUserError(coachReadsUnavailable)
  await store.sql`
    INSERT INTO coach_read_log (athlete_id, actor_type, actor_id, tool, scope)
    VALUES (${store.athleteId}, ${actor.type}, ${actor.id}, ${tool}, ${jsonParam(store.sql, scopeOf(args))})
  `
}

export interface CoachReadView {
  id: string
  created_at: string
  actor_type: 'mcp' | 'app_coach'
  actor_id: string
  /** The name the athlete gave the coach, or Coach for the in-app coach. */
  who: string
  tool: string
  scope: Record<string, unknown>
}

/** This athlete's coach reads, newest first. Empty before readiness.sql. */
export async function listCoachReads(store: ConnectedStore, limit = 50): Promise<CoachReadView[]> {
  if (!(await readinessTables(store))) return []
  const rows = await store.sql<{
    id: string; created_at: string; actor_type: 'mcp' | 'app_coach'; actor_id: string; token_name: string | null; tool: string; scope: unknown
  }[]>`
    SELECT r.id::text AS id, to_json(r.created_at) #>> '{}' AS created_at, r.actor_type, r.actor_id,
           t.name AS token_name, r.tool, r.scope
    FROM coach_read_log r
    LEFT JOIN mcp_token t ON r.actor_type = 'mcp' AND t.athlete_id = r.athlete_id AND t.id::text = r.actor_id
    WHERE r.athlete_id = ${store.athleteId}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${Math.max(1, Math.min(200, Math.round(limit)))}
  `
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    who: actorLabel(r.actor_type, r.token_name),
    tool: r.tool,
    scope: asJson<Record<string, unknown>>(r.scope, {}),
  }))
}
