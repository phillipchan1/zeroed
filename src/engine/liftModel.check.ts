// Standalone integrity check for the lift model (no test runner installed, same
// convention as prescription.check.ts).
// Run: node --experimental-strip-types src/engine/liftModel.check.ts
//
// What has to hold for the numbers on the bar to be trustworthy:
//
//   · "squat" is the squat — not Cossacks, ATG split squats or Bulgarians — and
//     "press" is the press, not the bench
//   · the same set logged twice counts once
//   · e1RM reads the RPE: 315×3 @6 and 315×3 @9 are different maxes
//   · only qualifying sets set the working max, and a light day can't drag it down
//   · a miss repeats or drops the load, and two misses pull the max down with it
//   · the call is per lift: push / hold / drop off that lift's own top set
//   · knee, sleep, missed weeks and deload each move the load, and say so
//   · nothing is prescribed above the all-time best +2.5% — a 125 presser is
//     never handed a 135 single
//   · every number carries a reason line

import {
  canonicalLiftId, parseLiftId, rpePercent, e1rmFromSet, loadForReps,
  readModelLog, dedupeSets, isQualifying, workingMaxAsOf, workingMaxSeries, trendOver,
  allTimeBest, ceilingLoad, backoffLoad, weeklyCall, dayOfModifiers, missedWeeksModifier,
  buildLiftModel, buildLiftModels, prescriptionFromProgram, renderLiftModel, sessionFlags,
  mondayOf, addDays, shortDay, targetReps, percentOf, liftIncrement, recencyFactor,
  modelFromSources, previewTrainingMax, BLOCK_TARGET_RPE,
  type LiftSet, type TopSetWeek, type ModelWorkout,
} from './liftModel.ts'
import { PHASE_RPE } from './prescription.ts'
import { readFileSync } from 'node:fs'

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
function near(actual: number | null | undefined, expected: number, tol: number, msg: string) {
  checks++
  if (actual == null || Math.abs(actual - expected) > tol) fails.push(`${msg} — expected ≈${expected}, got ${String(actual)}`)
}

// ---- fixtures ---------------------------------------------------------------

const TODAY = '2026-10-26'   // a Monday
const s = (
  exercise: string, date: string, weight: number, reps: number, rpe: number | null, missedReps = 0,
): LiftSet => ({ lift: canonicalLiftId(exercise), exercise, date, weight, reps, rpe, missedReps, workoutId: null })

// ---- canonical identity ----------------------------------------------------

for (const [name, id] of [
  ['Squat (no belt)', 'squat'], ['Low bar squat', 'squat'], ['High-bar squat', 'squat'], ['Back Squat', 'squat'],
  ['Bench press', 'bench'], ['Bench', 'bench'], ['Bench Press (paused)', 'bench'],
  ['Deadlift (conventional, no belt)', 'deadlift'], ['Conventional deadlift', 'deadlift'],
  ['Strict OHP', 'ohp'], ['Overhead Press', 'ohp'], ['Military press', 'ohp'],
] as const) eq(canonicalLiftId(name), id, `${name} is the ${id}`)

for (const name of [
  'Cossack Squat', 'ATG split squat', 'Bulgarian Split Squat', 'Pause squat', 'Tempo squat', 'Front Squat',
  'Box Squat', 'Belt Squat', 'Goblet Squat', 'Close-grip bench', 'Bench press (close grip)', 'Incline Bench Press',
  'DB Bench Press', 'Banded bench press', 'Sumo deadlift', 'Deficit deadlift', 'Romanian Deadlift',
  'Trap Bar Deadlift', 'Push press', 'Seated OHP', 'Overhead press (seated)', 'DB Shoulder Press', 'Landmine press',
]) eq(canonicalLiftId(name), null, `${name} is NOT a main lift`)

eq(parseLiftId('press'), 'ohp', '"press" asks for the overhead press')
eq(parseLiftId('OHP'), 'ohp', '"OHP" is the press')
eq(parseLiftId('bench'), 'bench', '"bench" is the bench')
eq(parseLiftId('dl'), 'deadlift', '"dl" is the deadlift')

// ---- the RPE chart ---------------------------------------------------------

