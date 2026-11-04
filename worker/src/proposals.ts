/**
 * Coach proposals: a previewed change parked for the athlete to accept on their
 * phone. Claude (through MCP) previews with propose=true; the app lists the
 * pending ones and its Accept applies exactly the stored edits, through the
 * same applyEdits path apply_program_edits uses. A proposal remembers a
 * fingerprint of the program it was previewed against and refuses to apply
 * if the program changed since (it goes 'stale' instead).
 *
 * The table is hand-applied on Neon (worker/schema/coach-proposal.sql). Until
 * it exists, every function here reports proposals as unavailable instead of
 * failing the call.
 */
import { applyEditsToDraft, diffDraft } from '../../supabase/functions/_shared/engine/programDraft.ts'
import { previewId } from '../../src/engine/mcpStamp.ts'
import { applyEdits, liveToDraft, revisionPayload, toProgramEdit, type EditInput } from './edits.ts'
import { beginAuthCors, json } from './cors.ts'
import { jsonParam, withSql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { loadLiveProgram, makeStore, type ConnectedStore, type LiveProgram } from './store.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ProposalRow {
  id: string
  preview_id: string
  title: string
  rationale: string | null
  goal_ids: string[]
  edits: EditInput[]
  timing: 'now' | 'next_week'
  request: string | null
  diff: unknown
  program_fingerprint: string
  status: 'pending' | 'applied' | 'declined' | 'stale'
  created_at: string
}

function missingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01'
}

/** What the live program looks like, as a hash. Any edit to the week changes it. */
export async function programFingerprint(live: LiveProgram): Promise<string> {
  return previewId(liveToDraft(live))
}

/** Goal ids or names → the athlete's goal ids. Unknown names are dropped. */
export async function resolveGoalIds(store: ConnectedStore, refs: unknown): Promise<string[]> {
  const list = Array.isArray(refs) ? refs.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []
  if (!list.length) return []
  const rows = await store.sql<{ id: string; name: string }[]>`
    SELECT id, name FROM athlete_goal WHERE athlete_id = ${store.athleteId}
  `
  const out: string[] = []
  for (const ref of list) {
    const want = ref.trim().toLowerCase()
    const hit = rows.find((r) => r.id === ref) ?? rows.find((r) => r.name.toLowerCase() === want)
      ?? rows.find((r) => r.name.toLowerCase().includes(want))
    if (hit && !out.includes(hit.id)) out.push(hit.id)
  }
  return out
}

export type ParkResult =
  | { ok: true; id: string; previewId: string; reused: boolean }
  | { ok: false; reason: 'unavailable' | 'nothing_to_change' }

export async function parkProposal(
  store: ConnectedStore,
  live: LiveProgram,
  inputs: EditInput[],
  opts: { title: string; rationale: string | null; goalIds: string[]; timing: 'now' | 'next_week'; request: string | null },
): Promise<ParkResult> {
  const base = liveToDraft(live)
  const { draft } = applyEditsToDraft(base, inputs.map(toProgramEdit))
  const diff = diffDraft(base, draft)
  if (!diff.dirty) return { ok: false, reason: 'nothing_to_change' }
  const id = await previewId({ edits: inputs, timing: opts.timing })
  const fingerprint = await programFingerprint(live)
  try {
    const [existing] = await store.sql<{ id: string }[]>`
      SELECT id FROM coach_proposal
      WHERE athlete_id = ${store.athleteId} AND preview_id = ${id} AND status = 'pending'
      LIMIT 1
    `
    if (existing) return { ok: true, id: existing.id, previewId: id, reused: true }
    const [row] = await store.sql<{ id: string }[]>`
      INSERT INTO coach_proposal (
        athlete_id, preview_id, title, rationale, goal_ids, edits, timing, request, diff, program_fingerprint, source
      ) VALUES (
        ${store.athleteId}, ${id}, ${opts.title}, ${opts.rationale}, ${jsonParam(store.sql, opts.goalIds)},
        ${jsonParam(store.sql, inputs)}, ${opts.timing}, ${opts.request},
        ${jsonParam(store.sql, revisionPayload(base.sessions, diff))}, ${fingerprint}, 'mcp'
      )
      RETURNING id
    `
    return { ok: true, id: row.id, previewId: id, reused: false }
  } catch (e) {
    if (missingTable(e)) return { ok: false, reason: 'unavailable' }
    throw e
  }
}

export async function listProposals(store: ConnectedStore, status: ProposalRow['status'] = 'pending'): Promise<ProposalRow[] | null> {
  try {
    return await store.sql<ProposalRow[]>`
      SELECT id, preview_id, title, rationale, goal_ids, edits, timing, request, diff, program_fingerprint, status,
             to_json(created_at) #>> '{}' AS created_at
      FROM coach_proposal
      WHERE athlete_id = ${store.athleteId} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT 20
    `
  } catch (e) {
    if (missingTable(e)) return null
    throw e
  }
}

