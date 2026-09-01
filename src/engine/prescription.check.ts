// Standalone integrity check for the prescription rules (no test runner
// installed, same convention as demandTables.check.ts / programDraft.check.ts).
// Run: node --experimental-strip-types src/engine/prescription.check.ts
//
// These are the numbers that decide whether an athlete's bench goes up. They
// were wrong in four independent ways at once, each individually plausible, and
// nothing in the repo could exercise them. So: prove the properties directly.
//
//   · a Strength block trained AT its own prescribed effort earns load
//   · "Hard" is effort, not injury — it can't trigger a deload by itself
//   · a lift logged at its target RPE holds its weight instead of dropping
//   · a limiter only caps the chain it actually concerns
//   · a limiter the system stopped believing in stops capping anything
//   · a clearance test can be passed, and pain reconfirms instead

import {
  rpeContract, DEFAULT_RPE_CONTRACT,
  tallyWeek, decidePrescription,
  autoregulateDelta, recommendedLoad, roundLoad, maxUpFor,
  advanceStatus, addressesLimiter, capIsActive, isLiftHeld,
  clearanceTestOf, pickClearanceLift, describeClearanceTest, newClearanceTest, judgeClearanceSession,
  P1_RESOLVE_THRESHOLD,
  type WeekWorkout, type WeekObservation, type LiftAttempt,
} from './prescription.ts'
import type { ExerciseTemplate, InsightRow, SetLog, ClearanceTest } from '../types/database.ts'
import { unitContext } from '../lib/units.ts'

// Both units supplied explicitly, so this stays pure — no localStorage, no browser.
const LB = unitContext('lb', 'lb')
const KG = unitContext('kg', 'kg')
const KG_ON_LB = unitContext('kg', 'lb')   // a kg athlete reading lb-stored history

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

// ---- fixtures ---------------------------------------------------------------

const set = (weight: number, reps: number, rpe: number | null): SetLog =>
  ({ set: 1, weight, reps, rpe, done: true })

function week(rpes: number[], done = 3): WeekWorkout[] {
  return Array.from({ length: done }, (_, i) => ({
    performed_at: `2026-08-0${i + 1}`,
    rpe: null,
    actual_weights: { '0': rpes.map((r) => set(225, 5, r)) },
  }))
}
const obs = (severity: number, signal = 'Bench Press — Hard'): WeekObservation =>
  ({ severity, signal, logged_at: '2026-08-01' })

const insight = (over: Partial<InsightRow> = {}): InsightRow => ({
  id: 'i1', athlete_id: 'a1', source_id: null, claim: 'Shoulder', category: 'Upper Chain',
  priority: 'P1', confidence: 0.55, status: 'likely', evidence: [], source: 'probe',
  program_impact: null, resolved_at: null, created_at: '', updated_at: '', prev_status: null,
  ...over,
} as unknown as InsightRow)