near(rpePercent(1, 10), 1.0, 1e-9, 'a single at 10 is the max')
near(rpePercent(1, 8), 0.922, 1e-9, '1 @8 = 92.2%')
near(rpePercent(5, 8), 0.811, 1e-9, '5 @8 = 81.1%')
near(rpePercent(3, 8), 0.863, 1e-9, '3 @8 = 86.3% (same as 5 @10)')
near(rpePercent(6, 9.5), 0.824, 1e-9, '6 @9.5 = 82.4%')
near(rpePercent(10, 6), 0.626, 1e-9, '10 @6 = 62.6%')
eq(rpePercent(13, 8), null, 'off the chart past 12 reps')
eq(rpePercent(5, 5), null, 'off the chart under RPE 6')
near(e1rmFromSet(365, 1, 8), 365 / 0.922, 1e-6, '365×1 @8 → 395.9')
ok(e1rmFromSet(315, 3, 6)! > e1rmFromSet(315, 3, 9)!, 'an easy triple says more about the max than a grinder')
near(e1rmFromSet(185, 5, null), 185 / 0.863, 1e-6, 'no RPE reads as 10 — a floor')
near(loadForReps(400, 5, 8), 324.4, 0.01, '5 @8 off a 400 max is 324.4')

// ---- reading the log ---------------------------------------------------------

{
  const workouts: ModelWorkout[] = [{
    id: 'w1',
    performed_at: '2026-10-20T01:30:00Z',   // Oct 19, 6:30pm in LA
    actual_weights: {
      '0': [
        { set: 1, weight: 315, reps: 5, rpe: 8, done: true },
        { set: 2, weight: 315, reps: 3, rpe: 10, done: true, missed_reps: 2 },
        { set: 3, weight: null, reps: null, rpe: null, done: false },
      ],
      '1': [{ set: 1, weight: 40, reps: 8, rpe: 7, done: true }],
    },
    exercises_snapshot: [
      { name: 'Squat (no belt)', sets: 3, reps: '5' },
      { name: 'Cossack Squat', sets: 2, reps: '8' },
    ],
    knee_pain_l: 2, knee_pain_r: 5, sleep_hours: 7, readiness: null, bodyweight: 205,
  }]
  const { sets, checkins } = readModelLog(workouts)
  eq(sets.length, 3, 'empty sets are not sets')
  eq(sets[0].date, '2026-10-19', 'dated on the athlete\'s calendar, not UTC')
  eq(sets[0].lift, 'squat', 'logged squat resolves')
  eq(sets[1].missedReps, 2, 'missed reps ride along')
  eq(sets[2].lift, null, 'the Cossack is not the squat')
  eq(checkins.length, 1, 'one check-in per session')
  eq(checkins[0].kneePainR, 5, 'knee pain read off the row')
}

{
  const dup = [s('Squat', '2026-10-19', 315, 5, 7), s('Squat', '2026-10-19', 315, 5, 8), s('Squat', '2026-10-19', 315, 4, 8)]
  const { sets, removed, duplicates } = dedupeSets(dup)
  eq(removed, 1, 'same lift, day, load and reps is one set')
  eq(duplicates.squat ?? 0, 0, 'straight sets in one session are not duplicate logs')
  const twice = dedupeSets([{ ...s('Squat', '2026-10-19', 315, 5, 8), workoutId: 'a' }, { ...s('Squat', '2026-10-19', 315, 5, 8), workoutId: 'b' }])
  eq(twice.duplicates.squat, 1, 'the same set from two workout rows is a duplicate log')
  eq(sets.find((x) => x.reps === 5)?.rpe, 8, 'the harder reading survives a merge')
  eq(dedupeSets([s('Squat', '2026-10-19', 315, 5, 8), s('Squat', '2026-10-20', 315, 5, 8)]).removed, 0, 'a different day is a different set')
}

// ---- qualifying + working max ---------------------------------------------

