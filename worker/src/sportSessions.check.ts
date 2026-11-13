// log_session_v1 (spec section 13): log a sport or conditioning session, against
// a real schema (PGlite, or throwaway Postgres with ZEROED_TEST_DATABASE_URL).
//
//   flag off   the MCP tool list is exactly as before, log_session /
//              update_session / delete_session are unknown, /api/sport-session
//              is 404, and session load, U7, rule 3, the weekly review and
//              list_workouts read exactly as before for the same fixtures
//              (pre-existing session_rpe taps and check-in pain only).
//   validation required fields, minutes 1–600, session RPE 1–10, YYYY-MM-DD,
//              no future day, nothing before this training week's Monday
//              (Monday through today, athlete's zone; midnight PT edges at
//              fixed instants, MCP log / update and the app route),
//              idempotent client_key.
//   planned    the first log against a planned card that day closes it; a
//              second the same day is external and never touches session_rpe.
//   volume     two same-day basketball logs (25 and 30 min) are both in
//              session_load (25×RPE1 + 30×RPE2); rule 3 maps by activity, not
//              "Outside the plan".
//   U7         a basketball log loads knee / ankle / hip; pain over 5 on it sets
//              the existing temporary block (adult, v1.3) and, the second time
//              in 14 days, the persistent block with the refer-out; a later
//              primer-only session without basketball in its name doesn't end a
//              knee block, a basketball log does.
//   roles      athlete always; propose coach and app_coach under standing
//              approval (app_coach never with approval_ref); read coach never
//              sees or reaches the tools, refusal logged; a coach without the
//              health toggle logs activity / minutes only and never reads RPE
//              or pain.
//   edit/del   change_log (standing:logging) for each; session load recomputed;
//              pain superseded or voided so U7 re-reads; deleting the log that
//              closed a card re-opens it unless another log is linked to it.
// coach_v1 is never turned on. Synthetic athletes A and B; synthetic numbers.
// The clock is pinned to Sunday 15 Nov 2026, noon in Los Angeles (it still
// ticks), so the whole Monday–Sunday week is loggable whatever the box's date.
// Run: node --experimental-strip-types worker/src/sportSessions.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { executeZeroedTool, LOGGING_TOOLS, zeroedToolsFor } from './tools.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { makeStore } from './store.ts'
import { addDays, REFER_OUT, REFER_OUT_TEMPORARY } from './readiness/rules.ts'
import { readinessContextFor, saveCheckin } from './readiness.ts'
import { resolveMethodology } from './methodology.ts'
import { sessionLoadForWeek } from './sessionRpe.ts'
import { loggedPerWeek, perActivityWeekly } from './activities.ts'
import { computeWeeklyReview } from './weeklyReview.ts'
import { loadPain, regionSessions } from './regionStatus.ts'
import { roleRefusal, toolsForRole } from './coachRoles.ts'
import { executeDataQuery } from './data.ts'
import { PAIN_REGIONS } from './methodology/v1.ts'
import { RED_FLAGS } from './readiness/rules.ts'
import {
  athleteSportSessionAction, noonInZone, runSportSessionTool, SPORT_HEALTH_REFUSED, SPORT_SESSION_TOOLS,
} from './sportSessions.ts'
import { SPORT_PAIN_REGIONS, SPORT_RED_FLAGS } from '../../src/engine/sportLog.ts'
import type { ComposeActivity } from './coach/composer.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PHASE_A = '55555555-5555-5555-5555-555555555555'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const THU = 'aaaa1313-0000-4000-8000-000000000001'
const PRIMER = 'aaaa1313-0000-4000-8000-000000000002'
const TOKEN_A = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_READ = 'aaaa1313-0000-4000-8000-0000000000a1'
const TOKEN_NOHEALTH = 'aaaa1313-0000-4000-8000-0000000000a2'
const TOKEN_B = 'bbbb6666-0000-4000-8000-000000000001'

// A log may be dated from this training week's Monday through today, and the
// fixtures go back up to six days, so "now" is a Sunday evening in LA.
const RealDate = Date
const PINNED_AT = RealDate.parse('2026-11-15T20:00:00Z') // Sunday 15 Nov, 12:00 PST
const shift = PINNED_AT - RealDate.now()
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + shift)
    else super(...(args as [number, number]))
  }

  static now(): number {
    return RealDate.now() + shift
  }
}
globalThis.Date = PinnedDate as DateConstructor

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A }
const coachRead: OverrideActor = { type: 'mcp', id: TOKEN_READ }
const coachNoHealth: OverrideActor = { type: 'mcp', id: TOKEN_NOHEALTH }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B }
const appCoach: OverrideActor = { type: 'app_coach', id: 'app_coach' }
const athleteA: OverrideActor = { type: 'athlete', id: A }

const T = await athleteToday(storeA)
const M = addDays(T, -((new Date(`${T}T00:00:00Z`).getUTCDay() + 6) % 7))
ok(T === '2026-11-15' && M === '2026-11-09', `pinned clock: today is Sunday 15 Nov in LA, its week began Monday 9 Nov (${T}, ${M})`)

