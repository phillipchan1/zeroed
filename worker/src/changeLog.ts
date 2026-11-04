/**
 * change_log (G2, tracks_v1): one accountable record of every coach and
 * athlete write — who, what (before → after), why, which rules, and what the
 * athlete approved — and the athlete's one-tap undo.
 *
 * Generalizes, doesn't replace: program_revision and session_override_log are
 * still written exactly as before. With tracks_v1 on, every covered write also
 * adds ONE change_log row in the same transaction (or the same statement).
 *
 * The contract (spec section 6, propose-only v1):
 *   logging   workout results, notes, goal measurements: standing:logging.
 *   anything  confirm=true, approval_ref and a preview_id under 24 h old
 *   else      whose diff still matches. approval_ref resolves to an
 *             approval row the athlete created for that preview and diff
 *             (G10, approvals.ts): tap:<id> or msg:<id>, consumed by the
 *             write, once. app_coach never supplies one. Previews for these
 *             writes live in change_preview; week-only overrides keep
 *             session_override_preview.
 *   undo      athlete only. Applies the inverse of a row's diff when the
 *             target still looks exactly like the row left it; refuses when
 *             it moved since, when the type can't be undone without deleting
 *             data, or when the row was already undone. A coach can preview
 *             an undo (preview_revert_change) and the feed shows it as
 *             suggested; only the athlete's tap applies it.
 *
 * Tables are hand-applied on Neon (worker/schema/change-log.sql). With the
 * flag off nothing here is called.
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { asJson, jsonParam, pgArrayLiteral, type Sql } from './db.ts'
import { insertProgramRevision } from './edits.ts'
import { athleteToday, canonicalJson, PREVIEW_TTL_HOURS, tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { actorLabel, ruleRefsFrom, summarizeChange } from './changeSummary.ts'
import {
  APPROVAL_REF_SHAPE, ApprovalSpent, checkApproval, coachTokenGone, consumeApproval, directTapApproval,
  parseApprovalRef, voidCoachApprovals,
} from './approvals.ts'
import type { ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'
import { methodologyVersionFor } from './methodology.ts'
import { seesHealth } from './regionStatus.ts'

export type ChangeActor = OverrideActor

export const STANDING_LOGGING = 'standing:logging'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function missingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return code === '42P01' || code === '42703'
}

export const changeLogUnavailable = 'The change log is not set up on this database yet. Nothing was written.'

/** A write that touched change_log before worker/schema/change-log.sql was applied. */
export function changeLogMissing(e: unknown): boolean {
  return missingSchema(e) && /change_(log|preview)/.test(String((e as { message?: string })?.message ?? ''))
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})

// ---- transactions -----------------------------------------------------------------

const open = new WeakSet<Sql>()

/**
 * BEGIN … COMMIT on this request's connection (the Worker holds one client per
 * request, so every query in fn lands inside it). Nested calls join the outer
 * transaction. Anything thrown rolls the whole write back, log row included.
 */
export async function withTx<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  if (open.has(sql)) return fn()
  await sql`BEGIN`
  open.add(sql)
  try {
    const out = await fn()
    await sql`COMMIT`
    return out
  } catch (e) {
    await sql`ROLLBACK`.catch(() => undefined)
    throw e
  } finally {
    open.delete(sql)
  }
}

/** Thrown inside a transaction to roll it back and answer with `result`. */
class Refusal<T> extends Error {
  result: T
  constructor(result: T) {
    super('refused')
    this.result = result
  }
}

// ---- approval ---------------------------------------------------------------------

/**
 * Null when this actor may make a non-logging write with this approval_ref;
 * otherwise why not. Same rules as week-only overrides (phase 1). Shape only:
 * the ref must then resolve to a real approval (checkApproval).
 */
export function writeApprovalProblem(actor: ChangeActor, ref: unknown): string | null {
  if (actor.type === 'app_coach') {
    return 'Refused: app_coach cannot supply approval_ref. Propose the change so the athlete accepts it in the app.'
  }
  if (actor.type === 'system') return 'Refused: system writes cannot approve a change.'
  if (typeof ref !== 'string' || !ref.trim()) {
    return 'Refused: approval_ref is required (the approval the athlete created for this preview; see list_approvals). Only logging (results, notes, measurements) has standing approval.'
  }
  const r = ref.trim()
  if (r.startsWith('standing:')) return 'Refused: standing approval covers logging only (results, notes, measurements).'
  if (!parseApprovalRef(r)) return `Refused: ${APPROVAL_REF_SHAPE}`
  return null
}

// ---- writing rows -----------------------------------------------------------------

export interface ChangeEntry {
  actor: ChangeActor
  tool: string
  targetType: string
  targetId: string | null
  diff: unknown
  rationale?: string | null
  ruleRefs?: string[]
  approvalRef: string | null
  /** The approval row approvalRef resolves to (G10). */
  approvalId?: string | null
  previewId?: string | null
  expiresOn?: string | null
  revertOf?: string | null
  id?: string
}

/** Append one row. Callers run it in the same transaction as the write it records. */
export async function writeChange(store: ConnectedStore, e: ChangeEntry): Promise<string> {
  const id = e.id ?? crypto.randomUUID()
  const rationale = e.rationale?.trim() ? e.rationale.trim() : null
  // G3: the methodology version (with this athlete's overrides) the write ran on.
  const methodology = await methodologyVersionFor(store)
  if (e.approvalId) {
    await store.sql`
      INSERT INTO change_log (
        id, athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
        approval_ref, approval_id, preview_id, expires_on, revert_of, methodology_version
      ) VALUES (
        ${id}, ${store.athleteId}, ${e.actor.type}, ${e.actor.id}, ${e.tool}, ${e.targetType}, ${e.targetId},
        ${jsonParam(store.sql, e.diff ?? {})}, ${rationale}, ${jsonParam(store.sql, e.ruleRefs ?? ruleRefsFrom(rationale))},
        ${e.approvalRef}, ${e.approvalId}, ${e.previewId ?? null}, ${e.expiresOn ?? null}, ${e.revertOf ?? null}, ${methodology}
      )
    `
    return id
  }
  // No approval row (standing:logging, system): the G2 insert, unchanged.
  await store.sql`
    INSERT INTO change_log (
      id, athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
      approval_ref, preview_id, expires_on, revert_of, methodology_version
    ) VALUES (
      ${id}, ${store.athleteId}, ${e.actor.type}, ${e.actor.id}, ${e.tool}, ${e.targetType}, ${e.targetId},
      ${jsonParam(store.sql, e.diff ?? {})}, ${rationale}, ${jsonParam(store.sql, e.ruleRefs ?? ruleRefsFrom(rationale))},
      ${e.approvalRef}, ${e.previewId ?? null}, ${e.expiresOn ?? null}, ${e.revertOf ?? null}, ${methodology}
    )
  `
  return id
}

// ---- previews ---------------------------------------------------------------------

