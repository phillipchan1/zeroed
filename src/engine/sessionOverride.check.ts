// Run: node --experimental-strip-types src/engine/sessionOverride.check.ts
import {
  addDays, applyOverrideOps, defaultExpiresOn, diffOverride, findExercise, isIsoDate,
  normalizeInputOps, overrideActive, overrideView, resolveExpiresOn, sessionWithOverride, shortDateLabel, workoutRxDate,
} from './sessionOverride.ts'
import type { ExerciseTemplate } from '../types/database.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const base: ExerciseTemplate[] = [
  { name: 'Bench Press', sets: 4, reps: '5', load: '185', target_rpe: 8 },
  { name: 'Incline DB Press', sets: 3, reps: '10', load: 'moderate' },
  { name: 'Cable Row', sets: 3, reps: '12', load: 'moderate' },
]

// Dates. 2026-11-02 is a Monday, 2026-11-08 the Sunday after.
ok(isIsoDate('2026-11-05') && !isIsoDate('2026-02-30') && !isIsoDate('11/05/2026'), 'isIsoDate: real calendar dates only')
ok(defaultExpiresOn('2026-11-02') === '2026-11-08', 'expiry: Monday → that Sunday')
ok(defaultExpiresOn('2026-11-05') === '2026-11-08', 'expiry: Thursday → that Sunday')
ok(defaultExpiresOn('2026-11-08') === '2026-11-08', 'expiry: Sunday → the same day')
ok(resolveExpiresOn('2026-11-05', null) === '2026-11-08', 'expiry: default when not asked')
ok(resolveExpiresOn('2026-11-05', '2026-11-12') === '2026-11-12', 'expiry: up to 7 days after is allowed')
ok(resolveExpiresOn('2026-11-05', '2026-11-13') === null, 'expiry: 8 days after is refused')
ok(resolveExpiresOn('2026-11-05', '2026-11-04') === null, 'expiry: before the date is refused')
ok(addDays('2026-12-30', 3) === '2027-01-02', 'addDays crosses a year')
ok(shortDateLabel('2026-11-05') === 'Thu Nov 5', 'shortDateLabel')

const row = { id: 'r1', date: '2026-11-05', expires_on: '2026-11-08', ops: [] }
ok(overrideActive(row, '2026-11-05', '2026-11-04'), 'active: on its date, before expiry')
ok(!overrideActive(row, '2026-11-06', '2026-11-04'), 'active: never on another date')
ok(overrideActive(row, '2026-11-05', '2026-11-08'), 'active: through expires_on')
ok(!overrideActive(row, '2026-11-05', '2026-11-09'), 'active: never after expires_on')
ok(!overrideActive({ ...row, voided_at: '2026-11-04T00:00:00Z' }, '2026-11-05', '2026-11-04'), 'active: never once cleared')

// Matching.
ok('index' in findExercise(base, 'bench press') && (findExercise(base, 'bench press') as { index: number }).index === 0, 'match: exact, any case')
ok('error' in findExercise(base, 'press'), 'match: an ambiguous fragment is an error, not a guess')
ok((findExercise(base, 'row') as { index: number }).index === 2, 'match: one unambiguous fragment')
ok('error' in findExercise(base, 'Deadlift'), 'match: missing is an error')
ok('error' in findExercise(base, 'Close-Grip Bench Press'), 'match: a longer name never lands on a shorter lift it contains')

// Ops.
const swapped = applyOverrideOps(base, [[{ op: 'swap', exercise_name: 'Bench Press', with: { name: 'DB Bench Press' } }]])
ok(swapped.exercises[0].name === 'DB Bench Press' && swapped.exercises[0].sets === 4 && swapped.exercises[0].target_rpe === 8, 'swap: keeps the slot\'s sets and RPE')
ok(swapped.exercises[0].load === undefined, 'swap: a number written for the old lift does not carry over')
ok(swapped.marks[0]?.kind === 'swapped' && swapped.marks[0].from === 'Bench Press', 'swap: marked with the programmed lift')
const twice = applyOverrideOps(base, [
  [{ op: 'swap', exercise_name: 'Bench Press', with: { name: 'DB Bench Press' } }],
  [{ op: 'swap', exercise_name: 'DB Bench Press', with: { name: 'Push-up' } }],
])
ok(twice.marks[0]?.from === 'Bench Press', 'swap: a second swap still names the programmed lift')
const missing = applyOverrideOps(base, [[{ op: 'drop', exercise_name: 'Deadlift' }, { op: 'drop', exercise_name: 'Cable Row' }]])
ok(missing.errors.length === 1 && missing.exercises.length === 2, 'apply: a missing target is reported and the rest still apply')
const added = applyOverrideOps(base, [[{ op: 'add', exercise: { name: 'Face Pull' }, after: 'Bench Press' }]])
ok(added.exercises[1].name === 'Face Pull' && added.exercises[1].sets === 3 && added.marks[1]?.kind === 'added', 'add: after a named lift, with defaults')
const out = applyOverrideOps(base, [[{ op: 'move_out', exercise_name: null, to_date: '2026-11-06' }]])
ok(out.exercises.length === 0 && out.movedOut[0].to_date === '2026-11-06', 'move_out: the whole session leaves')
const into = applyOverrideOps(base, [[{ op: 'move_in', from_date: '2026-11-04', exercise: null }]])
ok(into.movedInFrom === '2026-11-04' && Object.keys(into.marks).length === 3, 'move_in: the whole session arrives, every lift marked')
const carried = applyOverrideOps(base, [
  [{ op: 'move_out', exercise_name: null, to_date: '2026-11-07' }],
  [{ op: 'move_in', from_date: '2026-11-04', exercise: null, session: [{ name: 'Push-up', sets: 3, reps: '15' }] }],
])
ok(carried.exercises.map((e) => e.name).join() === 'Push-up', 'move_in: arrives as it stood on its day, even onto a day it had left')

