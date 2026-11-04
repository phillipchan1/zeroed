// Readiness + pain check-in (G4), the weekly review (G8) and coach-read
// logging, against a real schema. Flag off: session-rx, the MCP tool list,
// the routes and the read log are exactly as before. Flag on: U6 trims
// accessories at one flag and also pulls HIIT/plyos at two (multi-day flags
// count); U7 proceeds at ≤ 3, regresses at 4–5 and blocks above 5, when worse
// than yesterday, or on any red flag; a block persists until the athlete
// clears it and no coach can; minors never get a raised cap; the health
// toggle hides pain and check-ins from that coach; the weekly review makes
// its call on synthetic weeks; coach reads are logged and the athlete's are
// not. Athletes A and B never see each other's rows.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/readiness.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { athleteReadinessAction, clearRegion, HEALTH_HIDDEN, READINESS_TOOLS, saveCheckin, setCoachHealth } from './readiness.ts'
import { addDays, applyReadiness, evaluateRegion, u6Flags, type PainEntry } from './readiness/rules.ts'
import { weeklyCall, type LiftTrend } from './weeklyReview.ts'
import { METHODOLOGY_V1 } from './methodology/v1.ts'
import { makeStore } from './store.ts'
import type { SessionPrescription } from '../../src/engine/sessionRxCompute.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const A_PROGRAM = '33333333-3333-3333-3333-333333333333'
const A_PHASE = '55555555-5555-5555-5555-555555555555'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const C_DAY = 'cccc0000-0000-4000-8000-00000000000c'
const B_DAY = '88888888-8888-8888-8888-888888888888'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_A2_ID = 'aaaa6666-0000-4000-8000-0000000000a2'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

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
const monday = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7))
const M = monday(T)

// A second session for A: main lift, plyo, two accessories, a shoulder accessory, HIIT, and one the table can't place.
await harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, 'C day', 'strength', $4::jsonb, 'C intent', 2)`,
  [C_DAY, A_PROGRAM, A_PHASE, JSON.stringify([
    { name: 'Back Squat', sets: 3, reps: '5', load: 'heavy' },
    { name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' },
    { name: 'Walking Lunge', sets: 3, reps: '10', load: 'moderate' },
    { name: 'Dumbbell Row', sets: 3, reps: '10', load: 'moderate' },
    { name: 'Lateral Raise', sets: 3, reps: '12', load: 'light' },
    { name: 'Assault Bike', sets: 1, reps: 'Tabata', load: 'moderate' },
    { name: 'Zorblax Press', sets: 3, reps: '8', load: 'moderate' },
  ])],
)
// The phase covers the weeks the review checks, whatever today is.
await harness.query(`UPDATE phase SET week_start = $2::date, week_end = $3::date WHERE id = $1`, [A_PHASE, addDays(M, -35), addDays(M, 34)])
await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'second coach', 'hash-a2', 'aaa2')`,
  [TOKEN_A2_ID, A],
)

