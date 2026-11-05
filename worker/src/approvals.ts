/**
 * Approval capture (G10, tracks_v1): the athlete's yes, as a row.
 *
 * G1/G2 required approval_ref on every non-logging write but only checked its
 * shape. Now an approval is a row only the athlete's own session can create,
 * bound to one preview and a hash of the diff they saw:
 *
 *   tap   the athlete tapped Approve (or Accept, Undo) in the app.
 *   chat  the athlete said yes in the in-app coach chat; the server checks
 *         the message is theirs, written by them (not the coach), and newer
 *         than the preview.
 *
 * approval_ref is tap:<approval.id> or msg:<approval.id>. Every apply path
 * (G2 write tools, proposal accept, week-only override apply, undo) resolves
 * it: same athlete, same preview, same diff hash as the diff recomputed now,
 * under 24 h, not consumed, not voided, and its coach still has access. The
 * write consumes it in the same transaction (or statement), naming the
 * change_log row it produced, so it applies once. A coach (MCP or app_coach)
 * never creates one; an MCP coach can only reference one the athlete made for
 * that coach's preview, found with list_approvals(preview_id).
 *
 * The table is hand-applied on Neon (worker/schema/approval.sql). With the
 * flag off nothing here is called.
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { beginAuthCors, json } from './cors.ts'
import { asJson, pgArrayLiteral, withSql, type Sql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { makeStore } from './store.ts'
import { actorFromRef, canonicalJson, PREVIEW_TTL_HOURS, tracksV1On, type OverrideActor } from './sessionOverride.ts'
import type { ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'

export type ApprovalKind = 'program_edits' | 'session_override' | 'revert' | 'proposal' | 'change' | 'app_editor'
export type ApprovalChannel = 'tap' | 'chat'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_RE = /^(tap|msg):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export const approvalsUnavailable = 'Approvals are not set up on this database yet. Nothing was written.'

function missingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return code === '42P01' || code === '42703'
}

/** A write that touched approval before worker/schema/approval.sql was applied. */
export function approvalMissing(e: unknown): boolean {
  return missingSchema(e) && /approval/.test(String((e as { message?: string })?.message ?? ''))
}

/** SHA-256 of the diff as canonical JSON: what the athlete saw, as a hash. */
export async function diffHash(diff: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(diff ?? null)))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** tap:<uuid> / msg:<uuid> → its parts; null for anything else. */
export function parseApprovalRef(ref: unknown): { channel: ApprovalChannel; id: string } | null {
  const m = typeof ref === 'string' ? REF_RE.exec(ref.trim()) : null
  return m ? { channel: m[1].toLowerCase() === 'tap' ? 'tap' : 'chat', id: m[2].toLowerCase() } : null
}

export function approvalRefOf(channel: ApprovalChannel, id: string): string {
  return `${channel === 'tap' ? 'tap' : 'msg'}:${id}`
}

/** The shape every approval_ref must have before it is looked up. */
export const APPROVAL_REF_SHAPE = 'approval_ref must be msg:<approval id> or tap:<approval id> — the approval the athlete created for this preview (list_approvals(preview_id) shows it once they say yes).'

// ---- what is being approved -----------------------------------------------------------

/** A proposal as the athlete saw it: hashed into diff_hash. */
export function proposalApprovalState(p: { id: string; edits: unknown; timing: string; diff: unknown; program_fingerprint: string }): unknown {
  return {
    proposal_id: p.id,
    edits: asJson<unknown>(p.edits, []),
    timing: p.timing,
    diff: asJson<unknown>(p.diff, {}),
    program_fingerprint: p.program_fingerprint,
  }
}

interface PreviewTarget {
  kind: ApprovalKind
  previewId: string
  diff: unknown
  createdAt: string
  requestedBy: OverrideActor
  /** Why it can't be approved now, if it can't. */
  closed: string | null
}

