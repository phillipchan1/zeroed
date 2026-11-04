/**
 * Week-only session overrides (G1, tracks_v1). A coach or the athlete changes
 * ONE dated session — add, swap, drop or adjust an exercise, or move an
 * exercise or the whole session to another day — and the template is never
 * written. /api/session-rx reads the override for that exact date only.
 *
 * Writes follow the propose-only contract:
 *   preview  → a stored preview (preview_id + diff). Writes no override.
 *   apply    → confirm=true, a preview under 24 h old whose diff still
 *              matches, and an approval_ref. The athlete's own app session
 *              approves with tap:<id> (minted here, never taken from a
 *              client). An MCP coach passes the chat message where the
 *              athlete said yes (msg:<id>). app_coach can never supply one: it
 *              parks a coach_proposal and the athlete accepts it in the app.
 *   clear    → the same preview / apply pair, recorded the same way.
 * Every apply and clear adds a session_override_log row per override row and,
 * in the same statement, one change_log row (G2) for the whole write.
 *
 * Tables are hand-applied on Neon (worker/schema/session-override.sql). Until
 * they exist, every function here reads as "no overrides" or "unavailable".
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import type { ExerciseTemplate } from '../../src/types/database.ts'
import { mcpStamp } from '../../src/engine/mcpStamp.ts'
import {
  addDays, applyOverrideOps, daysBetween, defaultExpiresOn, diffOverride, doseLine, findExercise, isIsoDate,
  MAX_FUTURE_DAYS, MAX_MOVE_DAYS, MAX_PAST_DAYS, normalizeInputOps, overrideActive, overrideView,
  resolveExpiresOn, shortDateLabel, WEEK_ONLY_LABEL,
  type OverrideChange, type OverrideInputOp, type OverrideOp, type SessionOverrideView, type StoredOverride,
} from '../../src/engine/sessionOverride.ts'
import { beginAuthCors, json } from './cors.ts'
import { asJson, jsonParam, pgArrayLiteral, withSql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { calendarZone, loadLiveProgram, makeStore, type ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'
import { ruleRefsFrom } from './changeSummary.ts'

export type ActorType = 'athlete' | 'mcp' | 'app_coach' | 'system'

export interface OverrideActor {
  type: ActorType
  id: string
}

/** The in-app coach. Same tools as any coach, no approval power. */
export const APP_COACH: OverrideActor = { type: 'app_coach', id: 'app_coach' }

export const PREVIEW_TTL_HOURS = 24

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_BODY = /^[A-Za-z0-9._:-]{1,128}$/

function missingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return code === '42P01' || code === '42703'
}

const unavailable = 'Week-only overrides are not set up on this database yet.'
const flagOff = 'Week-only overrides are off for this athlete.'

// ---- flag, clock --------------------------------------------------------------

export async function tracksV1On(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ on: boolean | null }[]>`
    SELECT (flags->'tracks_v1') = 'true'::jsonb AS on FROM athlete WHERE id = ${store.athleteId}
  `
  return row?.on === true
}

export async function athleteToday(store: ConnectedStore, now: Date = new Date()): Promise<string> {
  const [row] = await store.sql<{ time_zone: string | null }[]>`
    SELECT time_zone FROM athlete WHERE id = ${store.athleteId} LIMIT 1
  `
  return mcpStamp(now, calendarZone(row?.time_zone)).local_date
}

// ---- approval -----------------------------------------------------------------

/**
 * Null when this actor may write with this approval_ref; otherwise why not.
 * Standing approval covers logging only, so it never covers an override.
 */
export function approvalProblem(actor: OverrideActor, ref: unknown): string | null {
  if (actor.type === 'app_coach') {
    return 'Refused: app_coach cannot supply approval_ref. Park it with propose=true so the athlete accepts it in the app.'
  }
  if (actor.type === 'system') return 'Refused: system writes cannot approve an override.'
  if (typeof ref !== 'string' || !ref.trim()) {
    return 'Refused: approval_ref is required (the message id where the athlete said yes). Overrides are not covered by standing approval.'
  }
  const r = ref.trim()
  if (r.startsWith('standing:')) return 'Refused: standing approval covers logging only, not session overrides.'
  if (actor.type === 'mcp') {
    if (r.startsWith('tap:')) return 'Refused: tap approvals come from the athlete\'s app, not from a coach.'
    if (!r.startsWith('msg:') || !REF_BODY.test(r.slice(4))) {
      return 'Refused: approval_ref must be msg:<message id> — the chat message where the athlete said yes.'
    }
    return null
  }
  if (!r.startsWith('tap:') || !REF_BODY.test(r.slice(4))) return 'Refused: the athlete approves with a tap.'
  return null
}

// ---- reads --------------------------------------------------------------------

interface OverrideRow extends StoredOverride {
  routine_id: string
  pair_id: string | null
}

function asRow(r: { id: string; routine_id: string; date: string; expires_on: string; ops: unknown; pair_id: string | null; voided_at?: string | null }): OverrideRow {
  return { ...r, ops: asJson<OverrideOp[]>(r.ops, []), voided_at: r.voided_at ?? null }
}

async function rowsOn(store: ConnectedStore, date: string): Promise<OverrideRow[]> {
  const rows = await store.sql<{ id: string; routine_id: string; date: string; expires_on: string; ops: unknown; pair_id: string | null }[]>`
    SELECT id, routine_id::text AS routine_id, date::text AS date, expires_on::text AS expires_on, ops,
           pair_id::text AS pair_id
    FROM session_override
    WHERE athlete_id = ${store.athleteId} AND date = ${date} AND voided_at IS NULL
    ORDER BY created_at, id
  `
  return rows.map(asRow)
}

/** A routine's template, only if this athlete owns it. */
async function ownedRoutine(store: ConnectedStore, routineId: string): Promise<{ id: string; name: string; exercises: ExerciseTemplate[] } | null> {
  if (!UUID_RE.test(routineId)) return null
  const [row] = await store.sql<{ id: string; name: string; exercises: unknown }[]>`
    SELECT r.id, r.name, r.exercises
    FROM routine r
    JOIN program p ON p.id = r.program_id
    WHERE r.id = ${routineId} AND p.athlete_id = ${store.athleteId}
    LIMIT 1
  `
  return row ? { id: row.id, name: row.name, exercises: asJson<ExerciseTemplate[]>(row.exercises, []) } : null
}

