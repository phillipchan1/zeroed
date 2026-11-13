/**
 * Session RPE (G9, tracks_v1): Foster's one CR-10 tap (0–10) for the whole
 * session, taken at the finish. Stored in its own table, session_rpe, and
 * never merged into set RPE: workout.rpe stays the mean of the set RPEs
 * (docs/one-athlete-one-arc.md §0.1), and arc_load_v1's workout.session_rpe
 * is left exactly as it was.
 *
 *   log    the athlete's own tap, for their today. Logging: standing approval,
 *          one change_log row per tap (before → after). One row per session
 *          per day: a second tap the same day updates it. No coach, app_coach
 *          included, writes a rating.
 *   late   a session dated D can be rated from D 00:00 until D+1 04:00,
 *          athlete-local (RATE_GRACE_HOURS), so last night's session can still
 *          be rated after midnight. The app queues a tap it couldn't send
 *          (src/lib/sessionRpeQueue.ts) and retries it with client_id and
 *          tapped_at: the window is judged at tapped_at, which is trusted only
 *          when it is no later than now (+ a few minutes of clock skew) and no
 *          older than QUEUE_MAX_AGE_MS — never a way to backdate beyond the
 *          window. A retry of a tap already applied (same client_id) is
 *          "Already logged"; a queued tap older than the row's latest is
 *          acknowledged and not applied. Both need session-rpe-queue.sql;
 *          before it, tapped_at is ignored (the tap counts as sent now).
 *   read   MCP get_session_rpe(since, until?) — a coach read, logged (tools.ts),
 *          and health data (D3): a coach the athlete hasn't shared health data
 *          with gets a refusal. Each row carries the set-RPE mean of the same
 *          day's workout beside it, labelled, so the two can be compared.
 *   load   session load (AU) = rating × duration_min when the duration is
 *          known; summed into get_weekly_review's session_load.
 *
 * Route, the athlete's own session, 404 with the flag off:
 *   POST /api/session-rpe   { action: 'log' | 'list' }
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { mcpStamp } from '../../src/engine/mcpStamp.ts'
import { beginAuthCors, json } from './cors.ts'
import { withSql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { STANDING_LOGGING, withTx, writeChange } from './changeLog.ts'
import { addDays } from './readiness/rules.ts'
import { seesHealth } from './regionStatus.ts'
import { athleteToday, tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { calendarZone, loadWorkouts, makeStore, type ConnectedStore } from './store.ts'
import { hiddenIds, idList } from './tombstones.ts'
import { sportLoadRows } from './sportSessions.ts'
import { McpUserError } from './userError.ts'

export const sessionRpeUnavailable = 'Session RPE is not set up on this database yet. Nothing was written.'
export const SESSION_RPE_HIDDEN = 'The athlete has not shared health data (check-ins, pain, session effort) with you. Ask them to turn on health data for this coach in Profile.'

/** The CR-10 anchors, as the app's tap shows them (src/engine/outsidePlan.ts; a check keeps them equal). */
export const CR10_LABELS: Record<number, string> = {
  0: 'Rest', 1: 'Very, very easy', 2: 'Easy', 3: 'Moderate', 4: 'Somewhat hard', 5: 'Hard',
  6: 'Hard to very hard', 7: 'Very hard', 8: 'Very hard to maximal', 9: 'Very hard to maximal', 10: 'Maximal',
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A session dated D can be rated until this hour (athlete-local) on D+1. */
export const RATE_GRACE_HOURS = 4
/** A queued tap's own clock is trusted back this far, and no further. */
export const QUEUE_MAX_AGE_MS = 48 * 60 * 60 * 1000
/** How far ahead of the server a device's clock may run. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000

/** The local hour (0–23) of an instant in a zone. */
function localHour(at: Date, zone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(at))
  } catch {
    return at.getUTCHours()
  }
}

/** The session dates a tap at `at` may rate: its own local date and, before 04:00, the day before. */
export function ratableDates(at: Date, zone: string): string[] {
  const day = mcpStamp(at, zone).local_date
  return localHour(at, zone) < RATE_GRACE_HOURS ? [day, addDays(day, -1)] : [day]
}


/** True once worker/schema/session-rpe.sql is on this database. Checked, not caught (callers run in transactions). */
export async function sessionRpeTable(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`SELECT to_regclass('public.session_rpe') IS NOT NULL AS ok`
  return row?.ok === true
}

