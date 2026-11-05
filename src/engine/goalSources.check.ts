// Run: node --experimental-strip-types src/engine/goalSources.check.ts
import {
  deriveGoalMeasurements, formatGoalSource, goalSource, goalsTrainedBy, inferGoalSource, parseGoalSource, sessionValue,
  workoutMeasurementKey, type GoalForSource,
} from './goalSources.ts'
import { e1rmFromSet } from './liftModel.ts'

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
ok(Math.abs(sessionValue('e1rm', sets, 'higher')! - Math.max(e1rmFromSet(225, 5, null)!, e1rmFromSet(245, 3, null)!)) < 1e-9, 'e1rm is the best RPE-chart estimate (no RPE reads as 10)')
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
ok(bench != null && Math.abs(bench.value - e1rmFromSet(275, 3, null)! / 2.2046226218) < 0.01, `stored lb converts to a kg goal, got ${bench?.value}`)
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

// ── Passive progress: rolling kinds, tiers, readiness, inferred ────────────
const rollGoal: GoalForSource = { id: 'g-b', name: 'Bench', metric: 'e1rm', unit: 'lb', direction: 'higher', target: 315, current: 300, source_metric: 'e1rm:Bench Press' }
const working = deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 245, reps: 5, rpe: 8, done: true }] }], [rollGoal], lb)
ok(working.length === 1, 'a rolling e1rm writes even under the current mark')
ok(working[0]?.tier === 'estimate' && /245×5 @8 · estimate$/.test(working[0]?.note ?? ''), `an RPE 8 five is an estimate, noted with its set, got ${working[0]?.note}`)
const easy = deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 225, reps: 5, rpe: 6, done: true }] }], [rollGoal], lb)
ok(easy.length === 0, 'an RPE 6 set says nothing about a max and writes nothing')
const tired = deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 235, reps: 5, rpe: 8, done: true }] }], [rollGoal], lb, { readiness: 3 })
ok(deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 235, reps: 5, rpe: 8, done: true }] }], [rollGoal], lb, { readiness: 7 }).length === 1, 'the same dip on a normal day still writes')
ok(tired.length === 0, 'a low-readiness dip under current does not move a rolling goal')
const single = deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 320, reps: 1, rpe: 9, done: true }] }], [rollGoal], lb)
ok(single[0]?.tier === 'tested' && single[0]?.hit === true, 'a single at RPE 9 past the target is tested and a hit')
const estHit = deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 290, reps: 3, rpe: 8, done: true }] }], [rollGoal], lb)
ok(estHit[0]?.confirm === true && estHit[0]?.hit === false, `an estimate past the target asks to confirm, not hit (value ${estHit[0]?.value})`)
const strong = deriveGoalMeasurements([{ name: 'Bench Press', sets: [
  { weight: 295, reps: 2, rpe: 8, done: true }, { weight: 295, reps: 2, rpe: 8, done: true },
] }], [rollGoal], lb)
ok(strong[0]?.tier === 'strong' && strong[0]?.hit === true, 'two agreeing heavy doubles @8 are strong evidence and can hit')
const missed = deriveGoalMeasurements([{ name: 'Bench Press', sets: [{ weight: 300, reps: 2, rpe: 10, missed_reps: 1, done: true }] }], [rollGoal], lb)
ok(missed.length === 0, 'a set with a missed rep is not a reading')
const inferred = deriveGoalMeasurements([{ name: 'DB Bench Press', sets: [{ weight: 110, reps: 5, rpe: 8, done: true }] }], [rollGoal], lb)
ok(inferred[0]?.tier === 'inferred' && Math.abs(inferred[0].value - e1rmFromSet(110, 5, 8)! / 0.4) < 0.01, `a DB press infers the bench through the 0.40 prior, got ${inferred[0]?.value}`)
ok(/inferred from DB Bench Press$/.test(inferred[0]?.note ?? ''), `an inferred note names the lift it came from, got ${inferred[0]?.note}`)
const learned = deriveGoalMeasurements([{ name: 'DB Bench Press', sets: [{ weight: 110, reps: 5, rpe: 8, done: true }] }], [rollGoal], lb, { ratios: { 'db bench press→bench press': 0.36 } })
ok(Math.abs(learned[0].value - e1rmFromSet(110, 5, 8)! / 0.36) < 0.01, 'a learned ratio replaces the prior')
const direct = deriveGoalMeasurements([
  { name: 'DB Bench Press', sets: [{ weight: 110, reps: 5, rpe: 8, done: true }] },
  { name: 'Bench Press', sets: [{ weight: 245, reps: 5, rpe: 8, done: true }] },
], [rollGoal], lb)
ok(direct[0]?.tier === 'estimate' && direct[0]?.exercise === 'Bench Press', 'direct evidence wins over inferred')