/** A session by routine id, or by name across the live (and queued) week. */
async function resolveSession(store: ConnectedStore, ref: string): Promise<{ id: string; name: string } | { error: string }> {
  if (UUID_RE.test(ref)) {
    const owned = await ownedRoutine(store, ref)
    return owned ? { id: owned.id, name: owned.name } : { error: `No session ${ref} on this athlete.` }
  }
  const live = await loadLiveProgram(store)
  if (!live) return { error: 'No active program.' }
  const sessions = [...live.sessions, ...live.scheduledSessions].map((s) => ({ name: s.name, id: s.routineId }))
  const hit = findExercise(sessions, ref)
  if ('error' in hit) {
    return { error: hit.error.includes('more than one')
      ? `"${ref}" matches more than one session; use its routine id.`
      : `No session named "${ref}" this week.` }
  }
  return { id: sessions[hit.index].id, name: sessions[hit.index].name }
}

// ---- session-rx ----------------------------------------------------------------

export interface OverrideContext {
  date: string
  forRoutine(routineId: string, base: ExerciseTemplate[]): SessionOverrideView | null
}

/**
 * What /api/session-rx needs to apply overrides for one request. Null — and
 * the caller takes today's path untouched — when no date was sent, the flag
 * is off, the tables are missing, or nothing is overridden on that date.
 */
export async function overrideContextFor(store: ConnectedStore, date: unknown): Promise<OverrideContext | null> {
  if (!isIsoDate(date)) return null
  if (!(await tracksV1On(store))) return null
  let rows: OverrideRow[]
  try {
    rows = await rowsOn(store, date)
  } catch (e) {
    if (missingSchema(e)) return null
    throw e
  }
  if (!rows.length) return null
  const today = await athleteToday(store)
  return {
    date,
    forRoutine: (routineId, base) => overrideView(base, rows.filter((r) => r.routine_id === routineId), date, today),
  }
}

// ---- plans ------------------------------------------------------------------------

interface CreateRequest {
  date: string
  routine_id: string
  ops: OverrideInputOp[]
  expires_on: string | null
}

interface PlannedRow {
  date: string
  routine_id: string
  session: string
  ops: OverrideOp[]
  expires_on: string
  paired: boolean
}

export interface DiffRow {
  date: string
  routine_id: string
  session: string
  label: string
  expires_on: string
  changes: OverrideChange[]
  /** The whole session as it would be served after this write. Part of the
   *  match on apply, so any change to that day since the preview makes it stale. */
  result: string[]
}

type Plan = { rows: PlannedRow[]; diff: DiffRow[] } | { error: string }

class PlanCache {
  private byDate = new Map<string, OverrideRow[]>()
  private routines = new Map<string, { id: string; name: string; exercises: ExerciseTemplate[] } | null>()
  private store: ConnectedStore
  private today: string
  constructor(store: ConnectedStore, today: string) {
    this.store = store
    this.today = today
  }
  async active(date: string, routineId: string): Promise<OverrideRow[]> {
    if (!this.byDate.has(date)) this.byDate.set(date, await rowsOn(this.store, date))
    return this.byDate.get(date)!.filter((r) => r.routine_id === routineId && overrideActive(r, date, this.today))
  }
  async routine(id: string) {
    if (!this.routines.has(id)) this.routines.set(id, await ownedRoutine(this.store, id))
    return this.routines.get(id)!
  }
}

function inWindow(date: string, today: string): boolean {
  const d = daysBetween(today, date)
  return d >= -MAX_PAST_DAYS && d <= MAX_FUTURE_DAYS
}

async function diffRows(cache: PlanCache, rows: PlannedRow[], exclude: Set<string> = new Set()): Promise<DiffRow[] | { error: string }> {
  const out: DiffRow[] = []
  for (const row of rows) {
    const routine = await cache.routine(row.routine_id)
    if (!routine) return { error: 'That session is not on this athlete.' }
    const existing = await cache.active(row.date, row.routine_id)
    const before = applyOverrideOps(routine.exercises, existing.map((r) => r.ops))
    const after = applyOverrideOps(
      routine.exercises,
      [...existing.filter((r) => !exclude.has(r.id)).map((r) => r.ops), row.ops],
    )
    if (after.errors.length > before.errors.length) {
      return { error: `${routine.name} on ${shortDateLabel(row.date)}: ${after.errors.slice(before.errors.length).join('; ')}` }
    }
    const changes = diffOverride(before, after)
    out.push({
      date: row.date,
      routine_id: row.routine_id,
      session: routine.name,
      label: `${routine.name} · ${shortDateLabel(row.date)}`,
      expires_on: row.expires_on,
      changes,
      result: after.exercises.map((ex) => `${ex.name} — ${doseLine(ex)}`),
    })
  }
  return out
}

