// Run: node --experimental-strip-types src/engine/weakLinks.check.ts
import { canonicalLift, liftPair, pairId, ratioFor } from './liftFamilies.ts'
import { asymmetryWeakLinks, learnedRatios, liftPoints, OWN_MIN_PAIRS, pairedWeeks, ratioWeakLinks, type TrainingSession } from './weakLinks.ts'
import { readTraining } from './signals.ts'
import { e1rmFromSet } from './liftModel.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ── families ────────────────────────────────────────────────────────────────
ok(canonicalLift('db bench') === 'DB Bench Press', 'an alias resolves to the library name')
ok(canonicalLift('Paused Squat') !== 'Back Squat', 'a paused squat is not the squat')
ok(liftPair('flat db press', 'bench press') != null, 'aliases on both sides find the pair')
ok(ratioFor('DB Bench Press', 'Bench Press') === 0.4, 'the prior until learned')
ok(ratioFor('DB Bench Press', 'Bench Press', { [pairId('DB Bench Press', 'Bench Press')]: 0.37 }) === 0.37, 'the learned ratio once there')
ok(ratioFor('Bench Press', 'Back Squat') === null, 'no pair, no ratio')

// ── a log where the DB press slips against the bench ────────────────────────
function iso(day: number): string {
  return new Date(Date.UTC(2026, 6, 1) + day * 86_400_000).toISOString().slice(0, 10)
}
// The bench climbs from 300; the DB press holds 41% for ten weeks, then drops to 37%.
const sessions: TrainingSession[] = []
for (let w = 0; w < 14; w++) {
  const benchMax = 300 + w * 2
  const share = w < 10 ? 0.41 : 0.37
  const dbMax = benchMax * share
  // Sets at RPE 8, five reps: back out the load that gives the max.
  const load = (max: number) => max / (e1rmFromSet(100, 5, 8)! / 100)
  sessions.push({ date: iso(w * 7), exercises: [{ name: 'Bench Press', sets: [{ weight: load(benchMax), reps: 5, rpe: 8, done: true }] }] })
  sessions.push({ date: iso(w * 7 + 2), exercises: [{ name: 'DB Bench Press', sets: [{ weight: load(dbMax), reps: 5, rpe: 8, done: true }] }] })
}
const today = iso(13 * 7 + 3)
const pts = liftPoints(sessions)
ok(pts.length === 28, `one point per lift per session, got ${pts.length}`)
const pair = liftPair('DB Bench Press', 'Bench Press')!
ok(pairedWeeks(pts, pair).length === 14, 'every week pairs')
const links = ratioWeakLinks(pts, today)
const db = links.find((l) => l.subject === 'DB Bench Press')
ok(db != null && db.basis === 'own' && db.state === 'slipping', `the DB press slips against its own baseline, got ${JSON.stringify(db)}`)
ok(db != null && Math.round(db.expected * 100) === 41 && Math.round(db.ratio * 100) === 37, 'from 41% to 37%')
ok(db?.text.includes('shoulder stability') === true, 'with what it usually means')
const learned = learnedRatios(pts)
const own = learned[pairId('DB Bench Press', 'Bench Press')]
ok(own != null && own > 0.39 && own < 0.41, `the learned ratio shrinks toward the prior, got ${own}`)

// Too few weeks: read against the prior instead.
const short = liftPoints(sessions.slice(-6))
ok(!ratioWeakLinks(short, today).some((l) => l.basis === 'own'), `with 3 paired weeks there is no own baseline (${OWN_MIN_PAIRS} needed)`)
ok(!ratioWeakLinks(short, today).some((l) => l.subject === 'DB Bench Press'), '37% against a 40% prior is inside the 10% band')
const lowDb = liftPoints([
  { date: iso(80), exercises: [{ name: 'Bench Press', sets: [{ weight: 280, reps: 3, rpe: 8, done: true }] }] },
  { date: iso(82), exercises: [{ name: 'DB Bench Press', sets: [{ weight: 92, reps: 3, rpe: 8, done: true }] }] },
])
const prior = ratioWeakLinks(lowDb, iso(84)).find((l) => l.subject === 'DB Bench Press')
ok(prior?.basis === 'prior' && prior.state === 'low', `a DB press at 33% of the bench reads low against the prior, got ${JSON.stringify(prior)}`)
ok(Object.keys(learnedRatios(short)).length === 0, 'and learns nothing yet')