const q = <R extends Record<string, unknown>>(text: string, params: unknown[] = []) => harness.query<R>(text, params)
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: number }>(text, params))[0]?.n ?? 0)
const setFlag = async (athleteId: string, k: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || jsonb_build_object(${k}::text, true) WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - ${k}::text WHERE id = ${athleteId}`
}
const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const parse = (text: string): Record<string, unknown> => {
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}
const names = async (athleteId: string) => (await zeroedToolsFor(sql, athleteId)).map((t) => t.name)
const SPORT_TOOLS = ['log_session', 'update_session', 'delete_session']

// ---- fixtures ---------------------------------------------------------------------------------
// An adult (v1.3 temporary blocks apply), tracks_v1 on as the athlete has it; coach_v1 stays off.
await q(`UPDATE athlete SET birth_date = '1990-01-01' WHERE id = $1`, [A])
await setFlag(A, 'tracks_v1', true)
await q(`UPDATE phase SET week_start = $1::date, week_end = $2::date WHERE id = $3`, [addDays(M, -35), addDays(M, 34), PHASE_A])
// The planned primer-only basketball day, and a primer with no basketball in its name.
await q(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow) VALUES
   ($1, $3, $4, 'Thu Basketball (conditioning)', 'conditioning',
    '[{"name":"Hip Airplane","sets":2,"reps":"5/side","load":"bodyweight"},{"name":"90/90 Hip IR","sets":2,"reps":"5/side","load":"bodyweight"}]'::jsonb, 'primer', 3),
   ($2, $3, $4, 'Mobility primer', 'mobility',
    '[{"name":"90/90 Hip IR","sets":2,"reps":"5/side","load":"bodyweight"}]'::jsonb, 'primer', 4)`,
  [THU, PRIMER, PROG_A, PHASE_A],
)
await q(`INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'read coach', 'hash-read', 'read'), ($3, $2, 'no-health coach', 'hash-nh', 'nhlt')`, [TOKEN_READ, A, TOKEN_NOHEALTH])
await q(`UPDATE mcp_token SET role = 'read' WHERE id = $1`, [TOKEN_READ])
await q(`UPDATE mcp_token SET share_health = false WHERE id = $1`, [TOKEN_NOHEALTH])
// Pre-existing data: a session RPE tap on today's A day (8 × 55) and a knee 2/10 check-in two days ago.
await q(
  `INSERT INTO session_rpe (athlete_id, date, session_id, rating, duration_min) VALUES ($1, $2::date, $3, 8, 55)`,
  [A, T, A_DAY],
)
const checkin = await saveCheckin(storeA, athleteA, { date: addDays(T, -2), pain: [{ region: 'knee', score: 2 }] })
ok(checkin.ok, 'fixture: the check-in logs')
const activities: ComposeActivity[] = [
  { id: 'act-court', module: 'court', name: 'Basketball', sessions_per_week: 2, season: 'in', days: [3] },
  { id: 'act-run', module: 'endurance', name: 'Running', sessions_per_week: 1, season: 'in', days: [5] },
]
const ruleStart = addDays(T, 1)
const methodology = await resolveMethodology(storeA)

// ---- the region lists the app shows are the check-in's ------------------------------------------
ok(JSON.stringify(SPORT_PAIN_REGIONS) === JSON.stringify(PAIN_REGIONS), 'app pain regions = the check-in\'s (methodology v1 PAIN_REGIONS)')
ok(JSON.stringify(SPORT_RED_FLAGS) === JSON.stringify(RED_FLAGS), 'app red flags = the check-in\'s (readiness RED_FLAGS)')
ok(SPORT_TOOLS.every((n) => LOGGING_TOOLS.has(n)), 'the three tools are LOGGING_TOOLS (standing:logging)')

// ---- flag OFF: exactly as before ----------------------------------------------------------------
const toolsOff = await zeroedToolsFor(sql, A)
ok(!toolsOff.some((t) => SPORT_TOOLS.includes(t.name)), 'flag off: no sport tools listed')
ok((await call('log_session', { activity: 'Basketball', date: T, duration_min: 25, session_rpe: 6, client_key: 'off-1', confirm: true })) === 'Unknown tool: log_session', 'flag off: log_session is unknown')
ok((await call('update_session', { workout_id: A_DAY, duration_min: 5, confirm: true })) === 'Unknown tool: update_session', 'flag off: update_session is unknown')
ok((await call('delete_session', { workout_id: A_DAY, confirm: true })) === 'Unknown tool: delete_session', 'flag off: delete_session is unknown')
ok((await athleteSportSessionAction(storeA, { action: 'list' }))[1] === 404, 'flag off: /api/sport-session is 404')
ok((await athleteSportSessionAction(storeA, { action: 'log', activity: 'Run', date: T, duration_min: 20, session_rpe: 4 }))[1] === 404, 'flag off: the app route writes nothing')
ok(await count(`SELECT count(*)::int AS n FROM workout WHERE kind IS NOT NULL`) === 0, 'flag off: no sport rows written')
const base = {
  load: JSON.stringify(await sessionLoadForWeek(storeA, M)),
  readiness: JSON.stringify(await readinessContextFor(storeA, T, methodology)),
  readinessBefore: JSON.stringify(await readinessContextFor(storeA, addDays(T, -2), methodology)),
  rule3: JSON.stringify(await loggedPerWeek(storeA, activities, ruleStart)),
  review: JSON.stringify(await computeWeeklyReview(storeA, { week: T, showHealth: true })),
  list: await call('list_workouts', { limit: 20 }),
  pain: JSON.stringify(await loadPain(storeA, addDays(T, -7), T)),
}
const baseLoad = JSON.parse(base.load) as { load_au: number; rated: number }
ok(baseLoad.load_au === 8 * 55 && baseLoad.rated === 1, 'flag off: session load is the one tap, 8 × 55')
ok(base.rule3 === '{}', 'flag off: rule 3 sees nothing logged')

