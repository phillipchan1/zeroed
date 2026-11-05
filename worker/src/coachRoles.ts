/**
 * Coach roles (D3, spec section 11 item 2): each coach token (mcp_token.role)
 * is 'read' or 'propose'.
 *
 *   read     only the read tools (get_*, list_*, search_*) are listed and
 *            callable. Every preview, apply and logging write is hidden from
 *            tools/list and refused here, server-side, whatever the client
 *            sends; each refusal is logged in coach_read_log.
 *   propose  exactly as before: preview, then apply with the athlete's
 *            approval. No role approves; approvals stay the athlete's.
 *
 * Only the athlete changes a role (readiness.ts setCoachRole, tracks_v1,
 * logged). app_coach has no token and is propose-equivalent. Existing tokens
 * default to 'propose', and before worker/schema/coach-roles.sql every token
 * reads as 'propose', so nothing changes until the athlete picks 'read'.
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { jsonParam } from './db.ts'
import { isReadTool } from './coachReads.ts'
import { readinessTables } from './regionStatus.ts'
import type { OverrideActor } from './sessionOverride.ts'
import type { ConnectedStore } from './store.ts'

export type CoachRole = 'read' | 'propose'

export const COACH_ROLES: readonly CoachRole[] = ['read', 'propose']

export function isCoachRole(v: unknown): v is CoachRole {
  return v === 'read' || v === 'propose'
}

/** The stored value as a role. Absent (column not there yet) is today's 'propose'; anything unrecognized fails closed to 'read'. */
export function parseRole(v: unknown): CoachRole {
  return v == null || v === 'propose' ? 'propose' : 'read'
}

/** May a coach with this role call this tool. */
export function roleAllows(role: CoachRole, tool: string): boolean {
  return role === 'propose' || isReadTool(tool)
}

/** tools/list for this role: a read coach never sees a preview, apply or write tool. */
export function toolsForRole(tools: McpTool[], role: CoachRole): McpTool[] {
  return role === 'propose' ? tools : tools.filter((t) => isReadTool(t.name))
}

/**
 * This coach's role on this athlete. Read through to_jsonb so it answers
 * 'propose' before coach-roles.sql. A token that isn't this athlete's (or is
 * gone) answers 'propose' here; the token checks elsewhere already refuse it.
 */
export async function coachRole(store: ConnectedStore, actor: OverrideActor): Promise<CoachRole> {
  if (actor.type !== 'mcp') return 'propose'
  const [row] = await store.sql<{ role: string | null }[]>`
    SELECT to_jsonb(t) ->> 'role' AS role
    FROM mcp_token t WHERE t.id::text = ${actor.id} AND t.athlete_id = ${store.athleteId}
  `
  return parseRole(row?.role)
}

export function roleRefusal(tool: string): string {
  return `Refused: this coach has read access only, and ${tool} proposes or makes a change. Nothing was written. The athlete can give you propose access in Profile → Coach access.`
}

/**
 * Log a refused call (coach_read_log, scope.refused = 'role:read'): the
 * athlete sees every attempt next to the reads. Before readiness.sql there
 * is nowhere to log it; the call is refused either way.
 */
export async function logRoleRefusal(store: ConnectedStore, actor: OverrideActor, tool: string): Promise<void> {
  if (actor.type !== 'mcp') return
  if (!(await readinessTables(store))) {
    console.warn('[mcp] refused by role (not logged: no coach_read_log)', tool)
    return
  }
  await store.sql`
    INSERT INTO coach_read_log (athlete_id, actor_type, actor_id, tool, scope)
    VALUES (${store.athleteId}, 'mcp', ${actor.id}, ${tool.slice(0, 120)}, ${jsonParam(store.sql, { refused: 'role:read' })})
  `
}

/**
 * The server-side gate, before any tool runs: null to go ahead, or the
 * refusal text (already logged). Read tools never query the role.
 */
export async function refuseByRole(store: ConnectedStore, actor: OverrideActor, tool: string): Promise<string | null> {
  if (actor.type !== 'mcp' || isReadTool(tool)) return null
  if (roleAllows(await coachRole(store, actor), tool)) return null
  await logRoleRefusal(store, actor, tool)
  return roleRefusal(tool)
}
