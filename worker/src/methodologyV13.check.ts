// Methodology v1.3 (spec section 11c, the S&C review of 11b): U7 "next
// session" is region-specific, and a rising pain trend that never blocks is a
// weekly-review coach flag.
//
//   U7  a > 5 still blocks that region for the day and the next logged
//       session that LOADS it. Knee, ankle, hip: squats, lunges, jumps, cuts
//       or basketball. Other regions: an exercise tagged to the region
//       (methodology/classify.ts); an untagged region never falls back to
//       "any session". Either way the block lapses after 14 inclusive days.
//   U15 a rating rising across 3 sessions that never blocks (2 → 3 → 4) is a
//       coach flag in the weekly review: no refer-out, no block. Rising on a
//       region that does block still makes that block persistent (11b).
//   Flag off: unchanged. A and B never mix.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/methodologyV13.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { athleteReadinessAction, saveCheckin } from './readiness.ts'
import { addDays, evaluateRegion, REFER_OUT, REFER_OUT_TEMPORARY, type PainEntry } from './readiness/rules.ts'
import { sessionLoadsRegion } from './methodology/classify.ts'
import { resolveParams } from './methodology/resolve.ts'
import { CURRENT_METHODOLOGY, METHODOLOGIES, METHODOLOGY_V1_2, METHODOLOGY_V1_3 } from './methodology/v1.ts'
import { computeWeeklyReview, risingPainFlags, type WeeklyReviewView } from './weeklyReview.ts'
import { makeStore } from './store.ts'
import type { SessionPrescription } from '../../src/engine/sessionRxCompute.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ---- pure: versions -------------------------------------------------------------------------------
ok(CURRENT_METHODOLOGY === METHODOLOGY_V1_3 && CURRENT_METHODOLOGY.version === 'v1.3', 'versions: v1.3 is current')
ok(METHODOLOGIES['v1.2'] === METHODOLOGY_V1_2 && METHODOLOGY_V1_2.params.U7.temporary_ends_on === undefined && METHODOLOGY_V1_2.params.U15.rising_pain_flag_sessions === undefined, 'versions: v1.2 still resolves, without the v1.3 keys')
const strip13 = (m: typeof METHODOLOGY_V1_3) => {
  const p = JSON.parse(JSON.stringify(m.params)) as Record<string, Record<string, unknown>>
  delete p.U7.temporary_ends_on
  delete p.U15.rising_pain_flag_sessions
  return JSON.stringify({ params: p, minors: m.minors, ttl: m.preview_ttl_hours })
}
ok(strip13(METHODOLOGY_V1_3) === JSON.stringify({ params: METHODOLOGY_V1_2.params, minors: METHODOLOGY_V1_2.minors, ttl: METHODOLOGY_V1_2.preview_ttl_hours }), 'v1.3: only the two 11c keys moved; everything else is v1.2')
const kid = resolveParams(METHODOLOGY_V1_3, [], { minor: true })
ok(kid.params.U7.temporary_blocks === false && kid.version.startsWith('v1.3+'), 'minors: still no temporary blocks under v1.3 (every block persists)')