async function planCreate(store: ConnectedStore, req: CreateRequest, today: string): Promise<Plan> {
  if (!inWindow(req.date, today)) {
    return { error: `date must be within ${MAX_PAST_DAYS} days back and ${MAX_FUTURE_DAYS} days ahead of today (${today}).` }
  }
  const expires = resolveExpiresOn(req.date, req.expires_on)
  if (!expires) return { error: 'expires_on must be on or after date and at most 7 days after it.' }
  if (expires < today) return { error: `An override for ${req.date} would already be expired (expires ${expires}).` }

  const cache = new PlanCache(store, today)
  const source = await cache.routine(req.routine_id)
  if (!source) return { error: 'That session is not on this athlete.' }
  const rows = new Map<string, PlannedRow>()
  const rowFor = (date: string, routineId: string, name: string, expiresOn: string): PlannedRow => {
    const key = `${date}|${routineId}`
    let row = rows.get(key)
    if (!row) {
      row = { date, routine_id: routineId, session: name, ops: [], expires_on: expiresOn, paired: false }
      rows.set(key, row)
    }
    return row
  }
  const src = rowFor(req.date, source.id, source.name, expires)

  for (const op of req.ops) {
    if (op.op !== 'move') {
      src.ops.push(op)
      continue
    }
    const gap = daysBetween(req.date, op.to_date)
    if (gap === 0) return { error: 'move to_date must differ from date.' }
    if (Math.abs(gap) > MAX_MOVE_DAYS) return { error: `A move lands within ${MAX_MOVE_DAYS} days of where it started.` }
    if (!inWindow(op.to_date, today)) return { error: `to_date must be within ${MAX_PAST_DAYS} days back and ${MAX_FUTURE_DAYS} days ahead.` }
    const toExpires = defaultExpiresOn(op.to_date)
    if (toExpires < today) return { error: `${op.to_date} is in a week that has already ended.` }
    let target = { id: source.id, name: source.name }
    if (op.to_session) {
      const hit = await resolveSession(store, op.to_session)
      if ('error' in hit) return { error: hit.error }
      target = hit
    }
    if (!op.exercise_name) {
      if (target.id !== source.id) return { error: 'A whole session moves to another day as itself; leave to_session out.' }
      // The session moves as it stands that day, edits included.
      const existing = await cache.active(req.date, source.id)
      const asIs = applyOverrideOps(source.exercises, existing.map((r) => r.ops))
      src.ops.push({ op: 'move_out', exercise_name: null, to_date: op.to_date })
      rowFor(op.to_date, source.id, source.name, toExpires).ops.push({
        op: 'move_in', from_date: req.date, exercise: null, session: asIs.exercises,
      })
    } else {
      // The exercise as it stands on the source date after the ops before it.
      const existing = await cache.active(req.date, source.id)
      const now = applyOverrideOps(source.exercises, [...existing.map((r) => r.ops), src.ops])
      const hit = findExercise(now.exercises, op.exercise_name)
      if ('error' in hit) return { error: `${source.name} on ${shortDateLabel(req.date)}: ${hit.error}` }
      const exercise = now.exercises[hit.index]
      if (!(await cache.routine(target.id))) return { error: 'That target session is not on this athlete.' }
      src.ops.push({ op: 'move_out', exercise_name: exercise.name, to_date: op.to_date })
      rowFor(op.to_date, target.id, target.name, toExpires).ops.push({ op: 'move_in', from_date: req.date, exercise: { ...exercise } })
    }
    src.paired = true
    rowFor(op.to_date, target.id, target.name, toExpires).paired = true
  }

  const planned = [...rows.values()].filter((r) => r.ops.length > 0)
  const diff = await diffRows(cache, planned)
  if ('error' in diff) return diff
  if (diff.every((d) => d.changes.length === 0)) return { error: 'These ops change nothing on that date.' }
  return { rows: planned, diff }
}