/** True once worker/schema/session-rpe-queue.sql is on this database (client_id, tapped_at). */
export async function sessionRpeQueueCols(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_rpe' AND column_name = 'tapped_at'
    ) AS ok
  `
  return row?.ok === true
}

export interface SessionRpeRow {
  id: string
  date: string
  session_id: string
  session: string | null
  workout_id: string | null
  rating: number
  duration_min: number | null
  /** rating × duration_min (AU); null without a duration. */
  load: number | null
  updated_at: string
}

/** Ratings dated in [from, to], oldest first. Empty before session-rpe.sql. */
export async function loadSessionRpe(store: ConnectedStore, from: string, to: string): Promise<SessionRpeRow[]> {
  if (!(await sessionRpeTable(store))) return []
  const rows = await store.sql<{
    id: string; date: string; session_id: string; session: string | null; workout_id: string | null
    rating: unknown; duration_min: unknown; updated_at: string
  }[]>`
    SELECT s.id::text AS id, s.date::text AS date, s.session_id::text AS session_id, r.name AS session,
           s.workout_id::text AS workout_id, s.rating, s.duration_min, to_json(s.updated_at) #>> '{}' AS updated_at
    FROM session_rpe s
    LEFT JOIN routine r ON r.id = s.session_id
    WHERE s.athlete_id = ${store.athleteId} AND s.date >= ${from}::date AND s.date <= ${to}::date
      AND NOT (s.id::text = ANY(${idList(await hiddenIds(store, 'session_rpe'))}::text[]))
    ORDER BY s.date, s.created_at, s.id
  `
  return rows.map((r) => {
    const rating = Number(r.rating)
    const duration = r.duration_min == null ? null : Number(r.duration_min)
    return { ...r, rating, duration_min: duration, load: duration == null ? null : rating * duration }
  })
}

// ---- the tap (logging) -------------------------------------------------------------

export interface SessionRpeResult {
  ok: boolean
  text: string
  /** A refusal that may pass later unchanged (the table isn't there yet): the app keeps the tap queued. */
  retry?: boolean
  change_id?: string
  rating?: SessionRpeRow
}

/** A whole number in [lo, hi]; null when absent; 'bad' otherwise. */
function intIn(v: unknown, lo: number, hi: number): number | null | 'bad' {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isInteger(n) && n >= lo && n <= hi ? n : 'bad'
}

/**
 * The athlete rates a session they trained today (or last night, until 04:00):
 * insert, or update that day's row for that session. Standing approval
 * (logging), one change_log row. `now` is the server's clock; checks pin it.
 */
export async function logSessionRpe(store: ConnectedStore, actor: OverrideActor, body: Record<string, unknown>, now: Date = new Date()): Promise<SessionRpeResult> {
  if (actor.type !== 'athlete' || actor.id !== store.athleteId) {
    return { ok: false, text: 'Refused: only the athlete rates their own session.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Session RPE is off for this athlete.' }
  if (!(await sessionRpeTable(store))) return { ok: false, text: sessionRpeUnavailable, retry: true }
  const [tz] = await store.sql<{ time_zone: string | null }[]>`SELECT time_zone FROM athlete WHERE id = ${store.athleteId} LIMIT 1`
  const zone = calendarZone(tz?.time_zone)
  const today = mcpStamp(now, zone).local_date
  const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : today
  if (!DATE_RE.test(date)) return { ok: false, text: 'Refused: date must be YYYY-MM-DD.' }
  // A queued tap: its id dedupes retries, its own time judges the window — within bounds.
  const queue = await sessionRpeQueueCols(store)
  let clientId: string | null = null
  if (body.client_id != null && body.client_id !== '') {
    if (typeof body.client_id !== 'string' || !UUID_RE.test(body.client_id)) return { ok: false, text: 'Refused: client_id must be a UUID.' }
    clientId = queue ? body.client_id.toLowerCase() : null
  }
  let tappedAt = now
  if (body.tapped_at != null && body.tapped_at !== '') {
    const at = typeof body.tapped_at === 'string' ? new Date(body.tapped_at) : new Date(NaN)
    if (Number.isNaN(at.getTime())) return { ok: false, text: 'Refused: tapped_at must be an ISO timestamp.' }
    if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) return { ok: false, text: 'Refused: tapped_at is in the future.' }
    if (at.getTime() < now.getTime() - QUEUE_MAX_AGE_MS) return { ok: false, text: 'Refused: this rating waited too long to sync (more than 48 hours).' }
    if (queue) tappedAt = at < now ? at : now
  }
  if (!ratableDates(tappedAt, zone).includes(date)) {
    return { ok: false, text: `Refused: a session RPE can only be logged or changed on the day of the session, or until 0${RATE_GRACE_HOURS}:00 the next morning.` }
  }
  const rating = intIn(body.rating, 0, 10)
  if (rating === 'bad' || rating == null) return { ok: false, text: 'Refused: rating must be a whole number 0–10 (CR-10).' }
  const duration = intIn(body.duration_min, 1, 600)
  if (duration === 'bad') return { ok: false, text: 'Refused: duration_min must be whole minutes, 1–600.' }
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : ''
  if (!UUID_RE.test(sessionId)) return { ok: false, text: 'Refused: session_id is required.' }
  const [session] = await store.sql<{ name: string }[]>`
    SELECT r.name FROM routine r JOIN program p ON p.id = r.program_id
    WHERE r.id = ${sessionId} AND p.athlete_id = ${store.athleteId} LIMIT 1
  `
  if (!session) return { ok: false, text: 'Refused: no such session.' }
  let workoutId: string | null = null
  if (typeof body.workout_id === 'string' && UUID_RE.test(body.workout_id)) {
    const [w] = await store.sql<{ id: string }[]>`
      SELECT w.id::text AS id FROM workout w JOIN routine r ON r.id = w.routine_id JOIN program p ON p.id = r.program_id
      WHERE w.id = ${body.workout_id} AND w.routine_id = ${sessionId} AND p.athlete_id = ${store.athleteId} LIMIT 1
    `
    if (!w) return { ok: false, text: 'Refused: no such workout for that session.' }
    workoutId = w.id
  }

  return withTx(store.sql, async () => {
    if (clientId) {
      // The same tap again: its first send landed and the answer was lost. Never a second write.
      const [dup] = await store.sql<{ id: string; date: string }[]>`
        SELECT id::text AS id, date::text AS date FROM session_rpe
        WHERE athlete_id = ${store.athleteId} AND client_id = ${clientId}
      `
      if (dup) {
        const [same] = (await loadSessionRpe(store, dup.date, dup.date)).filter((r) => r.id === dup.id)
        return { ok: true, text: 'Already logged.', ...(same ? { rating: same } : {}) }
      }
    }
    const [before] = queue
      ? await store.sql<{ id: string; rating: unknown; duration_min: unknown; workout_id: string | null; tapped_at: string | null }[]>`
          SELECT id::text AS id, rating, duration_min, workout_id::text AS workout_id, to_json(tapped_at) #>> '{}' AS tapped_at FROM session_rpe
          WHERE athlete_id = ${store.athleteId} AND date = ${date}::date AND session_id = ${sessionId}
          FOR UPDATE
        `
      : await store.sql<{ id: string; rating: unknown; duration_min: unknown; workout_id: string | null; tapped_at: string | null }[]>`
          SELECT id::text AS id, rating, duration_min, workout_id::text AS workout_id, NULL::text AS tapped_at FROM session_rpe
          WHERE athlete_id = ${store.athleteId} AND date = ${date}::date AND session_id = ${sessionId}
          FOR UPDATE
        `
    // A rating the athlete undid (voided, tracks_v1) counts as none: this tap is the first again.
    const live = before && !(await hiddenIds(store, 'session_rpe')).includes(before.id) ? before : null
    // A queued tap that lands after a newer one: the newer rating stands.
    if (live?.tapped_at && tappedAt.getTime() < new Date(live.tapped_at).getTime()) {
      const [newer] = (await loadSessionRpe(store, date, date)).filter((r) => r.id === live.id)
      return { ok: true, text: 'A newer rating is already logged.', rating: newer }
    }
    const prev = live ? { rating: Number(live.rating), duration_min: live.duration_min == null ? null : Number(live.duration_min) } : null
    // A tap without a duration keeps the one already logged.
    const nextDuration = duration ?? prev?.duration_min ?? null
    if (prev && prev.rating === rating && prev.duration_min === nextDuration && (workoutId == null || workoutId === before!.workout_id)) {
      const [same] = await loadSessionRpe(store, date, date).then((rows) => rows.filter((r) => r.id === before!.id))
      return { ok: true, text: 'Already logged.', rating: same }
    }
    const changeId = crypto.randomUUID()
    const [row] = queue
      ? await store.sql<{ id: string }[]>`
          INSERT INTO session_rpe (athlete_id, date, session_id, workout_id, rating, duration_min, change_id, client_id, tapped_at)
          VALUES (${store.athleteId}, ${date}::date, ${sessionId}, ${workoutId}, ${rating}, ${nextDuration}, ${changeId}, ${clientId}, ${tappedAt.toISOString()}::timestamptz)
          ON CONFLICT (athlete_id, date, session_id) DO UPDATE
            SET rating = EXCLUDED.rating, duration_min = EXCLUDED.duration_min,
                workout_id = COALESCE(EXCLUDED.workout_id, session_rpe.workout_id),
                change_id = EXCLUDED.change_id, client_id = EXCLUDED.client_id,
                tapped_at = EXCLUDED.tapped_at, updated_at = NOW()
          RETURNING id::text AS id
        `
      : await store.sql<{ id: string }[]>`
          INSERT INTO session_rpe (athlete_id, date, session_id, workout_id, rating, duration_min, change_id)
          VALUES (${store.athleteId}, ${date}::date, ${sessionId}, ${workoutId}, ${rating}, ${nextDuration}, ${changeId})
          ON CONFLICT (athlete_id, date, session_id) DO UPDATE
            SET rating = EXCLUDED.rating, duration_min = EXCLUDED.duration_min,
                workout_id = COALESCE(EXCLUDED.workout_id, session_rpe.workout_id),
                change_id = EXCLUDED.change_id, updated_at = NOW()
          RETURNING id::text AS id
        `
    // A rating undone earlier is revived by this tap: its tombstone is lifted, so this tap can be undone in turn.
    if (before && !live) {
      await store.sql`
        UPDATE change_tombstone SET lifted_at = NOW(), lifted_by = ${changeId}
        WHERE athlete_id = ${store.athleteId} AND row_table = 'session_rpe' AND row_id = ${before.id} AND lifted_at IS NULL
      `
    }
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'log_session_rpe',
      targetType: 'session_rpe',
      targetId: row.id,
      diff: {
        date,
        session_id: sessionId,
        session: session.name,
        before: prev,
        after: { rating, duration_min: nextDuration },
      },
      rationale: null,
      ruleRefs: [],
      approvalRef: STANDING_LOGGING,
      previewId: null,
    })
    const [saved] = (await loadSessionRpe(store, date, date)).filter((r) => r.id === row.id)
    return { ok: true, text: prev ? 'Updated.' : 'Logged.', change_id: changeId, rating: saved }
  })
}

// ---- the weekly review's load ----------------------------------------------------------

export interface SessionLoadView {
  /** Sessions rated this week, and how many of those had a duration. */
  rated: number
  with_duration: number
  rating_avg: number | null
  /** Σ rating × duration_min this week (AU). */
  load_au: number
  /** The mean weekly load over the 4 weeks before; null without any rating then. */
  usual_au: number | null
  /** load_au ÷ usual_au, for "lighter / usual / heavier". Not a risk score. */
  vs_usual: number | null
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** What the weekly sum reads of a tap or a sport log. */
type LoadRow = Pick<SessionRpeRow, 'date' | 'rating' | 'load' | 'workout_id'>

/**
 * Session load for the week [monday, monday + 6] against the 4 weeks before (Foster).
 * log_session_v1: every sport / conditioning log in the window (session RPE ×
 * minutes, planned or external, two same-day games both) adds to the session_rpe
 * taps; a tap already tied to one of those logs isn't counted twice. Flag off:
 * exactly the taps, as before.
 */
export async function sessionLoadForWeek(store: ConnectedStore, monday: string): Promise<SessionLoadView> {
  const sunday = addDays(monday, 6)
  const taps: LoadRow[] = await loadSessionRpe(store, addDays(monday, -28), sunday)
  const sport = await sportLoadRows(store, addDays(monday, -28), sunday)
  const sportIds = new Set(sport.map((x) => x.workout_id))
  const rows: LoadRow[] = sport.length
    ? [...taps.filter((r) => !r.workout_id || !sportIds.has(r.workout_id)), ...sport.map((x) => ({ date: x.date, rating: x.rating, load: x.load, workout_id: x.workout_id }))]
    : taps
  const week = rows.filter((r) => r.date >= monday)
  const prior = rows.filter((r) => r.date < monday)
  const sum = (xs: LoadRow[]) => xs.reduce((a, r) => a + (r.load ?? 0), 0)
  const loadAu = sum(week)
  const usual = prior.length ? round1(sum(prior) / 4) : null
  return {
    rated: week.length,
    with_duration: week.filter((r) => r.load != null).length,
    rating_avg: week.length ? round1(week.reduce((a, r) => a + r.rating, 0) / week.length) : null,
    load_au: loadAu,
    usual_au: usual,
    vs_usual: usual ? Math.round((loadAu / usual) * 100) / 100 : null,
  }
}

// ---- MCP ----------------------------------------------------------------------------------

export const SESSION_RPE_TOOLS: McpTool[] = [
  {
    name: 'get_session_rpe',
    description: 'The athlete\'s session RPE: one CR-10 rating (0–10) of each whole session, tapped at the finish, with its duration and session load (rating × minutes, AU). Separate from set RPE: set_rpe_mean beside each row is the mean of that day\'s set RPEs for the same session, for comparison only. Health data: only if the athlete shares it with you. Read-only; the athlete logs these themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        until: { type: 'string', description: 'YYYY-MM-DD, inclusive (default today).' },
      },
      required: ['since'],
      additionalProperties: false,
    },
  },
]

export const SESSION_RPE_TOOL_NAMES = new Set(SESSION_RPE_TOOLS.map((t) => t.name))

export async function runSessionRpeTool(store: ConnectedStore, name: string, args: Record<string, unknown>, actor: OverrideActor): Promise<string> {
  if (!(await tracksV1On(store)) || !SESSION_RPE_TOOL_NAMES.has(name)) throw new McpUserError(`Unknown tool: ${name}`)
  if (!(await seesHealth(store, actor))) return SESSION_RPE_HIDDEN
  if (!(await sessionRpeTable(store))) return sessionRpeUnavailable.replace(' Nothing was written.', '')
  const today = await athleteToday(store)
  const since = typeof args.since === 'string' ? args.since.trim().slice(0, 10) : ''
  const until = typeof args.until === 'string' && args.until.trim() ? args.until.trim().slice(0, 10) : today
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) throw new McpUserError('since (and until) must be YYYY-MM-DD')
  const [rows, tz, workouts] = await Promise.all([
    loadSessionRpe(store, since, until),
    store.sql<{ time_zone: string | null }[]>`SELECT time_zone FROM athlete WHERE id = ${store.athleteId}`,
    loadWorkouts(store, { limit: 120, since: `${addDays(since, -1)}T00:00:00Z`, until: `${addDays(until, 1)}T23:59:59Z` }),
  ])
  const zone = calendarZone(tz[0]?.time_zone)
  const setRpeMean = (r: SessionRpeRow): number | null => {
    const w = workouts.find((x) => (r.workout_id ? x.id === r.workout_id : x.routine_id === r.session_id && mcpStamp(new Date(x.performed_at), zone).local_date === r.date))
    return w?.rpe == null ? null : Number(w.rpe)
  }
  return JSON.stringify({
    since,
    until,
    scale: 'CR-10 (0 rest … 10 maximal), one rating of the whole session',
    sessions: rows.map((r) => ({
      date: r.date,
      session: r.session,
      session_id: r.session_id,
      rating: r.rating,
      label: CR10_LABELS[r.rating] ?? null,
      duration_min: r.duration_min,
      load_au: r.load,
      set_rpe_mean: setRpeMean(r),
    })),
    total_load_au: rows.reduce((a, r) => a + (r.load ?? 0), 0),
  }, null, 2)
}

// ---- app route ------------------------------------------------------------------------------

/** The route's body (POST /api/session-rpe), separated so checks can drive it without an auth cookie. */
export async function athleteSessionRpeAction(store: ConnectedStore, body: Record<string, unknown>, now: Date = new Date()): Promise<[unknown, number]> {
  if (!(await tracksV1On(store))) return [{ error: 'not found' }, 404]
  switch (body.action) {
    case 'log':
      return [await logSessionRpe(store, { type: 'athlete', id: store.athleteId }, body, now), 200]
    case 'list': {
      const today = await athleteToday(store, now)
      const from = typeof body.from === 'string' && DATE_RE.test(body.from) ? body.from : today
      const to = typeof body.to === 'string' && DATE_RE.test(body.to) ? body.to : today
      return [{ today, available: await sessionRpeTable(store), ratings: await loadSessionRpe(store, from, to) }, 200]
    }
    default:
      return [{ error: 'unknown action' }, 400]
  }
}

/** POST /api/session-rpe — the athlete's own session; same auth as /api/readiness. */
export async function handleSessionRpe(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
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
      const [out, status] = await athleteSessionRpeAction(makeStore(sql, athleteId, 'lb'), body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'session rpe request failed' }, 500, cors)
  }
}