function newPreviewId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `chp_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export async function storeChangePreview(
  store: ConnectedStore,
  actor: ChangeActor,
  tool: string,
  state: unknown,
  opts: { rationale?: string | null; targetId?: string | null } = {},
): Promise<string> {
  const previewId = newPreviewId()
  await store.sql`
    INSERT INTO change_preview (athlete_id, preview_id, tool, target_id, diff, actor_type, actor_id, rationale)
    VALUES (${store.athleteId}, ${previewId}, ${tool}, ${opts.targetId ?? null}, ${jsonParam(store.sql, state ?? {})},
            ${actor.type}, ${actor.id}, ${opts.rationale ?? null})
  `
  return previewId
}

export function previewFooter(previewId: string): string {
  return `preview_id: ${previewId} (valid ${PREVIEW_TTL_HOURS} h, and only while this diff still matches). Show the athlete this diff; once they approve it in the app, list_approvals(preview_id) gives their approval_ref. Apply with confirm=true, this preview_id and that approval_ref (it applies once).`
}

interface ChangePreviewRow {
  id: string
  preview_id: string
  tool: string
  diff: unknown
  actor_type: ChangeActor['type']
  actor_id: string
  used_at: string | null
  voided_at: string | null
  fresh: boolean
}

export type Authorized =
  | { ok: true; approvalRef: string; approvalId: string; previewId: string; previewRowId: string }
  | { ok: false; text: string }

/**
 * Everything a non-logging write must show before it runs: a preview of this
 * tool, under 24 h old, unused, not voided, whose stored diff equals `state`
 * recomputed now, and an approval the athlete made for that preview and that
 * diff (G10). Writes nothing.
 */
export async function authorizeWrite(
  store: ConnectedStore,
  actor: ChangeActor,
  tool: string,
  args: { preview_id?: unknown; approval_ref?: unknown },
  state: unknown,
): Promise<Authorized> {
  const problem = writeApprovalProblem(actor, args.approval_ref)
  if (problem) return { ok: false, text: problem }
  const previewId = typeof args.preview_id === 'string' ? args.preview_id.trim() : ''
  if (!previewId) {
    return { ok: false, text: `Refused: preview_id is required. Call ${tool} without confirm first, show the athlete the diff, then apply with that preview_id.` }
  }
  const [p] = await store.sql<ChangePreviewRow[]>`
    SELECT id, preview_id, tool, diff, actor_type, actor_id,
           to_json(used_at) #>> '{}' AS used_at, to_json(voided_at) #>> '{}' AS voided_at,
           (created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)) AS fresh
    FROM change_preview
    WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId}
    LIMIT 1
  `
  if (!p || p.tool !== tool) return { ok: false, text: `Refused: no ${tool} preview with that id on this athlete. Preview again.` }
  if (p.used_at) return { ok: false, text: 'Refused: this preview was already applied. Preview again.' }
  if (p.voided_at || (p.actor_type === 'mcp' && await coachTokenGone(store, p.actor_id))) {
    return { ok: false, text: 'Refused: this preview was voided (its coach no longer has access). Preview again.' }
  }
  if (!p.fresh) {
    return { ok: false, text: `Refused: this preview is more than ${PREVIEW_TTL_HOURS} h old. Preview again and show the athlete the new diff.` }
  }
  if (canonicalJson(asJson(p.diff, {})) !== canonicalJson(state)) {
    return { ok: false, text: 'Refused: the diff no longer matches the preview (the request or what it changes moved since). Preview again.' }
  }
  const approval = await checkApproval(store, args.approval_ref, { previewId: p.preview_id, currentDiff: state })
  if (!approval.ok) return approval
  return { ok: true, approvalRef: approval.approvalRef, approvalId: approval.approvalId, previewId: p.preview_id, previewRowId: p.id }
}

/** Claim a preview inside the write's transaction, so it applies once. */
async function claimPreview(store: ConnectedStore, rowId: string): Promise<boolean> {
  const rows = await store.sql<{ id: string }[]>`
    UPDATE change_preview SET used_at = NOW()
    WHERE id = ${rowId} AND athlete_id = ${store.athleteId} AND used_at IS NULL AND voided_at IS NULL
    RETURNING id
  `
  return rows.length > 0
}

export interface Logged<T> {
  result: T
  /** Null: nothing was written (a refusal or a no-op), so roll back and log nothing. */
  entry: Omit<ChangeEntry, 'actor' | 'tool' | 'approvalRef' | 'previewId'> | null
}

/**
 * What a write tool needs with tracks_v1 on. Built per call by the tool
 * dispatcher; absent with the flag off, and the tools then run exactly as
 * before.
 */
export interface WriteGate {
  actor: ChangeActor
  /** confirm !== true: keep `state` as a preview and hand back its id. */
  preview(tool: string, state: unknown, rationale: string | null): Promise<string>
  /** confirm === true: approval + preview check, then write and log in one transaction. */
  commit<T>(tool: string, args: Obj, state: unknown, write: () => Promise<Logged<T>>): Promise<T>
  /** A standing-approved logging write: logged as standing:logging. */
  logging<T>(tool: string, write: () => Promise<Logged<T>>): Promise<T>
}

export function makeWriteGate(store: ConnectedStore, actor: ChangeActor): WriteGate {
  return {
    actor,
    preview: (tool, state, rationale) => storeChangePreview(store, actor, tool, state, { rationale }),
    async commit(tool, args, state, write) {
      const auth = await authorizeWrite(store, actor, tool, args, state)
      if (!auth.ok) throw new McpUserError(auth.text)
      return commitAuthorized(store, actor, tool, auth, args.rationale, args.rule_refs, write)
    },
    async logging(tool, write) {
      try {
        return await withTx(store.sql, async () => {
          const { result, entry } = await write()
          if (!entry) throw new Refusal(result)
          await writeChange(store, { ...entry, actor, tool, approvalRef: STANDING_LOGGING, previewId: null })
          return result
        })
      } catch (e) {
        if (e instanceof Refusal) return e.result as Awaited<ReturnType<typeof write>>['result']
        throw e
      }
    },
  }
}

export async function commitAuthorized<T>(
  store: ConnectedStore,
  actor: ChangeActor,
  tool: string,
  auth: Extract<Authorized, { ok: true }>,
  rationale: unknown,
  ruleRefs: unknown,
  write: () => Promise<Logged<T>>,
): Promise<T> {
  try {
    return await withTx(store.sql, async () => {
      if (!(await claimPreview(store, auth.previewRowId))) throw new McpUserError('Refused: this preview was already applied. Preview again.')
      const { result, entry } = await write()
      if (!entry) throw new Refusal(result)
      const why = typeof rationale === 'string' && rationale.trim() ? rationale.trim() : entry.rationale ?? null
      const changeId = await writeChange(store, {
        ...entry,
        rationale: why,
        ruleRefs: ruleRefsFrom(why, ruleRefs),
        actor,
        tool,
        approvalRef: auth.approvalRef,
        approvalId: auth.approvalId,
        previewId: auth.previewId,
      })
      // Single use: spent by this change, or the whole write rolls back.
      if (!(await consumeApproval(store, auth.approvalId, changeId))) throw new ApprovalSpent()
      return result
    })
  } catch (e) {
    if (e instanceof Refusal) return e.result as T
    throw e
  }
}

// ---- revocation -------------------------------------------------------------------

/** This athlete's coach tokens that are not revoked yet. */
export async function liveCoachTokenIds(store: ConnectedStore): Promise<string[]> {
  const rows = await store.sql<{ id: string }[]>`
    SELECT id::text AS id FROM mcp_token WHERE athlete_id = ${store.athleteId} AND revoked_at IS NULL
  `
  return rows.map((r) => r.id)
}

/** Pending proposals this coach parked → stale + voided_at. Before methodology.sql: none. */
async function voidCoachProposals(store: ConnectedStore, tokenId: string): Promise<Array<{ id: string; preview_id: string }>> {
  const [ready] = await store.sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'coach_proposal' AND column_name = 'created_by'
    ) AS ok
  `
  if (!ready?.ok) return []
  return store.sql<Array<{ id: string; preview_id: string }>>`
    UPDATE coach_proposal SET status = 'stale', resolved_at = NOW(), voided_at = NOW()
    WHERE athlete_id = ${store.athleteId} AND status = 'pending' AND created_by = ${`mcp:${tokenId}`}
    RETURNING id::text AS id, preview_id
  `
}