// Diff.
const changes = diffOverride(applyOverrideOps(base, []), applyOverrideOps(base, [[
  { op: 'adjust', exercise_name: 'Cable Row', sets: 2 },
  { op: 'drop', exercise_name: 'Incline DB Press' },
]]))
ok(changes.some((c) => c.kind === 'changed' && c.name === 'Cable Row' && c.before?.startsWith('3×12') && c.after?.startsWith('2×12')), 'diff: adjust is a change')
ok(changes.some((c) => c.kind === 'removed' && c.name === 'Incline DB Press'), 'diff: drop is a removal')
ok(!changes.some((c) => c.name === 'Bench Press'), 'diff: untouched lifts are not listed')

// View.
ok(overrideView(base, [row], '2026-11-06', '2026-11-04') === null, 'view: null on another date')
ok(overrideView(base, [{ ...row, ops: [{ op: 'drop', exercise_name: 'Cable Row' }] }], '2026-11-05', '2026-11-04')?.dropped[0] === 'Cable Row', 'view: lists drops on its date')

// Input validation.
ok(normalizeInputOps([]).errors.length === 1, 'input: empty ops refused')
ok(normalizeInputOps([{ op: 'delete_everything' }]).errors.length === 1, 'input: unknown op refused')
ok(normalizeInputOps([{ op: 'adjust', exercise_name: 'Cable Row' }]).errors.length === 1, 'input: adjust with nothing to adjust refused')
ok(normalizeInputOps([{ op: 'adjust', exercise_name: 'Cable Row', sets: 40 }]).errors.length === 1, 'input: out-of-range sets refused')
ok(normalizeInputOps([{ op: 'move', to_date: '2026-11-06' }, { op: 'drop', exercise_name: 'Cable Row' }]).errors.length === 1, 'input: a whole-session move goes alone')
ok(normalizeInputOps(Array.from({ length: 13 }, () => ({ op: 'drop', exercise_name: 'x' }))).errors.length === 1, 'input: at most 12 ops')
const good = normalizeInputOps([{ op: 'swap', exercise_name: 'Bench Press', with: { name: 'DB Bench Press', sets: 3 } }])
ok(good.errors.length === 0 && good.ops.length === 1, 'input: a valid swap passes')

// Starting today's session (tracks_v1): the date sent, and the list trained.
const T = '2026-11-05'
ok(workoutRxDate({ tracksOn: false, isEdit: false, week: null, today: T }) === null, 'workout start: flag off → no date, the request is unchanged')
ok(workoutRxDate({ tracksOn: true, isEdit: false, week: null, today: T }) === T, 'workout start: flag on → today\'s date')
ok(workoutRxDate({ tracksOn: true, isEdit: true, week: null, today: T }) === null, 'workout start: never on an edit of a logged session')
ok(workoutRxDate({ tracksOn: true, isEdit: false, week: { start: '2026-11-02', end: '2026-11-08' }, today: T }) === T, 'workout start: logging into this week still uses today')
ok(workoutRxDate({ tracksOn: true, isEdit: false, week: { start: '2026-10-26', end: '2026-11-01' }, today: T }) === null, 'workout start: logging into another week → template')
const routineRow = { id: 'r1', name: 'Push', exercises: base }
const todays = overrideView(base, [{ id: 'o1', date: T, expires_on: '2026-11-08', ops: [{ op: 'drop', exercise_name: 'Cable Row' }] }], T, T)
ok(sessionWithOverride(routineRow, null) === routineRow, 'workout start: no override → the template, same object')
const trained = sessionWithOverride(routineRow, todays)
ok(trained.exercises.map((e) => e.name).join() === 'Bench Press,Incline DB Press' && trained.name === 'Push', 'workout start: an override for today replaces the list')
ok(routineRow.exercises.length === 3, 'workout start: the template itself is untouched')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('session override engine: ok')