/** A coach token that is revoked, expired or gone. */
export async function coachTokenGone(store: ConnectedStore, actorId: string): Promise<boolean> {
  if (!UUID_RE.test(actorId)) return true
  const [row] = await store.sql<{ gone: boolean }[]>`
    SELECT (revoked_at IS NOT NULL
            OR COALESCE((to_jsonb(t) ->> 'expires_at')::timestamptz < NOW(), false)) AS gone
    FROM mcp_token t
    WHERE id = ${actorId} AND athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return !row || row.gone
}

/**
 * The preview the athlete is approving, by id: a kept change preview (chp_),
 * a week-only override preview (sop_), or a pending coach proposal (its id).
 * Only this athlete's.
 */
async function loadPreviewTarget(store: ConnectedStore, previewId: string): Promise<PreviewTarget | null> {
  const id = previewId.trim()
  const ttl = PREVIEW_TTL_HOURS
  type Row = { preview_id: string; tool?: string; diff: unknown; created_at: string; actor_type: OverrideActor['type']; actor_id: string; used_at: string | null; voided_at: string | null; fresh: boolean }
  const closed = (r: Row): string | null =>
    r.used_at ? 'this preview was already applied'
      : r.voided_at ? 'this preview was voided'
        : !r.fresh ? `this preview is more than ${ttl} h old`
          : null
  if (id.startsWith('chp_')) {
    const [r] = await store.sql<Row[]>`
      SELECT preview_id, tool, diff, to_json(created_at) #>> '{}' AS created_at, actor_type, actor_id,
             to_json(used_at) #>> '{}' AS used_at, to_json(voided_at) #>> '{}' AS voided_at,
             (created_at > NOW() - make_interval(hours => ${ttl}::int)) AS fresh
      FROM change_preview WHERE preview_id = ${id} AND athlete_id = ${store.athleteId} LIMIT 1
    `
    if (!r) return null
    const kind: ApprovalKind = r.tool === 'apply_program_edits' ? 'program_edits' : r.tool === 'revert_change' ? 'revert' : 'change'
    return { kind, previewId: r.preview_id, diff: asJson<unknown>(r.diff, {}), createdAt: r.created_at, requestedBy: { type: r.actor_type, id: r.actor_id }, closed: closed(r) }
  }
  if (id.startsWith('sop_')) {
    const [r] = await store.sql<Row[]>`
      SELECT preview_id, diff, to_json(created_at) #>> '{}' AS created_at, actor_type, actor_id,
             to_json(used_at) #>> '{}' AS used_at, to_json(voided_at) #>> '{}' AS voided_at,
             (created_at > NOW() - make_interval(hours => ${ttl}::int)) AS fresh
      FROM session_override_preview WHERE preview_id = ${id} AND athlete_id = ${store.athleteId} LIMIT 1
    `
    if (!r) return null
    return { kind: 'session_override', previewId: r.preview_id, diff: asJson<unknown>(r.diff, []), createdAt: r.created_at, requestedBy: { type: r.actor_type, id: r.actor_id }, closed: closed(r) }
  }
  if (UUID_RE.test(id)) {
    const [p] = await store.sql<{
      id: string; preview_id: string; edits: unknown; timing: string; diff: unknown; program_fingerprint: string
      status: string; source: string; kind: string | null; created_by: string | null; created_at: string; fresh: boolean
    }[]>`
      SELECT id::text AS id, preview_id, edits, timing, diff, program_fingerprint, status, source,
             to_jsonb(cp) ->> 'kind' AS kind, to_jsonb(cp) ->> 'created_by' AS created_by, to_json(created_at) #>> '{}' AS created_at,
             (created_at > NOW() - make_interval(hours => ${ttl}::int)) AS fresh
      FROM coach_proposal cp WHERE id = ${id} AND athlete_id = ${store.athleteId} LIMIT 1
    `
    if (!p) return null
    // A parked week-only override is approved as the override preview it holds.
    if (p.kind === 'session_override') return loadPreviewTarget(store, p.preview_id)
    return {
      kind: 'proposal',
      previewId: p.id,
      diff: proposalApprovalState(p),
      createdAt: p.created_at,
      // G3: the coach that parked it, so revoking that coach voids this approval too.
      requestedBy: actorFromRef(p.created_by) ?? (p.source === 'app' ? { type: 'app_coach', id: 'app_coach' } : { type: 'mcp', id: 'coach' }),
      closed: p.status !== 'pending' ? `this proposal was already ${p.status}` : !p.fresh ? `this was proposed more than ${ttl} h ago` : null,
    }
  }
  return null
}

// ---- creating ---------------------------------------------------------------------------

export type CreateApprovalResult =
  | { ok: true; approval_id: string; approval_ref: string; preview_id: string; preview_kind: ApprovalKind; channel: ApprovalChannel }
  | { ok: false; reason: 'refused' | 'not_found' | 'stale' | 'off' | 'unavailable'; text: string }

/** Only the athlete's own session approves. */
function athleteOnly(store: ConnectedStore, actor: OverrideActor): string | null {
  if (actor.type === 'athlete' && actor.id === store.athleteId) return null
  if (actor.type === 'app_coach') return 'Refused: the in-app coach cannot approve. Only the athlete approves, in the app.'
  if (actor.type === 'mcp') return 'Refused: a coach cannot create an approval. Only the athlete approves, in the app.'
  return 'Refused: only the athlete can approve a change.'
}

async function insertApproval(
  store: ConnectedStore,
  row: { previewId: string; kind: ApprovalKind; hash: string; channel: ApprovalChannel; messageId: string | null; requestedBy: OverrideActor },
): Promise<string> {
  const [r] = await store.sql<{ id: string }[]>`
    INSERT INTO approval (athlete_id, preview_id, preview_kind, diff_hash, channel, message_id, requested_by_type, requested_by_id)
    VALUES (${store.athleteId}, ${row.previewId}, ${row.kind}, ${row.hash}, ${row.channel}, ${row.messageId},
            ${row.requestedBy.type}, ${row.requestedBy.id})
    RETURNING id::text AS id
  `
  return r.id
}

/**
 * The athlete approves one preview: a tap, or (with messageId) the chat
 * message where they said yes. Writes the approval row and nothing else; the
 * apply that consumes it is a separate step (or the same request, for Accept).
 */
export async function createApproval(
  store: ConnectedStore,
  actor: OverrideActor,
  args: { preview_id: unknown; message_id?: unknown },
): Promise<CreateApprovalResult> {
  const who = athleteOnly(store, actor)
  if (who) return { ok: false, reason: 'refused', text: who }
  if (!(await tracksV1On(store))) return { ok: false, reason: 'off', text: 'Approvals are off for this athlete.' }
  const previewId = typeof args.preview_id === 'string' ? args.preview_id.trim() : ''
  if (!previewId) return { ok: false, reason: 'refused', text: 'preview_id is required.' }
  const chat = args.message_id != null && args.message_id !== ''
  try {
    const target = await loadPreviewTarget(store, previewId)
    if (!target) return { ok: false, reason: 'not_found', text: 'No such preview.' }
    // A coach's undo suggestion is applied by the athlete's Undo tap, which is its own approval.
    if (target.kind === 'revert') return { ok: false, reason: 'refused', text: 'Undo it from Program → Changes; that tap is the approval.' }
    if (target.closed) return { ok: false, reason: 'stale', text: `Can't approve: ${target.closed}. Ask the coach to preview it again.` }
    if (target.requestedBy.type === 'mcp' && UUID_RE.test(target.requestedBy.id) && await coachTokenGone(store, target.requestedBy.id)) {
      return { ok: false, reason: 'stale', text: 'Can\'t approve: the coach that made this preview no longer has access.' }
    }
    let messageId: string | null = null
    if (chat) {
      const id = typeof args.message_id === 'string' ? args.message_id.trim() : ''
      if (!UUID_RE.test(id)) return { ok: false, reason: 'refused', text: 'Refused: message_id must be the id of your chat message.' }
      const [m] = await store.sql<{ role: string; newer: boolean }[]>`
        SELECT role, (created_at > ${target.createdAt}::timestamptz) AS newer
        FROM coach_message WHERE id = ${id} AND athlete_id = ${store.athleteId} LIMIT 1
      `
      if (!m) return { ok: false, reason: 'not_found', text: 'Refused: no such chat message on your account.' }
      if (m.role !== 'athlete') return { ok: false, reason: 'refused', text: 'Refused: that message was written by the coach, not by you.' }
      if (!m.newer) return { ok: false, reason: 'refused', text: 'Refused: that message is older than the preview, so it can\'t be your yes to it.' }
      messageId = id
    }
    const channel: ApprovalChannel = chat ? 'chat' : 'tap'
    const id = await insertApproval(store, {
      previewId: target.previewId,
      kind: target.kind,
      hash: await diffHash(target.diff),
      channel,
      messageId,
      requestedBy: target.requestedBy,
    })
    return { ok: true, approval_id: id, approval_ref: approvalRefOf(channel, id), preview_id: target.previewId, preview_kind: target.kind, channel }
  } catch (e) {
    if (missingSchema(e)) return { ok: false, reason: 'unavailable', text: approvalsUnavailable }
    throw e
  }
}