/**
 * Revoking a coach ends its MCP access (resolveMcpToken refuses it) and, here,
 * voids its open previews and every unconsumed approval of them (G10) at once
 * rather than at the next apply. Both are one change_log row per token this
 * revoke just ended (`wasLive`: the ids that were live before it). Idempotent:
 * a token already logged is skipped.
 */
export async function voidRevokedCoachPreviews(store: ConnectedStore, wasLive: string[]): Promise<number> {
  if (!wasLive.length) return 0
  const tokens = await store.sql<{ id: string; name: string }[]>`
    SELECT t.id::text AS id, t.name FROM mcp_token t
    WHERE t.athlete_id = ${store.athleteId} AND t.revoked_at IS NOT NULL
      AND t.id::text = ANY(${pgArrayLiteral(wasLive)}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM change_log c
        WHERE c.athlete_id = ${store.athleteId} AND c.tool = 'revoke_coach' AND c.target_id = t.id::text
      )
  `
  for (const t of tokens) {
    const changed = await store.sql<{ preview_id: string }[]>`
      UPDATE change_preview SET voided_at = NOW()
      WHERE athlete_id = ${store.athleteId} AND actor_type = 'mcp' AND actor_id = ${t.id}
        AND used_at IS NULL AND voided_at IS NULL
      RETURNING preview_id
    `
    const overrides = await store.sql<{ preview_id: string }[]>`
      UPDATE session_override_preview SET voided_at = NOW()
      WHERE athlete_id = ${store.athleteId} AND actor_type = 'mcp' AND actor_id = ${t.id}
        AND used_at IS NULL AND voided_at IS NULL
      RETURNING preview_id
    `
    const voided = [...changed, ...overrides].map((r) => r.preview_id).sort()
    // G3: proposals this coach parked (created_by names it; rows parked
    // before G3 have none and are left alone) can't be accepted any more.
    const proposals = await voidCoachProposals(store, t.id)
    const approvals = await voidCoachApprovals(store, t.id, proposals.flatMap((p) => [p.id, p.preview_id]))
    await writeChange(store, {
      actor: { type: 'system', id: 'revocation' },
      tool: 'revoke_coach',
      targetType: 'mcp_token',
      targetId: t.id,
      diff: {
        coach: t.name,
        voided_previews: voided,
        ...(proposals.length ? { voided_proposals: proposals.map((p) => p.id).sort() } : {}),
        ...(approvals.length ? { voided_approvals: approvals } : {}),
      },
      rationale: 'The athlete revoked this coach.',
      approvalRef: null,
    })
  }
  return tokens.length
}

// ---- reading ----------------------------------------------------------------------

export interface ChangeView {
  id: string
  created_at: string
  actor_type: ChangeActor['type']
  actor_id: string
  who: string
  tool: string
  target_type: string
  target_id: string | null
  summary: string
  diff: unknown
  rationale: string | null
  rule_refs: string[]
  approval_ref: string | null
  /** The approval row approval_ref resolves to (G10); null before G10 and for standing:logging. */
  approval_id: string | null
  preview_id: string | null
  expires_on: string | null
  reverted_by: string | null
  revert_of: string | null
  /** The type can be undone (state is checked again at undo time). */
  revertible: boolean
  /** A coach previewed undoing this in the last 24 h. */
  revert_suggested: boolean
}

interface ChangeRow {
  id: string
  created_at: string
  actor_type: ChangeActor['type']
  actor_id: string
  token_name: string | null
  tool: string
  target_type: string
  target_id: string | null
  diff: unknown
  rationale: string | null
  rule_refs: unknown
  approval_ref: string | null
  approval_id: string | null
  preview_id: string | null
  expires_on: string | null
  reverted_by: string | null
  revert_of: string | null
  revert_suggested?: boolean
}

function view(r: ChangeRow): ChangeView {
  const diff = asJson<unknown>(r.diff, {})
  return {
    id: r.id,
    created_at: r.created_at,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    who: actorLabel(r.actor_type, r.token_name),
    tool: r.tool,
    target_type: r.target_type,
    target_id: r.target_id,
    summary: summarizeChange({ tool: r.tool, target_type: r.target_type, diff }),
    diff,
    rationale: r.rationale,
    rule_refs: asJson<string[]>(r.rule_refs, []),
    approval_ref: r.approval_ref,
    approval_id: r.approval_id ?? null,
    preview_id: r.preview_id,
    expires_on: r.expires_on,
    reverted_by: r.reverted_by,
    revert_of: r.revert_of,
    revertible: !r.reverted_by && !r.revert_of && notRevertibleReason(r.tool, diff) == null,
    revert_suggested: r.revert_suggested === true && !r.reverted_by,
  }
}

const ACTOR_TYPES = new Set(['athlete', 'mcp', 'app_coach', 'system'])

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v.trim())
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export interface ChangePage {
  changes: ChangeView[]
  /** Pass back as `before` for the next (older) page; null at the end. */
  next_before: string | null
}

/**
 * Newest first, athlete-scoped. since/until: ISO date or timestamp.
 * target: a target_type ("program", "track", …) or a target id. actor: a
 * type ("mcp") or type:id ("mcp:<token id>"). before: the cursor from the
 * previous page. Null when the table is missing.
 */
