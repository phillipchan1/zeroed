// Run: node --experimental-strip-types src/engine/goals.check.ts
import {
  applyMeasurement, computeGoalStatus, pairKey, progressRatio, projectedAtDue,
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