// ---- flag ON, nothing logged yet: still identical -------------------------------------------------
await setFlag(A, 'log_session_v1', true)
const toolsOn = await zeroedToolsFor(sql, A)
ok(JSON.stringify(toolsOn.slice(0, toolsOff.length)) === JSON.stringify(toolsOff), 'flag on: every existing tool listed exactly as before')
ok(JSON.stringify(toolsOn.slice(toolsOff.length).map((t) => t.name)) === JSON.stringify(SPORT_TOOLS), 'flag on: the three sport tools appended')
ok(!(await names(B)).some((n) => SPORT_TOOLS.includes(n)), 'flag on for A only: B lists none')
ok(JSON.stringify(await sessionLoadForWeek(storeA, M)) === base.load, 'flag on, no logs: session load identical')
ok(JSON.stringify(await readinessContextFor(storeA, T, methodology)) === base.readiness, 'flag on, no logs: U7 / readiness identical')
ok(JSON.stringify(await loggedPerWeek(storeA, activities, ruleStart)) === base.rule3, 'flag on, no logs: rule 3 identical')
ok(JSON.stringify(await computeWeeklyReview(storeA, { week: T, showHealth: true })) === base.review, 'flag on, no logs: weekly review identical')
ok((await call('list_workouts', { limit: 20 })) === base.list, 'flag on, no logs: list_workouts identical')
ok(JSON.stringify(await loadPain(storeA, addDays(T, -7), T)) === base.pain, 'flag on, no logs: check-in pain reads identical')
const [coachFlags] = await q<{ coach: unknown; arc: unknown }>(`SELECT flags->'coach_v1' AS coach, flags->'arc_load_v1' AS arc FROM athlete WHERE id = $1`, [A])
ok(coachFlags.coach == null && coachFlags.arc == null, 'flag on: coach_v1 and arc_load_v1 are not turned on')

// ---- validation -----------------------------------------------------------------------------------
const good = { activity: 'Basketball', date: T, duration_min: 25, session_rpe: 6, client_key: 'v-0' }
const refused = async (args: Record<string, unknown>, has: RegExp, msg: string) => {
  const out = await call('log_session', { ...good, ...args, confirm: true })
  ok(out.startsWith('Refused') && has.test(out), `${msg} (${out.slice(0, 90)})`)
}
const workoutsBefore = await count(`SELECT count(*)::int AS n FROM workout`)
await refused({ activity: undefined }, /activity is required/, 'validation: activity required')
await refused({ activity: '   ' }, /activity is required/, 'validation: blank activity refused')
await refused({ date: undefined }, /date is required/, 'validation: date required')
await refused({ date: '11/13/2026' }, /YYYY-MM-DD/, 'validation: date format')
await refused({ date: '2026-02-30' }, /YYYY-MM-DD/, 'validation: impossible date')
await refused({ date: addDays(T, 1) }, /future/, 'validation: a future day is refused')
await refused({ date: addDays(M, -1) }, /training week: Monday 2026-11-09/, 'validation: the day before this training week\'s Monday is refused')
await refused({ duration_min: undefined }, /duration_min is required/, 'validation: duration required')
await refused({ duration_min: 0 }, /1–600/, 'validation: 0 minutes refused')
await refused({ duration_min: 601 }, /1–600/, 'validation: 601 minutes refused')
await refused({ duration_min: 25.5 }, /1–600/, 'validation: fractional minutes refused')
await refused({ session_rpe: undefined }, /session_rpe is required/, 'validation: session RPE required (coach with health access)')
await refused({ session_rpe: 0 }, /1–10/, 'validation: session RPE 0 refused')
await refused({ session_rpe: 11 }, /1–10/, 'validation: session RPE 11 refused')
await refused({ session_rpe: 6.5 }, /1–10/, 'validation: fractional session RPE refused')
await refused({ client_key: undefined }, /client_key is required/, 'validation: client_key required on log_session')
await refused({ pain: [{ region: 'kneecap', score: 3 }] }, /unknown pain region/, 'validation: unknown region refused')
await refused({ pain: [{ region: 'knee', score: 11 }] }, /0–10/, 'validation: pain 11 refused')
await refused({ pain: [{ region: 'knee', score: 3, red_flags: ['sore'] }] }, /red flag/, 'validation: unknown red flag refused')
await refused({ pain: [{ region: 'knee', score: 3 }, { region: 'knee', score: 4 }] }, /twice/, 'validation: a region twice refused')
await refused({ session_name: 'No such day' }, /no such planned session/, 'validation: an unknown planned session refused')
ok(await count(`SELECT count(*)::int AS n FROM workout`) === workoutsBefore, 'validation: nothing written by any refusal')
// Edges that pass, as previews (nothing written without confirm=true).
const edge = async (args: Record<string, unknown>, msg: string) => {
  const p = parse(await call('log_session', { ...good, ...args }))
  ok(typeof p.preview_id === 'string', msg)
}
await edge({ date: M }, 'validation: this training week\'s Monday is fine')
await edge({ date: T }, 'validation: today is fine')
await edge({ duration_min: 1 }, 'validation: 1 minute is fine')
await edge({ duration_min: 600 }, 'validation: 600 minutes is fine')
await edge({ session_rpe: 1 }, 'validation: session RPE 1 is fine')
await edge({ session_rpe: 10 }, 'validation: session RPE 10 is fine')
const preview = parse(await call('log_session', { ...good, session_name: 'Thu Basketball' }))
ok(preview.closes_planned === true, 'preview: says it would close the planned card')
ok(await count(`SELECT count(*)::int AS n FROM workout`) === workoutsBefore && await count(`SELECT count(*)::int AS n FROM change_log WHERE tool = 'log_session'`) === 0,
  'preview: writes nothing (no workout, no change_log)')

// ---- two games on the primer-only Thursday: 25 min @6 closes the card, 30 min @7 is external ----------
const first = parse(await call('log_session', { ...good, client_key: 'thu-1', session_name: 'Thu Basketball', confirm: true }))
const firstId = String(first.workout_id ?? '')
ok(first.closed_planned === true && first.session_load === 150, 'first log: closes the planned card; load 25 × 6 = 150')
const [w1] = await q<{ routine_id: string; rpe: unknown; session_rpe: unknown; duration_mins: number; kind: string; activity: string; source: string | null; logged_date: string }>(
  `SELECT routine_id::text AS routine_id, rpe, session_rpe, duration_mins, kind, activity, source, logged_date::text AS logged_date FROM workout WHERE id = $1`, [firstId])
