/**
 * Reverting a change (Round 2 item 3, spec section 6, tracks_v1): every
 * change_log type has one handler here, and REVERT_HANDLERS is checked against
 * every type the code writes (reverts.check.ts). A revert is itself a logged
 * write: one revert_change row (revert_of → the row it reverts, which gains
 * reverted_by), the athlete's tap as its approval, in one transaction.
 *
 * Path: a coach previews (preview_revert_change) and the athlete's feed shows
 * it as suggested; the athlete previews (POST /api/change-log
 * { action: 'preview_revert' }), sees what it restores and any conflict, and
 * taps (action 'revert' with that preview_id). Only the athlete applies.
 *
 * What reverting means, per kind (each handler's `defined` says it in words):
 *   restore   the target goes back to the row's `before` when it still looks
 *             exactly like the row's `after` (program edits, tracks, goals,
 *             rules, block details, training max, methodology overrides,
 *             activities, coach access, the birth date of an adult).
 *   retire    a row the change created is hidden, never deleted
 *             (change_tombstone): a track, a goal, an autoreg rule. An added
 *             session is taken out of the week (phase_id cleared), a queued
 *             block is skipped and this week's end date put back.
 *   void      a logging write is tombstoned, never deleted (check-in, pain
 *             reports, session RPE when there was none before, measurement,
 *             note). Append-only tables stay append-only.
 *   safety    clearing a block or a red flag reverts by blocking again. Redoing
 *             a clear is refused: only the clinician clear unblocks.
 *   redo      reverting a revert re-applies the original, through the same
 *             handler and guards.
 *   none      revoking a coach and the system's voided preview: access is
 *             never restored by an undo (invite the coach again).
 *
 * Every revert refuses when a later change touched the same target (the
 * preview lists it; undo that first), when the target moved since, when it
 * would loosen an under-18 rule, or when it would unblock a region. A preview
 * whose plan no longer matches at apply time is refused: preview again.
 *
 * With tracks_v1 off nothing here is called.
 */
import { asJson, jsonParam, pgArrayLiteral } from './db.ts'
import {
  changeLogMissing, changeLogUnavailable, GOAL_FIELDS, goalSnapshot, obj, programMetaSnapshot, Refusal,
  routineSnapshots, storeChangePreview, trackSnapshot, trainingMaxEntry, UUID_RE, withTx, writeChange,
  type ChangeActor, type RoutineSnap,
} from './changeLog.ts'
import { insertProgramRevision } from './edits.ts'
import { athleteToday, canonicalJson, PREVIEW_TTL_HOURS, tracksV1On } from './sessionOverride.ts'
import { actorLabel, summarizeChange } from './changeSummary.ts'
import { ApprovalSpent, consumeApproval, directTapApproval } from './approvals.ts'
import { athleteMinor, blockedRegions, loadOverrides, resolveMethodology } from './methodology.ts'
import { validateEdit, type PreviewWarning, type WeekSession } from './methodology/validators.ts'
import { applyOverrideOps, type OverrideOp } from '../../src/engine/sessionOverride.ts'
import type { ExerciseTemplate } from '../../src/types/database.ts'
import { CURRENT_METHODOLOGY } from './methodology/v1.ts'
import { checkOverride, resolveParams, type OverrideRecord } from './methodology/resolve.ts'
import { blocksNow, loadRegionStatus, readinessTables, seesHealth, statusBlockedRegions } from './regionStatus.ts'
import {
  isTombstoned, liftTombstones, tombstonesBy, tombstonesReady, writeTombstone, type TombTable,
} from './tombstones.ts'
import type { ConnectedStore } from './store.ts'

type Obj = Record<string, unknown>
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

/** undo: take a forward change back. redo: re-apply what an undo took back. */
export type Direction = 'undo' | 'redo'

export interface ConflictView {
  id: string
  at: string
  who: string
  tool: string
  summary: string
}

export type RevertResult =
  | { ok: true; change_id: string; summary: string; text: string; direction: Direction }
  | {
      ok: false
      reason: 'off' | 'unavailable' | 'not_found' | 'refused' | 'stale' | 'not_revertible'
      text: string
      conflicts?: ConflictView[]
      /** G5: the red-flag refusal, structured, for the athlete's app (the route is theirs alone). */
      warnings?: PreviewWarning[]
    }

type Fail = Extract<RevertResult, { ok: false }>

interface ApplyCtx {
  approvalRef: string
  approvalId: string
  /** The revert_change row being written. */
  changeId: string
  direction: Direction
}

interface RevertPlan {
  /** What the revert does, deterministic: the preview shows it and the tap approves it. */
  diff: Obj
  targetType: string
  targetId: string | null
  /** Runs inside the revert's transaction. Throws Refusal(stale) if a guard misses. Extra ids it mints go in the row's diff. */
  apply: (ctx: ApplyCtx) => Promise<Obj | void>
}

export interface ChangeRef {
  id: string
  created_at: string
  actor_type: ChangeActor['type']
  actor_id: string
  tool: string
  target_type: string
  target_id: string | null
  diff: Obj
  reverted_by: string | null
  revert_of: string | null
}

interface PlanCtx {
  tool: string
  dir: Direction
  row: ChangeRef
}

interface Handler {
  /** In words: what reverting this kind of change does. */
  defined: string
  /** Why this row can't be reverted in this direction (from its diff alone), or null. */
  blocked?: (d: Obj, dir: Direction) => string | null
  /** What it touches, to find later changes to the same target. */
  keys: (d: Obj, row: Pick<ChangeRef, 'id' | 'target_type' | 'target_id'>) => string[]
  /** Absent: never reverted (blocked or defined says why). */
  plan?: (store: ConnectedStore, d: Obj, ctx: PlanCtx) => Promise<RevertPlan | Fail>
}

const notRevertible = (text: string): Fail => ({ ok: false, reason: 'not_revertible', text: `Can't undo: ${text}` })
const stale = (what: string): Fail => ({
  ok: false,
  reason: 'stale',
  text: `Can't undo: ${what} changed since, so undoing would overwrite newer work. Preview again, or ask your coach to look again.`,
})
const staleRefusal = (what: string) => new Refusal<RevertResult>(stale(what))
const unavailable: Fail = { ok: false, reason: 'unavailable', text: 'Undo for this change is not set up on this database yet. Nothing changed.' }
const LEGACY = 'this change was recorded before undo covered it, so there is not enough on record to put it back safely.'

const idOf = (d: Obj, key: string, row: Pick<ChangeRef, 'target_id'>): string => String(d[key] ?? row.target_id ?? '')

/**
 * The red-flag rule every program write runs (U7, section 8), run on what a
 * revert would put back: work that loads a region blocked now is refused,
 * however long ago it was written. Only new loading counts, as in previews.
 */
async function loadsBlockedRegion(store: ConnectedStore, before: WeekSession[], after: WeekSession[]): Promise<Fail | null> {
  const [methodology, statusBlocked] = await Promise.all([resolveMethodology(store), statusBlockedRegions(store)])
  const blocked = [...new Set([...blockedRegions(methodology), ...statusBlocked])].sort()
  if (!blocked.length) return null
  const r = validateEdit({ before, after, params: methodology.params, changed: 0, total: 0, rewrite: true, blockedRegions: blocked })
  return r.blocked ? { ...notRevertible(`it would put back work on a blocked region. ${r.blocked.message}`), warnings: [r.blocked] } : null
}

const weekOf = (rows: RoutineSnap[]): WeekSession[] =>
  rows.map((r) => ({ key: r.id, name: r.name, dow: r.intended_dow, exercises: arr(r.exercises) as ExerciseTemplate[] }))

// ---- program edits (routines) -------------------------------------------------------------

function invertRevision(revision: unknown): Obj {
  const r = obj(revision)
  const flip = (c: Obj): Obj => (c.kind === 'added'
    ? { ...c, kind: 'removed', before: c.after ?? null, after: null }
    : c.kind === 'removed'
      ? { ...c, kind: 'added', after: c.before ?? null, before: null }
      : { ...c, before: c.after ?? null, after: c.before ?? null })
  const sessions = arr(r.sessions).map((s) => ({
    ...obj(s),
    changes: arr(obj(s).changes).map((c) => flip(obj(c))),
  }))
  return { added: Number(r.removed ?? 0), removed: Number(r.added ?? 0), changed: Number(r.changed ?? 0), new_sessions: 0, sessions }
}

const snaps = (v: unknown): RoutineSnap[] => arr(v).map(obj).filter((r) => typeof r.id === 'string') as unknown as RoutineSnap[]

function routineKeys(d: Obj): string[] {
  const keys = new Set<string>()
  for (const k of ['before', 'after', 'added', 'detached']) for (const r of snaps(d[k])) keys.add(`routine:${r.id}`)
  const q = obj(d.queued)
  if (typeof q.phase_id === 'string') keys.add(`phase:${q.phase_id}`)
  if (typeof q.live_phase_id === 'string') keys.add(`phase:${q.live_phase_id}`)
  return [...keys]
}

function routineBlocked(d: Obj, dir: Direction): string | null {
  if (d.unmatched === true) return 'this edit renamed or reshuffled sessions, so it can\'t be matched to put back. Change it again in the program editor.'
  if (d.timing === 'next_week') {
    const q = obj(d.queued)
    return q.phase_id && q.live_phase_id && q.live_week_end_before && q.live_week_end_after
      ? null
      : 'there isn\'t enough on record to put this week\'s end date back. Ask your coach to change next week instead.'
  }
  if (!Array.isArray(d.after)) return LEGACY
  if (dir === 'undo' && Number(d.inserted ?? 0) > snaps(d.added).length) {
    return 'this change added a session before undo covered it. Ask your coach to take the session out instead.'
  }
  return null
}

async function phaseOf(store: ConnectedStore, ids: string[]): Promise<Map<string, string | null>> {
  const wanted = ids.filter((id) => UUID_RE.test(id))
  if (!wanted.length) return new Map()
  const rows = await store.sql<{ id: string; phase_id: string | null }[]>`
    SELECT r.id::text AS id, r.phase_id::text AS phase_id
    FROM routine r JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId} AND r.id::text = ANY(${pgArrayLiteral(wanted)}::text[])
  `
  return new Map(rows.map((r) => [r.id, r.phase_id]))
}

function revisionSummary(tool: string, dir: Direction, queued: boolean): string {
  if (dir === 'redo') return queued ? 'Redid a queued block' : 'Redid a change'
  if (queued) return 'Undid a queued block'
  return tool === 'app_editor' ? 'Undid an editor change' : 'Undid a coach change'
}