export type ResolveResult =
  | { ok: true; status: 'applied' | 'declined'; text: string }
  | { ok: false; status: 'stale' | 'not_found' | 'unavailable' | 'refused'; text: string }

/**
 * Apply a pending proposal exactly as previewed. The athlete's Accept and an
 * MCP apply_program_edits(proposal_id) both land here.
 */
export async function acceptProposal(store: ConnectedStore, proposalId: string): Promise<ResolveResult> {
  if (!UUID_RE.test(proposalId)) return { ok: false, status: 'not_found', text: 'No such proposal.' }
  let rows: ProposalRow[]
  try {
    rows = await store.sql<ProposalRow[]>`
      SELECT id, preview_id, title, rationale, goal_ids, edits, timing, request, diff, program_fingerprint, status,
             to_json(created_at) #>> '{}' AS created_at
      FROM coach_proposal
      WHERE id = ${proposalId} AND athlete_id = ${store.athleteId}
      LIMIT 1
    `
  } catch (e) {
    if (missingTable(e)) return { ok: false, status: 'unavailable', text: 'Proposals are not set up on this database yet.' }
    throw e
  }
  const p = rows[0]
  if (!p) return { ok: false, status: 'not_found', text: 'No such proposal.' }
  if (p.status !== 'pending') {
    return { ok: false, status: p.status === 'stale' ? 'stale' : 'refused', text: `This proposal was already ${p.status}.` }
  }
  const live = await loadLiveProgram(store)
  if (!live) return { ok: false, status: 'refused', text: 'No active program to change.' }
  if (await programFingerprint(live) !== p.program_fingerprint) {
    await store.sql`
      UPDATE coach_proposal SET status = 'stale', resolved_at = NOW()
      WHERE id = ${p.id} AND athlete_id = ${store.athleteId}
    `
    return {
      ok: false,
      status: 'stale',
      text: 'The program changed after this was proposed, so it was not applied. Ask the coach to look again.',
    }
  }
  const text = await applyEdits(store, p.edits, { confirm: true, timing: p.timing, request: p.request ?? undefined })
  if (/^Refused|^No active/.test(text)) return { ok: false, status: 'refused', text }
  await store.sql`
    UPDATE coach_proposal SET status = 'applied', resolved_at = NOW()
    WHERE id = ${p.id} AND athlete_id = ${store.athleteId}
  `
  // The move, pinned to the goal it serves so the goal page shows it.
  const goalId = (Array.isArray(p.goal_ids) ? p.goal_ids : []).find((g) => UUID_RE.test(g)) ?? null
  const body = p.rationale ? `Accepted: ${p.title} Why: ${p.rationale}` : `Accepted: ${p.title}`
  await store.sql`
    INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
    VALUES (${store.athleteId}, 'coach', 'note', ${body}, ${goalId})
  `
  return { ok: true, status: 'applied', text }
}

export async function declineProposal(store: ConnectedStore, proposalId: string): Promise<ResolveResult> {
  if (!UUID_RE.test(proposalId)) return { ok: false, status: 'not_found', text: 'No such proposal.' }
  try {
    const rows = await store.sql<{ id: string }[]>`
      UPDATE coach_proposal SET status = 'declined', resolved_at = NOW()
      WHERE id = ${proposalId} AND athlete_id = ${store.athleteId} AND status = 'pending'
      RETURNING id
    `
    if (!rows.length) return { ok: false, status: 'not_found', text: 'No pending proposal with that id.' }
    return { ok: true, status: 'declined', text: 'Declined. Nothing changed.' }
  } catch (e) {
    if (missingTable(e)) return { ok: false, status: 'unavailable', text: 'Proposals are not set up on this database yet.' }
    throw e
  }
}

/**
 * POST /api/proposals — the app's side. Session auth, same as /api/session-rx.
 *   { action: 'list' }                 → { proposals } (null when the table is missing)
 *   { action: 'accept', id }           → ResolveResult
 *   { action: 'decline', id }          → ResolveResult
 */
export async function handleProposals(req: Request, env: Env, _waitUntil?: WaitUntil): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)

  let body: { action?: unknown; id?: unknown }
  try {
    body = await req.json() as { action?: unknown; id?: unknown }
  } catch {
    return json({ error: 'invalid json' }, 400, cors)
  }

  try {
    return await withSql(env, async (sql) => {
      const user = await sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET)
      if (!user) return json({ error: 'unauthorized' }, 401, cors)
      const athleteId = await resolveAthleteId(sql, user.id)
      if (!athleteId) return json({ error: 'unauthorized' }, 401, cors)
      const store = makeStore(sql, athleteId, 'lb')
      const id = typeof body.id === 'string' ? body.id : ''
      switch (body.action) {
        case 'list':
          return json({ proposals: await listProposals(store) }, 200, cors)
        case 'accept':
          return json(await acceptProposal(store, id), 200, cors)
        case 'decline':
          return json(await declineProposal(store, id), 200, cors)
        default:
          return json({ error: 'unknown action' }, 400, cors)
      }
    })
  } catch {
    return json({ error: 'proposal request failed' }, 500, cors)
  }
}
