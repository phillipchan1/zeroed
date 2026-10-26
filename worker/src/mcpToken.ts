import type { Sql } from './db.ts'

export interface McpTokenRow {
  id: string
  athlete_id: string
  name: string
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Bearer from Authorization, or x-zeroed-token when Authorization carries a gateway key. */
export function tokenFrom(req: Request): string {
  const dedicated = req.headers.get('x-zeroed-token')?.trim() ?? ''
  if (dedicated) return dedicated
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

export async function resolveMcpToken(sql: Sql, token: string): Promise<McpTokenRow | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const [row] = await sql<McpTokenRow[]>`
    SELECT id, athlete_id, name
    FROM mcp_token
    WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL
    LIMIT 1
  `
  return row ?? null
}

export async function touchMcpToken(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE mcp_token SET last_used_at = NOW() WHERE id = ${id}
  `
}
