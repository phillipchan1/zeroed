// Run: node --experimental-strip-types src/engine/starterPacks.check.ts
import { estimateSessionMinutes } from './programDraft.ts'
import { validateProvisionalProgram } from './safety.ts'
import {
  STARTER_PACKS,
  BYO_PACK_VISIBLE,
  visibleStarterPacks,
  resolveDaysChip,
  resolveStarterPack,
  timeBoxSession,
  previewPackProvisional,
  type StarterPackId,
} from './starterPacks.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const ALL_IDS: StarterPackId[] = [
  'sport_sc', 'get_strong', 'chase_total', 'hybrid', 'layoff', 'thirty_three', 'byo',
]

ok(STARTER_PACKS.length === 7, 'seven pack definitions')
ok(STARTER_PACKS.map((p) => p.id).join() === ALL_IDS.join(), 'pack ids are stable and ordered')
ok(BYO_PACK_VISIBLE === false, 'BYO is hidden — editor hand-off is not clean')
ok(!visibleStarterPacks().some((p) => p.id === 'byo'), 'visible list omits BYO')
ok(visibleStarterPacks().length === 6, 'six visible packs')

const CARD = {
  sport_sc: {
    days: '2, 3 or 4 (user picks one)',
    length: 'about 30-45 min to start',
  },
  get_strong: { days: '3', length: 'about 30-45 min to start' },
  chase_total: {
    days: '4',
    length: 'about 30-45 min to start; heavy SBD after your first 4-week block',
  },
  hybrid: { days: '3 lift days', length: 'about 30-45 min' },
  layoff: { days: '3', length: 'about 30 min to start' },
  thirty_three: { days: '3', length: 'about 30 min' },
  byo: { days: '1-7 (from their plan)', length: "your plan's length; we flag sessions over 75 min" },
} as const

for (const pack of STARTER_PACKS) {
  ok(pack.days === CARD[pack.id].days, `${pack.id} days card copy is exact`)
  ok(pack.length === CARD[pack.id].length, `${pack.id} length card copy is exact`)
}

ok(resolveDaysChip('5+') === 5, '"5+" → 5')
ok(resolveDaysChip('It changes week to week') === 3, '"It changes week to week" → 3')
ok(resolveDaysChip('2-4') === 2, 'a range resolves to one integer')
ok(resolveDaysChip('2–4') === 2, 'an en-dash range resolves to one integer')
ok(resolveDaysChip(7) === 7, 'numeric 7 stays 7')
ok(resolveDaysChip(0) === 1, '0 clamps to 1')
ok(resolveDaysChip(9) === 7, '9 clamps to 7')

for (const id of ALL_IDS) {
  const sessionsPick = id === 'sport_sc' ? 4 : id === 'byo' ? '5+' : undefined
  const resolved = resolveStarterPack({
    id,
    trainingAge: 6,
    sessionsPick,
    settings: {
      sport: 'basketball',
      season: 'in',
      game_days: ['Sat'],
      squat: '315',
      bench: '225',
      deadlift: '405',
      run_days: 2,
      plan_days: 5,
    },
  })
  ok(
    Number.isInteger(resolved.sessions) && resolved.sessions >= 1 && resolved.sessions <= 7,
    `${id} sessions is an integer 1–7 (got ${resolved.sessions})`,
  )
  ok(resolved.firstPhase === 'Stability', `${id} first phase is Stability, not Sport`)
}

ok(resolveStarterPack({ id: 'get_strong', trainingAge: 0.5 }).sessions === 3, 'get_strong is 3 days')
ok(resolveStarterPack({ id: 'get_strong', trainingAge: 0.5 }).goal === 'build base strength', 'get_strong goal')
ok(resolveStarterPack({ id: 'chase_total', trainingAge: 4 }).sessions === 4, 'chase_total is 4 days')
ok(
  resolveStarterPack({
    id: 'chase_total',
    trainingAge: 4,
    settings: { squat: '315', bench: '225', deadlift: '405' },
  }).goal.includes('315') &&
    resolveStarterPack({
      id: 'chase_total',
      trainingAge: 4,
      settings: { squat: '315', bench: '225', deadlift: '405' },
    }).goal.includes('225'),
  'chase_total goal includes their lifts',
)
ok(resolveStarterPack({ id: 'hybrid', trainingAge: 3 }).sessions === 3, 'hybrid is 3 lift days')
ok(
  !/planned around your runs/i.test(resolveStarterPack({ id: 'hybrid', trainingAge: 3 }).obstacle) &&
    !/planned around your runs/i.test(resolveStarterPack({ id: 'hybrid', trainingAge: 3 }).goal),
  'hybrid never says planned around your runs',
)
ok(resolveStarterPack({ id: 'layoff', trainingAge: 8 }).sessions === 3, 'layoff is 3 days')
ok(resolveStarterPack({ id: 'thirty_three', trainingAge: 5 }).sessions === 3, 'thirty_three is 3 days')
ok(resolveStarterPack({ id: 'thirty_three', trainingAge: 5 }).timeBoxMinutes === 30, 'thirty_three time-boxes to 30')
ok(resolveStarterPack({ id: 'byo', trainingAge: 4, sessionsPick: '5+' }).sessions === 5, 'byo maps 5+ → 5')
ok(
  resolveStarterPack({ id: 'sport_sc', trainingAge: 4, sessionsPick: 2 }).sessions === 2,
  'sport_sc honors a 2-day pick',
)
ok(
  resolveStarterPack({ id: 'sport_sc', trainingAge: 4, sessionsPick: 3 }).sessions === 3,
  'sport_sc honors a 3-day pick',
)
ok(
  resolveStarterPack({ id: 'sport_sc', trainingAge: 4, sessionsPick: 4 }).sessions === 4,
  'sport_sc honors a 4-day pick',
)
ok(
  resolveStarterPack({ id: 'sport_sc', trainingAge: 4, sessionsPick: 6 }).sessions === 3,
  'sport_sc rejects a day count outside 2/3/4',
)

