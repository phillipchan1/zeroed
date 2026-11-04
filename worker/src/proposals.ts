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
import { APP_COACH, applyPreview, PREVIEW_TTL_HOURS, tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { phaseRoutineSnapshots, routineDelta, withTx, writeChange } from './changeLog.ts'
import { ApprovalSpent, checkApproval, consumeApproval, createApproval, proposalApprovalState } from './approvals.ts'

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
  /** Present only on a week-only session override (tracks_v1). */
  kind?: 'session_override'
}

// kind is read through to_jsonb so these queries work before the column
// exists, and listed only when it isn't the default: program-edit proposals
// read back exactly as they did before overrides.
function withKind(rows: Array<ProposalRow & { kind?: string | null }>): ProposalRow[] {
  return rows.map(({ kind, ...r }) => kind === 'session_override' ? { ...r, kind } : r)
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
    return withKind(await store.sql<ProposalRow[]>`
      SELECT id, preview_id, title, rationale, goal_ids, edits, timing, request, diff, program_fingerprint, status,
             to_json(created_at) #>> '{}' AS created_at, to_jsonb(cp) ->> 'kind' AS kind
      FROM coach_proposal cp
      WHERE athlete_id = ${store.athleteId} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT 20
    `)
  } catch (e) {
    if (missingTable(e)) return null
    throw e
  }
}

/** applyEdits answers in prose; these openings mean nothing was written. */
export function appliedOk(text: string): boolean {
  return !/^(Refused|No active|Write failed|Nothing to write)/.test(text)
}

export type ResolveResult =
  | { ok: true; status: 'applied' | 'declined'; text: string }
  | { ok: false; status: 'stale' | 'not_found' | 'unavailable' | 'refused'; text: string }

/**
 * Apply a pending proposal exactly as previewed. The athlete's Accept and an
 * MCP apply_program_edits(proposal_id) both land here. A week-only override
 * proposal applies only with the athlete's own tap (opts.approvalRef, minted
 * by /api/proposals); a coach can't accept one on their behalf.
 *
 * With tracks_v1 on (G2) a program-edit proposal also needs an approval_ref,
 * must be under 24 h old like any preview, and its write is logged in
 * change_log in the same transaction. Since G10 the ref must resolve to an
 * approval row the athlete made for this proposal (their Accept tap, or their
 * yes in the coach chat), which the write consumes. opts.actor is the coach
 * applying it over MCP; an app Accept records the proposal's author.
 */
export async function acceptProposal(
  store: ConnectedStore,
  proposalId: string,
  opts: { approvalRef?: string; actor?: OverrideActor } = {},
): Promise<ResolveResult> {
  if (!UUID_RE.test(proposalId)) return { ok: false, status: 'not_found', text: 'No such proposal.' }
  let rows: ProposalRow[]
  try {
    rows = withKind(await store.sql<ProposalRow[]>`
      SELECT id, preview_id, title, rationale, goal_ids, edits, timing, request, diff, program_fingerprint, status,
             to_json(created_at) #>> '{}' AS created_at, to_jsonb(cp) ->> 'kind' AS kind
      FROM coach_proposal cp
      WHERE id = ${proposalId} AND athlete_id = ${store.athleteId}
      LIMIT 1
    `)
  } catch (e) {
    if (missingTable(e)) return { ok: false, status: 'unavailable', text: 'Proposals are not set up on this database yet.' }
    throw e
  }
  const p = rows[0]
  if (!p) return { ok: false, status: 'not_found', text: 'No such proposal.' }
  if (p.status !== 'pending') {
    return { ok: false, status: p.status === 'stale' ? 'stale' : 'refused', text: `This proposal was already ${p.status}.` }
  }
  if (p.kind === 'session_override') {
    // Parked for the athlete: only their Accept applies it (G1).
    if (opts.actor && await tracksV1On(store)) {
      return { ok: false, status: 'refused', text: 'Refused: this week-only change is parked for the athlete; they accept it in the app.' }
    }
    return acceptOverrideProposal(store, p, opts.approvalRef)
  }
  const logged = await tracksV1On(store)
  let author: OverrideActor = opts.actor ?? APP_COACH
  if (logged) {
    if (!opts.approvalRef) {
      return { ok: false, status: 'refused', text: 'Refused: approval_ref is required (msg:<id> of the message where the athlete said yes), or the athlete accepts it in the app.' }
    }
    const [meta] = await store.sql<{ fresh: boolean; source: string }[]>`
      SELECT (created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)) AS fresh, source
      FROM coach_proposal WHERE id = ${p.id} AND athlete_id = ${store.athleteId}
    `
    if (!meta?.fresh) {
      await store.sql`
        UPDATE coach_proposal SET status = 'stale', resolved_at = NOW()
        WHERE id = ${p.id} AND athlete_id = ${store.athleteId} AND status = 'pending'
      `
      return { ok: false, status: 'stale', text: `This was proposed more than ${PREVIEW_TTL_HOURS} h ago, so it was not applied. Ask the coach to look again.` }
    }
    if (!opts.actor) author = meta.source === 'app' ? APP_COACH : { type: 'mcp', id: 'coach' }
  }
  const run = () => applyProgramProposal(store, p, logged ? { approvalRef: opts.approvalRef!, author } : null)
  if (!logged) return run()
  try {
    return await withTx(store.sql, run)
  } catch (e) {
    if (e instanceof ApprovalSpent) return { ok: false, status: 'refused', text: e.message }
    throw e
  }
}