// ── sides ───────────────────────────────────────────────────────────────────
const sides = asymmetryWeakLinks([
  { name: 'Hip IR L', side: 'L', current: 30, direction: 'higher' },
  { name: 'Hip IR R', side: 'R', current: 38, direction: 'higher' },
  { name: 'Ankle L', side: 'L', current: 10, direction: 'higher' },
  { name: 'Ankle R', side: 'R', current: 10.5, direction: 'higher' },
])
ok(sides.length === 1 && sides[0].subject === 'Hip IR L', 'a 21% gap is flagged; a 5% gap is not')

// ── the combined read ───────────────────────────────────────────────────────
const read = readTraining(sessions, today, [])
ok(read.weak_links[0]?.subject === 'DB Bench Press', 'the biggest weak link leads')
ok(read.lifts.some((l) => l.lift === 'Bench Press'), 'latest lifts ride along')

// Interference: conditioning up, strength flat.
const inter: TrainingSession[] = []
for (let d = 0; d < 42; d += 2) {
  const recent = d >= 21
  inter.push({
    date: iso(100 + d),
    session_rpe: 7,
    duration_mins: recent ? 60 : 30,
    exercises: [
      { name: 'Back Squat', sets: [{ weight: 300, reps: 3, rpe: 8, done: true }] },
      { name: 'Assault Bike', sets: [{ duration: 20, done: true }] },
    ],
  })
}
const sig = readTraining(inter, iso(142), [])
ok(sig.signals.some((s) => s.kind === 'interference'), `doubling conditioning with a flat squat raises interference, got ${sig.signals.map((s) => s.kind)}`)

// Transfer: squat up, jump flat.
const tr: TrainingSession[] = []
for (let d = 0; d < 42; d += 3) {
  tr.push({
    date: iso(200 + d),
    exercises: [
      { name: 'Back Squat', sets: [{ weight: 280 + d * 1.5, reps: 3, rpe: 8, done: true }] },
      { name: 'Broad Jump', sets: [{ distance: 100, done: true }] },
    ],
  })
}
ok(readTraining(tr, iso(242), []).signals.some((s) => s.kind === 'transfer'), 'a squat climbing over a flat jump raises transfer')

// Fatigue: low-readiness days run under.
const fat: TrainingSession[] = []
for (let d = 0; d < 28; d += 2) {
  const low = d % 8 === 0
  fat.push({ date: iso(300 + d), readiness: low ? 3 : 8, exercises: [{ name: 'Bench Press', sets: [{ weight: low ? 230 : 250, reps: 3, rpe: 8, done: true }] }] })
}
ok(readTraining(fat, iso(328), []).signals.some((s) => s.kind === 'fatigue'), 'low-readiness days running 8% under raise fatigue')

// Engine: fade improves.
const eng: TrainingSession[] = []
const fades = [[22, 17], [22, 18], [22, 19], [22, 20.5]]
fades.forEach(([a, b], i) => eng.push({
  date: iso(400 + i * 7),
  exercises: [{ name: 'Assault Bike', sets: [a, (a + b) / 2, b].map((o) => ({ duration: 20, output: o, output_unit: 'cal', done: true })) }],
}))
ok(readTraining(eng, iso(425), []).signals.some((s) => s.kind === 'engine' && s.text.includes('improving')), 'a shrinking fade reads as a better engine')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('weak links + signals: ok')
