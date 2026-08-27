// Opaque mcp_token bearer auth. Raw token never stored — sha256 hex + last four.
import { admin } from './admin.ts'

export interface McpTokenRow {
  id: string
  athlete_id: string
  name: string
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Bearer from Authorization, or x-zeroed-token when Authorization carries the gateway anon key. */
export function tokenFrom(req: Request): string {
  const dedicated = req.headers.get('x-zeroed-token')?.trim() ?? ''
  if (dedicated) return dedicated
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

export async function resolveMcpToken(token: string): Promise<McpTokenRow | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const { data } = await admin
    .from('mcp_token')
    .select('id, athlete_id, name')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle<McpTokenRow>()
  return data ?? null
}

export const touchMcpToken = (id: string) =>
  admin.from('mcp_token').update({ last_used_at: new Date().toISOString() }).eq('id', id)
