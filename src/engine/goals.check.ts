// Run: node --experimental-strip-types src/engine/goals.check.ts
import {
  applyMeasurement, cadenceDays, computeGoalStatus, forecastAtDue, goalDisplayStatus, lastMeasuredOn, pairKey, progressRatio, projectedAtDue,
} from './goals.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const jump = applyMeasurement(
  { name: 'Broad jump', metric: 'distance', direction: 'higher', target: 100, current: 95, best: 95, baseline: 95 },
  { date: '2026-11-03', value: 97, source: 'workout_log' },
)
ok(jump.current === 97 && jump.best === 97, 'broad jump 97" updates current and best')

const jumpFixture = {
  name: 'Broad jump', metric: 'distance', direction: 'higher' as const,
  target: 100, current: 95, best: 95, baseline: 95, due_date: '2026-12-11',
}
const jumpToday = computeGoalStatus(jumpFixture, [], '2026-11-03')
ok(jumpToday !== 'hit', `Broad jump 95 / 100 is not hit, got ${jumpToday}`)
ok(jumpToday === 'on_track', `Broad jump 95 / 100 well before due is on_track, got ${jumpToday}`)
ok(
  computeGoalStatus({ ...jumpFixture, current: '95' as unknown as number, target: '100' as unknown as number }, [], '2026-11-03') !== 'hit',
  'Broad jump string numerics from Postgres are not hit via "95" >= "100"',
)
ok(computeGoalStatus({ ...jumpFixture, current: 100 }, [], '2026-11-03') === 'hit', 'Broad jump hits at 100')
ok(computeGoalStatus({ ...jumpFixture, current: 101 }, [], '2026-11-03') === 'hit', 'Broad jump above target is hit')

ok(
  computeGoalStatus(
    { name: 'Bench 1RM', metric: 'e1rm', direction: 'higher', target: 295, target_range_hi: 300, current: 294 },
    [], '2026-11-03',
  ) !== 'hit',
  'higher respects the range floor: 294 does not hit 295–300',
)
ok(
  computeGoalStatus(
    { name: 'Bench 1RM', metric: 'e1rm', direction: 'higher', target: 295, target_range_hi: 300, current: 298 },
    [], '2026-11-03',
  ) === 'hit',
  'higher 298 hits the 295–300 window',
)
ok(
  computeGoalStatus(
    { name: 'Bench 1RM', metric: 'e1rm', direction: 'higher', target: 295, target_range_hi: 300, current: 301 },
    [], '2026-11-03',
  ) !== 'hit',
  'higher respects target_range_hi: 301 is above the 295–300 window',
)
ok(
  computeGoalStatus(
    {
      name: 'Bench 1RM', metric: 'e1rm', direction: 'higher',
      target: '295' as unknown as number,
      target_range_hi: '300' as unknown as number,
      current: '301' as unknown as number,
    },
    [], '2026-11-03',
  ) !== 'hit',
  'higher string target_range_hi still rejects 301',
)

ok(
  computeGoalStatus({ name: 'Drop-off', metric: 'pct', direction: 'lower', target: 5, current: 7 }, [], '2026-11-03') !== 'hit',
  'lower 7 / 5 is not hit',
)
ok(
  computeGoalStatus({ name: 'Drop-off', metric: 'pct', direction: 'lower', target: 5, current: 5 }, [], '2026-11-03') === 'hit',
  'lower hits at the target',
)
ok(
  computeGoalStatus({ name: 'Drop-off', metric: 'pct', direction: 'lower', target: 5, current: 4 }, [], '2026-11-03') === 'hit',
  'lower hits under the target',
)
ok(
  computeGoalStatus(
    { name: 'Drop-off', metric: 'pct', direction: 'lower', target: '5' as unknown as number, current: '7' as unknown as number },
    [], '2026-11-03',
  ) !== 'hit',
  'lower string numerics are not hit via "7" <= "5"',
)

