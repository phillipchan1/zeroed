/**
 * Sport / conditioning logs (log_session_v1, spec section 13): a game of
 * basketball, a run, a class — what it was, the athlete's calendar date, how
 * long, how hard the whole session was (session RPE), pain by region, a note.
 *
 *   model     One log is one workout row of kind 'sport_conditioning' (two
 *             games on a day are two rows). Session RPE goes in
 *             workout.session_rpe and minutes in duration_mins — never
 *             workout.rpe (the set-RPE mean) and never a session_rpe table
 *             row, so two same-day logs can't collide on its (athlete, date,
 *             session) key. Session load = session RPE × minutes (AU).
 *   planned   Logged against a planned card (session_id / session_name, or
 *             the app's "Log this session"), the first log that day against
 *             that card files under its routine and closes it (week ring, U15
 *             compliance). A second the same day, or any log without a card,
 *             goes on the athlete's one external program, like arc_load_v1's
 *             "Log outside the plan", and fills no planned slot.
 *   pain      Each entry is a pain_report for that date and region, through
 *             the check-in's U7 path (readiness.ts applyPainReports): the same
 *             caps, blocks, temporary blocks and refer-out. The report names
 *             its log; an edit writes fresh reports and supersedes the old
 *             ones, a delete voids them with the log, so U7 re-reads.
 *   delete    The workout table is never DELETEd from: a deleted log is voided
 *             (voided_at) and every reader skips it, so a card it closed
 *             re-opens unless another log is linked to it.
 *   logging   Standing approval (D1: logging only). One change_log row per
 *             log, edit or delete, approval_ref standing:logging.
 *   who       The athlete, always (the app's route). Over MCP: a propose
 *             coach and app_coach (propose-equivalent, never an approval_ref,
 *             D4); a read coach never sees or reaches these tools
 *             (coachRoles.ts, refusal logged). Session RPE and pain are health
 *             data (section 11): a coach without the health toggle can log
 *             activity, date and minutes, and can't read or write either.
 *
 * Its own flag in athlete.flags, default off, independent of coach_v1,
 * arc_load_v1 and tracks_v1. Off: the tools aren't listed and calls are
 * unknown, the route answers 404, and every reader reads as before.
 * Rollback: UPDATE athlete SET flags = flags - 'log_session_v1';
 *
 * Route, the athlete's own session, 404 with the flag off:
 *   POST /api/sport-session   { action: 'log' | 'update' | 'delete' | 'list' }
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { mcpStamp, writePreview } from '../../src/engine/mcpStamp.ts'
import {
  loggableWeekStart, parseSportLog, sessionLoadAu, sportSnapshot, SPORT_KIND, SPORT_PAIN_REGIONS, SPORT_RED_FLAGS,
  type SportLogFields, type SportPain,
} from '../../src/engine/sportLog.ts'
import { beginAuthCors, json } from './cors.ts'
import { jsonParam, withSql, type WaitUntil, asJson } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { STANDING_LOGGING, withTx, writeChange } from './changeLog.ts'
import { resolveMethodology } from './methodology.ts'
import { applyPainReports, type PainOutcome } from './readiness.ts'
import { REFER_OUT, REFER_OUT_TEMPORARY, addDays } from './readiness/rules.ts'
import { readinessTables, seesHealth } from './regionStatus.ts'
import type { OverrideActor } from './sessionOverride.ts'
import { calendarZone, makeStore, type ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'

export const LOG_SESSION_FLAG = 'log_session_v1'

export const sportSessionsUnavailable = 'Sport logging is not set up on this database yet (log-session-v1.sql). Nothing was written.'
export const SPORT_HEALTH_REFUSED = 'Refused: the athlete has not shared health data (pain, session effort) with you, so you can\'t log or change session RPE or pain. Log the activity, date and minutes without them. Nothing was written.'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OUTSIDE_PLAN = 'Outside the plan'
/** How far ahead of the server a device's clock may run. */
const CLOCK_SKEW_MS = 5 * 60 * 1000

export async function logSessionV1On(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ on: boolean | null }[]>`
    SELECT (flags->'log_session_v1') = 'true'::jsonb AS on FROM athlete WHERE id = ${store.athleteId}
  `
  return row?.on === true
}

/** True once log-session-v1.sql is on this database (the workout columns). Checked, not caught. */
export async function sportSchemaReady(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'workout'
              AND column_name IN ('kind', 'activity', 'voided_at', 'pain_change_id', 'logged_date')) = 5
       AND to_regclass('public.change_log') IS NOT NULL AS ok
  `
  return row?.ok === true
}

/** Pain on a log also needs the check-in tables and pain_report.workout_id. */
async function painReady(store: ConnectedStore): Promise<boolean> {
  if (!(await readinessTables(store))) return false
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pain_report' AND column_name = 'workout_id'
    ) AS ok
  `
  return row?.ok === true
}

async function zoneOf(store: ConnectedStore): Promise<string> {
  const [row] = await store.sql<{ time_zone: string | null }[]>`SELECT time_zone FROM athlete WHERE id = ${store.athleteId} LIMIT 1`
  return calendarZone(row?.time_zone)
}

