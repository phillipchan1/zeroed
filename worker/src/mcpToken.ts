import type { Sql } from './db.ts'
import { parseRole, type CoachRole } from './coachRoles.ts'

export interface McpTokenRow {
  id: string
  athlete_id: string
  name: string
  /** D3: 'read' | 'propose'. 'propose' before worker/schema/coach-roles.sql. */
  role: CoachRole
}

const expiresColumn = new WeakMap<object, boolean>()

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time compare of hex (or any string) digests. Length mismatch still walks the longer input. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  const max = Math.max(left.length, right.length, 1)
  let diff = left.length === right.length ? 0 : 1
  for (let i = 0; i < max; i++) {
    const lc = i < left.length ? left.charCodeAt(i) : 0
    const rc = i < right.length ? right.charCodeAt(i) : 0
    diff |= lc ^ rc
  }
  return diff === 0
}

/** Bearer from Authorization, or x-zeroed-token when Authorization carries a gateway key. */
export function tokenFrom(req: Request): string {
  const dedicated = req.headers.get('x-zeroed-token')?.trim() ?? ''
  if (dedicated) return dedicated
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

async function mcpTokenHasExpiresAt(sql: Sql): Promise<boolean> {
  const cached = expiresColumn.get(sql)
  if (cached != null) return cached
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mcp_token'
        AND column_name = 'expires_at'
    ) AS exists
  `
  const exists = Boolean(row?.exists)
  expiresColumn.set(sql, exists)
  return exists
}

async function tokenExpired(sql: Sql, id: string): Promise<boolean> {
  if (!(await mcpTokenHasExpiresAt(sql))) return false
  const [row] = await sql<{ expires_at: string | Date | null }[]>`
    SELECT expires_at FROM mcp_token WHERE id = ${id} LIMIT 1
  `
  if (row?.expires_at == null) return false
  const ms = row.expires_at instanceof Date
    ? row.expires_at.getTime()
    : Date.parse(String(row.expires_at))
  return Number.isFinite(ms) && ms <= Date.now()
}

/**
 * Look up an opaque mcp_token. Hash compare is constant-time. Revoked and
 * expired rows (when `expires_at` exists — #17 copies the live table, which
 * has no expiry column, so existing tokens stay valid) are rejected.
 */
export async function resolveMcpToken(sql: Sql, token: string): Promise<McpTokenRow | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const [row] = await sql<{
    id: string
    athlete_id: string
    name: string
    token_hash: string
    revoked_at: string | Date | null
    role: string | null
  }[]>`
    SELECT t.id, t.athlete_id, t.name, t.token_hash, t.revoked_at, to_jsonb(t) ->> 'role' AS role
    FROM mcp_token t
    WHERE t.token_hash = ${tokenHash}
    LIMIT 1
  `
  if (!row) return null
  if (!timingSafeEqualHex(row.token_hash, tokenHash)) return null
  if (row.revoked_at) return null
  if (await tokenExpired(sql, row.id)) return null
  return { id: row.id, athlete_id: row.athlete_id, name: row.name, role: parseRole(row.role) }
}

export async function touchMcpToken(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE mcp_token SET last_used_at = NOW() WHERE id = ${id}
  `
}
