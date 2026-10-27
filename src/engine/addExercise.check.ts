// Standalone integrity check for adding a movement mid-session (no test runner
// installed, same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/addExercise.check.ts
//
// The properties that matter:
//
//   · picking a movement is one tap: it arrives with a sane dose for what it is
//   · the athlete's own last sets beat the table
//   · the addition is flagged as one, so the snapshot remembers it wasn't planned
//   · suggestions fill what today is missing rather than doubling what's there

import { buildAddition, suggestAdditions, browseLibrary, INTERVAL_MOVEMENTS } from './addExercise.ts'
import { findLibraryExercise, effectiveTrackingType } from './exerciseLibrary.ts'
import type { SetLog } from '../types/database.ts'

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

const set = (p: Partial<SetLog>): SetLog => ({
  set: 1, weight: null, reps: null, rpe: null, done: true, duration: null, distance: null, ...p,
})

// ---- 1. a dose for what it is ------------------------------------------------

const rdl = buildAddition('Romanian Deadlift')
ok(rdl.sets === 3 && rdl.reps === '8', 'a compound hinge is 3×8')
eq(rdl.added, true, 'flagged as an addition')
eq(rdl.tracking_type, 'weight_reps', 'logged as weight × reps')
const curl = buildAddition('Hammer Curl')
ok(curl.sets === 3 && curl.reps === '12' && curl.load === 'light', 'an isolation is 3×12, light')
const row = buildAddition('Chest-Supported Row')
eq(row.reps, '10', 'a row is 3×10')
const plank = buildAddition('Plank')
ok(plank.reps === '30s' && plank.tracking_type === 'time', 'a hold is timed, 3×30s')
const carry = buildAddition('Farmer Carry')
eq(carry.reps, '40s', 'a carry is 40s')
const bike = buildAddition('Assault Bike')
ok(bike.sets === 1 && bike.reps === '10 min', 'steady cardio is ten minutes')
const pushup = buildAddition('Push-Up')
ok(pushup.load === 'bodyweight' && pushup.tracking_type === 'bodyweight_reps', 'a push-up is bodyweight reps')
const stretch = buildAddition('Pigeon Stretch')
ok(stretch.sets === 2 && stretch.reps === '45s', 'mobility is 2×45s')
eq(buildAddition('farmers walk').name, 'Farmer Carry', 'an alias is filed under its canonical name')
const custom = buildAddition('  Zercher Good Morning Thing  ')
ok(custom.name === 'Zercher Good Morning Thing' && custom.sets >= 1, 'an uncurated name is kept as typed')

// ---- 2. last time beats the table --------------------------------------------

const lastRdl = [set({ weight: 185, reps: 6 }), set({ weight: 205, reps: 6 }), set({ weight: 205, reps: 6 }), set({ weight: 205, reps: 5 })]
const again = buildAddition('Romanian Deadlift', lastRdl)
ok(again.sets === 4 && again.reps === '6', 'four sets of six last time → four sets of six')
const lastPlank = [set({ duration: 45 }), set({ duration: 45 })]
const plankAgain = buildAddition('Plank', lastPlank)
ok(plankAgain.sets === 2 && plankAgain.reps === '45s', 'a hold repeats its last duration')
const notLogged = buildAddition('Romanian Deadlift', [set({ done: false })])
eq(notLogged.reps, '8', 'an empty log is no history')
const tooMany = buildAddition('Hammer Curl', Array.from({ length: 9 }, () => set({ reps: 12, weight: 30 })))
eq(tooMany.sets, 6, 'history is capped at six sets')

// The dose reads back as the metric it was built for.
for (const ex of [rdl, curl, plank, carry, bike, pushup]) {
  eq(effectiveTrackingType(ex), ex.tracking_type, `${ex.name} reads back as ${ex.tracking_type}`)
}

// ---- 3. suggestions fill the gaps -----------------------------------------

const upper = suggestAdditions(['Bench Press', 'Overhead Press'])
ok(upper.length > 0, 'an upper day gets suggestions')
ok(upper.some((e) => e.pattern === 'horizontal_pull' || e.pattern === 'vertical_pull'), 'a press day is offered a pull')
ok(!upper.some((e) => e.pattern === 'horizontal_push'), 'and not another press')
const withRow = suggestAdditions(['Chest-Supported Row'])
ok(!withRow.some((e) => e.name === 'Chest-Supported Row'), 'never what is already in the session')
const recent = suggestAdditions(['Back Squat'], ['Nordic Curl', 'Back Squat'])
eq(recent[0]?.name, 'Nordic Curl', 'what they added before comes first')
ok(!recent.some((e) => e.name === 'Back Squat'), 'a recent pick already in the session is skipped')
ok(suggestAdditions([], [], 5).length <= 5, 'the limit holds')

// ---- 4. the browse lists and interval movements are real ----------------------

ok(browseLibrary('Conditioning').length > 10, 'conditioning browses')
ok(browseLibrary('Upper Chain').every((e) => e.category === 'Upper Chain'), 'a category holds only itself')
for (const n of INTERVAL_MOVEMENTS) ok(findLibraryExercise(n)?.name === n, `interval movement "${n}" is in the library`)

if (fails.length) {
  console.error(`addExercise.check: ${fails.length} of ${checks} failed`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`addExercise.check: ${checks} checks passed`)
