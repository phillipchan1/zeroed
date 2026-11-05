// Methodology v1.2 (spec section 11a, the S&C review): the U6 and U7 fixes,
// every boundary, pure and against a real schema.
//
//   U6  one day alone is a flag only at sleep < 5 h, stress 5 or soreness 5;
//       sleep < 6 h and stress / soreness ≥ 4 count only as a 3-day streak.
//       The main lift is never touched.
//   U7  worse the next morning needs next > session and next ≥ 4. A rating
//       > 5 blocks that day and the next session, with the refer-out notice,
//       then lapses. Persistent (clinician clearance) only on a red flag,
//       > 5 twice within 14 days, or a rating rising across 3 sessions. The
//       4–5 rule is unchanged.
//   Under 18 the two loosenings don't apply (v1.1 kept); v1.2's tightenings do.
//   v1 and v1.1 still resolve exactly; new prescriptions record v1.2. A block
//   stored under v1.1 stays until the athlete clears it. Flag off: unchanged.
//   A coach without health access sees none of it. A and B never mix.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/methodologyV12.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { athleteReadinessAction, clearRegion, HEALTH_HIDDEN, saveCheckin, setCoachHealth } from './readiness.ts'
import {
  addDays, applyReadiness, evaluateRegion, readinessView, REFER_OUT, REFER_OUT_TEMPORARY, u6Flags,
  type CheckinDay, type PainEntry, type ReadinessFlag,
} from './readiness/rules.ts'
import { checkOverride, resolveParams } from './methodology/resolve.ts'
import { CURRENT_METHODOLOGY, METHODOLOGIES, METHODOLOGY_V1, METHODOLOGY_V1_1, METHODOLOGY_V1_2 } from './methodology/v1.ts'
import { makeStore } from './store.ts'
import type { ExerciseTemplate } from '../../src/types/database.ts'
import type { SessionPrescription } from '../../src/engine/sessionRxCompute.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ---- pure: versions ------------------------------------------------------------------------------
ok(METHODOLOGY_V1_2.version === 'v1.2' && CURRENT_METHODOLOGY.version === 'v1.3', 'versions: v1.2 resolves, v1.3 (section 11c) is current')
ok(METHODOLOGIES.v1 === METHODOLOGY_V1 && METHODOLOGIES['v1.1'] === METHODOLOGY_V1_1 && METHODOLOGIES['v1.2'] === METHODOLOGY_V1_2, 'versions: v1, v1.1 and v1.2 all resolve')
ok(!JSON.stringify(METHODOLOGY_V1_1).includes('single_day') && !JSON.stringify(METHODOLOGY_V1_1).includes('persistent_after'), 'versions: v1.1 has none of the v1.2 keys (its rules unchanged)')
const strip12 = (m: typeof METHODOLOGY_V1_2) => {
  const p = JSON.parse(JSON.stringify(m.params)) as Record<string, Record<string, unknown>>
  for (const k of ['single_day_sleep_under_hours', 'single_day_stress_soreness_at']) delete p.U6[k]
  for (const k of ['worse_next_morning_at', 'temporary_blocks', 'persistent_after']) delete p.U7[k]
  return JSON.stringify({ params: p, minors: m.minors, ttl: m.preview_ttl_hours })
}
ok(strip12(METHODOLOGY_V1_2) === JSON.stringify({ params: METHODOLOGY_V1_1.params, minors: METHODOLOGY_V1_1.minors, ttl: METHODOLOGY_V1_1.preview_ttl_hours }), 'v1.2: only U6 / U7 moved; minors 60, U4, U15 and the rest as v1.1')