async function planClear(store: ConnectedStore, ids: string[], today: string): Promise<{ ids: string[]; diff: DiffRow[] } | { error: string }> {
  const wanted = ids.filter((id) => UUID_RE.test(id))
  if (!wanted.length) return { error: 'override_id is required.' }
  const rows = await store.sql<{ id: string; routine_id: string; date: string; expires_on: string; ops: unknown; pair_id: string | null }[]>`
    SELECT id, routine_id::text AS routine_id, date::text AS date, expires_on::text AS expires_on, ops, pair_id::text AS pair_id
    FROM session_override
    WHERE athlete_id = ${store.athleteId} AND voided_at IS NULL
      AND (id::text = ANY(${pgArrayLiteral(wanted)}::text[])
        OR pair_id::text IN (
          SELECT pair_id::text FROM session_override
          WHERE athlete_id = ${store.athleteId} AND id::text = ANY(${pgArrayLiteral(wanted)}::text[]) AND pair_id IS NOT NULL
        ))
    ORDER BY date, created_at, id
  `
  const found = rows.map(asRow)
  if (!wanted.every((id) => found.some((r) => r.id === id))) return { error: 'No active override with that id on this athlete.' }
  const live = found.filter((r) => r.expires_on >= today)
  if (!live.length) return { error: 'That override has already expired; it no longer applies.' }
  const cache = new PlanCache(store, today)
  const exclude = new Set(live.map((r) => r.id))
  const seen = new Set<string>()
  const targets: PlannedRow[] = []
  for (const r of live) {
    const key = `${r.date}|${r.routine_id}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ date: r.date, routine_id: r.routine_id, session: '', ops: [], expires_on: r.expires_on, paired: false })
  }
  const diff = await diffRows(cache, targets, exclude)
  if ('error' in diff) return diff
  return { ids: live.map((r) => r.id).sort(), diff }
}

// ---- previews ---------------------------------------------------------------------

/** JSON with sorted keys: a diff read back from JSONB compares equal to a fresh one. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value))
}

function newPreviewId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `sop_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function formatDiff(diff: DiffRow[]): string {
  return diff.map((d) => [
    `### ${d.label} (${WEEK_ONLY_LABEL.toLowerCase()}, expires ${d.expires_on})`,
    ...(d.changes.length
      ? d.changes.map((c) => {
          const sign = c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'
          const rx = c.kind === 'changed' ? `${c.before} → ${c.after}` : c.after ?? c.before ?? ''
          return `${sign} ${c.name}${rx ? ` — ${rx}` : ''}`
        })
      : ['(back to the plan)']),
    `Session that day: ${d.result.length ? d.result.join('; ') : 'none (moved)'}`,
  ].join('\n')).join('\n\n')
}

/** The shape ProposalCard already renders. */
function proposalDiff(diff: DiffRow[]): Record<string, unknown> {
  return { sessions: diff.map((d) => ({ name: d.label, changes: d.changes })) }
}

export interface PreviewOk {
  ok: true
  preview_id: string
  diff: DiffRow[]
  text: string
}
export type PreviewResult = PreviewOk | { ok: false; text: string }

async function storePreview(
  store: ConnectedStore,
  actor: OverrideActor,
  kind: 'create' | 'clear',
  request: unknown,
  diff: DiffRow[],
  rationale: string | null,
): Promise<string> {
  const previewId = newPreviewId()
  await store.sql`
    INSERT INTO session_override_preview (athlete_id, preview_id, kind, request, diff, actor_type, actor_id, rationale)
    VALUES (${store.athleteId}, ${previewId}, ${kind}, ${jsonParam(store.sql, request)}, ${jsonParam(store.sql, diff)},
            ${actor.type}, ${actor.id}, ${rationale})
  `
  return previewId
}

function previewText(previewId: string, diff: DiffRow[], kind: 'create' | 'clear'): string {
  return [
    kind === 'create' ? '# Preview: week-only session override' : '# Preview: clear a week-only override',
    'The program template is not touched. Nothing is written until apply.',
    '',
    formatDiff(diff),
    '',
    `preview_id: ${previewId} (valid ${PREVIEW_TTL_HOURS} h, and only while this diff still matches)`,
    'Apply with apply_session_override(preview_id, confirm=true, approval_ref=msg:<id of the message where the athlete said yes>), or park it for the athlete with propose=true.',
  ].join('\n')
}

export async function previewCreate(
  store: ConnectedStore,
  actor: OverrideActor,
  args: { date: unknown; session: unknown; ops: unknown; expires_on?: unknown; rationale?: unknown },
): Promise<PreviewResult> {
  if (!(await tracksV1On(store))) return { ok: false, text: flagOff }
  if (!isIsoDate(args.date)) return { ok: false, text: 'date must be YYYY-MM-DD.' }
  const sessionRef = typeof args.session === 'string' ? args.session.trim() : ''
  if (!sessionRef) return { ok: false, text: 'session is required (routine id or session name).' }
  const { ops, errors } = normalizeInputOps(args.ops)
  if (errors.length) return { ok: false, text: `Refused: ${errors.join('; ')}` }
  if (args.expires_on != null && !isIsoDate(args.expires_on)) return { ok: false, text: 'expires_on must be YYYY-MM-DD.' }
  const rationale = typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim().slice(0, 500) : null
  try {
    const session = await resolveSession(store, sessionRef)
    if ('error' in session) return { ok: false, text: session.error }
    const today = await athleteToday(store)
    const request: CreateRequest = {
      date: args.date,
      routine_id: session.id,
      ops,
      expires_on: typeof args.expires_on === 'string' ? args.expires_on : null,
    }
    const plan = await planCreate(store, request, today)
    if ('error' in plan) return { ok: false, text: `Refused: ${plan.error}` }
    const previewId = await storePreview(store, actor, 'create', request, plan.diff, rationale)
    return { ok: true, preview_id: previewId, diff: plan.diff, text: previewText(previewId, plan.diff, 'create') }
  } catch (e) {
    if (missingSchema(e)) return { ok: false, text: unavailable }
    throw e
  }
}

export async function previewClear(
  store: ConnectedStore,
  actor: OverrideActor,
  args: { override_id: unknown; rationale?: unknown },
): Promise<PreviewResult> {
  if (!(await tracksV1On(store))) return { ok: false, text: flagOff }
  const ids = (Array.isArray(args.override_id) ? args.override_id : [args.override_id])
    .filter((v): v is string => typeof v === 'string')
  const rationale = typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim().slice(0, 500) : null
  try {
    const today = await athleteToday(store)
    const plan = await planClear(store, ids, today)
    if ('error' in plan) return { ok: false, text: `Refused: ${plan.error}` }
    const previewId = await storePreview(store, actor, 'clear', { override_ids: plan.ids }, plan.diff, rationale)
    return { ok: true, preview_id: previewId, diff: plan.diff, text: previewText(previewId, plan.diff, 'clear') }
  } catch (e) {
    if (missingSchema(e)) return { ok: false, text: unavailable }
    throw e
  }
}

// ---- apply ---------------------------------------------------------------------------

export type ApplyResult =
  | { ok: true; text: string; override_ids: string[] }
  | { ok: false; reason: 'refused' | 'stale' | 'not_found' | 'unavailable' | 'off'; text: string }

interface PreviewRow {
  id: string
  preview_id: string
  kind: 'create' | 'clear'
  request: unknown
  diff: unknown
  actor_type: ActorType
  actor_id: string
  rationale: string | null
  used_at: string | null
  voided_at: string | null
  fresh: boolean
}

async function log(
  store: ConnectedStore,
  entry: {
    actor: OverrideActor
    tool: string
    target: unknown
    diff: unknown
    rationale: string | null
    approvalRef: string | null
    previewId: string | null
    expiresOn: string | null
  },
): Promise<void> {
  await store.sql`
    INSERT INTO session_override_log (
      athlete_id, actor_type, actor_id, tool, target, diff, rationale, approval_ref, preview_id, expires_on
    ) VALUES (
      ${store.athleteId}, ${entry.actor.type}, ${entry.actor.id}, ${entry.tool},
      ${jsonParam(store.sql, entry.target)}, ${jsonParam(store.sql, entry.diff)},
      ${entry.rationale}, ${entry.approvalRef}, ${entry.previewId}, ${entry.expiresOn}
    )
  `
}

/** A preview parked as a pending proposal is the athlete's to accept, nobody else's. */
async function parkedForAthlete(store: ConnectedStore, previewId: string): Promise<boolean> {
  try {
    const rows = await store.sql<{ id: string }[]>`
      SELECT id FROM coach_proposal
      WHERE athlete_id = ${store.athleteId} AND preview_id = ${previewId} AND status = 'pending'
      LIMIT 1
    `
    return rows.length > 0
  } catch (e) {
    if (missingSchema(e)) return false
    throw e
  }
}

/** A preview by a coach whose token is revoked, expired or gone is void. Logged once. */
async function voidIfRevoked(store: ConnectedStore, p: PreviewRow): Promise<boolean> {
  if (p.actor_type !== 'mcp') return false
  const rows = UUID_RE.test(p.actor_id)
    ? await store.sql<{ revoked: boolean }[]>`
        SELECT (revoked_at IS NOT NULL
                OR COALESCE((to_jsonb(t) ->> 'expires_at')::timestamptz < NOW(), false)) AS revoked
        FROM mcp_token t
        WHERE id = ${p.actor_id} AND athlete_id = ${store.athleteId}
        LIMIT 1
      `
    : []
  if (rows[0] && !rows[0].revoked) return false
  const voided = await store.sql<{ id: string }[]>`
    UPDATE session_override_preview SET voided_at = NOW()
    WHERE id = ${p.id} AND athlete_id = ${store.athleteId} AND voided_at IS NULL
    RETURNING id
  `
  if (voided.length) {
    const why = 'The coach that made this preview no longer has access.'
    await log(store, {
      actor: { type: 'system', id: 'revocation' },
      tool: 'void_preview',
      target: { preview_id: p.preview_id, coach: `mcp:${p.actor_id}` },
      diff: {},
      rationale: why,
      approvalRef: null,
      previewId: p.preview_id,
      expiresOn: null,
    })
    // applyPreview only runs with tracks_v1 on, so G2's log is on too.
    await store.sql`
      INSERT INTO change_log (athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, preview_id)
      VALUES (${store.athleteId}, 'system', 'revocation', 'void_preview', 'session_override_preview', ${p.preview_id},
              ${jsonParam(store.sql, { coach: `mcp:${p.actor_id}` })}, ${why}, ${p.preview_id})
    `
  }
  return true
}

/**
 * Write a previewed override (or clear). `actor` is who is applying; the rows
 * and log record the preview's author as created_by and this approval_ref as
 * the athlete's yes.
 */
export async function applyPreview(
  store: ConnectedStore,
  actor: OverrideActor,
  args: { preview_id: unknown; confirm: unknown; approval_ref: unknown },
  /** Set only by acceptProposal: the athlete's Accept on a parked preview. */
  opts: { viaProposal?: boolean } = {},
): Promise<ApplyResult> {
  if (args.confirm !== true) {
    return { ok: false, reason: 'refused', text: 'Refused: apply_session_override requires confirm=true. Preview first, show the athlete, then apply.' }
  }
  const problem = approvalProblem(actor, args.approval_ref)
  if (problem) return { ok: false, reason: 'refused', text: problem }
  const approvalRef = String(args.approval_ref).trim()
  if (!(await tracksV1On(store))) return { ok: false, reason: 'off', text: flagOff }
  const previewId = typeof args.preview_id === 'string' ? args.preview_id.trim() : ''
  if (!previewId) return { ok: false, reason: 'refused', text: 'Refused: preview_id is required. Call preview_session_override first.' }

  let p: PreviewRow | undefined
  try {
    [p] = await store.sql<PreviewRow[]>`
      SELECT id, preview_id, kind, request, diff, actor_type, actor_id, rationale,
             to_json(used_at) #>> '{}' AS used_at, to_json(voided_at) #>> '{}' AS voided_at,
             (created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)) AS fresh
      FROM session_override_preview
      WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId}
      LIMIT 1
    `
  } catch (e) {
    if (missingSchema(e)) return { ok: false, reason: 'unavailable', text: unavailable }
    throw e
  }
  if (!p) return { ok: false, reason: 'not_found', text: 'Refused: no such preview on this athlete. Preview again.' }
  if (p.used_at) return { ok: false, reason: 'refused', text: 'Refused: this preview was already applied.' }
  if (p.voided_at || await voidIfRevoked(store, p)) {
    return { ok: false, reason: 'stale', text: 'Refused: this preview was voided (its coach no longer has access). Preview again.' }
  }
  if (!p.fresh) {
    return { ok: false, reason: 'stale', text: `Refused: this preview is more than ${PREVIEW_TTL_HOURS} h old. Preview again and show the athlete the new diff.` }
  }
  if (!opts.viaProposal && await parkedForAthlete(store, p.preview_id)) {
    return { ok: false, reason: 'refused', text: 'Refused: this change is parked for the athlete; they accept it in the app.' }
  }

  const today = await athleteToday(store)
  const storedDiff = canonicalJson(asJson<DiffRow[]>(p.diff, []))
  let createRows: PlannedRow[] = []
  let clearIds: string[] = []
  let diff: DiffRow[]
  if (p.kind === 'create') {
    const plan = await planCreate(store, asJson<CreateRequest>(p.request, { date: '', routine_id: '', ops: [], expires_on: null }), today)
    if ('error' in plan) return { ok: false, reason: 'stale', text: `Refused: the session changed since the preview (${plan.error}). Preview again.` }
    createRows = plan.rows
    diff = plan.diff
  } else {
    const plan = await planClear(store, asJson<{ override_ids: string[] }>(p.request, { override_ids: [] }).override_ids, today)
    if ('error' in plan) return { ok: false, reason: 'stale', text: `Refused: ${plan.error} Preview again.` }
    clearIds = plan.ids
    diff = plan.diff
  }
  if (canonicalJson(diff) !== storedDiff) {
    return { ok: false, reason: 'stale', text: 'Refused: the diff no longer matches the preview (the session or its overrides changed). Preview again.' }
  }

  // One statement per write: claiming the preview, the override rows and their
  // log rows land together or not at all, and a preview applies once.
  const author: OverrideActor = { type: p.actor_type, id: p.actor_id }
  let ids: string[]
  if (p.kind === 'create') {
    const pairId = createRows.some((r) => r.paired) ? crypto.randomUUID() : null
    const planned = createRows.map((row) => ({
      date: row.date,
      routine_id: row.routine_id,
      session: row.session,
      ops: row.ops,
      expires_on: row.expires_on,
      pair_id: row.paired ? pairId : null,
      changes: diff.find((x) => x.date === row.date && x.routine_id === row.routine_id)?.changes ?? [],
    }))
    const rows = await store.sql<{ id: string }[]>`
      WITH claim AS (
        UPDATE session_override_preview SET used_at = NOW()
        WHERE id = ${p.id} AND athlete_id = ${store.athleteId} AND used_at IS NULL AND voided_at IS NULL
        RETURNING id
      ),
      planned AS (
        SELECT * FROM jsonb_to_recordset(${jsonParam(store.sql, planned)}) AS x(
          date date, routine_id uuid, session text, ops jsonb, expires_on date, pair_id uuid, changes jsonb
        )
      ),
      ok AS (
        SELECT 1 FROM claim
        WHERE NOT EXISTS (
          SELECT 1 FROM planned x
          WHERE NOT EXISTS (
            SELECT 1 FROM routine r JOIN program pr ON pr.id = r.program_id
            WHERE r.id = x.routine_id AND pr.athlete_id = ${store.athleteId}
          )
        )
      ),
      ins AS (
        INSERT INTO session_override (
          athlete_id, date, routine_id, ops, expires_on, pair_id, actor_type, actor_id, rationale, approval_ref, preview_id
        )
        SELECT ${store.athleteId}::uuid, x.date, x.routine_id, x.ops, x.expires_on, x.pair_id,
               ${author.type}::text, ${author.id}::text, ${p.rationale}::text, ${approvalRef}::text, ${p.preview_id}::text
        FROM planned x
        WHERE EXISTS (SELECT 1 FROM ok)
        RETURNING id, date, routine_id, expires_on, pair_id
      ),
      logged AS (
        INSERT INTO session_override_log (
          athlete_id, actor_type, actor_id, tool, target, diff, rationale, approval_ref, preview_id, expires_on
        )
        SELECT ${store.athleteId}::uuid, ${author.type}::text, ${author.id}::text, 'apply_session_override',
               jsonb_build_object('override_id', i.id, 'date', i.date, 'routine_id', i.routine_id,
                                  'session', x.session, 'pair_id', i.pair_id),
               jsonb_build_object('changes', x.changes, 'ops', x.ops),
               ${p.rationale}::text, ${approvalRef}::text, ${p.preview_id}::text, i.expires_on
        FROM ins i JOIN planned x ON x.date = i.date AND x.routine_id = i.routine_id
        RETURNING id
      ),
      -- G2: the same write, once, in change_log (a move is one change, two rows).
      changed AS (
        INSERT INTO change_log (
          athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
          approval_ref, preview_id, expires_on
        )
        SELECT ${store.athleteId}::uuid, ${author.type}::text, ${author.id}::text, 'apply_session_override',
               'session_override', (SELECT min(id::text) FROM ins),
               jsonb_build_object('override_ids', (SELECT jsonb_agg(id::text ORDER BY date, id) FROM ins),
                                  'sessions', ${jsonParam(store.sql, diff)}),
               ${p.rationale}::text, ${jsonParam(store.sql, ruleRefsFrom(p.rationale))},
               ${approvalRef}::text, ${p.preview_id}::text, (SELECT max(expires_on) FROM ins)
        WHERE EXISTS (SELECT 1 FROM ins)
        RETURNING id
      )
      SELECT id::text AS id FROM ins ORDER BY date
    `
    ids = rows.map((r) => r.id)
  } else {
    const rows = await store.sql<{ id: string }[]>`
      WITH claim AS (
        UPDATE session_override_preview SET used_at = NOW()
        WHERE id = ${p.id} AND athlete_id = ${store.athleteId} AND used_at IS NULL AND voided_at IS NULL
        RETURNING id
      ),
      changes AS (
        SELECT * FROM jsonb_to_recordset(${jsonParam(store.sql, diff)}) AS d(date date, routine_id uuid, changes jsonb)
      ),
      voided AS (
        UPDATE session_override
        SET voided_at = NOW(), void_approval_ref = ${approvalRef}::text, void_preview_id = ${p.preview_id}::text
        WHERE athlete_id = ${store.athleteId} AND voided_at IS NULL
          AND id::text = ANY(${pgArrayLiteral(clearIds)}::text[])
          AND EXISTS (SELECT 1 FROM claim)
        RETURNING id, date, routine_id, expires_on
      ),
      logged AS (
        INSERT INTO session_override_log (
          athlete_id, actor_type, actor_id, tool, target, diff, rationale, approval_ref, preview_id, expires_on
        )
        SELECT ${store.athleteId}::uuid, ${author.type}::text, ${author.id}::text, 'clear_session_override',
               jsonb_build_object('override_id', v.id, 'date', v.date, 'routine_id', v.routine_id),
               jsonb_build_object('changes', COALESCE(c.changes, '[]'::jsonb)),
               ${p.rationale}::text, ${approvalRef}::text, ${p.preview_id}::text, v.expires_on
        FROM voided v LEFT JOIN changes c ON c.date = v.date AND c.routine_id = v.routine_id
        RETURNING id
      ),
      changed AS (
        INSERT INTO change_log (
          athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
          approval_ref, preview_id, expires_on
        )
        SELECT ${store.athleteId}::uuid, ${author.type}::text, ${author.id}::text, 'clear_session_override',
               'session_override', (SELECT min(id::text) FROM voided),
               jsonb_build_object('override_ids', (SELECT jsonb_agg(id::text ORDER BY date, id) FROM voided),
                                  'sessions', ${jsonParam(store.sql, diff)}),
               ${p.rationale}::text, ${jsonParam(store.sql, ruleRefsFrom(p.rationale))},
               ${approvalRef}::text, ${p.preview_id}::text, (SELECT max(expires_on) FROM voided)
        WHERE EXISTS (SELECT 1 FROM voided)
        RETURNING id
      )
      SELECT id::text AS id FROM voided ORDER BY date
    `
    ids = rows.map((r) => r.id)
  }
  if (!ids.length) return { ok: false, reason: 'refused', text: 'Refused: this preview was already applied.' }

  const summary = diff.map((d) => d.label).join('; ')
  const body = p.kind === 'create'
    ? `${WEEK_ONLY_LABEL}: ${summary}.${p.rationale ? ` Why: ${p.rationale}` : ''}`
    : `Back to the plan: ${summary}.${p.rationale ? ` Why: ${p.rationale}` : ''}`
  await store.sql`
    INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
    VALUES (${store.athleteId}, 'coach', 'note', ${body}, ${null})
  `
  return {
    ok: true,
    override_ids: ids,
    text: [
      p.kind === 'create'
        ? `Applied ${ids.length} week-only override row${ids.length === 1 ? '' : 's'}. The template is unchanged.`
        : `Cleared ${ids.length} override row${ids.length === 1 ? '' : 's'}. Those dates follow the plan again.`,
      formatDiff(diff),
      `override_ids: ${ids.join(', ')}`,
    ].join('\n\n'),
  }
}

// ---- lists ------------------------------------------------------------------------------

export interface OverrideListItem {
  id: string
  date: string
  routine_id: string
  session: string
  expires_on: string
  active: boolean
  ops: OverrideOp[]
  pair_id: string | null
  moved_out_to: string | null
  moved_in_from: string | null
  created_by: string
  rationale: string | null
  approval_ref: string
  created_at: string
  voided_at: string | null
}

export async function listOverrides(
  store: ConnectedStore,
  opts: { from?: string | null; to?: string | null; includeInactive?: boolean } = {},
): Promise<OverrideListItem[] | null> {
  const today = await athleteToday(store)
  const from = isIsoDate(opts.from) ? opts.from : addDays(today, -MAX_PAST_DAYS)
  const to = isIsoDate(opts.to) ? opts.to : addDays(today, MAX_FUTURE_DAYS)
  try {
    const rows = await store.sql<{
      id: string; date: string; routine_id: string; session: string; expires_on: string; ops: unknown
      pair_id: string | null; actor_type: string; actor_id: string; rationale: string | null
      approval_ref: string; created_at: string; voided_at: string | null
    }[]>`
      SELECT o.id, o.date::text AS date, o.routine_id::text AS routine_id, r.name AS session,
             o.expires_on::text AS expires_on, o.ops, o.pair_id::text AS pair_id, o.actor_type, o.actor_id,
             o.rationale, o.approval_ref, to_json(o.created_at) #>> '{}' AS created_at,
             to_json(o.voided_at) #>> '{}' AS voided_at
      FROM session_override o
      JOIN routine r ON r.id = o.routine_id
      WHERE o.athlete_id = ${store.athleteId} AND o.date BETWEEN ${from} AND ${to}
      ORDER BY o.date, o.created_at, o.id
      LIMIT 100
    `
    return rows
      .map((r) => {
        const ops = asJson<OverrideOp[]>(r.ops, [])
        const out = ops.find((o) => o.op === 'move_out' && o.exercise_name == null)
        const into = ops.find((o) => o.op === 'move_in' && o.exercise == null)
        return {
          id: r.id,
          date: r.date,
          routine_id: r.routine_id,
          session: r.session,
          expires_on: r.expires_on,
          active: !r.voided_at && r.expires_on >= today,
          ops,
          pair_id: r.pair_id,
          moved_out_to: out?.op === 'move_out' ? out.to_date : null,
          moved_in_from: into?.op === 'move_in' ? into.from_date : null,
          created_by: `${r.actor_type}:${r.actor_id}`,
          rationale: r.rationale,
          approval_ref: r.approval_ref,
          created_at: r.created_at,
          voided_at: r.voided_at,
        }
      })
      .filter((r) => opts.includeInactive || r.active)
  } catch (e) {
    if (missingSchema(e)) return null
    throw e
  }
}

// ---- proposals --------------------------------------------------------------------------

/**
 * Park a preview as a coach_proposal the athlete accepts in the app. The
 * Accept goes through acceptProposal → applyPreview with a tap: ref.
 */
export async function parkOverrideProposal(
  store: ConnectedStore,
  preview: PreviewOk,
  opts: { title: string; rationale: string | null; goalIds: string[]; source: 'mcp' | 'app' },
): Promise<{ ok: true; id: string } | { ok: false; text: string }> {
  try {
    const [row] = await store.sql<{ id: string }[]>`
      INSERT INTO coach_proposal (
        athlete_id, preview_id, title, rationale, goal_ids, edits, timing, request, diff, program_fingerprint, source, kind
      ) VALUES (
        ${store.athleteId}, ${preview.preview_id}, ${opts.title}, ${opts.rationale}, ${jsonParam(store.sql, opts.goalIds)},
        ${jsonParam(store.sql, { preview_id: preview.preview_id })}, 'now', ${null},
        ${jsonParam(store.sql, proposalDiff(preview.diff))}, ${preview.preview_id}, ${opts.source}, 'session_override'
      )
      RETURNING id
    `
    return { ok: true, id: row.id }
  } catch (e) {
    if (missingSchema(e)) return { ok: false, text: 'Not parked: proposals are not set up on this database yet.' }
    throw e
  }
}

// ---- MCP ----------------------------------------------------------------------------------

const overrideExerciseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    sets: { type: 'integer', minimum: 1, maximum: 10 },
    reps: { type: 'string' },
    load: { type: 'string', description: 'A number in the athlete\'s unit (a written load beats TM math) or bodyweight | light | moderate | heavy.' },
    target_rpe: { type: 'number', minimum: 1, maximum: 10 },
    cue: { type: 'string' },
  },
  required: ['name'],
}

const overrideOpSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['add', 'swap', 'drop', 'adjust', 'move'] },
    exercise_name: { type: ['string', 'null'], description: 'swap / drop / adjust: the exercise on that date. move: the exercise to move; leave out to move the whole session.' },
    exercise: { ...overrideExerciseSchema, description: 'add: the exercise to add.' },
    after: { type: ['string', 'null'], description: 'add: insert after this exercise (default: at the end).' },
    with: { ...overrideExerciseSchema, description: 'swap: the stand-in. Sets/reps/RPE carry over unless given.' },
    sets: { type: 'integer', minimum: 1, maximum: 10 },
    reps: { type: 'string' },
    load: { type: 'string' },
    target_rpe: { type: 'number', minimum: 1, maximum: 10 },
    to_date: { type: 'string', description: 'move: YYYY-MM-DD it lands on (within 7 days).' },
    to_session: { type: ['string', 'null'], description: 'move one exercise: the session it joins on to_date (default: the same session).' },
  },
  required: ['op'],
}

export const SESSION_OVERRIDE_TOOLS: McpTool[] = [
  {
    name: 'preview_session_override',
    description: 'Preview a week-only change to ONE dated session: add, swap, drop or adjust an exercise, or move an exercise or the whole session to another day ("missed Tuesday\'s squat, do it tomorrow"). The program template is never touched; /api/session-rx applies it on that date only, the app shows "This week only", and it expires by the end of that week. Returns preview_id + diff and writes no override. With propose=true it is parked for the athlete to accept in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD the session happens on.' },
        session: { type: 'string', description: 'Routine id or session name.' },
        ops: { type: 'array', items: overrideOpSchema, minItems: 1, maxItems: 12 },
        expires_on: { type: 'string', description: 'YYYY-MM-DD, default the Sunday ending that week; at most 7 days after date.' },
        rationale: { type: 'string', description: 'Why, in the athlete\'s terms.' },
        propose: { type: 'boolean', description: 'Park for the athlete to accept in the app. Required for the in-app coach.' },
        title: { type: 'string', description: 'With propose: one sentence the athlete reads.' },
        goal_ids: { type: 'array', items: { type: 'string' }, description: 'With propose: goals this serves, by id or name.' },
      },
      required: ['date', 'session', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_session_override',
    description: 'Write a previewed week-only override (or clear). Requires confirm=true, a preview_id under 24 h old whose diff still matches, and approval_ref = msg:<id> of the message where the athlete said yes. The in-app coach cannot approve; it proposes.',
    inputSchema: {
      type: 'object',
      properties: {
        preview_id: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        approval_ref: { type: 'string', description: 'msg:<message id> where the athlete approved this diff.' },
      },
      required: ['preview_id', 'confirm', 'approval_ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_session_overrides',
    description: 'Week-only overrides by date: what each changes, who made it, the approval, and when it expires. Active only unless include_inactive.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, default 7 days ago.' },
        to: { type: 'string', description: 'YYYY-MM-DD, default 13 days ahead.' },
        include_inactive: { type: 'boolean', description: 'Include expired and cleared rows (kept for audit).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_clear_session_override',
    description: 'Preview putting a dated session back to the plan by clearing an override (both halves of a move clear together). Apply it with apply_session_override, which needs approval like any write; the clear is recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        override_id: { type: 'string' },
        rationale: { type: 'string' },
        propose: { type: 'boolean' },
        title: { type: 'string' },
      },
      required: ['override_id'],
      additionalProperties: false,
    },
  },
]

