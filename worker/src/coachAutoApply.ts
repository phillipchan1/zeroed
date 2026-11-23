/**
 * Coach auto-apply for program-edit proposals (MCP apply_program_edits).
 *
 * Default OFF. When the athlete turns athlete.coach_auto_apply on, a coach
 * may apply a pending, unexpired program-edit proposal with proposal_id +
 * confirm=true and no approval_ref. Session overrides and every other write
 * tool still need an approval_ref. Missing column / table reads as off.
 *
 * Auto-apply records the prior program version and an in-app notice with a
 * plain-language diff and one-tap Undo. Undo is athlete-only, restores that
 * version exactly, and is idempotent.
 */
import { asJson, jsonParam, pgArrayLiteral } from './db.ts'
import { canonicalJson } from './sessionOverride.ts'
import { phaseRoutineSnapshots, withTx, type RoutineSnap } from './changeLog.ts'
import type { ConnectedStore } from './store.ts'

export const PROPOSAL_TTL_DAYS = 7
export const AUTO_APPLY_APPROVAL_REF = 'standing:coach_auto_apply'

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

function missingRelation(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01'
}

function missingColumn(e: unknown): boolean {
  return (e as { code?: string })?.code === '42703'
}

/** True only when the athlete's row has coach_auto_apply = true. Missing column is off. */
export async function coachAutoApplyOn(store: ConnectedStore): Promise<boolean> {
  try {
    const [row] = await store.sql<{ on: boolean | null }[]>`
      SELECT (to_jsonb(a) ->> 'coach_auto_apply') = 'true' AS on
      FROM athlete a WHERE id = ${store.athleteId} LIMIT 1
    `
    return row?.on === true
  } catch (e) {
    if (missingRelation(e) || missingColumn(e)) return false
    throw e
  }
}

export function proposalExpiredAt(createdAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(createdAt)
  if (!Number.isFinite(t)) return true
  return nowMs - t >= PROPOSAL_TTL_DAYS * 86_400_000
}

export interface ProgramVersion {
  program_id: string
  phase_id: string
  sessions_per_week: number
  week_end: string | null
  routines: RoutineSnap[]
}

export async function captureProgramVersion(
  store: ConnectedStore,
  live: { programId: string; phaseId: string; sessionsPerWeek: number; weekEnd: string },
): Promise<ProgramVersion> {
  return {
    program_id: live.programId,
    phase_id: live.phaseId,
    sessions_per_week: live.sessionsPerWeek,
    week_end: live.weekEnd,
    routines: await phaseRoutineSnapshots(store, live.phaseId),
  }
}

export async function currentProgramVersion(
  store: ConnectedStore,
  live: { programId: string; phaseId: string; sessionsPerWeek: number; weekEnd: string },
): Promise<ProgramVersion> {
  const [athlete] = await store.sql<{ n: number | null }[]>`
    SELECT sessions_per_week AS n FROM athlete WHERE id = ${store.athleteId}
  `
  return captureProgramVersion(store, {
    ...live,
    sessionsPerWeek: Number(athlete?.n ?? live.sessionsPerWeek),
  })
}

export function programVersionsEqual(a: ProgramVersion, b: ProgramVersion): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

interface RevisionChange {
  kind: string
  name: string
  before?: string
  after?: string
}

