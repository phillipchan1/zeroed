import type { Sql } from './db.ts'

const PROBE_MAX = 5
const PROBE_WINDOW_SECS = 3600

/**
 * App-side replacement for `check_probe_quota()`. Same contract: at most
 * PROBE_MAX probes per device or IP per window. Fails open if the table is
 * missing so a fresh Neon restore still lets the app function.
 */
export async function checkProbeQuota(
  sql: Sql,
  deviceId: string | null,
  ip: string | null,
): Promise<boolean> {
  try {
    await sql`DELETE FROM probe_throttle WHERE created_at < NOW() - INTERVAL '24 hours'`
    const recent = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n
      FROM probe_throttle
      WHERE created_at >= NOW() - ${PROBE_WINDOW_SECS} * INTERVAL '1 second'
        AND (
          (${deviceId}::text IS NOT NULL AND device_id = ${deviceId})
          OR (${ip}::text IS NOT NULL AND ip = ${ip})
        )
    `
    const count = Number(recent[0]?.n ?? 0)
    if (count >= PROBE_MAX) return false
    await sql`INSERT INTO probe_throttle (device_id, ip) VALUES (${deviceId}, ${ip})`
    return true
  } catch (err) {
    console.error('[quota] check_probe_quota failed', err)
    return true
  }
}