export async function listChanges(
  store: ConnectedStore,
  opts: { since?: unknown; until?: unknown; target?: unknown; actor?: unknown; before?: unknown; limit?: unknown } = {},
): Promise<ChangePage | null> {
  const limit = Math.max(1, Math.min(100, typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.round(opts.limit) : 25))
  const since = isoOrNull(opts.since)
  const until = isoOrNull(opts.until)
  const target = typeof opts.target === 'string' && opts.target.trim() ? opts.target.trim() : null
  const actorRaw = typeof opts.actor === 'string' && opts.actor.trim() ? opts.actor.trim() : null
  const [actorType, ...actorRest] = actorRaw ? actorRaw.split(':') : [null]
  if (actorType && !ACTOR_TYPES.has(actorType)) return { changes: [], next_before: null }
  const actorId = actorRest.length ? actorRest.join(':') : null
  let beforeTs: string | null = null
  let beforeId: string | null = null
  if (typeof opts.before === 'string' && opts.before.includes('|')) {
    const [ts, id] = opts.before.split('|')
    if (isoOrNull(ts) && UUID_RE.test(id)) {
      beforeTs = ts
      beforeId = id
    }
  }
  try {
    const rows = await store.sql<ChangeRow[]>`
      SELECT c.id::text AS id, to_json(c.created_at) #>> '{}' AS created_at, c.actor_type, c.actor_id,
             t.name AS token_name, c.tool, c.target_type, c.target_id, c.diff, c.rationale, c.rule_refs,
             c.approval_ref, to_jsonb(c) ->> 'approval_id' AS approval_id, c.preview_id, c.expires_on::text AS expires_on,
             c.reverted_by::text AS reverted_by, c.revert_of::text AS revert_of,
             EXISTS (
               SELECT 1 FROM change_preview p
               WHERE p.athlete_id = c.athlete_id AND p.tool = 'revert_change' AND p.target_id = c.id::text
                 AND p.used_at IS NULL AND p.voided_at IS NULL
                 AND p.created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)
             ) AS revert_suggested
      FROM change_log c
      LEFT JOIN mcp_token t ON c.actor_type = 'mcp' AND t.athlete_id = c.athlete_id AND t.id::text = c.actor_id
      WHERE c.athlete_id = ${store.athleteId}
        AND (${since}::timestamptz IS NULL OR c.created_at >= ${since}::timestamptz)
        AND (${until}::timestamptz IS NULL OR c.created_at <= ${until}::timestamptz)
        AND (${target}::text IS NULL OR c.target_type = ${target}::text OR c.target_id = ${target}::text)
        AND (${actorType ?? null}::text IS NULL OR c.actor_type = ${actorType ?? null}::text)
        AND (${actorId}::text IS NULL OR c.actor_id = ${actorId}::text)
        AND (${beforeTs}::timestamptz IS NULL OR (c.created_at, c.id) < (${beforeTs}::timestamptz, ${beforeId}::uuid))
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${limit + 1}
    `
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return { changes: page.map(view), next_before: rows.length > limit && last ? `${last.created_at}|${last.id}` : null }
  } catch (e) {
    if (missingSchema(e)) return null
    throw e
  }
}

// ---- undo -------------------------------------------------------------------------

/** Why this kind of row can't be undone, or null when it can. */
export function notRevertibleReason(tool: string, diff: unknown): string | null {
  const d = obj(diff)
  switch (tool) {
    case 'apply_session_override':
    case 'update_track':
    case 'set_track_progression_rule':
    case 'update_athlete_target':
    case 'update_program_meta':
    case 'set_training_max':
      return null
    case 'apply_program_edits':
    case 'accept_proposal':
    case 'assign_exercise_to_track':
      if (d.timing === 'next_week') return 'This change queued a new block for next Monday; undo isn\'t available for a queued block. Ask your coach to change it.'
      if (Number(d.inserted ?? 0) > 0) return 'This change added a session. Undoing it would delete that session, so it can\'t be undone here.'
      return null
    case 'upsert_goal':
      return d.before == null ? 'This change created the goal. Undoing it would delete the goal, so it can\'t be undone here.' : null
    case 'create_track':
      return 'Undoing this would delete the track, so it can\'t be undone here.'
    case 'upsert_autoreg_rule':
      return 'Undoing this would delete the rule. Ask your coach to change it instead.'
    case 'log_goal_measurement':
    case 'add_workout_note':
      return 'Logged results and notes stay in your log; they aren\'t undone.'
    case 'clear_session_override':
      return 'This put a session back to the plan. Make the week-only change again instead.'
    case 'app_editor':
      return 'You made this in the program editor; change it there again.'
    case 'revoke_coach':
    case 'void_preview':
      return 'Access changes can\'t be undone. Invite the coach again instead.'
    case 'revert_change':
      return 'This is already an undo.'
    case 'apply_methodology_override':
      return 'Rule changes go back through your coach: ask them to preview clearing it, and approve that.'
    case 'log_checkin':
      return 'Check-ins stay in your log; log a new one to update today.'
    case 'clear_region':
      return 'A cleared region stays cleared. If it hurts again, log it in today\'s check-in.'
    case 'set_coach_health_access':
    case 'set_coach_role':
      return 'Change it again under Profile → Coach access.'
    case 'clear_red_flag':
      return 'A cleared red flag stays cleared. If it flares again, log it in today\'s check-in.'
    case 'log_session_rpe':
      return 'Session effort stays in your log; tap it again on the day to change it.'
    case 'apply_activity_change':
      return 'Change the activity again instead: ask your coach to preview it, and approve that.'
    case 'apply_composed_block':
      return 'A block is replaced, not undone: ask your coach to re-compose, and approve the new block.'
    case 'set_birth_date':
      return 'Your birth date is set once at intake.'
    default:
      return 'This kind of change can\'t be undone yet.'
  }
}

export type RevertResult =
  | { ok: true; change_id: string; summary: string; text: string }
  | { ok: false; reason: 'off' | 'unavailable' | 'not_found' | 'refused' | 'stale' | 'not_revertible'; text: string }

type Fail = Extract<RevertResult, { ok: false }>

interface RevertPlan {
  /** The new row's diff: the inverse, plus what it undid. */
  diff: Obj
  targetType: string
  targetId: string | null
  /** Runs inside the undo's transaction. Throws Refusal(stale) if a guard misses. */
  apply: (approvalRef: string, changeId: string) => Promise<void>
}

const stale = (what: string): Fail => ({
  ok: false,
  reason: 'stale',
  text: `Can't undo: ${what} changed since, so undoing would overwrite newer work. Ask your coach to look again.`,
})
const staleRefusal = (what: string) => new Refusal<RevertResult>(stale(what))

interface RoutineSnap {
  id: string
  name: string
  session_type: string | null
  exercises: unknown
  intent: string | null
  intended_dow: number | null
}

/** Routine rows as stored, owned by this athlete. What before/after snapshots hold. */
export async function routineSnapshots(store: ConnectedStore, ids: string[]): Promise<RoutineSnap[]> {
  const wanted = ids.filter((id) => UUID_RE.test(id))
  if (!wanted.length) return []
  const rows = await store.sql<RoutineSnap[]>`
    SELECT r.id::text AS id, r.name, r.session_type, r.exercises, r.intent, r.intended_dow
    FROM routine r JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId} AND r.id::text = ANY(${pgArrayLiteral(wanted)}::text[])
    ORDER BY r.id
  `
  return rows.map((r) => ({ ...r, exercises: asJson<unknown>(r.exercises, []) }))
}

/** Every routine in a phase, as stored. */
export async function phaseRoutineSnapshots(store: ConnectedStore, phaseId: string): Promise<RoutineSnap[]> {
  const rows = await store.sql<RoutineSnap[]>`
    SELECT r.id::text AS id, r.name, r.session_type, r.exercises, r.intent, r.intended_dow
    FROM routine r JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId} AND r.phase_id = ${phaseId}
    ORDER BY r.id
  `
  return rows.map((r) => ({ ...r, exercises: asJson<unknown>(r.exercises, []) }))
}

