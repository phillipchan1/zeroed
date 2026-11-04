// Session RPE (G9) and the Workout screen's dated start, against a real
// schema. Flag off: the MCP tool list, /api/session-rpe, the weekly review and
// /api/session-rx are exactly as before, and nothing is written. Flag on: the
// athlete's one CR-10 tap lands in session_rpe (never in workout.rpe or
// workout.session_rpe), one row per session per day (a second tap updates
// it), each tap one change_log row under standing approval; out-of-range
// ratings, other days and coaches are refused; get_session_rpe is a logged
// coach read behind the health toggle; the weekly review gains session load
// without its call moving; a session-rx request dated today carries today's
// override, an undated one the template. Athletes A and B never see each
// other's rows.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/sessionRpe.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { setCoachHealth } from './readiness.ts'
import { addDays } from './readiness/rules.ts'
import { athleteSessionRpeAction, CR10_LABELS, logSessionRpe, SESSION_RPE_HIDDEN, SESSION_RPE_TOOLS } from './sessionRpe.ts'
import { sessionRpeWord } from '../../src/engine/outsidePlan.ts'
import { makeStore } from './store.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const B_DAY = '88888888-8888-8888-8888-888888888888'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_A2_ID = 'aaaa6666-0000-4000-8000-0000000000a2'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const A_WORKOUT = 'aaaa9999-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachA2: OverrideActor = { type: 'mcp', id: TOKEN_A2_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const appCoach: OverrideActor = { type: 'app_coach', id: 'app_coach' }
const athleteA: OverrideActor = { type: 'athlete', id: A }
const athleteB: OverrideActor = { type: 'athlete', id: B }

const T = await athleteToday(storeA)
const M = addDays(T, -((new Date(`${T}T00:00:00Z`).getUTCDay() + 6) % 7))

await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'second coach', 'hash-a2', 'aaa2')`,
  [TOKEN_A2_ID, A],
)
// Today's A day, logged with set RPEs averaging 8 (workout.rpe is that mean).
await harness.query(
  `INSERT INTO workout (id, routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
   VALUES ($1, $2, NOW(), 8, 55, '{"0":[{"set":1,"weight":200,"reps":5,"rpe":8,"done":true}]}'::jsonb,
           '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy"}]'::jsonb)`,
  [A_WORKOUT, A_DAY],
)
// The phase covers this week whatever today is, for the review's compliance.
await harness.query(`UPDATE phase SET week_start = $1::date, week_end = $2::date WHERE id = '55555555-5555-5555-5555-555555555555'`, [addDays(M, -35), addDays(M, 34)])
// A week-only override for today on A's A day: one exercise added.
await harness.query(
  `INSERT INTO session_override (athlete_id, date, routine_id, ops, expires_on, actor_type, actor_id, approval_ref, preview_id)
   VALUES ($1::uuid, $2::date, $3, $4::jsonb, $2::date, 'athlete', $1::text, 'tap:synthetic', 'sop_synthetic')`,
  [A, T, A_DAY, JSON.stringify([{ op: 'add', exercise: { name: 'Walking Lunge', sets: 3, reps: '10', load: 'moderate' } }])],
)

const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
type Rx = { prescription: { override?: { label: string; exercises: Array<{ name: string }> }; exercises: Array<{ name: string }> } }
const rx = async (athleteId = A, routine = A_DAY, date?: string) => {
  const [out] = await sessionRxForAthlete(sql, athleteId, { routine_id: routine, unit: 'lb', storage_unit: 'lb', ...(date ? { date } : {}) })
  return { out: out as Rx, text: JSON.stringify(out) }
}
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const tap = (body: Record<string, unknown>, store = storeA, actor = athleteA) => logSessionRpe(store, actor, body)
const workoutRow = async () => (await harness.query<{ rpe: string | null; session_rpe: string | null }>(`SELECT rpe::text AS rpe, session_rpe::text AS session_rpe FROM workout WHERE id = $1`, [A_WORKOUT]))[0]

// ---- pure ----------------------------------------------------------------------------------
ok(Object.keys(CR10_LABELS).length === 11 && Object.entries(CR10_LABELS).every(([k, v]) => sessionRpeWord(Number(k)) === v), 'labels: the Worker\'s CR-10 labels match the app\'s tap')

// ---- flag OFF: exactly as before ----------------------------------------------------------------
const offRx = await rx()
const offRxDated = await rx(A, A_DAY, T)
ok(offRxDated.text === offRx.text, 'flag off: a dated session-rx request is the template, byte-identical to an undated one')
ok(!offRx.text.includes('Walking Lunge') && !offRx.text.includes('"override"'), 'flag off: today\'s override is not applied')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list unchanged')
ok((await call('get_session_rpe', { since: T })).includes('Unknown tool'), 'flag off: get_session_rpe is unknown')
const [offRoute, offStatus] = await athleteSessionRpeAction(storeA, { action: 'log', session_id: A_DAY, rating: 5 })
ok(offStatus === 404 && (offRoute as { error?: string }).error === 'not found', 'flag off: /api/session-rpe answers 404')
ok(!(await tap({ session_id: A_DAY, rating: 5 })).ok, 'flag off: a tap is refused')
ok(await count('session_rpe') === 0 && await count('change_log') === 0 && await count('coach_read_log') === 0, 'flag off: nothing written')

// ---- flag ON: the Workout screen's dated start ------------------------------------------------------
await flag(A, true)
const onDated = (await rx(A, A_DAY, T)).out
ok(onDated.prescription.override?.label === 'This week only', 'workout start, flag on: today\'s request carries the week-only override and its badge label')
ok(onDated.prescription.override?.exercises.map((e) => e.name).join() === 'Back Squat,Walking Lunge', 'workout start, flag on: the overridden list is what gets trained')
ok(onDated.prescription.exercises.map((e) => e.name).join() === 'Back Squat,Walking Lunge', 'workout start, flag on: the prescription\'s indexes follow the override')
const onUndated = (await rx()).out
ok(onUndated.prescription.override == null && onUndated.prescription.exercises.map((e) => e.name).join() === 'Back Squat', 'workout start: an undated request is the template (no double-applied ops on re-prescribe)')
ok((await rx(A, A_DAY, addDays(T, 1))).out.prescription.override == null, 'workout start: another date has no override')
const onTools = await zeroedToolsFor(sql, A)
ok(SESSION_RPE_TOOLS.every((t) => onTools.some((x) => x.name === t.name)), 'flag on: get_session_rpe listed')
ok(!onTools.some((t) => /session_rpe/.test(t.name) && t.name !== 'get_session_rpe'), 'flag on: no coach write tool for session RPE')

const review0 = JSON.parse(await call('get_weekly_review', {}, coachA2)) as { call: string; why: string; rule_refs: string[]; session_load: { rated: number; load_au: number } }
ok(review0.session_load?.rated === 0 && review0.session_load.load_au === 0, 'review: no ratings → an empty session_load')

// ---- the tap -------------------------------------------------------------------------------------
const first = await tap({ session_id: A_DAY, rating: 5, duration_min: 60 })
ok(first.ok && first.text === 'Logged.' && first.rating?.rating === 5 && first.rating.load === 300, 'tap: logged, load = rating × minutes')
const [log1] = await harness.query<{ tool: string; actor_type: string; approval_ref: string; target_type: string; diff: { before: unknown; after: { rating: number } } }>(
  `SELECT tool, actor_type, approval_ref, target_type, diff FROM change_log WHERE id = $1`, [first.change_id])
ok(log1?.tool === 'log_session_rpe' && log1.actor_type === 'athlete' && log1.approval_ref === 'standing:logging' && log1.target_type === 'session_rpe', 'tap: one change_log row under standing approval')
ok(log1?.diff.before === null && log1.diff.after.rating === 5, 'tap: the log row records before → after')
const w1 = await workoutRow()
ok(Number(w1.rpe) === 8 && w1.session_rpe === null, 'separate: workout.rpe (set-RPE mean) and workout.session_rpe are untouched')

const second = await tap({ session_id: A_DAY, rating: 7 })
ok(second.ok && second.text === 'Updated.' && await count('session_rpe', 'athlete_id = $1', [A]) === 1, 'one per session per day: a second tap updates, no duplicate')
ok(second.rating?.rating === 7 && second.rating.duration_min === 60 && second.rating.load === 420, 'update: a tap without minutes keeps the logged duration')
const [log2] = await harness.query<{ diff: { before: { rating: number }; after: { rating: number } } }>(`SELECT diff FROM change_log WHERE id = $1`, [second.change_id])
ok(log2?.diff.before.rating === 5 && log2.diff.after.rating === 7, 'update: logged with the old and new rating')
const logsNow = await count('change_log', `tool = 'log_session_rpe'`)
const same = await tap({ session_id: A_DAY, rating: 7 })
ok(same.ok && same.text === 'Already logged.' && await count('change_log', `tool = 'log_session_rpe'`) === logsNow, 'update: the same tap again writes nothing')
const viaRoute = (await athleteSessionRpeAction(storeA, { action: 'log', session_id: A_DAY, rating: 6, duration_min: 50, workout_id: A_WORKOUT }))[0] as { ok: boolean }
ok(viaRoute.ok && await count('session_rpe', 'athlete_id = $1 AND rating = 6 AND workout_id = $2', [A, A_WORKOUT]) === 1, 'route: the app logs through /api/session-rpe, with the workout linked')
const listed = (await athleteSessionRpeAction(storeA, { action: 'list' }))[0] as { ratings: Array<{ session_id: string; rating: number }> }
ok(listed.ratings.length === 1 && listed.ratings[0].rating === 6, 'route: list returns today\'s rating')
const w2 = await workoutRow()
ok(Number(w2.rpe) === 8 && w2.session_rpe === null, 'separate: still never merged into the workout\'s RPEs')

// ---- validation ---------------------------------------------------------------------------------
for (const bad of [-1, 11, 7.5, '7.5', 'hard', null, undefined]) {
  ok(!(await tap({ session_id: A_DAY, rating: bad })).ok, `range: rating ${String(bad)} is refused`)
}
ok((await tap({ session_id: A_DAY, rating: 0, duration_min: 30 })).ok, 'range: 0 (rest) is allowed')
ok((await tap({ session_id: A_DAY, rating: 10 })).ok, 'range: 10 (maximal) is allowed')
for (const bad of [0, 601, 12.5, 'long']) {
  ok(!(await tap({ session_id: A_DAY, rating: 5, duration_min: bad })).ok, `range: duration_min ${String(bad)} is refused`)
}
ok(!(await tap({ session_id: A_DAY, rating: 5, date: addDays(T, -1) })).ok, 'same day: yesterday\'s rating can\'t be logged or changed')
ok(!(await tap({ session_id: A_DAY, rating: 5, date: addDays(T, 1) })).ok, 'same day: nor a future day')
ok(!(await tap({ session_id: A_DAY, rating: 5, date: 'tomorrow' })).ok, 'date must be a date')
ok(!(await tap({ session_id: 'not-a-session', rating: 5 })).ok, 'session_id must be a session')
let dbRange = false
try { await harness.query(`INSERT INTO session_rpe (athlete_id, date, session_id, rating) VALUES ($1, $2::date, $3, 11)`, [A, addDays(T, -2), A_DAY]) } catch { dbRange = true }
ok(dbRange, 'range: the table refuses 11 too')
let dbDup = false
try { await harness.query(`INSERT INTO session_rpe (athlete_id, date, session_id, rating) VALUES ($1, $2::date, $3, 4)`, [A, T, A_DAY]) } catch { dbDup = true }
ok(dbDup, 'one per day: the table refuses a second row for the same session and date')
await tap({ session_id: A_DAY, rating: 6, duration_min: 50 })

// Coaches never write a rating.
ok(!(await tap({ session_id: A_DAY, rating: 2 }, storeA, coachA)).ok, 'writes: an MCP coach can\'t rate the session')
ok(!(await tap({ session_id: A_DAY, rating: 2 }, storeA, appCoach)).ok, 'writes: app_coach can\'t rate the session')
ok((await call('log_session_rpe', { session_id: A_DAY, rating: 2 })).includes('Unknown tool'), 'writes: there is no coach tool for it')

// ---- reads (MCP) ----------------------------------------------------------------------------------
const readsBefore = await count('coach_read_log', `tool = 'get_session_rpe'`)
const seen = JSON.parse(await call('get_session_rpe', { since: addDays(T, -7) }, coachA)) as { sessions: Array<{ rating: number; label: string; duration_min: number; load_au: number; set_rpe_mean: number | null; session: string }>; total_load_au: number }
ok(seen.sessions.length === 1 && seen.sessions[0].rating === 6 && seen.sessions[0].load_au === 300 && seen.sessions[0].session === 'A day', 'read: the coach sees the rating, minutes and load')
ok(seen.sessions[0].label === 'Hard to very hard', 'read: with its CR-10 label')
ok(seen.sessions[0].set_rpe_mean === 8, 'read: the set-RPE mean sits beside it, separate')
ok(await count('coach_read_log', `tool = 'get_session_rpe' AND actor_id = $1`, [TOKEN_A_ID]) === readsBefore + 1, 'read: the coach read is logged')
await call('get_session_rpe', { since: T }, athleteA)
ok(await count('coach_read_log', `tool = 'get_session_rpe'`) === readsBefore + 1, 'read: the athlete\'s own read is not logged')
ok((await call('get_session_rpe', { since: 'last week' }, coachA)).includes('YYYY-MM-DD'), 'read: since must be a date')

// ---- weekly review --------------------------------------------------------------------------------
// The 4 weeks before: one rated session (4 × 50 = 200 AU) → usual 50 AU a week.
await harness.query(`INSERT INTO session_rpe (athlete_id, date, session_id, rating, duration_min) VALUES ($1, $2::date, $3, 4, 50)`, [A, addDays(M, -7), A_DAY])
const writesBeforeReview = await count('change_log')
const review1 = JSON.parse(await call('get_weekly_review', {}, coachA2)) as typeof review0 & { session_load: { rated: number; with_duration: number; rating_avg: number; load_au: number; usual_au: number; vs_usual: number } }
ok(review1.session_load.rated === 1 && review1.session_load.load_au === 300 && review1.session_load.rating_avg === 6, 'review: this week\'s session load (rating × minutes)')
ok(review1.session_load.usual_au === 50 && review1.session_load.vs_usual === 6, 'review: against the 4 weeks before')
ok(review1.call === review0.call && review1.why === review0.why && JSON.stringify(review1.rule_refs) === JSON.stringify(review0.rule_refs), 'review: additive — the call and its why don\'t move')
ok(await count('change_log') === writesBeforeReview, 'review: read-only')

// ---- health toggle (D3) -------------------------------------------------------------------------
ok((await setCoachHealth(storeA, athleteA, TOKEN_A_ID, false)).ok, 'toggle: the athlete turns health data off for one coach')
ok((await call('get_session_rpe', { since: addDays(T, -7) }, coachA)) === SESSION_RPE_HIDDEN, 'health off: get_session_rpe refused for that coach')
const hiddenReview = JSON.parse(await call('get_weekly_review', {}, coachA)) as { session_load: unknown; health_hidden?: boolean }
ok(hiddenReview.session_load === null && hiddenReview.health_hidden === true, 'health off: no session_load in the review')
const hiddenLog = await call('get_change_log', { since: addDays(T, -1), target: 'session_rpe' }, coachA)
ok(hiddenLog.includes('Session effort (not shared with you)') && !hiddenLog.includes('"rating"'), 'health off: session RPE rows in the change log are redacted')
ok((await call('get_change_log', { since: addDays(T, -1), target: 'session_rpe' }, coachA2)).includes('"rating"'), 'health on: the other coach sees whole rows')
ok(JSON.parse(await call('get_session_rpe', { since: addDays(T, -7) }, coachA2)).sessions.length === 1, 'health on for the other coach: it still reads')

// ---- isolation ------------------------------------------------------------------------------------
await flag(B, true)
const bList = (await athleteSessionRpeAction(storeB, { action: 'list', from: addDays(T, -30), to: T }))[0] as { ratings: unknown[] }
ok(bList.ratings.length === 0, 'isolation: B lists none of A\'s ratings')
const bCoach = JSON.parse(await call('get_session_rpe', { since: addDays(T, -30) }, coachB, B)) as { sessions: unknown[] }
ok(bCoach.sessions.length === 0, 'isolation: B\'s coach reads none of A\'s ratings')
ok(!(await tap({ session_id: A_DAY, rating: 3 }, storeB, athleteB)).ok, 'isolation: B can\'t rate A\'s session')
ok(!(await tap({ session_id: B_DAY, rating: 3 })).ok, 'isolation: A can\'t rate B\'s session')
ok(!(await tap({ session_id: A_DAY, rating: 3 }, storeA, athleteB)).ok, 'isolation: B acting on A\'s store is refused')
ok(!(await tap({ session_id: A_DAY, rating: 3, workout_id: '99999999-9999-9999-9999-999999999999' }, storeB, athleteB)).ok, 'isolation: B can\'t link A\'s workout')
const bOwn = await tap({ session_id: B_DAY, rating: 4, duration_min: 40 }, storeB, athleteB)
ok(bOwn.ok && await count('session_rpe', 'athlete_id = $1', [B]) === 1, 'isolation: B rates B\'s own session')
ok((await rx(B, B_DAY, T)).out.prescription.override == null, 'isolation: A\'s override never reaches B')
ok(((await rx(A, B_DAY, T)).out as unknown as { error?: string }).error === 'not found', 'isolation: A can\'t start B\'s session')
const aAfter = JSON.parse(await call('get_session_rpe', { since: addDays(T, -30) }, coachA2)) as { sessions: Array<{ session: string }> }
ok(aAfter.sessions.length === 2 && aAfter.sessions.every((x) => x.session === 'A day'), 'isolation: A\'s coach sees only A\'s two ratings')
ok(await count('change_log', `athlete_id = $1 AND tool = 'log_session_rpe'`, [B]) === 1, 'isolation: B\'s log row is B\'s')

// ---- rollback: flag off again → exactly as before ---------------------------------------------------
await flag(A, false)
ok((await rx(A, A_DAY, T)).text === offRx.text, 'rollback: flag off → the dated start is the template again, byte-identical')
ok((await rx()).text === offRx.text, 'rollback: undated, byte-identical')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'rollback: MCP tool list unchanged')
ok((await call('get_session_rpe', { since: T }, coachA2)).includes('Unknown tool'), 'rollback: get_session_rpe is gone')
ok((await athleteSessionRpeAction(storeA, { action: 'list' }))[1] === 404, 'rollback: /api/session-rpe answers 404')
const rowsKept = await count('session_rpe', 'athlete_id = $1', [A])
ok(rowsKept === 2, 'rollback: the rows stay, ignored')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
