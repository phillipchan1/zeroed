// Standalone integrity check for the exercise library and swaps (no test runner
// installed, same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/exerciseLibrary.check.ts
//
// The properties that matter:
//
//   · no two entries claim the same name — one of them would silently lose
//   · a row is logged in weight × reps, whatever tempo note rides along with it
//     (the T-bar row that came out in seconds)
//   · "Row (Erg)" is the rowing machine and plain "Row" is not
//   · a curated movement's metric beats a stale stamp on the routine
//   · a swap stays inside the pattern, honours the gear on hand, never makes an
//     unscreened session riskier, and keeps what the slot was programmed as

import {
  LIBRARY_EXERCISES, LIBRARY_COLLISIONS, findLibraryExercise, resolveTrackingType,
  effectiveTrackingType, resolvePattern, prescribedUnit, suggestSwaps, buildSwap,
  searchLibrary, equipmentAvailable, TRACKING_LABEL,
} from './exerciseLibrary.ts'
import { TRACKING_TYPES, type ExerciseTemplate } from '../types/database.ts'

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

// ---- 1. table integrity ----------------------------------------------------

eq(LIBRARY_COLLISIONS.length, 0, `name collisions: ${LIBRARY_COLLISIONS.join('; ')}`)
const names = new Set<string>()
for (const ex of LIBRARY_EXERCISES) {
  ok(!names.has(ex.name), `duplicate canonical name ${ex.name}`)
  names.add(ex.name)
  ok((TRACKING_TYPES as readonly string[]).includes(ex.tracking), `${ex.name}: bad tracking ${ex.tracking}`)
  ok(!ex.alt || ex.alt !== ex.tracking, `${ex.name}: alt metric equals its own`)
  ok(findLibraryExercise(ex.name) === ex, `${ex.name} doesn't find itself`)
  if (ex.noteAs) ok(!!findLibraryExercise(ex.noteAs), `${ex.name}: noteAs "${ex.noteAs}" isn't in the library`)
}
ok(LIBRARY_EXERCISES.length >= 200, `library has ${LIBRARY_EXERCISES.length} entries`)

// ---- 2. the metric ----------------------------------------------------------

const track = (name: string, reps?: string, load?: string) => resolveTrackingType(name, reps, load)

eq(track('T-Bar Row', '8-10'), 'weight_reps', 'T-bar row is weight × reps')
eq(track('T Row Bar', '8'), 'weight_reps', 'the way the athlete typed it')
eq(track('T-Bar Rows', '8 (3s eccentric)'), 'weight_reps', 'a tempo note never makes a row a hold')
eq(track('Meadows Row', '8, 2s squeeze'), 'weight_reps', 'curated: meadows row')
eq(track('Gorilla Row', '8-10 · 3s pause'), 'weight_reps', 'uncurated row with a tempo note')
eq(track('Row (Erg)', '10 min'), 'time', '"Row (Erg)" is the rowing machine')
eq(track('Row (Erg)', '2000m'), 'distance', 'an erg piece in meters logs distance')
ok(track('Row', '8') !== 'time', 'plain "Row" is not the rowing machine')
eq(findLibraryExercise('Row (Erg)')?.name, 'Rowing Machine', 'qualifier is kept for the lookup')
eq(track('Farmer Carry', '40 yd'), 'distance', 'a carry walked for distance')
eq(track('Farmer Carry', '45s'), 'time', 'a carry walked for time')
eq(track("Farmer's Carry", '3'), 'time', 'a bare count never moves a carry off its default')
eq(track('Plank', '3'), 'time', 'a plank is a hold, whatever number rides with it')
eq(track('Push-ups', '12'), 'bodyweight_reps', 'plural, hyphenated push-ups')
eq(track('Weighted Pull-Ups', '5'), 'bodyweight_reps', 'weighted pull-up is a bodyweight lift with added load')
eq(findLibraryExercise('Dumbbell Romanian Deadlift')?.name, 'DB Romanian Deadlift', 'dumbbell → db')
eq(findLibraryExercise('Single-Arm Dumbbell Row')?.name, 'DB Row', 'single-arm db row')
eq(findLibraryExercise('Incline Hammer Curls')?.name, 'Hammer Curl', 'a leading modifier peels off')
eq(findLibraryExercise('Incline Bench Press')?.name, 'Incline Bench Press', 'but only when the full name is unknown')
eq(findLibraryExercise('Hip Hinge (Dowel)')?.name, 'Hip Hinge (Dowel)', 'a parenthesised canonical still finds itself')
eq(track('Cable Lateral Raises', '12-15'), 'weight_reps', 'cable lateral raise')
eq(track('Copenhagen Plank', '20s/side'), 'time', 'copenhagen')
eq(track('Dead Hang', '30-45s'), 'time', 'dead hang')
eq(track('Hollow Rock Hold', '30s'), 'time', 'uncurated hold with a time')
eq(track('Plank Up-Down', '10'), 'weight_reps', 'uncurated plank variant with a counted dose is not timed')
eq(track('Box Jumps', '3x5'), 'bodyweight_reps', 'box jumps')
eq(track('Assault Bike', '10 cal'), 'time', 'calorie target still logs on the clock')