/** Routines a write changed: before and after snapshots of each, and how many it added. */
export function routineDelta(before: RoutineSnap[], after: RoutineSnap[]): { before: RoutineSnap[]; after: RoutineSnap[]; inserted: number } {
  const was = new Map(before.map((r) => [r.id, r]))
  const touched = after.filter((r) => was.has(r.id) && canonicalJson(r) !== canonicalJson(was.get(r.id)))
  return {
    before: touched.map((r) => was.get(r.id)!),
    after: touched,
    inserted: after.filter((r) => !was.has(r.id)).length,
  }
}

function invertRevision(revision: unknown): Obj {
  const r = obj(revision)
  const flip = (c: Obj): Obj => (c.kind === 'added'
    ? { ...c, kind: 'removed', before: c.after ?? null, after: null }
    : c.kind === 'removed'
      ? { ...c, kind: 'added', after: c.before ?? null, before: null }
      : { ...c, before: c.after ?? null, after: c.before ?? null })
  const sessions = (Array.isArray(r.sessions) ? r.sessions : []).map((s) => ({
    ...obj(s),
    changes: (Array.isArray(obj(s).changes) ? obj(s).changes as unknown[] : []).map((c) => flip(obj(c))),
  }))
  return {
    added: Number(r.removed ?? 0),
    removed: Number(r.added ?? 0),
    changed: Number(r.changed ?? 0),
    new_sessions: 0,
    sessions,
  }
}

async function planRoutines(store: ConnectedStore, tool: string, d: Obj): Promise<RevertPlan | Fail> {
  const before = (Array.isArray(d.before) ? d.before : []) as RoutineSnap[]
  const after = (Array.isArray(d.after) ? d.after : []) as RoutineSnap[]
  const current = new Map((await routineSnapshots(store, after.map((r) => r.id))).map((r) => [r.id, r]))
  for (const a of after) {
    const now = current.get(a.id)
    if (!now || canonicalJson(now) !== canonicalJson(a)) return stale(`the ${a.name} session`)
  }
  const spw = d.sessions_per_week ? obj(d.sessions_per_week) : null
  if (spw) {
    const [row] = await store.sql<{ n: number | null }[]>`SELECT sessions_per_week AS n FROM athlete WHERE id = ${store.athleteId}`
    if (Number(row?.n) !== Number(spw.after)) return stale('sessions per week')
  }
  const revision = invertRevision(d.revision)
  return {
    targetType: tool === 'assign_exercise_to_track' ? 'routine' : 'program',
    targetId: typeof d.phase_id === 'string' ? d.phase_id : null,
    diff: {
      before: after,
      after: before,
      ...(spw ? { sessions_per_week: { before: spw.after, after: spw.before } } : {}),
      ...(tool === 'assign_exercise_to_track' ? {} : { revision }),
    },
    apply: async () => {
      for (const b of before) {
        const a = after.find((x) => x.id === b.id)
        const done = await store.sql<{ id: string }[]>`
          UPDATE routine r
          SET name = ${b.name}, session_type = ${b.session_type}, exercises = ${jsonParam(store.sql, b.exercises)},
              intent = ${b.intent}, intended_dow = ${b.intended_dow}
          FROM program p
          WHERE r.id = ${b.id} AND r.program_id = p.id AND p.athlete_id = ${store.athleteId}
            AND r.exercises = ${jsonParam(store.sql, a?.exercises ?? null)}
          RETURNING r.id
        `
        if (!done.length) throw staleRefusal(`the ${b.name} session`)
      }
      if (spw) {
        await store.sql`
          UPDATE athlete SET sessions_per_week = ${Number(spw.before)}
          WHERE id = ${store.athleteId} AND sessions_per_week = ${Number(spw.after)}
        `
      }
      if (tool !== 'assign_exercise_to_track' && typeof d.program_id === 'string' && typeof d.phase_id === 'string') {
        // The program changed, so the journey records it like any other edit.
        await insertProgramRevision(store, { programId: d.program_id, phaseId: d.phase_id }, {
          trigger: 'editor',
          effectiveOn: await athleteToday(store),
          requests: [],
          snapshot: after.map((s) => ({ name: s.name, intent: s.intent, session_type: s.session_type, intended_dow: s.intended_dow, exercises: s.exercises })),
          diff: revision,
          summary: 'Undid a coach change',
        })
      }
    },
  }
}

const TRACK_FIELDS = ['name', 'color', 'icon', 'purpose', 'methodology_text', 'sources', 'sort_order', 'deload_policy', 'retest_policy'] as const

export async function trackSnapshot(store: ConnectedStore, trackId: string): Promise<Obj | null> {
  if (!UUID_RE.test(trackId)) return null
  const [row] = await store.sql<Obj[]>`
    SELECT t.name, t.color, t.icon, t.purpose, t.methodology_text, t.sources, t.sort_order, t.deload_policy, t.retest_policy
    FROM track t JOIN program p ON p.id = t.program_id
    WHERE t.id = ${trackId} AND p.athlete_id = ${store.athleteId}
    LIMIT 1
  `
  const jsonb = new Set(['sources', 'deload_policy', 'retest_policy'])
  return row ? Object.fromEntries(TRACK_FIELDS.map((k) => [k, jsonb.has(k) ? asJson<unknown>(row[k], null) : row[k] ?? null])) : null
}

const GOAL_FIELDS = ['name', 'metric', 'unit', 'side', 'direction', 'target', 'target_range_hi', 'due_date', 'test_protocol', 'cadence', 'source_metric', 'track_id'] as const

/**
 * The goal's definition. Not baseline/current/best/status: logging a
 * measurement moves those, and an undo of the definition must not.
 */
export async function goalSnapshot(store: ConnectedStore, ref: { id?: string | null; name?: string | null }): Promise<(Obj & { id: string }) | null> {
  const byId = ref.id && UUID_RE.test(ref.id) ? ref.id : null
  if (!byId && !ref.name) return null
  const [row] = await store.sql<Obj[]>`
    SELECT id::text AS id, name, metric, unit, side, direction, target::float8 AS target,
           target_range_hi::float8 AS target_range_hi, due_date::text AS due_date,
           test_protocol, cadence, source_metric, track_id::text AS track_id
    FROM athlete_goal
    WHERE athlete_id = ${store.athleteId}
      AND ((${byId}::text IS NOT NULL AND id::text = ${byId}::text) OR (${byId}::text IS NULL AND name = ${ref.name ?? null}::text))
    LIMIT 1
  `
  if (!row) return null
  return { id: String(row.id), ...Object.fromEntries(GOAL_FIELDS.map((k) => [k, row[k] ?? null])) }
}

const META_FIELDS = ['name', 'block_phase', 'start_date', 'end_date', 'deload_week_start', 'retest_start', 'retest_end'] as const