ok(
  computeGoalStatus({ name: 'Wall test', metric: 'wall_test', direction: 'pass', current: 0 }, [], '2026-11-03') !== 'hit',
  'pass is not hit on a fail (0)',
)
ok(
  computeGoalStatus({ name: 'Wall test', metric: 'wall_test', direction: 'pass', current: 1 }, [], '2026-11-03') === 'hit',
  'pass is hit only on a pass (1)',
)
ok(
  computeGoalStatus({ name: 'Wall test', metric: 'wall_test', direction: 'pass' }, [], '2026-11-03') !== 'hit',
  'pass is not hit with no measurement',
)
ok(
  computeGoalStatus({ name: 'Wall test', metric: 'wall_test', direction: 'pass', target: 0, current: 0 }, [], '2026-11-03') !== 'hit',
  'pass does not treat target 0 as a hit',
)

ok(lastMeasuredOn([]) === null, 'no measurements → last_measured is null')
ok(
  lastMeasuredOn([{ date: '2026-10-01', value: 95, source: 'manual', client_key: 'seed:broad-jump-95' }]) === null,
  'seed Broad jump 2026-10-01 is not a real last_measured',
)
ok(
  lastMeasuredOn([
    { date: '2026-10-01', value: 95, source: 'manual', client_key: 'seed:broad-jump-95' },
    { date: '2026-11-03', value: 97, source: 'workout_log' },
  ]) === '2026-11-03',
  'last_measured is the latest real measured_on',
)

const hipL = computeGoalStatus(
  { name: 'Hip IR L', metric: 'hip_ir', direction: 'higher', target: 35, current: 30, baseline: 30, due_date: '2026-11-30' },
  [{ date: '2026-11-02', value: 30, source: 'manual' }, { date: '2026-11-09', value: 30, source: 'manual' }],
  '2026-11-20',
)
ok(hipL === 'behind', `Hip IR 30 with a flat trend near due is behind, got ${hipL}`)
const hipR = computeGoalStatus(
  { name: 'Hip IR R', metric: 'hip_ir', direction: 'higher', target: 35, current: 34, baseline: 34, due_date: '2026-11-30' },
  [{ date: '2026-11-02', value: 34, source: 'manual' }],
  '2026-11-20',
)
ok(hipR === 'behind', `Hip IR 34 flat near due is behind, got ${hipR}`)
ok(pairKey('Hip IR L') === pairKey('Hip IR R'), 'L/R pair by name stem')

const benchHit = computeGoalStatus(
  { name: 'Bench 1RM', metric: 'e1rm', direction: 'higher', target: 295, current: 298, baseline: 285, due_date: '2026-12-11' },
  [],
  '2026-11-03',
)
ok(benchHit === 'hit', 'bench at 298 hits the 295–300 window')

const open = computeGoalStatus(
  { name: 'Strict OHP', metric: 'load', direction: 'higher', target: 155, current: 125 },
  [],
  '2026-11-03',
)
ok(open === 'on_track', 'open-ended OHP with no due date is on track')

ok(progressRatio({ name: 'x', metric: 'm', direction: 'higher', baseline: 95, current: 97, target: 100 }) === 0.4, '95 → 97 toward 100 is 40%')
const projected = projectedAtDue(
  [{ date: '2026-10-01', value: 90, source: 'manual' }, { date: '2026-11-01', value: 96, source: 'manual' }],
  '2026-12-01',
)
ok(projected != null && projected > 100 && projected < 103, `linear projection continues the slope, got ${projected}`)