/** Noon on `date` in `zone`, as an instant: a backdated log sits mid-day, so its date never slips. */
export function noonInZone(date: string, zone: string): string {
  const guess = new Date(`${date}T12:00:00Z`)
  const local = mcpStamp(guess, zone).local
  const drift = Date.parse(`${local.slice(0, 19)}Z`) - guess.getTime()
  return new Date(guess.getTime() - (Number.isFinite(drift) ? drift : 0)).toISOString()
}

// ---- reading logs ------------------------------------------------------------------------

export interface SportLogRow {
  workout_id: string
  client_key: string | null
  routine_id: string
  routine_name: string
  /** True when it closed a planned card (its routine is in a non-external program). */
  closed_planned: boolean
  activity: string
  date: string
  duration_min: number
  session_rpe: number | null
  session_load: number | null
  pain: SportPain[]
  notes: string | null
  voided: boolean
  change_id: string | null
}

interface RawLog {
  id: string; client_key: string | null; routine_id: string; routine_name: string; program_status: string
  activity: string | null; logged_date: string | null; duration_mins: unknown; session_rpe: unknown
  pain: unknown; notes: string | null; voided_at: string | null; change_id: string | null
}

function toRow(r: RawLog): SportLogRow {
  const rpe = r.session_rpe == null ? null : Number(r.session_rpe)
  const minutes = Number(r.duration_mins ?? 0)
  return {
    workout_id: r.id,
    client_key: r.client_key,
    routine_id: r.routine_id,
    routine_name: r.routine_name,
    closed_planned: r.program_status !== 'external',
    activity: r.activity ?? OUTSIDE_PLAN,
    date: r.logged_date ?? '',
    duration_min: minutes,
    session_rpe: rpe,
    session_load: sessionLoadAu(rpe, minutes),
    pain: asJson<SportPain[]>(r.pain, []),
    notes: r.notes,
    voided: r.voided_at != null,
    change_id: r.change_id,
  }
}

/** This athlete's sport logs: dated [from, to], or by id. Voided ones only when asked. Call after sportSchemaReady. */
export async function loadSportLogs(
  store: ConnectedStore,
  q: { from?: string; to?: string; ids?: string[]; includeVoided?: boolean },
): Promise<SportLogRow[]> {
  const ids = q.ids?.filter((x) => UUID_RE.test(x)) ?? null
  if (ids && !ids.length) return []
  const rows = await store.sql<RawLog[]>`
    SELECT w.id::text AS id, w.client_key, w.routine_id::text AS routine_id, r.name AS routine_name, p.status AS program_status,
           w.activity, w.logged_date::text AS logged_date, w.duration_mins, w.session_rpe, w.pain, w.notes,
           to_json(w.voided_at) #>> '{}' AS voided_at, w.change_id::text AS change_id
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId} AND w.kind = ${SPORT_KIND}
      AND (${q.from ?? null}::date IS NULL OR w.logged_date >= ${q.from ?? null}::date)
      AND (${q.to ?? null}::date IS NULL OR w.logged_date <= ${q.to ?? null}::date)
      AND (${ids ? `{${ids.join(',')}}` : null}::text[] IS NULL OR w.id::text = ANY(${ids ? `{${ids.join(',')}}` : null}::text[]))
      AND (${q.includeVoided === true}::boolean OR w.voided_at IS NULL)
    ORDER BY w.logged_date, w.performed_at, w.id
  `
  return rows.map(toRow)
}

/** The view a caller gets: health fields (session RPE, load, pain, notes) only when they may see them. */
export function sportView(row: SportLogRow, health: boolean): Record<string, unknown> {
  return {
    workout_id: row.workout_id,
    client_key: row.client_key,
    kind: SPORT_KIND,
    activity: row.activity,
    date: row.date,
    duration_min: row.duration_min,
    ...(health
      ? { session_rpe: row.session_rpe, session_load: row.session_load, pain: row.pain, notes: row.notes }
      // Notes often say how it felt ("knee was sore"): held back with the health fields.
      : { health: 'not shared with you' }),
    planned: row.closed_planned ? { session_id: row.routine_id, session: row.routine_name } : null,
    ...(row.voided ? { deleted: true } : {}),
  }
}

/** One line under list_workouts / get_workout for a sport log. */
export function sportLine(row: SportLogRow, health: boolean): string {
  const bits = [
    `${row.activity}`,
    `${row.duration_min} min`,
    health && row.session_rpe != null ? `session RPE ${row.session_rpe}` : null,
    health && row.session_load != null ? `load ${row.session_load} AU` : null,
    health ? (row.pain.length ? `pain ${row.pain.map((p) => `${p.region.replace(/_/g, ' ')} ${p.score}/10${p.red_flags.length ? ' (red flag)' : ''}`).join(', ')}` : 'no pain logged') : 'session RPE and pain not shared with you',
    row.closed_planned ? `closed planned "${row.routine_name}"` : 'off-plan (external)',
  ].filter(Boolean)
  return `- Sport / conditioning log (${SPORT_KIND}, ${row.date}): ${bits.join(' · ')}${health && row.notes ? `\n- Notes: ${row.notes}` : ''}`
}