async function planQueued(store: ConnectedStore, d: Obj, ctx: PlanCtx): Promise<RevertPlan | Fail> {
  const q = obj(d.queued)
  const phaseId = String(q.phase_id)
  const liveId = String(q.live_phase_id)
  const [weekEndBefore, weekEndAfter] = [String(q.live_week_end_before), String(q.live_week_end_after)]
  const today = await athleteToday(store)
  const phases = await store.sql<{ id: string; status: string; week_start: string; week_end: string }[]>`
    SELECT ph.id::text AS id, ph.status, ph.week_start::text AS week_start, ph.week_end::text AS week_end
    FROM phase ph JOIN program p ON p.id = ph.program_id
    WHERE p.athlete_id = ${store.athleteId} AND ph.id::text = ANY(${pgArrayLiteral([phaseId, liveId])}::text[])
  `
  const queued = phases.find((p) => p.id === phaseId)
  const live = phases.find((p) => p.id === liveId)
  if (!queued || !live) return stale('next week\'s block')
  if (queued.week_start <= today) return notRevertible('next week\'s block has already started. Ask your coach to change it.')
  const undo = ctx.dir === 'undo'
  if (queued.status !== (undo ? 'pending' : 'skipped')) return stale('next week\'s block')
  if (live.week_end !== (undo ? weekEndAfter : weekEndBefore)) return stale('this block\'s end date')
  if (!undo) {
    const [other] = await store.sql<{ id: string }[]>`
      SELECT ph.id::text AS id FROM phase ph JOIN program p ON p.id = ph.program_id
      WHERE p.athlete_id = ${store.athleteId} AND ph.status = 'pending' AND ph.id <> ${phaseId}
      LIMIT 1
    `
    if (other) return stale('next week (another block is queued)')
  }
  const revision = invertRevision(d.revision)
  return {
    targetType: 'program',
    targetId: typeof d.phase_id === 'string' ? d.phase_id : liveId,
    diff: {
      timing: 'next_week',
      program_id: d.program_id ?? null,
      phase_id: d.phase_id ?? liveId,
      queued: { ...q, state: undo ? 'skipped' : 'pending' },
      revision,
    },
    apply: async () => {
      // Skipped, not deleted: nothing reads a skipped phase, and its routines stay as history.
      const moved = await store.sql<{ id: string }[]>`
        UPDATE phase ph SET status = ${undo ? 'skipped' : 'pending'}
        FROM program p
        WHERE ph.id = ${phaseId} AND ph.program_id = p.id AND p.athlete_id = ${store.athleteId}
          AND ph.status = ${undo ? 'pending' : 'skipped'}
        RETURNING ph.id
      `
      const ends = await store.sql<{ id: string }[]>`
        UPDATE phase ph SET week_end = ${undo ? weekEndBefore : weekEndAfter}::date
        FROM program p
        WHERE ph.id = ${liveId} AND ph.program_id = p.id AND p.athlete_id = ${store.athleteId}
          AND ph.week_end = ${undo ? weekEndAfter : weekEndBefore}::date
        RETURNING ph.id
      `
      if (!moved.length || !ends.length) throw staleRefusal('next week\'s block')
      if (typeof d.program_id === 'string') {
        await insertProgramRevision(store, { programId: d.program_id, phaseId: liveId }, {
          trigger: 'editor',
          effectiveOn: today,
          requests: [],
          snapshot: [],
          diff: revision,
          summary: revisionSummary(ctx.tool, ctx.dir, true),
        })
      }
    },
  }
}