ok(w1?.routine_id === THU && w1.source == null, 'first log: filed under the planned routine')
ok(w1?.rpe == null && Number(w1?.session_rpe) === 6 && w1.duration_mins === 25, 'first log: session RPE in session_rpe, never workout.rpe; minutes in duration_mins')
ok(w1?.kind === 'sport_conditioning' && w1.activity === 'Basketball' && w1.logged_date === T, 'first log: kind, activity, date')
const [cl1] = await q<{ approval_ref: string; actor_type: string; target_type: string }>(`SELECT approval_ref, actor_type, target_type FROM change_log WHERE tool = 'log_session' AND target_id = $1`, [firstId])
ok(cl1?.approval_ref === 'standing:logging' && cl1.actor_type === 'mcp' && cl1.target_type === 'sport_session', 'first log: one change_log row, standing:logging')
const again = parse(await call('log_session', { ...good, client_key: 'thu-1', session_name: 'Thu Basketball', duration_min: 99, confirm: true }))
ok(again.workout_id === firstId && again.reused === true, 'idempotent: the same client_key returns the same workout')
ok(await count(`SELECT count(*)::int AS n FROM workout WHERE client_key = 'thu-1'`) === 1 && await count(`SELECT count(*)::int AS n FROM change_log WHERE tool = 'log_session'`) === 1,
  'idempotent: no second row, no second change_log')
const second = parse(await call('log_session', { ...good, client_key: 'thu-2', duration_min: 30, session_rpe: 7, session_name: 'Thu Basketball', confirm: true }))
const secondId = String(second.workout_id ?? '')
ok(second.closed_planned === false && second.session_load === 210, 'second log the same day: not a second close; load 30 × 7 = 210')
const [w2] = await q<{ status: string; session_type: string; source: string }>(
  `SELECT p.status, r.session_type, w.source FROM workout w JOIN routine r ON r.id = w.routine_id JOIN program p ON p.id = r.program_id WHERE w.id = $1`, [secondId])
ok(w2?.status === 'external' && w2.session_type === 'external' && w2.source === 'external', 'second log: on the external program (session_type external)')
ok(await count(`SELECT count(*)::int AS n FROM session_rpe WHERE athlete_id = $1`, [A]) === 1, 'no session_rpe row written: two same-day logs never meet its unique key')
ok(await count(`SELECT count(*)::int AS n FROM workout WHERE routine_id = $1 AND voided_at IS NULL`, [THU]) === 1, 'the planned card has exactly one log (the first)')

// ---- volume ----------------------------------------------------------------------------------------
const loadOn = await sessionLoadForWeek(storeA, M)
ok(loadOn.load_au === 8 * 55 + 25 * 6 + 30 * 7, `session_load: the tap + 25×6 + 30×7 (${loadOn.load_au})`)
ok(loadOn.rated === 3, 'session_load: both logs counted as rated sessions')
const reviewOn = await computeWeeklyReview(storeA, { week: T, showHealth: true }) as { session_load: { load_au: number } | null }
ok(reviewOn.session_load?.load_au === 8 * 55 + 150 + 210, 'weekly review session_load includes both basketball logs')
const baseCompliance = (JSON.parse(base.review) as { compliance: { logged: number } }).compliance.logged
ok((reviewOn as unknown as { compliance: { logged: number } }).compliance.logged === baseCompliance + 1,
  'U15 compliance: the log that closed the card counts; the second (external) game fills no planned slot')
const rule3 = await loggedPerWeek(storeA, activities, ruleStart)
ok(rule3['act-court'] === 1 && rule3['act-run'] == null, 'rule 3: two basketball logs in two weeks = 1 a week on the court activity (by activity, not routine name)')
ok(JSON.stringify(perActivityWeekly([{ name: 'Outside the plan', n: 2 }], activities)) === '{}', 'rule 3: the sentinel "Outside the plan" maps to nothing')
ok(perActivityWeekly([{ name: 'Basketball', n: 2 }], activities)['act-court'] === 1, 'rule 3: "Basketball" maps to the court module')
const listOn = await call('list_workouts', { limit: 20 })
ok(listOn.includes('Sport / conditioning log') && listOn.includes('session RPE 6') && listOn.includes('load 150 AU') && listOn.includes('closed planned "Thu Basketball (conditioning)"'),
  'list_workouts (flag on): activity, minutes, session RPE, load and planned link')
ok(listOn.includes('off-plan (external)') && listOn.includes('load 210 AU'), 'list_workouts: the external log too')
ok((await call('get_workout', { workout_id: secondId })).includes('session RPE 7'), 'get_workout: the sport log with its session RPE')
ok((await call('list_workouts', { limit: 20 }, coachB, B)).includes('Sport') === false, 'B never sees A\'s logs')
ok((await call('update_session', { workout_id: firstId, duration_min: 5, confirm: true }, coachB, B)) === 'Unknown tool: update_session', 'B (flag off) cannot reach the tools')
ok((await athleteSportSessionAction(storeB, { action: 'list' }))[1] === 404, 'B (flag off): the route is 404 for B')

// ---- U7: basketball loads knee / ankle / hip ------------------------------------------------------
const loads = await regionSessions(storeA, T, T, ['knee', 'ankle', 'hip', 'shoulder', 'elbow'])
ok(loads.length >= 2 && loads.every((s) => s.regions.includes('knee') && s.regions.includes('ankle') && s.regions.includes('hip') && !s.regions.includes('shoulder')),
  'a basketball log (planned or external) loads knee, ankle and hip, nothing else')