ok(isQualifying(s('Squat', TODAY, 315, 5, 8)), '5 @8 on the squat qualifies')
ok(!isQualifying(s('Squat', TODAY, 275, 7, 8)), '7 reps does not')
ok(!isQualifying(s('Squat', TODAY, 365, 1, 10)), 'RPE 10 does not')
ok(!isQualifying(s('Squat', TODAY, 225, 5, 5.5)), 'RPE 5.5 does not')
ok(!isQualifying(s('Squat', TODAY, 315, 5, null)), 'no RPE does not')
ok(!isQualifying(s('Squat', TODAY, 315, 3, 9, 2)), 'a set with missed reps does not')
ok(!isQualifying(s('Cossack Squat', TODAY, 50, 5, 8)), 'a Cossack does not')

eq(recencyFactor(0), 1, 'today counts in full')
near(recencyFactor(21), 0.95, 1e-9, 'half the discount is gone at three weeks')

{
  // A recent 5 @8 at 330 (e1RM 406.9) vs a heavier-looking single five weeks back.
  const log = [
    s('Squat', '2026-09-21', 365, 1, 8),     // e1RM 395.9, 35 days old
    s('Squat', '2026-10-19', 330, 5, 8),     // e1RM 406.9, 7 days old
    s('Squat', '2026-10-22', 205, 5, 6),     // a deload top set: e1RM 277 — must not drag
  ]
  const wm = workingMaxAsOf(log, 'squat', TODAY)!
  eq(wm.anchor.date, '2026-10-19', 'the recent five beats the old single')
  near(wm.value, (330 / 0.811) * recencyFactor(7), 0.01, 'working max is the recency-weighted best')
  ok(wm.value > 390, 'a deload day does not drag the working max down')
  eq(wm.sessions, 3, 'three sessions of evidence')

  const old = workingMaxAsOf([s('Squat', '2026-08-01', 400, 1, 8)], 'squat', TODAY)
  eq(old, null, 'nothing older than six weeks counts')

  // No RPE at all in range → read at 10, flagged.
  const floor = workingMaxAsOf([s('Squat', '2026-10-19', 300, 5, null)], 'squat', TODAY)!
  eq(floor.basis, 'no_rpe_floor', 'an RPE-less window is a floor, and says so')
  near(floor.value, (300 / 0.863) * recencyFactor(7), 0.01, '300×5 with no RPE → floor 347.6, discounted')

  // Two missed reps on the newest session cap the max at the failure.
  const missed = workingMaxAsOf([
    s('Squat', '2026-10-12', 330, 5, 8),
    s('Squat', '2026-10-22', 340, 3, null, 2),
  ], 'squat', TODAY)!
  eq(missed.basis, 'capped_by_miss', '2+ missed recomputes the working max')
  near(missed.value, 340 / 0.922, 0.01, '340 for 3 (of 5) caps it at 340×3 @10 = 368.8')
}

{
  const climbing = [0, 7, 14, 21, 28].map((d, i) => s('Bench press', addDays('2026-09-28', d), 225 + i * 5, 5, 8))
  const series = workingMaxSeries(climbing, 'bench', TODAY)
  eq(series.length, 5, 'one working-max point per session')
  const t4 = trendOver(series, TODAY, 4)!
  ok(t4.perWeek > 0, `a climbing bench trends up (${t4.perWeek}/wk)`)
  ok(trendOver(series.slice(-1), TODAY, 4) === null, 'one point is not a trend')
}

// ---- all-time best + ceiling ----------------------------------------------

{
  const log = [s('Strict OHP', '2026-07-10', 125, 1, 9), s('Strict OHP', '2026-10-19', 115, 5, 7)]
  const best = allTimeBest(log, 'ohp')!
  eq(best.heaviest.weight, 125, 'heaviest press logged is 125')
  const cap = ceilingLoad(best, 1, 8)
  ok(cap <= 125 * 1.025 + 1e-9, `ceiling on a single is the best +2.5% (${cap})`)
}

// ---- in-session + weekly calls ---------------------------------------------

near(backoffLoad(300, 9, 8, false).load, 285, 1e-9, 'a top set a point heavy takes 5% off the back-offs')
near(backoffLoad(300, 7, 8, false).load, 315, 1e-9, 'a point light adds 5% on a lower lift')
near(backoffLoad(200, 7, 8, true).load, 205, 1e-9, '…and 2.5% on an upper one')
near(backoffLoad(300, 8.5, 8, false).load, 300, 1e-9, 'half a point either way is the plan working')