async function applyProgramProposal(
  store: ConnectedStore,
  p: ProposalRow,
  log: { approvalRef: string; author: OverrideActor } | null,
): Promise<ResolveResult> {
  // Claim it before writing anything, so an app Accept and an MCP apply racing
  // each other can't both apply it. Released back to pending if nothing lands.
  const claimed = await store.sql<{ id: string }[]>`
    UPDATE coach_proposal SET status = 'applied', resolved_at = NOW()
    WHERE id = ${p.id} AND athlete_id = ${store.athleteId} AND status = 'pending'
    RETURNING id
  `
  if (!claimed.length) return { ok: false, status: 'refused', text: 'This proposal was already resolved.' }
  const release = async (status: 'pending' | 'stale') => {
    await store.sql`
      UPDATE coach_proposal SET status = ${status}, resolved_at = ${status === 'stale' ? new Date().toISOString() : null}
      WHERE id = ${p.id} AND athlete_id = ${store.athleteId}
    `
  }
  const live = await loadLiveProgram(store)
  if (!live) {
    await release('pending')
    return { ok: false, status: 'refused', text: 'No active program to change.' }
  }
  if (await programFingerprint(live) !== p.program_fingerprint) {
    await release('stale')
    return {
      ok: false,
      status: 'stale',
      text: 'The program changed after this was proposed, so it was not applied. Ask the coach to look again.',
    }
  }
  // G10: the athlete's approval of exactly this proposal, checked before any write.
  let approvalId: string | null = null
  let approvalRef = log?.approvalRef ?? null
  if (log) {
    const approval = await checkApproval(store, log.approvalRef, { previewId: p.id, currentDiff: proposalApprovalState(p) })
    if (!approval.ok) {
      await release('pending')
      return { ok: false, status: 'refused', text: approval.text }
    }
    approvalId = approval.approvalId
    approvalRef = approval.approvalRef
  }
  const before = log ? await phaseRoutineSnapshots(store, live.phaseId) : []
  let text: string
  try {
    text = await applyEdits(store, p.edits, { confirm: true, timing: p.timing, request: p.request ?? undefined })
  } catch (e) {
    await release('pending')
    throw e
  }
  if (!appliedOk(text)) {
    await release('pending')
    return { ok: false, status: 'refused', text }
  }
  if (log) {
    const [athlete] = await store.sql<{ n: number }[]>`SELECT sessions_per_week AS n FROM athlete WHERE id = ${store.athleteId}`
    const spw = Number(athlete?.n ?? live.sessionsPerWeek)
    const changeId = await writeChange(store, {
      actor: log.author,
      tool: 'accept_proposal',
      targetType: 'program',
      targetId: live.phaseId,
      diff: {
        proposal_id: p.id,
        title: p.title,
        timing: p.timing,
        program_id: live.programId,
        phase_id: live.phaseId,
        revision: p.diff,
        ...routineDelta(before, await phaseRoutineSnapshots(store, live.phaseId)),
        ...(spw !== live.sessionsPerWeek ? { sessions_per_week: { before: live.sessionsPerWeek, after: spw } } : {}),
      },
      rationale: p.rationale,
      approvalRef,
      approvalId,
      previewId: p.preview_id,
    })
    // Single use: spent by this change, or the whole accept rolls back.
    if (!(await consumeApproval(store, approvalId!, changeId))) throw new ApprovalSpent()
  }
  // The move, pinned to the goal it serves so the goal page shows it.
  const goalId = (Array.isArray(p.goal_ids) ? p.goal_ids : []).find((g) => UUID_RE.test(g)) ?? null
  const body = p.rationale ? `Accepted: ${p.title} Why: ${p.rationale}` : `Accepted: ${p.title}`
  await store.sql`
    INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
    VALUES (${store.athleteId}, 'coach', 'note', ${body}, ${goalId})
  `
  return { ok: true, status: 'applied', text }
}