// ---- pure: what loads a region ---------------------------------------------------------------------
const s = (...names: string[]) => ({ exercises: names.map((name) => ({ name, sets: 3, reps: '5', load: 'moderate' })) })
const LOWER = ['knee', 'ankle', 'hip']
for (const [what, session] of [
  ['squats', s('Back Squat')], ['lunges', s('Walking Lunge')], ['jumps', s('Box Jump')], ['jumps (a bound)', s('Lateral Bound')],
  ['cuts', s('Cone cuts')], ['basketball', s('Basketball')], ['a session named basketball', { name: 'Pickup basketball', exercises: [] }],
] as const) {
  ok(LOWER.every((r) => sessionLoadsRegion(session, r)), `loads knee/ankle/hip: ${what}`)
}
const upper = s('Bench Press', 'Dumbbell Row', 'Lateral Raise', 'Tricep Pushdown')
ok(LOWER.every((r) => !sessionLoadsRegion(upper, r)), 'loads knee/ankle/hip: an upper-body session doesn\'t')
ok(!sessionLoadsRegion(s('Leg Extension'), 'knee') && !sessionLoadsRegion(s('Deadlift'), 'hip'), 'knee/ankle/hip: only the five named kinds count (no invented map)')
ok(sessionLoadsRegion(upper, 'elbow') && sessionLoadsRegion(upper, 'shoulder') && !sessionLoadsRegion(s('Back Squat'), 'elbow'), 'other regions: an exercise tagged to it (classify.ts)')
const everything = s('Back Squat', 'Walking Lunge', 'Box Jump', 'Basketball', 'Bench Press', 'Deadlift', 'Calf Raise')
ok(!sessionLoadsRegion(everything, 'foot') && !sessionLoadsRegion(everything, 'shin'), 'untagged regions (foot, shin): nothing loads them, no fallback to any session')

// ---- pure: U7 call and the coach flag ---------------------------------------------------------------
const D = '2030-06-20'
const pe = (score: number, date = D, region = 'shoulder'): PainEntry => ({ date, region, score, red_flags: [] })
const U7 = METHODOLOGY_V1_3.params.U7
const ev = (today: PainEntry, history: PainEntry[], yesterday: PainEntry | null = null) => evaluateRegion({ today, yesterday, params: U7, raised: false, adult: true, history })
const trend = [pe(2, addDays(D, -4)), pe(3, addDays(D, -2)), pe(4)]
const trendCall = ev(trend[2], trend.slice(0, 2))
ok(trendCall.status !== 'blocked' && !trendCall.refer_out && trendCall.block === undefined, 'U7 2 → 3 → 4, none over 5: no block, no refer-out')
ok(ev(pe(6), [pe(2, addDays(D, -4)), pe(4, addDays(D, -2))]).block === 'persistent', 'U7 rising onto a block (2 → 4 → 6): still persistent (11b)')
ok(ev(pe(6), []).reason.includes('next session that loads the shoulder'), 'U7 v1.3: the reason names the region-loading session')
const blocks = (p: PainEntry) => ev(p, trend.filter((x) => x.date < p.date)).status === 'blocked'
const flags = risingPainFlags(trend, { from: addDays(D, -3), to: addDays(D, 3) }, { sessions: 3, withinDays: 14, blocks })
ok(flags.length === 1 && flags[0].region === 'shoulder' && flags[0].scores.join() === '2,3,4' && flags[0].rule_refs.includes('U15'), 'coach flag: 2 → 3 → 4 flagged, U15')
ok(!/clinician|refer/i.test(flags[0].text), 'coach flag: no refer-out in it')
ok(risingPainFlags([pe(2, addDays(D, -20)), pe(3, addDays(D, -2)), pe(4)], { from: addDays(D, -3), to: D }, { sessions: 3, withinDays: 14, blocks: () => false }).length === 0, 'coach flag: a run longer than 14 days isn\'t one')
ok(risingPainFlags([pe(2, addDays(D, -4)), pe(4, addDays(D, -2)), pe(3)], { from: addDays(D, -3), to: D }, { sessions: 3, withinDays: 14, blocks: () => false }).length === 0, 'coach flag: 2 → 4 → 3 isn\'t rising')
ok(risingPainFlags(trend, { from: addDays(D, 1), to: addDays(D, 7) }, { sessions: 3, withinDays: 14, blocks: () => false }).length === 0, 'coach flag: only a run ending in the week')
ok(risingPainFlags(trend, { from: addDays(D, -3), to: D }, { sessions: 3, withinDays: 14, blocks: () => true }).length === 0, 'coach flag: a run that blocks is U7\'s, not a flag')

