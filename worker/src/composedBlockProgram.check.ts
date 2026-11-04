// Composed blocks write the week's exercises (Round 2 item 6, coach_v1).
// Pure: the section 4 worked example's week becomes concrete sessions that
// match the layout day by day, the engine's sets/reps/RPE targets and never a
// written load, the G5 validators run as an explicit rewrite (U13), red-
// flagged regions never loaded, minors capped (RPE, contacts), the prehab cap
// kept, deterministic. Against a real schema: coach_v1 off → nothing changes;
// on → the preview carries the program diff and writes nothing; apply is one
// transaction (a failure mid-write leaves nothing, and the approval unspent),
// single-use, refused when the live program moved since the preview; the live
// program is untouched until the block's start (a new pending phase); a
// re-compose before the start replaces the queued block; anything else queued
// is never overwritten; revert skips the queued week (and, once started,
// brings the previous block back); athlete A never reads or writes B's rows.
// Synthetic data. Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is
// set, else PGlite.
// Run: node --experimental-strip-types worker/src/composedBlockProgram.check.ts

import { addDaysIso, compose, type ComposeInput, type ComposedBlock } from './coach/composer.ts'
import { BLOCK_PROGRAM_VERSION, blockSessions, type BlockSessions } from './coach/blockProgram.ts'
import { COMPOSER_V1 } from './coach/modules.ts'
import { classify } from './methodology/classify.ts'
import { validateEdit } from './methodology/validators.ts'
import { METHODOLOGY_V1_2 } from './methodology/v1.ts'
import { openIsolationHarness } from './isolationDb.ts'
import { createApproval } from './approvals.ts'
import { revertChange } from './reverts.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool } from './tools.ts'
import { loadLiveProgram, makeStore } from './store.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const P = METHODOLOGY_V1_2.params
const MINORS = METHODOLOGY_V1_2.minors
const START = '2026-11-09' // a Monday

function input(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    start: START,
    activities: [{ id: 'act-bball', module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'in', days: [3] }],
    goals: [{ id: 'goal-squat', name: 'Back Squat 1RM', test: 'Back Squat 1RM', weight: 'priority', due_date: '2027-03-01' }],
    schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] },
    training_age: '3to10',
    minor: false,
    age: 30,
    injuries: [],
    blocked_regions: [],
    params: P,
    minors: MINORS,
    ...over,
  }
}
const sessionsOf = (b: ComposedBlock, i: ComposeInput) => blockSessions(b, { blocked: i.blocked_regions, minor: i.minor, minors: i.minors })
const all = (s: BlockSessions) => s.sessions.flatMap((x) => x.exercises)
const loads = (s: BlockSessions) => all(s).flatMap((e) => classify(e).regions)