/**
 * The athlete's tap on a write that has no separate preview (undo, the
 * program editor): the tap is the preview and the approval, created here and
 * consumed by the same transaction's write.
 */
export async function directTapApproval(
  store: ConnectedStore,
  kind: Extract<ApprovalKind, 'revert' | 'app_editor'>,
  previewId: string,
  diff: unknown,
): Promise<{ id: string; ref: string }> {
  const id = await insertApproval(store, {
    previewId,
    kind,
    hash: await diffHash(diff),
    channel: 'tap',
    messageId: null,
    requestedBy: { type: 'athlete', id: store.athleteId },
  })
  return { id, ref: approvalRefOf('tap', id) }
}

// ---- checking and consuming ---------------------------------------------------------------

export type ApprovalCheck = { ok: true; approvalId: string; approvalRef: string } | { ok: false; text: string }

/**
 * Does approval_ref resolve to an open approval the athlete made for exactly
 * this preview and this diff? `currentDiff` is the diff recomputed now, so an
 * approval of a diff that has since moved does not match. Writes nothing.
 */
export async function checkApproval(
  store: ConnectedStore,
  ref: unknown,
  expect: { previewId: string; currentDiff: unknown },
): Promise<ApprovalCheck> {
  const parsed = parseApprovalRef(ref)
  if (!parsed) return { ok: false, text: `Refused: ${APPROVAL_REF_SHAPE}` }
  let a: {
    id: string; preview_id: string; diff_hash: string; channel: ApprovalChannel; requested_by_type: string; requested_by_id: string
    consumed_at: string | null; voided_at: string | null; fresh: boolean
  } | undefined
  try {
    [a] = await store.sql<NonNullable<typeof a>[]>`
      SELECT id::text AS id, preview_id, diff_hash, channel, requested_by_type, requested_by_id,
             to_json(consumed_at) #>> '{}' AS consumed_at, to_json(voided_at) #>> '{}' AS voided_at,
             (created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)) AS fresh
      FROM approval WHERE id = ${parsed.id} AND athlete_id = ${store.athleteId} LIMIT 1
    `
  } catch (e) {
    if (missingSchema(e)) return { ok: false, text: approvalsUnavailable }
    throw e
  }
  if (!a || a.channel !== parsed.channel) {
    return { ok: false, text: 'Refused: no such approval on this athlete. The athlete approves in the app (a tap, or their yes in the coach chat); pass the approval_ref that creates.' }
  }
  if (a.preview_id !== expect.previewId) return { ok: false, text: 'Refused: that approval is for a different preview. Ask the athlete to approve this one.' }
  if (a.consumed_at) return { ok: false, text: 'Refused: that approval was already used. Each approval applies once; preview again and ask the athlete.' }
  if (a.voided_at) return { ok: false, text: 'Refused: that approval was voided (its coach no longer has access). Preview again.' }
  if (!a.fresh) return { ok: false, text: `Refused: that approval is more than ${PREVIEW_TTL_HOURS} h old. Preview again and ask the athlete.` }
  if (a.requested_by_type === 'mcp' && UUID_RE.test(a.requested_by_id) && await coachTokenGone(store, a.requested_by_id)) {
    return { ok: false, text: 'Refused: that approval was voided (its coach no longer has access). Preview again.' }
  }
  if (a.diff_hash !== await diffHash(expect.currentDiff)) {
    return { ok: false, text: 'Refused: the diff changed since the athlete approved it. Preview again and ask the athlete.' }
  }
  return { ok: true, approvalId: a.id, approvalRef: approvalRefOf(a.channel, a.id) }
}