// Knee 7 on a basketball log three days ago: an adult's first > 5 is the temporary block (v1.3).
const D3 = addDays(T, -3)
const D2 = addDays(T, -2)
const D1 = addDays(T, -1)
const hurt = parse(await call('log_session', { activity: 'Basketball', date: D3, duration_min: 40, session_rpe: 7, pain: [{ region: 'knee', score: 7 }], client_key: 'hurt-1', confirm: true }))
const hurtId = String(hurt.workout_id ?? '')
const u7 = hurt.u7 as { temporary_blocks?: Array<{ region: string }>; refer_out?: string | null } | undefined
ok(u7?.temporary_blocks?.some((b) => b.region === 'knee') === true && u7?.refer_out === REFER_OUT_TEMPORARY, 'pain 7 on a log: the existing temporary block and its refer-out notice')
ok(String(hurt.result ?? '').includes(REFER_OUT_TEMPORARY), 'log_session result says it')
ok(await count(`SELECT count(*)::int AS n FROM pain_report WHERE workout_id = $1 AND region = 'knee' AND score = 7 AND date = $2::date`, [hurtId, D3]) === 1, 'the pain is a pain_report for that date and region, naming its log')
ok((await readinessContextFor(storeA, D3, methodology)).blocked.includes('knee'), 'U7: knee blocked the day of the report')
// A primer-only session the next day (no basketball in its name) doesn't end it.
await q(`INSERT INTO workout (routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
         VALUES ($1, $2::timestamptz, NULL, 10, '{"0":[{"set":1,"weight":null,"reps":5,"rpe":null,"done":true}]}'::jsonb,
                 '[{"name":"90/90 Hip IR","sets":2,"reps":"5/side","load":"bodyweight"}]'::jsonb)`, [PRIMER, noonInZone(D2, 'America/Los_Angeles')])
ok((await readinessContextFor(storeA, D1, methodology)).temporary.some((t) => t.region === 'knee'), 'U7: a primer-only session without basketball in its name does not consume the knee block')
// A basketball log the next day does.
const ends = parse(await call('log_session', { activity: 'Basketball', date: D2, duration_min: 20, session_rpe: 5, client_key: 'ends-1', confirm: true }))
ok(typeof ends.workout_id === 'string', 'the next-day basketball log lands')
ok(!(await readinessContextFor(storeA, D1, methodology)).blocked.includes('knee'), 'U7: the basketball log is the session that ends the temporary knee block')
// > 5 twice in 14 days: the persistent block and the refer-out.
const hurt2 = parse(await call('log_session', { activity: 'Basketball', date: D1, duration_min: 30, session_rpe: 8, pain: [{ region: 'knee', score: 8 }], client_key: 'hurt-2', confirm: true }))
const u7b = hurt2.u7 as { refer_out?: string | null; moved?: Array<{ region: string; to: string }> } | undefined
ok(u7b?.refer_out === REFER_OUT && u7b.moved?.some((m) => m.region === 'knee' && m.to === 'blocked') === true, 'pain > 5 twice in 14 days on a log: the existing persistent block and refer-out')
ok(await count(`SELECT count(*)::int AS n FROM region_status WHERE athlete_id = $1 AND region = 'knee' AND status = 'blocked'`, [A]) === 1, 'region_status: knee blocked, by the log\'s report')
// A red flag on a log follows 11b like the check-in's.
const flagged = parse(await call('log_session', { activity: 'Run', date: D1, duration_min: 30, session_rpe: 5, pain: [{ region: 'ankle', score: 3, red_flags: ['swelling'] }], client_key: 'flag-1', confirm: true }))
ok((flagged.u7 as { refer_out?: string } | undefined)?.refer_out === REFER_OUT, 'a red flag on a log: blocked with the refer-out')

// ---- roles and health ----------------------------------------------------------------------------
ok(!toolsForRole(toolsOn, 'read').some((t) => SPORT_TOOLS.includes(t.name)), 'read coach: the tools are not listed')
const readLogsBefore = await count(`SELECT count(*)::int AS n FROM coach_read_log WHERE actor_id = $1 AND scope->>'refused' = 'role:read'`, [TOKEN_READ])
const readOut = await call('log_session', { ...good, client_key: 'read-1', confirm: true }, coachRead)
ok(readOut === roleRefusal('log_session'), 'read coach: log_session refused')
ok(await count(`SELECT count(*)::int AS n FROM coach_read_log WHERE actor_id = $1 AND tool = 'log_session' AND scope->>'refused' = 'role:read'`, [TOKEN_READ]) === readLogsBefore + 1, 'read coach: the refusal is in coach_read_log')
ok((await call('delete_session', { workout_id: firstId, confirm: true }, coachRead)) === roleRefusal('delete_session'), 'read coach: delete_session refused')
ok(await count(`SELECT count(*)::int AS n FROM workout WHERE client_key = 'read-1'`) === 0, 'read coach: nothing written')

const nhRpe = await call('log_session', { ...good, client_key: 'nh-1', confirm: true }, coachNoHealth)
ok(nhRpe === SPORT_HEALTH_REFUSED, 'health toggle off: a coach cannot write session RPE')
const nhPain = await call('log_session', { activity: 'Run', date: T, duration_min: 30, pain: [{ region: 'knee', score: 2 }], client_key: 'nh-2', confirm: true }, coachNoHealth)
ok(nhPain === SPORT_HEALTH_REFUSED, 'health toggle off: a coach cannot write pain')
const nh = parse(await call('log_session', { activity: 'Run', date: T, duration_min: 30, client_key: 'nh-3', confirm: true }, coachNoHealth))
const nhLog = nh.log as Record<string, unknown> | undefined
ok(typeof nh.workout_id === 'string' && !('session_load' in nh) && !('u7' in nh) && nhLog?.session_rpe === undefined && nhLog?.health === 'not shared with you',
  'health toggle off: logs activity and minutes; the answer carries no RPE, load or U7')