async function planRoutines(store: ConnectedStore, d: Obj, ctx: PlanCtx): Promise<RevertPlan | Fail> {
  if (d.timing === 'next_week') return planQueued(store, d, ctx)
  const before = snaps(d.before)
  const after = snaps(d.after)
  const phaseId = typeof d.phase_id === 'string' ? d.phase_id : ctx.row.target_type === 'program' ? ctx.row.target_id : null
  // Sessions this change added come out of the week (undo) or go back in (redo); never deleted.
  const detach = ctx.dir === 'undo' ? snaps(d.added) : []
  const attach = ctx.dir === 'redo' ? snaps(d.detached) : []
  if ((detach.length || attach.length) && !phaseId) return notRevertible(LEGACY)
  const current = new Map((await routineSnapshots(store, [...after, ...detach, ...attach].map((r) => r.id))).map((r) => [r.id, r]))
  for (const a of [...after, ...detach, ...attach]) {
    const now = current.get(a.id)
    if (!now || canonicalJson(now) !== canonicalJson(a)) return stale(`the ${a.name} session`)
  }
  const phases = await phaseOf(store, [...detach, ...attach].map((r) => r.id))
  if (detach.some((r) => phases.get(r.id) !== phaseId)) return stale('the week')
  if (attach.some((r) => phases.get(r.id) != null)) return stale('the week')
  if (detach.length) {
    const [left] = await store.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM routine r JOIN program p ON p.id = r.program_id
      WHERE p.athlete_id = ${store.athleteId} AND r.phase_id = ${phaseId}
        AND NOT (r.id::text = ANY(${pgArrayLiteral(detach.map((r) => r.id))}::text[]))
    `
    if (Number(left?.n ?? 0) === 0) return notRevertible('it would leave this week with no sessions. Ask your coach to change the week instead.')
  }
  const red = await loadsBlockedRegion(store, weekOf([...after, ...detach]), weekOf([...before, ...attach]))
  if (red) return red
  const spw = d.sessions_per_week ? obj(d.sessions_per_week) : null
  if (spw) {
    const [row] = await store.sql<{ n: number | null }[]>`SELECT sessions_per_week AS n FROM athlete WHERE id = ${store.athleteId}`
    if (Number(row?.n) !== Number(spw.after)) return stale('sessions per week')
  }
  const revision = invertRevision(d.revision)
  const programTool = ctx.tool !== 'assign_exercise_to_track'
  return {
    targetType: ctx.tool === 'assign_exercise_to_track' ? 'routine' : 'program',
    targetId: phaseId,
    diff: {
      timing: 'now',
      ...(typeof d.program_id === 'string' ? { program_id: d.program_id } : {}),
      ...(phaseId ? { phase_id: phaseId } : {}),
      before: after,
      after: before,
      ...(ctx.dir === 'undo'
        ? (detach.length ? { detached: detach } : {})
        : (attach.length ? { added: attach, inserted: attach.length } : {})),
      ...(spw ? { sessions_per_week: { before: spw.after, after: spw.before } } : {}),
      ...(programTool ? { revision } : {}),
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
      for (const r of detach) {
        const done = await store.sql<{ id: string }[]>`
          UPDATE routine r SET phase_id = NULL
          FROM program p
          WHERE r.id = ${r.id} AND r.program_id = p.id AND p.athlete_id = ${store.athleteId} AND r.phase_id = ${phaseId}
          RETURNING r.id
        `
        if (!done.length) throw staleRefusal(`the ${r.name} session`)
      }
      for (const r of attach) {
        const done = await store.sql<{ id: string }[]>`
          UPDATE routine r SET phase_id = ${phaseId}
          FROM program p
          WHERE r.id = ${r.id} AND r.program_id = p.id AND p.athlete_id = ${store.athleteId} AND r.phase_id IS NULL
          RETURNING r.id
        `
        if (!done.length) throw staleRefusal(`the ${r.name} session`)
      }
      if (spw) {
        const done = await store.sql<{ id: string }[]>`
          UPDATE athlete SET sessions_per_week = ${Number(spw.before)}
          WHERE id = ${store.athleteId} AND sessions_per_week = ${Number(spw.after)}
          RETURNING id
        `
        if (!done.length) throw staleRefusal('sessions per week')
      }
      if (programTool && typeof d.program_id === 'string' && phaseId) {
        // The program changed, so the journey records it like any other edit.
        await insertProgramRevision(store, { programId: d.program_id, phaseId }, {
          trigger: 'editor',
          effectiveOn: await athleteToday(store),
          requests: [],
          snapshot: after.map((s) => ({ name: s.name, intent: s.intent, session_type: s.session_type, intended_dow: s.intended_dow, exercises: s.exercises })),
          diff: revision,
          summary: revisionSummary(ctx.tool, ctx.dir, false),
        })
      }
    },
  }
}

const ROUTINES: Handler = {
  defined: 'Puts the changed sessions back exactly as they were. A session the change added comes out of the week (kept, not deleted); a block queued for next Monday is skipped and this week keeps its end date. Redo re-applies it.',
  blocked: routineBlocked,
  keys: routineKeys,
  plan: planRoutines,
}

// ---- week-only overrides ------------------------------------------------------------------

function overrideKeys(d: Obj): string[] {
  const keys = new Set<string>()
  for (const id of arr(d.override_ids)) keys.add(`override:${String(id)}`)
  for (const s of arr(d.sessions).map(obj)) if (s.date && s.routine_id) keys.add(`day:${String(s.date)}:${String(s.routine_id)}`)
  return [...keys]
}

async function planOverride(store: ConnectedStore, d: Obj, ctx: PlanCtx): Promise<RevertPlan | Fail> {
  const ids = arr(d.override_ids).map(String).filter((id) => UUID_RE.test(id))
  if (!ids.length) return notRevertible('this row names no week-only change.')
  // An apply undone, or a clear redone, voids the overrides; the other two put copies back.
  const voiding = (ctx.tool === 'apply_session_override') === (ctx.dir === 'undo')
  const today = await athleteToday(store)
  const rows = await store.sql<{ id: string; voided: boolean; expires_on: string; date: string; routine_id: string }[]>`
    SELECT id::text AS id, voided_at IS NOT NULL AS voided, expires_on::text AS expires_on, date::text AS date, routine_id::text AS routine_id
    FROM session_override
    WHERE athlete_id = ${store.athleteId} AND id::text = ANY(${pgArrayLiteral(ids)}::text[])
  `
  if (rows.length !== ids.length) return stale('that week-only change')
  if (rows.every((r) => r.expires_on < today)) {
    return { ok: false, reason: 'stale', text: 'Can\'t undo: that week-only change has already expired; there is nothing left to put back.' }
  }
  if (voiding) {
    if (rows.some((r) => r.voided)) return stale('that week-only change (it was cleared)')
  } else {
    if (rows.some((r) => !r.voided)) return stale('that week-only change')
    if (rows.some((r) => r.expires_on < today)) return notRevertible('part of that week-only change has expired. Make the change again instead.')
    const [busy] = await store.sql<{ id: string }[]>`
      SELECT o.id::text AS id FROM session_override o
      WHERE o.athlete_id = ${store.athleteId} AND o.voided_at IS NULL
        AND EXISTS (
          SELECT 1 FROM session_override x
          WHERE x.id::text = ANY(${pgArrayLiteral(ids)}::text[]) AND x.date = o.date AND x.routine_id = o.routine_id
        )
      LIMIT 1
    `
    if (busy) return stale('that day (a newer week-only change sits on it)')
    const src = await store.sql<{ id: string; date: string; routine_id: string; ops: unknown; exercises: unknown; name: string }[]>`
      SELECT o.id::text AS id, o.date::text AS date, o.routine_id::text AS routine_id, o.ops, r.exercises, r.name
      FROM session_override o JOIN routine r ON r.id = o.routine_id
      WHERE o.athlete_id = ${store.athleteId} AND o.id::text = ANY(${pgArrayLiteral(ids)}::text[])
      ORDER BY o.date, o.id
    `
    const base = src.map((x) => ({ key: `${x.routine_id}@${x.date}`, name: x.name, dow: null, exercises: arr(asJson<unknown>(x.exercises, [])) as ExerciseTemplate[] }))
    const put = src.map((x, i) => ({ ...base[i], exercises: applyOverrideOps(base[i].exercises, [arr(asJson<unknown>(x.ops, [])) as OverrideOp[]]).exercises }))
    const red = await loadsBlockedRegion(store, base, put)
    if (red) return red
  }
  const tag = ctx.dir === 'undo' ? 'revert_session_override' : 'reapply_session_override'
  return {
    targetType: 'session_override',
    targetId: ids[0],
    diff: voiding ? { override_ids: ids, sessions: d.sessions ?? [], state: 'voided' } : { copies_of: ids, sessions: d.sessions ?? [], state: 'live' },
    apply: async ({ approvalRef, changeId }) => {
      const marker = `revert:${changeId}`
      if (voiding) {
        const voided = await store.sql<{ id: string }[]>`
          WITH v AS (
            UPDATE session_override
            SET voided_at = NOW(), void_approval_ref = ${approvalRef}::text, void_preview_id = ${marker}::text
            WHERE athlete_id = ${store.athleteId} AND voided_at IS NULL AND id::text = ANY(${pgArrayLiteral(ids)}::text[])
            RETURNING id, date, routine_id, expires_on
          ),
          logged AS (
            INSERT INTO session_override_log (
              athlete_id, actor_type, actor_id, tool, target, diff, rationale, approval_ref, preview_id, expires_on
            )
            SELECT ${store.athleteId}::uuid, 'athlete', ${store.athleteId}::text, ${tag}::text,
                   jsonb_build_object('override_id', v.id, 'date', v.date, 'routine_id', v.routine_id, 'revert_of', ${ctx.row.id}::text),
                   '{}'::jsonb, 'Undone by the athlete.', ${approvalRef}::text, ${marker}::text, v.expires_on
            FROM v
            RETURNING id
          )
          SELECT id::text AS id FROM v
        `
        if (voided.length !== ids.length) throw staleRefusal('that week-only change')
        return
      }
      // Copies, so the voided rows stay exactly as they were (audit); a pair keeps its pairing.
      const src = await store.sql<{ id: string; date: string; routine_id: string; ops: unknown; expires_on: string; pair_id: string | null }[]>`
        SELECT id::text AS id, date::text AS date, routine_id::text AS routine_id, ops, expires_on::text AS expires_on, pair_id::text AS pair_id
        FROM session_override
        WHERE athlete_id = ${store.athleteId} AND voided_at IS NOT NULL AND id::text = ANY(${pgArrayLiteral(ids)}::text[])
        ORDER BY date, id
      `
      if (src.length !== ids.length) throw staleRefusal('that week-only change')
      const pairs = new Map<string, string>()
      const copied: string[] = []
      for (const s of src) {
        const pair = s.pair_id ? (pairs.get(s.pair_id) ?? (pairs.set(s.pair_id, crypto.randomUUID()), pairs.get(s.pair_id)!)) : null
        const [row] = await store.sql<{ id: string }[]>`
          INSERT INTO session_override (
            athlete_id, date, routine_id, ops, expires_on, pair_id, actor_type, actor_id, rationale, approval_ref, preview_id
          ) VALUES (
            ${store.athleteId}, ${s.date}::date, ${s.routine_id}, ${jsonParam(store.sql, asJson<unknown>(s.ops, []))}, ${s.expires_on}::date,
            ${pair}, 'athlete', ${store.athleteId}, 'Put back by the athlete (an undo, undone).', ${approvalRef}, ${marker}
          )
          RETURNING id::text AS id
        `
        await store.sql`
          INSERT INTO session_override_log (
            athlete_id, actor_type, actor_id, tool, target, diff, rationale, approval_ref, preview_id, expires_on
          ) VALUES (
            ${store.athleteId}, 'athlete', ${store.athleteId}, ${tag},
            ${jsonParam(store.sql, { override_id: row.id, copy_of: s.id, date: s.date, routine_id: s.routine_id, revert_of: ctx.row.id })},
            '{}'::jsonb, 'Put back by the athlete.', ${approvalRef}, ${marker}, ${s.expires_on}::date
          )
        `
        copied.push(row.id)
      }
      return { override_ids: copied }
    },
  }
}

const OVERRIDES: Handler = {
  defined: 'A week-only change is cleared (kept, voided); a clear puts the change back as a copy while it has not expired. Redo flips it again.',
  keys: overrideKeys,
  plan: planOverride,
}

// ---- tombstoned rows ----------------------------------------------------------------------

/** Retire (undo) or bring back (redo) one row a change created. */
async function planRetire(
  store: ConnectedStore,
  ctx: PlanCtx,
  t: { table: TombTable; rowId: string; what: string; targetType: string; diff: Obj; guard?: () => Promise<Fail | null> },
): Promise<RevertPlan | Fail> {
  if (!(await tombstonesReady(store))) return unavailable
  if (!UUID_RE.test(t.rowId)) return notRevertible('this row names nothing to put back.')
  const undo = ctx.dir === 'undo'
  const hidden = await isTombstoned(store, t.table, t.rowId)
  if (hidden === undo) return stale(t.what)
  const lifting = undo ? [] : (await tombstonesBy(store, ctx.row.id)).filter((x) => x.row_table === t.table && x.row_id === t.rowId)
  if (!undo && !lifting.length) return stale(t.what)
  const blocked = t.guard ? await t.guard() : null
  if (blocked) return blocked
  return {
    targetType: t.targetType,
    targetId: t.rowId,
    diff: { ...t.diff, [undo ? 'retired' : 'restored']: true },
    apply: async ({ changeId }) => {
      const done = undo
        ? await writeTombstone(store, { table: t.table, rowId: t.rowId, kind: 'retire', changeId, voidsChangeId: ctx.row.id })
        : (await liftTombstones(store, lifting.map((x) => x.id), changeId)) === lifting.length
      if (!done) throw staleRefusal(t.what)
    },
  }
}

const CREATE_TRACK: Handler = {
  defined: 'The track is retired: hidden everywhere, never deleted, once nothing is assigned to it. Redo brings it back.',
  keys: (d, row) => [`track:${idOf(d, 'track_id', row)}:exists`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'track_id', ctx.row)
    const name = str(d.name) ?? str(obj(d.after).name) ?? 'that'
    return planRetire(store, ctx, {
      table: 'track',
      rowId: id,
      what: `the ${name} track`,
      targetType: 'track',
      diff: { track_id: id, name, after: d.after ?? { name } },
      guard: async () => {
        if (!(await trackSnapshot(store, id))) return stale(`the ${name} track`)
        if (ctx.dir === 'redo') return null
        const [used] = await store.sql<{ n: number }[]>`
          SELECT (
            (SELECT count(*) FROM routine r JOIN program p ON p.id = r.program_id
             WHERE p.athlete_id = ${store.athleteId} AND r.exercises @> ${jsonParam(store.sql, [{ track_id: id }])})
            + (SELECT count(*) FROM athlete_goal g WHERE g.athlete_id = ${store.athleteId} AND g.track_id = ${id})
            + (SELECT count(*) FROM progression_rule pr JOIN program p ON p.id = pr.program_id
               WHERE p.athlete_id = ${store.athleteId} AND pr.track_id = ${id} AND (pr.active_to IS NULL OR pr.active_to >= CURRENT_DATE))
          )::int AS n
        `
        return Number(used?.n ?? 0) > 0
          ? notRevertible(`exercises, goals or rules still use the ${name} track. Move them off it (or undo those changes) first.`)
          : null
      },
    })
  },
}

const AUTOREG: Handler = {
  defined: 'The rule is retired: it stops applying and is hidden, never deleted. Redo brings it back.',
  keys: (d, row) => [`autoreg:${idOf(d, 'rule_id', row)}`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'rule_id', ctx.row)
    return planRetire(store, ctx, {
      table: 'autoreg_rule',
      rowId: id,
      what: 'that rule',
      targetType: 'autoreg_rule',
      diff: { rule_id: id, after: d.after ?? null },
      guard: async () => {
        const [row] = await store.sql<{ id: string }[]>`SELECT id::text AS id FROM autoreg_rule WHERE id = ${id} AND athlete_id = ${store.athleteId}`
        return row ? null : stale('that rule')
      },
    })
  },
}

/** Void (undo) or bring back (redo) a logging row. */
async function planVoid(
  store: ConnectedStore,
  ctx: PlanCtx,
  t: { table: TombTable; rowId: string; what: string; targetType: string; diff: Obj; exists: () => Promise<boolean> },
): Promise<RevertPlan | Fail> {
  if (!(await tombstonesReady(store))) return unavailable
  if (!UUID_RE.test(t.rowId) || !(await t.exists())) return stale(t.what)
  const undo = ctx.dir === 'undo'
  if ((await isTombstoned(store, t.table, t.rowId)) === undo) return stale(t.what)
  const lifting = undo ? [] : (await tombstonesBy(store, ctx.row.id)).filter((x) => x.row_table === t.table && x.row_id === t.rowId)
  if (!undo && !lifting.length) return stale(t.what)
  return {
    targetType: t.targetType,
    targetId: t.rowId,
    diff: { ...t.diff, [undo ? 'voided' : 'restored']: true },
    apply: async ({ changeId }) => {
      const done = undo
        ? await writeTombstone(store, { table: t.table, rowId: t.rowId, kind: 'void', changeId, voidsChangeId: ctx.row.id })
        : (await liftTombstones(store, lifting.map((x) => x.id), changeId)) === lifting.length
      if (!done) throw staleRefusal(t.what)
    },
  }
}

const NOTE: Handler = {
  defined: 'The note is voided: it stays in the record, hidden from the log. Redo shows it again.',
  keys: (d, row) => [`note:${idOf(d, 'note_id', row)}`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'note_id', ctx.row)
    return planVoid(store, ctx, {
      table: 'workout_note',
      rowId: id,
      what: 'that note',
      targetType: 'workout_note',
      diff: { note_id: id, text: d.text ?? null, workout_id: d.workout_id ?? null, session_id: d.session_id ?? null },
      exists: async () => (await store.sql<{ id: string }[]>`SELECT id::text AS id FROM workout_note WHERE id = ${id} AND athlete_id = ${store.athleteId}`).length > 0,
    })
  },
}

const GOAL_STATE = ['current', 'best', 'baseline', 'status'] as const

async function goalState(store: ConnectedStore, goalId: string): Promise<Obj | null> {
  if (!UUID_RE.test(goalId)) return null
  const [row] = await store.sql<Obj[]>`
    SELECT current::float8 AS current, best::float8 AS best, baseline::float8 AS baseline, status
    FROM athlete_goal WHERE id = ${goalId} AND athlete_id = ${store.athleteId}
  `
  return row ? Object.fromEntries(GOAL_STATE.map((k) => [k, row[k] ?? null])) : null
}

const MEASUREMENT: Handler = {
  defined: 'The measurement is voided (kept, hidden) and the goal\'s current, best and baseline go back to what they were before it. Redo logs it back.',
  blocked: (d) => (d.goal_before === undefined || d.goal_after === undefined ? LEGACY : null),
  keys: (d, row) => [`goal_state:${String(d.goal_id ?? '')}`, `measurement:${idOf(d, 'measurement_id', row)}`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'measurement_id', ctx.row)
    const goalId = String(d.goal_id ?? '')
    const now = await goalState(store, goalId)
    if (!now || !same(now, d.goal_after)) return stale('that goal')
    const restore = obj(d.goal_before)
    const plan = await planVoid(store, ctx, {
      table: 'goal_measurement',
      rowId: id,
      what: 'that measurement',
      targetType: 'goal_measurement',
      diff: { measurement_id: id, goal: d.goal ?? null, goal_id: goalId, date: d.date ?? null, value: d.value ?? null, side: d.side ?? null, goal_before: d.goal_after, goal_after: d.goal_before },
      exists: async () => (await store.sql<{ id: string }[]>`SELECT id::text AS id FROM goal_measurement WHERE id = ${id} AND athlete_id = ${store.athleteId}`).length > 0,
    })
    if ('ok' in plan) return plan
    return {
      ...plan,
      apply: async (c) => {
        await plan.apply(c)
        const done = await store.sql<{ id: string }[]>`
          UPDATE athlete_goal SET current = ${(restore.current ?? null) as number | null}, best = ${(restore.best ?? null) as number | null},
                 baseline = ${(restore.baseline ?? null) as number | null}, status = ${String(restore.status ?? 'on_track')}, updated_at = NOW()
          WHERE id = ${goalId} AND athlete_id = ${store.athleteId}
          RETURNING id
        `
        if (!done.length) throw staleRefusal('that goal')
      },
    }
  },
}

// ---- snapshot restores --------------------------------------------------------------------

const UPDATE_TRACK: Handler = {
  defined: 'The track\'s details go back to what they were.',
  keys: (d, row) => [`track:${idOf(d, 'track_id', row)}`],
  plan: async (store, d) => {
    const id = String(d.track_id ?? '')
    const now = await trackSnapshot(store, id)
    if (!now || !same(now, d.after)) return stale('that track')
    const b = obj(d.before)
    return {
      targetType: 'track',
      targetId: id,
      diff: { track_id: id, before: d.after, after: d.before },
      apply: async () => {
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
  },
}

const PROGRESSION_RULE: Handler = {
  defined: 'The rule is ended (from yesterday), not deleted, so the track goes back to the rule before it. Redo reopens it.',
  blocked: (d, dir) => (dir === 'redo' && typeof d.ended_on !== 'string' ? LEGACY : null),
  keys: (d) => [`rule:${String(d.rule_id ?? '')}`],
  plan: async (store, d, ctx) => {
    const id = String(d.rule_id ?? '')
    if (!UUID_RE.test(id)) return notRevertible('this row names no rule.')
    const undo = ctx.dir === 'undo'
    const a = obj(undo ? d.after : d.before)
    const [row] = await store.sql<{ engine_type: string; params: unknown; active_to: string | null }[]>`
      SELECT pr.engine_type, pr.params, pr.active_to::text AS active_to
      FROM progression_rule pr JOIN program p ON p.id = pr.program_id
      WHERE pr.id = ${id} AND p.athlete_id = ${store.athleteId}
      LIMIT 1
    `
    if (!row || row.engine_type !== a.engine_type || !same(asJson(row.params, {}), a.params ?? {})) return stale('that progression rule')
    if (undo ? row.active_to != null : row.active_to !== d.ended_on) return stale('that progression rule')
    const rule = { ...a, active_to: null }
    return {
      targetType: 'progression_rule',
      targetId: id,
      diff: undo
        ? { rule_id: id, track_id: d.track_id ?? null, before: rule, after: { ...rule, active_to: 'yesterday' }, ended: true }
        : { rule_id: id, track_id: d.track_id ?? null, before: { ...rule, active_to: d.ended_on }, after: rule, reopened: true },
      apply: async () => {
        // Ended, not deleted: readers already skip a rule whose active_to has passed.
        const done = undo
          ? await store.sql<{ id: string; active_to: string }[]>`
              UPDATE progression_rule SET active_to = CURRENT_DATE - 1
              WHERE id = ${id} AND active_to IS NULL
                AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
              RETURNING id, active_to::text AS active_to
            `
          : await store.sql<{ id: string; active_to: string }[]>`
              UPDATE progression_rule SET active_to = NULL
              WHERE id = ${id} AND active_to = ${String(d.ended_on)}::date
                AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
              RETURNING id, active_to::text AS active_to
            `
        if (!done.length) throw staleRefusal('that progression rule')
        return undo ? { ended_on: done[0].active_to } : undefined
      },
    }
  },
}

const GOAL: Handler = {
  defined: 'An edited goal goes back to its old definition (its measurements are kept). A goal the change created is retired: hidden, never deleted. Redo re-applies it.',
  keys: (d, row) => [d.before == null || d.after == null ? `goal:${idOf(d, 'goal_id', row)}:exists` : `goal:${idOf(d, 'goal_id', row)}`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'goal_id', ctx.row)
    const after = obj(d.after)
    const def = (g: Obj) => Object.fromEntries(GOAL_FIELDS.map((k) => [k, g[k] ?? null]))
    const name = str(after.name) ?? str(obj(d.before).name) ?? ''
    // Created → retired (undo); retired → back (redo of that undo).
    if (d.before == null || d.retired === true) {
      const creating = ctx.dir === 'undo'
      return planRetire(store, ctx, {
        table: 'athlete_goal',
        rowId: id,
        what: `the ${name} goal`,
        targetType: 'athlete_goal',
        diff: creating ? { goal_id: id, before: d.after, after: null } : { goal_id: id, before: null, after: d.before },
        // Retiring hides the goal whatever was edited on it since; nothing is overwritten.
        guard: async () => ((await goalSnapshot(store, { id })) ? null : stale(`the ${name} goal`)),
      })
    }
    const now = await goalSnapshot(store, { id })
    if (!now || !same(def(now), def(after))) return stale('that goal')
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
  },
}

const ATHLETE_TARGET: Handler = {
  defined: 'Your target text goes back to what it was.',
  keys: () => ['athlete.goals'],
  plan: async (store, d) => {
    const [row] = await store.sql<{ goals: string | null }[]>`SELECT goals FROM athlete WHERE id = ${store.athleteId}`
    if (!same(row?.goals ?? null, obj(d.after).goals ?? null)) return stale('your target')
    const before = (obj(d.before).goals ?? null) as string | null
    const after = (obj(d.after).goals ?? null) as string | null
    return {
      targetType: 'athlete',
      targetId: store.athleteId,
      diff: { before: d.after, after: d.before },
      apply: async () => {
        const done = await store.sql<{ id: string }[]>`
          UPDATE athlete SET goals = ${before} WHERE id = ${store.athleteId} AND goals IS NOT DISTINCT FROM ${after}
          RETURNING id
        `
        if (!done.length) throw staleRefusal('your target')
      },
    }
  },
}

const PROGRAM_META: Handler = {
  defined: 'The block\'s name, phase and dates go back to what they were.',
  keys: (d, row) => [`program_meta:${idOf(d, 'program_id', row)}`],
  plan: async (store, d) => {
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
  },
}

const TRAINING_MAX: Handler = {
  defined: 'That lift\'s training max goes back to its previous value (or back to auto). Other lifts are untouched.',
  keys: (d) => [`tm:${String(d.lift ?? '')}`],
  plan: async (store, d) => {
    const lift = String(d.lift ?? '')
    if (!/^(squat|bench|deadlift|ohp)$/.test(lift)) return notRevertible('this row names no lift.')
    if (!same(await trainingMaxEntry(store, lift), d.after)) return stale(`the ${lift} training max`)
    const before = d.before ?? null
    return {
      targetType: 'training_max',
      targetId: lift,
      diff: { lift, before: d.after ?? null, after: before },
      apply: async () => {
        // Only the lift this change set, and only back to what it was.
        const json = before == null ? null : JSON.stringify(before)
        const was = d.after == null ? null : JSON.stringify(d.after)
        const done = await store.sql<{ id: string }[]>`
          UPDATE athlete SET training_max_overrides = CASE
            WHEN ${json}::jsonb IS NULL THEN COALESCE(training_max_overrides, '{}'::jsonb) - ${lift}::text
            ELSE COALESCE(training_max_overrides, '{}'::jsonb) || jsonb_build_object(${lift}::text, ${json}::jsonb)
          END
          WHERE id = ${store.athleteId}
            AND (COALESCE(training_max_overrides, '{}'::jsonb) -> ${lift}::text) IS NOT DISTINCT FROM ${was}::jsonb
          RETURNING id
        `
        if (!done.length) throw staleRefusal(`the ${lift} training max`)
      },
    }
  },
}

// ---- methodology and safety ---------------------------------------------------------------

const methodologyKey = (d: Obj) => `methodology:${String(d.path ?? '')}:${String(d.track_id ?? '')}`

/** Overrides as they would be with this scope's active row replaced by `value` (or none). */
function withScope(overrides: OverrideRecord[], path: string, trackId: string | null, value: unknown): OverrideRecord[] {
  const rest = overrides.filter((o) => !(o.path === path && (o.track_id ?? null) === trackId))
  return value === undefined ? rest : [...rest, { id: 'revert', path, track_id: trackId, value }]
}

async function insertOverride(
  store: ConnectedStore,
  o: { id: string; path: string; trackId: string | null; value: unknown; rationale: string; ruleRefs: string[] },
  ctx: ApplyCtx,
): Promise<void> {
  await store.sql`
    INSERT INTO methodology_override (
      id, athlete_id, track_id, methodology_version, path, value, rationale, rule_refs,
      actor_type, actor_id, approval_ref, approval_id, preview_id, change_id
    ) VALUES (
      ${o.id}, ${store.athleteId}, ${o.trackId}, ${CURRENT_METHODOLOGY.version}, ${o.path},
      ${jsonParam(store.sql, o.value)}, ${o.rationale}, ${jsonParam(store.sql, o.ruleRefs)},
      'athlete', ${store.athleteId}, ${ctx.approvalRef}, ${ctx.approvalId}, ${`revert:${ctx.changeId}`}, ${ctx.changeId}
    )
  `
}

async function supersede(store: ConnectedStore, id: string, by: string | null): Promise<void> {
  const done = await store.sql<{ id: string }[]>`
    UPDATE methodology_override SET superseded_at = NOW(), superseded_by = ${by}
    WHERE id = ${id} AND athlete_id = ${store.athleteId} AND superseded_at IS NULL
    RETURNING id
  `
  if (!done.length) throw staleRefusal('that rule')
}

const METHODOLOGY_OVERRIDE: Handler = {
  defined: 'The rule goes back to the value it had before (or to the default). Never when that would loosen an under-18 rule or lift a red flag; a red flag only lifts with the clinician clear.',
  keys: (d) => [methodologyKey(d)],
  plan: async (store, d) => {
    const path = String(d.path ?? '')
    const trackId = typeof d.track_id === 'string' ? d.track_id : null
    const [overrides, minor] = await Promise.all([loadOverrides(store), athleteMinor(store)])
    const cur = overrides.find((o) => o.path === path && (o.track_id ?? null) === trackId) ?? null
    if ((cur?.id ?? null) !== ((d.override_id as string | null | undefined) ?? null)) return stale('that rule')
    let restored: unknown
    if (typeof d.superseded === 'string') {
      const [old] = await store.sql<{ value: unknown }[]>`
        SELECT value FROM methodology_override WHERE id = ${d.superseded} AND athlete_id = ${store.athleteId}
      `
      if (!old) return stale('that rule')
      restored = asJson<unknown>(old.value, null)
    }
    const clear = restored === undefined
    if (clear && !cur) return notRevertible('there is nothing to put back.')
    const opts = { trackId, minor: minor === true }
    const now = resolveParams(CURRENT_METHODOLOGY, overrides, opts)
    const withoutThis = resolveParams(CURRENT_METHODOLOGY, withScope(overrides, path, trackId, undefined), opts)
    // Every methodology guard, as the athlete: under-18 rules only tighten, no raised cap for a minor or a red-flagged region.
    const check = checkOverride({ path, value: restored, clear, trackId, now, withoutThis, minor, actorType: 'athlete', exists: cur != null })
    if (!check.ok) return notRevertible(check.text.replace(/^Refused: /, ''))
    const athleteNow = resolveParams(CURRENT_METHODOLOGY, overrides, { trackId: null, minor: minor === true })
    const athleteAfter = resolveParams(CURRENT_METHODOLOGY, withScope(overrides, path, trackId, restored), { trackId: null, minor: minor === true })
    const lifted = blockedRegions(athleteNow).filter((r) => !blockedRegions(athleteAfter).includes(r))
    if (lifted.length) {
      return notRevertible(`it would lift the red flag on the ${lifted.join(', ').replace(/_/g, ' ')}. A red flag only lifts when you mark it cleared by a clinician.`)
    }
    return {
      targetType: 'methodology',
      targetId: path,
      diff: { path, track_id: trackId, before: check.before, after: check.after, superseded: cur?.id ?? null, base_version: CURRENT_METHODOLOGY.version },
      apply: async (ctx) => {
        const newId = clear ? null : crypto.randomUUID()
        // Superseded first: one active row per scope.
        if (cur) await supersede(store, cur.id, newId)
        if (newId) await insertOverride(store, { id: newId, path, trackId, value: restored, rationale: 'Put back by the athlete (an undo).', ruleRefs: [] }, ctx)
        return { override_id: newId }
      },
    }
  },
}

const SAFETY_REDO = 'only the clinician clear lifts a block. If a clinician has cleared it again, mark it cleared again.'

const CLEAR_RED_FLAG: Handler = {
  defined: 'The red flag is set again, so the region is blocked (safety first). Redoing the clear is refused: only the clinician clear lifts it.',
  blocked: (_d, dir) => (dir === 'redo' ? SAFETY_REDO : null),
  keys: (d) => [methodologyKey({ path: d.path, track_id: null })],
  plan: async (store, d) => {
    const path = String(d.path ?? '')
    const region = String(d.region ?? '')
    if (!/^U7\.regions\.[a-z_]+\.blocked$/.test(path)) return notRevertible('this row names no red flag.')
    const overrides = await loadOverrides(store)
    const cur = overrides.find((o) => o.path === path && o.track_id == null) ?? null
    if (cur?.value === true) return { ok: false, reason: 'stale', text: 'Can\'t undo: that red flag is already set again.' }
    return {
      targetType: 'methodology',
      targetId: path,
      diff: { path, region, before: false, after: true, superseded: cur?.id ?? null, reflagged: true },
      apply: async (ctx) => {
        const id = crypto.randomUUID()
        if (cur) await supersede(store, cur.id, id)
        await insertOverride(store, { id, path, trackId: null, value: true, rationale: 'Red flag set again: the athlete undid the clinician clear.', ruleRefs: ['U7'] }, ctx)
        return { override_id: id }
      },
    }
  },
}

const CLEAR_REGION: Handler = {
  defined: 'The region is blocked again (safety first). Redoing the clear is refused: only the clinician clear lifts a block.',
  blocked: (_d, dir) => (dir === 'redo' ? SAFETY_REDO : null),
  keys: (d, row) => [`region:${String(d.region ?? row.target_id ?? '')}`],
  plan: async (store, d) => {
    const region = String(d.region ?? '')
    if (!(await readinessTables(store))) return unavailable
    if (!/^[a-z_]+$/.test(region)) return notRevertible('this row names no region.')
    if (blocksNow((await loadRegionStatus(store)).find((s) => s.region === region))) {
      return { ok: false, reason: 'stale', text: 'Can\'t undo: that region is already blocked again.' }
    }
    return {
      targetType: 'region',
      targetId: region,
      diff: { region, cleared_status_id: d.status_id ?? null, reblocked: true },
      apply: async ({ changeId }) => {
        const [row] = await store.sql<{ id: string }[]>`
          INSERT INTO region_status (athlete_id, region, status, reason, change_id)
          VALUES (${store.athleteId}, ${region}, 'blocked', 'Blocked again: the athlete undid the clinician clear (U7).', ${changeId})
          RETURNING id::text AS id
        `
        return { status_id: row.id }
      },
    }
  },
}

// ---- logging: check-ins and session RPE ---------------------------------------------------

const CHECKIN: Handler = {
  defined: 'The check-in and its pain scores are voided (kept, hidden): readiness no longer counts them. A block it set stays until the clinician clear. Redo counts them again.',
  keys: (d, row) => [`checkin:${String(d.checkin_change_id ?? row.id)}`],
  plan: async (store, d, ctx) => {
    if (!(await readinessTables(store)) || !(await tombstonesReady(store))) return unavailable
    const origin = String(d.checkin_change_id ?? ctx.row.id)
    const undo = ctx.dir === 'undo'
    if (undo) {
      const [checkins, pains] = await Promise.all([
        store.sql<{ id: string }[]>`SELECT id::text AS id FROM checkin WHERE athlete_id = ${store.athleteId} AND change_id = ${origin} ORDER BY id`,
        store.sql<{ id: string }[]>`SELECT id::text AS id FROM pain_report WHERE athlete_id = ${store.athleteId} AND change_id = ${origin} ORDER BY id`,
      ])
      if (!checkins.length && !pains.length) return stale('that check-in')
      for (const c of checkins) if (await isTombstoned(store, 'checkin', c.id)) return stale('that check-in')
      for (const p of pains) if (await isTombstoned(store, 'pain_report', p.id)) return stale('that check-in')
      const regions = arr(d.regions).map(obj).filter((m) => m.to === 'blocked').map((m) => String(m.region))
      return {
        targetType: 'checkin',
        targetId: str(d.date) ?? ctx.row.target_id,
        diff: {
          date: d.date ?? null, checkin_change_id: origin, voided: { checkin: checkins[0]?.id ?? null, pain: pains.map((p) => p.id) },
          ...(regions.length ? { still_blocked: regions } : {}),
        },
        apply: async ({ changeId }) => {
          const rows: Array<{ table: TombTable; id: string }> = [...checkins.map((c) => ({ table: 'checkin' as const, id: c.id })), ...pains.map((p) => ({ table: 'pain_report' as const, id: p.id }))]
          for (const r of rows) {
            if (!(await writeTombstone(store, { table: r.table, rowId: r.id, kind: 'void', changeId, voidsChangeId: origin }))) throw staleRefusal('that check-in')
          }
        },
      }
    }
    const lifting = (await tombstonesBy(store, ctx.row.id)).filter((x) => x.row_table === 'checkin' || x.row_table === 'pain_report')
    if (!lifting.length) return stale('that check-in')
    return {
      targetType: 'checkin',
      targetId: str(d.date) ?? ctx.row.target_id,
      diff: { date: d.date ?? null, checkin_change_id: origin, restored: { rows: lifting.map((x) => x.row_id).sort() } },
      apply: async ({ changeId }) => {
        if ((await liftTombstones(store, lifting.map((x) => x.id), changeId)) !== lifting.length) throw staleRefusal('that check-in')
      },
    }
  },
}

const SESSION_RPE: Handler = {
  defined: 'Session effort goes back to the rating before this tap; a first rating is voided (kept, hidden). Redo puts the tap back.',
  keys: (d, row) => [`session_rpe:${idOf(d, 'session_rpe_id', row)}`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'session_rpe_id', ctx.row)
    if (!UUID_RE.test(id)) return notRevertible('this row names no rating.')
    if (!(await tombstonesReady(store))) return unavailable
    const [s] = await store.sql<{ rating: number; duration_min: number | null; change_id: string | null }[]>`
      SELECT rating::int AS rating, duration_min::int AS duration_min, change_id::text AS change_id
      FROM session_rpe WHERE id = ${id} AND athlete_id = ${store.athleteId}
    `
    // The tap the row should still carry: this row's, or (after a void and its redo) the one voided.
    const tap = String(d.tap_change_id ?? ctx.row.id)
    if (!s || s.change_id !== tap) return stale('that session\'s effort')
    const base = { session_rpe_id: id, date: d.date ?? null, session_id: d.session_id ?? null, session: d.session ?? null }
    const hidden = await isTombstoned(store, 'session_rpe', id)
    if (d.after == null) {
      // This row voided a first rating: put it back.
      const lifting = (await tombstonesBy(store, ctx.row.id)).filter((x) => x.row_table === 'session_rpe' && x.row_id === id)
      if (!hidden || !lifting.length) return stale('that session\'s effort')
      return {
        targetType: 'session_rpe',
        targetId: id,
        diff: { ...base, before: null, after: d.before, tap_change_id: tap, restored: true },
        apply: async ({ changeId }) => {
          if ((await liftTombstones(store, lifting.map((x) => x.id), changeId)) !== lifting.length) throw staleRefusal('that session\'s effort')
        },
      }
    }
    const after = obj(d.after)
    if (hidden || s.rating !== Number(after.rating) || (s.duration_min ?? null) !== ((after.duration_min as number | null | undefined) ?? null)) {
      return stale('that session\'s effort')
    }
    if (d.before == null) {
      return {
        targetType: 'session_rpe',
        targetId: id,
        diff: { ...base, before: d.after, after: null, tap_change_id: tap, voided: true },
        apply: async ({ changeId }) => {
          if (!(await writeTombstone(store, { table: 'session_rpe', rowId: id, rowChangeId: tap, kind: 'void', changeId, voidsChangeId: ctx.row.id }))) {
            throw staleRefusal('that session\'s effort')
          }
        },
      }
    }
    const b = obj(d.before)
    return {
      targetType: 'session_rpe',
      targetId: id,
      diff: { ...base, before: d.after, after: d.before },
      apply: async ({ changeId }) => {
        const done = await store.sql<{ id: string }[]>`
          UPDATE session_rpe SET rating = ${Number(b.rating)}, duration_min = ${(b.duration_min ?? null) as number | null},
                 change_id = ${changeId}, updated_at = NOW()
          WHERE id = ${id} AND athlete_id = ${store.athleteId} AND change_id = ${tap}
          RETURNING id
        `
        if (!done.length) throw staleRefusal('that session\'s effort')
        return { tap_change_id: changeId }
      },
    }
  },
}

// ---- coach access, birth date -------------------------------------------------------------

function coachAccessHandler(field: 'share_health' | 'role', label: string): Handler {
  return {
    defined: `The coach's ${label} goes back to what it was (only while the coach still has access).`,
    keys: (d, row) => [`mcp_token:${idOf(d, 'token_id', row)}:${field}`],
    plan: async (store, d, ctx) => {
      const id = idOf(d, 'token_id', ctx.row)
      if (!UUID_RE.test(id)) return notRevertible('this row names no coach.')
      const change = obj(d[field])
      const [row] = await store.sql<{ v: string | null; revoked: boolean }[]>`
        SELECT to_jsonb(t) ->> ${field}::text AS v, (t.revoked_at IS NOT NULL) AS revoked
        FROM mcp_token t WHERE t.id = ${id} AND t.athlete_id = ${store.athleteId}
      `
      if (!row) return stale('that coach')
      if (row.revoked) return notRevertible('that coach no longer has access. Invite them again instead.')
      // Read as the access screen does: no role column is 'propose'; no share_health column is on.
      const now = field === 'role' ? (row.v ?? 'propose') : row.v !== 'false'
      if (!same(now, change.after)) return stale(`that coach's ${label}`)
      return {
        targetType: 'mcp_token',
        targetId: id,
        diff: { coach: d.coach ?? null, token_id: id, [field]: { before: change.after, after: change.before } },
        apply: async () => {
          const done = field === 'role'
            ? await store.sql<{ id: string }[]>`
                UPDATE mcp_token SET role = ${String(change.before)}
                WHERE id = ${id} AND athlete_id = ${store.athleteId} AND revoked_at IS NULL
                RETURNING id::text AS id
              `
            : await store.sql<{ id: string }[]>`
                UPDATE mcp_token SET share_health = ${change.before === true}
                WHERE id = ${id} AND athlete_id = ${store.athleteId} AND revoked_at IS NULL
                RETURNING id::text AS id
              `
          if (!done.length) throw staleRefusal('that coach')
        },
      }
    },
  }
}