const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
type Ex = { name: string; load: number | null; sets: number; skip: boolean; reasons: string[] }
type Rx = { prescription: SessionPrescription & { exercises: Ex[] }; version: string; program_version: string; readiness?: { flags: unknown[] } }
const rx = async (athleteId = A, routine = C_DAY, date?: string) => {
  const [out] = await sessionRxForAthlete(sql, athleteId, { routine_id: routine, unit: 'lb', storage_unit: 'lb', ...(date ? { date } : {}) })
  return { out: out as Rx, text: JSON.stringify(out) }
}
const ex = (r: Rx, name: string) => r.prescription.exercises.find((e) => e.name === name)!
const strip = (text: string) => JSON.stringify(JSON.parse(text), (k, v) => (k === 'methodology_version' ? undefined : v))
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const checkin = (body: Record<string, unknown>, store = storeA, actor = athleteA) => saveCheckin(store, actor, body)
// ---- pure rules -------------------------------------------------------------------------------
const U6 = METHODOLOGY_V1.params.U6
const U7 = METHODOLOGY_V1.params.U7
const day = (date: string, sleep: number | null, stress: number | null = null, soreness: number | null = null) => ({ date, sleep_hours: sleep, stress, soreness })
ok(u6Flags([day('2026-01-10', 7, 2, 2)], '2026-01-10', U6).length === 0, 'U6 pure: a good day has no flags')
ok(u6Flags([day('2026-01-10', 5.5)], '2026-01-10', U6).map((f) => f.kind).join() === 'sleep', 'U6 pure: one short night is one flag')
ok(u6Flags([day('2026-01-08', 5), day('2026-01-09', 5), day('2026-01-10', 5)], '2026-01-10', U6).map((f) => f.kind).join() === 'sleep,sleep_streak', 'U6 pure: 3 short nights add a streak flag')
ok(u6Flags([day('2026-01-08', 7, 4), day('2026-01-09', 7, 4), day('2026-01-10', 7, 4)], '2026-01-10', U6).map((f) => f.kind).join() === 'stress,stress_streak', 'U6 pure: stress 4+ for 3 days adds a streak flag')
ok(u6Flags([day('2026-01-07', 5), day('2026-01-09', 5), day('2026-01-10', 5)], '2026-01-10', U6).length === 1, 'U6 pure: a gap breaks the streak')
const pe = (score: number, red: PainEntry['red_flags'] = [], date = '2026-01-10'): PainEntry => ({ date, region: 'knee', score, red_flags: red })
const ev = (today: PainEntry, yesterday: PainEntry | null = null, raised = false, adult = true) => evaluateRegion({ today, yesterday, params: U7, raised, adult })
ok(ev(pe(3)).status === 'ok', 'U7 pure: 3/10 proceeds')
ok(ev(pe(4)).status === 'capped' && ev(pe(5)).status === 'capped', 'U7 pure: 4–5 regress')
ok(ev(pe(6)).status === 'blocked' && ev(pe(6)).refer_out, 'U7 pure: > 5 blocks and refers out')
ok(ev(pe(1, ['swelling'])).status === 'blocked', 'U7 pure: a red flag blocks at any score')
ok(ev(pe(5), pe(4, [], '2026-01-09')).status === 'blocked', 'U7 pure: worse than yesterday (above the cap) blocks')
ok(ev(pe(3), pe(2, [], '2026-01-09')).status === 'ok', 'U7 pure: a small rise under the cap is not "worse"')
ok(ev(pe(5), null, true, true).status === 'ok', 'U7 pure: an adult\'s raised cap lets 5 proceed')
ok(ev(pe(5), null, true, false).status === 'capped', 'U7 pure: a raised cap never counts for a minor (or unknown age)')
ok(ev(pe(5), pe(5, [], '2026-01-09'), true, true).status === 'capped', 'U7 pure: a raised cap needs the region settled the day before')
ok(ev(pe(2, ['numbness_tingling']), null, true, true).status === 'blocked', 'U7 pure: red flags win over a raised cap')
const baseRx = { targets: {}, hints: {}, skip: {}, reasons: {}, exercises: [] } as unknown as SessionPrescription
const untouched = applyReadiness(baseRx, [{ name: 'Walking Lunge', sets: 3, reps: '10' }], { date: '2026-01-10', flags: [], regions: [], blocked: [], params: METHODOLOGY_V1.params, unit: 'lb' })
ok(untouched.rx === baseRx && untouched.adjustments.length === 0, 'apply pure: nothing to say → the same object back')
const dl = (lift: string, down: number, trend: LiftTrend['trend'] = 'flat'): LiftTrend => ({ lift, e1rm_week: 100, e1rm_prior: 100, change_pct: trend === 'down' ? -3 : 0, trend, down_sessions: down })
const comp = (ratio: number | null) => ({ ratio, target: 0.8, trigger: 0.7 })
ok(weeklyCall({ compliance: comp(1), lifts: [dl('squat', 0, 'up')], flagDays: 0, painRegions: [] }).call === 'progress', 'review pure: all good → progress')
ok(weeklyCall({ compliance: comp(0.5), lifts: [], flagDays: 0, painRegions: [] }).call === 'deload', 'review pure: compliance < 70% → deload (U11)')
ok(weeklyCall({ compliance: comp(1), lifts: [dl('bench', 2, 'down')], flagDays: 0, painRegions: [] }).call === 'deload', 'review pure: e1RM down 2 sessions in a row → deload')
ok(weeklyCall({ compliance: comp(1), lifts: [], flagDays: 5, painRegions: [] }).call === 'deload', 'review pure: flags most of the week → deload')
ok(weeklyCall({ compliance: comp(0.75), lifts: [], flagDays: 0, painRegions: [] }).call === 'hold', 'review pure: 70–80% → hold (U15)')
ok(weeklyCall({ compliance: comp(1), lifts: [], flagDays: 0, painRegions: ['knee'] }).call === 'hold', 'review pure: pain over the cap → hold (U7)')

