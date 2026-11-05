// Run: node --experimental-strip-types src/engine/capacity.check.ts
import { goalCapacity, goalMarks, goalRead, goalTestReason, measurementTier, STALE_DAYS } from './capacity.ts'
import { formatEvidenceNote, parseEvidenceTier, strengthEvidence, noteExercise } from './evidence.ts'
import type { GoalMeasurement } from './goals.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ── evidence notes round-trip ────────────────────────────────────────────────
ok(parseEvidenceTier(formatEvidenceNote('Bench Press', { tier: 'estimate', detail: '285×3 @8' })) === 'estimate', 'estimate round-trips')
ok(parseEvidenceTier(formatEvidenceNote('Bench Press', { tier: 'strong', detail: '295×2 @8' })) === 'strong', 'strong round-trips')
ok(parseEvidenceTier(formatEvidenceNote('Bench Press', { tier: 'inferred', detail: '110×5 @8' }, 'DB Bench Press')) === 'inferred', 'inferred round-trips with its source')
ok(parseEvidenceTier('Bench Press') === null, 'a bare old note has no tier')
ok(noteExercise('Bench Press — 285×3 @8 · estimate') === 'Bench Press' && noteExercise('Strict Press') === 'Strict Press', 'the exercise reads back')
ok(measurementTier({ source: 'workout_log', note: 'Bench Press' }, true) === 'estimate', 'an old session note on a rolling goal was an estimate')
ok(measurementTier({ source: 'workout_log', note: 'Broad Jump' }, false) === 'tested', 'an old session note on a best goal was a mark')
ok(measurementTier({ source: 'manual', note: null }, true) === 'tested', 'a hand-logged number is a test')

// ── strength evidence ───────────────────────────────────────────────────────
ok(strengthEvidence([{ weight: 300, reps: 12, rpe: 9, done: true }]) === null, 'twelve reps is past what an estimate trusts')
ok(strengthEvidence([{ weight: 300, reps: 1, done: true }])?.tier === 'tested', 'an unrated single is what was lifted: tested')
ok(strengthEvidence([{ weight: 300, reps: 1, rpe: 8, done: true }])?.tier === 'estimate', 'a single @8 is an estimate of more')

// ── capacity ────────────────────────────────────────────────────────────────
const today = '2026-11-05'
const bench = { direction: 'higher', target: 315, target_range_hi: null, source_metric: 'e1rm:Bench Press', cadence: null } as const
const est = (date: string, value: number, tier: 'estimate' | 'tested' | 'strong' | 'inferred' = 'estimate'): GoalMeasurement => ({
  date, value, source: 'workout_log', note: formatEvidenceNote('Bench Press', { tier, detail: 'x' }),
})
const hist = [est('2026-10-08', 290), est('2026-10-22', 300), est('2026-11-03', 296)]
const cap = goalCapacity(bench, hist, today)!
ok(cap != null && cap.value > 293 && cap.value < 300, `capacity pools recent estimates, got ${cap?.value}`)
ok(cap.tier === 'estimated' && cap.lo < cap.value && cap.hi > cap.value, 'an estimate has a range')
ok(cap.days_since === 2 && cap.points === 3, 'days since and points in window')

const withTest = [...hist, { date: '2026-11-04', value: 305, source: 'manual', note: null }]
const capT = goalCapacity(bench, withTest, today)!
ok(capT.tier === 'tested' && capT.value > cap.value, 'a fresh test leads and pulls the value up')
ok(capT.hi - capT.lo < cap.hi - cap.lo, 'a tested reading narrows the range')

const stale = goalCapacity(bench, [est('2026-09-01', 300)], today)!
ok(stale.tier === 'stale' && stale.days_since > STALE_DAYS, 'two months without evidence is stale')
ok(stale.hi - stale.lo > cap.hi - cap.lo, 'stale widens the range')
ok(goalCapacity(bench, [], today) === null, 'no evidence, no capacity')

// ── test reasons ────────────────────────────────────────────────────────────
ok(goalTestReason(bench, cap, { passive: true, today }) === null, 'a passive goal with fresh evidence needs no test')
ok(goalTestReason(bench, stale, { passive: true, today })?.code === 'stale', 'a stale passive goal asks for a rated set')
ok(goalTestReason(bench, null, { passive: true, today })?.text.includes('Bench Press') === true, 'no evidence: the first session sets it')
const pastEst = goalCapacity(bench, [est('2026-10-30', 318), est('2026-11-03', 320)], today)!
ok(goalTestReason(bench, pastEst, { passive: true, today })?.code === 'confirm', 'an estimate past the target asks to confirm')
const mob = { direction: 'higher', target: 40, target_range_hi: null, source_metric: 'test', cadence: 'biweekly' } as const
const mobCap = goalCapacity(mob, [{ date: '2026-10-10', value: 35, source: 'manual' }], today)!
ok(goalTestReason(mob, mobCap, { passive: false, today })?.code === 'cadence', 'a manual measurement past its cadence is due')
ok(goalTestReason(mob, goalCapacity(mob, [{ date: '2026-11-01', value: 35, source: 'manual' }], today), { passive: false, today }) === null, 'inside its cadence it is not')

// ── the read the app shows ──────────────────────────────────────────────────
const fields = { name: 'Bench', metric: 'e1rm', unit: 'lb', due_date: '2027-01-15', ...bench }
ok(goalRead({ ...fields, current: 320 }, [est('2026-10-30', 318), est('2026-11-03', 320)], today).display === 'confirm', 'an estimate at the target shows To confirm, not Zeroed')
ok(goalRead({ ...fields, current: 320 }, [est('2026-10-30', 318), est('2026-11-03', 320, 'strong')], today).display === 'zeroed', 'strong evidence at the target is Zeroed')
ok(goalRead({ ...fields, current: 320 }, [est('2026-10-30', 318), { date: '2026-11-03', value: 320, source: 'manual' }], today).display === 'zeroed', 'a logged test at the target is Zeroed')
ok(goalRead({ ...fields, current: 296 }, hist, today).display !== 'needs_test', 'a passive goal with sessions writing to it never just needs a test')
ok(goalRead({ ...fields, current: null }, [], today).display === 'needs_test', 'no evidence yet still says so')
const oldStyle = { name: 'Broad', metric: 'distance', unit: 'in', direction: 'higher', target: 100, current: 101, source_metric: null, due_date: null, cadence: 'weekly' }
ok(goalRead(oldStyle, [{ date: '2026-11-01', value: 101, source: 'workout_log', note: 'Broad Jump' }], today).display === 'zeroed', 'a best-kind mark at the target is still Zeroed')

// ── marks the row stores ────────────────────────────────────────────────────
const marks = goalMarks({ ...bench, baseline: null }, [...hist, est('2026-11-04', 330, 'inferred')], today)!
ok(marks.best === 300, `an inferred reading never sets a best, got ${marks.best}`)
ok(marks.baseline === 290, 'baseline is the first reading')
ok(marks.current < 310 && marks.current > 290, `current is the pooled capacity, got ${marks.current}`)
const bestKind = goalMarks({ direction: 'higher', target: 100, target_range_hi: null, baseline: 90, source_metric: 'distance:Broad Jump' }, [
  { date: '2026-10-01', value: 95, source: 'workout_log' }, { date: '2026-11-01', value: 98, source: 'workout_log' },
], today)!
ok(bestKind.current === 98 && bestKind.best === 98 && bestKind.baseline === 90, 'a best kind keeps latest, best and stored baseline')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('capacity: ok')