const BIRTH_DATE: Handler = {
  defined: 'The birth date goes back to not on file, for an adult only: under-18 rules are never loosened by an undo. Redo records it again.',
  keys: () => ['athlete.birth_date'],
  plan: async (store, d) => {
    const [row] = await store.sql<{ birth_date: string | null }[]>`SELECT to_jsonb(a) ->> 'birth_date' AS birth_date FROM athlete a WHERE a.id = ${store.athleteId}`
    const now = row?.birth_date ? row.birth_date.slice(0, 10) : null
    if (now !== ((d.after as string | null | undefined) ?? null)) return stale('your birth date')
    // Removing a minor's date would drop their under-18 rules: refused. Recording one only tightens.
    if (d.before == null && (await athleteMinor(store)) !== false) {
      return notRevertible('you are under 18, and under-18 rules can only be tightened, never loosened.')
    }
    const before = (d.before as string | null | undefined) ?? null
    return {
      targetType: 'athlete',
      targetId: store.athleteId,
      diff: { field: 'birth_date', before: d.after ?? null, after: before },
      apply: async () => {
        const done = await store.sql<{ id: string }[]>`
          UPDATE athlete SET birth_date = ${before}::date
          WHERE id = ${store.athleteId} AND birth_date IS NOT DISTINCT FROM ${now}::date
          RETURNING id::text AS id
        `
        if (!done.length) throw staleRefusal('your birth date')
      },
    }
  },
}

