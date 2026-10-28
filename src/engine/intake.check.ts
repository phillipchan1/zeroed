// Run: node --experimental-strip-types src/engine/intake.check.ts
import {
  EMPTY_ANSWERS,
  coachRead,
  focusOptions,
  inferPack,
  intakeSteps,
  planLanes,
  readOwnWords,
  resolveIntake,
  trainingYears,
  type IntakeAnswers,
} from './intake.ts'
import { resolveStarterPack, visibleStarterPacks } from './starterPacks.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const a = (over: Partial<IntakeAnswers>): IntakeAnswers => ({ ...EMPTY_ANSWERS, ...over })

// Focus → pack: one pack per focus, and every visible pack is reachable.
ok(inferPack(a({ focus: 'sport' })) === 'sport_sc', 'sport → sport_sc')
ok(inferPack(a({ focus: 'endurance' })) === 'hybrid', 'endurance → hybrid')
ok(inferPack(a({ focus: 'strength' })) === 'get_strong', 'strength → get_strong')
ok(inferPack(a({ focus: 'total' })) === 'chase_total', 'total → chase_total')
ok(inferPack(a({ focus: 'time' })) === 'thirty_three', 'time → thirty_three')
ok(inferPack(a({ focus: 'comeback' })) === 'layoff', 'comeback → layoff')
for (const p of visibleStarterPacks()) {
  ok(inferPack(a({ packOverride: p.id, focus: 'strength' })) === p.id, `override wins for ${p.id}`)
}
// No focus yet: lead with what they train.
ok(inferPack(a({ modalities: ['lifting', 'sport'] })) === 'sport_sc', 'no focus + sport → sport_sc')
ok(inferPack(a({ modalities: ['running'] })) === 'hybrid', 'no focus + running → hybrid')
ok(inferPack(a({ modalities: [] })) === 'get_strong', 'no focus, nothing → get_strong')

// Focus options lead with what they said they train.
const fo = focusOptions(a({ modalities: ['running', 'sport'], sport: 'Basketball' }))
ok(fo[0].id === 'sport' && fo[0].label === 'Play basketball better', 'sport option first, named')
ok(fo[1].id === 'endurance' && fo[1].label === 'Train for my running', 'endurance option second')
ok(!fo.some((o) => o.id === 'total'), 'no "hit a number" without lifting')
ok(focusOptions(a({ modalities: ['lifting'] })).some((o) => o.id === 'total'), 'lifting offers "hit a number"')
ok(focusOptions(a({ modalities: ['hyrox'] }))[0].label === 'Train for Hyrox', 'Hyrox named')

// Steps: only ask what the pack uses.
ok(intakeSteps(a({ focus: 'strength' })).join() === 'train,focus,experience,plan', 'strength: no follow-ups')
ok(intakeSteps(a({ focus: 'sport' })).join() === 'train,focus,experience,sport,plan', 'sport: sport follow-up')
ok(intakeSteps(a({ focus: 'endurance' })).join() === 'train,focus,experience,endurance,plan', 'endurance: days follow-up')
ok(intakeSteps(a({ focus: 'total' })).join() === 'train,focus,experience,lifts,plan', 'total: lifts follow-up')
ok(intakeSteps(a({ nothingYet: true, focus: 'time' })).join() === 'train,focus,plan', 'nothing yet skips experience')
ok(intakeSteps(a({ focus: 'strength', packOverride: 'sport_sc' })).includes('sport'), 'override pulls its follow-up')

// Training age: nothing yet is always 0, and years drive the existing safety ceiling.
ok(trainingYears(a({ nothingYet: true, experience: '3plus' })) === 0, 'nothing yet → 0 years')
ok(trainingYears(a({ experience: 'under1' })) === 0, 'under a year → 0')
ok(trainingYears(a({ experience: '1to3' })) === 2, '1–3 → 2')
ok(trainingYears(a({ experience: '3plus' })) === 4, '3+ → 4')
ok(trainingYears(a({})) === 0, 'unanswered → 0 (most conservative)')