// ---- pure: the worked example -------------------------------------------------------------------
const wIn = input()
const wb = compose(wIn)
const ws = sessionsOf(wb, wIn)
const sessionDays = wb.week.filter((d) => d.kind === 'session')
ok(ws.sessions.length === sessionDays.length && ws.sessions.every((s, i) => s.intended_dow === sessionDays[i].dow), 'worked example: one session per training day of the layout, on its day')
ok(!ws.sessions.some((s) => s.intended_dow === 3), 'worked example: nothing on the basketball day (it counts as load)')
for (const d of sessionDays) {
  const s = ws.sessions.find((x) => x.intended_dow === d.dow)!
  const has = (re: RegExp) => s.exercises.some((e) => re.test(e.name))
  for (const u of d.units) {
    if (u.kind === 'lift') ok(s.exercises.some((e) => e.track === 'Max strength' || e.track === 'Other lifts'), `day ${d.dow}: the lift unit has lifts on the strength tracks`)
    if (u.kind === 'power') ok(has(/Broad Jump/) && has(/Box Jump/) && has(/Acceleration Sprint/), `day ${d.dow}: power is jumps + acceleration starts`)
    if (u.kind === 'aerobic') ok(s.exercises.some((e) => e.name === 'Bike' && e.reps === `${u.minutes} min`), `day ${d.dow}: aerobic is ${u.minutes} min on the bike (strength is the priority, U9)`)
    if (u.kind === 'alactic') ok(s.exercises.some((e) => e.name === 'Bike Sprint' && classify(e).classes.has('hiit')), `day ${d.dow}: repeat sprints are a bike interval block (HIIT, U9)`)
    if (u.kind === 'prehab') ok(has(/Tibialis Raise/) && has(/90\/90 Hip Lift-Off/), `day ${d.dow}: the knee/ankle/hip IR prehab set`)
  }
}
const squatDays = ws.sessions.filter((s) => s.exercises.some((e) => e.name === 'Back Squat' && e.track === 'Max strength'))
ok(squatDays.length >= 1 && squatDays.every((s) => s.exercises.find((e) => e.name === 'Back Squat')!.target_rpe === 8), 'the priority goal\'s lift (squat) carries the priority track, RPE 8 (U1, U5)')
ok(!ws.sessions.some((s) => s.exercises.some((e) => e.name === 'Bench Press' && e.track === 'Max strength')), 'other main lifts run on Other lifts (maintenance, U2), not the priority track')
ok(all(ws).every((e) => e.load === undefined || !/\d/.test(String(e.load))), 'no written loads: the engine computes them (#49)')
ok(all(ws).every((e) => e.target_rpe === undefined || e.target_rpe <= 8), 'no target above the base RPE: RPE 10 is for test days only (U5)')
const jumpContacts = ws.sessions.flatMap((s) => s.exercises).filter((e) => typeof e.contacts === 'number').reduce((n, e) => n + (e.contacts ?? 0), 0)
ok(jumpContacts >= wb.contacts.per_session[0] && jumpContacts <= wb.contacts.per_session[1] && wb.contacts.per_session[1] === 80, 'jumps sized to the 40–80 sport-week budget (U14)')
for (const s of ws.sessions) {
  const ranks = s.exercises.map((e) => classify(e).rank).filter((r): r is NonNullable<typeof r> => r != null)
  ok(ranks.every((r, i) => i === 0 || r >= ranks[i - 1]), `${s.name}: session order holds (U8)`)
}
const after = ws.sessions.map((s) => ({ key: `block:${s.intended_dow}`, name: s.name, dow: s.intended_dow, exercises: s.exercises }))
const before = [{ key: 'r1', name: 'Old day', dow: 0, exercises: [{ name: 'Leg Press', sets: 3, reps: '10' }, { name: 'Lat Pulldown', sets: 3, reps: '10' }] }]
const asRewrite = validateEdit({ before, after, params: P, changed: 2 + all(ws).length, total: 2, rewrite: true, blockedRegions: [] })
ok(asRewrite.blocked === null && !asRewrite.warnings.some((w) => w.rule === 'U13'), 'validators: as rewrite=true the block passes U13, and nothing blocks')
const asSmall = validateEdit({ before, after, params: P, changed: 2 + all(ws).length, total: 2, rewrite: false, blockedRegions: [] })
ok(asSmall.blocked?.rule === 'U13', 'validators: the same week as a "small" edit would fail U13 (why a block is an explicit rewrite)')
ok(JSON.stringify(sessionsOf(compose(input()), input())) === JSON.stringify(ws), 'deterministic: same block, same sessions')

// Red flags: never loaded, listed as held.
for (const region of ['knee', 'shoulder', 'low_back'] as const) {
  const i = input({ blocked_regions: [region] })
  const s = sessionsOf(compose(i), i)
  ok(!loads(s).includes(region), `red flag ${region}: no written exercise loads it`)
  ok(s.held.length > 0 && s.held.every((h) => h.regions.includes(region)), `red flag ${region}: what was left out is listed as held`)
}
const kneeIn = input({ blocked_regions: ['knee'] })
const knee = sessionsOf(compose(kneeIn), kneeIn)
ok(knee.held.some((h) => h.exercise === 'Back Squat') && !all(knee).some((e) => /Jump/.test(e.name)), 'knee red flag: no squat, no jumps')
const runIn = input({ goals: [{ id: 'g-half', name: 'Half marathon', test: 'Half marathon', weight: 'priority', due_date: '2027-01-15' }], blocked_regions: ['achilles'] })
const runS = sessionsOf(compose(runIn), runIn)
ok(!all(runS).some((e) => /Run/.test(e.name)) && all(runS).some((e) => /^Bike/.test(e.name)), 'achilles red flag: an endurance priority rides instead of running')
const runOkIn = input({ goals: [{ id: 'g-half', name: 'Half marathon', test: 'Half marathon', weight: 'priority', due_date: '2027-01-15' }] })
ok(all(sessionsOf(compose(runOkIn), runOkIn)).some((e) => e.name === 'Easy Run'), 'no red flag: the endurance priority runs')

