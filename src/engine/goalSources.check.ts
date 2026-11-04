// Run: node --experimental-strip-types src/engine/goalSources.check.ts
import {
  deriveGoalMeasurements, formatGoalSource, goalSource, goalsTrainedBy, inferGoalSource, parseGoalSource, sessionValue,
  workoutMeasurementKey, type GoalForSource,
} from './goalSources.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const lb = { weight: 'lb' as const, distance: 'in' as const }

ok(parseGoalSource('e1rm:Bench Press')?.exercise === 'Bench Press', 'parse e1rm binding')
ok(parseGoalSource(' TOP_SET : Strict Press ')?.kind === 'top_set', 'parse is case and space tolerant')
ok(parseGoalSource('test')?.kind === 'test' && parseGoalSource('test')?.exercise === null, 'test needs no exercise')
ok(parseGoalSource('e1rm') === null, 'a measured kind without an exercise is unreadable')
ok(parseGoalSource('speed:Bench') === null, 'unknown kinds are unreadable')
ok(parseGoalSource(null) === null, 'null is no binding')
ok(formatGoalSource({ kind: 'distance', exercise: 'Broad Jump' }) === 'distance:Broad Jump', 'format round-trips')

const names = ['Back Squat', 'Bench Press', 'Broad Jump', 'Strict Press', 'Alactic Bike']
ok(inferGoalSource({ name: 'Broad jump', metric: 'distance', unit: 'in' }, names)?.exercise === 'Broad Jump', 'infer broad jump from name + inches')
ok(inferGoalSource({ name: 'Bench Press 1RM', metric: 'e1rm', unit: 'lb' }, names)?.kind === 'e1rm', 'infer e1rm from metric')
ok(inferGoalSource({ name: 'Bench Press 1RM', metric: 'e1rm', unit: 'lb' }, names)?.exercise === 'Bench Press', 'the 1RM suffix drops off the stem')
ok(inferGoalSource({ name: 'Bench 1RM', metric: 'e1rm', unit: 'lb' }, names) === null, 'a different spelling needs an explicit binding')
ok(inferGoalSource({ name: 'Deadlift', metric: 'top_set', unit: 'lb' }, ['Trap Bar Deadlift']) === null, 'a variant never feeds the base lift by inference')
ok(inferGoalSource({ name: 'Hip IR L', metric: 'hip_ir', unit: '°', side: 'L' }, ['Hip IR']) === null, 'sided goals are manual tests')
ok(inferGoalSource({ name: 'Vertical', metric: 'height', unit: 'furlongs' }, names) === null, 'unknown unit infers nothing')
ok(goalSource({ name: 'Bench 1RM', metric: 'e1rm', unit: 'lb', source_metric: 'top_set:Paused Bench' }, names)?.exercise === 'Paused Bench', 'a stored binding wins over inference')

const sets = [
  { weight: 225, reps: 5, done: true },
  { weight: 245, reps: 3, done: true },
  { weight: 265, reps: 2, done: false },
]
ok(sessionValue('top_set', sets, 'higher') === 245, 'top set ignores sets not completed')
ok(sessionValue('e1rm', sets, 'higher') === Math.max(Math.round(225 * (1 + 5 / 30)), Math.round(245 * (1 + 3 / 30))), 'e1rm is the best Epley estimate')
ok(sessionValue('rounds', [{ done: true }, { done: true }, { done: false }], 'higher') === 2, 'rounds count completed rows')
ok(sessionValue('time', [{ duration: 1.9, done: true }, { duration: 1.82, done: true }], 'lower') === 1.82, 'a lower time goal takes the fastest')

