// Standalone integrity check for rest prescription (no test runner installed,
// same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/restTimer.check.ts
//
// The properties that matter:
//
//   · a heavy main lift in a Strength block gets real rest, not the flat 90s
//     the app used to give everything
//   · a band pull-apart does not get three minutes
//   · a plank is its own rest
//   · the athlete can always move it, and can never move it somewhere absurd

import {
  restSecondsFor, clampRest, adjustRest, formatRest,
  DEFAULT_REST_SECONDS, REST_STEP_SECONDS, MIN_REST_SECONDS, MAX_REST_SECONDS,
} from './restTimer.ts'

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

const ex = (name: string, load?: string) => ({ name, load })

// ---- 1. the block decides ---------------------------------------------------

eq(restSecondsFor(ex('Back Squat'), 'Strength'), 180,
  'a main lift in a Strength block gets the full three minutes')
eq(restSecondsFor(ex('Bench Press'), 'Power'), 180, 'Power expresses fresh — same')
eq(restSecondsFor(ex('Back Squat'), 'Stability'), 120,
  'the same lift in Stability is not maximal, so it rests less')
eq(restSecondsFor(ex('Back Squat'), 'Sport'), 120, 'Sport is mixed qualities')

// The complaint this exists to answer: 90s for everything was wrong in BOTH
// directions at once.
ok(restSecondsFor(ex('Back Squat'), 'Strength') > DEFAULT_REST_SECONDS,
  'a heavy triple used to be cut short by the flat default')
ok(restSecondsFor(ex('Band Pull-Apart'), 'Strength') < DEFAULT_REST_SECONDS ||
   restSecondsFor(ex('Band Pull-Apart'), 'Stability') < DEFAULT_REST_SECONDS,
  'and an accessory used to make you stand around')

// ---- 2. main lift vs accessory ---------------------------------------------

eq(restSecondsFor(ex('Deadlift'), 'Strength'), 180, 'a deadlift is a main lift')
eq(restSecondsFor(ex('Overhead Press'), 'Strength'), 180, 'so is an overhead press')
eq(restSecondsFor(ex('Barbell Row'), 'Strength'), 180, 'and a row')
eq(restSecondsFor(ex('Band Pull-Apart'), 'Strength'), 90, 'a band pull-apart is not')
eq(restSecondsFor(ex('Face Pull'), 'Stability'), 60, 'nor is a face pull in Stability')
eq(restSecondsFor(ex('Lateral Raise'), 'Sport'), 60, 'nor a lateral raise')

// The program's own "heavy" stamp counts even when the name says nothing — the
// two ways a session declares which movement is the work.
eq(restSecondsFor(ex('Goblet Squat', 'heavy'), 'Strength'), 180,
  'anything the program marked heavy rests like a main lift')
// An explicit light stamp beats the name. A light goblet squat is warm-up or
// accessory work; it must not buy three minutes because "squat" is in it.
eq(restSecondsFor(ex('Goblet Squat', 'light'), 'Strength'), 90,
  'an explicit light stamp demotes a main-lift NAME to accessory rest')
eq(restSecondsFor(ex('Back Squat', 'bodyweight'), 'Strength'), 90,
  'so does bodyweight')
eq(restSecondsFor(ex('Back Squat', 'moderate'), 'Strength'), 180,
  'moderate leaves the name to decide, and the name says main lift')

// ---- 3. the metric matters as much as the name -----------------------------

eq(restSecondsFor(ex('Plank'), 'Strength', 'time'), 45, 'a held effort is its own rest')
eq(restSecondsFor(ex('Farmer Carry'), 'Strength', 'distance'), 45, 'so is a carry')
// A timed hold beats the main-lift rule — "Press" in the name must not buy a
// three-minute rest for a 30-second isometric.
eq(restSecondsFor(ex('Pallof Press'), 'Strength', 'time'), 45,
  'the tracking type wins over a main-lift name match')

// ---- 4. unknowns fall back, never crash ------------------------------------

eq(restSecondsFor(ex('Back Squat'), null), DEFAULT_REST_SECONDS, 'no block, the old default')
eq(restSecondsFor(ex('Back Squat'), 'Nonsense'), DEFAULT_REST_SECONDS, 'an unknown block too')
eq(restSecondsFor(null, 'Strength'), DEFAULT_REST_SECONDS, 'no exercise, the old default')
eq(restSecondsFor(undefined, undefined), DEFAULT_REST_SECONDS, 'nothing at all still answers')

// ---- 5. the athlete can always move it -------------------------------------

eq(adjustRest(90, 1), 120, 'one tap up is +30s')
eq(adjustRest(90, -1), 60, 'one tap down is -30s')
eq(adjustRest(180, 2), 240, 'two taps compound')
eq(REST_STEP_SECONDS, 30, 'the step is 30s')

eq(adjustRest(MIN_REST_SECONDS, -5), MIN_REST_SECONDS, 'it cannot be driven below the floor')
eq(adjustRest(MAX_REST_SECONDS, 5), MAX_REST_SECONDS, 'or above the ceiling')
eq(clampRest(-40), MIN_REST_SECONDS, 'a negative rest is not a rest')
eq(clampRest(9999), MAX_REST_SECONDS, 'past ten minutes it is a new session')
eq(clampRest(Number.NaN), DEFAULT_REST_SECONDS, 'NaN falls back rather than propagating')
eq(clampRest(97.4), 97, 'a fractional second rounds')

// ---- 6. the clock ----------------------------------------------------------

eq(formatRest(180), '3:00', 'three minutes')
eq(formatRest(90), '1:30', 'ninety seconds')
eq(formatRest(45), '0:45', 'under a minute keeps the leading zero')
eq(formatRest(0), '0:00', 'zero')
eq(formatRest(-5), '0:00', 'never negative on screen')

// ---- report -----------------------------------------------------------------

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} rest-timer checks failed:`)
  fails.forEach((f) => console.error(`  · ${f}`))
  process.exit(1)
}
console.log(`✓ all ${checks} rest-timer checks passed`)
