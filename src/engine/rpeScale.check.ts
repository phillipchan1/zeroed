// Run: node --experimental-strip-types src/engine/rpeScale.check.ts
import { isLoggedRpe, loggedRpeError, pickerRpeScale, roundLoggedRpe, roundSessionRpe, workoutRpeError, RPE_SCALE, RPE_SCALE_INTEGERS } from './rpeScale.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(RPE_SCALE[0] === 1 && RPE_SCALE[RPE_SCALE.length - 1] === 10, 'scale runs 1–10')
ok(RPE_SCALE.includes(7.5) && RPE_SCALE.includes(9.5), 'scale includes 7.5 and 9.5')
ok(!RPE_SCALE.includes(10.5) && !RPE_SCALE.includes(0.5), 'scale excludes 10.5 and 0.5')
ok(RPE_SCALE.length === 19, '19 half-steps from 1 to 10')

ok(isLoggedRpe(null) && isLoggedRpe(undefined), 'empty RPE is allowed')
ok(isLoggedRpe(1) && isLoggedRpe(10) && isLoggedRpe(5), 'integers on the scale pass')
ok(isLoggedRpe(7.5) && isLoggedRpe(9.5), 'RPE 7.5 and 9.5 are accepted')
ok(isLoggedRpe('7.5') && isLoggedRpe('5'), 'numeric strings on the scale pass')
ok(!isLoggedRpe(10.5) && !isLoggedRpe(0.5), 'RPE 10.5 and 0.5 are rejected')
ok(!isLoggedRpe(0) && !isLoggedRpe(11) && !isLoggedRpe(7.25), '0, 11, and quarter-steps are rejected')
ok(!isLoggedRpe('nope') && !isLoggedRpe({}), 'non-numeric values are rejected')

ok(loggedRpeError(7.5) == null, '7.5 has no error')
ok(Boolean(loggedRpeError(10.5)?.includes('10.5')), '10.5 error names the value')
ok(Boolean(loggedRpeError(0.5)?.startsWith('unsupported rpe')), '0.5 error is the unsupported-rpe shape')

ok(roundLoggedRpe(7.4) === 7.5 && roundLoggedRpe(7.2) === 7, 'averages round to the nearest half-step')
ok(roundLoggedRpe(0) === 1 && roundLoggedRpe(12) === 10, 'rounding clamps to 1–10')

ok(RPE_SCALE_INTEGERS.length === 10 && RPE_SCALE_INTEGERS[0] === 1 && RPE_SCALE_INTEGERS[9] === 10, 'integer scale is 1–10')
ok(RPE_SCALE_INTEGERS.every((n) => Number.isInteger(n)), 'integer scale has no halves')
ok(pickerRpeScale(true) === RPE_SCALE, 'picker uses full scale when half-steps are on')
ok(pickerRpeScale(false) === RPE_SCALE_INTEGERS, 'picker hides halves when off')
ok(roundSessionRpe(7.5, true) === 7.5, 'session avg keeps 7.5 when half-steps are on')
ok(roundSessionRpe(7.5, false) === 8, 'session avg of 7.5 becomes 8 when halves are off')
ok(roundSessionRpe(7.2, false) === 7, 'session avg of 7.2 becomes 7 when halves are off')

ok(workoutRpeError({ rpe: 5 }) == null, 'session RPE 5 is accepted')
ok(workoutRpeError({ rpe: 7.5 }) == null, 'session RPE 7.5 is accepted')
ok(workoutRpeError({ rpe: 10.5 }) != null, 'session RPE 10.5 is rejected')
ok(workoutRpeError({ rpe: 0.5 }) != null, 'session RPE 0.5 is rejected')
ok(workoutRpeError({
  actual_weights: { '0': [{ set: 1, weight: 135, reps: 5, rpe: 5, done: true }] },
}) == null, 'set RPE 5 is accepted')
ok(workoutRpeError({
  actual_weights: { '0': [{ set: 1, weight: 225, reps: 3, rpe: 9.5, done: true }] },
}) == null, 'set RPE 9.5 is accepted')
ok(workoutRpeError({
  actual_weights: { '0': [{ set: 1, weight: 225, reps: 3, rpe: 10.5, done: true }] },
}) != null, 'set RPE 10.5 is rejected')
ok(workoutRpeError({
  actual_weights: { '0': [{ set: 1, weight: 225, reps: 3, rpe: 0.5, done: true }] },
}) != null, 'set RPE 0.5 is rejected')

if (fails.length) {
  console.error(`rpeScale.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`rpeScale.check: ${checks} checks passed`)