/** Mark it used by `changeId`, once. False if it was consumed or voided meanwhile. */
export async function consumeApproval(store: ConnectedStore, approvalId: string, changeId: string): Promise<boolean> {
  const rows = await store.sql<{ id: string }[]>`
    UPDATE approval SET consumed_at = NOW(), consumed_by_change_id = ${changeId}
    WHERE id = ${approvalId} AND athlete_id = ${store.athleteId} AND consumed_at IS NULL AND voided_at IS NULL
    RETURNING id
  `
  return rows.length > 0
}

/** Thrown inside a write's transaction when its approval was spent meanwhile: rolls it all back. */
export class ApprovalSpent extends McpUserError {
  constructor() {
    super('Refused: that approval was already used. Each approval applies once; preview again and ask the athlete.')
  }
}

// ---- revocation ---------------------------------------------------------------------------

async function approvalTable(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`SELECT to_regclass('public.approval') IS NOT NULL AS ok`
  return row?.ok === true
}

/**
 * Void every unconsumed approval of this coach's previews, and (G3) of the
 * previews behind proposals it parked (`previewIds`). Ids voided. Safe before
 * the table exists.
 */
export async function voidCoachApprovals(store: ConnectedStore, tokenId: string, previewIds: string[] = []): Promise<string[]> {
  if (!(await approvalTable(store.sql))) return []
  const rows = await store.sql<{ id: string }[]>`
    UPDATE approval SET voided_at = NOW()
    WHERE athlete_id = ${store.athleteId}
      AND ((requested_by_type = 'mcp' AND requested_by_id = ${tokenId})
           OR preview_id = ANY(${pgArrayLiteral(previewIds)}::text[]))
      AND consumed_at IS NULL AND voided_at IS NULL
    RETURNING id::text AS id
  `
  return rows.map((r) => r.id).sort()
}

