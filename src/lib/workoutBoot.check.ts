// Run: node --experimental-strip-types src/lib/workoutBoot.check.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  draftHasLoggedSets,
  liveWorkoutReconcile,
  reconcileWorkoutBootstrap,
  routineContentDiffers,
  routineVersionMarker,
} from './routineVersion.ts'
import type { ExerciseTemplate, SetLog } from '../types/database.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

function emptySet(n: number): SetLog {
  return { set: n, weight: null, reps: null, rpe: null, done: false }
}
function loggedSet(n: number): SetLog {
  return { set: n, weight: 225, reps: 5, rpe: null, done: true }
}
function ex(name: string, sets: number, reps: string, load?: string): ExerciseTemplate {
  return { name, sets, reps, ...(load ? { load } : {}) }
}

const staleFriday = {
  name: 'Fri Bench Power + Hypertrophy',
  exercises: [
    ex('Bench Press', 3, '6-8', 'moderate'),
    ex('Push-up plus', 3, '8'),
  ],
}
const currentFriday = {
  name: 'Fri Power Baseline',
  exercises: [
    ex('Bench Press', 5, '2'),
    ex('Band Pull-Apart', 3, '12'),
    ex('Broad Jump', 3, '1'),
    ex('10yd Sprint', 4, '1'),
  ],
}

ok(routineContentDiffers(staleFriday, currentFriday), 'rewritten Friday differs by name/exercises')
ok(!routineContentDiffers(currentFriday, currentFriday), 'identical snapshot matches itself')
ok(
  routineVersionMarker(staleFriday) !== routineVersionMarker(currentFriday),
  'version marker changes when the session is rewritten under the same id',
)
ok(
  routineVersionMarker({ ...currentFriday, updated_at: '2026-10-25T00:00:00Z' })
    !== routineVersionMarker({ ...currentFriday, updated_at: '2026-10-30T00:00:00Z' }),
  'updated marker is part of the version',
)

const firstOpen = reconcileWorkoutBootstrap(currentFriday, null, false)
ok(firstOpen.reseed === true, 'missing bootstrap is seeded from the snapshot')
ok(firstOpen.discardEmptyDraft === false, 'first seed does not discard a draft')

const sameContent = reconcileWorkoutBootstrap(currentFriday, currentFriday, false)
ok(sameContent.reseed === false, 'matching snapshot leaves a fetched bootstrap alone')
ok(sameContent.discardEmptyDraft === false, 'matching snapshot does not touch the draft')

const staleEmpty = reconcileWorkoutBootstrap(currentFriday, staleFriday, false)
ok(staleEmpty.reseed === true, 'rewritten routine under the same id reseeds the bootstrap')
ok(staleEmpty.discardEmptyDraft === true, 'empty draft of the older version is discarded')

const staleLogged = reconcileWorkoutBootstrap(currentFriday, staleFriday, true)
ok(staleLogged.reseed === true, 'logged draft still reseeds the bootstrap to the snapshot')
ok(staleLogged.discardEmptyDraft === false, 'draft with logged sets is never discarded')

ok(!draftHasLoggedSets({ 0: [emptySet(1), emptySet(2)] }), 'untouched template rows are not logged')
ok(draftHasLoggedSets({ 0: [loggedSet(1)] }), 'a done set with numbers is logged')
ok(draftHasLoggedSets({ 0: [{ set: 1, weight: null, reps: 8, rpe: null, done: false }] }),
  'typed-in reps without a tap still count as logged')

const bootSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'workoutBoot.ts'), 'utf8')
ok(bootSrc.includes('reconcileWorkoutBootstrap'), 'seedWorkoutBootstrap uses the reconcile policy')
ok(bootSrc.includes('discardEmptyStaleDraft'), 'stale path can discard an empty local draft')
ok(!bootSrc.includes('workoutOutbox'), 'workout bootstrap does not import the outbox')
ok(!bootSrc.includes('clearDraft('), 'stale path does not call the remote-clearing clearDraft')

const screenSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../screens/loop/WorkoutScreen.tsx'), 'utf8')
ok(screenSrc.includes('seedWorkoutBootstrap'), 'workout screen reseeds from the snapshot before painting')
ok(screenSrc.includes('routines.find'), 'workout screen looks up the snapshot routine by id')
ok(screenSrc.includes('liveWorkoutReconcile'), 'workout screen reconciles when a late snapshot arrives')
ok(screenSrc.includes('draftHasLoggedSets'), 'late reconcile checks the live grid for logged sets')

const lateEmpty = liveWorkoutReconcile(currentFriday, staleFriday, false)
ok(lateEmpty.adoptRoutine === true, 'late snapshot adopts the fresher routine when the grid is empty')
ok(lateEmpty.rebuildGrid === true, 'late snapshot rebuilds an empty grid to the snapshot')

const lateLogged = liveWorkoutReconcile(currentFriday, staleFriday, true)
ok(lateLogged.adoptRoutine === false, 'late snapshot does not swap the exercise list under logged sets')
ok(lateLogged.rebuildGrid === false, 'late snapshot does not rebuild a grid with logged sets')

const lateSame = liveWorkoutReconcile(currentFriday, currentFriday, false)
ok(lateSame.adoptRoutine === false && lateSame.rebuildGrid === false, 'late snapshot matching the paint is a no-op')

const lateCold = liveWorkoutReconcile(currentFriday, null, false)
ok(lateCold.adoptRoutine === true && lateCold.rebuildGrid === true, 'late snapshot on a cold paint adopts and builds the grid')

ok(bootSrc.includes('liveWorkoutReconcile'), 'workoutBoot re-exports the live reconcile')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('workout bootstrap stale rewrite: ok')