{
  const wk = (weekStart: string, weight: number, rpe: number | null, missedReps = 0): TopSetWeek => ({
    weekStart, top: s('Squat', addDays(weekStart, 1), weight, 5, rpe), missedReps, lastSessionDate: addDays(weekStart, 1),
  })
  const call = (last: TopSetWeek | null, prior: TopSetWeek | null, upper = false, pain: string | null = null) =>
    weeklyCall({ upper, target: 8, last, prior, pain })
  eq(call(wk('2026-10-19', 300, 8), null).call, 'push', 'on target → push')
  eq(call(wk('2026-10-19', 300, 7.5), null).deltaPct, 5, 'lower body pushes 5%')
  eq(call(wk('2026-10-19', 200, 7), null, true).deltaPct, 2.5, 'upper body pushes 2.5%')
  eq(call(wk('2026-10-19', 300, 8.5), null).call, 'hold', 'within half a point over → hold')
  eq(call(wk('2026-10-19', 300, 9.5), wk('2026-10-12', 295, 8)).call, 'hold', 'one week over is not a trend')
  eq(call(wk('2026-10-19', 300, 9), wk('2026-10-12', 300, 8.5)).call, 'drop', 'over target two weeks running → drop')
  eq(call(wk('2026-10-19', 300, 9), wk('2026-10-12', 300, 8.5)).deltaPct, -5, 'a drop is 5%')
  eq(call(wk('2026-10-19', 300, 7), null, false, 'pain flag on Oct 20').call, 'hold', 'pain blocks a push')
  eq(call(wk('2026-10-19', 300, 8, 1), null).call, 'repeat', '1 missed rep repeats the load')
  eq(call(wk('2026-10-19', 300, 8, 3), null).deltaPct, -5, '2+ missed reps drops 5%')
  eq(call(wk('2026-10-19', 300, null), null).call, 'hold', 'no RPE → hold, never a guess')
}

// ---- modifiers --------------------------------------------------------------

{
  const sore = { kneePainL: 1, kneePainR: 5 }
  eq(dayOfModifiers('Squat (no belt)', sore)[0]?.factor, 0.9, 'knee 5/10 takes 10% off the squat')
  eq(dayOfModifiers('Walking Lunge', sore)[0]?.factor, 0.9, '…and off lunges')
  eq(dayOfModifiers('Box Jump', sore)[0]?.skip, true, 'jumps are skipped over 3/10')
  eq(dayOfModifiers('Box Jump', { kneePainL: 3 }).length, 0, 'jumps are fine at 3/10')
  eq(dayOfModifiers('Bench press', sore).length, 0, 'a knee does not touch the bench')
  const tired = dayOfModifiers('Bench press', { sleepHours: 5.5 })
  eq(tired[0]?.factor, 0.95, 'under 6h of sleep takes 5% off')
  eq(tired[0]?.rpeCap, 7, '…and caps RPE at 7')
  eq(dayOfModifiers('Deadlift', { readiness: 4 })[0]?.rpeCap, 7, 'readiness under 5 caps it too')
  eq(missedWeeksModifier(1)?.factor, 0.95, 'one missed week is −5%')
  eq(missedWeeksModifier(3)?.factor, 0.9, 'two or more is −10%')
  eq(missedWeeksModifier(0), null, 'no missed weeks, no modifier')
}

// ---- the whole model --------------------------------------------------------

const REASON = /^\d+(\.\d)? = \d+% of TM \d+( \(set by hand\))? \(from \d+(\.\d)?x\d+ @\d+(\.\d)?, [A-Z][a-z]{2} \d+\)$/