const pull: GoalForSource = { id: 'g-p', name: 'Pull-ups', metric: 'reps', unit: 'reps', direction: 'higher', target: 15, current: 10, source_metric: 'reps_to_failure:Pull-Up' }
const pr = deriveGoalMeasurements([{ name: 'Pull-Up', sets: [{ reps: 8, rpe: 8, done: true }, { reps: 7, rpe: 9, done: true }] }], [pull], lb)
ok(pr[0]?.value === 10 && pr[0]?.tier === 'estimate', `8 pull-ups @8 is about 10 to failure, got ${pr[0]?.value}`)

const rel: GoalForSource = { id: 'g-r', name: 'Weighted pull-up', metric: 'relative', unit: 'xBW', direction: 'higher', target: 1.5, current: 1.3, source_metric: 'relative_e1rm:Pull-Up' }
const relOut = deriveGoalMeasurements([{ name: 'Pull-Up', sets: [{ weight: 45, reps: 3, rpe: 8, done: true }] }], [rel], lb, { bodyweight: 180 })
ok(relOut.length === 1 && Math.abs(relOut[0].value - Math.round((e1rmFromSet(225, 3, 8)! / 180) * 100) / 100) < 0.011, `a weighted pull-up adds bodyweight before the ratio, got ${relOut[0]?.value}`)
ok(deriveGoalMeasurements([{ name: 'Pull-Up', sets: [{ weight: 45, reps: 3, rpe: 8, done: true }] }], [rel], lb).length === 0, 'relative strength needs a bodyweight')

const bike: GoalForSource = { id: 'g-o', name: 'Bike output', metric: 'output', unit: 'cal', direction: 'higher', target: 25, current: 20, source_metric: 'output:Assault Bike' }
const fade: GoalForSource = { id: 'g-f', name: 'Bike fade', metric: 'fade', unit: '%', direction: 'higher', target: 90, current: 80, source_metric: 'fade:Assault Bike' }
const rounds = [22, 21, 20, 18].map((o) => ({ duration: 20, output: o, output_unit: 'cal', rpe: 8, done: true }))
const cond = deriveGoalMeasurements([{ name: 'Assault Bike', sets: rounds }], [bike, fade], lb)
ok(cond.find((m) => m.goal_id === 'g-o')?.value === 20.25, 'output is the mean per round')
ok(Math.abs((cond.find((m) => m.goal_id === 'g-f')?.value ?? 0) - 81.82) < 0.01, 'fade is last over first as a percent')
const wrongUnit = deriveGoalMeasurements([{ name: 'Assault Bike', sets: rounds.map((r) => ({ ...r, output_unit: 'W' })) }], [bike], lb)
ok(wrongUnit.length === 0, 'output in another unit than the goal is not read')

const ft: GoalForSource = { id: 'g-ft', name: 'Free throws', metric: 'rate', unit: '%', direction: 'higher', target: 80, current: 70, source_metric: 'success_rate:Free Throw' }
const shots = deriveGoalMeasurements([{ name: 'Free Throw', sets: [{ attempts: 10, makes: 7, done: true }, { attempts: 10, makes: 8, done: true }] }], [ft], lb)
ok(shots[0]?.value === 75 && shots[0]?.tier === 'tested', 'success rate is makes over attempts')
ok(deriveGoalMeasurements([{ name: 'Free Throw', sets: [{ attempts: 5, makes: 5, done: true }] }], [ft], lb).length === 0, 'five attempts say too little')
ok(parseGoalSource('fade:Assault Bike')?.kind === 'fade' && parseGoalSource('output:Rowing Machine')?.kind === 'output', 'new kinds parse')
ok(inferGoalSource({ name: 'Bike output', metric: 'output', unit: 'cal' }, ['Bike Output'])?.kind === 'output', 'calories infer an output goal')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('goal sources: ok')
