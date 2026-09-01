// Standalone integrity check for the strength balance read.
// Run: node --experimental-strip-types src/engine/balance.check.ts
//
// The properties that matter:
//
//   · a lifter in proportion has NO weak chain — the read must be able to say
//     "nothing is behind" rather than always nominating a loser
//   · the reference is the athlete's own average standing, not the squat, so a
//     lifter who simply squats badly doesn't read as though every other lift
//     were ahead
//   · one lift is not a ratio, and it says so instead of inventing a baseline
//   · the finding is the same under any unit and any absolute strength level

import {
  readBalance, describeGap, labelForSlot,
  EXPECTED_VS_SQUAT, LAGGING_THRESHOLD, LEADING_THRESHOLD,
  type BalanceInput,
} from './balance.ts'

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

// A lifter exactly on the textbook ratios, off a 400 squat.
const inProportion: BalanceInput[] = [
  { slot: 'squat', lift: 'Back Squat',   e1rm: 400 },
  { slot: 'hinge', lift: 'Deadlift',     e1rm: 480 },
  { slot: 'push',  lift: 'Bench Press',  e1rm: 300 },
  { slot: 'pull',  lift: 'Barbell Row',  e1rm: 280 },
]

// ---- 1. balanced means balanced --------------------------------------------

const even = readBalance(inProportion)
eq(even.weakest, null, 'a lifter in proportion has no weak chain')
ok(even.reason !== null, 'and is told why there is no finding, rather than shown nothing')
ok(even.chains.every((c) => c.state === 'even'), 'every chain reads as even')
ok(even.chains.every((c) => Math.abs(c.ratio - 1) < 0.02), 'and every ratio sits on 1.0')

// ---- 2. a real lag is found and named --------------------------------------

const weakPress = readBalance([
  ...inProportion.filter((i) => i.slot !== 'push'),
  { slot: 'push', lift: 'Bench Press', e1rm: 225 },   // 300 expected → 25% behind
])
eq(weakPress.weakest?.slot, 'push', 'the lagging chain is the one that is behind')
eq(weakPress.weakest?.lift, 'Bench Press', 'named by the lift that carried it')
ok(weakPress.weakest!.ratio < LAGGING_THRESHOLD, 'and it is under the threshold')
ok(describeGap(weakPress.weakest!).includes('behind'), 'described in the athlete\u2019s terms')
eq(weakPress.chains[0].slot, 'push', 'chains sort worst-first, so the read leads with the finding')

// ---- 3. the reference is the athlete, not the squat ------------------------
// The inversion this exists to prevent: anchor to the squat alone and a lifter
// who simply squats badly reads as though every OTHER lift were ahead.

const weakSquat = readBalance([
  { slot: 'squat', lift: 'Back Squat',  e1rm: 300 },   // the lagging one
  { slot: 'hinge', lift: 'Deadlift',    e1rm: 480 },
  { slot: 'push',  lift: 'Bench Press', e1rm: 300 },
  { slot: 'pull',  lift: 'Barbell Row', e1rm: 280 },
])
eq(weakSquat.weakest?.slot, 'squat', 'a weak squat is found as the weak chain')
ok(weakSquat.chains.filter((c) => c.state === 'leading').length <= 2,
  'and does NOT make every other lift read as ahead')

// ---- 4. scale-invariance ----------------------------------------------------
// The finding is about proportion, so it must not change with absolute strength
// or with the unit the numbers happen to be in.

const halved = readBalance(inProportion.map((i) => ({ ...i, e1rm: i.e1rm / 2 })))
eq(halved.weakest, null, 'a lifter half as strong but equally balanced still has no weak chain')
const inKilos = readBalance([
  ...inProportion.filter((i) => i.slot !== 'push').map((i) => ({ ...i, e1rm: i.e1rm / 2.2046 })),
  { slot: 'push' as const, lift: 'Bench Press', e1rm: 225 / 2.2046 },
])
eq(inKilos.weakest?.slot, 'push', 'the same lifter in kilos gets the same finding')

// ---- 5. not enough to say anything -----------------------------------------

const one = readBalance([{ slot: 'squat', lift: 'Back Squat', e1rm: 400 }])
eq(one.weakest, null, 'one lift produces no finding')
eq(one.chains.length, 0, 'and no chains')
ok(one.reason!.length > 0, 'and says why — one lift is not a ratio')

eq(readBalance([]).chains.length, 0, 'nothing in, nothing out')
ok(readBalance([]).reason !== null, 'and still an explanation')
eq(readBalance([{ slot: 'squat', lift: 'S', e1rm: 0 }, { slot: 'push', lift: 'B', e1rm: 300 }]).chains.length, 0,
  'a zero e1RM is not a measurement')

// The heaviest lift wins a slot the athlete trains twice.
const dupes = readBalance([
  { slot: 'squat', lift: 'Back Squat',  e1rm: 400 },
  { slot: 'squat', lift: 'Front Squat', e1rm: 300 },
  { slot: 'push',  lift: 'Bench Press', e1rm: 300 },
])
eq(dupes.chains.find((c) => c.slot === 'squat')?.lift, 'Back Squat',
  'the heaviest lift represents its slot')
eq(dupes.chains.length, 2, 'and the slot appears once')

// ---- 6. the constants are the ordinary coaching numbers ---------------------

eq(EXPECTED_VS_SQUAT.squat, 1, 'the squat is the reference ratio')
ok(EXPECTED_VS_SQUAT.hinge > 1, 'a deadlift is expected above the squat')
ok(EXPECTED_VS_SQUAT.push < 1, 'a bench below it')
ok(LAGGING_THRESHOLD < 1 && LEADING_THRESHOLD > 1, 'the thresholds straddle parity')
ok(labelForSlot('hinge').length > 0, 'every slot has a human label')

// ---- report -----------------------------------------------------------------

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} balance checks failed:`)
  fails.forEach((f) => console.error(`  · ${f}`))
  process.exit(1)
}
console.log(`✓ all ${checks} balance checks passed`)