// ---- coach_v1: activities and composed blocks ---------------------------------------------

const ACTIVITY_FIELDS = ['module', 'name', 'sessions_per_week', 'season', 'days', 'active'] as const

const ACTIVITY: Handler = {
  defined: 'The activity goes back to what it was; one the change added is set inactive (never deleted). A re-compose is then due.',
  keys: (d, row) => [`activity:${idOf(d, 'activity_id', row)}`],
  plan: async (store, d, ctx) => {
    const id = idOf(d, 'activity_id', ctx.row)
    if (!UUID_RE.test(id)) return notRevertible('this row names no activity.')
    const [row] = await store.sql<{ module_key: string; name: string; sessions_per_week: number; season: string; days: unknown; active: boolean }[]>`
      SELECT module_key, name, sessions_per_week::int AS sessions_per_week, season, days, active
      FROM activity WHERE id = ${id} AND athlete_id = ${store.athleteId}
      FOR UPDATE
    `
    if (!row) return stale('that activity')
    const days = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/[{}]/g, '').split(',').filter(Boolean) : [])
      .map(Number).sort((a, b) => a - b)
    const now = { module: row.module_key, name: row.name, sessions_per_week: Number(row.sessions_per_week), season: row.season, days: days(row.days), active: row.active }
    const pick = (o: Obj) => Object.fromEntries(ACTIVITY_FIELDS.map((k) => [k, k === 'days' ? days(o.days) : o[k] ?? null]))
    const after = obj(d.after)
    if (!same(pick(now), pick(after))) return stale('that activity')
    const restore = d.before == null ? { ...pick(after), active: false } : pick(obj(d.before))
    return {
      targetType: 'activity',
      targetId: id,
      diff: { op: 'revert', activity_id: id, before: pick(after), after: restore },
      apply: async ({ changeId }) => {
        const done = await store.sql<{ id: string }[]>`
          UPDATE activity SET module_key = ${String(restore.module)}, name = ${String(restore.name)},
                 sessions_per_week = ${Number(restore.sessions_per_week)}, season = ${String(restore.season)},
                 days = ${`{${(restore.days as number[]).join(',')}}`}::smallint[], active = ${restore.active === true},
                 change_id = ${changeId}, updated_at = NOW()
          WHERE id = ${id} AND athlete_id = ${store.athleteId}
          RETURNING id::text AS id
        `
        if (!done.length) throw staleRefusal('that activity')
      },
    }
  },
}