// ---- volume ------------------------------------------------------------------------------------

/** Sport logs in [from, to] with a session RPE: what session_load adds (sessionRpe.ts). Empty with the flag off. */
export async function sportLoadRows(store: ConnectedStore, from: string, to: string): Promise<Array<{ workout_id: string; date: string; rating: number; duration_min: number; load: number }>> {
  if (!(await logSessionV1On(store)) || !(await sportSchemaReady(store))) return []
  return (await loadSportLogs(store, { from, to }))
    .filter((r) => r.session_rpe != null && r.session_load != null)
    .map((r) => ({ workout_id: r.workout_id, date: r.date, rating: r.session_rpe!, duration_min: r.duration_min, load: r.session_load! }))
}

// ---- writing --------------------------------------------------------------------------------------

type Refusal = { ok: false; text: string; retry?: boolean }
type Done = { ok: true; text: string; log: SportLogRow; extra: Record<string, unknown> }
export type SportResult = Refusal | Done | { ok: true; preview: Record<string, unknown> }

const refuse = (text: string, retry = false): Refusal => ({ ok: false, text: text.startsWith('Refused') || retry ? text : `Refused: ${text}`, ...(retry ? { retry } : {}) })

/** Who may write here. Null to go on. */
function writerProblem(store: ConnectedStore, actor: OverrideActor, args: Record<string, unknown>): string | null {
  if (actor.type === 'athlete' && actor.id !== store.athleteId) return 'Refused: only the athlete logs their own sessions.'
  if (actor.type === 'system') return 'Refused: system writes cannot log a session.'
  // D4: app_coach is propose-equivalent and never supplies an approval.
  if (actor.type === 'app_coach' && args.approval_ref != null && args.approval_ref !== '') {
    return 'Refused: app_coach cannot supply approval_ref. Logging has standing approval; nothing else is needed.'
  }
  return null
}

const hasArg = (args: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined && args[k] !== null

/** A planned card this log names: a session in the athlete's active program, by id or by name. */
async function resolvePlanned(store: ConnectedStore, args: Record<string, unknown>): Promise<{ id: string; name: string } | null | 'missing'> {
  const id = typeof args.session_id === 'string' ? args.session_id.trim() : ''
  const name = typeof args.session_name === 'string' ? args.session_name.trim() : ''
  if (!id && !name) return null
  if (id) {
    if (!UUID_RE.test(id)) return 'missing'
    const [r] = await store.sql<{ id: string; name: string }[]>`
      SELECT r.id::text AS id, r.name FROM routine r JOIN program p ON p.id = r.program_id
      WHERE r.id = ${id} AND p.athlete_id = ${store.athleteId} AND p.status = 'active' LIMIT 1
    `
    return r ?? 'missing'
  }
  const rows = await store.sql<{ id: string; name: string }[]>`
    SELECT r.id::text AS id, r.name FROM routine r
    JOIN program p ON p.id = r.program_id
    LEFT JOIN phase ph ON ph.id = r.phase_id
    WHERE p.athlete_id = ${store.athleteId} AND p.status = 'active' AND (ph.id IS NULL OR ph.status = 'active')
      AND r.name ILIKE ${'%' + name.replace(/[%_]/g, '') + '%'}
    ORDER BY (lower(r.name) = ${name.toLowerCase()}) DESC, length(r.name), r.name
    LIMIT 1
  `
  return rows[0] ?? 'missing'
}

/** Another standing log of this routine on this local date (the card is already closed that day). */
async function routineTakenOn(store: ConnectedStore, routineId: string, date: string, zone: string, except: string | null): Promise<boolean> {
  const rows = await store.sql<{ id: string; performed_at: string; logged_date: string | null }[]>`
    SELECT w.id::text AS id, to_json(w.performed_at) #>> '{}' AS performed_at, w.logged_date::text AS logged_date
    FROM workout w
    WHERE w.routine_id = ${routineId} AND w.voided_at IS NULL
      AND w.performed_at >= (${date}::date - 1) AND w.performed_at < (${date}::date + 2)
  `
  return rows.some((r) => r.id !== except && (r.logged_date ?? mcpStamp(new Date(r.performed_at), zone).local_date) === date)
}

/** The athlete's external program's log routine (session_type 'external'), made on first use. Same shape the app makes. */
async function externalRoutineId(store: ConnectedStore): Promise<string> {
  let [prog] = await store.sql<{ id: string }[]>`
    SELECT id::text AS id FROM program WHERE athlete_id = ${store.athleteId} AND status = 'external' LIMIT 1
  `
  if (!prog) {
    ;[prog] = await store.sql<{ id: string }[]>`
      INSERT INTO program (athlete_id, goal, status) VALUES (${store.athleteId}, ${OUTSIDE_PLAN}, 'external')
      RETURNING id::text AS id
    `
  }
  const [found] = await store.sql<{ id: string }[]>`
    SELECT id::text AS id FROM routine WHERE program_id = ${prog.id} AND session_type = 'external' ORDER BY id LIMIT 1
  `
  if (found) return found.id
  const [made] = await store.sql<{ id: string }[]>`
    INSERT INTO routine (program_id, phase_id, name, session_type, exercises)
    VALUES (${prog.id}, NULL, ${OUTSIDE_PLAN}, 'external', '[]'::jsonb)
    RETURNING id::text AS id
  `
  return made.id
}

/** Pain reports for a log, then U7 — the check-in's path. The workout's pain_change_id must already be changeId. */
async function writePain(store: ConnectedStore, date: string, pain: SportPain[], workoutId: string, changeId: string): Promise<PainOutcome | null> {
  if (!pain.length) return null
  const ids = new Map<string, string>()
  for (const p of pain) {
    const [row] = await store.sql<{ id: string }[]>`
      INSERT INTO pain_report (athlete_id, date, region, score, red_flags, checkin_id, change_id, workout_id)
      VALUES (${store.athleteId}, ${date}::date, ${p.region}, ${p.score}, ${`{${p.red_flags.join(',')}}`}::text[], NULL, ${changeId}, ${workoutId})
      RETURNING id::text AS id
    `
    ids.set(p.region, row.id)
  }
  return applyPainReports(store, date, true, ids, await resolveMethodology(store), changeId)
}

/** What a log's pain did to U7, for the caller — only one who sees health data. */
function u7View(out: PainOutcome | null): Record<string, unknown> | null {
  if (!out) return null
  const blocked = out.moves.filter((m) => m.to === 'blocked')
  return {
    regions: out.calls.map((c) => ({ region: c.region, status: c.status, score: c.score, reason: c.reason, ...(c.block ? { block: c.block } : {}) })),
    moved: out.moves,
    temporary_blocks: out.temporary,
    refer_out: blocked.length ? REFER_OUT : out.temporary.length ? REFER_OUT_TEMPORARY : null,
  }
}

function u7Text(out: PainOutcome | null): string {
  if (!out) return ''
  const blocked = out.moves.filter((m) => m.to === 'blocked')
  const notes = [
    ...(blocked.length ? [blocked.map((m) => m.reason).join(' '), REFER_OUT] : []),
    ...(out.temporary.length ? [out.temporary.map((m) => m.reason).join(' '), REFER_OUT_TEMPORARY] : []),
  ]
  return notes.length ? ` ${notes.join(' ')}` : ''
}

/**
 * The day the window is judged at: now, or a queued log's own clock if it was
 * queued in the current training week (app route only). A log queued last week
 * is judged now, so its date still has to be in this week.
 */
function judgedAt(loggedAt: unknown, now: Date, zone: string): Date | string {
  if (loggedAt == null || loggedAt === '') return now
  const at = typeof loggedAt === 'string' ? new Date(loggedAt) : new Date(NaN)
  if (Number.isNaN(at.getTime())) return 'logged_at must be an ISO timestamp.'
  if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) return 'logged_at is in the future.'
  if (mcpStamp(at, zone).local_date < loggableWeekStart(mcpStamp(now, zone).local_date)) return now
  return at < now ? at : now
}