// Minors: RPE and contacts capped, tightened only.
const minorIn = input({ minor: true, age: 16, activities: [], training_age: '10plus' })
const minorS = sessionsOf(compose(minorIn), minorIn)
ok(all(minorS).every((e) => e.target_rpe === undefined || e.target_rpe <= MINORS.max_rpe), 'under 18: no target RPE above the cap')
const minorJumps = minorS.sessions.map((s) => s.exercises.reduce((n, e) => n + (e.contacts ?? 0), 0))
ok(minorJumps.every((n) => n <= MINORS.contacts_per_session_max), 'under 18: contacts per session ≤ the minors\' ceiling')
const tight = { ...MINORS, max_rpe: 6, contacts_per_session_max: 20 }
const tightIn = input({ minor: true, age: 16, minors: tight })
const tightS = blockSessions(compose(tightIn), { blocked: [], minor: true, minors: tight })
ok(all(tightS).every((e) => e.target_rpe === undefined || e.target_rpe <= 6) && tightS.sessions.every((s) => s.exercises.reduce((n, e) => n + (e.contacts ?? 0), 0) <= 20), 'a coach-tightened minors cap tightens the sessions too')

// Prehab cap: three modules' prehab, only what fits the cap is written.
const manyIn = input({
  activities: [
    { id: 'a1', module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'in', days: [3] },
    { id: 'a2', module: 'field', name: 'Sunday soccer', sessions_per_week: 1, season: 'in', days: [6] },
    { id: 'a3', module: 'endurance', name: 'Trail running', sessions_per_week: 1, season: 'in', days: [5] },
  ],
})
const manyB = compose(manyIn)
const manyS = sessionsOf(manyB, manyIn)
ok(manyB.prehab.minutes <= COMPOSER_V1.prehab_minutes[1] && manyB.prehab.deferred.length > 0, 'prehab: capped per session, the rest deferred')
const deferredNames = manyB.prehab.deferred.flatMap((k) => ({ nordics: ['Nordic Hamstring Curl'], copenhagen: ['Copenhagen Plank'], calf_achilles: ['Single-Leg Calf Raise'], single_leg_bridge_work: ['Single-Leg Glute Bridge'] } as Record<string, string[]>)[k] ?? [])
ok(deferredNames.length > 0 && !all(manyS).some((e) => deferredNames.includes(e.name)), 'prehab: deferred items are not written')

// ---- against a real schema -----------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PROG_B = '44444444-4444-4444-4444-444444444444'
const PHASE_A = '55555555-5555-5555-5555-555555555555'
const PHASE_B = '66666666-6666-6666-6666-666666666666'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
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

const call = (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A) =>
  executeZeroedTool(sql, athlete, name, args, {}, actor)
