/* Coach proposals, the app's side: list what's waiting, accept, decline.
 *
 * Claude parks a previewed change with preview_program_edits(propose=true);
 * the Worker keeps it with a fingerprint of the program it was previewed
 * against. Accepting here applies exactly that change, or refuses (stale) if
 * the program moved since. Everything degrades to "nothing waiting" when the
 * Worker route or the table isn't there yet, so an older backend reads as an
 * empty list rather than an error.
 */
import { proposalsUrl } from './api'
import { getAccessToken } from './authClient'

export interface ProposalChange {
  kind: 'added' | 'removed' | 'changed' | 'kept'
  name: string
  before?: string
  after?: string
}

export interface CoachProposal {
  id: string
  title: string
  rationale: string | null
  goal_ids: string[]
  timing: 'now' | 'next_week'
  /** warnings (tracks_v1, G5): what the engine's validators said about the preview; read with proposalWarnings. */
  diff: { sessions?: Array<{ name: string; changes: ProposalChange[] }>; warnings?: unknown } | null
  status: 'pending' | 'applied' | 'declined' | 'stale'
  created_at: string
  /** tracks_v1: a week-only session override rather than a program edit. */
  kind?: 'session_override'
}

export interface ProposalResult {
  ok: boolean
  status: string
  text: string
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const url = proposalsUrl()
  if (!url) throw new Error('proposals unavailable')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`proposals ${res.status}`)
  return parsed
}

/** Pending proposals, newest first. Empty when the backend can't hold them yet. */
export async function fetchProposals(): Promise<CoachProposal[]> {
  if (!proposalsUrl()) return []
  try {
    const out = await post({ action: 'list' }) as { proposals?: CoachProposal[] | null }
    return Array.isArray(out?.proposals) ? out.proposals : []
  } catch {
    return []
  }
}

export async function resolveProposal(id: string, action: 'accept' | 'decline'): Promise<ProposalResult> {
  try {
    const out = await post({ action, id }) as Partial<ProposalResult>
    return { ok: out?.ok === true, status: String(out?.status ?? 'error'), text: String(out?.text ?? '') }
  } catch {
    return { ok: false, status: 'error', text: 'Couldn’t reach the coach. Nothing changed; try again when you’re online.' }
  }
}
