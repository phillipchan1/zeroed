// Run: node --experimental-strip-types src/engine/progression.check.ts
import { proposeForExercise, proposeNextWeek, type PerformedExercise, type ProgressionRule } from './progression.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const ohpRule: ProgressionRule = {
  engine_type: 'rpe_autoreg',
  exercise_name: 'Strict OHP',
  params: { target_rpe: 7, increment: 5, load: 115 },
}
const ohpHit: PerformedExercise = {
  name: 'Strict OHP',
  prescribed: { sets: 4, reps: '4', load: '115', target_rpe: 7 },
  sets: [7, 7, 7, 6.5].map((rpe) => ({ reps: 4, load: 115, rpe })),
}
const ohpHold: PerformedExercise = {
  name: 'Strict OHP',
  prescribed: { sets: 4, reps: '4', load: '115', target_rpe: 7 },
  sets: [7, 7, 7.5, 7].map((rpe) => ({ reps: 4, load: 115, rpe })),
}
const plus = proposeForExercise(ohpRule, ohpHit)
ok(plus.apply && plus.to.includes('120'), `OHP all ≤ 7 proposes 120, got ${plus.to}`)
ok(plus.reason.includes('120'), 'OHP reason names 120')
const hold = proposeForExercise(ohpRule, ohpHold)
ok(!hold.apply && hold.to.includes('115'), `OHP one set at 7.5 proposes hold, got ${hold.to}`)

const dbRule: ProgressionRule = {
  engine_type: 'double_progression',
  exercise_name: 'DB Bench',
  params: { rep_low: 6, rep_high: 8, increment: 5, load: 100, sets: 4 },
}
const dbHit: PerformedExercise = {
  name: 'DB Bench',
  prescribed: { sets: 4, reps: '6-8', load: '100' },
  sets: [8, 8, 8, 8].map((reps) => ({ reps, load: 100, rpe: 8 })),
}
const dbMiss: PerformedExercise = {
  name: 'DB Bench',
  prescribed: { sets: 4, reps: '6-8', load: '100' },
  sets: [8, 8, 7, 7].map((reps) => ({ reps, load: 100, rpe: 8 })),
}
ok(proposeForExercise(dbRule, dbHit).to.includes('105'), 'DB bench 4×8 @100 → 105')
ok(!proposeForExercise(dbRule, dbMiss).apply, 'DB bench 8/8/7/7 holds 100')

const bikeRule: ProgressionRule = {
  engine_type: 'time_interval',
  exercise_name: 'Assault Bike',
  params: { rounds: 8, next_rounds: 10, work: '10s', rest: '50s' },
}
const bike: PerformedExercise = {
  name: 'Assault Bike',
  prescribed: { sets: 1, reps: '8 × 10s on / 50s off', load: 'bodyweight' },
  sets: [{ reps: 8, load: null, rpe: 8 }],
}
const interval = proposeForExercise(bikeRule, bike)
ok(interval.to.startsWith('10 ×'), `alactic 8 → 10 rounds, got ${interval.to}`)
ok(interval.reason.includes('lifts untouched'), 'interval proposal does not touch lifts')

const squatRule: ProgressionRule = {
  engine_type: 'maintenance',
  exercise_name: 'Back Squat',
  params: { load: 295, held_rpe: 8 },
}
const squat: PerformedExercise = {
  name: 'Back Squat',
  prescribed: { sets: 3, reps: '3', load: '295', target_rpe: 7 },
  sets: [{ reps: 3, load: 295, rpe: 7 }, { reps: 3, load: 295, rpe: 7 }, { reps: 3, load: 295, rpe: 7 }],
}
ok(!proposeForExercise(squatRule, squat).apply, 'maintenance squat does not bump load')

const manualDl: ProgressionRule = { engine_type: 'manual', exercise_name: 'Deadlift', params: {} }
const manualSq: ProgressionRule = { engine_type: 'manual', exercise_name: 'Squat', params: {} }
const dlDone: PerformedExercise = {
  name: 'Deadlift',
  prescribed: { sets: 3, reps: '3', load: '350', target_rpe: 7 },
  sets: [{ reps: 3, load: 350, rpe: 7 }],
}
const sqDone: PerformedExercise = {
  name: 'Squat',
  prescribed: { sets: 3, reps: '3', load: '295', target_rpe: 7 },
  sets: [{ reps: 3, load: 295, rpe: 7 }],
}
const manualDlProp = proposeForExercise(manualDl, dlDone)
ok(!manualDlProp.apply && manualDlProp.to === '350', 'manual deadlift keeps written 350')
ok(manualDlProp.reason.includes('Manual'), 'manual reason says coach sets the value')
const manualSqProp = proposeForExercise(manualSq, sqDone)
ok(!manualSqProp.apply && manualSqProp.to === '295', 'manual squat keeps written 295')
const manualWeek = proposeNextWeek([manualDl, manualSq], [dlDone, sqDone])
ok(manualWeek.every((p) => !p.apply), 'manual weekly prescription never writes a TM bump')
ok(manualWeek.map((p) => p.to).join(',') === '350,295', 'manual weekly prescription stays on written loads')

const mixed = proposeNextWeek(
  [ohpRule, dbRule, bikeRule, squatRule],
  [ohpHit, dbHit, bike, squat],
)
ok(mixed.length === 4, 'one proposal per performed exercise')
ok(mixed.filter((p) => p.exercise === 'Back Squat' || p.exercise === 'Strict OHP').length === 2, 'lifts still listed next to the bike')
ok(Boolean(mixed.find((p) => p.exercise === 'Assault Bike')?.to.startsWith('10')), 'bike rounds move without a lift change')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('progression: ok')