const ex = (name: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate =>
  ({ name, sets: 4, reps: '5', ...over })

// ---- 1. the RPE contract ----------------------------------------------------

eq(rpeContract('Strength').target, 8, 'Strength targets RPE 8')
eq(rpeContract('Stability').target, 6, 'Stability targets RPE 6')
eq(rpeContract(null).target, DEFAULT_RPE_CONTRACT.target, 'no phase → legacy default')
eq(rpeContract('Nonsense').target, DEFAULT_RPE_CONTRACT.target, 'unknown phase → legacy default')

// ---- 2. a Strength block trained as written must PROGRESS --------------------
// The original bug: PROGRESS required avg RPE <= 6.5 while the block prescribed
// 7-8, so training it correctly could only ever produce HOLD or DELOAD.

const strengthWeek = tallyWeek(3, week([7, 8, 8]), [])
eq(strengthWeek.avgRPE, 7.7, 'avg RPE across the week')
eq(decidePrescription(strengthWeek, { phaseName: 'Strength' }).directive, 'PROGRESS',
  'RPE 7.7 in a Strength block earns load')
eq(decidePrescription(strengthWeek, { phaseName: 'Strength' }).load_delta_pct, 5,
  'and the load step is +5%')

// The same week in a Stability block is genuinely too hard — it must NOT progress.
eq(decidePrescription(strengthWeek, { phaseName: 'Stability' }).directive, 'DELOAD',
  'RPE 7.7 in a Stability block is over the ceiling')

// A truly excessive Strength week still deloads.
eq(decidePrescription(tallyWeek(3, week([9, 10, 9.5]), []), { phaseName: 'Strength' }).directive, 'DELOAD',
  'RPE 9.5 in a Strength block is grinding')

// Legacy behaviour is preserved exactly when no phase is known.
eq(decidePrescription(tallyWeek(3, week([6, 6.5, 6]), []), {}).directive, 'PROGRESS',
  'no phase: RPE <= 6.5 still progresses')
eq(decidePrescription(tallyWeek(3, week([8, 9, 9]), []), {}).directive, 'DELOAD',
  'no phase: RPE >= 8.5 still deloads')

// ---- 3. "Hard" is effort, not injury ----------------------------------------

const hardWeek = tallyWeek(3, week([7, 8, 8]), [obs(3), obs(3)])
eq(hardWeek.hardCount, 2, 'two Hard chips counted as hard')
eq(hardWeek.painCount, 0, 'two Hard chips are NOT pain')
eq(decidePrescription(hardWeek, { phaseName: 'Strength' }).directive, 'PROGRESS',
  'two Hard chips do not deload a strength block')

const painWeek = tallyWeek(3, week([7, 8, 8]), [obs(4, 'Bench Press — Tweak'), obs(5, 'Bench Press — Pain')])
eq(painWeek.painCount, 2, 'Tweak + Pain are pain')
eq(decidePrescription(painWeek, { phaseName: 'Strength' }).directive, 'DELOAD',
  'two real pain flags still deload')
ok(painWeek.flagged_categories.includes('Bench Press'), 'flagged categories name what hurt')
ok(!hardWeek.flagged_categories.length, 'a hard week flags nothing')

// ---- 4. the per-lift ratchet ------------------------------------------------
// Logging the RPE the block asked for must not mark the weight down.

eq(autoregulateDelta(8, 8, 0, 'PROGRESS', 15), 0, 'RPE 8 against a target of 8 → no change')
eq(autoregulateDelta(8, 7, 0, 'PROGRESS', 15), -3, 'RPE 8 against a target of 7 → the old -3%')
eq(autoregulateDelta(6, 8, 0, 'PROGRESS', 15), 6, 'an easy top set earns +6%')
eq(autoregulateDelta(9, 8, 0, 'PROGRESS', 15), -3, 'grinding still backs off')
eq(autoregulateDelta(4, 8, 0, 'PROGRESS', 5), 5, 'the phase cap clamps a big jump')
eq(autoregulateDelta(4, 8, -10, 'DELOAD', 15), -10, 'a DELOAD week is never overridden upward')
eq(maxUpFor('Stability'), 5, 'Stability banks load')
eq(maxUpFor('Strength'), 15, 'Strength lets progression run')

// Compounded over a block: the old behaviour walked 225 backwards, the new one
// holds it. This is the whole complaint, expressed as arithmetic.
let oldWay = 225
let newWay = 225
for (let w = 0; w < 4; w++) {
  oldWay = recommendedLoad(set(oldWay, 5, 8), autoregulateDelta(8, 7, 0, 'HOLD', 15), LB)!
  newWay = recommendedLoad(set(newWay, 5, 8), autoregulateDelta(8, 8, 0, 'HOLD', 15), LB)!
}
ok(oldWay <= 205, `old contract drifts down over 4 weeks (got ${oldWay})`)
eq(newWay, 225, 'the block-aware contract holds the bar where it was')

// ---- 4b. the recommendation lands in the athlete's own unit -----------------
// A recommended load is the number that goes on the bar, so it has to be racked
// in the unit the athlete loads plates in — and read off history that may have
// been stored in the other one.

eq(recommendedLoad(set(225, 5, 8), 0, LB), 225, 'repeat-the-load returns the load as lifted')
eq(recommendedLoad(set(225, 5, 8), 5, LB), 235, 'a +5% step off 225 lb racks to 235 lb')
eq(recommendedLoad(set(100, 5, 8), 5, KG), 105, 'a +5% step off 100 kg racks to 105 kg, not 5-kg-rounded nonsense')
eq(roundLoad(103.9, KG), 105, 'kg rounds on 2.5s')
eq(roundLoad(227, LB), 225, 'lb rounds on 5s')
eq(recommendedLoad(set(225, 5, 8), 0, KG_ON_LB), 102.1,
  'a kg athlete reads an lb-stored 225 as 102.1 kg, never as "225 kg"')
ok(recommendedLoad(set(225, 5, 8), 0, KG_ON_LB) !== 225,
  'switching display units never relabels a stored load')
eq(recommendedLoad(null, 5, LB), null, 'a lift with no weighted history recommends nothing')

// ---- 5. limiter scope -------------------------------------------------------

eq(addressesLimiter('Bench Press', 'Upper Chain'), true, 'bench is upper chain')
eq(addressesLimiter('Back Squat', 'Upper Chain'), false, 'a squat is not shoulder work')
eq(addressesLimiter('Romanian Deadlift', 'Posterior Chain'), true, 'RDL is posterior')
eq(addressesLimiter('Overhead Press', 'Upper Chain'), true, 'OHP is upper chain')
eq(addressesLimiter('Zercher Yoke Carry', 'Upper Chain'), false, 'a carry reads as core, not shoulder work')
eq(addressesLimiter('Jefferson Curl', 'Upper Chain'), null, 'a movement the library has never seen has no opinion')

const shoulder = insight()
const stampedBench = ex('Bench Press', { insight_id: 'i1' })
const stampedSquat = ex('Back Squat', { insight_id: 'i1' })
const unknownLift = ex('Jefferson Curl', { insight_id: 'i1' })

ok(isLiftHeld(stampedBench, shoulder, true), 'bench is held under a shoulder limiter')
ok(!isLiftHeld(stampedSquat, shoulder, true), 'squat is NOT held under a shoulder limiter')
ok(isLiftHeld(unknownLift, shoulder, true), 'an unknown stamped lift keeps its existing hold')
ok(!isLiftHeld(ex('Bench Press'), shoulder, true), 'an unstamped lift is never held')

// ---- 6. a limiter nobody believes in stops capping --------------------------

ok(capIsActive(insight({ confidence: 0.55 })), 'a live read caps load')
ok(capIsActive(insight({ confidence: P1_RESOLVE_THRESHOLD })), 'exactly at threshold still caps')
ok(!capIsActive(insight({ confidence: 0.12 })), 'a 12%-confidence read caps nothing')
ok(!capIsActive(null), 'no limiter, no cap')
ok(!isLiftHeld(stampedBench, insight({ confidence: 0.12 }), capIsActive(insight({ confidence: 0.12 }))),
  'and no lift is held by it')

// ---- 7. status moves in both directions -------------------------------------

eq(advanceStatus('hypothesis', 0.85), 'confirmed', 'strong evidence confirms')
eq(advanceStatus('hypothesis', 0.55), 'likely', 'moderate evidence promotes')
eq(advanceStatus('likely', 0.25), 'resolved', 'contrary evidence can retire a read')
eq(advanceStatus('confirmed', 0.30), 'resolved', 'even a confirmed read can be retired')
eq(advanceStatus('likely', 0.60), null, 'no threshold crossed → no change')
eq(advanceStatus('resolved', 0.90), null, 'resolved is terminal')

// ---- 8. the clearance test --------------------------------------------------

const session = [ex('Back Squat'), ex('Bench Press'), ex('Band Pull-Apart')]
eq(pickClearanceLift(session, 'Upper Chain', () => true), 'Bench Press',
  'the test picks the main upper-chain lift, not the accessory')
eq(pickClearanceLift(session, 'Lower Chain', () => true), 'Back Squat', 'lower chain picks the squat')
eq(pickClearanceLift([ex('Band Pull-Apart')], 'Lower Chain', () => true), null,
  'nothing on the chain → no test')

const test = newClearanceTest('Bench Press', 8, '2026-08-12')
ok(describeClearanceTest(test).includes('RPE 8+'), 'the requirement names the effort')
ok(describeClearanceTest(test).includes('Bench Press'), 'and the lift')

const clean: LiftAttempt[] = [{ name: 'Bench Press', qualifying: 2, pain: false }]
const thin: LiftAttempt[] = [{ name: 'Bench Press', qualifying: 1, pain: false }]
const hurt: LiftAttempt[] = [{ name: 'Bench Press', qualifying: 3, pain: true }]

ok(judgeClearanceSession(test, clean).passed, '2 qualifying sets passes the session')
ok(!judgeClearanceSession(test, thin).relevant, '1 qualifying set neither passes nor fails')
ok(judgeClearanceSession(test, hurt).painOnLift, 'pain is registered')
ok(!judgeClearanceSession(test, hurt).passed, 'and pain overrides three good sets')
eq(judgeClearanceSession(test, hurt).qualifying, 0, 'a painful session banks nothing')
ok(!judgeClearanceSession(test, []).relevant, 'a session that never trained the lift is irrelevant')

// A pushed lift can carry the proof instead of the nominated one.
const pushed: LiftAttempt[] = [
  { name: 'Bench Press', qualifying: 0, pain: false },
  { name: 'Overhead Press', qualifying: 2, pain: false },
]
eq(judgeClearanceSession(test, pushed).provedOn, 'Overhead Press',
  'the lift that actually did the work gets the credit')
ok(judgeClearanceSession(test, pushed).passed, 'and it counts')

// Two clean sessions close the test out.
let running: ClearanceTest = test
for (let i = 0; i < 2; i++) {
  const v = judgeClearanceSession(running, clean)
  running = { ...running, sessions_passed: v.passed ? running.sessions_passed + 1 : 0 }
}
ok(running.sessions_passed >= running.criterion.sessions, 'two clean sessions clear the limiter')

// clearanceTestOf reads the newest OPEN test, ignoring closed ones.
const withTests = insight({
  evidence: [
    { ...newClearanceTest('Bench Press', 8, '2026-07-01'), status: 'reconfirmed' },
    newClearanceTest('Overhead Press', 8, '2026-08-01'),
  ],
} as Partial<InsightRow>)
eq(clearanceTestOf(withTests)?.lift, 'Overhead Press', 'the open test wins over the closed one')
eq(clearanceTestOf(insight()), null, 'no evidence → no test')

// ---- report -----------------------------------------------------------------

if (fails.length) {
  console.error(`\n✗ ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✓ all ${checks} prescription checks passed`)