// resolveIntake agrees with the pack resolver, plus the "also trains" brief.
const sportA = a({
  modalities: ['lifting', 'sport', 'running'], sport: 'Basketball', focus: 'sport',
  experience: '1to3', season: 'in', gameDays: ['Tue', 'Thu'], liftDays: 2,
})
const sportR = resolveIntake(sportA)
const sportBase = resolveStarterPack({
  id: 'sport_sc', trainingAge: 2, sessionsPick: 2,
  settings: { sport: 'Basketball', season: 'in', game_days: ['Tue', 'Thu'] },
})
ok(sportR.sessions === 2, 'sport lift days pass through')
ok(sportR.goal === sportBase.goal, 'goal unchanged from the pack')
ok(sportR.obstacle.startsWith(sportBase.obstacle), 'pack obstacle kept verbatim')
ok(sportR.obstacle.endsWith('Also trains: running.'), `also-trains brief (got ${sportR.obstacle})`)
ok(!/basketball\./i.test(sportR.obstacle.split('Also trains')[1] ?? ''), 'lead sport not repeated')

const hybridR = resolveIntake(a({ modalities: ['lifting', 'running', 'mobility'], focus: 'endurance', experience: '3plus', enduranceDays: 4 }))
ok(hybridR.id === 'hybrid' && hybridR.sessions === 3, 'hybrid keeps 3 lift days')
ok(hybridR.settings.run_days === 4, 'run days stored')
ok(hybridR.obstacle.endsWith('Also trains: running and mobility / yoga.'), `hybrid brief (got ${hybridR.obstacle})`)

const plain = resolveIntake(a({ modalities: ['lifting'], focus: 'strength', experience: '1to3' }))
ok(plain.obstacle === resolveStarterPack({ id: 'get_strong', trainingAge: 2 }).obstacle, 'lifting only: no brief added')

// Lanes: strength is the only planned lane; the rest are shown, not invented.
const lanes = planLanes(sportA, sportR)
ok(lanes[0].key === 'strength' && lanes[0].planned && lanes[0].dots === 2, 'strength lane planned, 2 dots')
ok(lanes[0].detail === '2 days a week · about 30-45 min to start', `card length verbatim (got ${lanes[0].detail})`)
ok(lanes.some((l) => l.key === 'sport' && !l.planned && l.detail === 'In-season · games Tue, Thu'), 'sport lane')
ok(lanes.some((l) => l.key === 'endurance' && !l.planned && l.detail === 'Yours'), 'run lane not invented for sport pack')
ok(planLanes(a({ modalities: ['lifting'] }), plain).length === 1, 'lifting only → one lane')

// The coach's line only quotes the resolver's numbers.
ok(coachRead(sportA, sportR) === 'Basketball leads. 2 strength days make you faster and harder to break, built around your season.', 'sport read')
ok(coachRead(a({ modalities: ['running'], focus: 'endurance' }), resolveIntake(a({ modalities: ['running'], focus: 'endurance' }))).startsWith('Running leads'), 'endurance read')
ok(coachRead(a({ focus: 'time' }), resolveIntake(a({ focus: 'time' }))) === 'Thirty minutes, three days. Every session fits the box.', 'time read')

// Own words.
const ow = readOwnWords('I lift 3x a week, run on weekends and play BJJ')
ok(ow.modalities.join() === 'lifting,running,sport', `own words modalities (got ${ow.modalities.join()})`)
ok(ow.sport === 'Combat', 'BJJ → Combat')
ok(readOwnWords('rugby and the gym').sport === 'Rugby', 'unlisted sport keeps its word')
ok(readOwnWords('peloton most mornings').modalities.join() === 'cycling', 'peloton → cycling')
ok(readOwnWords('nothing really').modalities.length === 0, 'no match → nothing')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('intake: ok')