const adult = resolveParams(METHODOLOGY_V1_2, [], { minor: false })
const kid = resolveParams(METHODOLOGY_V1_2, [], { minor: true })
ok(adult.version === 'v1.2' && kid.version.startsWith('v1.2+'), 'versions: an adult runs on v1.2, a minor on v1.2+<under-18>')
ok(kid.params.U6.single_day_sleep_under_hours === undefined && kid.params.U7.temporary_blocks === false && kid.params.U7.worse_next_morning_at === 4, 'minors: v1.2 loosenings off (v1.1 kept), its tightenings on')
ok(kid.minors.contacts_per_session_max === 60 && Object.values(kid.params.U14.contacts_per_session).every(([, hi]) => hi <= 60), 'minors: the 60-contact ceiling unchanged')
ok(METHODOLOGY_V1_2.params.U6.single_day_sleep_under_hours === 5 && adult.params.U6.single_day_sleep_under_hours === 5, 'clamp: an adult\'s params are not touched')
for (const path of ['U6.single_day_sleep_under_hours', 'U6.single_day_stress_soreness_at', 'U7.worse_next_morning_at', 'U7.temporary_blocks', 'U7.persistent_after.within_days']) {
  const r = checkOverride({ path, value: 1, clear: false, trackId: null, now: adult, withoutThis: adult, minor: false, actorType: 'mcp', exists: false })
  ok(!r.ok && r.text.includes('methodology version'), `overrides: ${path} is fixed by the version`)
}

// ---- pure: U6 ------------------------------------------------------------------------------------
const D = '2026-01-10'
const day = (date: string, sleep: number | null, stress: number | null = null, soreness: number | null = null): CheckinDay => ({ date, sleep_hours: sleep, stress, soreness })
const kinds = (days: CheckinDay[], p = adult.params.U6) => u6Flags(days, D, p).map((f) => f.kind).join()
ok(kinds([day(D, 4.9)]) === 'sleep', 'U6 sleep 4.9 h: one-day flag')
ok(kinds([day(D, 5.0)]) === '', 'U6 sleep 5.0 h: no flag')
ok(kinds([day(D, 5.9)]) === '', 'U6 sleep 5.9 h alone: no flag')
ok(kinds([day(D, 6.0)]) === '', 'U6 sleep 6.0 h: no flag')
ok(kinds([day(addDays(D, -1), 5.9), day(D, 5.9)]) === '', 'U6 sleep 5.9 h two nights: no flag')
ok(kinds([day(addDays(D, -2), 5.9), day(addDays(D, -1), 5.9), day(D, 5.9)]) === 'sleep_streak', 'U6 sleep 5.9 h three nights: the streak flag only')
ok(kinds([day(addDays(D, -2), 6.0), day(addDays(D, -1), 6.0), day(D, 6.0)]) === '', 'U6 sleep 6.0 h three nights: no streak')
ok(kinds([day(addDays(D, -2), 4.9), day(addDays(D, -1), 4.9), day(D, 4.9)]) === 'sleep,sleep_streak', 'U6 sleep 4.9 h three nights: one-day + streak = two flags')
ok(kinds([day(D, 7, 4)]) === '' && kinds([day(D, 7, 5)]) === 'stress', 'U6 stress 4 alone: none; 5: a flag')
ok(kinds([day(D, 7, null, 4)]) === '' && kinds([day(D, 7, null, 5)]) === 'soreness', 'U6 soreness 4 alone: none; 5: a flag')
ok(kinds([day(addDays(D, -1), 7, 4), day(D, 7, 4)]) === '', 'U6 stress 4 two days: no flag')
ok(kinds([day(addDays(D, -2), 7, 4), day(addDays(D, -1), 7, 4), day(D, 7, 4)]) === 'stress_streak', 'U6 stress 4 three days: the streak flag')
ok(kinds([day(addDays(D, -2), 7, null, 4), day(addDays(D, -1), 7, null, 4), day(D, 7, null, 4)]) === 'soreness_streak', 'U6 soreness 4 three days: the streak flag')
ok(kinds([day(addDays(D, -2), 7, 4), day(addDays(D, -1), 7, 3), day(D, 7, 4)]) === '', 'U6: a 3 breaks the stress streak')
ok(u6Flags([day(D, 4.9)], D, adult.params.U6)[0].message === 'Slept 4.9 h (under 5)', 'U6: the flag names the v1.2 line')
ok(kinds([day(D, 5.5)], kid.params.U6) === 'sleep' && kinds([day(D, 7, 4)], kid.params.U6) === 'stress', 'U6 minors: v1.1 kept — 5.5 h or stress 4 alone is still a flag')
ok(kinds([day(D, 5.5)], METHODOLOGY_V1_1.params.U6) === 'sleep' && kinds([day(D, 7, 4)], METHODOLOGY_V1.params.U6) === 'stress', 'U6 v1 / v1.1: unchanged for history')