eq(prescribedUnit('3 × 30s'), 'time', 'sets × time')
eq(prescribedUnit('5x5'), 'reps', 'sets × reps')
eq(prescribedUnit('8 each side'), 'reps', 'per-side count')
eq(prescribedUnit('1:30'), 'time', 'clock time')
eq(prescribedUnit('2 min'), 'time', 'minutes')
eq(prescribedUnit('20m'), 'distance', 'meters')
eq(prescribedUnit('1 mi'), 'distance', 'miles')
eq(prescribedUnit('AMRAP'), null, 'no quantity')

// A stamp written by the old heuristic is overruled for a curated lift…
const stale: ExerciseTemplate = { name: 'T-Bar Row', sets: 3, reps: '8 (3s eccentric)', tracking_type: 'time' }
eq(effectiveTrackingType(stale), 'weight_reps', 'library overrules a stale stamp')
// …and respected for one the library doesn't know.
const custom: ExerciseTemplate = { name: 'Gym-Specific Contraption', sets: 3, reps: '8', tracking_type: 'time' }
eq(effectiveTrackingType(custom), 'time', 'an uncurated stamp stands')

// ---- 3. patterns -----------------------------------------------------------

eq(resolvePattern('T-Bar Row'), 'horizontal_pull', 'T-bar row is a row')
eq(resolvePattern('Gorilla Row'), 'horizontal_pull', 'uncurated row by keyword')
eq(resolvePattern('Zottman Curl'), 'elbow_flexion', 'uncurated curl by keyword')
eq(resolvePattern('Seated Leg Curl'), 'knee_flexion', 'a leg curl is not a biceps curl')
eq(resolvePattern('Gym-Specific Contraption'), null, 'no opinion on the unknowable')

// ---- 4. swaps --------------------------------------------------------------

const tbar = suggestSwaps('T-Bar Row')
ok(tbar.length >= 8, `T-bar row has a real list (${tbar.length})`)
ok(tbar.slice(0, 6).every((s) => s.exercise.pattern === 'horizontal_pull'), 'top swaps for a row are rows')
ok(!tbar.some((s) => s.exercise.name === 'T-Bar Row'), 'a movement never suggests itself')
ok(tbar.slice(0, 5).some((s) => s.exercise.equipment === 'dumbbell'), 'a dumbbell option makes the first screen')
ok(new Set(tbar.slice(0, 4).map((s) => s.exercise.equipment)).size >= 3, 'the first screen spreads equipment')

const hotel = suggestSwaps('Barbell Row', { available: ['dumbbell'] })
ok(hotel.length > 0, 'a dumbbells-only gym still has rows')
ok(hotel.every((s) => equipmentAvailable(s.exercise.equipment, ['dumbbell'])), 'dumbbells-only: nothing needs other gear')
ok(hotel.some((s) => s.exercise.equipment === 'bodyweight'), 'bodyweight is always on hand')

const travel = suggestSwaps('Lat Pulldown', { available: [] })
ok(travel.some((s) => s.exercise.name === 'Pull-Up'), 'empty list means a full gym')
const noGear = suggestSwaps('Lat Pulldown', { available: ['band'] })
ok(noGear[0]?.exercise.name === 'Band Lat Pulldown', `bands only → band pulldown first (got ${noGear[0]?.exercise.name})`)