export const SESSION_OVERRIDE_TOOL_NAMES = new Set(SESSION_OVERRIDE_TOOLS.map((t) => t.name))

export async function runSessionOverrideTool(
  store: ConnectedStore,
  name: string,
  args: Record<string, unknown>,
  actor: OverrideActor,
  resolveGoals: (refs: unknown) => Promise<string[]>,
): Promise<string> {
  if (!(await tracksV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  switch (name) {
    case 'preview_session_override':
    case 'preview_clear_session_override': {
      const preview = name === 'preview_session_override'
        ? await previewCreate(store, actor, { date: args.date, session: args.session, ops: args.ops, expires_on: args.expires_on, rationale: args.rationale })
        : await previewClear(store, actor, { override_id: args.override_id, rationale: args.rationale })
      if (!preview.ok) return preview.text
      const propose = args.propose === true
      if (!propose) {
        return actor.type === 'app_coach'
          ? `${preview.text}\n\nThe in-app coach cannot apply this. Preview again with propose=true to park it for the athlete.`
          : preview.text
      }
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 200) : null
      if (!title) throw new McpUserError('title is required with propose=true: one sentence the athlete reads')
      const rationale = typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim() : null
      const parked = await parkOverrideProposal(store, preview, {
        title,
        rationale,
        goalIds: await resolveGoals(args.goal_ids),
        source: actor.type === 'app_coach' ? 'app' : 'mcp',
      })
      if (!parked.ok) return `${preview.text}\n\n${parked.text}`
      return `${preview.text}\n\n## Proposed\nParked for the athlete as proposal ${parked.id}. They accept it in the app; that tap is the approval.`
    }
    case 'apply_session_override':
      return (await applyPreview(store, actor, {
        preview_id: args.preview_id,
        confirm: args.confirm,
        approval_ref: args.approval_ref,
      })).text
    case 'list_session_overrides': {
      const rows = await listOverrides(store, {
        from: typeof args.from === 'string' ? args.from : null,
        to: typeof args.to === 'string' ? args.to : null,
        includeInactive: args.include_inactive === true,
      })
      if (rows == null) return unavailable
      if (!rows.length) return 'No week-only overrides in that window.'
      return JSON.stringify(rows, null, 2)
    }
    default:
      throw new McpUserError(`Unknown tool: ${name}`)
  }
}

// ---- app route ----------------------------------------------------------------------------

/**
 * POST /api/session-override — the athlete's own session. Same auth as
 * /api/session-rx. 404 unless tracks_v1 is on, so the route reads as absent
 * with the flag off.
 *   { action: 'list', from?, to? }              → { overrides }
 *   { action: 'preview', date, session, ops, expires_on?, rationale? }
 *   { action: 'preview_clear', override_id, rationale? }
 *   { action: 'apply', preview_id }             → the tap IS the approval
 */
export async function handleSessionOverride(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
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
      const [out, status] = await athleteOverrideAction(makeStore(sql, athleteId, 'lb'), body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'override request failed' }, 500, cors)
  }
}