// ---- flag OFF: exactly as before ---------------------------------------------------------------
const off = await rx()
const offA = await rx(A, A_DAY)
ok(!off.text.includes('"readiness":') && !off.text.includes('"adjustments"'), 'flag off: session-rx has no readiness / adjustments')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list unchanged')
ok((await call('get_checkins', { since: T })).includes('Unknown tool'), 'flag off: get_checkins is unknown')
ok((await call('get_weekly_review', {})).includes('Unknown tool'), 'flag off: get_weekly_review is unknown')
const [offRoute, offStatus] = await athleteReadinessAction(storeA, { action: 'today' })
ok(offStatus === 404 && (offRoute as { error?: string }).error === 'not found', 'flag off: /api/readiness answers 404')
ok(!(await checkin({ sleep_hours: 5 })).ok, 'flag off: a check-in is refused')
await call('get_athlete', {})
await call('list_workouts', {})
ok(await count('coach_read_log') === 0, 'flag off: coach reads are not logged')
ok(await count('checkin') === 0 && await count('change_log') === 0, 'flag off: nothing written')

// ---- flag ON, nothing logged: as G3 --------------------------------------------------------------
await flag(A, true)
const onEmpty = await rx()
ok(strip(onEmpty.text) === off.text, 'flag on, no check-in: byte-identical to flag off (but for methodology_version)')
const onTools = await zeroedToolsFor(sql, A)
ok(READINESS_TOOLS.every((t) => onTools.some((x) => x.name === t.name)), 'flag on: get_checkins, get_region_status, get_weekly_review listed')

// ---- coach reads ---------------------------------------------------------------------------------
const readsBefore = await count('coach_read_log')
await call('get_athlete', {}, coachA)
await call('search_lifts', { exercise: 'squat' }, coachA)
ok(await count('coach_read_log', `actor_type = 'mcp' AND actor_id = $1`, [TOKEN_A_ID]) === readsBefore + 2, 'reads: every MCP read tool call is logged')
const [scoped] = await harness.query<{ tool: string; scope: { exercise?: string } }>(`SELECT tool, scope FROM coach_read_log WHERE tool = 'search_lifts' LIMIT 1`)
ok(scoped?.scope?.exercise === 'squat', 'reads: the scope (arguments) is recorded')
await call('get_athlete', {}, appCoach)
ok(await count('coach_read_log', `actor_type = 'app_coach'`) === 1, 'reads: app_coach reads are logged')
const beforeOwn = await count('coach_read_log')
await call('get_athlete', {}, athleteA)
await call('get_checkins', { since: T }, athleteA)
ok(await count('coach_read_log') === beforeOwn, 'reads: the athlete\'s own reads are not logged')
await call('preview_program_edits', { edits: [{ type: 'update_exercise', session_name: 'A day', exercise_name: 'Back Squat', sets: 4 }] }, coachA)
ok(await count('coach_read_log') === beforeOwn, 'reads: previews are not read-log rows (they are kept previews)')
const [access] = await athleteReadinessAction(storeA, { action: 'coach_access' })
const acc = access as { coaches: Array<{ id: string; share_health: boolean }>; reads: Array<{ who: string; tool: string }> }
ok(acc.reads.length === beforeOwn && acc.reads.some((r) => r.tool === 'search_lifts' && r.who === 'claude-a'), 'reads: the athlete sees the list, with who')
ok(acc.coaches.every((c) => c.share_health === true), 'D3: health data is on by default for invited coaches')
ok(acc.coaches.length === 2, 'coach access lists only A\'s live coaches')

