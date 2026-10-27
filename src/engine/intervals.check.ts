// Standalone integrity check for the interval engine (no test runner installed,
// same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/intervals.check.ts
//
// The properties that matter:
//
//   · what the coach writes ("8 × 20s on / 40s off") runs as exactly that block,
//     in whichever of the shapes coaches actually write it
//   · straight sets never get mistaken for intervals — a tempo note, a hold,
//     "10/10" a side on a lift
//   · the clock knows where it is at any second, catch-up after a locked phone
//     included, and the block ends on work rather than a dangling rest
//   · what gets logged reads back as the same rounds, and a hand-built block
//     round-trips through the same rep spec the coach uses

import {
  parseIntervalReps, intervalPlanFor, buildTimeline, readClock, roundsDone,
  intervalSetLogs, roundsFromLogs, blockSeconds, timelineSeconds, intervalReps,
  intervalExercise, manualPlan, describePlan, fmtDose, secondsFromReps, stepSeconds,
  READY_SECONDS, INTERVAL_PRESETS,
} from './intervals.ts'
import { effectiveTrackingType, buildSwap } from './exerciseLibrary.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}
function eq<T>(actual: T, expected: T, msg: string) {
  checks++
  if (actual !== expected) fails.push(`${msg} — expected ${String(expected)}, got ${String(actual)}`)
}

const ex = (name: string, reps: string, sets = 1) => ({ name, reps, sets })

// ---- 1. the shapes a coach writes -------------------------------------------

const shapes: Array<[string, string, number, number, number | null]> = [
  ['the editor\'s documented example',  '8 × 20s on / 40s off',            20, 40, 8],
  ['x instead of ×',                     '8 x 20s on / 40s off',            20, 40, 8],
  ['count trailing',                     '20s on / 40s off x 8',            20, 40, 8],
  ['no count — sets carry it',           '30s on / 30s off',                30, 30, null],
  ['comma separated',                    '10 rounds: 15s sprint, 45s walk', 15, 45, 10],
  ['minutes',                            '6 × 1 min hard / 1 min easy',     60, 60, 6],
  ['Norwegian 4×4',                      '4 x 4 min @ 90% / 3 min easy',    240, 180, 4],
  ['secs spelled out',                   '10 x 30 sec on, 30 sec off',      30, 30, 10],
  ['no separator, on/off words',         '20 sec on 10 sec off',            20, 10, null],
  ['parenthetical ignored',              '8 × 20s on / 40s off (Tabata-ish)', 20, 40, 8],
]
for (const [why, reps, work, rest, rounds] of shapes) {
  const p = parseIntervalReps(reps)
  ok(p != null, `${why}: "${reps}" reads as intervals`)
  if (!p) continue
  eq(p.work, work, `${why}: work`)
  eq(p.rest, rest, `${why}: rest`)
  eq(p.rounds, rounds, `${why}: rounds`)
}

const tabata = parseIntervalReps('Tabata')
ok(tabata?.work === 20 && tabata?.rest === 10 && tabata?.rounds === 8, 'Tabata is 8 × 20 / 10 by name')
const emom = parseIntervalReps('EMOM 10 min')
ok(emom?.work === 60 && emom?.rest === 0 && emom?.rounds === 10, 'EMOM 10 min is ten one-minute rounds')
eq(parseIntervalReps('EMOM x 12')?.rounds, 12, 'EMOM x 12')
eq(parseIntervalReps('emom 8')?.rounds, 8, 'EMOM with a bare count')
const e2 = parseIntervalReps('E2MOM 20 min')
ok(e2?.work === 120 && e2?.rounds === 10, 'E2MOM 20 min is ten two-minute rounds')

// The bare shorthand only on a movement that says conditioning.
const bike = intervalPlanFor(ex('Assault Bike', '10 x 30/30'))
ok(bike?.work === 30 && bike?.rest === 30 && bike?.rounds === 10, '"10 x 30/30" on a bike')
const clock = intervalPlanFor(ex('Assault Bike', '30:30 x 10'))
ok(clock?.work === 30 && clock?.rounds === 10, '"30:30" on a bike is 30 and 30, not half an hour')
eq(intervalPlanFor(ex('Bulgarian Split Squat', '10/10', 3)), null, '"10/10" on a lift is reps a side')
eq(intervalPlanFor(ex('DB Row', '8/8', 3)), null, 'nor on a row')

// ---- 2. straight sets stay straight sets ------------------------------------