/** The route's body, separated so checks can drive it without an auth cookie. */
export async function athleteOverrideAction(store: ConnectedStore, body: Record<string, unknown>): Promise<[unknown, number]> {
  if (!(await tracksV1On(store))) return [{ error: 'not found' }, 404]
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  switch (body.action) {
    case 'list':
      return [{
        overrides: await listOverrides(store, {
          from: typeof body.from === 'string' ? body.from : null,
          to: typeof body.to === 'string' ? body.to : null,
        }),
      }, 200]
    case 'preview': {
      const p = await previewCreate(store, me, { date: body.date, session: body.session, ops: body.ops, expires_on: body.expires_on, rationale: body.rationale })
      return [p.ok ? { ok: true, preview_id: p.preview_id, diff: p.diff } : { ok: false, text: p.text }, 200]
    }
    case 'preview_clear': {
      const p = await previewClear(store, me, { override_id: body.override_id, rationale: body.rationale })
      return [p.ok ? { ok: true, preview_id: p.preview_id, diff: p.diff } : { ok: false, text: p.text }, 200]
    }
    case 'apply': {
      // Only previews the athlete made themselves apply here; a coach's
      // preview reaches the athlete as a proposal and is accepted there.
      const previewId = typeof body.preview_id === 'string' ? body.preview_id : ''
      let own: { id: string } | undefined
      try {
        [own] = await store.sql<{ id: string }[]>`
          SELECT id FROM session_override_preview
          WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId}
            AND actor_type = 'athlete' AND actor_id = ${store.athleteId}
          LIMIT 1
        `
      } catch (e) {
        if (missingSchema(e)) return [{ ok: false, reason: 'unavailable', text: unavailable }, 200]
        throw e
      }
      if (!own) return [{ ok: false, reason: 'not_found', text: 'No such preview.' }, 200]
      return [await applyPreview(store, me, { preview_id: previewId, confirm: true, approval_ref: `tap:${own.id}` }), 200]
    }
    default:
      return [{ error: 'unknown action' }, 400]
  }
}