export async function programMetaSnapshot(store: ConnectedStore, programId: string): Promise<Obj | null> {
  if (!UUID_RE.test(programId)) return null
  const [row] = await store.sql<Obj[]>`
    SELECT name, block_phase, start_date::text AS start_date, end_date::text AS end_date,
           deload_week_start::text AS deload_week_start, retest_start::text AS retest_start, retest_end::text AS retest_end
    FROM program WHERE id = ${programId} AND athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return row ? Object.fromEntries(META_FIELDS.map((k) => [k, row[k] ?? null])) : null
}

export async function trainingMaxEntry(store: ConnectedStore, lift: string): Promise<unknown> {
  const [row] = await store.sql<{ entry: unknown }[]>`
    SELECT COALESCE(training_max_overrides, '{}'::jsonb) -> ${lift}::text AS entry FROM athlete WHERE id = ${store.athleteId}
  `
  return asJson<unknown>(row?.entry ?? null, null)
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

async function planRevert(store: ConnectedStore, tool: string, d: Obj): Promise<RevertPlan | Fail> {
  const reason = notRevertibleReason(tool, d)
  if (reason) return { ok: false, reason: 'not_revertible', text: `Can't undo: ${reason}` }
  switch (tool) {
    case 'apply_program_edits':
    case 'accept_proposal':
    case 'assign_exercise_to_track':
      return planRoutines(store, tool, d)
    case 'apply_session_override': {
      const ids = (Array.isArray(d.override_ids) ? d.override_ids : []).map(String).filter((id) => UUID_RE.test(id))
      if (!ids.length) return { ok: false, reason: 'not_revertible', text: 'Can\'t undo: this row names no override.' }
      const today = await athleteToday(store)
      const rows = await store.sql<{ id: string; voided: boolean; expires_on: string }[]>`
        SELECT id::text AS id, voided_at IS NOT NULL AS voided, expires_on::text AS expires_on
        FROM session_override
        WHERE athlete_id = ${store.athleteId} AND id::text = ANY(${pgArrayLiteral(ids)}::text[])
      `
      if (rows.length !== ids.length || rows.some((r) => r.voided)) return stale('that week-only change (it was cleared)')
      if (rows.every((r) => r.expires_on < today)) return { ok: false, reason: 'stale', text: 'Can\'t undo: that week-only change has already expired; there is nothing left to undo.' }
      return {
        targetType: 'session_override',
        targetId: ids[0],
        diff: { override_ids: ids, sessions: d.sessions ?? [] },
        apply: async (approvalRef, changeId) => {
          const voided = await store.sql<{ id: string }[]>`
            WITH v AS (
              UPDATE session_override
              SET voided_at = NOW(), void_approval_ref = ${approvalRef}::text, void_preview_id = ${`revert:${changeId}`}::text
              WHERE athlete_id = ${store.athleteId} AND voided_at IS NULL AND id::text = ANY(${pgArrayLiteral(ids)}::text[])
              RETURNING id, date, routine_id, expires_on
            ),
            logged AS (
              INSERT INTO session_override_log (
                athlete_id, actor_type, actor_id, tool, target, diff, rationale, approval_ref, preview_id, expires_on
              )
              SELECT ${store.athleteId}::uuid, 'athlete', ${store.athleteId}::text, 'revert_session_override',
                     jsonb_build_object('override_id', v.id, 'date', v.date, 'routine_id', v.routine_id, 'revert_of', ${changeId}::text),
                     '{}'::jsonb, 'Undone by the athlete.', ${approvalRef}::text, ${`revert:${changeId}`}::text, v.expires_on
              FROM v
              RETURNING id
            )
            SELECT id::text AS id FROM v
          `
          if (voided.length !== ids.length) throw staleRefusal('that week-only change')
        },
      }
    }
    case 'update_track': {
      const id = String(d.track_id ?? '')
      const now = await trackSnapshot(store, id)
      if (!now || !same(now, d.after)) return stale('that track')
      return {
        targetType: 'track',
        targetId: id,
        diff: { track_id: id, before: d.after, after: d.before },
        apply: async () => {
          const b = obj(d.before)
          const done = await store.sql<{ id: string }[]>`
            UPDATE track SET name = ${b.name as string}, color = ${(b.color ?? null) as string | null}, icon = ${(b.icon ?? null) as string | null},
                   purpose = ${(b.purpose ?? null) as string | null}, methodology_text = ${(b.methodology_text ?? null) as string | null},
                   sources = ${jsonParam(store.sql, b.sources ?? [])}, sort_order = ${Number(b.sort_order ?? 0)},
                   deload_policy = ${b.deload_policy == null ? null : jsonParam(store.sql, b.deload_policy)},
                   retest_policy = ${b.retest_policy == null ? null : jsonParam(store.sql, b.retest_policy)}
            WHERE id = ${id} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
            RETURNING id
          `
          if (!done.length) throw staleRefusal('that track')
        },
      }
    }
    case 'set_track_progression_rule': {
      const id = String(d.rule_id ?? '')
      if (!UUID_RE.test(id)) return { ok: false, reason: 'not_revertible', text: 'Can\'t undo: this row names no rule.' }
      const a = obj(d.after)
      const [row] = await store.sql<{ engine_type: string; params: unknown; active_to: string | null }[]>`
        SELECT pr.engine_type, pr.params, pr.active_to::text AS active_to
        FROM progression_rule pr JOIN program p ON p.id = pr.program_id
        WHERE pr.id = ${id} AND p.athlete_id = ${store.athleteId}
        LIMIT 1
      `
      if (!row || row.active_to != null || row.engine_type !== a.engine_type || !same(asJson(row.params, {}), a.params ?? {})) {
        return stale('that progression rule')
      }
      return {
        targetType: 'progression_rule',
        targetId: id,
        diff: { rule_id: id, before: { ...a, active_to: null }, after: { ...a, active_to: 'yesterday' } },
        apply: async () => {
          // Ended, not deleted: readers already skip a rule whose active_to has passed.
          const done = await store.sql<{ id: string }[]>`
            UPDATE progression_rule SET active_to = CURRENT_DATE - 1
            WHERE id = ${id} AND active_to IS NULL
              AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
            RETURNING id
          `
          if (!done.length) throw staleRefusal('that progression rule')
        },
      }
    }
    case 'upsert_goal': {
      const id = String(d.goal_id ?? '')
      const now = await goalSnapshot(store, { id })
      const after = obj(d.after)
      if (!now || !same(Object.fromEntries(GOAL_FIELDS.map((k) => [k, now[k] ?? null])), Object.fromEntries(GOAL_FIELDS.map((k) => [k, after[k] ?? null])))) {
        return stale('that goal')
      }
      const b = obj(d.before)
      return {
        targetType: 'athlete_goal',
        targetId: id,
        diff: { goal_id: id, before: d.after, after: d.before },
        apply: async () => {
          const done = await store.sql<{ id: string }[]>`
            UPDATE athlete_goal SET
              name = ${b.name as string}, metric = ${b.metric as string}, unit = ${(b.unit ?? null) as string | null},
              side = ${(b.side ?? null) as string | null}, direction = ${b.direction as string},
              target = ${(b.target ?? null) as number | null}, target_range_hi = ${(b.target_range_hi ?? null) as number | null},
              due_date = ${(b.due_date ?? null) as string | null},
              test_protocol = ${(b.test_protocol ?? null) as string | null}, cadence = ${(b.cadence ?? null) as string | null},
              source_metric = ${(b.source_metric ?? null) as string | null}, track_id = ${(b.track_id ?? null) as string | null},
              updated_at = NOW()
            WHERE id = ${id} AND athlete_id = ${store.athleteId}
            RETURNING id
          `
          if (!done.length) throw staleRefusal('that goal')
        },
      }
    }
    case 'update_athlete_target': {
      const [row] = await store.sql<{ goals: string | null }[]>`SELECT goals FROM athlete WHERE id = ${store.athleteId}`
      if (!same(row?.goals ?? null, obj(d.after).goals ?? null)) return stale('your target')
      const before = (obj(d.before).goals ?? null) as string | null
      return {
        targetType: 'athlete',
        targetId: store.athleteId,
        diff: { before: d.after, after: d.before },
        apply: async () => {
          await store.sql`UPDATE athlete SET goals = ${before} WHERE id = ${store.athleteId}`
        },
      }
    }
    case 'update_program_meta': {
      const id = String(d.program_id ?? '')
      const now = await programMetaSnapshot(store, id)
      if (!now || !same(now, d.after)) return stale('the block details')
      const b = obj(d.before)
      return {
        targetType: 'program',
        targetId: id,
        diff: { program_id: id, before: d.after, after: d.before },
        apply: async () => {
          const done = await store.sql<{ id: string }[]>`
            UPDATE program SET
              name = ${(b.name ?? null) as string | null}, block_phase = ${(b.block_phase ?? null) as string | null},
              start_date = ${(b.start_date ?? null) as string | null}::date, end_date = ${(b.end_date ?? null) as string | null}::date,
              deload_week_start = ${(b.deload_week_start ?? null) as string | null}::date,
              retest_start = ${(b.retest_start ?? null) as string | null}::date, retest_end = ${(b.retest_end ?? null) as string | null}::date
            WHERE id = ${id} AND athlete_id = ${store.athleteId}
            RETURNING id
          `
          if (!done.length) throw staleRefusal('the block details')
        },
      }
    }
    case 'set_training_max': {
      const lift = String(d.lift ?? '')
      if (!/^(squat|bench|deadlift|ohp)$/.test(lift)) return { ok: false, reason: 'not_revertible', text: 'Can\'t undo: this row names no lift.' }
      if (!same(await trainingMaxEntry(store, lift), d.after)) return stale(`the ${lift} training max`)
      const before = d.before ?? null
      return {
        targetType: 'training_max',
        targetId: lift,
        diff: { lift, before: d.after ?? null, after: before },
        apply: async () => {
          // Only the lift this change set, and only back to what it was.
          const json = before == null ? null : JSON.stringify(before)
          await store.sql`
            UPDATE athlete SET training_max_overrides = CASE
              WHEN ${json}::jsonb IS NULL THEN COALESCE(training_max_overrides, '{}'::jsonb) - ${lift}::text
              ELSE COALESCE(training_max_overrides, '{}'::jsonb) || jsonb_build_object(${lift}::text, ${json}::jsonb)
            END
            WHERE id = ${store.athleteId}
          `
        },
      }
    }
    default:
      return { ok: false, reason: 'not_revertible', text: 'Can\'t undo: this kind of change can\'t be undone yet.' }
  }
}