const [nhRow] = await q<{ session_rpe: unknown }>(`SELECT session_rpe FROM workout WHERE id = $1`, [String(nh.workout_id)])
ok(nhRow?.session_rpe == null, 'health toggle off: no session RPE stored')
const nhList = await call('list_workouts', { limit: 20 }, coachNoHealth)
ok(nhList.includes('session RPE and pain not shared with you') && !nhList.includes('session RPE 6') && !nhList.includes('knee 7/10'), 'health toggle off: list_workouts shows no session RPE or pain')
ok((await call('update_session', { workout_id: firstId, session_rpe: 9, confirm: true }, coachNoHealth)) === SPORT_HEALTH_REFUSED, 'health toggle off: cannot change session RPE')
ok((await call('update_session', { workout_id: firstId, pain: [], confirm: true }, coachNoHealth)) === SPORT_HEALTH_REFUSED, 'health toggle off: cannot change pain')
const changeLogNh = await call('get_change_log', { since: addDays(T, -10) }, coachNoHealth)
ok(!changeLogNh.includes('"session_rpe": 6') && changeLogNh.includes('Sport / conditioning log (effort and pain not shared with you)'), 'health toggle off: the change log hides a log\'s effort and pain')

const appRef = await call('log_session', { ...good, client_key: 'app-1', approval_ref: 'tap:00000000-0000-4000-8000-000000000000', confirm: true }, appCoach)
ok(appRef.startsWith('Refused: app_coach cannot supply approval_ref'), 'app_coach: cannot supply approval_ref (D4)')
const app = parse(await call('log_session', { ...good, activity: 'Ride', client_key: 'app-2', confirm: true }, appCoach))
ok(typeof app.workout_id === 'string', 'app_coach: logs under standing approval (propose-equivalent)')
const [appCl] = await q<{ approval_ref: string; actor_type: string }>(`SELECT approval_ref, actor_type FROM change_log WHERE tool = 'log_session' AND target_id = $1`, [String(app.workout_id)])
ok(appCl?.approval_ref === 'standing:logging' && appCl.actor_type === 'app_coach', 'app_coach: change_log is standing:logging, never its own approval_ref')

// The athlete, through the app's route.
const own = await athleteSportSessionAction(storeA, {
  action: 'log', client_key: 'app-route-1', logged_at: new Date().toISOString(), activity: 'Class', date: D1, duration_min: 45, session_rpe: 5, notes: 'spin',
})
const ownBody = own[0] as { ok?: boolean; log?: { workout_id: string; session_load: number; notes: string } }
ok(own[1] === 200 && ownBody.ok === true && ownBody.log?.session_load === 225 && ownBody.log.notes === 'spin', 'athlete (app route): logs their own session')
const listed = (await athleteSportSessionAction(storeA, { action: 'list', from: addDays(T, -6), to: T }))[0] as { logs: Array<{ workout_id: string }> }
ok(listed.logs.some((l) => l.workout_id === ownBody.log?.workout_id) && listed.logs.some((l) => l.workout_id === firstId), 'app route: list returns the athlete\'s logs')
const futureOwn = (await athleteSportSessionAction(storeA, { action: 'log', client_key: 'app-route-2', activity: 'Class', date: addDays(T, 1), duration_min: 45, session_rpe: 5 }))[0] as { ok: boolean; text: string }
ok(futureOwn.ok === false && /future/.test(futureOwn.text), 'app route: a future day is refused')