// ---- against a real schema ---------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const A_PROGRAM = '33333333-3333-3333-3333-333333333333'
const A_PHASE = '55555555-5555-5555-5555-555555555555'
const B_PROGRAM = '44444444-4444-4444-4444-444444444444'
const B_PHASE = '66666666-6666-6666-6666-666666666666'
const UPPER = 'dddd0000-0000-4000-8000-0000000000d1'
const HOOPS = 'dddd0000-0000-4000-8000-0000000000d2'
const JUMPS = 'dddd0000-0000-4000-8000-0000000000d3'
const B_HOOPS = 'dddd0000-0000-4000-8000-0000000000d4'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const athleteA: OverrideActor = { type: 'athlete', id: A }
const T = await athleteToday(storeA)

const routine = (id: string, program: string, phase: string, name: string, exercises: string[]) => harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, $4, 'strength', $5::jsonb, 'synthetic', 3)`,
  [id, program, phase, name, JSON.stringify(exercises.map((n) => ({ name: n, sets: 3, reps: '5', load: 'moderate' })))],
)
await routine(UPPER, A_PROGRAM, A_PHASE, 'Upper', ['Bench Press', 'Dumbbell Row', 'Lateral Raise'])
await routine(HOOPS, A_PROGRAM, A_PHASE, 'Basketball', ['Basketball'])
await routine(JUMPS, A_PROGRAM, A_PHASE, 'Jumps', ['Box Jump', 'Bench Press'])
await routine(B_HOOPS, B_PROGRAM, B_PHASE, 'Basketball', ['Basketball', 'Box Jump'])
await harness.query(`UPDATE phase SET week_start = $2::date, week_end = $3::date WHERE id IN ($1, $4)`, [A_PHASE, addDays(T, -35), addDays(T, 34), B_PHASE])
await harness.query(`DELETE FROM session_observation`)
await harness.query(`DELETE FROM workout`)

type Ex = { name: string; skip: boolean }
type Rx = { prescription: SessionPrescription & { exercises: Ex[] }; methodology_version?: string }
const rx = async (routineId: string, date: string, athleteId = A) => {
  const [out] = await sessionRxForAthlete(sql, athleteId, { routine_id: routineId, unit: 'lb', storage_unit: 'lb', date })
  return { out: out as Rx, text: JSON.stringify(out) }
}
// No readiness on the prescription: nothing active that day, so nothing blocked.
const blockedOn = async (region: string, date: string, routineId = JUMPS) => (await rx(routineId, date)).out.prescription.readiness?.blocked_regions?.includes(region) === true
const workout = (routineId: string, date: string) => harness.query(
  `INSERT INTO workout (routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
   VALUES ($1, $2::timestamptz, 7, 40, '{}'::jsonb, '[]'::jsonb)`, [routineId, `${date}T19:00:00Z`],
)
const flag = (athleteId: string, on: boolean) => on
  ? sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  : sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const blockedRows = (athlete: string, region: string) => count('region_status', `athlete_id = $1 AND region = $2 AND status = 'blocked'`, [athlete, region])
const painRow = (athlete: string, region: string, date: string, score: number) => harness.query(
  `INSERT INTO pain_report (athlete_id, date, region, score) VALUES ($1, $2::date, $3, $4)`, [athlete, date, region, score],
)
const review = async (week: string) => JSON.parse(await executeZeroedTool(sql, A, 'get_weekly_review', { week }, {}, coachA)) as WeeklyReviewView

// Tuesday = T-3, Wednesday = T-2, Thursday = T-1, Friday = T.
const TUE = addDays(T, -3), WED = addDays(T, -2), THU = addDays(T, -1), FRI = T

// ---- flag off: unchanged --------------------------------------------------------------------------
const offJumps = await rx(JUMPS, FRI)
ok(!offJumps.text.includes('methodology_version') && !offJumps.text.includes('"readiness"'), 'flag off: no methodology version, no readiness')
ok(!(await saveCheckin(storeA, athleteA, { date: TUE, pain: [{ region: 'knee', score: 7 }] })).ok && await count('pain_report') === 0, 'flag off: check-ins refused, nothing written')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list unchanged')

await flag(A, true)
await flag(B, true)
await sql`UPDATE athlete SET birth_date = ${addDays(T, -30 * 365)}::date WHERE id IN (${A}, ${B})`
ok((await rx(JUMPS, FRI)).out.prescription.methodology_version === 'v1.3', 'flag on: the prescription records v1.3')

// ---- repro: Tuesday knee > 5, Wednesday upper, Thursday basketball / Friday jumps ----------------------
const knee = await saveCheckin(storeA, athleteA, { date: TUE, pain: [{ region: 'knee', score: 7 }] })
ok(knee.ok && knee.text.includes(REFER_OUT_TEMPORARY) && await blockedRows(A, 'knee') === 0, 'repro: Tuesday knee 7 is a temporary block with the notice')
await workout(UPPER, WED)
const thu = (await rx(HOOPS, THU)).out
ok(thu.prescription.readiness?.blocked_regions.includes('knee') === true && thu.prescription.readiness?.temporary_regions?.includes('knee') === true, 'repro: Wednesday\'s upper session doesn\'t consume it; Thursday basketball still carries the knee block')
const fri = (await rx(JUMPS, FRI)).out
ok(fri.prescription.exercises.find((e) => e.name === 'Box Jump')?.skip === true, 'repro: with no knee session Thursday, Friday jumps still carry it (Box Jump off)')
ok(fri.prescription.exercises.find((e) => e.name === 'Bench Press')?.skip === false, 'repro: the upper work in that session isn\'t touched')
const tv = (await athleteReadinessAction(storeA, { action: 'today' }))[0] as { temporary_blocked: Array<{ region: string; since: string }> }
ok(tv.temporary_blocked.some((b) => b.region === 'knee' && b.since === TUE), 'repro: Today shows the knee as temporary since Tuesday')

// Isolation: B's basketball session doesn't count as A's knee session.
await workout(B_HOOPS, WED)
ok(await blockedOn('knee', FRI), 'isolation: B\'s basketball session doesn\'t consume A\'s knee block')

// ---- counter: the first later session that loads the knee consumes it ---------------------------------
await workout(HOOPS, THU)
const after = (await rx(JUMPS, FRI)).out
ok(after.prescription.readiness?.blocked_regions.includes('knee') !== true && after.prescription.exercises.find((e) => e.name === 'Box Jump')?.skip === false, 'counter: Thursday\'s basketball consumes the knee block; Friday jumps load normally')
ok(await blockedOn('knee', THU, HOOPS), 'counter: it still blocks the basketball session itself (Thursday)')

// ---- other regions: tagged exercises only; untagged ones wait for the lapse ---------------------------------
// Synthetic rows, written straight in: a check-in can only be back-dated 7 days.
await painRow(A, 'foot', addDays(THU, -10), 6) // foot: no exercise is tagged to it
await painRow(A, 'shin', addDays(THU, -14), 6) // shin: likewise, on its 14th day Thursday
ok(await blockedOn('foot', THU) && await blockedOn('foot', FRI), 'untagged region: the foot stays blocked through upper, basketball and jumps sessions')
ok(await blockedOn('shin', THU) && !(await blockedOn('shin', FRI)), 'untagged region: lapses after 14 inclusive days (shin: day 14 blocked, day 15 not)')
await painRow(A, 'hip', addDays(WED, -14), 6)
ok(await blockedOn('hip', WED) && !(await blockedOn('hip', THU)), '14-day lapse: with only an upper session in between, the hip block clears on day 15 anyway')
ok(await blockedRows(A, 'foot') + await blockedRows(A, 'shin') + await blockedRows(A, 'hip') === 0, 'temporary blocks write no region_status rows')

// ---- 2 → 3 → 4: no refer-out, no block; the weekly review shows the coach flag ---------------------------
// Synthetic shoulder ratings on alternate days (each its own session, none the next morning of another).
const r1 = await saveCheckin(storeA, athleteA, { date: addDays(T, -5), pain: [{ region: 'shoulder', score: 2 }] })
const r2 = await saveCheckin(storeA, athleteA, { date: addDays(T, -3), pain: [{ region: 'shoulder', score: 3 }] })
const r3 = await saveCheckin(storeA, athleteA, { date: addDays(T, -1), pain: [{ region: 'shoulder', score: 4 }] })
// (The day's notice can come from another region's block above; the shoulder's own call has none.)
const shoulderCall = (r: typeof r1) => r.regions?.find((x) => x.region === 'shoulder')
ok([r1, r2, r3].every((r) => r.ok && shoulderCall(r) != null && shoulderCall(r)!.status !== 'blocked' && !shoulderCall(r)!.refer_out), 'trend 2 → 3 → 4: no refer-out, no block for the shoulder')
ok(!(r3.readiness?.blocked_regions ?? []).includes('shoulder') && !(r3.readiness?.temporary_regions ?? []).includes('shoulder'), 'trend 2 → 3 → 4: the shoulder isn\'t among the day\'s blocked regions')
ok(await blockedRows(A, 'shoulder') === 0 && !(await blockedOn('shoulder', T, UPPER)), 'trend 2 → 3 → 4: no block, temporary or persistent')
const wk = await review(addDays(T, -1))
const shoulderFlag = wk.coach_flags?.find((f) => f.region === 'shoulder')
ok(shoulderFlag?.kind === 'rising_pain' && shoulderFlag.scores.join() === '2,3,4' && shoulderFlag.rule_refs.includes('U15'), 'weekly review: the 2 → 3 → 4 trend is a coach flag (U15)')
ok(!wk.coach_flags?.some((f) => f.region === 'knee' || f.region === 'foot'), 'weekly review: no flag for regions that blocked')
const hidden = await computeWeeklyReview(storeA, { week: addDays(T, -1), showHealth: false }) as WeeklyReviewView
ok(hidden.coach_flags === undefined && hidden.health_hidden === true, 'weekly review: no coach flags for a coach without health data')
ok(wk.call === (await computeWeeklyReview(storeA, { week: addDays(T, -1), showHealth: true }) as WeeklyReviewView).call, 'weekly review: the flag doesn\'t change the call')

// ---- 11b unchanged: rising onto a block makes it persistent ---------------------------------------------
await saveCheckin(storeA, athleteA, { date: addDays(T, -6), pain: [{ region: 'elbow', score: 2 }] })
await saveCheckin(storeA, athleteA, { date: addDays(T, -4), pain: [{ region: 'elbow', score: 4 }] })
const el = await saveCheckin(storeA, athleteA, { date: addDays(T, -2), pain: [{ region: 'elbow', score: 6 }] })
ok(el.regions?.find((r) => r.region === 'elbow')?.block === 'persistent' && await blockedRows(A, 'elbow') === 1 && el.text.includes(REFER_OUT), 'rising 2 → 4 → 6 on a blocked region: persistent, clinician notice (11b)')
ok(await blockedOn('elbow', T, UPPER), 'persistent: a later elbow-loading session doesn\'t lift it')

// ---- isolation: B sees none of A's flags; B's rows never reach A ----------------------------------------
const bReview = await computeWeeklyReview(storeB, { week: addDays(T, -1), showHealth: true }) as WeeklyReviewView
ok((bReview.coach_flags ?? []).length === 0 && !JSON.stringify(bReview).includes('shoulder'), 'isolation: B\'s review has none of A\'s pain')
await painRow(B, 'wrist', THU, 7)
ok(!(await blockedOn('wrist', FRI)), 'isolation: B\'s wrist never blocks A')

// ---- rollback: flag off again → unchanged ---------------------------------------------------------------
await flag(A, false)
const back = await rx(JUMPS, FRI)
ok(!back.text.includes('"readiness"') && !back.text.includes('methodology_version'), 'rollback: flag off → no readiness, no version, rows ignored')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'rollback: MCP tool list as before')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