// ---- U6 -----------------------------------------------------------------------------------------
const one = await checkin({ sleep_hours: 5 })
ok(one.ok && one.readiness?.level === 'trim_accessories', 'U6: one flag → trim accessories')
const [logRow] = await harness.query<{ tool: string; actor_type: string; approval_ref: string; target_type: string }>(`SELECT tool, actor_type, approval_ref, target_type FROM change_log WHERE id = $1`, [one.change_id])
ok(logRow?.tool === 'log_checkin' && logRow.actor_type === 'athlete' && logRow.approval_ref === 'standing:logging', 'check-in: logged under standing approval')
const r1 = (await rx()).out
ok(ex(r1, 'Walking Lunge').sets === 2 && ex(r1, 'Dumbbell Row').sets === 2, 'U6 one flag: accessories trimmed 3 → 2 sets')
ok(!ex(r1, 'Box Jump').skip && !ex(r1, 'Assault Bike').skip, 'U6 one flag: HIIT and plyos stay')
ok(JSON.stringify(ex(r1, 'Back Squat')) === JSON.stringify(ex(off.out, 'Back Squat')), 'U6: the main lift is untouched')
ok((r1.prescription.adjustments ?? []).every((a) => a.rule_refs.includes('U6') && a.reason.length > 0), 'U6: each adjustment explains itself with its rule')
ok(r1.prescription.readiness?.flags.length === 1 && (r1 as { readiness?: unknown }).readiness != null, 'U6: readiness is on the prescription and the response')
ok(r1.version !== onEmpty.out.version && r1.program_version !== onEmpty.out.program_version, 'U6: the versions move so the app refetches')
ok(JSON.stringify((await rx()).out) === JSON.stringify(r1), 'U6: deterministic')

await checkin({ sleep_hours: 5, stress: 4 })
const r2 = (await rx()).out
ok(r2.prescription.readiness?.level === 'pull_hiit_plyo', 'U6: two flags → pull HIIT/plyos')
ok(ex(r2, 'Box Jump').skip && ex(r2, 'Assault Bike').skip, 'U6 two flags: HIIT and plyos pulled')
ok(ex(r2, 'Walking Lunge').sets === 2, 'U6 two flags: accessories still trimmed')
ok(!ex(r2, 'Back Squat').skip && ex(r2, 'Back Squat').load === ex(off.out, 'Back Squat').load, 'U6 two flags: the main lift is kept')
const adj2 = r2.prescription.adjustments ?? []
ok(adj2.findIndex((a) => a.action === 'skip') < adj2.findIndex((a) => a.action === 'trim_sets'), 'U6: cut order — HIIT/plyos before accessories')

await checkin({ date: addDays(T, -2), sleep_hours: 5 })
await checkin({ date: addDays(T, -1), sleep_hours: 5.5 })
await checkin({ sleep_hours: 5, stress: 2 })
const r3 = (await rx()).out
ok(r3.prescription.readiness?.flags.map((f) => f.kind).join() === 'sleep,sleep_streak', 'U6 multi-day: 3 short nights count as a second flag')
ok(ex(r3, 'Assault Bike').skip, 'U6 multi-day: two flags pull HIIT')
await checkin({ date: addDays(T, -1), sleep_hours: 8 })
ok((await rx()).out.prescription.readiness?.flags.length === 1, 'U6 multi-day: a good night breaks the streak')
await checkin({ sleep_hours: 8, stress: 2, soreness: 2 })
const r4 = (await rx()).out
ok((r4.prescription.adjustments ?? []).length === 0 && ex(r4, 'Walking Lunge').sets === 3, 'U6: no flags → no adjustments')