{
  // Squat: three clean weeks at 5 @8, last week on target.
  const log = [
    s('Squat (no belt)', '2025-03-01', 405, 1, 9),   // an old PR — outside the window, inside the ceiling
    s('Squat (no belt)', '2026-10-06', 315, 5, 8),
    s('Squat (no belt)', '2026-10-13', 320, 5, 8),
    s('Squat (no belt)', '2026-10-20', 325, 5, 8),
    s('Cossack Squat', '2026-10-20', 60, 8, 9),
    s('ATG split squat', '2026-10-21', 95, 6, 9),
  ]
  const m = buildLiftModel({
    lift: 'squat', sets: log, today: TODAY,
    prescription: { sets: 3, reps: '5', targetRpe: 8, exercise: 'Squat (no belt)' },
  })
  const r = m.recommendation!
  eq(r.call, 'push', 'squat on target last week pushes')
  eq(r.basis, 'last_top_set', 'same rep target → the last top set is the base')
  eq(r.load, 340, '325 + 5% = 341 → 340')
  ok(REASON.test(r.reason), `reason line has the shape "245 = 65% of TM 377 (from 365x1 @8, Oct 6)" — got "${r.reason}"`)
  ok(m.lastQualifying.every((q) => q.lift === 'squat'), 'nothing but squats in the squat\'s evidence')
  eq(m.trainingMax!.source, 'computed', 'TM is computed without an override')
  near(m.trainingMax!.value, m.workingMax!.value * 0.9, 1e-9, 'TM = 90% of the working max')
  ok(r.conditional.some((c) => c.includes('sleep')), 'the sleep rule is stated when today\'s check-in is unknown')

  // Without that old PR, 325×5 IS the heaviest squat ever — the push is held to +2.5%.
  const atBest = buildLiftModel({
    lift: 'squat', sets: log.slice(1), today: TODAY,
    prescription: { sets: 3, reps: '5', targetRpe: 8, exercise: 'Squat (no belt)' },
  }).recommendation!
  eq(atBest.load, 330, 'at a lifetime best, 341 is capped at 325 + 2.5% = 333 → 330')
  eq(atBest.capped, true, 'and flagged as capped')
}

{
  // The sanity check: best logged strict press is 125. A fast set of fives makes
  // the chart think a 135 single is RPE 8 — it must not be prescribed.
  const log = [
    s('Strict OHP', '2026-07-14', 125, 1, 9),
    s('Strict OHP', '2026-10-06', 110, 5, 7),
    s('Strict OHP', '2026-10-13', 115, 5, 7),
    s('Strict OHP', '2026-10-20', 115, 5, 7),
  ]
  const single = buildLiftModel({
    lift: 'ohp', sets: log, today: TODAY,
    prescription: { sets: 1, reps: '1', targetRpe: 8, exercise: 'Strict OHP' },
  }).recommendation!
  ok(single.load !== 135, `no 135 single for a 125 presser (got ${single.load})`)
  ok(single.load <= 125 * 1.025, `the single stays under 125 + 2.5% (got ${single.load})`)
  eq(single.capped, true, 'and says it was capped')
  eq(single.load % 2.5, 0, 'pressing loads round to 2.5')
  ok(single.why.some((w) => w.startsWith('capped')), 'the cap is in the reason')

  const testDay = buildLiftModel({
    lift: 'ohp', sets: log, today: TODAY, testDay: true,
    prescription: { sets: 1, reps: '1', targetRpe: 8, exercise: 'Strict OHP' },
  }).recommendation!
  ok(testDay.load > 128, `a flagged test day lifts the ceiling (got ${testDay.load})`)

  const fives = buildLiftModel({
    lift: 'ohp', sets: log, today: TODAY,
    prescription: { sets: 3, reps: '5', targetRpe: 8, exercise: 'Strict OHP' },
  }).recommendation!
  eq(fives.call, 'push', 'fives at @7 push')
  eq(fives.load, 117.5, '115 + 2.5% = 117.9 → 117.5')
}

{
  // TM override and a program percentage: every number moves off the hand-set TM.
  const log = [s('Bench press', '2026-10-20', 245, 3, 8)]
  const m = buildLiftModel({
    lift: 'bench', sets: log, today: TODAY, tmOverride: 275,
    prescription: { sets: 5, reps: '5', load: '65%', exercise: 'Bench press' },
  })
  eq(m.trainingMax!.source, 'override', 'a hand-set TM wins')
  eq(m.recommendation!.load, 180, '65% of TM 275 = 178.75 → 180')
  eq(m.recommendation!.pctOfTm, 65, 'shown as a % of TM')
  ok(m.recommendation!.reason.includes('(set by hand)'), 'the reason says the TM was set by hand')
}

