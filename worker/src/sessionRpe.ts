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


/** True once worker/schema/session-rpe.sql is on this database. Checked, not caught (callers run in transactions). */
export async function sessionRpeTable(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`SELECT to_regclass('public.session_rpe') IS NOT NULL AS ok`
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
 * The athlete rates a session they trained today: insert, or update today's
 * row for that session. Standing approval (logging), one change_log row.
 */
export async function logSessionRpe(store: ConnectedStore, actor: OverrideActor, body: Record<string, unknown>): Promise<SessionRpeResult> {
  if (actor.type !== 'athlete' || actor.id !== store.athleteId) {
    return { ok: false, text: 'Refused: only the athlete rates their own session.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Session RPE is off for this athlete.' }
  if (!(await sessionRpeTable(store))) return { ok: false, text: sessionRpeUnavailable }
  const today = await athleteToday(store)
  const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : today
  if (!DATE_RE.test(date)) return { ok: false, text: 'Refused: date must be YYYY-MM-DD.' }
  if (date !== today) return { ok: false, text: 'Refused: a session RPE can only be logged or changed on the day of the session.' }
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
    const [before] = await store.sql<{ id: string; rating: unknown; duration_min: unknown; workout_id: string | null }[]>`
      SELECT id::text AS id, rating, duration_min, workout_id::text AS workout_id FROM session_rpe
      WHERE athlete_id = ${store.athleteId} AND date = ${date}::date AND session_id = ${sessionId}
      FOR UPDATE
    `
    const prev = before ? { rating: Number(before.rating), duration_min: before.duration_min == null ? null : Number(before.duration_min) } : null
    // A tap without a duration keeps the one already logged.
    const nextDuration = duration ?? prev?.duration_min ?? null
    if (prev && prev.rating === rating && prev.duration_min === nextDuration && (workoutId == null || workoutId === before!.workout_id)) {
      const [same] = await loadSessionRpe(store, date, date).then((rows) => rows.filter((r) => r.id === before!.id))
      return { ok: true, text: 'Already logged.', rating: same }
    }
    const changeId = crypto.randomUUID()
    const [row] = await store.sql<{ id: string }[]>`
      INSERT INTO session_rpe (athlete_id, date, session_id, workout_id, rating, duration_min, change_id)
      VALUES (${store.athleteId}, ${date}::date, ${sessionId}, ${workoutId}, ${rating}, ${nextDuration}, ${changeId})
      ON CONFLICT (athlete_id, date, session_id) DO UPDATE
        SET rating = EXCLUDED.rating, duration_min = EXCLUDED.duration_min,
            workout_id = COALESCE(EXCLUDED.workout_id, session_rpe.workout_id),
            change_id = EXCLUDED.change_id, updated_at = NOW()
      RETURNING id::text AS id
    `
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

/** Session load for the week [monday, monday + 6] against the 4 weeks before (Foster). */
export async function sessionLoadForWeek(store: ConnectedStore, monday: string): Promise<SessionLoadView> {
  const sunday = addDays(monday, 6)
  const rows = await loadSessionRpe(store, addDays(monday, -28), sunday)
  const week = rows.filter((r) => r.date >= monday)
  const prior = rows.filter((r) => r.date < monday)
  const sum = (xs: SessionRpeRow[]) => xs.reduce((a, r) => a + (r.load ?? 0), 0)
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
export async function athleteSessionRpeAction(store: ConnectedStore, body: Record<string, unknown>): Promise<[unknown, number]> {
  if (!(await tracksV1On(store))) return [{ error: 'not found' }, 404]
  switch (body.action) {
    case 'log':
      return [await logSessionRpe(store, { type: 'athlete', id: store.athleteId }, body), 200]
    case 'list': {
      const today = await athleteToday(store)
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