// ---- U7 -----------------------------------------------------------------------------------------
await checkin({ pain: [{ region: 'knee', score: 3 }] })
const p3 = (await rx()).out
ok(ex(p3, 'Back Squat').load === ex(off.out, 'Back Squat').load && !ex(p3, 'Box Jump').skip, 'U7 ≤ 3: proceed')
await checkin({ pain: [{ region: 'knee', score: 4 }] })
const p4 = (await rx()).out
const squatOff = ex(off.out, 'Back Squat').load!
ok(ex(p4, 'Back Squat').load! < squatOff && ex(p4, 'Back Squat').load === Math.round((squatOff * 0.9) / 5) * 5, 'U7 4–5: knee load −10% on the squat')
ok(ex(p4, 'Box Jump').skip && (p4.prescription.adjustments ?? []).some((a) => a.exercise === 'Box Jump' && a.rule_refs.includes('U7')), 'U7 4–5: impact dropped for the knee')
ok(!ex(p4, 'Dumbbell Row').skip && ex(p4, 'Dumbbell Row').sets === 3, 'U7 4–5: other regions untouched')
ok(p4.prescription.readiness?.regions.find((x) => x.region === 'knee')?.status === 'capped', 'U7 4–5: the knee reads capped')
ok((await harness.query<{ status: string }>(`SELECT status FROM region_status WHERE athlete_id = $1 AND region = 'knee' ORDER BY created_at DESC LIMIT 1`, [A]))[0]?.status === 'capped', 'U7: region_status records the change')
await checkin({ pain: [{ region: 'knee', score: 1 }] })

const elbow = await checkin({ pain: [{ region: 'elbow', score: 6 }] })
ok(elbow.ok && elbow.text.includes('clinician') && elbow.refer_out != null, 'U7 > 5: blocked, with a refer-out notice')
const p6 = (await rx()).out
ok(ex(p6, 'Dumbbell Row').skip && ex(p6, 'Dumbbell Row').load == null, 'U7 > 5: no loading of the elbow')
ok(p6.prescription.readiness?.blocked_regions.includes('elbow') && p6.prescription.readiness?.refer_out != null, 'U7 > 5: response names the block and refers out')
const zorb = (p6.prescription.adjustments ?? []).find((a) => a.exercise === 'Zorblax Press')
ok(zorb?.action === 'check_region' && !ex(p6, 'Zorblax Press').skip, 'U7: an exercise the table can\'t place is flagged, not silently loaded')

await checkin({ date: addDays(T, -1), pain: [{ region: 'shoulder', score: 4 }] })
await checkin({ pain: [{ region: 'shoulder', score: 5 }] })
ok(ex((await rx()).out, 'Lateral Raise').skip, 'U7: worse than yesterday → shoulder blocked')