interface WriteOpts {
  now?: Date
  /** MCP: preview unless confirm=true. The app route always confirms. */
  confirm: boolean
  /** MCP log_session requires client_key (idempotent retries). */
  requireClientKey: boolean
  /** The app's queued log: judge the date window at its queued time (this training week only). */
  trustLoggedAt?: boolean
}

/** Log one sport / conditioning session. */
export async function logSportSession(store: ConnectedStore, actor: OverrideActor, args: Record<string, unknown>, opts: WriteOpts): Promise<SportResult> {
  const who = writerProblem(store, actor, args)
  if (who) return refuse(who)
  if (!(await logSessionV1On(store))) return refuse('Sport logging is off for this athlete.')
  if (!(await sportSchemaReady(store))) return refuse(sportSessionsUnavailable, true)
  const health = await seesHealth(store, actor)
  if (!health && (hasArg(args, 'session_rpe') || (Array.isArray(args.pain) && args.pain.length > 0))) return refuse(SPORT_HEALTH_REFUSED)
  const now = opts.now ?? new Date()
  const zone = await zoneOf(store)
  const at = opts.trustLoggedAt ? judgedAt(args.logged_at, now, zone) : now
  if (typeof at === 'string') return refuse(at)
  const todayNow = mcpStamp(now, zone).local_date
  const today = mcpStamp(at, zone).local_date
  const parsed = parseSportLog(args, today, { requireRpe: health })
  if (!parsed.ok) return refuse(parsed.error)
  const f = parsed.value as SportLogFields
  if (f.date > todayNow) return refuse('a session can\'t be logged for a future day.')
  const clientKey = typeof args.client_key === 'string' && args.client_key.trim() ? args.client_key.trim().slice(0, 120) : null
  if (opts.requireClientKey && !clientKey) return refuse('client_key is required: one stable key per session, so a retry never logs it twice.')
  if (f.pain.length && !(await painReady(store))) return refuse('Pain on a session log needs check-ins set up on this database. Nothing was written.', true)
  const planned = await resolvePlanned(store, args)
  if (planned === 'missing') return refuse('no such planned session in the active program.')
  const load = sessionLoadAu(f.session_rpe, f.duration_min)
  const closes = planned ? !(await routineTakenOn(store, planned.id, f.date, zone, null)) : false

  if (!opts.confirm) {
    const diff = [{
      op: 'log_session', activity: f.activity, date: f.date, duration_min: f.duration_min,
      ...(health ? { session_rpe: f.session_rpe, session_load: load, pain: f.pain } : {}),
      notes: f.notes, client_key: clientKey,
      files_under: closes ? { planned: planned!.name, session_id: planned!.id } : 'external (outside the plan)',
    }]
    return { ok: true, preview: { ...(await writePreview(diff)), closes_planned: closes, note: 'Preview only. Call again with confirm=true to log it (standing approval: logging).' } }
  }

  return withTx(store.sql, async () => {
    if (clientKey) {
      const [dup] = await store.sql<{ id: string }[]>`
        SELECT w.id::text AS id FROM workout w WHERE w.athlete_id = ${store.athleteId} AND w.client_key = ${clientKey} LIMIT 1
      `
      if (dup) {
        const [row] = await loadSportLogs(store, { ids: [dup.id], includeVoided: true })
        if (!row) return refuse('client_key already names a different workout.')
        return { ok: true, text: 'Already logged.', log: row, extra: { reused: true } } satisfies Done
      }
    }
    // Decided again inside the transaction: a second log the same day goes external.
    const linked = planned && !(await routineTakenOn(store, planned.id, f.date, zone, null)) ? planned : null
    const routineId = linked ? linked.id : await externalRoutineId(store)
    const changeId = crypto.randomUUID()
    const snap = sportSnapshot(f.activity, f.duration_min)
    const performedAt = f.date === todayNow ? now.toISOString() : noonInZone(f.date, zone)
    const [ins] = await store.sql<{ id: string }[]>`
      INSERT INTO workout (
        routine_id, performed_at, actual_weights, actual_reps, rpe, duration_mins, exercises_snapshot,
        session_rpe, source, athlete_id, client_key,
        kind, activity, notes, pain, logged_date, change_id, pain_change_id
      ) VALUES (
        ${routineId}, ${performedAt}::timestamptz, ${jsonParam(store.sql, snap.weights)}, ${jsonParam(store.sql, snap.reps)}, NULL,
        ${f.duration_min}, ${jsonParam(store.sql, snap.exercises)},
        ${f.session_rpe}, ${linked ? null : 'external'}, ${store.athleteId}, ${clientKey},
        ${SPORT_KIND}, ${f.activity}, ${f.notes}, ${jsonParam(store.sql, f.pain)}, ${f.date}::date, ${changeId}, ${changeId}
      )
      RETURNING id::text AS id
    `
    const u7 = await writePain(store, f.date, f.pain, ins.id, changeId)
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'log_session',
      targetType: 'sport_session',
      targetId: ins.id,
      diff: {
        workout_id: ins.id, activity: f.activity, date: f.date, duration_min: f.duration_min,
        session_rpe: f.session_rpe, session_load: load, pain: f.pain, notes: f.notes,
        planned: linked ? { session_id: linked.id, session: linked.name } : null,
        ...(planned && !linked ? { planned_already_closed: { session_id: planned.id, session: planned.name } } : {}),
        ...(u7 ? { regions: u7.moves, ...(u7.temporary.length ? { temporary_blocks: u7.temporary } : {}) } : {}),
      },
      rationale: null,
      ruleRefs: f.pain.length ? ['U7'] : [],
      approvalRef: STANDING_LOGGING,
      previewId: null,
    })
    const [row] = await loadSportLogs(store, { ids: [ins.id] })
    const where = linked ? ` Closed the planned session "${linked.name}".` : planned ? ` "${planned.name}" was already logged that day, so this one is filed outside the plan.` : ' Filed outside the plan.'
    return {
      ok: true,
      text: `Logged.${where}${health ? u7Text(u7) : ''}`,
      log: row,
      extra: { closed_planned: linked != null, change_id: changeId, ...(health ? { u7: u7View(u7) } : {}) },
    } satisfies Done
  })
}