// ---- update ----------------------------------------------------------------------------------------
const upPrev = parse(await call('update_session', { workout_id: firstId, duration_min: 35 }))
ok(typeof upPrev.preview_id === 'string' && (await q<{ d: number }>(`SELECT duration_mins AS d FROM workout WHERE id = $1`, [firstId]))[0]?.d === 25, 'update: preview without confirm changes nothing')
for (const [args, why] of [
  [{ duration_min: 0 }, /1–600/], [{ session_rpe: 11 }, /1–10/], [{ date: addDays(T, 1) }, /future/], [{ date: addDays(M, -1) }, /training week/],
  [{ activity: '' }, /activity is required/], [{ session_rpe: null }, /can't be cleared/], [{}, /nothing to change/],
] as Array<[Record<string, unknown>, RegExp]>) {
  const out = await call('update_session', { workout_id: firstId, ...args, confirm: true })
  ok(out.startsWith('Refused') && why.test(out), `update: refused ${JSON.stringify(args)} (${out.slice(0, 80)})`)
}
ok((await call('update_session', { duration_min: 35, confirm: true })).includes('workout_id or client_key is required'), 'update: needs workout_id or client_key')
const loadBeforeUp = (await sessionLoadForWeek(storeA, M)).load_au
const up = parse(await call('update_session', { client_key: 'thu-1', duration_min: 35, notes: 'second half hurt', confirm: true }))
ok(up.session_load === 35 * 6, 'update by client_key: session load recomputed (35 × 6)')
ok(await count(`SELECT count(*)::int AS n FROM change_log WHERE tool = 'update_session' AND target_id = $1 AND approval_ref = 'standing:logging'`, [firstId]) === 1, 'update: one change_log row, standing:logging')
ok((await sessionLoadForWeek(storeA, M)).load_au === loadBeforeUp + (35 - 25) * 6, 'update: weekly session load recomputed (+10 min × 6)')
// Pain edit: the knee 7 becomes 2 — the old report is superseded and U7 re-reads (the temporary block is gone).
const painUp = parse(await call('update_session', { workout_id: hurtId, pain: [{ region: 'knee', score: 2 }], confirm: true }))
ok(typeof painUp.workout_id === 'string', 'update: pain changed')
const d3Pain = (await loadPain(storeA, D3, D3)).filter((p) => p.region === 'knee')
ok(d3Pain.length === 1 && d3Pain[0].score === 2, 'update: the log\'s pain_report for that date reads 2 now (the 7 is superseded)')
ok(!(await readinessContextFor(storeA, D3, methodology)).temporary.some((t) => t.region === 'knee'), 'update: U7 re-evaluates — no temporary knee block from the superseded 7')
ok(await count(`SELECT count(*)::int AS n FROM pain_report WHERE workout_id = $1`, [hurtId]) === 2, 'update: pain_report stays append-only (the old row is kept, not counted)')
// Clearing the pain ([]) leaves none of the log's reports standing.
const hurt2Id = String(hurt2.workout_id ?? '')
ok((await loadPain(storeA, D1, D1)).some((p) => p.region === 'knee' && p.score === 8), 'before the edit: the knee 8 counts')
await call('update_session', { workout_id: hurt2Id, pain: [], confirm: true })
ok(!(await loadPain(storeA, D1, D1)).some((p) => p.region === 'knee'), 'update pain to []: the log\'s knee report is voided for U7')
ok((await q<{ pain: unknown }>(`SELECT pain FROM workout WHERE id = $1`, [hurt2Id]))[0]?.pain != null, 'update pain to []: the log keeps an (empty) pain list')

// ---- delete ----------------------------------------------------------------------------------------
const delPrev = parse(await call('delete_session', { workout_id: hurtId }))
ok(typeof delPrev.preview_id === 'string' && (await q<{ v: string | null }>(`SELECT voided_at::text AS v FROM workout WHERE id = $1`, [hurtId]))[0]?.v == null, 'delete: preview without confirm deletes nothing')
const del = parse(await call('delete_session', { workout_id: hurtId, confirm: true }))
ok(del.reopened_planned === false, 'delete: an external log re-opens nothing')
ok(await count(`SELECT count(*)::int AS n FROM workout WHERE id = $1`, [hurtId]) === 1, 'delete: the row is kept (voided, never DELETEd)')
ok((await loadPain(storeA, D3, D3)).every((p) => p.region !== 'knee'), 'delete: its pain reports no longer count')
ok(await count(`SELECT count(*)::int AS n FROM change_log WHERE tool = 'delete_session' AND target_id = $1 AND approval_ref = 'standing:logging'`, [hurtId]) === 1, 'delete: one change_log row, standing:logging')
ok((await call('delete_session', { workout_id: hurtId, confirm: true })).includes('Already deleted'), 'delete: twice is "Already deleted"')
ok((await call('update_session', { workout_id: hurtId, duration_min: 10, confirm: true })).includes('was deleted'), 'delete: a deleted log can\'t be changed')
ok((await call('get_workout', { workout_id: hurtId })).includes('has been deleted'), 'delete: get_workout says it was deleted')
ok(!(await call('list_workouts', { limit: 30 })).includes(hurtId), 'delete: list_workouts no longer shows it')
// The log that closed Thursday's card: deleting it re-opens the card (the second game is external, not linked).
const loadBeforeDel = (await sessionLoadForWeek(storeA, M)).load_au
const delFirst = parse(await call('delete_session', { client_key: 'thu-1', confirm: true }))
ok(delFirst.reopened_planned === true, 'delete: the log that closed the planned card re-opens it')
ok((await sessionLoadForWeek(storeA, M)).load_au === loadBeforeDel - 35 * 6, 'delete: weekly session load drops by its load')
const appRead = await executeDataQuery(sql, { userId: USER_A, athleteId: A }, { table: 'workout', op: 'select', columns: 'id, routine_id', filters: [{ column: 'routine_id', op: 'eq', value: THU }] })
ok(Array.isArray(appRead.data) && appRead.data.length === 0, 'delete: the app\'s /api/data reads no workout on the card (week ring re-opens)')
// Not re-opened while another log is linked: a card already done (primer) that day keeps it.
const D4 = addDays(T, -4)
const linked = parse(await call('log_session', { activity: 'Basketball', date: D4, duration_min: 25, session_rpe: 6, session_id: THU, client_key: 'd4-1', confirm: true }))
ok(linked.closed_planned === true, 'a log by session_id closes the card that day')
await q(`INSERT INTO workout (routine_id, performed_at, duration_mins, actual_weights, exercises_snapshot)
         VALUES ($1, $2::timestamptz, 10, '{}'::jsonb, '[{"name":"Hip Airplane","sets":2,"reps":"5/side"}]'::jsonb)`, [THU, noonInZone(D4, 'America/Los_Angeles')])
const delLinked = parse(await call('delete_session', { workout_id: String(linked.workout_id), confirm: true }))
ok(delLinked.reopened_planned === false, 'delete: the card stays closed while another log is linked to it that day')
const D5 = addDays(T, -5)
await q(`INSERT INTO workout (routine_id, performed_at, duration_mins, actual_weights, exercises_snapshot)
         VALUES ($1, $2::timestamptz, 10, '{}'::jsonb, '[{"name":"Hip Airplane","sets":2,"reps":"5/side"}]'::jsonb)`, [THU, noonInZone(D5, 'America/Los_Angeles')])
const afterPrimer = parse(await call('log_session', { activity: 'Basketball', date: D5, duration_min: 25, session_rpe: 6, session_id: THU, client_key: 'd5-1', confirm: true }))
ok(afterPrimer.closed_planned === false, 'a log on a day the card is already logged (primer done) goes external, never a second fill')

// ---- the window is this training week, Monday through today, in LA (fixed instants) -------------------
const FRI_NOON = new Date('2026-11-13T20:00:00Z') // Friday 13 Nov, 12:00 PST
const SUN_LATE = new Date('2026-11-16T07:30:00Z') // Sunday 15 Nov, 23:30 PST (Monday in UTC)
const MON_EARLY = new Date('2026-11-16T08:30:00Z') // Monday 16 Nov, 00:30 PST
const logAt = async (now: Date, date: string) => runSportSessionTool(storeA, 'log_session', { ...good, date, client_key: `wk-${date}` }, coachA, now)
const accepts = async (now: Date, date: string, msg: string) => ok(typeof parse(await logAt(now, date)).preview_id === 'string', msg)
const refuses = async (now: Date, date: string, why: RegExp, msg: string) => {
  const out = await logAt(now, date)
  ok(out.startsWith('Refused') && why.test(out), `${msg} (${out.slice(0, 90)})`)
}
const windowBefore = await count(`SELECT count(*)::int AS n FROM workout`)
await accepts(FRI_NOON, '2026-11-09', 'window (MCP log, Friday): Monday the week began is fine')
await accepts(FRI_NOON, '2026-11-13', 'window (MCP log, Friday): today is fine')
await refuses(FRI_NOON, '2026-11-08', /training week: Monday 2026-11-09/, 'window (MCP log, Friday): the Sunday before is refused')
await refuses(FRI_NOON, '2026-11-14', /future/, 'window (MCP log, Friday): Saturday of the same week is the future, refused')
await refuses(FRI_NOON, '2026-11-15', /future/, 'window (MCP log, Friday): Sunday of the same week is the future, refused')
await accepts(SUN_LATE, '2026-11-15', 'midnight (MCP log): Sunday 23:30 PT is still Sunday')
await accepts(SUN_LATE, '2026-11-09', 'midnight (MCP log): Sunday 23:30 PT is still the week of Monday 9 Nov')
await refuses(SUN_LATE, '2026-11-16', /future/, 'midnight (MCP log): at Sunday 23:30 PT, Monday (UTC\'s date) is the future')
await accepts(MON_EARLY, '2026-11-16', 'midnight (MCP log): Monday 00:30 PT is Monday')
await refuses(MON_EARLY, '2026-11-15', /training week: Monday 2026-11-16/, 'midnight (MCP log): at Monday 00:30 PT the Sunday just gone is before the week start')
// update can move a log's date: same window.
const moveAt = async (now: Date, date: string) => runSportSessionTool(storeA, 'update_session', { workout_id: secondId, date }, coachA, now)
ok(typeof parse(await moveAt(FRI_NOON, '2026-11-09')).preview_id === 'string', 'window (MCP update, Friday): moving to Monday the week began is fine')
ok(/^Refused.*training week/.test(await moveAt(FRI_NOON, '2026-11-08')), 'window (MCP update, Friday): moving to the Sunday before is refused')
ok(/^Refused.*future/.test(await moveAt(FRI_NOON, '2026-11-14')), 'window (MCP update, Friday): moving to Saturday of the same week is refused')
ok(typeof parse(await moveAt(SUN_LATE, '2026-11-09')).preview_id === 'string' && /^Refused.*future/.test(await moveAt(SUN_LATE, '2026-11-16')), 'midnight (MCP update): Sunday 23:30 PT is still the week of Monday 9 Nov; Monday 16 is the future')
ok(/^Refused.*training week/.test(await moveAt(MON_EARLY, '2026-11-15')), 'midnight (MCP update): Monday 00:30 PT, moving to the Sunday just gone is refused')
ok(await count(`SELECT count(*)::int AS n FROM workout`) === windowBefore, 'window: previews and refusals wrote nothing')
// The app route, with the queued log's own clock.
const route = async (now: Date, body: Record<string, unknown>) => (await athleteSportSessionAction(storeA, { action: 'log', activity: 'Run', duration_min: 30, session_rpe: 4, ...body }, now))[0] as { ok: boolean; text: string }
const rFri = await route(FRI_NOON, { client_key: 'wk-r1', date: '2026-11-08', logged_at: FRI_NOON.toISOString() })
ok(rFri.ok === false && /training week/.test(rFri.text), 'window (app route, Friday): the Sunday before is refused')
const rSat = await route(FRI_NOON, { client_key: 'wk-r2', date: '2026-11-14', logged_at: FRI_NOON.toISOString() })
ok(rSat.ok === false && /future/.test(rSat.text), 'window (app route, Friday): Saturday of the same week is refused')
const rCarried = await route(MON_EARLY, { client_key: 'wk-r3', date: '2026-11-15', logged_at: SUN_LATE.toISOString() })
ok(rCarried.ok === false && /training week: Monday 2026-11-16/.test(rCarried.text), 'midnight (app route): queued Sunday 23:30 PT, synced Monday 00:30 PT — Sunday is last week, refused')
ok(await count(`SELECT count(*)::int AS n FROM workout`) === windowBefore, 'window (app route): refusals wrote nothing')
const rMon = await route(MON_EARLY, { client_key: 'wk-r4', date: '2026-11-16', logged_at: new Date('2026-11-16T08:10:00Z').toISOString() })
ok(rMon.ok === true, 'midnight (app route): queued Monday 00:10 PT, synced 00:30 PT — Monday is fine')
const rMonday = await route(new Date(), { client_key: 'wk-r5', date: M, logged_at: new Date().toISOString() })
ok(rMonday.ok === true, 'window (app route, Sunday): Monday the week began is fine')

// ---- flag OFF again: the tools, route and volume are as before ----------------------------------------
await setFlag(A, 'log_session_v1', false)
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(toolsOff), 'flag off again: tool list exactly as before')
ok((await call('log_session', { ...good, client_key: 'off-2', confirm: true })) === 'Unknown tool: log_session', 'flag off again: log_session unknown')
ok((await athleteSportSessionAction(storeA, { action: 'list' }))[1] === 404, 'flag off again: route 404')
ok(JSON.stringify(await sessionLoadForWeek(storeA, M)) === base.load, 'flag off again: session load reads exactly as before (taps only)')
ok(JSON.stringify(await loggedPerWeek(storeA, activities, ruleStart)) === base.rule3, 'flag off again: rule 3 reads exactly as before (routine names)')
ok(!(await call('list_workouts', { limit: 30 })).includes('Sport / conditioning log'), 'flag off again: list_workouts adds no sport lines')
const [endFlags] = await q<{ coach: unknown }>(`SELECT flags->'coach_v1' AS coach FROM athlete WHERE id = $1`, [A])
ok(endFlags.coach == null, 'coach_v1 was never turned on')
ok(SPORT_SESSION_TOOLS.length === 3, 'three tools')

await harness.close()
console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('sport sessions: ok')