/** Plain-language one-liner for the athlete notice, e.g. "Moved Thursday squat to Friday; A day deadlift 5×5 → 4×5". */
export function plainLanguageDiff(
  before: RoutineSnap[],
  after: RoutineSnap[],
  revision?: { sessions?: Array<{ name: string; changes: RevisionChange[] }> } | null,
): string {
  const bits: string[] = []
  const beforeById = new Map(before.map((r) => [r.id, r]))
  for (const a of after) {
    const b = beforeById.get(a.id)
    if (b && b.intended_dow != null && a.intended_dow != null && b.intended_dow !== a.intended_dow) {
      const from = DOW[b.intended_dow] ?? `day ${b.intended_dow}`
      const to = DOW[a.intended_dow] ?? `day ${a.intended_dow}`
      bits.push(`Moved ${from} ${a.name} to ${to}`)
    }
  }
  for (const s of revision?.sessions ?? []) {
    for (const c of s.changes ?? []) {
      if (c.kind === 'kept') continue
      if (c.kind === 'changed' && c.before && c.after) bits.push(`${s.name} ${c.name} ${c.before} → ${c.after}`)
      else if (c.kind === 'added') bits.push(`Added ${c.name} to ${s.name}`)
      else if (c.kind === 'removed') bits.push(`Removed ${c.name} from ${s.name}`)
    }
  }
  return bits.join('; ') || 'Your coach updated this week’s plan.'
}

export interface AutoApplyNoticeRow {
  id: string
  proposal_id: string | null
  change_id: string | null
  diff_text: string
  created_at: string
  undone_at: string | null
}

export async function recordAutoApplyNotice(
  store: ConnectedStore,
  opts: {
    proposalId: string
    changeId: string | null
    diffText: string
    prior: ProgramVersion
  },
): Promise<string | null> {
  try {
    const [row] = await store.sql<{ id: string }[]>`
      INSERT INTO coach_auto_apply_notice (
        athlete_id, proposal_id, change_id, diff_text, prior_version
      ) VALUES (
        ${store.athleteId}, ${opts.proposalId}, ${opts.changeId}, ${opts.diffText},
        ${jsonParam(store.sql, opts.prior)}
      )
      RETURNING id
    `
    return row?.id ?? null
  } catch (e) {
    if (missingRelation(e)) return null
    throw e
  }
}

export async function listAutoApplyNotices(store: ConnectedStore): Promise<AutoApplyNoticeRow[] | null> {
  try {
    return await store.sql<AutoApplyNoticeRow[]>`
      SELECT id, proposal_id::text AS proposal_id, change_id::text AS change_id, diff_text,
             to_json(created_at) #>> '{}' AS created_at, to_json(undone_at) #>> '{}' AS undone_at
      FROM coach_auto_apply_notice
      WHERE athlete_id = ${store.athleteId} AND undone_at IS NULL
      ORDER BY created_at DESC
      LIMIT 20
    `
  } catch (e) {
    if (missingRelation(e)) return null
    throw e
  }
}

export type UndoAutoApplyResult =
  | { ok: true; text: string; already?: true }
  | { ok: false; status: 'not_found' | 'unavailable' | 'refused'; text: string }

async function restoreProgramVersion(store: ConnectedStore, prior: ProgramVersion): Promise<void> {
  const ids = prior.routines.map((r) => r.id).filter(Boolean)
  for (const r of prior.routines) {
    const done = await store.sql<{ id: string }[]>`
      UPDATE routine rt
      SET name = ${r.name},
          session_type = ${r.session_type},
          exercises = ${jsonParam(store.sql, r.exercises)},
          intent = ${r.intent},
          intended_dow = ${r.intended_dow},
          phase_id = ${prior.phase_id}
      FROM program p
      WHERE rt.id = ${r.id} AND rt.program_id = p.id AND p.athlete_id = ${store.athleteId}
        AND p.id = ${prior.program_id}
      RETURNING rt.id
    `
    if (!done.length) {
      throw new Error(`undo: could not restore ${r.name}`)
    }
  }
  if (ids.length) {
    await store.sql`
      UPDATE routine rt SET phase_id = NULL
      FROM program p
      WHERE rt.program_id = p.id AND p.athlete_id = ${store.athleteId}
        AND rt.phase_id = ${prior.phase_id}
        AND NOT (rt.id::text = ANY(${pgArrayLiteral(ids)}::text[]))
    `
  }
  await store.sql`
    UPDATE athlete SET sessions_per_week = ${prior.sessions_per_week}
    WHERE id = ${store.athleteId}
  `
  if (prior.week_end) {
    await store.sql`
      UPDATE phase ph SET week_end = ${prior.week_end}::date
      FROM program p
      WHERE ph.id = ${prior.phase_id} AND ph.program_id = p.id AND p.athlete_id = ${store.athleteId}
        AND p.id = ${prior.program_id}
    `
  }
}