/** The log a call names, by workout_id or client_key. */
async function findLog(store: ConnectedStore, args: Record<string, unknown>): Promise<SportLogRow | null> {
  const id = typeof args.workout_id === 'string' ? args.workout_id.trim() : ''
  const key = typeof args.client_key === 'string' ? args.client_key.trim() : ''
  if (id) return (await loadSportLogs(store, { ids: [id], includeVoided: true }))[0] ?? null
  if (!key) return null
  const [w] = await store.sql<{ id: string }[]>`
    SELECT w.id::text AS id FROM workout w WHERE w.athlete_id = ${store.athleteId} AND w.client_key = ${key} LIMIT 1
  `
  return w ? (await loadSportLogs(store, { ids: [w.id], includeVoided: true }))[0] ?? null : null
}

const EDITABLE = ['activity', 'date', 'duration_min', 'session_rpe', 'pain', 'notes'] as const

/** Change a log: activity, date (inside the window), minutes, session RPE, pain, notes. */
export async function updateSportSession(store: ConnectedStore, actor: OverrideActor, args: Record<string, unknown>, opts: WriteOpts): Promise<SportResult> {
  const who = writerProblem(store, actor, args)
  if (who) return refuse(who)
  if (!(await logSessionV1On(store))) return refuse('Sport logging is off for this athlete.')
  if (!(await sportSchemaReady(store))) return refuse(sportSessionsUnavailable, true)
  if (!hasArg(args, 'workout_id') && !hasArg(args, 'client_key')) return refuse('workout_id or client_key is required.')
  const health = await seesHealth(store, actor)
  if (!health && (hasArg(args, 'session_rpe') || hasArg(args, 'pain'))) return refuse(SPORT_HEALTH_REFUSED)
  const before = await findLog(store, args)
  if (!before) return refuse('no such sport log on this athlete.')
  if (before.voided) return refuse('that log was deleted.')
  const now = opts.now ?? new Date()
  const zone = await zoneOf(store)
  const today = mcpStamp(now, zone).local_date
  const patchArgs: Record<string, unknown> = {}
  for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined) patchArgs[k] = args[k]
  if (patchArgs.notes === null) patchArgs.notes = ''
  if (!Object.keys(patchArgs).length) return refuse(`nothing to change: give any of ${EDITABLE.join(', ')}.`)
  if (patchArgs.session_rpe === null) return refuse('session_rpe can\'t be cleared: a session that happened has effort (1–10).')
  const parsed = parseSportLog(patchArgs, today, { partial: true })
  if (!parsed.ok) return refuse(parsed.error)
  const p = parsed.value
  if ((p.pain?.length ?? 0) > 0 && !(await painReady(store))) return refuse('Pain on a session log needs check-ins set up on this database. Nothing was written.', true)
  const after = {
    activity: p.activity ?? before.activity,
    date: p.date ?? before.date,
    duration_min: p.duration_min ?? before.duration_min,
    session_rpe: p.session_rpe !== undefined ? p.session_rpe : before.session_rpe,
    pain: p.pain ?? before.pain,
    notes: p.notes !== undefined ? p.notes : before.notes,
  }
  const same = after.activity === before.activity && after.date === before.date && after.duration_min === before.duration_min
    && after.session_rpe === before.session_rpe && JSON.stringify(after.pain) === JSON.stringify(before.pain) && after.notes === before.notes
  if (same) return { ok: true, text: 'Nothing changed.', log: before, extra: {} }
  if (!opts.confirm) {
    const shown = (x: typeof after) => health ? x : { activity: x.activity, date: x.date, duration_min: x.duration_min, notes: x.notes }
    const diff = [{ op: 'update_session', workout_id: before.workout_id, before: shown({ ...before }), after: shown(after) }]
    return { ok: true, preview: { ...(await writePreview(diff)), note: 'Preview only. Call again with confirm=true to apply it (standing approval: logging).' } }
  }

  return withTx(store.sql, async () => {
    const changeId = crypto.randomUUID()
    const painChanged = JSON.stringify(after.pain) !== JSON.stringify(before.pain) || (after.date !== before.date && after.pain.length > 0)
    // A log that closed its card keeps it unless the new day's card is already closed by another log; then it goes external.
    let routineId = before.routine_id
    let movedOff: string | null = null
    if (before.closed_planned && after.date !== before.date && await routineTakenOn(store, before.routine_id, after.date, zone, before.workout_id)) {
      routineId = await externalRoutineId(store)
      movedOff = before.routine_name
    }
    const snap = sportSnapshot(after.activity, after.duration_min)
    const performedAt = after.date === before.date ? null : after.date === today ? now.toISOString() : noonInZone(after.date, zone)
    await store.sql`
      UPDATE workout SET
        routine_id = ${routineId},
        source = ${routineId === before.routine_id ? (before.closed_planned ? null : 'external') : 'external'},
        performed_at = COALESCE(${performedAt}::timestamptz, performed_at),
        actual_weights = ${jsonParam(store.sql, snap.weights)}, actual_reps = ${jsonParam(store.sql, snap.reps)},
        exercises_snapshot = ${jsonParam(store.sql, snap.exercises)},
        duration_mins = ${after.duration_min}, session_rpe = ${after.session_rpe},
        activity = ${after.activity}, notes = ${after.notes}, pain = ${jsonParam(store.sql, after.pain)},
        logged_date = ${after.date}::date, change_id = ${changeId},
        pain_change_id = CASE WHEN ${painChanged}::boolean THEN ${changeId}::uuid ELSE pain_change_id END
      WHERE id = ${before.workout_id} AND athlete_id = ${store.athleteId} AND voided_at IS NULL
    `
    // New reports supersede the old ones (pain_change_id moved); an empty list leaves none standing.
    const u7 = painChanged ? await writePain(store, after.date, after.pain, before.workout_id, changeId) : null
    const pick = (x: typeof after) => ({ activity: x.activity, date: x.date, duration_min: x.duration_min, session_rpe: x.session_rpe, session_load: sessionLoadAu(x.session_rpe, x.duration_min), pain: x.pain, notes: x.notes })
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'update_session',
      targetType: 'sport_session',
      targetId: before.workout_id,
      diff: {
        workout_id: before.workout_id,
        before: pick(before), after: pick(after),
        ...(painChanged ? { pain_reports: 'superseded' } : {}),
        ...(movedOff ? { reopened_planned: movedOff } : {}),
        ...(u7 ? { regions: u7.moves } : {}),
      },
      rationale: null,
      ruleRefs: painChanged ? ['U7'] : [],
      approvalRef: STANDING_LOGGING,
      previewId: null,
    })
    const [row] = await loadSportLogs(store, { ids: [before.workout_id] })
    return {
      ok: true,
      text: `Updated.${movedOff ? ` "${movedOff}" was already logged that day, so this one is now outside the plan.` : ''}${health ? u7Text(u7) : ''}`,
      log: row,
      extra: { change_id: changeId, ...(health && u7 ? { u7: u7View(u7) } : {}) },
    } satisfies Done
  })
}

