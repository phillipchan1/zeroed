/* Approvals, the app's side (tracks_v1, G10).
 *
 * Only the athlete's own session can approve a change. The Worker creates the
 * approval row (bound to one preview and a hash of the diff shown) and hands
 * back its approval_ref; a coach can then apply that preview with it, once.
 * Pass messageId when the yes came in the coach chat: the Worker checks the
 * message is the athlete's own, written after the preview. Proposal cards
 * don't need this: their Approve approves and applies in one request
 * (/api/proposals accept). With the flag off the route answers 404 and this
 * reports "not approved".
 */
import { approvalsUrl } from './api'
import { getAccessToken } from './authClient'

export interface ApprovalResult {
  ok: boolean
  approval_ref?: string
  reason?: string
  text?: string
}

export async function approvePreview(previewId: string, messageId?: string): Promise<ApprovalResult> {
  const url = approvalsUrl()
  if (!url) return { ok: false, reason: 'unavailable', text: 'Approvals aren’t available here.' }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ action: 'approve', preview_id: previewId, ...(messageId ? { message_id: messageId } : {}) }),
    })
    const out = await res.json().catch(() => null) as ApprovalResult | null
    if (!res.ok || !out) return { ok: false, reason: 'error', text: 'Couldn’t record your approval. Nothing changed.' }
    return out
  } catch {
    return { ok: false, reason: 'offline', text: 'Couldn’t reach the coach. Nothing changed; try again when you’re online.' }
  }
}