/**
 * Athlete-only undo of one auto-apply notice. Restores the recorded prior
 * program version (deep-equal). A second tap is a no-op success.
 */
export async function undoAutoApplyNotice(store: ConnectedStore, noticeId: string): Promise<UndoAutoApplyResult> {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(noticeId)) return { ok: false, status: 'not_found', text: 'No such notice.' }
  try {
    return await withTx(store.sql, async () => {
      const [row] = await store.sql<{
        id: string
        undone_at: string | null
        prior_version: unknown
        program_id: string | null
        phase_id: string | null
      }[]>`
        SELECT n.id, to_json(n.undone_at) #>> '{}' AS undone_at, n.prior_version,
               n.prior_version ->> 'program_id' AS program_id,
               n.prior_version ->> 'phase_id' AS phase_id
        FROM coach_auto_apply_notice n
        WHERE n.id = ${noticeId} AND n.athlete_id = ${store.athleteId}
        LIMIT 1
      `
      if (!row) return { ok: false, status: 'not_found' as const, text: 'No such notice.' }
      if (row.undone_at) return { ok: true, text: 'Already undone. Nothing changed.', already: true as const }
      const prior = asJson<ProgramVersion>(row.prior_version, {
        program_id: '',
        phase_id: '',
        sessions_per_week: 0,
        week_end: null,
        routines: [],
      })
      if (!prior.program_id || !prior.phase_id) {
        return { ok: false, status: 'refused' as const, text: 'That notice has no program version to restore.' }
      }
      const [spw] = await store.sql<{ n: number | null; week_end: string | null }[]>`
        SELECT a.sessions_per_week AS n, ph.week_end::text AS week_end
        FROM athlete a
        LEFT JOIN phase ph ON ph.id = ${prior.phase_id}
        LEFT JOIN program p ON p.id = ph.program_id AND p.athlete_id = a.id
        WHERE a.id = ${store.athleteId}
      `
      const current: ProgramVersion = {
        program_id: prior.program_id,
        phase_id: prior.phase_id,
        sessions_per_week: Number(spw?.n ?? prior.sessions_per_week),
        week_end: spw?.week_end ?? prior.week_end,
        routines: await phaseRoutineSnapshots(store, prior.phase_id),
      }
      if (!programVersionsEqual(current, prior)) {
        await restoreProgramVersion(store, prior)
        const restored: ProgramVersion = {
          program_id: prior.program_id,
          phase_id: prior.phase_id,
          sessions_per_week: Number(
            (await store.sql<{ n: number | null }[]>`SELECT sessions_per_week AS n FROM athlete WHERE id = ${store.athleteId}`)[0]?.n
            ?? prior.sessions_per_week,
          ),
          week_end: (
            await store.sql<{ week_end: string | null }[]>`
              SELECT ph.week_end::text AS week_end FROM phase ph
              JOIN program p ON p.id = ph.program_id
              WHERE ph.id = ${prior.phase_id} AND p.athlete_id = ${store.athleteId}
            `
          )[0]?.week_end ?? prior.week_end,
          routines: await phaseRoutineSnapshots(store, prior.phase_id),
        }
        if (!programVersionsEqual(restored, prior)) {
          throw new Error('undo: restored program is not deep-equal to the prior version')
        }
      }
      await store.sql`
        UPDATE coach_auto_apply_notice SET undone_at = NOW()
        WHERE id = ${noticeId} AND athlete_id = ${store.athleteId} AND undone_at IS NULL
      `
      return { ok: true, text: 'Undone. Your previous plan is back.' }
    })
  } catch (e) {
    if (missingRelation(e)) return { ok: false, status: 'unavailable', text: 'Undo for this change is not set up on this database yet. Nothing changed.' }
    throw e
  }
}
