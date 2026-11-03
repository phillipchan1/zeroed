/**
 * MCP write-preview helpers. Every new write tool uses these so the
 * confirm / client_key / timestamp contract stays one place.
 */

export interface McpStamp {
  utc: string
  local: string
  local_date: string
}

export function mcpStamp(at: Date = new Date(), timeZone = 'America/Los_Angeles'): McpStamp {
  const utc = at.toISOString()
  let local_date = utc.slice(0, 10)
  let local = utc
  try {
    const datePart = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at)
    const timePart = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(at)
    local_date = datePart
    local = `${datePart}T${timePart}`
  } catch { /* invalid zone — keep UTC */ }
  return { utc, local, local_date }
}

export async function previewId(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle) {
    const buf = await subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
  }
  let hash = 0
  for (let i = 0; i < json.length; i++) hash = ((hash << 5) - hash + json.charCodeAt(i)) | 0
  return `preview${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export async function writePreview(
  diff: unknown[],
  warnings: string[] = [],
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    ...mcpStamp(),
    diff,
    warnings,
    preview_id: await previewId({ diff, warnings, extra }),
    ...extra,
  }
}