// ---- reading ------------------------------------------------------------------------------

export interface ApprovalView {
  approval_ref: string
  preview_id: string
  preview_kind: ApprovalKind
  channel: ApprovalChannel
  created_at: string
  status: 'open' | 'consumed' | 'voided' | 'expired'
  consumed_by_change_id: string | null
}

export async function listApprovals(store: ConnectedStore, opts: { previewId?: string | null; limit?: number } = {}): Promise<ApprovalView[] | null> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30))
  try {
    const rows = await store.sql<{
      id: string; preview_id: string; preview_kind: ApprovalKind; channel: ApprovalChannel; created_at: string
      consumed_at: string | null; voided_at: string | null; consumed_by_change_id: string | null; fresh: boolean
    }[]>`
      SELECT id::text AS id, preview_id, preview_kind, channel, to_json(created_at) #>> '{}' AS created_at,
             to_json(consumed_at) #>> '{}' AS consumed_at, to_json(voided_at) #>> '{}' AS voided_at,
             consumed_by_change_id::text AS consumed_by_change_id,
             (created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)) AS fresh
      FROM approval
      WHERE athlete_id = ${store.athleteId} AND (${opts.previewId ?? null}::text IS NULL OR preview_id = ${opts.previewId ?? null}::text)
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `
    return rows.map((r) => ({
      approval_ref: approvalRefOf(r.channel, r.id),
      preview_id: r.preview_id,
      preview_kind: r.preview_kind,
      channel: r.channel,
      created_at: r.created_at,
      status: r.consumed_at ? 'consumed' : r.voided_at ? 'voided' : r.fresh ? 'open' : 'expired',
      consumed_by_change_id: r.consumed_by_change_id,
    }))
  } catch (e) {
    if (missingSchema(e)) return null
    throw e
  }
}