for (const [reps, why] of [
  ['8', 'a rep count'],
  ['8-10', 'a range'],
  ['30s', 'a single hold'],
  ['8 (3s eccentric)', 'a tempo note'],
  ['8-10, 2s squeeze', 'a squeeze cue'],
  ['3 each side', 'per side'],
  ['3 x 8, rest 90s', 'a rest note on straight sets'],
  ['1:30', 'one clock time'],
  ['AMRAP', 'no quantity'],
  ['400m', 'a distance rep'],
] as const) {
  eq(parseIntervalReps(reps), null, `"${reps}" (${why}) is not intervals`)
  eq(parseIntervalReps(reps, true), null, `"${reps}" (${why}) is not intervals, even loosely`)
}

// ---- 3. rows: how a block sits in the set grid ------------------------------

const perRound = intervalPlanFor(ex('Assault Bike', '20s on / 40s off', 8))!
ok(perRound.rows === 'round' && perRound.rounds === 8 && perRound.sets === 1,
  'no count in the spec → each of the 8 sets is a round')
const oneBlock = intervalPlanFor(ex('Assault Bike', '8 × 20s on / 40s off', 1))!
ok(oneBlock.rows === 'set' && oneBlock.rounds === 8 && oneBlock.sets === 1, 'count in the spec → one row is the block')
const twoBlocks = intervalPlanFor(ex('Bike', '8 × 20s on / 10s off', 2))!
ok(twoBlocks.rows === 'set' && twoBlocks.sets === 2, 'sets 2 runs the block twice')
const redundant = intervalPlanFor(ex('Bike', '8 × 20s on / 40s off', 8))!
ok(redundant.rounds === 8 && redundant.sets === 1, 'sets 8 with "8 ×" is the same eight rounds said twice, not 64')
const noisy = intervalPlanFor(ex('Bike', '6 × 30s on / 30s off', 9))!
ok(noisy.sets === 1 && noisy.rounds === 6, 'nine repeats of a block is noise, not a prescription')

// ---- 4. the timeline ---------------------------------------------------------

const plan = oneBlock   // 8 × 20 / 40
const tl = buildTimeline(plan)
eq(tl[0].kind, 'ready', 'opens on the ready beat')
eq(tl[0].secs, READY_SECONDS, 'ready beat length')
eq(tl.filter((p) => p.kind === 'work').length, 8, 'eight work phases')
eq(tl.filter((p) => p.kind === 'rest').length, 7, 'seven rests — none after the last round')
eq(tl[tl.length - 1].kind, 'work', 'the block ends on work')
eq(blockSeconds(plan), 8 * 20 + 7 * 40, 'block length')
eq(timelineSeconds(tl), READY_SECONDS + blockSeconds(plan), 'timeline = ready + block')

const twoTl = buildTimeline(twoBlocks)
eq(twoTl.filter((p) => p.kind === 'break').length, 1, 'one break between two sets')
eq(twoTl.find((p) => p.kind === 'break')?.secs, 60, 'the break is a minute')

let r = readClock(tl, 0)
ok(r.phase.kind === 'ready' && Math.abs(r.remaining - READY_SECONDS) < 1e-9, 'second 0 is the ready beat')
r = readClock(tl, READY_SECONDS)
ok(r.phase.kind === 'work' && r.phase.round === 1, 'the ready beat hands straight to round 1')
r = readClock(tl, READY_SECONDS + 20 + 5)
ok(r.phase.kind === 'rest' && Math.abs(r.remaining - 35) < 1e-9, 'into the first rest with 35s left')
r = readClock(tl, READY_SECONDS + 3 * 60 + 10)
ok(r.phase.kind === 'work' && r.phase.round === 4, 'catch-up after a locked phone lands mid round 4')
ok(readClock(tl, 10_000).done, 'past the end reads done')

const half = roundsDone(plan, tl, READY_SECONDS + 3 * 60 + 10)
eq(half[0], 3, 'three rounds banked mid round 4')
eq(roundsDone(plan, tl, timelineSeconds(tl))[0], 8, 'all eight at the end')
eq(roundsDone(plan, tl, READY_SECONDS + 19.99)[0], 0, 'a round only counts once its clock has run out')

// ---- 5. filing it and reading it back -----------------------------------------

const blockRows = intervalSetLogs(oneBlock, [8], 1, 8)
eq(blockRows.length, 1, 'one row for the block')
ok(blockRows[0].done && blockRows[0].duration === 160 && blockRows[0].rpe === 8, 'the row holds the work, not the rest')
eq(roundsFromLogs(oneBlock, blockRows)[0], 8, 'and reads back as eight rounds')