function blockKeys(d: Obj): string[] {
  const keys = new Set<string>(['block'])
  for (const id of arr(d.activities_added)) keys.add(`activity:${String(id)}`)
  for (const id of [...arr(d.goals_added), ...arr(d.screen_goals_added), ...arr(d.goals_unretired)]) keys.add(`goal:${String(id)}:exists`)
  for (const g of arr(d.goals_weighted).map(obj)) keys.add(`goal_weight:${String(g.goal_id)}`)
  for (const t of arr(d.tracks).map(obj)) {
    keys.add(t.created === true || t.unretired === true ? `track:${String(t.track_id)}:exists` : `track:${String(t.track_id)}`)
    if (t.rule_id) keys.add(`rule:${String(t.rule_id)}`)
  }
  if (typeof d.program_id === 'string') keys.add(`program_meta:${d.program_id}`)
  return [...keys]
}

const COMPOSED_BLOCK: Handler = {
  defined: 'The block comes off: its rules end, tracks and goals it created are retired, added activities go inactive, goal weights, track purposes and block dates go back, and the block before it is the block of record again. Redo is refused: re-compose instead, so the new block runs on the current methodology.',
  blocked: (d, dir) => {
    if (dir === 'redo') return 'a block is never re-applied from the log. Ask your coach to re-compose, so the new block runs on the current methodology, and approve that.'
    return arr(d.tracks).length && !d.ended_rule_ends ? LEGACY : null
  },
  keys: blockKeys,
  plan: async (store, d, ctx) => {
    if (!(await tombstonesReady(store))) return unavailable
    const blockId = String(d.block_id ?? ctx.row.target_id ?? '')
    const [cur] = await store.sql<{ id: string }[]>`
      SELECT id::text AS id FROM composed_block WHERE athlete_id = ${store.athleteId} AND superseded_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1
      FOR UPDATE
    `
    if (cur?.id !== blockId) return stale('the block (a newer one is in place)')
    const meta = obj(d.program_meta)
    if (typeof d.program_id === 'string' && !same(await programMetaSnapshot(store, d.program_id), meta.after)) return stale('the block dates')
    const tracks = arr(d.tracks).map(obj)
    const ends = obj(d.ended_rule_ends)
    for (const t of tracks) {
      const [rule] = await store.sql<{ open: boolean }[]>`
        SELECT (pr.active_to IS NULL OR pr.active_to >= CURRENT_DATE) AS open
        FROM progression_rule pr JOIN program p ON p.id = pr.program_id
        WHERE pr.id = ${String(t.rule_id)} AND p.athlete_id = ${store.athleteId}
      `
      if (!rule?.open) return stale(`the ${String(t.name)} rule`)
    }
    const retireGoals = [...arr(d.goals_added), ...arr(d.screen_goals_added), ...arr(d.goals_unretired)].map(String).filter((id) => UUID_RE.test(id))
    const retireTracks = tracks.filter((t) => t.created === true).map((t) => String(t.track_id))
    return {
      targetType: 'composed_block',
      targetId: blockId,
      diff: {
        block_id: blockId, start: d.start ?? null, end: d.end ?? null, priorities: d.priorities ?? [], undone: true,
        reinstated_from: d.superseded ?? null,
        activities_inactive: arr(d.activities_added), goals_retired: retireGoals, tracks_retired: retireTracks,
        rules_ended: tracks.map((t) => String(t.rule_id)), rules_reopened: Object.keys(ends),
      },
      apply: async (c) => {
        const tomb = (table: TombTable, rowId: string) => writeTombstone(store, { table, rowId, kind: 'retire', changeId: c.changeId, voidsChangeId: ctx.row.id })
        for (const id of arr(d.activities_added).map(String)) {
          await store.sql`
            UPDATE activity SET active = false, change_id = ${c.changeId}, updated_at = NOW()
            WHERE id = ${id} AND athlete_id = ${store.athleteId} AND active
          `
        }
        for (const id of retireGoals) await tomb('athlete_goal', id)
        for (const g of arr(d.goals_weighted).map(obj)) {
          const b = obj(g.before)
          await store.sql`
            UPDATE athlete_goal SET weight = ${(b.weight ?? null) as string | null}, quality = ${(b.quality ?? null) as string | null}, updated_at = NOW()
            WHERE id = ${String(g.goal_id)} AND athlete_id = ${store.athleteId}
          `
        }
        for (const id of arr(d.goals_tracked).map(obj)) {
          await store.sql`
            UPDATE athlete_goal SET track_id = NULL
            WHERE id = ${String(id.goal_id)} AND athlete_id = ${store.athleteId} AND track_id = ${String(id.track_id)}
          `
        }
        const start = String(d.start ?? '')
        for (const t of tracks) {
          // Ends from today (or never ran, for a block that hasn't started): history stays.
          await store.sql`
            UPDATE progression_rule SET active_to = GREATEST(${start}::date, CURRENT_DATE) - 1
            WHERE id = ${String(t.rule_id)} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
          `
          if (t.created === true) await tomb('track', String(t.track_id))
          else if (t.unretired === true) {
            const lifted = await store.sql<{ id: string }[]>`
              SELECT id::text AS id FROM change_tombstone
              WHERE athlete_id = ${store.athleteId} AND row_table = 'track' AND row_id = ${String(t.track_id)} AND lifted_by = ${ctx.row.id}
            `
            if (lifted.length) await tomb('track', String(t.track_id))
          } else {
            await store.sql`
              UPDATE track SET purpose = ${(t.purpose_before ?? null) as string | null}
              WHERE id = ${String(t.track_id)} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
            `
          }
        }
        for (const [ruleId, was] of Object.entries(ends)) {
          await store.sql`
            UPDATE progression_rule SET active_to = ${(was ?? null) as string | null}::date
            WHERE id = ${ruleId} AND program_id IN (SELECT id FROM program WHERE athlete_id = ${store.athleteId})
          `
        }
        if (typeof d.program_id === 'string') {
          const b = obj(meta.before)
          await store.sql`
            UPDATE program SET
              name = ${(b.name ?? null) as string | null}, block_phase = ${(b.block_phase ?? null) as string | null},
              start_date = ${(b.start_date ?? null) as string | null}::date, end_date = ${(b.end_date ?? null) as string | null}::date,
              deload_week_start = ${(b.deload_week_start ?? null) as string | null}::date,
              retest_start = ${(b.retest_start ?? null) as string | null}::date, retest_end = ${(b.retest_end ?? null) as string | null}::date
            WHERE id = ${d.program_id} AND athlete_id = ${store.athleteId}
          `
        }
        const off = await store.sql<{ id: string }[]>`
          UPDATE composed_block SET superseded_at = NOW(), superseded_by = NULL
          WHERE id = ${blockId} AND athlete_id = ${store.athleteId} AND superseded_at IS NULL
          RETURNING id::text AS id
        `
        if (!off.length) throw staleRefusal('the block')
        // The block before it is the block of record again: a copy, since a superseded row never changes back.
        if (typeof d.superseded === 'string') {
          const copy = crypto.randomUUID()
          const done = await store.sql<{ id: string }[]>`
            INSERT INTO composed_block (
              id, athlete_id, program_id, start_date, end_date, methodology_version, modules_version, compose_key, block, request,
              intake_id, preview_id, approval_ref, change_id, actor_type, actor_id
            )
            SELECT ${copy}, athlete_id, program_id, start_date, end_date, methodology_version, modules_version, compose_key, block, request,
                   intake_id, ${`revert:${c.changeId}`}, ${c.approvalRef}, ${c.changeId}, 'athlete', ${store.athleteId}
            FROM composed_block WHERE id = ${d.superseded} AND athlete_id = ${store.athleteId}
            RETURNING id::text AS id
          `
          return done.length ? { reinstated_block_id: copy } : undefined
        }
      },
    }
  },
}