const ankle = await checkin({ pain: [{ region: 'ankle', score: 2, red_flags: ['swelling'] }] })
ok(ankle.ok && ankle.regions?.find((x) => x.region === 'ankle')?.status === 'blocked', 'U7: a red flag blocks at 2/10')
ok((await checkin({ pain: [{ region: 'ankle', score: 9, red_flags: ['made_up'] }] })).ok === false, 'check-in: unknown red flags are refused')
await checkin({ pain: [{ region: 'ankle', score: 0 }] })
await checkin({ date: addDays(T, -1), pain: [{ region: 'ankle', score: 0 }] })
const stillBlocked = (await rx()).out
ok(stillBlocked.prescription.readiness?.blocked_regions.includes('ankle') && ex(stillBlocked, 'Box Jump').skip, 'U7: the block persists after a 0/10 day')
ok(await call('preview_program_edits', { edits: [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Calf Raise', sets: 3, reps: '12', load: 'moderate' }] }).then((t) => t.startsWith('Refused (U7)')), 'U7: a preview loading a blocked region is refused')

// No coach can clear a block.
ok(!(await clearRegion(storeA, coachA, 'ankle')).ok, 'clear: an MCP coach can\'t clear a block')
ok(!(await clearRegion(storeA, appCoach, 'ankle')).ok, 'clear: app_coach can\'t clear a block')
ok((await call('clear_region', { region: 'ankle' })).includes('Unknown tool'), 'clear: there is no coach tool for it')
ok((await call('preview_methodology_override', { path: 'U7.regions.ankle.blocked', value: false })).startsWith('Refused'), 'clear: nor through a rule override')
ok((await rx()).out.prescription.readiness?.blocked_regions.includes('ankle') === true, 'clear: still blocked after the coaches tried')
// The athlete can.
const cleared = await clearRegion(storeA, athleteA, 'ankle')
ok(cleared.ok, 'clear: the athlete marks it cleared by a clinician')
const [clearRow] = await harness.query<{ tool: string; actor_type: string; approval_ref: string; rule_refs: string[] }>(`SELECT tool, actor_type, approval_ref, rule_refs FROM change_log WHERE id = $1`, [cleared.change_id])
ok(clearRow?.tool === 'clear_region' && clearRow.actor_type === 'athlete' && /^tap:/.test(clearRow.approval_ref), 'clear: logged with the athlete\'s tap')
ok(!(await rx()).out.prescription.readiness?.blocked_regions.includes('ankle'), 'clear: the ankle loads again')
ok(!(await clearRegion(storeA, athleteA, 'ankle')).ok, 'clear: once')
let appendOnly = false
try { await harness.query(`UPDATE checkin SET sleep_hours = 9 WHERE athlete_id = $1`, [A]) } catch { appendOnly = true }
ok(appendOnly, 'checkin is append-only')
let clearedOnce = false
try { await harness.query(`UPDATE region_status SET cleared_at = NULL, cleared_by = NULL WHERE region = 'ankle' AND cleared_at IS NOT NULL`) } catch { clearedOnce = true }
ok(clearedOnce, 'region_status: a clear can\'t be undone in the table')

// ---- raised caps: adults only ------------------------------------------------------------------------
const override = (athlete: string, path: string) => harness.query(
  `INSERT INTO methodology_override (athlete_id, methodology_version, path, value, actor_type, actor_id, approval_ref, preview_id, change_id)
   VALUES ($1::uuid, 'v1', $2, 'true'::jsonb, 'athlete', $1::text, 'tap:synthetic', 'chp_synthetic', gen_random_uuid())`, [athlete, path])
await sql`UPDATE athlete SET birth_date = ${addDays(T, -30 * 365)}::date WHERE id = ${A}`
await override(A, 'U7.regions.groin.raised_cap')
const groin = await checkin({ pain: [{ region: 'groin', score: 5 }] })
ok(groin.regions?.find((x) => x.region === 'groin')?.status === 'ok', 'raised cap: an adult\'s groin at 5/10 proceeds')
const groinFlag = await checkin({ pain: [{ region: 'groin', score: 2, red_flags: ['locking'] }] })
ok(groinFlag.regions?.find((x) => x.region === 'groin')?.status === 'blocked', 'raised cap: a red flag still blocks')
await flag(B, true)
await sql`UPDATE athlete SET birth_date = ${addDays(T, -15 * 365)}::date WHERE id = ${B}`
await override(B, 'U7.regions.knee.raised_cap')
const minor = await checkin({ pain: [{ region: 'knee', score: 5 }] }, storeB, athleteB)
ok(minor.ok && minor.regions?.find((x) => x.region === 'knee')?.status === 'capped', 'minors: never a raised cap (5/10 regresses)')

// ---- health-data toggle (D3) -----------------------------------------------------------------------
const seen = await call('get_checkins', { since: addDays(T, -3) }, coachA)
ok(seen.includes('"sleep_hours"') && seen.includes('"knee"'), 'health on: the coach sees check-ins and pain')
ok((await call('get_region_status', {}, coachA)).includes('"elbow"'), 'health on: the coach sees region status')
ok(!(await setCoachHealth(storeA, coachA, TOKEN_A_ID, false)).ok, 'toggle: a coach can\'t change it')
ok(!(await setCoachHealth(storeA, athleteA, TOKEN_B_ID, false)).ok, 'toggle: not on another athlete\'s coach')
const turnedOff = await setCoachHealth(storeA, athleteA, TOKEN_A_ID, false)
ok(turnedOff.ok && await count('change_log', `id = $1 AND tool = 'set_coach_health_access'`, [turnedOff.change_id]) === 1, 'toggle: the athlete turns it off, logged')
ok((await call('get_checkins', { since: addDays(T, -3) }, coachA)) === HEALTH_HIDDEN, 'health off: get_checkins hidden from that coach')
ok((await call('get_region_status', {}, coachA)) === HEALTH_HIDDEN, 'health off: get_region_status hidden from that coach')
const hiddenReview = JSON.parse(await call('get_weekly_review', {}, coachA)) as { pain: unknown; checkins: unknown; health_hidden?: boolean; why: string }
ok(hiddenReview.pain === null && hiddenReview.checkins === null && hiddenReview.health_hidden === true, 'health off: the review has no pain or check-in sections')
ok(!/elbow|knee|shoulder|sleep/.test(hiddenReview.why), 'health off: the review\'s why names no health input')
const hiddenLog = await call('get_change_log', { since: addDays(T, -7), target: 'checkin' }, coachA)
ok(!hiddenLog.includes('"score"') && !hiddenLog.includes('sleep_hours') && hiddenLog.includes('not shared with you'), 'health off: check-in rows in the change log are redacted')
ok((await call('get_checkins', { since: addDays(T, -3) }, coachA2)).includes('"sleep_hours"'), 'health off for one coach: the other still sees it')
ok((await call('get_change_log', { since: addDays(T, -7), target: 'checkin' }, coachA2)).includes('"score"'), 'health on: change log rows are whole')

// ---- rollback: flag off again → exactly as before ---------------------------------------------------
await flag(A, false)
const back = await rx()
ok(back.text === off.text, 'rollback: flag off → C day byte-identical to before, rows ignored')
ok((await rx(A, A_DAY)).text === offA.text, 'rollback: A day byte-identical')
const readsNow = await count('coach_read_log')
await call('get_athlete', {}, coachA)
ok(await count('coach_read_log') === readsNow, 'rollback: no read logging with the flag off')
await flag(A, true)
// ---- weekly review (synthetic weeks) -------------------------------------------------------------
const W1 = addDays(M, -21)
const W2 = addDays(M, -14)
const W3 = addDays(M, -7)
const workout = (routine: string, date: string, weight: number) => harness.query(
  `INSERT INTO workout (routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
   VALUES ($1, $2::timestamptz, 8, 45, $3::jsonb, '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy"}]'::jsonb)`,
  [routine, `${date}T19:00:00Z`, JSON.stringify({ 0: [{ set: 1, weight, reps: 5, rpe: 8, done: true }] })],
)
// The seed's synthetic workout sits on a fixed date; these weeks move with today.
await harness.query(`DELETE FROM session_observation WHERE workout_id = '99999999-9999-9999-9999-999999999999'`)
await harness.query(`DELETE FROM workout WHERE id = '99999999-9999-9999-9999-999999999999'`)
await workout(A_DAY, addDays(W1, -6), 200)
await workout(A_DAY, addDays(W1, 1), 210)
await workout(C_DAY, addDays(W1, 3), 215)
await workout(A_DAY, addDays(W2, 2), 220)
await workout(A_DAY, addDays(W3, 1), 205)
await workout(C_DAY, addDays(W3, 3), 205)
type Review = { compliance: { planned: number; logged: number; ratio: number; met: boolean }; priority_lifts: LiftTrend[]; call: string; rule_refs: string[]; why: string; week_start: string }
const review = async (week: string, actor: OverrideActor = coachA2) => JSON.parse(await call('get_weekly_review', { week }, actor)) as Review
const w1 = await review(addDays(W1, 4))
ok(w1.week_start === W1 && w1.compliance.planned === 2 && w1.compliance.logged === 2 && w1.compliance.met, 'review: compliance 2/2 planned vs logged')
ok(w1.priority_lifts.find((l) => l.lift === 'squat')?.trend === 'up', 'review: the priority lift\'s e1RM trend')
ok(w1.call === 'progress' && w1.rule_refs.includes('U15') && w1.why.startsWith('Progress:'), 'review: all good → progress, with rules and a why')
const w2 = await review(W2)
ok(w2.compliance.ratio === 0.5 && w2.call === 'deload' && w2.rule_refs.includes('U11'), 'review: 1 of 2 sessions → deload (U11)')
const w3 = await review(W3)
ok(w3.compliance.met && w3.priority_lifts.find((l) => l.lift === 'squat')?.trend === 'down' && w3.call === 'hold' && w3.rule_refs.includes('U5'), 'review: e1RM down → hold (U5)')
const [appReview] = await athleteReadinessAction(storeA, { action: 'weekly_review', week: W1 })
ok((appReview as Review).call === 'progress', 'review: the app route gives the same review')
const thisWeek = JSON.parse(await call('get_weekly_review', {}, coachA2)) as { pain: { regions: Array<{ region: string }>; blocked: string[] }; checkins: { days: number } }
ok(thisWeek.pain.blocked.includes('elbow') && thisWeek.checkins.days >= 1, 'review: pain trend and check-in averages this week')
const writesBefore = await count('change_log')
await review(W1)
ok(await count('change_log') === writesBefore, 'review: read-only')

// ---- isolation -------------------------------------------------------------------------------------
const bView = (await athleteReadinessAction(storeB, { action: 'today' }))[0] as { checkin: unknown; pain: Array<{ region: string }>; blocked: Array<{ region: string }> }
ok(bView.checkin === null && bView.pain.every((p) => p.region === 'knee') && !bView.blocked.some((x) => x.region === 'elbow'), 'isolation: B sees none of A\'s check-ins, pain or blocks')
const bCoach = await call('get_checkins', { since: addDays(T, -7) }, coachB, B)
ok(!bCoach.includes('"sleep_hours": 5') && !bCoach.includes('elbow'), 'isolation: B\'s coach reads none of A\'s rows')
ok(!(await clearRegion(storeB, athleteB, 'elbow')).ok, 'isolation: B can\'t clear A\'s block')
ok((await rx()).out.prescription.readiness?.blocked_regions.includes('elbow') === true, 'isolation: A\'s block untouched by B')
const bRx = await rx(B, B_DAY)
ok(!bRx.text.includes('elbow') && !bRx.text.includes('shoulder') && !bRx.text.includes('groin'), 'isolation: B\'s prescription knows nothing of A')
ok(((await rx(A, B_DAY)).out as unknown as { error?: string }).error === 'not found', 'isolation: A can\'t prescribe B\'s session')
const bAccess = (await athleteReadinessAction(storeB, { action: 'coach_access' }))[0] as { coaches: Array<{ id: string }>; reads: Array<{ actor_id: string }> }
ok(bAccess.coaches.every((c) => c.id === TOKEN_B_ID) && bAccess.reads.every((r) => r.actor_id === TOKEN_B_ID), 'isolation: B\'s coach access lists only B\'s coach and reads')
ok(await count('coach_read_log', `athlete_id = $1 AND actor_id <> $2`, [B, TOKEN_B_ID]) === 0, 'isolation: B\'s read log has only B\'s coach')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