const partial = intervalSetLogs(oneBlock, [5], 1)
ok(partial[0].duration === 100, 'ended early: five rounds of work')
eq(roundsFromLogs(oneBlock, partial)[0], 5, 'reads back as five')

const roundRows = intervalSetLogs(perRound, [5], 8)
eq(roundRows.length, 8, 'per-round grid keeps its eight rows')
eq(roundRows.filter((l) => l.done).length, 5, 'five of them done')
ok(roundRows.every((l, i) => (i < 5 ? l.duration === 20 : l.duration == null)), 'each done row is one round of work')
eq(roundsFromLogs(perRound, roundRows)[0], 5, 'reads back as five rounds')

const grown = intervalSetLogs(twoBlocks, [8, 3], 1)
eq(grown.length, 2, 'a block that outruns the grid grows it')
ok(grown[1].duration === 60, 'second set: three rounds of 20s')

const empty = intervalSetLogs(oneBlock, [0], 1)
ok(!empty[0].done && empty[0].duration == null, 'nothing done leaves the row empty')

// ---- 6. hand-built blocks round-trip through the coach's spec -----------------

for (const p of INTERVAL_PRESETS) {
  const built = manualPlan({ ...p, sets: 1 })
  const asEx = intervalExercise('Assault Bike', built)
  const back = intervalPlanFor(asEx)
  ok(back != null, `preset ${p.label} writes a spec that reads back`)
  if (!back) continue
  ok(back.work === built.work && back.rest === built.rest && back.rounds === built.rounds,
    `preset ${p.label} round-trips: "${asEx.reps}"`)
}
eq(intervalReps({ work: 20, rest: 40, rounds: 8 }), '8 × 20s on / 40s off', 'canonical spec')
eq(intervalReps({ work: 60, rest: 0, rounds: 10 }), 'EMOM 10 min', 'EMOM spec')
eq(intervalReps({ work: 240, rest: 180, rounds: 4 }), '4 × 4 min on / 3 min off', 'minutes spec')
const twoSet = intervalPlanFor(intervalExercise('Bike', manualPlan({ work: 20, rest: 10, rounds: 8, sets: 2 })))
ok(twoSet?.sets === 2 && twoSet.rounds === 8, 'two Tabatas round-trip as two sets')

eq(describePlan(oneBlock), '8 × 20s / 40s', 'list line')
eq(fmtDose(ex('Assault Bike', '8 × 20s on / 40s off')), '8 × 20s / 40s', 'a block is not "1×8 × 20s on / 40s off"')
eq(fmtDose(ex('Back Squat', '5', 3)), '3×5', 'straight sets unchanged')

// ---- 7. an interval block is timed, whatever the movement --------------------

eq(effectiveTrackingType({ name: 'Burpee', reps: '8 × 20s on / 40s off' }), 'time', 'burpee intervals log time')
eq(effectiveTrackingType({ name: 'Sprint', reps: '10 × 15s on / 45s off' }), 'time', 'sprint intervals log time')
eq(effectiveTrackingType({ name: 'Bike Intervals', reps: '10 x 30/30' }), 'time', 'an uncurated interval block is timed')
eq(effectiveTrackingType({ name: 'Bike Intervals', reps: '10 x 30/30', tracking_type: 'weight_reps' }), 'time',
  'even over a stale stamp — a block is timed by construction')
eq(effectiveTrackingType({ name: 'Back Squat', reps: '5' }), 'weight_reps', 'a squat is still a squat')
const swapped = buildSwap({ name: 'Assault Bike', sets: 1, reps: '8 × 20s on / 40s off' }, 'Kettlebell Swing')
eq(swapped.reps, '8 × 20s on / 40s off', 'swapping the bike out keeps the block')

// ---- 8. small helpers --------------------------------------------------------

eq(secondsFromReps('30s'), 30, '30s')
eq(secondsFromReps('10 min'), 600, '10 min is ten minutes, not ten seconds')
eq(secondsFromReps('1:30'), 90, '1:30')
eq(secondsFromReps('8'), null, 'a rep count has no seconds')
eq(stepSeconds(20, 1, 5), 25, 'fine steps under a minute')
eq(stepSeconds(60, -1, 5), 55, 'stepping down from a minute stays fine')
eq(stepSeconds(60, 1, 5), 75, 'coarser above a minute')
eq(stepSeconds(5, -1, 5), 5, 'clamped at the floor')
eq(stepSeconds(5, -1, 0), 0, 'rest may reach zero')

if (fails.length) {
  console.error(`intervals.check: ${fails.length} of ${checks} failed`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`intervals.check: ${checks} checks passed`)