async function callErr(name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> {
  try {
    return await call(name, args, actor, athlete)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const kept = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? ''
const parsed = (text: string) => JSON.parse(/\{\n {2}"preview_id"[\s\S]*?\n\}/.exec(text)![0]) as {
  block: { start: string; program?: { sessions: Array<{ name: string; day: number; exercises: Array<{ name: string; track: string | null; target_rpe?: number; contacts?: number }> }>; held: unknown[]; note: string | null; appliable: boolean } }
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
async function flags(athleteId: string, f: { tracks?: boolean; coach?: boolean }) {
  for (const [k, on] of [['tracks_v1', f.tracks], ['coach_v1', f.coach]] as const) {
    if (on === undefined) continue
    if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || jsonb_build_object(${k}::text, true) WHERE id = ${athleteId}`
    else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - ${k}::text WHERE id = ${athleteId}`
  }
}
async function tap(previewId: string, store = storeA, actor: OverrideActor = athleteA): Promise<string> {
  const r = await createApproval(store, actor, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
const rx = async () => JSON.stringify(await sessionRxForAthlete(sql, A, { routine_id: ROUTINE_A, unit: 'lb', storage_unit: 'lb' }))
const rxNumbers = (text: string) => text.replace(/"(program_)?version":"[^"]*"/g, '')
const phasesOf = async (prog: string) => harness.query<{ id: string; status: string; week_start: string; week_end: string }>(
  `SELECT id::text AS id, status, week_start::text AS week_start, week_end::text AS week_end FROM phase WHERE program_id = $1 ORDER BY week_start, id`, [prog])
const liveRoutines = async (phase: string) => JSON.stringify(await harness.query(`SELECT id, name, session_type, exercises, intent, intended_dow FROM routine WHERE phase_id = $1 ORDER BY id`, [phase]))
const programRows = async () => JSON.stringify({
  phases: await harness.query(`SELECT id, status, week_start::text, week_end::text FROM phase ORDER BY id`),
  routines: await harness.query(`SELECT id, phase_id, exercises FROM routine ORDER BY id`),
})

await harness.query(`INSERT INTO athlete_goal (athlete_id, name, metric, unit, direction, target, due_date, test_protocol) VALUES ($1, 'Back Squat 1RM', 'Back Squat', 'lb', 'higher', 315, CURRENT_DATE + 120, 'Back Squat 1RM')`, [A])
await harness.query(`INSERT INTO athlete_goal (athlete_id, name, metric, unit, direction, target, due_date, test_protocol) VALUES ($1, 'Bench 225', 'Bench Press', 'lb', 'higher', 225, CURRENT_DATE + 120, 'Bench Press 1RM')`, [B])
await harness.query(`INSERT INTO activity (athlete_id, module_key, name, sessions_per_week, season, days) VALUES ($1, 'court', 'Rec basketball', 1, 'in', '{3}')`, [A])
await harness.query(`INSERT INTO activity (athlete_id, module_key, name, sessions_per_week, season, days) VALUES ($1, 'court', 'Pickup volleyball', 1, 'in', '{5}')`, [B])
const tmoBefore = JSON.stringify(await harness.query(`SELECT id, training_max_overrides FROM athlete ORDER BY id`))
const today = await athleteToday(storeA)
const start = (() => { const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); return addDaysIso(today, (8 - dow) % 7 || 7) })()

// ---- coach_v1 off: nothing changes -----------------------------------------------------------------
await flags(A, { tracks: true })
const rowsOff = await programRows()
const rxOff = await rx()
ok((await callErr('preview_composed_block', {})).includes('Unknown tool'), 'coach_v1 off: preview_composed_block is unknown')
ok((await callErr('apply_composed_block', { preview_id: 'chp_x', confirm: true, approval_ref: 'tap:x' })).includes('Unknown tool'), 'coach_v1 off: apply_composed_block is unknown')
ok(await programRows() === rowsOff && await rx() === rxOff, 'coach_v1 off: phases, routines and /api/session-rx unchanged')

// ---- coach_v1 on: preview carries the program diff, writes nothing ------------------------------------
await flags(A, { coach: true })
await flags(B, { tracks: true, coach: true })
const liveBefore = await liveRoutines(PHASE_A)
const liveLoaded = JSON.stringify(await loadLiveProgram(storeA).then((l) => l?.sessions))
const rowsBefore = await programRows()
const prevText = await call('preview_composed_block', {
  goal_weights: [{ goal: 'Back Squat 1RM', weight: 'priority' }],
  schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] },
  training_age: '3to10',
  start,
  rationale: 'One priority strength goal; basketball counts as conditioning (U2, U9).',
})
const prevId = kept(prevText)
const prev = parsed(prevText)
ok(/## Program from/.test(prevText) && /rewrite=true/.test(prevText) && /never from the coach/.test(prevText), 'preview: the program diff, said to be an explicit rewrite (U13), loads from the engine')
ok(prev.block.program?.sessions.map((s) => s.day).join() === '0,1,2,5', 'preview: the worked example\'s 4 training days (Mon, Tue, Wed, Sat), not the game day')
ok(prev.block.program!.sessions.some((s) => s.exercises.some((e) => e.name === 'Back Squat' && e.track === 'Max strength')), 'preview: the squat on the priority track')
ok(await programRows() === rowsBefore, 'preview: nothing written to the program')

// Diff changed → refused: the live week moves after the preview.
const ref1 = await tap(prevId)
await harness.query(`UPDATE routine SET exercises = exercises || '[{"name":"Plank","sets":2,"reps":"30s"}]'::jsonb WHERE id = $1`, [ROUTINE_A])
ok((await callErr('apply_composed_block', { preview_id: prevId, confirm: true, approval_ref: ref1 })).includes('no longer matches'), 'the live program moved since the preview → refused')
await harness.query(`UPDATE routine SET exercises = exercises - (jsonb_array_length(exercises) - 1) WHERE id = $1`, [ROUTINE_A])
ok(await liveRoutines(PHASE_A) === liveBefore, '(the live routine put back)')

// Atomic: a failure mid-write leaves nothing, and neither the preview nor the approval is spent.
const atomicId = kept(await call('preview_composed_block', { goal_weights: [{ goal: 'Back Squat 1RM', weight: 'priority' }], schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] }, training_age: '3to10', start }))
const atomicRef = await tap(atomicId)
await harness.exec(`
  CREATE OR REPLACE FUNCTION fail_block_routine() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.name LIKE 'Sat:%' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER fail_block_routine BEFORE INSERT ON routine FOR EACH ROW EXECUTE FUNCTION fail_block_routine();
`)
const logBefore = await count('change_log', `athlete_id = $1`, [A])
const trackBefore = await count('track', `program_id = $1`, [PROG_A])
let threw = false
try { await call('apply_composed_block', { preview_id: atomicId, confirm: true, approval_ref: atomicRef }) } catch { threw = true }
ok(threw, 'atomic: the mid-write failure surfaces')
ok(await programRows() === rowsBefore && await count('composed_block', `athlete_id = $1`, [A]) === 0, 'atomic: no phase, routine or block row')
ok(await count('change_log', `athlete_id = $1`, [A]) === logBefore && await count('track', `program_id = $1`, [PROG_A]) === trackBefore, 'atomic: no change_log row, no tracks')
ok(await count('change_preview', `preview_id = $1 AND used_at IS NULL`, [atomicId]) === 1, 'atomic: the preview is not spent')
await harness.exec(`DROP TRIGGER fail_block_routine ON routine; DROP FUNCTION fail_block_routine();`)

// Apply: one transaction, single-use approval.
const applied = await call('apply_composed_block', { preview_id: atomicId, confirm: true, approval_ref: atomicRef })
ok(applied.startsWith('Applied the composed block') && /Queued 4 sessions a week from/.test(applied), 'apply: the same preview and approval go through once the write can')
ok((await callErr('apply_composed_block', { preview_id: atomicId, confirm: true, approval_ref: atomicRef })).includes('already'), 'apply: single use')
const [cb1] = await harness.query<{ id: string; phase_id: string; change_id: string }>(`SELECT id::text AS id, phase_id::text AS phase_id, change_id::text AS change_id FROM composed_block WHERE athlete_id = $1 AND superseded_at IS NULL`, [A])
const [log1] = await harness.query<{ tool: string; methodology_version: string; approval_ref: string; diff: { modules_version: string; program_phase: { version: string; phase_id: string; routine_ids: string[]; live_week_end_before: string; live_week_end_after: string; rewrite: boolean } } }>(
  `SELECT tool, methodology_version, approval_ref, diff FROM change_log WHERE id::text = $1`, [cb1.change_id])
ok(log1.tool === 'apply_composed_block' && log1.methodology_version === 'v1.2' && log1.diff.modules_version === 'modules-v1' && log1.approval_ref === atomicRef, 'change_log: one row, methodology + module versions, the approval')
ok(log1.diff.program_phase.version === BLOCK_PROGRAM_VERSION && log1.diff.program_phase.phase_id === cb1.phase_id && log1.diff.program_phase.rewrite === true, 'change_log: the queued phase, the generator version, rewrite=true')
ok(await count('change_log', `athlete_id = $1 AND tool = 'apply_composed_block'`, [A]) === 1, 'one change_log row for the whole block')
const phases1 = await phasesOf(PROG_A)
const queued1 = phases1.find((p) => p.id === cb1.phase_id)
ok(queued1?.status === 'pending' && queued1.week_start === start, 'apply: a new queued block (pending phase) from the block\'s start')
const live1 = phases1.find((p) => p.id === PHASE_A)!
ok(live1.status === 'active' && live1.week_end === (log1.diff.program_phase.live_week_end_before >= start ? addDaysIso(start, -1) : log1.diff.program_phase.live_week_end_before), 'live program: still active, ends the day before the block starts')
ok(await liveRoutines(PHASE_A) === liveBefore, 'live program: its routines untouched')
// The version hashes cover the block's progression rules (dated from its start); the numbers must not move.
ok(rxNumbers(await rx()) === rxNumbers(rxOff), 'live program: /api/session-rx for today prescribes exactly the same')
ok(JSON.stringify(await loadLiveProgram(storeA).then((l) => l?.sessions)) === liveLoaded, 'live program: the week the Worker loads is unchanged')
const routines1 = await harness.query<{ id: string; name: string; intended_dow: number; exercises: Array<{ name: string; load?: string; track_id?: string; target_rpe?: number }> }>(
  `SELECT id::text AS id, name, intended_dow, exercises FROM routine WHERE phase_id = $1 ORDER BY intended_dow`, [cb1.phase_id])
const tracksA = new Map((await harness.query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM track WHERE program_id = $1`, [PROG_A])).map((t) => [t.id, t.name]))
ok(routines1.length === 4 && routines1.map((r) => r.intended_dow).join() === prev.block.program!.sessions.map((s) => s.day).join(), 'routines: one per session day, as previewed')
ok(routines1.every((r) => r.exercises.every((e) => !e.track_id || tracksA.has(e.track_id))), 'routines: exercises point at the block\'s tracks in A\'s program')
ok(routines1.some((r) => r.exercises.some((e) => e.name === 'Back Squat' && tracksA.get(e.track_id ?? '') === 'Max strength')), 'routines: the squat on the priority track (tm_wave computes its load)')
ok(routines1.every((r) => r.exercises.every((e) => e.load === undefined || !/\d/.test(e.load))), 'routines: no written loads')
ok(JSON.stringify(await harness.query(`SELECT id, training_max_overrides FROM athlete ORDER BY id`)) === tmoBefore, 'training_max_overrides untouched')

// Re-compose before the start: the queued block is replaced (kept, skipped), not refused.
const re = await call('preview_composed_block', { schedule: { days_per_week: 4, minutes_per_session: 90, rest_days: [6] }, start })
const reId = kept(re)
ok(parsed(re).block.program?.appliable === true, 're-compose: appliable while the old block is still queued')
ok((await call('apply_composed_block', { preview_id: reId, confirm: true, approval_ref: await tap(reId) })).startsWith('Applied'), 're-compose: applied')
const [cb2] = await harness.query<{ id: string; phase_id: string; change_id: string }>(`SELECT id::text AS id, phase_id::text AS phase_id, change_id::text AS change_id FROM composed_block WHERE athlete_id = $1 AND superseded_at IS NULL`, [A])
const phases2 = await phasesOf(PROG_A)
ok(phases2.find((p) => p.id === cb1.phase_id)?.status === 'skipped' && phases2.find((p) => p.id === cb2.phase_id)?.status === 'pending', 're-compose: the old queued block skipped, the new one queued')
ok(await count('routine', `phase_id = $1`, [cb1.phase_id]) === 4, 're-compose: the old block\'s routines kept (nothing deleted)')
ok(await liveRoutines(PHASE_A) === liveBefore, 're-compose: the live routines still untouched')

// Something else queued is never overwritten.
const OTHER = 'abcd0000-0000-4000-8000-0000000000aa'
await harness.query(`UPDATE phase SET status = 'skipped' WHERE id = $1`, [cb2.phase_id])
await harness.query(`INSERT INTO phase (id, program_id, name, week_start, week_end, status) VALUES ($1, $2, 'Strength', $3, $4, 'pending')`, [OTHER, PROG_A, start, addDaysIso(start, 27)])
const blockedPrev = await call('preview_composed_block', { start })
ok(parsed(blockedPrev).block.program?.appliable === false && /already queued/.test(blockedPrev), 'another queued block: the preview says not appliable')
const blockedRef = await tap(kept(blockedPrev))
ok((await callErr('apply_composed_block', { preview_id: kept(blockedPrev), confirm: true, approval_ref: blockedRef })).includes('already queued'), 'another queued block: apply refused')
await harness.query(`UPDATE phase SET status = 'skipped' WHERE id = $1`, [OTHER])
await harness.query(`UPDATE phase SET status = 'pending' WHERE id = $1`, [cb2.phase_id])

// Revert (the athlete's tap): the queued week is skipped, the replaced one re-queued, nothing deleted.
const routinesBefore = await count('routine', `program_id = $1`, [PROG_A])
const undo2 = await revertChange(storeA, athleteA, cb2.change_id)
ok(undo2.ok, `revert: the athlete undoes the re-composed block${undo2.ok ? '' : ` (${undo2.text})`}`)
const phases3 = await phasesOf(PROG_A)
ok(phases3.find((p) => p.id === cb2.phase_id)?.status === 'skipped' && phases3.find((p) => p.id === cb1.phase_id)?.status === 'pending', 'revert: its week skipped, the block it replaced queued again')
const [cbBack] = await harness.query<{ phase_id: string }>(`SELECT phase_id::text AS phase_id FROM composed_block WHERE athlete_id = $1 AND superseded_at IS NULL`, [A])
ok(cbBack?.phase_id === cb1.phase_id, 'revert: the previous block is the block of record again, with its queued week')
ok(await count('routine', `program_id = $1`, [PROG_A]) === routinesBefore && await liveRoutines(PHASE_A) === liveBefore, 'revert: nothing deleted; live routines untouched')
ok(phases3.find((p) => p.id === PHASE_A)?.status === 'active', 'revert: the live block still runs')

// ---- B: red flag + minor + a started block's revert -----------------------------------------------------
const minorDob = addDaysIso(today, -(16 * 365 + 30))
await harness.query(`UPDATE athlete SET birth_date = $2 WHERE id = $1`, [B, minorDob])
await harness.query(`INSERT INTO region_status (athlete_id, region, status, reason) VALUES ($1, 'shoulder', 'blocked', 'synthetic red flag')`, [B])
const rowsA = await programRows().then((r) => JSON.stringify(JSON.parse(r).phases.filter((p: { id: string }) => p.id !== PHASE_B)))
const bPrevText = await call('preview_composed_block', { goal_weights: [{ goal: 'Bench 225', weight: 'priority' }], schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] }, start }, athleteB, B)
const bPrev = parsed(bPrevText)
const bEx = bPrev.block.program!.sessions.flatMap((s) => s.exercises)
ok(bEx.length > 0 && !bEx.some((e) => classify({ name: e.name, sets: 1, reps: '1' }).regions.includes('shoulder')), 'B red flag (shoulder): no exercise in the block loads it')
ok(bPrev.block.program!.held.length > 0 && /Held \(U7\)/.test(bPrevText), 'B red flag: the left-out work is shown as held')
ok(bEx.every((e) => e.target_rpe === undefined || e.target_rpe <= MINORS.max_rpe), 'B under 18: no target RPE above the cap')
ok(bPrev.block.program!.sessions.every((s) => s.exercises.reduce((n, e) => n + (e.contacts ?? 0), 0) <= MINORS.contacts_per_session_max), 'B under 18: contacts within the minors\' ceiling')
// Coach without the health toggle: the held work is a count, not the region.
await harness.query(`UPDATE mcp_token SET share_health = false WHERE id = $1`, [TOKEN_B_ID])
const bCoachText = await call('preview_composed_block', { goal_weights: [{ goal: 'Bench 225', weight: 'priority' }], schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] }, start }, coachB, B)
ok(!/shoulder/i.test(bCoachText) && /held for a health reason/i.test(bCoachText) && /shoulder/.test(bPrevText), 'D3: a coach without the health toggle sees held work, never the region')
await harness.query(`UPDATE mcp_token SET share_health = true WHERE id = $1`, [TOKEN_B_ID])
const bId = kept(bPrevText)
const bApplied = await call('apply_composed_block', { preview_id: bId, confirm: true, approval_ref: await tap(bId, storeB, athleteB) }, athleteB, B)
ok(bApplied.startsWith('Applied'), 'B: the athlete applies their own block')
const [cbB] = await harness.query<{ phase_id: string; change_id: string }>(`SELECT phase_id::text AS phase_id, change_id::text AS change_id FROM composed_block WHERE athlete_id = $1 AND superseded_at IS NULL`, [B])
const bRoutineEx = (await harness.query<{ exercises: Array<{ name: string; target_rpe?: number }> }>(`SELECT exercises FROM routine WHERE phase_id = $1`, [cbB.phase_id])).flatMap((r) => r.exercises)
ok(bRoutineEx.length > 0 && !bRoutineEx.some((e) => classify({ name: e.name, sets: 1, reps: '1' }).regions.includes('shoulder')), 'B: the written routines load no blocked region')
ok(JSON.stringify(JSON.parse(await programRows()).phases.filter((p: { id: string }) => p.id !== PHASE_B && p.id !== cbB.phase_id)) === rowsA, 'isolation: B\'s apply touched none of A\'s phases')
ok(await count('routine', `phase_id = $1 AND program_id <> $2`, [cbB.phase_id, PROG_B]) === 0, 'isolation: B\'s block routines live in B\'s program')

// Started (the app promoted it on its date), then reverted: the previous block runs again.
const [bLiveWas] = await harness.query<{ week_end: string }>(`SELECT week_end::text AS week_end FROM phase WHERE id = $1`, [PHASE_B])
const [bLog] = await harness.query<{ diff: { program_phase: { live_week_end_before: string } } }>(`SELECT diff FROM change_log WHERE id::text = $1`, [cbB.change_id])
await harness.query(`UPDATE phase SET status = 'completed' WHERE id = $1`, [PHASE_B])
await harness.query(`UPDATE phase SET status = 'active' WHERE id = $1`, [cbB.phase_id])
const undoB = await revertChange(storeB, athleteB, cbB.change_id)
ok(undoB.ok, `revert after the start: allowed${undoB.ok ? '' : ` (${undoB.text})`}`)
const bPhases = await phasesOf(PROG_B)
ok(bPhases.find((p) => p.id === cbB.phase_id)?.status === 'skipped' && bPhases.find((p) => p.id === PHASE_B)?.status === 'active', 'revert after the start: the block\'s week skipped, the previous block live again')
ok(bPhases.find((p) => p.id === PHASE_B)?.week_end === bLog.diff.program_phase.live_week_end_before && bLiveWas.week_end !== undefined, 'revert after the start: the previous block\'s end date put back')

// ---- isolation ---------------------------------------------------------------------------------------------
const aOpen = kept(await call('preview_composed_block', { start }))
ok((await callErr('apply_composed_block', { preview_id: aOpen, confirm: true, approval_ref: await tap(aOpen) }, coachB, B)).includes('no apply_composed_block preview'), 'isolation: B cannot apply A\'s block preview')
const crossRevert = await revertChange(storeB, athleteB, cb1.change_id)
ok(!crossRevert.ok, 'isolation: B cannot revert A\'s block')
ok((await revertChange(storeA, athleteB, cb2.change_id)).ok === false, 'isolation: B acting on A\'s store is refused')
const bView = await call('preview_composed_block', { start }, coachB, B)
ok(!/Back Squat 1RM/.test(bView) && !bView.includes(PHASE_A) && !bView.includes(PROG_A), 'isolation: B\'s preview names nothing of A\'s')

// ---- before composed-block-program.sql: blocks apply as before, without sessions ------------------------
await harness.exec(`ALTER TABLE composed_block DROP COLUMN phase_id`)
const bPhasesBefore = JSON.stringify(await phasesOf(PROG_B))
const oldText = await call('preview_composed_block', { goal_weights: [{ goal: 'Bench 225', weight: 'priority' }], schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] }, start }, athleteB, B)
ok(/sessions are not written on this database yet/.test(oldText) && parsed(oldText).block.program?.appliable === true, 'old schema: the preview says the sessions are not written, and stays appliable')
const oldApplied = await call('apply_composed_block', { preview_id: kept(oldText), confirm: true, approval_ref: await tap(kept(oldText), storeB, athleteB) }, athleteB, B)
ok(oldApplied.startsWith('Applied') && !/Queued/.test(oldApplied), 'old schema: the block applies as before')
ok(JSON.stringify(await phasesOf(PROG_B)) === bPhasesBefore, 'old schema: no phase written or moved')
await harness.exec(`ALTER TABLE composed_block ADD COLUMN IF NOT EXISTS phase_id UUID`)

// ---- rollback: coach_v1 off again → as before -------------------------------------------------------------
const rowsNow = await programRows()
await flags(A, { coach: false })
ok((await callErr('preview_composed_block', {})).includes('Unknown tool'), 'rollback: coach_v1 off → the block tools are unknown again')
ok(await programRows() === rowsNow, 'rollback: turning the flag off writes nothing')

await harness.close()
if (fails.length) {
  console.error(`${fails.length}/${checks} composed-block program checks failed (${harness.backend}):\n- ${fails.join('\n- ')}`)
  process.exit(1)
}
console.log(`${checks} checks, 0 failed (${harness.backend})`)
console.log('composed-block-program: ok')