{
  // Deload: 65% of TM, RPE ≤ 6.
  const m = buildLiftModel({
    lift: 'deadlift', sets: [s('Deadlift', '2026-10-21', 405, 3, 8)], today: TODAY, deload: true,
  })
  eq(m.recommendation!.call, 'deload', 'a deload week is a deload')
  eq(m.recommendation!.rpeCap, 6, 'RPE capped at 6')
  eq(m.recommendation!.pctOfTm, 65, '65% of TM')
}

{
  // Two weeks off the bench: −10%, re-establish, no push.
  const m = buildLiftModel({
    lift: 'bench', sets: [s('Bench press', '2026-10-06', 225, 5, 7)], today: TODAY,
    prescription: { sets: 3, reps: '5', targetRpe: 8 },
  })
  eq(m.missedWeeks, 2, 'two weeks without the bench')
  eq(m.recommendation!.call, 'establish', 're-establish after two or more')
  eq(m.recommendation!.load, 205, '225 − 10% = 202.5 → 205')

  // Months off: the max is carried as it stood the last day the lift was trained.
  const gone = buildLiftModel({
    lift: 'squat', today: TODAY,
    sets: [s('Squat', '2026-05-27', 260, 5, 6), s('Squat', '2026-06-17', 275, 3, null)],
  })
  eq(gone.workingMax!.basis, 'carried', 'a max with nothing in the window is carried, and says so')
  near(gone.workingMax!.value, (260 / 0.762) * recencyFactor(21), 0.01, 'at its value on the last day trained (Jun 17), not its peak')
  ok(gone.missedWeeks > 2 && gone.recommendation!.call === 'establish', 'and the load re-establishes')
}

{
  // Knee pain this week takes the squat down 10% and blocks the push.
  const m = buildLiftModel({
    lift: 'squat', sets: [s('Squat', '2026-10-20', 300, 5, 7)], today: TODAY,
    checkins: [{ date: '2026-10-21', kneePainL: 0, kneePainR: 6, sleepHours: null, readiness: null, bodyweight: null }],
    prescription: { sets: 3, reps: '5', targetRpe: 8 },
  })
  eq(m.recommendation!.call, 'hold', 'knee pain ≥ 4 is a pain flag: no push')
  eq(m.recommendation!.load, 300, 'but last week\'s knee says nothing about today\'s load')

  const today = buildLiftModel({
    lift: 'squat', sets: [s('Squat', '2026-10-20', 300, 5, 7)], today: TODAY,
    dayOf: { kneePainR: 6, sleepHours: 5 },
    prescription: { sets: 3, reps: '5', targetRpe: 8 },
  }).recommendation!
  near(today.load, 255, 0.01, 'knee −10% and short sleep −5% today: 300 × 0.9 × 0.95 = 256.5 → 255')
  eq(today.rpeCap, 7, 'short sleep caps RPE at 7')
}

{
  // Detrained: working max well under the old best.
  const m = buildLiftModel({
    lift: 'deadlift', today: TODAY,
    sets: [s('Deadlift', '2026-03-02', 480, 1, 9), s('Deadlift', '2026-10-20', 365, 3, 8)],
  })
  eq(m.detrained, true, 'a working max under 90% of the best reads as returning')
  ok(m.notes.some((n) => n.startsWith('returning')), 'and says so')
}

{
  const models = buildLiftModels({ sets: [s('Squat', '2026-10-20', 300, 5, 8)], today: TODAY })
  eq(models.bench.recommendation, null, 'no bench history, no bench number')
  ok(renderLiftModel(models.squat).includes('Reason: '), 'the rendered model carries the reason line')
  ok(renderLiftModel(models.bench).includes('nothing to recommend'), 'and an empty lift says so')
}

// ---- small parts -------------------------------------------------------------

