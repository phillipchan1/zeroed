// Run: node --experimental-strip-types src/engine/autoreg.check.ts
import { droppedExerciseNames, evaluateAutoregRules, PHIL_AUTOREG_SEED } from './autoreg.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const tuesday = [
  { name: 'Deadlift' },
  { name: 'Back Squat' },
  { name: 'Assault Bike' },
]
const friday = [
  { name: 'Broad Jump' },
  { name: 'Lateral Bound' },
  { name: 'Sprint' },
  { name: 'Strict OHP' },
]

const six = evaluateAutoregRules(PHIL_AUTOREG_SEED, { pain_knee_L: 6, pain_knee_R: 4 }, tuesday)
const droppedSix = droppedExerciseNames(six)
ok(droppedSix.has('Back Squat'), 'knee 6/10 drops squat')
ok(!droppedSix.has('Deadlift'), 'knee 6/10 leaves deadlift')
ok(six.some((f) => /no squats/i.test(f.message)), 'knee 6/10 shows the reason')

const four = evaluateAutoregRules(PHIL_AUTOREG_SEED, { pain_knee_L: 4, pain_knee_R: 4 }, tuesday)
ok(four.some((f) => f.action === 'cap_depth' && /265/.test(f.message)), 'knee 4/10 shows 265 or cut depth')
ok(!droppedExerciseNames(four).has('Back Squat'), 'knee 4/10 does not drop the squat')

const plyo = evaluateAutoregRules(PHIL_AUTOREG_SEED, { pain_knee_L: 4 }, friday)
ok(droppedExerciseNames(plyo).has('Broad Jump'), 'knee 4/10 drops broad jump')
ok(droppedExerciseNames(plyo).has('Lateral Bound'), 'knee 4/10 drops bounds')
ok(!droppedExerciseNames(plyo).has('Strict OHP'), 'knee 4/10 leaves OHP')

const sleep = evaluateAutoregRules(PHIL_AUTOREG_SEED, { sleep_hours: 5 }, tuesday)
ok(sleep.some((f) => f.action === 'reduce_load_lb' && /−10|−10|-10/.test(f.message)), 'short sleep −10 lb')

const shaky = evaluateAutoregRules(PHIL_AUTOREG_SEED, { warmup_quality: 'shaky' }, friday)
ok(shaky.some((f) => f.exercise_name === 'Strict OHP' && f.action === 'reduce_load_pct'), 'shaky OHP warm-up → 85%')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('autoreg: ok')
