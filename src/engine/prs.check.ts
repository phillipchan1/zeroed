// Standalone integrity check for PR detection and volume (no test runner
// installed, same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/prs.check.ts
//
// The properties that matter:
//
//   · a true single's e1RM is the weight, not 3.3% above it
//   · a TIE is never a PR — the record stands
//   · beating the bar by a pound is a PR; matching it is not
//   · more reps at less weight is not a rep PR
//   · volume is load × reps and nothing else — a set of carries adds nothing,
//     and a bodyweight set contributes only what was hung off the belt

import {
  estimate1RM, estimateIsReliable, detectSetPRs, displayPRs, foldBest, bestOfSets, prLabel,
  NO_BEST, type LiftBest,
} from './prs.ts'
import { tallySets, tallySession, setLoad, isSetLogged, sumVolume, NO_VOLUME } from './volume.ts'
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
function same(actual: unknown[], expected: unknown[], msg: string) {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fails.push(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const set = (weight: number | null, reps: number | null, extra: Partial<SetLog> = {}): SetLog => ({
  set: 1, weight, reps, rpe: null, done: true, ...extra,
})

// ---- 1. the estimator -------------------------------------------------------

eq(estimate1RM(225, 1), 225, 'a true single IS the 1RM — no extrapolation past it')
eq(estimate1RM(225, 5), 263, '225×5 estimates 263')
eq(estimate1RM(100, 10), 133, '100×10 estimates 133')
eq(estimate1RM(0, 5), null, 'an unloaded set estimates nothing')
eq(estimate1RM(225, 0), null, 'zero reps estimates nothing')
ok(estimateIsReliable(5), 'five reps is a usable estimate')
ok(!estimateIsReliable(20), 'twenty reps is an endurance set, not a strength estimate')
ok(!estimateIsReliable(null), 'no reps, no estimate')

// ---- 2. PRs: strictly greater ----------------------------------------------

const standing: LiftBest = { weight: 225, e1rm: 263, repsAtBest: 5 }

same(detectSetPRs(set(225, 5), standing), [], 'repeating your best is not a PR')
same(detectSetPRs(set(230, 5), standing), ['weight', 'e1rm'], 'a heavier top set is a PR twice over')
same(detectSetPRs(set(225, 6), standing), ['e1rm', 'reps'], 'same bar, one more rep — e1RM and rep PR')
same(detectSetPRs(set(225, 4), standing), [], 'same bar, fewer reps — nothing')
same(detectSetPRs(set(135, 12), standing), [], 'more reps at a lighter weight is not a rep PR')
same(detectSetPRs(set(null, 8), standing), [], 'an unloaded set can never be a weight PR')
same(detectSetPRs(set(100, 5), NO_BEST), ['weight', 'e1rm'], 'the very first loaded set sets both records')
same(detectSetPRs(null, standing), [], 'no set, no PR')

// The exact boundary — one unit over is a PR, dead level is not.
same(detectSetPRs(set(226, 5), standing), ['weight', 'e1rm'], 'one pound over the best is a PR')
eq(detectSetPRs(set(225, 5), standing).length, 0, 'dead level leaves the record standing')

// A first-ever set is a baseline, not a record — nothing to beat.
same(displayPRs(set(100, 5), NO_BEST), [], 'the first loaded set on a lift shows no badge')
same(displayPRs(set(230, 5), standing), ['weight', 'e1rm'], 'a real record still shows')

eq(prLabel(['weight', 'e1rm', 'reps']), 'Heaviest', 'heaviest-ever outranks the estimate')
eq(prLabel(['e1rm', 'reps']), 'Best e1RM', 'the estimate outranks a rep record')
eq(prLabel([]), null, 'no PR, no badge')

// ---- 3. folding a history ---------------------------------------------------

const hist = bestOfSets([set(185, 5), set(205, 5), set(225, 3), set(225, 5)])
eq(hist.weight, 225, 'the heaviest weight wins')
eq(hist.repsAtBest, 5, 'reps at the top weight take the best of the ties')
eq(hist.e1rm, estimate1RM(225, 5), 'the best estimate comes off the best set')

// A new top weight RESETS the rep benchmark — 5 reps at 225 does not make
// 4 reps at 235 a rep failure.
const after = foldBest(hist, set(235, 3))
eq(after.weight, 235, 'the new top weight takes over')
eq(after.repsAtBest, 3, 'the rep benchmark resets to the new top set')
same(detectSetPRs(set(235, 4), after), ['e1rm', 'reps'],
  'one more rep at the new top weight is a rep PR (and a better estimate with it)')

eq(foldBest(NO_BEST, set(null, 10)).weight, null, 'an unloaded set moves no record')

// ---- 4. volume --------------------------------------------------------------

eq(setLoad(set(225, 5)), 1125, '225 × 5 is 1125')
eq(setLoad(set(0, 5)), 0, 'an unloaded set is no tonnage')
eq(setLoad(set(225, 0)), 0, 'zero reps is no tonnage')
eq(setLoad(set(-45, 5)), 0, 'a negative weight can never add volume')
eq(setLoad({ set: 1, weight: null, reps: null, rpe: null, done: true, duration: 60 }), 0,
  'a 60-second plank is training, but it is not tonnage')

const session = tallySets([
  set(225, 5), set(225, 5), set(225, 3),
  { set: 4, weight: null, reps: null, rpe: null, done: true, duration: 45 },
  { set: 5, weight: null, reps: 12, rpe: null, done: true },
])
eq(session.load, 1125 + 1125 + 675, 'session volume sums the loaded sets')
eq(session.loadedSets, 3, 'three of the five sets carried load')
eq(session.loggedSets, 5, 'all five sets were logged')
eq(session.reps, 5 + 5 + 3 + 12, 'reps count whether loaded or not')

eq(tallySession({ 0: [set(100, 10)], 1: [set(50, 10)] }).load, 1500, 'a grid tallies across exercises')
eq(tallySession(null).load, 0, 'no grid, no volume')
eq(sumVolume([session, session]).load, session.load * 2, 'tallies add')
eq(sumVolume([]).load, NO_VOLUME.load, 'an empty roll-up is zero')

// The shared predicate: numbers typed without tapping the checkbox still count.
ok(isSetLogged({ set: 1, weight: 225, reps: 5, rpe: null, done: false }),
  'a set with numbers in it is logged even if the box was never tapped')
ok(!isSetLogged({ set: 1, weight: null, reps: null, rpe: null, done: false }),
  'an untouched set is not logged')
ok(isSetLogged({ set: 1, weight: null, reps: 0, rpe: null, done: false }),
  'zero reps is a deliberate entry, not an empty one')

// ---- report -----------------------------------------------------------------

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} PR/volume checks failed:`)
  fails.forEach((f) => console.error(`  · ${f}`))
  process.exit(1)
}
console.log(`✓ all ${checks} PR/volume checks passed`)
