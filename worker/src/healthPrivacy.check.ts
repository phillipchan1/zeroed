// Round 2 PR 1 (spec section 11) against a real schema: the refused preview
// that named a blocked region to a coach without health access, session RPE
// as health data, the U4 e1RM method, and the under-18 contact ceiling.
//
//   Flag off: every surface is exactly as before, whatever a coach's health
//   toggle says (no redaction, no e1RM method, chart-at-RPE-10 numbers).
//   Flag on, a coach with share_health = false: refusals and warnings on
//   program edits, week-only overrides, proposals and methodology overrides
//   say HEALTH_HELD_TEXT, never the region or pain; get_methodology, the change
//   log, get_lift_model and get_workout leave health out; session RPE stays
//   hidden and every read is logged. The athlete, app_coach and a coach with
//   the toggle on still see the region.
//   U4: RPE-chart e1RM with an RPE, Epley without, the method recorded.
//   Minors: 60 contacts a session (v1.1, kept in v1.2), tighten-only; v1 and v1.1 still resolve.
//   Athletes A and B never see each other's rows.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/healthPrivacy.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { createApproval } from './approvals.ts'
import { athleteOverrideAction, athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { saveCheckin, setCoachHealth } from './readiness.ts'
import { addDays } from './readiness/rules.ts'
import { logSessionRpe, SESSION_RPE_HIDDEN } from './sessionRpe.ts'
import { HEALTH_PATH_HIDDEN } from './methodology.ts'
import { HEALTH_HELD_TEXT } from './methodology/validators.ts'
import { checkOverride, engineParams, resolveParams } from './methodology/resolve.ts'
import { CURRENT_METHODOLOGY, METHODOLOGIES, METHODOLOGY_V1, METHODOLOGY_V1_1, METHODOLOGY_V1_2 } from './methodology/v1.ts'
import { compose, type ComposeInput } from './coach/composer.ts'
import { redactHealth } from './activities.ts'
import { redactHealthText } from './regionStatus.ts'
import {
  allTimeBest, buildLiftModel, epleyE1rm, estimateE1rm, renderLiftModel, workingMaxAsOf, type LiftSet,
} from '../../src/engine/liftModel.ts'
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
const A_WORKOUT = '99999999-9999-9999-9999-999999999999'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_A2_ID = 'aaaa6666-0000-4000-8000-0000000000a2'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const coachOn: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachOff: OverrideActor = { type: 'mcp', id: TOKEN_A2_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const appCoach: OverrideActor = { type: 'app_coach', id: 'app_coach' }
const athleteA: OverrideActor = { type: 'athlete', id: A }

const T = await athleteToday(storeA)

await harness.query(
  `INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'private coach', 'hash-a2', 'aaa2')`,
  [TOKEN_A2_ID, A],
)
// Synthetic log: a deadlift with no RPE (the U4 fallback), and a debrief pain signal.
await harness.query(
  `INSERT INTO workout (routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
   VALUES ($1, NOW() - interval '3 days', NULL, 40, '{"0":[{"set":1,"weight":300,"reps":5,"done":true}]}'::jsonb,
           '[{"name":"Deadlift","sets":1,"reps":"5","load":"heavy"}]'::jsonb)`,
  [A_DAY],
)
await harness.query(
  `INSERT INTO session_observation (workout_id, category, signal, severity) VALUES ($1, 'Pain signal', 'Synthetic knee ache on the descent', 4)`,
  [A_WORKOUT],
)

const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachOn, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const reads = (actorId: string, tool: string) => count('coach_read_log', 'athlete_id = $1 AND actor_id = $2 AND tool = $3', [A, actorId, tool])
const chp = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? /preview_id: (chp_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const sop = (text: string) => /preview_id: (sop_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const tap = async (previewId: string) => {
  const r = await createApproval(storeA, athleteA, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
/** Nothing that names a region or carries a pain number. */
const leaks = (text: string) => /knee|ankle|achilles|hip\b|elbow|Red flag:|red-flag|\d\/10|pain \d/i.test(text)

const boxJump = [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' }]
const jumpOp = (date: string) => ({ date, session: 'A day', ops: [{ op: 'add', exercise: { name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' } }] })

// ---- pure: U4 ------------------------------------------------------------------------------------
near(epleyE1rm(300, 5)!, 350, 'Epley: 300×5 → 350')
ok(epleyE1rm(300, 1) === 300 && epleyE1rm(300, 13) == null && epleyE1rm(0, 5) == null, 'Epley: a single is its weight; off the 1–12 range is null')
const chart = estimateE1rm(365, 1, 8)!
ok(chart.method === 'rpe_chart' && Math.abs(chart.e1rm - 365 / 0.922) < 1e-6, 'U4: a set with an RPE reads off the chart, method rpe_chart')
ok(estimateE1rm(300, 5, null, 'epley')!.method === 'epley' && estimateE1rm(300, 5, null, 'epley')!.e1rm === 350, 'U4 v1.1: no RPE → Epley, method epley')
ok(estimateE1rm(300, 5, 8, 'epley')!.method === 'rpe_chart', 'U4 v1.1: an RPE still wins over Epley')
const floor = estimateE1rm(300, 5, null)!
ok(floor.method === 'rpe_chart' && Math.abs(floor.e1rm - 300 / 0.863) < 1e-6, 'U4 default (v1, flag off): no RPE reads at RPE 10 on the chart')

const s = (exercise: string, date: string, weight: number, reps: number, rpe: number | null): LiftSet => ({
  lift: exercise === 'Deadlift' ? 'deadlift' : 'squat', exercise, date, weight, reps, rpe, missedReps: 0, workoutId: null,
})
const TODAY = '2026-11-04'
const noRpeLog = [s('Deadlift', '2026-11-01', 300, 5, null)]
const wmFloor = workingMaxAsOf(noRpeLog, 'deadlift', TODAY, false)!
const wmEpley = workingMaxAsOf(noRpeLog, 'deadlift', TODAY, false, 'epley')!
ok(wmFloor.basis === 'no_rpe_floor' && !('e1rmMethod' in wmFloor.anchor) && Math.abs(wmFloor.anchor.e1rm - 300 / 0.863) < 1e-6, 'working max, no params: floor at RPE 10, no method field (today\'s objects)')
ok(wmEpley.anchor.e1rmMethod === 'epley' && wmEpley.anchor.e1rm === 350, 'working max, v1.1: Epley, method recorded on the anchor')
const mixed = [...noRpeLog, s('Deadlift', '2026-10-30', 315, 3, 8)]
ok(workingMaxAsOf(mixed, 'deadlift', TODAY, false, 'epley')!.anchor.e1rmMethod === 'rpe_chart', 'working max, v1.1: qualifying RPE sets still read off the chart')
ok(allTimeBest(noRpeLog, 'deadlift', false, 'epley')!.e1rmSet.e1rmMethod === 'epley' && allTimeBest(noRpeLog, 'deadlift', false)!.e1rmSet.e1rmMethod === undefined, 'all-time best: method only with v1.1')
const modelOff = buildLiftModel({ lift: 'deadlift', sets: noRpeLog, today: TODAY, rpeHalfSteps: false })
const modelOn = buildLiftModel({ lift: 'deadlift', sets: noRpeLog, today: TODAY, rpeHalfSteps: false, params: { e1rmNoRpe: 'epley' } })
ok(JSON.stringify(buildLiftModel({ lift: 'deadlift', sets: noRpeLog, today: TODAY, rpeHalfSteps: false, params: {} })) === JSON.stringify(modelOff), 'lift model: params without e1rmNoRpe is byte-identical to no params')
ok(!JSON.stringify(modelOff).includes('e1rmMethod') && !renderLiftModel(modelOff).includes('Epley') && renderLiftModel(modelOff).includes('read at RPE 10'), 'lift model, no params: no method anywhere, the RPE-10 floor note')
ok(renderLiftModel(modelOn).includes('e1RM 350 (Epley)') && renderLiftModel(modelOn).includes('by Epley (U4)'), 'lift model, v1.1: the estimate says Epley')

// ---- pure: methodology v1.1, minors -------------------------------------------------------------
ok(CURRENT_METHODOLOGY.version === 'v1.2' && METHODOLOGIES.v1 === METHODOLOGY_V1 && METHODOLOGIES['v1.1'] === METHODOLOGY_V1_1, 'versions: v1.2 is current, v1 and v1.1 still resolve')
ok(METHODOLOGY_V1_2.minors.contacts_per_session_max === 60 && METHODOLOGY_V1_2.params.U4.e1rm_without_rpe === 'epley' && JSON.stringify(METHODOLOGY_V1_2.params.U15) === JSON.stringify(METHODOLOGY_V1_1.params.U15), 'v1.2: minors 60, U4 and U15 as v1.1')
ok(METHODOLOGY_V1.minors.contacts_per_session_max === 80 && METHODOLOGY_V1.params.U4.e1rm_without_rpe === undefined, 'v1 is untouched (80, chart at RPE 10)')
ok(METHODOLOGY_V1_1.minors.contacts_per_session_max === 60 && METHODOLOGY_V1_1.params.U4.e1rm_without_rpe === 'epley', 'v1.1: minors 60 contacts, U4 Epley fallback')
ok(JSON.stringify({ ...METHODOLOGY_V1_1.params, U4: METHODOLOGY_V1.params.U4 }) === JSON.stringify(METHODOLOGY_V1.params), 'v1.1: no other param moved (U6, U7, U15 thresholds unchanged)')
ok(engineParams(resolveParams(METHODOLOGY_V1, [], { minor: false })).e1rmNoRpe === undefined, 'v1 engine params: no e1RM fallback (today\'s math)')
ok(engineParams(resolveParams(METHODOLOGY_V1_1, [], { minor: false })).e1rmNoRpe === 'epley', 'v1.1 engine params: Epley fallback')
const kid = resolveParams(METHODOLOGY_V1_1, [], { minor: true })
ok(Object.values(kid.params.U14.contacts_per_session).every(([lo, hi]) => hi <= 60 && lo <= hi), 'minor (v1.1): every contact band tops out at 60')
ok(resolveParams(METHODOLOGY_V1, [], { minor: true }).params.U14.contacts_per_session.advanced[1] === 80, 'minor (v1): still 80, for history')
const ov = (path: string, value: unknown) => ({ id: path, track_id: null, path, value })
ok(resolveParams(METHODOLOGY_V1_1, [ov('minors.contacts_per_session_max', 50)], { minor: true }).params.U14.contacts_per_session.advanced[1] === 50, 'minors: a coach lowers it to 50')
const stale = resolveParams(METHODOLOGY_V1_1, [ov('minors.contacts_per_session_max', 70)], { minor: true })
ok(stale.minors.contacts_per_session_max === 60 && stale.params.U14.contacts_per_session.advanced[1] === 60 && stale.version === 'v1.1+' + stale.version.split('+')[1] && stale.applied.length === 0, 'minors: an override set under v1 (70) never loosens v1.1\'s 60')
const guard = (value: number, minor: boolean | null) => checkOverride({
  path: 'minors.contacts_per_session_max', value, clear: false, trackId: null, actorType: 'mcp', exists: false, minor,
  now: resolveParams(METHODOLOGY_V1_1, [], { minor: minor === true }), withoutThis: resolveParams(METHODOLOGY_V1_1, [], { minor: minor === true }),
})
const up = guard(70, true)
ok(!up.ok && up.text.includes('only be tightened'), 'minors: raising the ceiling to 70 is refused (tighten-only)')
ok(!guard(70, false).ok, 'minors: refused for an adult\'s rules too (the under-18 rules only tighten)')
ok(guard(50, true).ok, 'minors: lowering to 50 passes')
const fixed = checkOverride({ path: 'U4.e1rm_without_rpe', value: 'rpe10_floor', clear: false, trackId: null, actorType: 'athlete', exists: false, minor: false, now: kid, withoutThis: kid })
ok(!fixed.ok && fixed.text.includes('methodology version'), 'U4: the e1RM fallback can\'t be overridden')

// ---- pure: composer purposes and lift-model text ----------------------------------------------
const P = METHODOLOGY_V1_1.params
const composeInput: ComposeInput = {
  start: '2026-11-09',
  activities: [{ id: 'act-run', module: 'endurance', name: 'Synthetic running', sessions_per_week: 1, season: 'in', days: [5] }],
  goals: [{ id: 'goal-10k', name: 'Synthetic 10k', test: '10k time', weight: 'priority', quality: 'aerobic', due_date: '2027-03-01' }],
  schedule: { days_per_week: 4, minutes_per_session: 60, rest_days: [] },
  training_age: '3to10', minor: false, age: 30, injuries: [], blocked_regions: ['knee'],
  params: P, minors: METHODOLOGY_V1_1.minors,
}
const composed = compose(composeInput)
ok(composed.tracks.some((t) => /knee/.test(t.why)), 'composer: the full block names the red-flagged region (athlete view)')
ok(redactHealth(composed).tracks.every((t) => !/knee|red-flagged/i.test(t.why)), 'composer: the purposes written to tracks (redacted why) never name it')
const liftText = 'Skip today. knee pain 6/10 → skip jumps today · hold: knee pain 6/10 on Nov 2 · pain flag on Oct 30 · 5h sleep, readiness 4/10 → −5%'
ok(!/\d\/10|\dh sleep|pain flag/.test(redactHealthText(liftText)) && redactHealthText('245 = 65% of TM 377') === '245 = 65% of TM 377', 'lift-model text: health inputs out, the numbers stay')

// ---- flag OFF: exactly as before, toggle or not -------------------------------------------------
await sql`UPDATE mcp_token SET share_health = false WHERE id = ${TOKEN_A2_ID}`
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list unchanged')
const offSurfaces = async (actor: OverrideActor) => Promise.all([
  call('preview_program_edits', { edits: boxJump }, actor),
  call('get_lift_model', { lift: 'all', knee_pain_l: 6 }, actor),
  call('search_lifts', { exercise: 'deadlift' }, actor),
  call('get_workout', { workout_id: A_WORKOUT }, actor),
])
const offOn = await offSurfaces(coachOn)
const offOff = await offSurfaces(coachOff)
ok(JSON.stringify(offOff) === JSON.stringify(offOn), 'flag off: a coach with health off sees byte-for-byte what one with it on sees')
ok(!offOn[0].includes('Refused') && !offOn[0].includes('preview_id'), 'flag off: no validators, no kept preview')
ok(offOn[1].includes('knee pain 6/10') && !/Epley|RPE chart/.test(offOn[1]) && offOn[1].includes('read at RPE 10'), 'flag off: get_lift_model as before (chart at RPE 10, no method)')
ok(offOn[2].includes('(e1RM 348)') && offOn[2].includes('no RPE reads as @10') && !/Epley|RPE chart\)/.test(offOn[2].replace('RPE chart; no RPE', '')), 'flag off: search_lifts reads the RPE-less deadlift at RPE 10 (348), no method')
ok(offOn[3].includes('Pain signal: Synthetic knee ache'), 'flag off: get_workout lists every observation')
ok(await count('change_log') === 0 && await count('coach_read_log') === 0, 'flag off: nothing written')

// ---- flag ON ------------------------------------------------------------------------------------
await flag(A, true)
await flag(B, true)
ok((await setCoachHealth(storeA, athleteA, TOKEN_A2_ID, true)).ok && (await setCoachHealth(storeA, athleteA, TOKEN_A2_ID, false)).ok, 'toggle: health off for the private coach (logged)')
await harness.query(`UPDATE athlete SET birth_date = '1990-01-01' WHERE id = $1`, [A])
// v1.2: over 5 twice within 14 days is a persistent block (one alone lapses after the next session).
await saveCheckin(storeA, athleteA, { date: addDays(await athleteToday(storeA), -3), pain: [{ region: 'knee', score: 7 }] })
const blocked = await saveCheckin(storeA, athleteA, { pain: [{ region: 'knee', score: 7 }] })
ok(blocked.ok, 'setup: the athlete\'s knee is blocked (pain > 5, twice in 14 days)')
await harness.query(
  `INSERT INTO methodology_override (athlete_id, methodology_version, path, value, actor_type, actor_id, approval_ref, preview_id, change_id)
   VALUES ($1::uuid, 'v1.1', 'U7.regions.ankle.blocked', 'true'::jsonb, 'athlete', $1::text, 'tap:synthetic', 'chp_synthetic', gen_random_uuid())`, [A],
)

// U4 surfaces, flag on.
const onModel = await call('get_lift_model', { lift: 'deadlift' })
ok(onModel.includes('e1RM 350 (Epley)') && onModel.includes('by Epley (U4)'), 'U4 on: get_lift_model reads the RPE-less deadlift by Epley and says so')
ok((await call('get_lift_model', { lift: 'squat' })).includes('(RPE chart)'), 'U4 on: an RPE\'d estimate says RPE chart')
const onSearch = await call('search_lifts', { exercise: 'deadlift' })
ok(onSearch.includes('(e1RM 350, Epley)') && onSearch.includes('Epley when no RPE is logged (U4)'), 'U4 on: search_lifts records the method per estimate')
const review = JSON.parse(await call('get_weekly_review', {})) as { methodology_version: string; priority_lifts: Array<{ lift: string; e1rm_week_method: string | null; e1rm_prior_method: string | null }> }
ok(review.methodology_version.startsWith('v1.2') && review.priority_lifts.every((l) => 'e1rm_week_method' in l && 'e1rm_prior_method' in l), 'U4 on: the weekly review records the method beside each e1RM, on v1.2')
const meth = JSON.parse(await call('get_methodology', {})) as { methodology_version: string; params: { U4: { e1rm_without_rpe: string } }; minors: { contacts_per_session_max: number } }
ok(meth.methodology_version.startsWith('v1.2') && meth.params.U4.e1rm_without_rpe === 'epley' && meth.minors.contacts_per_session_max === 60, 'get_methodology: v1.2, U4 Epley fallback, minors 60')
ok((await call('preview_methodology_override', { path: 'minors.contacts_per_session_max', value: 70 })).includes('only be tightened'), 'MCP: raising the minors ceiling is refused')
ok(chp(await call('preview_methodology_override', { path: 'minors.contacts_per_session_max', value: 50 })) !== '', 'MCP: lowering it previews')

// Program edits: a held region.
const editOn = await call('preview_program_edits', { edits: boxJump }, coachOn)
const editOff = await call('preview_program_edits', { edits: boxJump }, coachOff)
ok(editOn.startsWith('Refused (U7)') && editOn.includes('knee'), 'program edits, health on: refused, naming the region')
ok(editOff.startsWith('Refused (U7)') && editOff.includes(HEALTH_HELD_TEXT) && !leaks(editOff), 'program edits, health off: refused generically, no region, no pain')
ok(editOff.includes('A day'), 'program edits, health off: still says which session')
ok((await call('preview_program_edits', { edits: boxJump }, athleteA)).includes('knee'), 'program edits, the athlete: names the region')
ok((await call('preview_program_edits', { edits: boxJump }, appCoach)).includes('knee'), 'program edits, app_coach: unchanged, names the region')
const parkOff = await call('preview_program_edits', { edits: boxJump, propose: true, title: 'Add jumps.' }, coachOff)
ok(parkOff.startsWith('Refused (U7)') && !leaks(parkOff) && !parkOff.includes('Parked'), 'proposal (propose=true), health off: refused generically, nothing parked')
const crossCoach = await call('preview_program_edits', { edits: boxJump }, coachB)
ok(!leaks(crossCoach), 'isolation: another athlete\'s coach token never sees A\'s region')

// Week-only overrides.
const ovOn = await call('preview_session_override', jumpOp(addDays(T, 1)), coachOn)
const ovOff = await call('preview_session_override', jumpOp(addDays(T, 1)), coachOff)
ok(ovOn.startsWith('Refused (U7)') && ovOn.includes('knee'), 'session override, health on: names the region')
ok(ovOff.startsWith('Refused (U7)') && ovOff.includes(HEALTH_HELD_TEXT) && !leaks(ovOff), 'session override, health off: generic, no region')
const [ovAthlete] = await athleteOverrideAction(storeA, { action: 'preview', ...jumpOp(addDays(T, 1)) })
ok(JSON.stringify(ovAthlete).includes('knee'), 'session override, the athlete\'s own route: names the region')

// Methodology overrides on a region.
const raiseOn = await call('preview_methodology_override', { path: 'U7.regions.ankle.raised_cap', value: true }, coachOn)
ok(raiseOn.includes('ankle has a red flag'), 'methodology, health on: the red-flag refusal names the region')
const raiseOff = await call('preview_methodology_override', { path: 'U7.regions.ankle.raised_cap', value: true }, coachOff)
const raiseOffClean = await call('preview_methodology_override', { path: 'U7.regions.elbow.raised_cap', value: true }, coachOff)
ok(raiseOff === HEALTH_PATH_HIDDEN && raiseOffClean === HEALTH_PATH_HIDDEN, 'methodology, health off: the same generic refusal for a red-flagged region and a clear one')
ok(await call('preview_methodology_override', { path: 'U7.regions.knee.blocked', value: true }, coachOff) === HEALTH_PATH_HIDDEN, 'methodology, health off: a region rule can\'t even be previewed')
const viewOn = await call('get_methodology', {}, coachOn)
const viewOff = JSON.parse(await call('get_methodology', {}, coachOff)) as { blocked_regions: unknown; health_hidden?: boolean; params: { U7: { regions: object } }; overrides: Array<{ path: string }> }
ok(viewOn.includes('"ankle"'), 'get_methodology, health on: the red-flagged region')
ok(viewOff.blocked_regions === null && viewOff.health_hidden === true && Object.keys(viewOff.params.U7.regions).length === 0 && viewOff.overrides.every((o) => !o.path.startsWith('U7.regions')), 'get_methodology, health off: no regions, no region overrides')
ok(!leaks(JSON.stringify({ ...viewOff, overridable_paths: undefined })), 'get_methodology, health off: nothing names a region (beyond the path schema)')

// A region rule applied with health on; the toggle goes off before the next apply.
const hip = chp(await call('preview_methodology_override', { path: 'U7.regions.hip.blocked', value: true, rationale: 'Synthetic: athlete reported a sharp pain (U7).' }, coachOn))
const hipApplied = await call('apply_methodology_override', { preview_id: hip, confirm: true, approval_ref: await tap(hip) }, coachOn)
ok(hipApplied.startsWith('Set U7.regions.hip.blocked'), 'methodology, health on: a coach sets a red flag with the athlete\'s approval')
const elbow = chp(await call('preview_methodology_override', { path: 'U7.regions.elbow.blocked', value: true }, coachOn))
const elbowRef = await tap(elbow)
await setCoachHealth(storeA, athleteA, TOKEN_A_ID, false)
const before = await count('methodology_override')
ok(await call('apply_methodology_override', { preview_id: elbow, confirm: true, approval_ref: elbowRef }, coachOn) === HEALTH_PATH_HIDDEN && await count('methodology_override') === before, 'methodology apply after the toggle went off: generic refusal, nothing written')
await setCoachHealth(storeA, athleteA, TOKEN_A_ID, true)

// A coach's rationale citing U7 on a non-health change.
const plankOp = { date: addDays(T, 2), session: 'A day', ops: [{ op: 'add', exercise: { name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' } }], rationale: 'Synthetic: knee pain 6/10 today, so core instead (U7).' }
const plank = sop(await call('preview_session_override', plankOp, coachOn))
const plankApplied = await call('apply_session_override', { preview_id: plank, confirm: true, approval_ref: await tap(plank) }, coachOn)
ok(plankApplied.startsWith('Applied'), 'setup: a health-citing week-only change applied')

// Change log.
const logOn = await call('get_change_log', { since: addDays(T, -1), limit: 100 }, coachOn)
const logOff = await call('get_change_log', { since: addDays(T, -1), limit: 100 }, coachOff)
ok(logOn.includes('U7.regions.hip.blocked') && logOn.includes('knee pain 6/10'), 'change log, health on: the region rule and the rationale')
ok(logOff.includes('Pain rule for a region (not shared with you)') && logOff.includes('A health-related reason (not shared with you).'), 'change log, health off: the rows exist, redacted')
ok(!leaks(logOff), 'change log, health off: no region, no pain anywhere')
ok((await call('get_change_log', { since: addDays(T, -1), target: 'U7.regions.hip.blocked' }, coachOff)).includes('health data the athlete hasn\'t shared with you') && (await call('get_change_log', { since: addDays(T, -1), target: 'U7.regions.elbow.blocked' }, coachOff)) === (await call('get_change_log', { since: addDays(T, -1), target: 'U7.regions.hip.blocked' }, coachOff)), 'change log, health off: a region filter answers the same, set or not')
const logB = await call('get_change_log', { since: addDays(T, -1), limit: 100 }, coachB, B)
ok(!logB.includes('U7.regions') && !logB.includes('core instead'), 'isolation: B\'s change log has none of A\'s rows')

// Lift model and workout.
const lmOn = await call('get_lift_model', { lift: 'squat', knee_pain_l: 6 }, coachOn)
const lmOff = await call('get_lift_model', { lift: 'squat', knee_pain_l: 6 }, coachOff)
ok(lmOn.includes('knee pain 6/10'), 'get_lift_model, health on: the knee reading')
ok(!/pain \d|\d\/10 →/.test(lmOff) && lmOff.includes('a health input the athlete hasn\'t shared with you'), 'get_lift_model, health off: the load moves, the reading is withheld')
const wOn = await call('get_workout', { workout_id: A_WORKOUT }, coachOn)
const wOff = await call('get_workout', { workout_id: A_WORKOUT }, coachOff)
ok(wOn.includes('Pain signal: Synthetic knee ache'), 'get_workout, health on: the pain observation')
ok(!wOff.includes('Pain signal') && wOff.includes('A felt good') && wOff.includes('1 health observation the athlete hasn\'t shared with you'), 'get_workout, health off: pain observation withheld, others kept')

// ---- session RPE is health data ----------------------------------------------------------------
ok((await logSessionRpe(storeA, athleteA, { session_id: A_DAY, rating: 7, duration_min: 50 })).ok, 'setup: the athlete taps session RPE 7')
const rpeReadsOff = await reads(TOKEN_A2_ID, 'get_session_rpe')
ok(await call('get_session_rpe', { since: addDays(T, -7) }, coachOff) === SESSION_RPE_HIDDEN, 'session RPE, health off: refused')
ok(await reads(TOKEN_A2_ID, 'get_session_rpe') === rpeReadsOff + 1, 'session RPE, health off: the attempt is still a logged coach read')
const rpeReadsOn = await reads(TOKEN_A_ID, 'get_session_rpe')
ok((await call('get_session_rpe', { since: addDays(T, -7) }, coachOn)).includes('"rating": 7') && await reads(TOKEN_A_ID, 'get_session_rpe') === rpeReadsOn + 1, 'session RPE, health on: shown, and logged')
const reviewOff = JSON.parse(await call('get_weekly_review', {}, coachOff)) as { session_load: unknown; pain: unknown; checkins: unknown; health_hidden?: boolean; why: string }
ok(reviewOff.session_load === null && reviewOff.pain === null && reviewOff.checkins === null && reviewOff.health_hidden === true && !leaks(reviewOff.why), 'weekly review, health off: no session load, pain or check-ins')
ok(await reads(TOKEN_A2_ID, 'get_weekly_review') >= 1, 'weekly review: a logged coach read')
const reviewOn = JSON.parse(await call('get_weekly_review', {}, coachOn)) as { session_load: { rated: number } | null }
ok(reviewOn.session_load?.rated === 1, 'weekly review, health on: session load')
const rpeLogOff = await call('get_change_log', { since: addDays(T, -1), target: 'session_rpe' }, coachOff)
ok(rpeLogOff.includes('Session effort (not shared with you)') && !rpeLogOff.includes('"rating"') && !rpeLogOff.includes('"after"'), 'change log, health off: session RPE rows redacted')
const athleteReads = await count('coach_read_log', 'actor_type = $1', ['athlete'])
await call('get_session_rpe', { since: addDays(T, -7) }, athleteA)
ok(athleteReads === 0 && await count('coach_read_log', 'actor_type = $1', ['athlete']) === 0, 'the athlete\'s own reads are never logged')
ok((await call('get_session_rpe', { since: addDays(T, -7) }, coachB, B)).includes('"sessions": []'), 'isolation: B\'s coach sees none of A\'s ratings')

// ---- isolation: B ------------------------------------------------------------------------------
const bMeth = JSON.parse(await call('get_methodology', {}, coachB, B)) as { blocked_regions: string[]; overrides: unknown[] }
ok(bMeth.blocked_regions.length === 0 && bMeth.overrides.length === 0, 'isolation: B has none of A\'s red flags or overrides')
ok(!(await call('search_lifts', { exercise: 'deadlift' }, coachB, B)).includes('Epley)'), 'isolation: B\'s search_lifts has none of A\'s RPE-less sets')
ok(!(await call('preview_program_edits', { edits: [{ ...boxJump[0], session_name: 'B day' }] }, coachB, B)).startsWith('Refused (U7)'), 'isolation: A\'s blocked knee never refuses B\'s edit')

function near(a: number, b: number, msg: string) {
  ok(Math.abs(a - b) < 1e-6, msg)
}

await harness.close()
console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`health-privacy: ok (${harness.backend})`)
