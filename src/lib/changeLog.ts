/* The Changes feed, the app's side (tracks_v1).
 *
 * Every write a coach or the athlete makes is recorded by the Worker in
 * change_log: who, what, why, and what the athlete approved. The Worker
 * writes the one-line summary; this only fetches and displays it, and sends
 * the athlete's Undo tap. With the flag off the route answers 404 and every
 * reader here degrades to "nothing to show".
 */
import { changeLogUrl } from './api'
import { getAccessToken } from './authClient'

export interface ChangeItem {
  id: string
  created_at: string
  actor_type: 'athlete' | 'mcp' | 'app_coach' | 'system'
  /** You / Claude / Coach / System, or the name given to a connected coach. */
  who: string
  tool: string
  summary: string
  rationale: string | null
  rule_refs: string[]
  reverted_by: string | null
  revert_of: string | null
  revertible: boolean
  /** What the tap does: undo the change, or redo one an undo took back. */
  revert_action?: 'undo' | 'redo' | null
  revert_suggested: boolean
}

/** A newer change to the same thing, which has to be undone first. */
export interface RevertConflict {
  id: string
  at: string
  who: string
  summary: string
}

export interface UndoPreview {
  ok: boolean
  preview_id?: string
  direction?: 'undo' | 'redo'
  text: string
  conflicts?: RevertConflict[]
  /** G5: a red-flag refusal, structured (read with warningsView). */
  warnings?: unknown
}

export interface UndoResult {
  ok: boolean
  reason?: string
  text: string
  warnings?: unknown
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const url = changeLogUrl()
  if (!url) throw new Error('change log unavailable')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`change log ${res.status}`)
  return parsed
}

/** The latest changes, newest first. Empty on any failure. */
export async function fetchChanges(): Promise<ChangeItem[]> {
  if (!changeLogUrl()) return []
  try {
    const out = await post({ action: 'list', limit: 30 }) as { changes?: ChangeItem[] | null }
    return Array.isArray(out?.changes) ? out.changes : []
  } catch {
    return []
  }
}

/** What Undo (or Redo) would do, or the newer change that stops it. Writes nothing. */
export async function previewUndo(id: string): Promise<UndoPreview> {
  try {
    const out = await post({ action: 'preview_revert', id }) as Partial<UndoPreview> & { conflicts?: RevertConflict[] }
    return {
      ok: out?.ok === true,
      preview_id: typeof out?.preview_id === 'string' ? out.preview_id : undefined,
      direction: out?.direction === 'redo' ? 'redo' : 'undo',
      text: String(out?.text ?? ''),
      conflicts: Array.isArray(out?.conflicts) ? out.conflicts : [],
      ...(Array.isArray(out?.warnings) ? { warnings: out.warnings } : {}),
    }
  } catch {
    return { ok: false, text: 'Couldn’t reach the server. Nothing changed; try again when you’re online.' }
  }
}

/**
 * The athlete's Undo. The tap is the approval; with the preview they saw, the
 * Worker applies exactly that or asks to preview again.
 */
export async function undoChange(id: string, previewId?: string): Promise<UndoResult> {
  try {
    const out = await post({ action: 'revert', id, ...(previewId ? { preview_id: previewId } : {}) }) as Partial<UndoResult>
    return { ok: out?.ok === true, reason: out?.reason, text: String(out?.text ?? ''), ...(Array.isArray(out?.warnings) ? { warnings: out.warnings } : {}) }
  } catch {
    return { ok: false, reason: 'error', text: 'Couldn’t reach the server. Nothing changed; try again when you’re online.' }
  }
}

/** "Today 14:02", "Yesterday 09:10", or "3 Nov". */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