eq(mondayOf('2026-10-26'), '2026-10-26', 'Oct 26 2026 is a Monday')
eq(mondayOf('2026-11-01'), '2026-10-26', 'Sunday belongs to the week before it')
eq(shortDay('2026-10-06'), 'Oct 6', 'short day')
eq(targetReps('3-5')?.hi, 5, 'a range loads for its top')
eq(targetReps('5')?.lo, 5, 'a single number')
eq(percentOf('65%'), 65, 'a percentage')
eq(percentOf('65-70% TM'), 67.5, 'a percentage range')
eq(percentOf('~275 lbs'), null, 'a load is not a percentage')
eq(liftIncrement('ohp', 'lb'), 2.5, 'press rounds to 2.5 lb')
eq(liftIncrement('squat', 'lb'), 5, 'everything else to 5 lb')
eq(sessionFlags('Week 5 deload').deload, true, 'a deload session is flagged')
eq(sessionFlags('Lower A').deload, false, 'a normal one is not')
eq(sessionFlags('Retest week').testDay, true, 'a retest is a test day')
eq(prescriptionFromProgram('ohp', [
  { name: 'Upper A', exercises: [{ name: 'Bench press', sets: 3, reps: '5' }, { name: 'Strict OHP', sets: 3, reps: '5', target_rpe: 7 }] },
])?.targetRpe, 7, 'the program\'s press prescription is found by identity')

// ---- from rows (what the app and the MCPs actually call) -----------------------

{
  const row = (id: string, at: string, sets: Array<[number, number, number | null, number?]>, extra: Partial<ModelWorkout> = {}): ModelWorkout => ({
    id, performed_at: at,
    actual_weights: { '0': sets.map(([weight, reps, rpe, missed], i) => ({ set: i + 1, weight, reps, rpe, done: true, missed_reps: missed ?? null })) },
    exercises_snapshot: [{ name: 'Strict OHP', sets: 3, reps: '5' }],
    ...extra,
  })
  const workouts = [
    row('a', '2026-07-14T19:00:00Z', [[125, 1, 9]]),
    row('b', '2026-10-13T19:00:00Z', [[115, 5, 7], [115, 5, 7], [115, 5, 7.5]]),
    row('b-again', '2026-10-13T19:05:00Z', [[115, 5, 7]]),   // the same session, synced twice
    row('c', '2026-10-20T19:00:00Z', [[115, 5, 7], [115, 5, 7]]),
  ]
  const sessions = [{ name: 'Upper B', intent: 'press day', exercises: [{ name: 'Strict OHP', sets: 1, reps: '1', target_rpe: 8 }] }]
  const m = modelFromSources('ohp', { workouts, sessions, today: TODAY, phaseName: 'Strength' })
  eq(m.duplicatesRemoved, 1, 'a session synced twice is counted once, and reported')
  ok(m.recommendation!.load <= 125 * 1.025, `the program's OHP single is capped off the real log (got ${m.recommendation!.load})`)
  eq(m.recommendation!.targetRpe, 8, 'the lift\'s own target RPE wins over the block\'s')

  const deload = modelFromSources('ohp', { workouts, today: TODAY, sessions: [{ name: 'Week 5 deload', exercises: sessions[0].exercises }] })
  eq(deload.recommendation!.call, 'deload', 'a session called a deload deloads')
  const avg = modelFromSources('ohp', { workouts, sessions, today: TODAY, directive: 'DELOAD' })
  ok(avg.recommendation!.call !== 'deload', 'the averaged weekly DELOAD does not move a single lift')

  const pv = previewTrainingMax('ohp', 140, { workouts, sessions, today: TODAY })
  ok(pv.includes('→ 140lb (set by hand)'), 'a TM write previews before → after')
  ok(pv.includes('This week after:'), 'and what it does to this week')
}

// ---- drift guards ---------------------------------------------------------------

for (const [phase, contract] of Object.entries(PHASE_RPE)) {
  eq(BLOCK_TARGET_RPE[phase], contract.target, `BLOCK_TARGET_RPE.${phase} matches PHASE_RPE`)
}
{
  // The edge function and the Worker read a copy; it may differ only in the type import.
  const here = readFileSync(new URL('./liftModel.ts', import.meta.url), 'utf8')
  const copy = readFileSync(new URL('../../supabase/functions/_shared/engine/liftModel.ts', import.meta.url), 'utf8')
  const strip = (t: string) => t.replace(/^import type \{[^}]*\} from '[^']*'\n/m, '')
  ok(strip(here) === strip(copy), 'supabase/functions/_shared/engine/liftModel.ts is in sync with src/engine/liftModel.ts')
}

if (fails.length) {
  console.error(`liftModel.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`liftModel.check: ${checks} checks passed`)