// ---- the registry -------------------------------------------------------------------------

const NEVER_ACCESS = 'access is never given back by an undo. Invite the coach again instead (a new connection the athlete approves).'

/**
 * One handler per change_log type. reverts.check.ts fails if the code writes a
 * type that isn't here. revert_change dispatches to the type it reverted.
 */
export const REVERT_HANDLERS: Record<string, Handler> = {
  apply_program_edits: ROUTINES,
  accept_proposal: ROUTINES,
  assign_exercise_to_track: ROUTINES,
  app_editor: ROUTINES,
  apply_session_override: OVERRIDES,
  clear_session_override: OVERRIDES,
  create_track: CREATE_TRACK,
  update_track: UPDATE_TRACK,
  set_track_progression_rule: PROGRESSION_RULE,
  upsert_autoreg_rule: AUTOREG,
  upsert_goal: GOAL,
  log_goal_measurement: MEASUREMENT,
  add_workout_note: NOTE,
  update_athlete_target: ATHLETE_TARGET,
  update_program_meta: PROGRAM_META,
  set_training_max: TRAINING_MAX,
  apply_methodology_override: METHODOLOGY_OVERRIDE,
  clear_red_flag: CLEAR_RED_FLAG,
  clear_region: CLEAR_REGION,
  log_checkin: CHECKIN,
  log_session_rpe: SESSION_RPE,
  set_coach_health_access: coachAccessHandler('share_health', 'health-data access'),
  set_coach_role: coachAccessHandler('role', 'role'),
  set_birth_date: BIRTH_DATE,
  apply_activity_change: ACTIVITY,
  apply_composed_block: COMPOSED_BLOCK,
  revoke_coach: {
    defined: `Not reverted: ${NEVER_ACCESS}`,
    blocked: () => NEVER_ACCESS,
    keys: (_d, row) => [`mcp_token:${String(row.target_id ?? '')}`],
  },
  void_preview: {
    defined: 'Not reverted: a preview voided because its coach lost access stays void. The coach previews again.',
    blocked: () => 'a preview voided because its coach lost access stays void. The coach can preview again.',
    keys: (_d, row) => [`preview:${String(row.target_id ?? '')}`],
  },
  revert_change: {
    defined: 'Reverting a revert re-applies what it took back, through the reverted type\'s own handler and guards (redo).',
    keys: () => [],
  },
}

/** Every change_log type with a revert handler. */
export const REVERTIBLE_TYPES = Object.keys(REVERT_HANDLERS).sort()

/** The type a row's revert runs through, and which way. A revert row's revert is a redo (or an undo of a redo). */
export function revertTarget(row: { tool: string; diff: unknown }): { tool: string; dir: Direction } {
  if (row.tool !== 'revert_change') return { tool: row.tool, dir: 'undo' }
  const d = obj(row.diff)
  return { tool: String(d.undid_tool ?? ''), dir: d.direction === 'redo' ? 'undo' : 'redo' }
}

/** For the feed: undo / redo when this row can be reverted (state is checked again at preview), else why not. */
export function revertInfo(row: { tool: string; diff: unknown; reverted_by: string | null }): { action: Direction | null; reason: string | null } {
  if (row.reverted_by) return { action: null, reason: 'Already undone.' }
  const { tool, dir } = revertTarget(row)
  const h = REVERT_HANDLERS[tool]
  if (!h || tool === 'revert_change') return { action: null, reason: 'This kind of change can\'t be undone yet.' }
  const why = h.blocked?.(obj(row.diff), dir) ?? (h.plan ? null : h.defined)
  return why ? { action: null, reason: why.replace(/^\w/, (c) => c.toUpperCase()) } : { action: dir, reason: null }
}

/** Kept for callers of the G2 name: why a row can't be undone, or null. */
export function notRevertibleReason(tool: string, diff: unknown): string | null {
  return revertInfo({ tool, diff, reverted_by: null }).reason
}

function keysOf(row: Pick<ChangeRef, 'id' | 'tool' | 'diff' | 'target_type' | 'target_id'>): string[] {
  const { tool } = revertTarget(row)
  return REVERT_HANDLERS[tool]?.keys(obj(row.diff), row) ?? []
}

// ---- reading rows -------------------------------------------------------------------------

interface ChangeRowDb extends Omit<ChangeRef, 'diff'> {
  diff: unknown
  token_name?: string | null
}

const toRef = (r: ChangeRowDb): ChangeRef => ({ ...r, diff: obj(asJson<unknown>(r.diff, {})) })

async function loadChange(store: ConnectedStore, changeId: string, lock: boolean): Promise<ChangeRef | null> {
  if (!UUID_RE.test(changeId)) return null
  const rows = lock
    ? await store.sql<ChangeRowDb[]>`
        SELECT id::text AS id, to_json(created_at) #>> '{}' AS created_at, actor_type, actor_id, tool, target_type, target_id, diff,
               reverted_by::text AS reverted_by, revert_of::text AS revert_of
        FROM change_log WHERE id = ${changeId} AND athlete_id = ${store.athleteId}
        FOR UPDATE
      `
    : await store.sql<ChangeRowDb[]>`
        SELECT id::text AS id, to_json(created_at) #>> '{}' AS created_at, actor_type, actor_id, tool, target_type, target_id, diff,
               reverted_by::text AS reverted_by, revert_of::text AS revert_of
        FROM change_log WHERE id = ${changeId} AND athlete_id = ${store.athleteId}
      `
  return rows[0] ? toRef(rows[0]) : null
}

function precheck(row: ChangeRef | null): Fail | null {
  if (!row) return { ok: false, reason: 'not_found', text: 'No such change.' }
  if (row.reverted_by) return { ok: false, reason: 'refused', text: 'Already undone.' }
  return null
}

/** What a row's revert says it reverted: the original change, through any undo / redo. */
function originalSummary(row: ChangeRef): string {
  if (row.tool === 'revert_change' && str(row.diff.undid)) return String(row.diff.undid)
  return summarizeChange({ tool: row.tool, target_type: row.target_type, diff: row.diff })
}

const HEALTH_TARGETS = new Set(['checkin', 'region', 'session_rpe'])
const isHealthRow = (r: Pick<ChangeRef, 'target_type' | 'target_id'>) =>
  HEALTH_TARGETS.has(r.target_type) || (r.target_type === 'methodology' && /^U7\.regions\./.test(r.target_id ?? ''))