/** Delete a log: voided, never erased. Its pain stops counting; a card it closed re-opens unless another log closes it. */
export async function deleteSportSession(store: ConnectedStore, actor: OverrideActor, args: Record<string, unknown>, opts: WriteOpts): Promise<SportResult> {
  const who = writerProblem(store, actor, args)
  if (who) return refuse(who)
  if (!(await logSessionV1On(store))) return refuse('Sport logging is off for this athlete.')
  if (!(await sportSchemaReady(store))) return refuse(sportSessionsUnavailable, true)
  if (!hasArg(args, 'workout_id') && !hasArg(args, 'client_key')) return refuse('workout_id or client_key is required.')
  const before = await findLog(store, args)
  if (!before) return refuse('no such sport log on this athlete.')
  if (before.voided) return { ok: true, text: 'Already deleted.', log: before, extra: {} }
  const health = await seesHealth(store, actor)
  if (!opts.confirm) {
    const diff = [{ op: 'delete_session', workout_id: before.workout_id, activity: before.activity, date: before.date, duration_min: before.duration_min }]
    return { ok: true, preview: { ...(await writePreview(diff)), note: 'Preview only. Call again with confirm=true to delete it (standing approval: logging).' } }
  }
  const zone = await zoneOf(store)
  return withTx(store.sql, async () => {
    const changeId = crypto.randomUUID()
    await store.sql`
      UPDATE workout SET voided_at = NOW(), void_change_id = ${changeId}
      WHERE id = ${before.workout_id} AND athlete_id = ${store.athleteId} AND voided_at IS NULL
    `
    const reopened = before.closed_planned && !(await routineTakenOn(store, before.routine_id, before.date, zone, before.workout_id))
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'delete_session',
      targetType: 'sport_session',
      targetId: before.workout_id,
      diff: {
        workout_id: before.workout_id, activity: before.activity, date: before.date, duration_min: before.duration_min,
        session_rpe: before.session_rpe, pain: before.pain,
        ...(before.pain.length ? { pain_reports: 'voided' } : {}),
        ...(reopened ? { reopened_planned: { session_id: before.routine_id, session: before.routine_name } } : {}),
      },
      rationale: null,
      ruleRefs: before.pain.length ? ['U7'] : [],
      approvalRef: STANDING_LOGGING,
      previewId: null,
    })
    const [row] = await loadSportLogs(store, { ids: [before.workout_id], includeVoided: true })
    return {
      ok: true,
      text: `Deleted.${reopened ? ` "${before.routine_name}" is open again.` : ''}${health && before.pain.length ? ' Its pain reports no longer count.' : ''}`,
      log: row,
      extra: { reopened_planned: reopened, change_id: changeId },
    } satisfies Done
  })
}

