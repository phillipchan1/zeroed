// Standalone integrity check for logged-set attribution (no test runner
// installed, same convention as programDraft.check.ts).
// Run: node --experimental-strip-types src/engine/loggedSets.check.ts
//
// The property under test is the one that was silently false before the
// snapshot existed: EDITING A PROGRAM MUST NOT CHANGE WHAT THE ATHLETE DID.
// actual_weights is index-keyed, the editor splices exercises in and out, and
// every read used to resolve names against the routine's live list — so adding
// one movement to the middle of a session rewrote the history of every session
// already logged against it.

import { readLoggedExercises, resolveLoggedExercises } from './loggedSets.ts'
import { applyEditsToDraft, type ProgramDraft } from './programDraft.ts'
import type { ProgramEdit } from './agentClient.ts'
import type { ExerciseTemplate, SetLog } from '../types/database.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

function ex(name: string, sets = 3, reps = '5'): ExerciseTemplate {
  return { name, sets, reps, tracking_type: 'weight_reps' }
}
function set(weight: number, reps: number): SetLog {
  return { set: 1, weight, reps, rpe: 8, done: true }
}

// The week as it stood on Monday, and the session the athlete actually logged
// against it: squats at 225, bench at 185, rows at 135.
const AS_LOGGED = [ex('Back Squat'), ex('Bench Press'), ex('Barbell Row')]
const workout = {
  actual_weights: {
    '0': [set(225, 5)],
    '1': [set(185, 5)],
    '2': [set(135, 8)],
  } as Record<string, SetLog[]>,
  exercises_snapshot: AS_LOGGED,
}

// ---- the baseline: a snapshot reads back exactly what was done -------------

const asLogged = readLoggedExercises(workout)
ok(asLogged.length === 3, `expected 3 logged movements, got ${asLogged.length}`)
ok(asLogged[0].name === 'Back Squat', `slot 0 should be Back Squat, got ${asLogged[0]?.name}`)
ok(asLogged[1].name === 'Bench Press', `slot 1 should be Bench Press, got ${asLogged[1]?.name}`)
ok(asLogged[2].name === 'Barbell Row', `slot 2 should be Barbell Row, got ${asLogged[2]?.name}`)
ok(asLogged[0].sets[0].weight === 225, 'the squat should still carry 225')

// ---- the regression: an edit splices, and history must not move -------------
//
// Run the REAL editor against the real week, exactly as an athlete would on a
// Friday: "add a jump to the session". add_exercise inserts at anchor+1, so
// every index after the anchor shifts by one.

const draft: ProgramDraft = {
  sessionsPerWeek: 3,
  sessions: [{
    routineId: 'r1', name: 'Lower A', intent: '', sessionType: 'strength',
    intendedDow: null, exercises: AS_LOGGED.map((e) => ({ ...e })),
  }],
}
const addJump: ProgramEdit = {
  type: 'add_exercise',
  session_name: 'Lower A',
  exercise_name: 'Box Jump',
  after_exercise: 'Back Squat',   // lands at index 1, shifting bench and row
  sets: 4, reps: '3',
  load: null, cue: null, target_rpe: null,
  exercises: null, note: null, sessions_per_week: null,
  set_name: null, set_intent: null, set_session_type: null, set_intended_dow: null,
} as unknown as ProgramEdit

const { draft: edited } = applyEditsToDraft(draft, [addJump])
const liveAfterEdit = edited.sessions[0].exercises

// Confirm the edit really did shift the indices — otherwise this check proves
// nothing, and would keep passing if add_exercise stopped splicing.
ok(liveAfterEdit.length === 4, `the edit should add a movement, got ${liveAfterEdit.length}`)
ok(liveAfterEdit[1].name === 'Box Jump', `Box Jump should land at index 1, got ${liveAfterEdit[1]?.name}`)
ok(liveAfterEdit[2].name === 'Bench Press', 'Bench Press should have shifted to index 2')

// Reading the OLD workout against the NEW routine — the exact situation after
// hitting Apply on a Friday with the week already logged.
const afterEdit = readLoggedExercises({ ...workout, routine: { exercises: liveAfterEdit } })
ok(afterEdit[0].name === 'Back Squat', `after the edit slot 0 must still read Back Squat, got ${afterEdit[0]?.name}`)
ok(afterEdit[1].name === 'Bench Press',
  `after the edit the 185 must still be Bench Press, got ${afterEdit[1]?.name} — this is the relabeling bug`)
ok(afterEdit[2].name === 'Barbell Row',
  `after the edit the 135 must still be Barbell Row, got ${afterEdit[2]?.name}`)
ok(afterEdit.every((l, i) => l.sets[0].weight === asLogged[i].sets[0].weight),
  'the numbers must be attached to the same movements as before the edit')

// And the proof that the snapshot is what saves it: without one, the same read
// resolves against the edited routine and DOES mislabel. This asserts the
// failure mode is real, so the check above is not vacuous.
const noSnapshot = readLoggedExercises({
  actual_weights: workout.actual_weights,
  exercises_snapshot: null,
  routine: { exercises: liveAfterEdit },
})
ok(noSnapshot[1].name === 'Box Jump',
  'without a snapshot the 185 should mislabel as Box Jump — if not, this check no longer proves anything')

// ---- removal shifts the other way ------------------------------------------

const removed = liveAfterEdit.filter((e) => e.name !== 'Box Jump' && e.name !== 'Back Squat')
const afterRemoval = readLoggedExercises({ ...workout, routine: { exercises: removed } })
ok(afterRemoval[0].name === 'Back Squat', 'a dropped lift must not erase it from a logged session')
ok(afterRemoval.length === 3, `all 3 logged movements should survive a removal, got ${afterRemoval.length}`)

// ---- fallbacks and shapes ---------------------------------------------------

ok(resolveLoggedExercises({ actual_weights: null, exercises_snapshot: AS_LOGGED }).length === 3,
  'a snapshot should be used when present')
ok(resolveLoggedExercises({ actual_weights: null, routine: { exercises: AS_LOGGED } }).length === 3,
  'the routine should be the fallback when no snapshot exists')
ok(resolveLoggedExercises({ actual_weights: null, exercises_snapshot: [] , routine: { exercises: AS_LOGGED } }).length === 3,
  'an empty snapshot should fall back rather than blank the session')
ok(resolveLoggedExercises({ actual_weights: null }).length === 0,
  'no snapshot and no routine should read as nothing, not throw')

ok(readLoggedExercises({ actual_weights: null, exercises_snapshot: AS_LOGGED }).length === 0,
  'a workout with no sets logs nothing')
ok(readLoggedExercises({ actual_weights: { '0': [] }, exercises_snapshot: AS_LOGGED }).length === 0,
  'an empty set array is not a logged movement')
ok(readLoggedExercises({ actual_weights: { '9': [set(100, 5)] }, exercises_snapshot: AS_LOGGED }).length === 0,
  'an index past the end of the prescription names nothing and must be dropped')

// Name-keyed rows (hand-seeded data) resolve by name, not by a bogus index.
const named = readLoggedExercises({
  actual_weights: { 'Bench Press': [set(185, 5)] } as Record<string, SetLog[]>,
  exercises_snapshot: AS_LOGGED,
})
ok(named.length === 1 && named[0].name === 'Bench Press', 'a name-keyed entry should resolve by name')
ok(named[0].exercise?.sets === 3, 'a name-keyed entry should still find its template')

// ---- report ----------------------------------------------------------------

if (fails.length) {
  console.error(`loggedSets.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`loggedSets.check: ${checks} checks passed`)