interface LoadedChange {
  id: string
  tool: string
  target_type: string
  diff: unknown
  reverted_by: string | null
  revert_of: string | null
}

async function loadChange(store: ConnectedStore, changeId: string, lock: boolean): Promise<LoadedChange | null> {
  if (!UUID_RE.test(changeId)) return null
  const rows = lock
    ? await store.sql<LoadedChange[]>`
        SELECT id::text AS id, tool, target_type, diff, reverted_by::text AS reverted_by, revert_of::text AS revert_of
        FROM change_log WHERE id = ${changeId} AND athlete_id = ${store.athleteId}
        FOR UPDATE
      `
    : await store.sql<LoadedChange[]>`
        SELECT id::text AS id, tool, target_type, diff, reverted_by::text AS reverted_by, revert_of::text AS revert_of
        FROM change_log WHERE id = ${changeId} AND athlete_id = ${store.athleteId}
      `
  return rows[0] ? { ...rows[0], diff: asJson<unknown>(rows[0].diff, {}) } : null
}

function precheck(row: LoadedChange | null): Fail | null {
  if (!row) return { ok: false, reason: 'not_found', text: 'No such change.' }
  if (row.revert_of) return { ok: false, reason: 'not_revertible', text: 'Can\'t undo: this is already an undo.' }
  if (row.reverted_by) return { ok: false, reason: 'refused', text: 'Already undone.' }
  return null
}

/**
 * The athlete's one-tap undo. Writes a new change_log row (revert_of = the
 * original), sets reverted_by on the original, and restores the target — all
 * in one transaction, or nothing. Only the athlete's own session may call it;
 * a coach previews (previewRevert) and the athlete taps.
 */
