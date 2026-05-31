// Standalone integrity check for the demand tables (no test runner installed).
// Run: node --experimental-strip-types src/engine/demandTables.check.ts
// Proves: every arena has a Move-2 question; every sport/lift/option resolves to
// a limiter in the insight vocab; classifiers map the canonical examples.

import {
  ARENA_TYPES, CATEGORY_NAMES, DEMAND_PROFILES, NUMBER_LIMITER_MAP,
  LIMITER_QUESTIONS, getDemandProfile, getLimiterQuestion, resolveLimiter,
  defaultLimiter, classifyArena, matchSport, matchLift, obstacleLimiterPrior,
  OBSTACLE_CATEGORY_HINTS,
  type SportKey, type LiftKey, type ArenaType,
} from './demandTables.ts'

const vocab = new Set<string>(CATEGORY_NAMES)
const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

function validLimiter(label: string, l: { axis: string; label: string; category: string; tilt: string }) {
  ok(!!l && !!l.axis && !!l.label && !!l.tilt, `${label}: limiter missing fields`)
  ok(vocab.has(l.category), `${label}: category "${l.category}" not in vocab`)
}

// Every arena has a question with at least 2 options.
for (const arena of ARENA_TYPES) {
  const q = getLimiterQuestion(arena)
  ok(!!q.question && q.options.length >= 2, `arena ${arena}: question/options malformed`)
}

// Sport arena: every sport profile resolves on every Move-2 axis + default.
const sportKeys: SportKey[] = Object.keys(DEMAND_PROFILES) as SportKey[]
for (const sport of sportKeys) {
  const p = getDemandProfile(sport)
  ok(!!p.discipline && !!p.energySystem && p.keyQualities.length > 0, `sport ${sport}: profile incomplete`)
  for (const opt of LIMITER_QUESTIONS.sport.options) {
    validLimiter(`sport/${sport}/${opt.axis}`, resolveLimiter({ arenaType: 'sport', sportKey: sport, optionKey: opt.axis }))
  }
  validLimiter(`sport/${sport}/default`, defaultLimiter({ arenaType: 'sport', sportKey: sport }))
}

// Number arena: every lift resolves on every Move-2 axis + default.
const liftKeys: LiftKey[] = Object.keys(NUMBER_LIMITER_MAP) as LiftKey[]
for (const lift of liftKeys) {
  for (const opt of LIMITER_QUESTIONS.number.options) {
    validLimiter(`number/${lift}/${opt.axis}`, resolveLimiter({ arenaType: 'number', liftKey: lift, optionKey: opt.axis }))
  }
  validLimiter(`number/${lift}/default`, defaultLimiter({ arenaType: 'number', liftKey: lift }))
}

// Self-resolving arenas: every option carries a valid resolution.
const selfArenas: ArenaType[] = ['body', 'durability', 'event', 'all_around']
for (const arena of selfArenas) {
  for (const opt of LIMITER_QUESTIONS[arena].options) {
    validLimiter(`${arena}/${opt.axis}`, resolveLimiter({ arenaType: arena, optionKey: opt.axis }))
  }
  validLimiter(`${arena}/default`, defaultLimiter({ arenaType: arena }))
}

// Durability "localize" refines its category from the obstacle feeder.
const localized = resolveLimiter({ arenaType: 'durability', optionKey: 'localize', obstacle: 'my left shoulder keeps flaring on bench' })
ok(localized.category === 'Upper Chain', `durability localize should refine to Upper Chain, got ${localized.category}`)

// Classifiers — canonical examples from the spec.
const arenaCases: Array<[string, ArenaType]> = [
  ['Excel at basketball', 'sport'],
  ['285 bench', 'number'],
  ['first pull-up', 'number'],
  ['Get jacked', 'body'],
  ['lean down', 'body'],
  ['Stop getting hurt', 'durability'],
  ['pain-free at 45', 'durability'],
  ['Spartan in October', 'event'],
  ['run a marathon', 'event'],
  ['Be a complete athlete', 'all_around'],
]
for (const [text, expected] of arenaCases) {
  const got = classifyArena(text)
  ok(got.type === expected, `classifyArena("${text}") → ${got.type}, expected ${expected}`)
}
ok(classifyArena('').confidence === 'low', 'empty arena text should be low-confidence')
ok(classifyArena('something vague and off-script').type === 'all_around', 'unmatched arena text should default to all_around')

ok(matchSport('excel at basketball') === 'basketball', 'matchSport basketball')
ok(matchSport('I run trail marathons') === 'endurance_run', 'matchSport endurance_run')
ok(matchSport('jiu jitsu competitor') === 'combat', 'matchSport combat')
ok(matchSport('whatever') === 'generic', 'matchSport fallback generic')
ok(matchLift('want a 285 bench') === 'bench', 'matchLift bench')
ok(matchLift('first pull-up') === 'pullup', 'matchLift pullup')
ok(matchLift('hit a big number') === 'generic', 'matchLift fallback generic')

// Obstacle prior + legacy category-only view preserved.
ok(obstacleLimiterPrior('my knee hurts in the squat')?.category === 'Lower Chain', 'obstacle prior knee → Lower Chain')
ok(obstacleLimiterPrior('') === null, 'empty obstacle → null prior')
ok(OBSTACLE_CATEGORY_HINTS.length === 6, 'legacy OBSTACLE_CATEGORY_HINTS preserved (6 rows)')
ok(OBSTACLE_CATEGORY_HINTS[0].category === 'Lower Chain' && OBSTACLE_CATEGORY_HINTS[5].category === 'Strength', 'legacy hint order preserved')

if (fails.length) {
  console.error(`✗ ${fails.length}/${checks} demand-table checks FAILED:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ all ${checks} demand-table checks passed`)