// ---- MCP ------------------------------------------------------------------------------------------

const painItem = {
  type: 'object',
  properties: {
    region: { type: 'string', enum: [...SPORT_PAIN_REGIONS] },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    red_flags: { type: 'array', items: { type: 'string', enum: [...SPORT_RED_FLAGS] } },
  },
  required: ['region', 'score'],
  additionalProperties: false,
}

const fields = {
  activity: { type: 'string', description: 'What it was, free text: Basketball, Run, Ride, Class, Match, or anything else. Used for U7 (basketball loads knee, ankle, hip) and conditioning volume.' },
  date: { type: 'string', description: 'YYYY-MM-DD, the athlete\'s calendar date, in the current training week: from this week\'s Monday through today (athlete\'s time zone). Never a future day, never before this week\'s Monday.' },
  duration_min: { type: 'integer', minimum: 1, maximum: 600, description: 'Whole minutes, 1–600.' },
  session_rpe: { type: 'integer', minimum: 1, maximum: 10, description: 'How hard the whole session was, 1–10 (CR-10). Health data: required, unless the athlete hasn\'t shared health data with you — then leave it out.' },
  pain: { type: 'array', items: painItem, description: 'Pain by region (the check-in\'s regions and red flags). Each is a pain report for that date, judged by U7. Health data: only if the athlete shares it with you.' },
  notes: { type: 'string', description: 'The athlete\'s note on it.' },
}