const goals: GoalForSource[] = [
  { id: 'g-ohp', name: 'Strict press', metric: 'top_set', unit: 'lb', direction: 'higher', target: 130, current: 120, source_metric: 'top_set:Strict Press' },
  { id: 'g-broad', name: 'Broad jump', metric: 'distance', unit: 'in', direction: 'higher', target: 100, current: 97 },
  { id: 'g-bench', name: 'Bench 1RM', metric: 'e1rm', unit: 'kg', direction: 'higher', target: 140, current: 120, source_metric: 'e1rm:Bench Press' },
  { id: 'g-hip', name: 'Hip IR L', metric: 'hip_ir', unit: '°', side: 'L', direction: 'higher', target: 35, current: 30 },
]
const session = [
  { name: 'Strict Press', sets: [{ weight: 120, reps: 4, done: true }, { weight: 120, reps: 4, done: true }] },
  { name: 'Broad Jump', sets: [{ distance: 99, done: true }, { distance: 101, done: true }] },
  { name: 'Bench Press', sets: [{ weight: 275, reps: 3, done: true }] },
]
const out = deriveGoalMeasurements(session, goals, lb)
const ohp = out.find((m) => m.goal_id === 'g-ohp')
ok(ohp?.value === 120 && ohp.previous === 120 && !ohp.hit, 'a flat press still writes 120, so the plateau reaches the forecast')
const broad = out.find((m) => m.goal_id === 'g-broad')
ok(broad?.value === 101 && broad.hit, 'broad jump 101 writes and hits 100')
const bench = out.find((m) => m.goal_id === 'g-bench')
ok(bench != null && Math.abs(bench.value - Math.round(275 * 1.1) / 2.2046226218) < 0.01, `stored lb converts to a kg goal, got ${bench?.value}`)
ok(!out.some((m) => m.goal_id === 'g-hip'), 'sided goals are never written by a session')

const deload = deriveGoalMeasurements(
  [{ name: 'Strict Press', sets: [{ weight: 95, reps: 5, done: true }] }], goals, lb,
)
ok(!deload.some((m) => m.goal_id === 'g-ohp'), 'a deload under the current mark writes nothing')
const sprint = deriveGoalMeasurements(
  [{ name: '10 m Sprint', sets: [{ duration: 1.84, done: true }] }],
  [{ id: 'g-10', name: '10 m sprint', metric: 'time', unit: 's', direction: 'lower', target: 1.75, current: 1.82 }],
  lb,
)
ok(sprint.length === 0, 'a slower sprint than current writes nothing for a lower goal')
const cm = deriveGoalMeasurements(
  [{ name: 'Broad Jump', sets: [{ distance: 100, done: true }] }],
  [{ id: 'g-cm', name: 'Broad jump', metric: 'distance', unit: 'cm', direction: 'higher', target: 250, current: 240 }],
  lb,
)
ok(cm[0]?.value === 254, 'inches convert to a cm goal')
ok(workoutMeasurementKey('w1', 'g1') === 'wl:w1:g1', 'client key is per workout and goal')
const plank = deriveGoalMeasurements(
  [{ name: 'Plank', sets: [{ duration: 90, done: true }] }],
  [{ id: 'g-pl', name: 'Plank', metric: 'time', unit: 'min', direction: 'higher', target: 2, current: 1, source_metric: 'time:Plank' }],
  lb,
)
ok(plank[0]?.value === 1.5, `seconds convert to a minutes goal, got ${plank[0]?.value}`)
const bw = deriveGoalMeasurements(
  [{ name: 'Back Squat', sets: [{ weight: 315, reps: 1, done: true }] }],
  [{ id: 'g-bw', name: 'Squat', metric: 'ratio', unit: 'xBW', direction: 'higher', target: 2, current: 1.5, source_metric: 'top_set:Back Squat' }],
  lb,
)
ok(bw.length === 0, 'a unit the session cannot be stated in writes nothing')
const typo = deriveGoalMeasurements(
  [{ name: 'Strict Press', sets: [{ weight: 110, reps: 4, done: true }] }], goals, lb, { requireHold: false },
)
ok(typo.find((m) => m.goal_id === 'g-ohp')?.value === 110, 'an edit re-derives even below the current mark')
const trained = goalsTrainedBy(goals, ['Strict Press', 'Broad Jump', 'DB Row'])
ok(trained.map((t) => t.goal.id).join() === 'g-ohp,g-broad', `a session trains the goals its exercises feed, got ${trained.map((t) => t.goal.id).join()}`)
ok(trained[0].exercise === 'Strict Press', 'the matched exercise rides along')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('goal sources: ok')
