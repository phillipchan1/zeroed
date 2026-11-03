// Run: node --experimental-strip-types src/engine/goals.check.ts
import {
  applyMeasurement, computeGoalStatus, lastMeasuredOn, pairKey, progressRatio, projectedAtDue,
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

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('goals: ok')