// ---- MCP ----------------------------------------------------------------------------------

export const APPROVAL_TOOLS: McpTool[] = [
  {
    name: 'list_approvals',
    description: 'The athlete\'s approvals of one preview you made: each approval_ref (tap:<id> from an in-app tap, msg:<id> from their yes in the coach chat), whether it is open, used or voided. Coaches cannot create approvals; only the athlete does, in the app. Pass an open approval_ref to the apply call for that same preview_id; it applies once.',
    inputSchema: {
      type: 'object',
      properties: {
        preview_id: { type: 'string', description: 'The preview_id (chp_… / sop_…) or proposal id the athlete was asked to approve.' },
      },
      required: ['preview_id'],
      additionalProperties: false,
    },
  },
]

export const APPROVAL_TOOL_NAMES = new Set(APPROVAL_TOOLS.map((t) => t.name))

export async function runApprovalTool(store: ConnectedStore, name: string, args: Record<string, unknown>): Promise<string> {
  if (!(await tracksV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  if (name !== 'list_approvals') throw new McpUserError(`Unknown tool: ${name}`)
  const previewId = typeof args.preview_id === 'string' ? args.preview_id.trim() : ''
  if (!previewId) throw new McpUserError('preview_id is required')
  const rows = await listApprovals(store, { previewId, limit: 20 })
  if (rows == null) return approvalsUnavailable.replace(' Nothing was written.', '')
  if (!rows.length) return 'No approvals for that preview yet. Show the athlete the diff and wait for their yes in the app.'
  return JSON.stringify({ approvals: rows }, null, 2)
}

// ---- app route ----------------------------------------------------------------------------

/** POST /api/approvals — the athlete's own session; same auth as /api/session-rx. */
export async function handleApprovals(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)

  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return json({ error: 'invalid json' }, 400, cors)
  }

  try {
    return await withSql(env, async (sql) => {
      const user = await sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET)
      if (!user) return json({ error: 'unauthorized' }, 401, cors)
      const athleteId = await resolveAthleteId(sql, user.id)
      if (!athleteId) return json({ error: 'unauthorized' }, 401, cors)
      const [out, status] = await athleteApprovalAction(makeStore(sql, athleteId, 'lb'), body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'approval request failed' }, 500, cors)
  }
}

/**
 * The route's body (POST /api/approvals), separated so checks can drive it
 * without an auth cookie. The athlete's own session only; 404 with the flag
 * off so the route reads as absent.
 *   { action: 'approve', preview_id }               → a tap approval
 *   { action: 'approve', preview_id, message_id }   → a chat approval
 *   { action: 'list', preview_id? }                 → { approvals }
 */
export async function athleteApprovalAction(store: ConnectedStore, body: Record<string, unknown>): Promise<[unknown, number]> {
  if (!(await tracksV1On(store))) return [{ error: 'not found' }, 404]
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  switch (body.action) {
    case 'approve':
      return [await createApproval(store, me, { preview_id: body.preview_id, message_id: body.message_id }), 200]
    case 'list':
      return [{ approvals: await listApprovals(store, { previewId: typeof body.preview_id === 'string' ? body.preview_id : null }) }, 200]
    default:
      return [{ error: 'unknown action' }, 400]
  }
}