export const SPORT_SESSION_TOOLS: McpTool[] = [
  {
    name: 'log_session',
    description: 'Log a sport or conditioning session the athlete did (a game, a run, a class): activity, date, minutes, session RPE, optional pain and notes. One call per session; two games are two calls. Named against a planned session (session_id or session_name), the first log that day closes that card; otherwise it is filed outside the plan and fills no planned slot. Counts toward weekly session load and U7. Preview unless confirm=true. Logging: standing approval, recorded in the change log.',
    inputSchema: {
      type: 'object',
      properties: {
        ...fields,
        session_id: { type: 'string', description: 'The planned session (routine id) this was, if any.' },
        session_name: { type: 'string', description: 'Or the planned session by name, e.g. "Thu Basketball".' },
        client_key: { type: 'string', description: 'One stable key per session you log. A retry with the same key never logs it twice.' },
        confirm: { type: 'boolean', description: 'true to log it; otherwise a preview.' },
      },
      required: ['activity', 'date', 'duration_min', 'client_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_session',
    description: 'Change a logged sport / conditioning session: activity, date (inside the 7-day window), minutes, session RPE, pain (the list replaces the old one; [] clears it), notes. Session load and U7 re-read it. Preview unless confirm=true. Logging: standing approval.',
    inputSchema: {
      type: 'object',
      properties: {
        workout_id: { type: 'string', description: 'From log_session or list_workouts.' },
        client_key: { type: 'string', description: 'Or the client_key it was logged with.' },
        ...fields,
        confirm: { type: 'boolean', description: 'true to apply; otherwise a preview.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_session',
    description: 'Delete a logged sport / conditioning session. It is kept as deleted, never erased; it stops counting toward volume and its pain stops counting for U7. A planned card it closed re-opens unless another log closes it. Preview unless confirm=true. Logging: standing approval.',
    inputSchema: {
      type: 'object',
      properties: {
        workout_id: { type: 'string' },
        client_key: { type: 'string' },
        confirm: { type: 'boolean', description: 'true to delete; otherwise a preview.' },
      },
      additionalProperties: false,
    },
  },
]

export const SPORT_SESSION_TOOL_NAMES = new Set(SPORT_SESSION_TOOLS.map((t) => t.name))

/** MCP: the three tools, for a flag-on athlete. Unknown otherwise. */
export async function runSportSessionTool(store: ConnectedStore, name: string, args: Record<string, unknown>, actor: OverrideActor, now: Date = new Date()): Promise<string> {
  if (!SPORT_SESSION_TOOL_NAMES.has(name) || !(await logSessionV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  const opts: WriteOpts = { now, confirm: args.confirm === true, requireClientKey: name === 'log_session' }
  const out = name === 'log_session' ? await logSportSession(store, actor, args, opts)
    : name === 'update_session' ? await updateSportSession(store, actor, args, opts)
      : await deleteSportSession(store, actor, args, opts)
  if (!out.ok) return out.text
  if ('preview' in out) return JSON.stringify(out.preview, null, 2)
  const health = await seesHealth(store, actor)
  return JSON.stringify({
    ...mcpStamp(now, await zoneOf(store)),
    result: out.text,
    workout_id: out.log.workout_id,
    ...(health ? { session_load: out.log.session_load } : {}),
    log: sportView(out.log, health),
    ...out.extra,
  }, null, 2)
}

// ---- app route ------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The route's body (POST /api/sport-session), separated so checks can drive it without an auth cookie. */
export async function athleteSportSessionAction(store: ConnectedStore, body: Record<string, unknown>, now: Date = new Date()): Promise<[unknown, number]> {
  if (!(await logSessionV1On(store))) return [{ error: 'not found' }, 404]
  const athlete: OverrideActor = { type: 'athlete', id: store.athleteId }
  const opts: WriteOpts = { now, confirm: true, requireClientKey: false, trustLoggedAt: true }
  const answer = (r: SportResult): [unknown, number] => {
    if (!r.ok) return [r, 200]
    if ('preview' in r) return [{ ok: true, preview: r.preview }, 200]
    return [{ ok: true, text: r.text, log: sportView(r.log, true), ...r.extra }, 200]
  }
  switch (body.action) {
    case 'log':
      return answer(await logSportSession(store, athlete, body, opts))
    case 'update':
      return answer(await updateSportSession(store, athlete, body, opts))
    case 'delete':
      return answer(await deleteSportSession(store, athlete, body, opts))
    case 'list': {
      if (!(await sportSchemaReady(store))) return [{ available: false, logs: [] }, 200]
      const today = mcpStamp(now, await zoneOf(store)).local_date
      const from = typeof body.from === 'string' && DATE_RE.test(body.from) ? body.from : addDays(today, -6)
      const to = typeof body.to === 'string' && DATE_RE.test(body.to) ? body.to : today
      return [{ available: true, today, logs: (await loadSportLogs(store, { from, to })).map((r) => sportView(r, true)) }, 200]
    }
    default:
      return [{ error: 'unknown action' }, 400]
  }
}

/** POST /api/sport-session — the athlete's own session; same auth as /api/session-rpe. */
export async function handleSportSession(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
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
      const [out, status] = await athleteSportSessionAction(makeStore(sql, athleteId, 'lb'), body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'sport session request failed' }, 500, cors)
  }
}