const pressGoal = { name: 'Strict press', metric: 'top_set', direction: 'higher' as const, target: 130, baseline: 112, current: 120, due_date: '2026-11-27' }
const pressHist = [
  { date: '2026-09-30', value: 112, source: 'workout_log' }, { date: '2026-10-07', value: 115, source: 'workout_log' },
  { date: '2026-10-14', value: 120, source: 'workout_log' }, { date: '2026-10-21', value: 120, source: 'workout_log' },
  { date: '2026-10-28', value: 120, source: 'workout_log' },
]
const pressFc = forecastAtDue(pressGoal, pressHist)
ok(pressFc?.value === 120 && pressFc.perWeek === 0, `a press flat for three weeks forecasts 120, got ${pressFc?.value}`)
ok(pressFc?.neededPerWeek != null && pressFc.neededPerWeek > 2 && pressFc.neededPerWeek < 2.5, `needs about 2.3 lb a week, got ${pressFc?.neededPerWeek}`)
ok(computeGoalStatus(pressGoal, pressHist, '2026-11-04') === 'behind', 'a stalled press 23 days out is behind, not on track')
const benchGoal = { name: 'Bench', metric: 'e1rm', direction: 'higher' as const, target: 285, baseline: 262, current: 275, due_date: '2026-11-27' }
const benchHist = [
  { date: '2026-10-19', value: 266, source: 'workout_log' }, { date: '2026-10-26', value: 271, source: 'workout_log' },
  { date: '2026-11-02', value: 275, source: 'workout_log' },
]
ok(computeGoalStatus(benchGoal, benchHist, '2026-11-04') === 'on_track', 'bench climbing 4.5 a week reaches 285 by the 27th')
ok(forecastAtDue({ ...benchGoal, due_date: null }, benchHist) === null, 'no due date, no forecast')
ok(forecastAtDue(benchGoal, [benchHist[0]]) === null, 'one point is not a trend')
ok(forecastAtDue(benchGoal, [{ date: '2026-11-01', value: 270, source: 'manual', client_key: 'seed:a' }, ...benchHist.slice(2)]) === null, 'seed rows do not make a trend')
const rangeGoal = { ...benchGoal, target: 280, target_range_hi: 284, current: 279 }
ok(computeGoalStatus(rangeGoal, benchHist, '2026-11-04') === 'on_track', 'overshooting a range ceiling is not behind')
const sprintGoal = { name: '10 m sprint', metric: 'time', direction: 'lower' as const, target: 1.75, baseline: 1.9, current: 1.82, due_date: '2026-12-15' }
const sprintHist = [{ date: '2026-10-10', value: 1.9, source: 'manual' }, { date: '2026-10-24', value: 1.85, source: 'manual' }, { date: '2026-11-01', value: 1.82, source: 'manual' }]
ok(computeGoalStatus(sprintGoal, sprintHist, '2026-11-04') === 'on_track', 'a lower goal trending down is on track')
const noDue = { name: 'Pull-ups', metric: 'reps', direction: 'higher' as const, target: 15, baseline: 8, current: 10 }
ok(computeGoalStatus(noDue, [{ date: '2026-10-01', value: 10, source: 'manual' }, { date: '2026-10-15', value: 10, source: 'manual' }, { date: '2026-11-01', value: 10, source: 'manual' }], '2026-11-04') === 'behind', 'no due date and three flat points is behind')

ok(cadenceDays('weekly') === 7 && cadenceDays('Biweekly') === 14 && cadenceDays('every 2 weeks') === 14, 'cadence words read as days')
ok(cadenceDays('every 10 days') === 10 && cadenceDays('monthly') === 30 && cadenceDays('when it feels right') === null, 'cadence numbers read; prose does not')
ok(goalDisplayStatus('on_track', '2026-10-06', { cadence: 'every 2 weeks', today: '2026-11-04' }) === 'needs_test', 'a lapsed cadence needs a test')
ok(goalDisplayStatus('on_track', '2026-10-28', { cadence: 'every 2 weeks', today: '2026-11-04' }) === 'on_course', 'inside the cadence stays on course')
ok(goalDisplayStatus('on_track', '2026-01-01', { cadence: null, today: '2026-11-04' }) === 'on_course', 'no cadence never goes stale')

ok(goalDisplayStatus('hit', '2026-11-03') === 'zeroed', 'hit with a real measurement is zeroed')
ok(goalDisplayStatus('behind', '2026-11-03') === 'off_course', 'behind is off course')
ok(goalDisplayStatus('on_track', '2026-11-03') === 'on_course', 'on_track is on course')
ok(goalDisplayStatus('on_track', null) === 'needs_test', 'no real measurement needs a test')
ok(goalDisplayStatus('hit', null) === 'needs_test', 'a seeded hit with no real measurement still needs a test')
ok(goalDisplayStatus('behind', null) === 'needs_test', 'a pending baseline near its due date needs a test, not the signal')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('goals: ok')
