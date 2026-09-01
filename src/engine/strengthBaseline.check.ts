// Standalone integrity check for the strength baseline (no test runner
// installed, same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/strengthBaseline.check.ts
//
// The properties that matter:
//
//   · a lift lands in the movement slot a coach would put it in — "Leg Press"
//     is a squat pattern, "Overhead Press" is a push, and the ordering of the
//     patterns is what decides it
//   · the baseline covers the four slots before it doubles up, so a lifter with
//     four pressing variations doesn't get a "baseline" of four benches
//   · a lift with no loaded history is DROPPED, not offered as a blank field —
//     the whole point is to stop asking
//   · the stored map still answers to the legacy slot keys, so the existing
//     squat:hinge ratio check and every row already in the database keep working
//   · a delta inside the estimate's own error bar is not called progress

import {
  slotOf, buildBaseline, toStrengthMap, namedLifts, strengthDeltas, strengthStalls, gainPct,
  SLOT_KEY, MEANINGFUL_GAIN_PCT,
} from './strengthBaseline.ts'
import type { LiftBest } from './prs.ts'

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
function same(actual: unknown, expected: unknown, msg: string) {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fails.push(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const best = (weight: number, reps: number, e1rm?: number): LiftBest => ({
  weight, repsAtBest: reps, e1rm: e1rm ?? Math.round(weight * (1 + reps / 30)),
})

// ---- 1. slotting ------------------------------------------------------------

eq(slotOf('Back Squat'), 'squat', 'a squat is a squat')
eq(slotOf('Front Squat'), 'squat', 'so is a front squat')
eq(slotOf('Leg Press'), 'squat', 'a leg press is a squat pattern, not a press')
eq(slotOf('Bulgarian Split Squat'), 'squat', 'a split squat is a squat pattern')
eq(slotOf('Deadlift'), 'hinge', 'a deadlift hinges')
eq(slotOf('Romanian Deadlift'), 'hinge', 'so does an RDL')
eq(slotOf('Hip Thrust'), 'hinge', 'and a hip thrust')
eq(slotOf('Bench Press'), 'push', 'a bench is a push')
eq(slotOf('Overhead Press'), 'push', 'an overhead press is a push')
eq(slotOf('Barbell Row'), 'pull', 'a row pulls')
eq(slotOf('Pull-Up'), 'pull', 'a pull-up pulls')
eq(slotOf('Lat Pulldown'), 'pull', 'a pulldown pulls')
eq(slotOf('Plank'), null, 'a plank is not a main strength pattern')
eq(slotOf('Farmer Carry'), null, 'a carry has no slot')

// ---- 2. building the baseline ----------------------------------------------

const bests: Record<string, LiftBest> = {
  'Back Squat':       best(315, 5),
  'Bench Press':      best(225, 5),
  'Deadlift':         best(405, 3),
  'Barbell Row':      best(185, 8),
  'Bulgarian Split Squat': best(80, 8),
  'Plank':            { weight: null, reps: null, e1rm: null, repsAtBest: null } as unknown as LiftBest,
}

const baseline = buildBaseline(
  ['Back Squat', 'Bench Press', 'Deadlift', 'Barbell Row', 'Bulgarian Split Squat', 'Plank'],
  bests,
)
same(baseline.map((l) => l.name), ['Deadlift', 'Back Squat', 'Bench Press', 'Barbell Row', 'Bulgarian Split Squat'],
  'one lift per slot first (heaviest wins the slot), then the rest')
ok(!baseline.some((l) => l.name === 'Plank'), 'a lift with no loaded history is dropped, not offered blank')

// The failure this ordering exists to prevent: a program that is all pressing
// must not produce a "strength baseline" of four benches and nothing else.
const pressOnly = buildBaseline(
  ['Bench Press', 'Incline Bench Press', 'DB Bench Press', 'Overhead Press', 'Barbell Row'],
  {
    'Bench Press':         best(225, 5),
    'Incline Bench Press': best(185, 5),
    'DB Bench Press':      best(160, 8),
    'Overhead Press':      best(135, 5),
    'Barbell Row':         best(185, 8),
  },
  {},
  2,
)
same(pressOnly.map((l) => l.slot), ['push', 'pull'], 'slot coverage beats raw weight when places are scarce')

eq(buildBaseline(['Back Squat'], {}).length, 0, 'no logged bests, no baseline')
eq(buildBaseline([], bests).length, 0, 'no lifts, no baseline')

// A lift the athlete trains twice under the same name is counted once.
eq(buildBaseline(['Back Squat', 'Back Squat'], bests).length, 1, 'a repeated lift is one entry')

// The e1RM comes off the logged set, not a guess.
eq(baseline.find((l) => l.name === 'Back Squat')!.e1rm, Math.round(315 * (1 + 5 / 30)),
  'the baseline number is the logged e1RM')
eq(baseline.find((l) => l.name === 'Back Squat')!.topWeight, 315, 'the set behind it is carried for display')

// ---- 3. the stored map ------------------------------------------------------

const map = toStrengthMap(baseline)
eq(map['Back Squat'], 368, 'the map carries the lift by its real name')
eq(map[SLOT_KEY.squat], 368, 'and answers to the legacy slot key')
eq(map[SLOT_KEY.hinge], Math.round(405 * (1 + 3 / 30)), 'the hinge slot takes the deadlift')
eq(map[SLOT_KEY.push], 263, 'the push slot takes the bench')
ok(map[SLOT_KEY.squat]! > map['Bulgarian Split Squat']!, 'the heaviest lift in a slot owns the slot')

same(Object.keys(namedLifts(map)).sort(),
  ['Back Squat', 'Barbell Row', 'Bench Press', 'Bulgarian Split Squat', 'Deadlift'],
  'named lifts read back without the legacy keys')

// ---- 4. deltas --------------------------------------------------------------

const prior = { 'Back Squat': 350, 'Bench Press': 260, squat_1rm_est: 350, push_1rm_est: 260 }
const now   = { 'Back Squat': 368, 'Bench Press': 262, squat_1rm_est: 368, push_1rm_est: 262 }

const deltas = strengthDeltas(prior, now)
same(deltas.map((d) => d.name), ['Back Squat'], 'only the meaningful gain is reported')
eq(deltas[0].from, 350, 'the delta carries where it came from')
eq(deltas[0].to, 368, 'and where it got to')
eq(deltas[0].pct, 5, 'and by how much')

ok(((262 - 260) / 260) * 100 < MEANINGFUL_GAIN_PCT,
  'the bench move is inside the estimate error bar, which is why it is not reported')

// The boundary the retest step and the retest summary used to disagree about:
// 258 → 263 is 1.94%, which ROUNDS to 2 but isn't 2. One predicate, one answer.
eq(gainPct(258, 263), null, '1.94% rounds to 2 but is still not a reported gain')
eq(gainPct(350, 368), 5, 'a real gain reports its rounded percentage')
eq(gainPct(400, 350), null, 'a regression is not a gain')
eq(gainPct(null, 368), null, 'nothing to compare against')
eq(gainPct(0, 368), null, 'a zero baseline can never yield a percentage')
ok(strengthDeltas({ 'Bench Press': 258 }, { 'Bench Press': 263 }).length === 0,
  'and the summary agrees with the step on that same lift')

same(strengthDeltas(prior, prior), [], 'no change, nothing to say')
same(strengthDeltas(undefined, now), [], 'no prior diagnostic, no delta')
same(strengthDeltas({ 'Back Squat': 400 }, { 'Back Squat': 350 }), [], 'a regression is not reported as a gain')

// ---- 5. stalls: the half nobody reports -------------------------------------
// A lift measured twice that didn't move is an instruction to change something.

same(strengthStalls(prior, now), ['Bench Press'],
  'a lift measured twice that did not move is a stall')
same(strengthStalls(prior, { 'Back Squat': 368, 'Bench Press': 290 }), [],
  'two real gains, no stalls')
same(strengthStalls({ 'Back Squat': 400 }, { 'Back Squat': 350 }), ['Back Squat'],
  'a regression counts as a stall — same instruction, and more likely estimate noise than a real loss')
same(strengthStalls(prior, { 'Overhead Press': 150 }), [],
  'a lift with no prior measurement cannot have stalled')
same(strengthStalls(undefined, now), [], 'no prior diagnostic, no stalls')
ok(!strengthStalls(prior, now).includes('squat_1rm_est'),
  'the canonical slot keys are not reported as lifts')

// A retest against a legacy row (canonical keys only) still says something.
const legacy = strengthDeltas({ squat_1rm_est: 300 }, { 'Back Squat': 368, squat_1rm_est: 368 })
same(legacy.map((d) => d.name), ['Squat'], 'falls back to the canonical slot against an old row')
eq(legacy[0].pct, 23, 'and reports the real move')

// ---- report -----------------------------------------------------------------

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} strength-baseline checks failed:`)
  fails.forEach((f) => console.error(`  · ${f}`))
  process.exit(1)
}
console.log(`✓ all ${checks} strength-baseline checks passed`)