/**
 * Later changes, not since undone, that touched what this row touched. A later
 * change undone after this row (its undo the newest in its chain) nets out and
 * isn't one.
 */
async function laterConflicts(store: ConnectedStore, row: ChangeRef, health: boolean): Promise<ConflictView[]> {
  const mine = new Set(keysOf(row))
  if (!mine.size) return []
  const later = (await store.sql<ChangeRowDb[]>`
    SELECT c.id::text AS id, to_json(c.created_at) #>> '{}' AS created_at, c.actor_type, c.actor_id, t.name AS token_name,
           c.tool, c.target_type, c.target_id, c.diff, c.reverted_by::text AS reverted_by, c.revert_of::text AS revert_of
    FROM change_log c
    LEFT JOIN mcp_token t ON c.actor_type = 'mcp' AND t.athlete_id = c.athlete_id AND t.id::text = c.actor_id
    WHERE c.athlete_id = ${store.athleteId} AND c.id <> ${row.id}
      AND (c.created_at, c.id) > (${row.created_at}::timestamptz, ${row.id}::uuid)
    ORDER BY c.created_at, c.id
    LIMIT 5000
  `).map((r) => ({ ref: toRef(r), token: r.token_name ?? null }))
  const laterIds = new Set(later.map((l) => l.ref.id))
  const out: ConflictView[] = []
  for (const { ref, token } of later) {
    if (ref.reverted_by) continue
    if (ref.tool === 'revert_change' && revertTarget(ref).dir === 'redo' && ref.revert_of && laterIds.has(ref.revert_of)) continue
    if (!keysOf(ref).some((k) => mine.has(k))) continue
    const hidden = !health && isHealthRow(ref)
    out.push({
      id: ref.id,
      at: ref.created_at,
      who: actorLabel(ref.actor_type, token),
      tool: ref.tool,
      summary: hidden ? 'A health check-in (not shared with you)' : summarizeChange({ tool: ref.tool, target_type: ref.target_type, diff: ref.diff }),
    })
  }
  return out
}

interface Planned {
  plan: RevertPlan
  tool: string
  dir: Direction
  summary: string
}

async function planFor(store: ConnectedStore, row: ChangeRef, health: boolean): Promise<Planned | Fail> {
  const { tool, dir } = revertTarget(row)
  const h = REVERT_HANDLERS[tool]
  if (!h || tool === 'revert_change') return notRevertible('this kind of change can\'t be undone yet.')
  const why = h.blocked?.(row.diff, dir) ?? (h.plan ? null : h.defined)
  if (why || !h.plan) return notRevertible(why ?? h.defined)
  const conflicts = await laterConflicts(store, row, health)
  if (conflicts.length) {
    return {
      ok: false,
      reason: 'stale',
      text: `Can't ${dir}: what it changed changed since, in a newer change (${conflicts.map((c) => `${c.who}: ${c.summary}`).join('; ')}). Undo that first, then preview again.`,
      conflicts,
    }
  }
  const plan = await h.plan(store, row.diff, { tool, dir, row })
  if ('ok' in plan) return dir === 'redo' ? { ...plan, text: plan.text.replace(/^Can't undo/, 'Can\'t redo') } : plan
  return { plan, tool, dir, summary: originalSummary(row) }
}

const previewState = (row: ChangeRef, p: Planned) => ({ change_id: row.id, direction: p.dir, inverse: p.plan.diff })

// ---- previews -----------------------------------------------------------------------------

export type RevertPreview =
  | { ok: true; preview_id: string; direction: Direction; summary: string; restores: Obj; text: string }
  | Fail

/**
 * What reverting a row would do, kept as a revert_change preview. A coach's
 * shows in the athlete's feed as suggested; the athlete's own is what their
 * tap applies. Writes no change.
 */
export async function previewRevertFor(store: ConnectedStore, actor: ChangeActor, changeId: string, rationale: string | null): Promise<RevertPreview> {
  const health = await seesHealth(store, actor)
  const row = await loadChange(store, changeId, false)
  // Before anything about its state: even "already undone" would say something about a health row.
  if (row && !health && isHealthRow(row)) {
    return { ok: false, reason: 'refused', text: 'That change is health data the athlete hasn\'t shared with you. Ask the athlete.' }
  }
  const pre = precheck(row)
  if (pre) return pre
  const planned = await planFor(store, row!, health)
  if ('ok' in planned) return planned
  const previewId = await storeChangePreview(store, actor, 'revert_change', previewState(row!, planned), { rationale, targetId: row!.id })
  const verb = planned.dir === 'undo' ? 'Undo' : 'Redo'
  return {
    ok: true,
    preview_id: previewId,
    direction: planned.dir,
    summary: planned.summary,
    restores: planned.plan.diff,
    text: `${verb}: ${planned.summary}`,
  }
}

/** preview_revert_change, for a coach: the preview as text. There is no coach-side apply. */
export async function previewRevert(store: ConnectedStore, actor: ChangeActor, changeId: string, rationale: string | null): Promise<string> {
  const p = await previewRevertFor(store, actor, changeId, rationale)
  if (!p.ok) return p.text
  return [
    `# Preview: ${p.direction === 'undo' ? 'undo' : 'redo'} a change`,
    p.text,
    '',
    `## What ${p.direction === 'undo' ? 'undoing' : 'redoing'} restores`,
    JSON.stringify(p.restores, null, 2),
    '',
    `preview_id: ${p.preview_id}`,
    `Nothing was written. Only the athlete can ${p.direction}: it now shows as suggested on this change in their Changes feed (Program → Changes), and their tap is the approval. There is no coach-side apply.`,
  ].join('\n')
}

async function checkPreview(store: ConnectedStore, previewId: string, row: ChangeRef, state: unknown): Promise<Fail | null> {
  const again = 'Preview again: what this revert would do changed since you previewed it.'
  const [p] = await store.sql<{ id: string; diff: unknown; used: boolean; voided: boolean; fresh: boolean }[]>`
    SELECT id::text AS id, diff, used_at IS NOT NULL AS used, voided_at IS NOT NULL AS voided,
           (created_at > NOW() - make_interval(hours => ${PREVIEW_TTL_HOURS}::int)) AS fresh
    FROM change_preview
    WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId} AND tool = 'revert_change' AND target_id = ${row.id}
    LIMIT 1
  `
  if (!p) return { ok: false, reason: 'refused', text: 'No such preview of this revert. Preview again.' }
  if (p.used || p.voided) return { ok: false, reason: 'refused', text: 'That preview was already used. Preview again.' }
  if (!p.fresh) return { ok: false, reason: 'stale', text: `That preview is more than ${PREVIEW_TTL_HOURS} h old. Preview again.` }
  if (canonicalJson(asJson(p.diff, {})) !== canonicalJson(state)) return { ok: false, reason: 'stale', text: again }
  return null
}

// ---- applying -----------------------------------------------------------------------------

/**
 * The athlete's revert. Writes a new change_log row (revert_of = the reverted
 * row), sets reverted_by on it, and restores the target — all in one
 * transaction, or nothing. Only the athlete's own session may call it; a coach
 * previews (previewRevert) and the athlete taps. With previewId, the plan must
 * still be exactly what that preview showed.
 */
export async function revertChange(
  store: ConnectedStore,
  actor: ChangeActor,
  changeId: string,
  opts: { previewId?: string | null } = {},
): Promise<RevertResult> {
  if (actor.type !== 'athlete' || actor.id !== store.athleteId) {
    return { ok: false, reason: 'refused', text: 'Refused: only the athlete can undo a change. A coach can suggest it with preview_revert_change.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, reason: 'off', text: 'The change log is off for this athlete.' }
  try {
    return await withTx(store.sql, async () => {
      const row = await loadChange(store, changeId, true)
      const pre = precheck(row)
      if (pre) throw new Refusal<RevertResult>(pre)
      const planned = await planFor(store, row!, true)
      if ('ok' in planned) throw new Refusal<RevertResult>(planned)
      const state = previewState(row!, planned)
      const previewId = typeof opts.previewId === 'string' && opts.previewId.trim() ? opts.previewId.trim() : null
      if (previewId) {
        const bad = await checkPreview(store, previewId, row!, state)
        if (bad) throw new Refusal<RevertResult>(bad)
      }
      const { plan, tool, dir, summary } = planned
      const newId = crypto.randomUUID()
      // The athlete's tap is the approval (G10): a real approval row, consumed by this revert's change_log row.
      const tap = await directTapApproval(store, 'revert', `revert:${row!.id}`, plan.diff)
      const extra = await plan.apply({ approvalRef: tap.ref, approvalId: tap.id, changeId: newId, direction: dir })
      await writeChange(store, {
        id: newId,
        actor,
        tool: 'revert_change',
        targetType: plan.targetType,
        targetId: plan.targetId,
        diff: { ...plan.diff, ...(extra ?? {}), undid: summary, undid_tool: tool, direction: dir },
        rationale: dir === 'undo' ? 'Undone by the athlete.' : 'Redone by the athlete.',
        ruleRefs: [],
        approvalRef: tap.ref,
        approvalId: tap.id,
        previewId,
        revertOf: row!.id,
      })
      if (!(await consumeApproval(store, tap.id, newId))) throw new ApprovalSpent()
      const claimed = await store.sql<{ id: string }[]>`
        UPDATE change_log SET reverted_by = ${newId}
        WHERE id = ${row!.id} AND athlete_id = ${store.athleteId} AND reverted_by IS NULL
        RETURNING id
      `
      if (!claimed.length) throw new Refusal<RevertResult>({ ok: false, reason: 'refused', text: 'Already undone.' })
      // Every preview of reverting this row (a coach's suggestion, the athlete's own) is spent.
      await store.sql`
        UPDATE change_preview SET used_at = NOW()
        WHERE athlete_id = ${store.athleteId} AND tool = 'revert_change' AND target_id = ${row!.id}
          AND used_at IS NULL AND voided_at IS NULL
      `
      const done = dir === 'undo' ? 'Undone' : 'Redone'
      await store.sql`
        INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
        VALUES (${store.athleteId}, 'coach', 'note', ${`You ${dir === 'undo' ? 'undid' : 'redid'}: ${summary}`}, ${null})
      `
      return { ok: true as const, change_id: newId, summary, direction: dir, text: `${done}: ${summary}` }
    })
  } catch (e) {
    if (e instanceof Refusal) return e.result as RevertResult
    if (e instanceof ApprovalSpent) return { ok: false, reason: 'refused', text: e.message }
    if (changeLogMissing(e)) return { ok: false, reason: 'unavailable', text: changeLogUnavailable }
    throw e
  }
}