const layoffHi = resolveStarterPack({ id: 'layoff', trainingAge: 8 })
ok(layoffHi.effectiveTrainingAge === 1, 'layoff caps effective training age at 1')
ok(layoffHi.trainingAge === 8, 'layoff keeps the real training age')
const layoffLo = resolveStarterPack({ id: 'layoff', trainingAge: 0.4 })
ok(layoffLo.effectiveTrainingAge === 0.4, 'layoff does not raise a true novice')

const layoffPreview = previewPackProvisional({ id: 'layoff', trainingAge: 8 })
const layoffLoads = layoffPreview.design.sessions.flatMap((s) => s.exercises.map((e) => e.load))
ok(layoffLoads.length > 0, 'layoff preview has exercises')
ok(
  layoffLoads.every((l) => l === 'bodyweight' || l === 'light'),
  `layoff loads never exceed light (got ${[...new Set(layoffLoads)].join(', ')})`,
)

const long = [
  { name: 'Goblet Squat', sets: 3, reps: '10', load: 'light' },
  { name: 'Romanian Deadlift', sets: 3, reps: '10', load: 'light' },
  { name: 'Walking Lunge', sets: 3, reps: '8 each side', load: 'light' },
  { name: 'Chest-Supported Row', sets: 3, reps: '12', load: 'light' },
  { name: 'DB Press', sets: 3, reps: '10', load: 'light' },
  { name: 'Curl', sets: 3, reps: '12', load: 'light' },
]
ok(estimateSessionMinutes(long) > 30, `long fixture is over 30 (got ${estimateSessionMinutes(long)})`)
const boxed = timeBoxSession(long, 30)
ok(estimateSessionMinutes(boxed) <= 30, `timeBoxSession ≤ 30 (got ${estimateSessionMinutes(boxed)})`)
ok(boxed.length >= 3, `timeBoxSession keeps ≥ 3 exercises (got ${boxed.length})`)
ok(timeBoxSession(long.slice(0, 3), 1).length === 3, 'timeBoxSession never goes below 3')

const t33 = previewPackProvisional({ id: 'thirty_three', trainingAge: 6 })
for (const session of t33.design.sessions) {
  ok(session.exercises.length >= 3, `thirty_three ${session.name} keeps ≥ 3 exercises`)
  ok(
    estimateSessionMinutes(session.exercises) <= 30,
    `thirty_three ${session.name} estimates ≤ 30 (got ${estimateSessionMinutes(session.exercises)})`,
  )
}

for (const id of ALL_IDS) {
  const { resolved, design } = previewPackProvisional({
    id,
    trainingAge: id === 'layoff' ? 8 : 4,
    sessionsPick: id === 'sport_sc' ? 3 : undefined,
    settings: { sport: 'soccer', season: 'off', game_days: ['Sun'] },
  })
  let threw = false
  try {
    validateProvisionalProgram(design, { trainingAge: resolved.effectiveTrainingAge })
  } catch {
    threw = true
  }
  ok(!threw, `${id} first session passes validateProvisionalProgram`)
  ok(resolved.firstPhase === 'Stability', `${id} does not claim a Sport phase`)
  for (const session of design.sessions) {
    ok(
      !/\bsport\s+(phase|block|routine)\b/i.test(session.name) &&
        !/\bsport\s+(phase|block)\b/i.test(session.intent),
      `${id} ${session.name} is not a Sport-phase routine`,
    )
  }
}

const sport = previewPackProvisional({
  id: 'sport_sc',
  trainingAge: 5,
  sessionsPick: 3,
  settings: { sport: 'basketball', season: 'in', game_days: ['Fri', 'Sat'] },
})
ok(sport.resolved.settings.sport === 'basketball', 'sport_sc stores sport as a setting')
ok(sport.resolved.settings.season === 'in', 'sport_sc stores season as a setting')
ok(
  Array.isArray(sport.resolved.settings.game_days) && sport.resolved.settings.game_days.join() === 'Fri,Sat',
  'sport_sc stores game_days as a setting',
)
ok(
  !/4th 28-day|sport-specific, mixed-quality|Sport block/i.test(sport.resolved.goal) &&
    !/4th 28-day|sport-specific, mixed-quality|Sport block/i.test(sport.resolved.obstacle),
  'sport_sc does not claim the Sport block',
)
ok(
  sport.design.sessions.every((s) => s.name.startsWith('Session')),
  'sport_sc first-block sessions are A/B/C, not a Sport phase',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('starter packs: ok')