const recent = suggestSwaps('T-Bar Row', { recent: ['Chest-Supported Row'] })
eq(recent[0]?.exercise.name, 'Chest-Supported Row', 'last pick for this movement leads')
eq(recent[0]?.reason.startsWith('Your pick last time'), true, 'and says so')

const known = suggestSwaps('Bench Press', { hasHistory: (n) => n === 'Machine Chest Press' })
ok(known.findIndex((s) => s.exercise.name === 'Machine Chest Press') < 4, 'a lift with numbers on it ranks up')

const sq = suggestSwaps('Goblet Squat')
ok(!sq.some((s) => s.exercise.contra), 'never swap into a contraindicated movement')
const bsq = suggestSwaps('Back Squat', { screened: false })
ok(!bsq.some((s) => s.exercise.contra), 'unscreened: no contraindicated stand-ins even for a contra lift')

const excl = suggestSwaps('T-Bar Row', { exclude: ['DB Row'] })
ok(!excl.some((s) => s.exercise.name === 'DB Row'), 'a lift already in the session is left out')
eq(suggestSwaps('Gym-Specific Contraption').length, 0, 'no pattern, no guesses')

// ---- 5. building the stand-in ---------------------------------------------

const slot: ExerciseTemplate = {
  name: 'T-Bar Row', sets: 4, reps: '8-10', load: 'moderate', target_rpe: 8,
  insight_id: 'ins-1', cue: 'Chest on the pad', reading: true, pattern_key: 'shoulder_mobility',
  tracking_type: 'weight_reps',
}
const db = buildSwap(slot, 'dumbbell row')
eq(db.name, 'DB Row', 'canonical name')
eq(db.sets, 4, 'sets carry')
eq(db.reps, '8-10', 'reps carry when the metric matches')
eq(db.load, 'moderate', 'load carries')
eq(db.target_rpe, 8, 'effort carries')
eq(db.insight_id, 'ins-1', 'the slot still answers to its read')
eq(db.swapped_from, 'T-Bar Row', 'remembers the plan')
eq(db.cue, undefined, "the other lift's cue is dropped")
eq(db.reading, undefined, 'the reading tag is dropped')
eq(db.tracking_type, 'weight_reps', 'metric stamped')

const again = buildSwap(db, 'Cable Row')
eq(again.swapped_from, 'T-Bar Row', 'a swap of a swap still names the programmed lift')

const inv = buildSwap(slot, 'Inverted Row')
eq(inv.load, 'bodyweight', 'a bar row is bodyweight work')
eq(inv.tracking_type, 'bodyweight_reps', 'and logs as reps')

const abWheel: ExerciseTemplate = { name: 'Ab Wheel', sets: 3, reps: '10', load: 'bodyweight' }
const plank = buildSwap(abWheel, 'Plank')
eq(plank.tracking_type, 'time', 'plank logs time')
eq(plank.reps, '30s', 'and gets a timed dose, not "10"')

const carry: ExerciseTemplate = { name: 'Farmer Carry', sets: 3, reps: '40 yd', load: 'heavy' }
const suitcase = buildSwap(carry, 'Suitcase Carry')
eq(suitcase.tracking_type, 'distance', 'a carry for a carry keeps the distance')
eq(suitcase.reps, '40 yd', 'and the dose')

const bwRow: ExerciseTemplate = { name: 'Inverted Row', sets: 3, reps: '10', load: 'bodyweight' }
eq(buildSwap(bwRow, 'DB Row').load, 'light', 'bodyweight → loaded gets a starting load')

const freeform = buildSwap(slot, '  Hotel Cable Thing  ')
eq(freeform.name, 'Hotel Cable Thing', 'a typed name is accepted, trimmed')
eq(freeform.tracking_type, 'weight_reps', 'and gets a sane metric')

// ---- 6. search ---------------------------------------------------------------

eq(searchLibrary('t bar')[0]?.name, 'T-Bar Row', 'search finds the T-bar row')
ok(searchLibrary('curl').some((e) => e.name === 'Hammer Curl'), 'search by word')
eq(searchLibrary('').length, 0, 'empty query, empty result')
ok(Object.keys(TRACKING_LABEL).length === TRACKING_TYPES.length, 'every metric has a label')

if (fails.length) {
  console.error(`exerciseLibrary.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error('  ✗', f)
  process.exit(1)
}
console.log(`exerciseLibrary.check: all ${checks} checks passed`)