// Main lift: never modified by U6, at any flag count.
const exs: ExerciseTemplate[] = [
  { name: 'Back Squat', sets: 3, reps: '5', load: 'heavy' },
  { name: 'Bench Press', sets: 3, reps: '5', load: 'heavy' },
  { name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' },
  { name: 'Walking Lunge', sets: 3, reps: '10', load: 'moderate' },
] as ExerciseTemplate[]
const row = (index: number, name: string, load: number | null) => ({ index, name, load, sets: 3, reps: '5', rpe: 8, call: null, reason: null, reasons: [], skip: false, held: false, backoff: null })
const base = {
  directive: null, loadDeltaPct: 0, rpeTarget: null, rationale: null, rule: null, held: {},
  targets: { 0: 300, 1: 200, 2: null, 3: 50 }, hints: {}, skip: {}, reasons: {},
  exercises: [row(0, 'Back Squat', 300), row(1, 'Bench Press', 200), row(2, 'Box Jump', null), row(3, 'Walking Lunge', 50)],
} as unknown as SessionPrescription
const three: ReadinessFlag[] = ['sleep', 'stress', 'soreness'].map((k) => ({ kind: k as ReadinessFlag['kind'], message: k, rule_refs: ['U6'] }))
const flagged = applyReadiness(base, exs, { date: D, flags: three, regions: [], blocked: [], params: adult.params, unit: 'lb' })
ok(JSON.stringify(flagged.rx.exercises![0]) === JSON.stringify(base.exercises![0]) && JSON.stringify(flagged.rx.exercises![1]) === JSON.stringify(base.exercises![1]), 'U6 three flags: the main lifts are untouched (load, sets, reasons)')
ok(flagged.rx.targets[0] === 300 && flagged.rx.targets[1] === 200 && !flagged.adjustments.some((a) => a.index <= 1), 'U6 three flags: no adjustment names a main lift')
ok(flagged.rx.exercises![2].skip && flagged.rx.exercises![3].sets === 2, 'U6 three flags: plyos pulled, accessories trimmed')
// The 4–5 rule, unchanged: impact dropped and loaded work −10% for that region.
const capped = applyReadiness(base, exs, { date: D, flags: [], regions: [evaluateRegion({ today: { date: D, region: 'knee', score: 5, red_flags: [] }, yesterday: null, params: adult.params.U7, raised: false, adult: true })], blocked: [], params: adult.params, unit: 'lb' })
ok(capped.rx.exercises![0].load === 270 && capped.rx.exercises![2].skip && capped.rx.exercises![1].load === 200, 'U7 4–5: knee loads −10% (300 → 270), the jump dropped, the bench untouched')

// ---- pure: U7 ------------------------------------------------------------------------------------
const pe = (score: number, date = D, red: PainEntry['red_flags'] = [], region: PainEntry['region'] = 'knee'): PainEntry => ({ date, region, score, red_flags: red })
const ev = (today: PainEntry, yesterday: PainEntry | null = null, history: PainEntry[] = [], params = adult.params.U7, raised = false, isAdult = true) =>
  evaluateRegion({ today, yesterday, params, raised, adult: isAdult, history: yesterday ? [...history, yesterday] : history })
const y = (score: number) => pe(score, addDays(D, -1))
ok(ev(pe(3), y(2)).status === 'ok', 'U7 next morning 2 → 3: no block')
const w34 = ev(pe(4), y(3))
ok(w34.status === 'blocked' && w34.block === 'temporary' && w34.refer_out && w34.reason.includes('worse the next morning'), 'U7 next morning 3 → 4: blocked (temporary), refer out')
ok(ev(pe(4), y(4)).status === 'capped', 'U7 next morning 4 → 4: no block (the 4–5 rule)')
ok(ev(pe(5), y(4)).status === 'blocked', 'U7 next morning 4 → 5: blocked')
ok(ev(pe(3), y(2), [], METHODOLOGY_V1_1.params.U7).status === 'ok' && ev(pe(4), y(3), [], METHODOLOGY_V1_1.params.U7).status === 'capped', 'U7 v1.1: unchanged for history (3 → 4 was not a block)')
ok(ev(pe(4)).status === 'capped' && ev(pe(5)).status === 'capped', 'U7 4–5 rule unchanged: capped')
ok(ev(pe(3)).status === 'ok', 'U7 ≤ 3: proceed')
const once = ev(pe(6))
ok(once.status === 'blocked' && once.block === 'temporary' && once.refer_out && once.reason.includes('today or your next session'), 'U7 > 5 once: blocked today and the next session, refer out')
const twice14 = ev(pe(7), null, [pe(6, addDays(D, -14))])
ok(twice14.status === 'blocked' && twice14.block === 'persistent' && twice14.reason.includes('twice within 14 days'), 'U7 > 5 twice, 14 days apart: persistent')
ok(ev(pe(7), null, [pe(6, addDays(D, -3))]).block === 'persistent', 'U7 > 5 twice, 3 days apart: persistent')
ok(ev(pe(7), null, [pe(6, addDays(D, -15))]).block === 'temporary', 'U7 > 5 twice, 15 days apart: not persistent')
ok(ev(pe(7), null, [pe(5, addDays(D, -3))]).block === 'temporary', 'U7: 5 then 7 is not "> 5 twice"')
const rising = ev(pe(6), null, [pe(2, addDays(D, -4)), pe(4, addDays(D, -2))])
ok(rising.block === 'persistent' && rising.reason.includes('2 → 4 → 6'), 'U7 rising across 3 sessions (2 → 4 → 6): persistent')
ok(ev(pe(5), y(4), [pe(3, addDays(D, -2))]).block === 'persistent', 'U7 rising 3 → 4 → 5 (worse the next morning): persistent')
ok(ev(pe(6), null, [pe(4, addDays(D, -4)), pe(3, addDays(D, -2))]).block === 'temporary', 'U7 4 → 3 → 6 is not rising: temporary')
ok(ev(pe(6), null, [pe(4, addDays(D, -4)), pe(4, addDays(D, -2))]).block === 'temporary', 'U7 4 → 4 → 6 is not rising: temporary')
ok(ev(pe(6), null, [pe(2, addDays(D, -20)), pe(4, addDays(D, -2))]).block === 'temporary', 'U7: a report older than 14 days doesn\'t count toward rising')
ok(ev(pe(5), null, [pe(2, addDays(D, -4)), pe(3, addDays(D, -2))]).status === 'capped', 'U7: rising alone (2 → 3 → 5, no block) only makes a block persistent, it doesn\'t block')
for (const red of ['swelling', 'locking', 'numbness_tingling', 'acute_injury'] as const) {
  const r = ev(pe(1, D, [red]))
  ok(r.status === 'blocked' && r.block === 'persistent' && r.refer_out, `U7 red flag (${red}): persistent at 1/10`)
}
ok(ev(pe(5), y(3), [], adult.params.U7, true, true).status === 'blocked', 'U7 raised cap: 3 → 5 is worse the next morning, so it blocks (a raised cap never overrides it)')
ok(ev(pe(5), null, [], adult.params.U7, true, true).status === 'ok', 'U7 raised cap: an adult\'s settled 5 still proceeds (D2)')
// Minors: every block persistent (v1.1), and v1.2's tighter calls apply.
ok(ev(pe(6), null, [], kid.params.U7).block === 'persistent', 'U7 minors: > 5 once is persistent (v1.1 kept)')
ok(ev(pe(4), y(3), [], kid.params.U7).block === 'persistent', 'U7 minors: 3 → 4 blocks (v1.2) and persists')
ok(ev(pe(5), null, [], kid.params.U7, true, false).status === 'capped', 'U7 minors: never a raised cap')
// The notice.
const view = (regions: ReturnType<typeof ev>[], blocked: string[], temporary: string[]) => readinessView({ date: D, flags: [], regions, blocked, temporary, params: adult.params })
ok(view([once], ['knee'], ['knee']).refer_out === REFER_OUT_TEMPORARY, 'refer-out: a temporary block shows the next-session notice')
ok(view([once], ['knee'], ['knee']).temporary_regions?.join() === 'knee', 'view: names the temporary regions')
ok(view([twice14], ['knee'], []).refer_out === REFER_OUT && view([twice14], ['knee'], []).temporary_regions === undefined, 'refer-out: a persistent block shows the clinician notice')
ok(view([], ['knee', 'hip'], ['knee']).refer_out === REFER_OUT, 'refer-out: any persistent block wins')

// ---- against a real schema ---------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const A_PROGRAM = '33333333-3333-3333-3333-333333333333'
const A_PHASE = '55555555-5555-5555-5555-555555555555'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const C_DAY = 'cccc0000-0000-4000-8000-0000000000c2'
const B_DAY = '88888888-8888-8888-8888-888888888888'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const athleteA: OverrideActor = { type: 'athlete', id: A }
const athleteB: OverrideActor = { type: 'athlete', id: B }
const T = await athleteToday(storeA)

await harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, 'C day', 'strength', $4::jsonb, 'C intent', 2)`,
  [C_DAY, A_PROGRAM, A_PHASE, JSON.stringify([
    { name: 'Back Squat', sets: 3, reps: '5', load: 'heavy' },
    { name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' },
    { name: 'Walking Lunge', sets: 3, reps: '10', load: 'moderate' },
    { name: 'Dumbbell Row', sets: 3, reps: '10', load: 'moderate' },
    { name: 'Lateral Raise', sets: 3, reps: '12', load: 'light' },
    { name: 'Hip Thrust', sets: 3, reps: '8', load: 'moderate' },
  ])],
)
await harness.query(`UPDATE phase SET week_start = $2::date, week_end = $3::date WHERE id = $1`, [A_PHASE, addDays(T, -35), addDays(T, 34)])
// The seed's synthetic workouts sit on fixed dates; the "next session" checks log their own.
await harness.query(`DELETE FROM session_observation`)
await harness.query(`DELETE FROM workout`)

type Ex = { name: string; load: number | null; sets: number; skip: boolean; reasons: string[] }
type Rx = { prescription: SessionPrescription & { exercises: Ex[] }; methodology_version?: string }
const rx = async (athleteId = A, routine = C_DAY, date?: string) => {
  const [out] = await sessionRxForAthlete(sql, athleteId, { routine_id: routine, unit: 'lb', storage_unit: 'lb', ...(date ? { date } : {}) })
  return { out: out as Rx, text: JSON.stringify(out) }
}
const ex = (r: Rx, name: string) => r.prescription.exercises.find((e) => e.name === name)!
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const blockedRows = (athlete: string, region: string) => count('region_status', `athlete_id = $1 AND region = $2 AND status = 'blocked'`, [athlete, region])
const checkin = (body: Record<string, unknown>, store = storeA, actor = athleteA) => saveCheckin(store, actor, body)
const workout = (routine: string, date: string) => harness.query(
  `INSERT INTO workout (routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
   VALUES ($1, $2::timestamptz, 7, 40, '{}'::jsonb, '[]'::jsonb)`, [routine, `${date}T19:00:00Z`],
)
type Today = { temporary_blocked: Array<{ region: string; since: string }>; blocked: Array<{ region: string }>; readiness: { refer_out: string | null } }
const todayView = async (store = storeA) => (await athleteReadinessAction(store, { action: 'today' }))[0] as Today

// ---- flag off: unchanged --------------------------------------------------------------------------
const off = await rx()
const offA = await rx(A, A_DAY)
ok(!off.text.includes('methodology_version') && !off.text.includes('"readiness"'), 'flag off: no methodology version, no readiness')
ok(!(await checkin({ sleep_hours: 4 })).ok && await count('checkin') === 0, 'flag off: check-ins refused, nothing written')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list unchanged')

// ---- flag on: v1.2 recorded ------------------------------------------------------------------------
await flag(A, true)
await flag(B, true)
await sql`UPDATE athlete SET birth_date = ${addDays(T, -30 * 365)}::date WHERE id = ${A}`
await sql`UPDATE athlete SET birth_date = ${addDays(T, -15 * 365)}::date WHERE id = ${B}`
const on = (await rx()).out
ok(on.methodology_version === 'v1.3' && on.prescription.methodology_version === 'v1.3', 'flag on: session-rx and the prescription record v1.3')
ok((await rx(B, B_DAY)).out.prescription.methodology_version?.startsWith('v1.3+') === true, 'flag on: a minor\'s prescription records v1.3+<under-18>')
const review = JSON.parse(await call('get_weekly_review', {})) as { methodology_version: string }
ok(review.methodology_version === 'v1.3', 'flag on: the weekly review records v1.3')

// ---- U6, end to end ---------------------------------------------------------------------------------
await checkin({ sleep_hours: 5.0 })
ok(((await rx()).out.prescription.readiness?.flags.length ?? 0) === 0 && ex((await rx()).out, 'Walking Lunge').sets === 3, 'U6 DB: 5.0 h → no flag, nothing trimmed')
await checkin({ sleep_hours: 4.9 })
const u6 = (await rx()).out
ok(u6.prescription.readiness?.level === 'trim_accessories' && ex(u6, 'Walking Lunge').sets === 2, 'U6 DB: 4.9 h → one flag, accessories trimmed')
ok(JSON.stringify(ex(u6, 'Back Squat')) === JSON.stringify(ex(on, 'Back Squat')), 'U6 DB: the main lift untouched')
await checkin({ sleep_hours: 8, stress: 4, soreness: 4 })
ok(((await rx()).out.prescription.readiness?.flags.length ?? 0) === 0, 'U6 DB: stress 4 + soreness 4 for one day → no flag')
await checkin({ sleep_hours: 8, stress: 5, soreness: 5 })
const u6b = (await rx()).out
ok(u6b.prescription.readiness?.level === 'pull_hiit_plyo' && ex(u6b, 'Box Jump').skip && !ex(u6b, 'Back Squat').skip && ex(u6b, 'Back Squat').load === ex(on, 'Back Squat').load, 'U6 DB: stress 5 + soreness 5 → two flags, plyos pulled, main lift kept')
await checkin({ sleep_hours: 8, stress: 2, soreness: 2 })
const minorSleep = await checkin({ sleep_hours: 5.5 }, storeB, athleteB)
ok(minorSleep.readiness?.level === 'trim_accessories', 'U6 DB minors: 5.5 h alone is still a flag (v1.1 kept)')

// ---- U7 > 5 once: today and the next session, then it lapses ----------------------------------------
const e1 = await checkin({ date: addDays(T, -2), pain: [{ region: 'elbow', score: 6 }] })
ok(e1.ok && e1.text.includes(REFER_OUT_TEMPORARY), 'U7 > 5 once: the check-in answers with the refer-out notice')
ok(await blockedRows(A, 'elbow') === 0, 'U7 > 5 once: no persistent block row written')
const [elog] = await harness.query<{ diff: { temporary_blocks?: Array<{ region: string }>; regions: unknown[] } }>(`SELECT diff FROM change_log WHERE id = $1`, [e1.change_id])
ok(elog?.diff.temporary_blocks?.[0]?.region === 'elbow', 'U7 > 5 once: the change log records the temporary block')
const thatDay = (await rx(A, C_DAY, addDays(T, -2))).out
ok(ex(thatDay, 'Dumbbell Row').skip && thatDay.prescription.readiness?.refer_out === REFER_OUT_TEMPORARY, 'U7 > 5 once: blocked that day, refer-out shown')
const nextSession = (await rx()).out
ok(ex(nextSession, 'Dumbbell Row').skip && ex(nextSession, 'Dumbbell Row').reasons.some((r) => r.includes('next session')), 'U7 > 5 once: still blocked for the next session (none logged since)')
ok(nextSession.prescription.readiness?.temporary_regions?.includes('elbow') === true && nextSession.prescription.readiness?.refer_out === REFER_OUT_TEMPORARY, 'U7 > 5 once: the prescription names it temporary, with the notice')
const tv = await todayView()
ok(tv.temporary_blocked.some((b) => b.region === 'elbow' && b.since === addDays(T, -2)) && !tv.blocked.some((b) => b.region === 'elbow'), 'today: shown as temporary, nothing to clear')
ok(!(await clearRegion(storeA, athleteA, 'elbow')).ok, 'clear: a temporary block needs no clinician clear')
const status = JSON.parse(await call('get_region_status', {})) as { regions: Array<{ region: string; status: string; block?: string }>; refer_out: string | null }
ok(status.regions.find((r) => r.region === 'elbow')?.block === 'temporary' && status.refer_out === REFER_OUT_TEMPORARY, 'get_region_status: blocked, temporary, the notice')
// B logging a session doesn't lapse A's block.
await workout(B_DAY, addDays(T, -1))
ok(ex((await rx()).out, 'Dumbbell Row').skip, 'isolation: B\'s session doesn\'t count as A\'s next session')
// v1.3 (section 11c): A's squat-only session doesn't load the elbow, so the block stays.
await workout(A_DAY, addDays(T, -1))
ok(ex((await rx()).out, 'Dumbbell Row').skip, 'U7 v1.3: a session that doesn\'t load the elbow leaves its block')
// A logs a session that loads it (Dumbbell Row): the block lapses after it.
await workout(C_DAY, addDays(T, -1))
const lapsed = (await rx()).out
ok(!ex(lapsed, 'Dumbbell Row').skip && !(lapsed.prescription.readiness?.blocked_regions ?? []).includes('elbow'), 'U7 > 5 once: lapses after the next session')
ok((await todayView()).temporary_blocked.length === 0, 'today: nothing temporary once it lapses')
const weekBlocked = JSON.parse(await call('get_weekly_review', { week: addDays(T, -2) })) as { pain: { blocked: string[] } }
ok(weekBlocked.pain.blocked.includes('elbow'), 'weekly review: a temporary block that week counts as blocked')

// ---- U7 persistent -----------------------------------------------------------------------------------
const insertPain = (athlete: string, date: string, region: string, score: number) => harness.query(
  `INSERT INTO pain_report (athlete_id, date, region, score) VALUES ($1, $2::date, $3, $4)`, [athlete, date, region, score],
)
// > 5 twice: 14 days apart → persistent; 15 → not.
await insertPain(A, addDays(T, -14), 'hip', 7)
await insertPain(A, addDays(T, -15), 'hamstring', 7)
const both = await checkin({ pain: [{ region: 'hip', score: 6 }, { region: 'hamstring', score: 6 }] })
ok(both.regions?.find((r) => r.region === 'hip')?.block === 'persistent' && await blockedRows(A, 'hip') === 1, 'U7 > 5 twice in 14 days: persistent, a region_status block row')
ok(both.regions?.find((r) => r.region === 'hamstring')?.block === 'temporary' && await blockedRows(A, 'hamstring') === 0, 'U7 > 5 15 days apart: temporary, no row')
ok(both.text.includes(REFER_OUT) && both.text.includes(REFER_OUT_TEMPORARY), 'check-in: both notices when both kinds are set')
const both2 = (await rx()).out
ok(ex(both2, 'Hip Thrust').skip && both2.prescription.readiness?.refer_out === REFER_OUT, 'persistent: no loading, the clinician notice wins')
// Rising across 3 sessions.
await checkin({ date: addDays(T, -5), pain: [{ region: 'shoulder', score: 2 }] })
await checkin({ date: addDays(T, -3), pain: [{ region: 'shoulder', score: 4 }] })
const sh = await checkin({ pain: [{ region: 'shoulder', score: 6 }] })
ok(sh.regions?.find((r) => r.region === 'shoulder')?.block === 'persistent' && await blockedRows(A, 'shoulder') === 1, 'U7 rising 2 → 4 → 6: persistent')
// A red flag.
const ankle = await checkin({ pain: [{ region: 'ankle', score: 1, red_flags: ['swelling'] }] })
ok(ankle.regions?.find((r) => r.region === 'ankle')?.block === 'persistent' && await blockedRows(A, 'ankle') === 1, 'U7 red flag: persistent')
// Persistent blocks don't lapse with a session; the athlete clears them.
await workout(A_DAY, T)
ok((await rx(A, C_DAY, addDays(T, 1))).out.prescription.readiness?.blocked_regions.includes('hip') === true, 'persistent: a logged session doesn\'t lift it')
ok((await clearRegion(storeA, athleteA, 'hip')).ok && !(await rx(A, C_DAY, addDays(T, 1))).out.prescription.readiness?.blocked_regions.includes('hip'), 'persistent: lifted only by the athlete\'s clinician clear')
// 4–5 unchanged.
const k5 = await checkin({ pain: [{ region: 'knee', score: 5 }] })
const k5rx = (await rx()).out
ok(k5.regions?.find((r) => r.region === 'knee')?.status === 'capped' && k5rx.prescription.readiness?.regions.find((r) => r.region === 'knee')?.status === 'capped' && !k5rx.prescription.readiness?.blocked_regions.includes('knee'), 'U7 4–5 DB: capped, not blocked (unchanged)')

// A block stored under v1.1 (a one-off 6/10, then persistent) stays until the athlete clears it.
await harness.query(
  `INSERT INTO region_status (athlete_id, region, status, reason, created_at) VALUES ($1, 'wrist', 'blocked', 'wrist at 6/10 (over 5). No loading there (U7).', NOW() - INTERVAL '10 days')`, [A],
)
ok((await rx()).out.prescription.readiness?.blocked_regions.includes('wrist') === true && (await todayView()).blocked.some((b) => b.region === 'wrist'), 'v1.1 block: still blocks under v1.2, listed to clear')
ok((await clearRegion(storeA, athleteA, 'wrist')).ok, 'v1.1 block: the athlete clears it as before')

// ---- minors ------------------------------------------------------------------------------------------
const kidKnee = await checkin({ pain: [{ region: 'knee', score: 6 }] }, storeB, athleteB)
ok(kidKnee.regions?.find((r) => r.region === 'knee')?.block === 'persistent' && await blockedRows(B, 'knee') === 1, 'minors: > 5 once is persistent (v1.1 kept)')
ok(kidKnee.text.includes(REFER_OUT) && !kidKnee.text.includes(REFER_OUT_TEMPORARY), 'minors: the clinician notice')

// ---- privacy: a coach without health access ------------------------------------------------------------
await checkin({ date: addDays(T, -1), pain: [{ region: 'neck', score: 7 }] })
ok((await rx()).out.prescription.readiness?.temporary_regions?.includes('neck') === true, 'setup: a temporary neck block')
ok((await setCoachHealth(storeA, athleteA, TOKEN_A_ID, false)).ok, 'toggle: health off for coach A')
ok(await call('get_region_status', {}, coachA) === HEALTH_HIDDEN && await call('get_checkins', { since: addDays(T, -7) }, coachA) === HEALTH_HIDDEN, 'privacy: region status and check-ins hidden')
const hiddenReview = JSON.parse(await call('get_weekly_review', {}, coachA)) as { pain: unknown; why: string }
ok(hiddenReview.pain === null && !/neck|shoulder|ankle|elbow/.test(hiddenReview.why), 'privacy: the review names no region')
const hiddenLog = await call('get_change_log', { since: addDays(T, -7), target: 'checkin' }, coachA)
ok(!hiddenLog.includes('neck') && !hiddenLog.includes('temporary_blocks'), 'privacy: the change log hides temporary blocks too')
ok((await setCoachHealth(storeA, athleteA, TOKEN_A_ID, true)).ok, 'toggle: back on')

// ---- isolation -------------------------------------------------------------------------------------------
const bToday = await todayView(storeB)
ok(bToday.temporary_blocked.every((b) => b.region === 'knee') && !bToday.blocked.some((b) => ['elbow', 'neck', 'shoulder', 'ankle'].includes(b.region)), 'isolation: B sees none of A\'s blocks')
const bRx = await rx(B, B_DAY)
ok(!/neck|shoulder|ankle|elbow|hamstring/.test(bRx.text), 'isolation: B\'s prescription knows nothing of A')
const bStatus = await call('get_region_status', {}, coachB, B)
ok(!/neck|shoulder|ankle|elbow|hamstring/.test(bStatus), 'isolation: B\'s coach reads none of A\'s regions')
ok(!(await clearRegion(storeB, athleteB, 'shoulder')).ok && await blockedRows(A, 'shoulder') === 1, 'isolation: B can\'t clear A\'s block')
ok((await rx()).out.prescription.readiness?.blocked_regions.includes('knee') === false, 'isolation: B\'s knee block never reaches A')

// ---- rollback: flag off again → unchanged --------------------------------------------------------------
await flag(A, false)
const back = await rx()
const backA = await rx(A, A_DAY)
ok(!back.text.includes('"readiness"') && !back.text.includes('methodology_version'), 'rollback: flag off → no readiness, no version, rows ignored')
// The A-day and C-day prescriptions differ from before only through the workouts logged above (last weights), not the rows.
await harness.query(`DELETE FROM workout WHERE routine_id IN ($1, $2)`, [A_DAY, C_DAY])
ok((await rx()).text === off.text && (await rx(A, A_DAY)).text === offA.text && backA.text.length > 0, 'rollback: byte-identical to before once the synthetic sessions are gone')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