export async function revertChange(store: ConnectedStore, actor: ChangeActor, changeId: string): Promise<RevertResult> {
  if (actor.type !== 'athlete' || actor.id !== store.athleteId) {
    return { ok: false, reason: 'refused', text: 'Refused: only the athlete can undo a change. A coach can suggest it with preview_revert_change.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, reason: 'off', text: 'The change log is off for this athlete.' }
  try {
    return await withTx(store.sql, async () => {
      const row = await loadChange(store, changeId, true)
      const pre = precheck(row)
      if (pre) throw new Refusal<RevertResult>(pre)
      const plan = await planRevert(store, row!.tool, obj(row!.diff))
      if ('ok' in plan) throw new Refusal<RevertResult>(plan)
      const summary = summarizeChange({ tool: row!.tool, target_type: row!.target_type, diff: row!.diff })
      const newId = crypto.randomUUID()
      // The athlete's tap on Undo is the preview and the approval (G10): a
      // real approval row, consumed by this undo's change_log row.
      const tap = await directTapApproval(store, 'revert', `revert:${row!.id}`, plan.diff)
      const approvalRef = tap.ref
      await plan.apply(approvalRef, newId)
      await writeChange(store, {
        id: newId,
        actor,
        tool: 'revert_change',
        targetType: plan.targetType,
        targetId: plan.targetId,
        diff: { ...plan.diff, undid: summary, undid_tool: row!.tool },
        rationale: 'Undone by the athlete.',
        ruleRefs: [],
        approvalRef,
        approvalId: tap.id,
        revertOf: row!.id,
      })
      if (!(await consumeApproval(store, tap.id, newId))) throw new ApprovalSpent()
      const claimed = await store.sql<{ id: string }[]>`
        UPDATE change_log SET reverted_by = ${newId}
        WHERE id = ${row!.id} AND athlete_id = ${store.athleteId} AND reverted_by IS NULL
        RETURNING id
      `
      if (!claimed.length) throw new Refusal<RevertResult>({ ok: false, reason: 'refused', text: 'Already undone.' })
      // A coach's suggestion to undo this is spent.
      await store.sql`
        UPDATE change_preview SET used_at = NOW()
        WHERE athlete_id = ${store.athleteId} AND tool = 'revert_change' AND target_id = ${row!.id}
          AND used_at IS NULL AND voided_at IS NULL
      `
      await store.sql`
        INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
        VALUES (${store.athleteId}, 'coach', 'note', ${`You undid: ${summary}`}, ${null})
      `
      return { ok: true as const, change_id: newId, summary, text: `Undone: ${summary}` }
    })
  } catch (e) {
    if (e instanceof Refusal) return e.result as RevertResult
    if (e instanceof ApprovalSpent) return { ok: false, reason: 'refused', text: e.message }
    if (missingSchema(e)) return { ok: false, reason: 'unavailable', text: changeLogUnavailable }
    throw e
  }
}

/**
 * What undoing a row would do, for a coach to suggest. Writes no change; a
 * coach's preview is kept (tool revert_change) so the athlete's feed shows
 * the suggestion. There is no coach-side apply.
 */
export async function previewRevert(store: ConnectedStore, actor: ChangeActor, changeId: string, rationale: string | null): Promise<string> {
  const row = await loadChange(store, changeId, false)
  const pre = precheck(row)
  if (pre) return pre.text
  const plan = await planRevert(store, row!.tool, obj(row!.diff))
  if ('ok' in plan) return plan.text
  const summary = summarizeChange({ tool: row!.tool, target_type: row!.target_type, diff: row!.diff })
  const previewId = await storeChangePreview(store, actor, 'revert_change', { change_id: row!.id, inverse: plan.diff }, {
    rationale,
    targetId: row!.id,
  })
  return [
    '# Preview: undo a change',
    `Undo: ${summary}`,
    '',
    '## What undoing restores',
    JSON.stringify(plan.diff, null, 2),
    '',
    `preview_id: ${previewId}`,
    'Nothing was written. Only the athlete can undo: it now shows as suggested on this change in their Changes feed (Program → Changes), and their tap is the approval. There is no coach-side apply.',
  ].join('\n')
}

// ---- MCP --------------------------------------------------------------------------

export const CHANGE_LOG_TOOLS: McpTool[] = [
  {
    name: 'get_change_log',
    description: 'Every recorded change to this athlete, newest first: who (athlete, a coach via MCP, the in-app coach, system), the tool, the target, the before → after diff, the rationale and rule refs (U1–U15), the approval, the preview it applied, and whether it was undone. Use it to see what other coaches did before you propose. Paginate with before = next_before.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date or timestamp, inclusive.' },
        target: { type: 'string', description: 'A target type (program, routine, track, progression_rule, athlete_goal, session_override, training_max, …) or a target id.' },
        actor: { type: 'string', description: 'athlete | mcp | app_coach | system, or type:id (e.g. mcp:<token id>).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' },
        before: { type: 'string', description: 'Cursor from next_before for the next (older) page.' },
      },
      required: ['since'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_revert_change',
    description: 'Preview undoing one change_log row: what it would restore, or why it can\'t (the target changed since, it was already undone, or undoing would delete data). Writes nothing. Only the athlete can undo; this marks the change as suggested in their Changes feed and their tap applies it.',
    inputSchema: {
      type: 'object',
      properties: {
        change_id: { type: 'string', description: 'id from get_change_log.' },
        rationale: { type: 'string', description: 'Why, in the athlete\'s terms.' },
      },
      required: ['change_id'],
      additionalProperties: false,
    },
  },
]

export const CHANGE_LOG_TOOL_NAMES = new Set(CHANGE_LOG_TOOLS.map((t) => t.name))

/** change_log target types that carry health data (G4, G9, D3). */
const HEALTH_TARGETS = new Set(['checkin', 'region', 'session_rpe'])

/** A per-region pain rule (U7.regions.<region>.*): which region is capped or red-flagged is health data too. */
const healthRuleRow = (c: { target_type: string; target_id: string | null }) =>
  c.target_type === 'methodology' && /^U7\.regions\./.test(c.target_id ?? '')

/** Rules whose reasons are readiness and pain (U6, U7): a rationale citing them can quote check-ins or pain. */
const HEALTH_RULES = new Set(['U6', 'U7'])

export async function runChangeLogTool(store: ConnectedStore, name: string, args: Obj, actor: ChangeActor): Promise<string> {
  if (!(await tracksV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  switch (name) {
    case 'get_change_log': {
      if (!isoOrNull(args.since)) throw new McpUserError('since is required: an ISO date or timestamp')
      const health = await seesHealth(store, actor)
      // D3: filtering by one region's pain rule would say, by whether anything
      // comes back, whether that region was capped or red-flagged. Answered the
      // same either way.
      const asked = typeof args.target === 'string' ? args.target.trim() : ''
      if (!health && /^U7\.regions\./.test(asked)) {
        return 'Pain rules for a region are health data the athlete hasn\'t shared with you. Ask the athlete.'
      }
      const page = await listChanges(store, args)
      if (page == null) return changeLogUnavailable.replace(' Nothing was written.', '')
      if (!page.changes.length) return 'No changes in that window.'
      // D3: check-ins, pain, region clears, per-region pain rules and session RPE are
      // health data. A coach the athlete hasn't shared them with sees that a row
      // exists, not what it says; and another actor's rationale citing U6/U7 (which
      // can quote pain or check-ins) is withheld.
      if (!health) {
        const own = (c: { actor_type: string; actor_id: string }) => c.actor_type === actor.type && c.actor_id === actor.id
        page.changes = page.changes.map((c) => (HEALTH_TARGETS.has(c.target_type) || healthRuleRow(c)
          ? {
              ...c, target_id: null, diff: { hidden: true }, rationale: null, rule_refs: [],
              summary: c.target_type === 'session_rpe' ? 'Session effort (not shared with you)'
                : healthRuleRow(c) ? 'Pain rule for a region (not shared with you)'
                  : 'Health check-in (not shared with you)',
            }
          : c.rationale && !own(c) && c.rule_refs.some((r) => HEALTH_RULES.has(r))
            ? { ...c, rationale: 'A health-related reason (not shared with you).' }
            : c))
      }
      return JSON.stringify({
        changes: page.changes.map((c) => ({
          id: c.id,
          at: c.created_at,
          who: c.who,
          actor: `${c.actor_type}:${c.actor_id}`,
          tool: c.tool,
          target: { type: c.target_type, id: c.target_id },
          summary: c.summary,
          diff: c.diff,
          rationale: c.rationale,
          rule_refs: c.rule_refs,
          approval_ref: c.approval_ref,
          approval_id: c.approval_id,
          preview_id: c.preview_id,
          expires_on: c.expires_on,
          reverted_by: c.reverted_by,
          revert_of: c.revert_of,
          revertible: c.revertible,
        })),
        next_before: page.next_before,
      }, null, 2)
    }
    case 'preview_revert_change': {
      const id = typeof args.change_id === 'string' ? args.change_id.trim() : ''
      if (!id) throw new McpUserError('change_id is required')
      const why = typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim() : null
      return previewRevert(store, actor, id, why)
    }
    default:
      throw new McpUserError(`Unknown tool: ${name}`)
  }
}

/**
 * For write paths outside a tool call (the data route): is the log on for this
 * athlete. Read through to_jsonb so it answers false, never throws, on a
 * database without athlete.flags.
 */
export async function changeLogOnFor(sql: Sql, athleteId: string): Promise<boolean> {
  const [row] = await sql<{ on: boolean | null }[]>`
    SELECT (to_jsonb(a) #> '{flags,tracks_v1}') = 'true'::jsonb AS on FROM athlete a WHERE a.id = ${athleteId}
  `
  return row?.on === true
}