async function acceptOverrideProposal(store: ConnectedStore, p: ProposalRow, approvalRef?: string): Promise<ResolveResult> {
  if (!approvalRef) {
    return { ok: false, status: 'refused', text: 'Refused: this is a week-only change; the athlete accepts it in the app.' }
  }
  const claimed = await store.sql<{ id: string }[]>`
    UPDATE coach_proposal SET status = 'applied', resolved_at = NOW()
    WHERE id = ${p.id} AND athlete_id = ${store.athleteId} AND status = 'pending'
    RETURNING id
  `
  if (!claimed.length) return { ok: false, status: 'refused', text: 'This proposal was already resolved.' }
  let res: Awaited<ReturnType<typeof applyPreview>>
  try {
    res = await applyPreview(store, { type: 'athlete', id: store.athleteId }, {
      preview_id: p.preview_id,
      confirm: true,
      approval_ref: approvalRef,
    }, { viaProposal: true })
  } catch (e) {
    await store.sql`
      UPDATE coach_proposal SET status = 'pending', resolved_at = NULL
      WHERE id = ${p.id} AND athlete_id = ${store.athleteId}
    `
    throw e
  }
  if (res.ok) return { ok: true, status: 'applied', text: res.text }
  const status = res.reason === 'stale' || res.reason === 'not_found' ? 'stale' : 'pending'
  await store.sql`
    UPDATE coach_proposal SET status = ${status}, resolved_at = ${status === 'stale' ? new Date().toISOString() : null}
    WHERE id = ${p.id} AND athlete_id = ${store.athleteId}
  `
  return status === 'stale'
    ? { ok: false, status: 'stale', text: `${res.text.replace(/^Refused: /, '')} Ask the coach to look again.` }
    : { ok: false, status: 'refused', text: res.text }
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
 * The athlete's Accept. With tracks_v1 on (G10) it is approve + apply: their
 * tap creates an approval row for exactly this proposal, and the apply
 * consumes it. Off, it is the pre-G10 accept, unchanged.
 */
export async function approveAndAccept(store: ConnectedStore, proposalId: string): Promise<ResolveResult & { approval_ref?: string }> {
  if (!(await tracksV1On(store))) return acceptProposal(store, proposalId, { approvalRef: `tap:${proposalId}` })
  if (!UUID_RE.test(proposalId)) return { ok: false, status: 'not_found', text: 'No such proposal.' }
  const approval = await createApproval(store, { type: 'athlete', id: store.athleteId }, { preview_id: proposalId })
  if (!approval.ok) {
    if (approval.reason === 'stale') {
      // Too old to approve: it goes stale, as an accept of it always did.
      await store.sql`
        UPDATE coach_proposal SET status = 'stale', resolved_at = NOW()
        WHERE id = ${proposalId} AND athlete_id = ${store.athleteId} AND status = 'pending'
          AND created_at <= NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)
      `
    }
    const status = approval.reason === 'stale' ? 'stale' : approval.reason === 'not_found' ? 'not_found' : approval.reason === 'unavailable' ? 'unavailable' : 'refused'
    return { ok: false, status, text: approval.text.replace(/^Can't approve: /, '') }
  }
  const res = await acceptProposal(store, proposalId, { approvalRef: approval.approval_ref })
  return res.ok ? { ...res, approval_ref: approval.approval_ref } : res
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
          // The athlete's own tap on Accept is the approval.
          return json(await approveAndAccept(store, id), 200, cors)
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
