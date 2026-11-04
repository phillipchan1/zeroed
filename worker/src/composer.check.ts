// Activity modules + composer (G6) and the intake parser (G7), pure: the
// section 4 worked example (a generic lifter with a priority strength goal
// who plays rec basketball once a week; then a half-marathon goal flips
// running to priority and flags the strength trade-off), max 2 priorities,
// never a silently dropped goal, prehab dedupe/cap/order, red-flagged
// regions never loaded, minors tightened, and determinism. Synthetic data.
// Run: node --experimental-strip-types worker/src/composer.check.ts

import { compose, composeKey, recomposeReason, weekLines, classifyGoal, type ComposeInput, type ComposedBlock } from './coach/composer.ts'
import { MODULES, MODULE_KEYS, PREHAB, SCREENS, COMPOSER_V1, moduleForSport } from './coach/modules.ts'
import { parseIntake } from './coach/intake.ts'
import { METHODOLOGY_V1 } from './methodology/v1.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const P = METHODOLOGY_V1.params
const MINORS = METHODOLOGY_V1.minors
const START = '2026-11-09' // a Monday

function base(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    start: START,
    activities: [{ id: 'act-bball', module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'in', days: [3] }],
    goals: [{ id: 'goal-squat', name: 'Back Squat 1RM', test: 'Back Squat 1RM', weight: 'priority', due_date: '2027-03-01' }],
    schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [] },
    training_age: '3to10',
    minor: false,
    age: 30,
    injuries: [],
    blocked_regions: [],
    params: P,
    minors: MINORS,
    ...over,
  }
}
const track = (b: ComposedBlock, q: string) => b.tracks.find((t) => t.quality === q)
const units = (b: ComposedBlock, kind: string) => b.week.flatMap((d) => d.units.filter((u) => u.kind === kind))
const dayOf = (b: ComposedBlock, kind: string) => b.week.filter((d) => d.units.some((u) => u.kind === kind)).map((d) => d.dow)

// ---- modules are config -------------------------------------------------------------------
ok(MODULE_KEYS.length === 5 && MODULE_KEYS.every((k) => MODULES[k].key === k), 'the 5 starter modules')
for (const k of MODULE_KEYS) {
  ok(MODULES[k].screens.every((s) => SCREENS[s]) && MODULES[k].prehab.every((p) => PREHAB[p]), `${k}: screens and prehab resolve`)
  ok(Object.keys(MODULES[k].demands).length > 0, `${k}: lists demands`)
}
ok(MODULES.endurance.standard_practice.includes('rules.polarized_easy_fraction') && MODULES.endurance.standard_practice.includes('rules.weekly_volume_increase_max'), 'endurance 80/20 and ≤10%/wk are marked standard-practice')
ok(MODULES.endurance.rules.polarized_easy_fraction === 0.8 && MODULES.endurance.rules.weekly_volume_increase_max === 0.1, 'endurance defaults: 80/20, ≤10%/wk')
ok(PREHAB.nordics.standard_practice === true && PREHAB.copenhagen.standard_practice === true && MODULES.field.standard_practice.includes('prehab.nordics'), 'soccer Nordics and Copenhagen are marked standard-practice')
ok(MODULES.court.screens.join() === 'knee_to_wall,hip_ir,single_leg_landing', 'court screens: knee-to-wall, hip IR, single-leg landing')
ok(moduleForSport('Rec basketball') === 'court' && moduleForSport('Sunday soccer') === 'field' && moduleForSport('trail running') === 'endurance', 'sport names map to modules')
ok(classifyGoal({ name: 'Half marathon', test: null }) === 'aerobic' && classifyGoal({ name: 'Bench 225', test: null }) === 'max_strength' && classifyGoal({ name: 'Vertical jump', test: null }) === 'power', 'goals classify to qualities')
ok(classifyGoal({ name: 'Row 2k', test: null }) === 'aerobic' && classifyGoal({ name: '2k erg', test: null }) === 'aerobic' && classifyGoal({ name: 'Barbell row 8RM', test: null }) === 'max_strength', 'a 2k row is aerobic; a barbell row is strength')
ok(classifyGoal({ name: 'Feel better', test: null }) === null, 'an unclassifiable goal is not guessed')

// ---- worked example, part 1: lifter + rec basketball ------------------------------------------
const one = compose(base())
ok(one.priorities.join() === 'max_strength', 'example: the strength goal is the one priority')
ok(track(one, 'max_strength')?.role === 'priority' && track(one, 'max_strength')?.engine_type === 'tm_wave', 'example: max strength is a priority tm_wave track')
ok(track(one, 'other_lifts')?.role === 'maintenance', 'example: other lifts run at maintenance')
const aero = units(one, 'aerobic')
const alac = units(one, 'alactic')
ok(aero.length === 1 && /30–40 min/.test(aero[0].label) && /120–150/.test(aero[0].label), 'example: the engine adds exactly 1 aerobic session (30–40 min, HR ~120–150)')
ok(alac.length === 1 && /8–10 × 8–10 s/.test(alac[0].label) && /50–60 s rest/.test(alac[0].label), 'example: and exactly 1 alactic session (8–10 × 8–10 s, 50–60 s rest)')
ok(track(one, 'aerobic')?.supplied_by_activities === 1 && track(one, 'alactic')?.supplied_by_activities === 1, 'example: basketball counts as 1 aerobic + 1 alactic exposure')
ok(/bike or rower/.test(aero[0].label), 'example: conditioning on bike or rower while strength is the priority (U9)')
const pw = units(one, 'power')
ok(pw.length === 1 && /6–10 × 5–10 yd/.test(pw[0].label), 'example: power is acceleration starts 6–10 × 5–10 yd')
ok(one.contacts.per_session[0] === 40 && one.contacts.per_session[1] === 80 && one.contacts.level === 'return_or_sport_week', 'example: 40–80 jump contacts, conservative because games share the week')
ok(one.prehab.items.map((i) => i.key).join() === 'knee_ankle_tolerance,hip_ir_work', 'example: prehab is the knee/ankle + hip IR set')
ok(track(one, 'change_of_direction')?.role === 'minimum' && track(one, 'change_of_direction')?.sessions_per_week === 0, 'example: change of direction is covered by the games (minimum dose)')
ok(one.trade_offs.length === 0 && !one.needs_decision, 'example: no trade-offs to decide')
ok(one.week[3].kind === 'activity' && one.week[3].activities.join() === 'Rec basketball' && one.week[3].units.length === 0, 'example: game day counts as load, nothing added on it')
const sessionDays = one.week.filter((d) => d.kind === 'session')
ok(sessionDays.length <= 4, 'example: no more training days than the hard max')
ok(one.week.every((d) => d.minutes <= 75), 'example: no session over the minutes')
ok(dayOf(one, 'lift').length === 3, 'example: 3 lifting sessions')
ok(!dayOf(one, 'lift').includes(4), 'example: no priority lift the day after the game (U9)')
for (const d of one.week) {
  const order = d.units.map((u) => u.kind)
  const rank = (k: string) => ({ power: 1, change_of_direction: 1, lift: 2, prehab: 3, aerobic: 4, alactic: 4 } as Record<string, number>)[k] ?? 0
  ok(order.every((k, i) => i === 0 || rank(order[i - 1]) <= rank(k)), `example: ${d.dow} keeps session order (U8): ${order.join(' → ')}`)
  if (d.units.some((u) => u.hiit)) {
    const next = one.week[(d.dow + 1) % 7]
    ok(!next.units.some((u) => u.kind === 'lift' && u.heavy), `example: no HIIT the day before a heavy lift (U9), day ${d.dow}`)
  }
}
ok(one.deload_week.start === '2026-12-07' && one.retest_week.start === '2026-12-14' && one.retest_week.end === '2026-12-20', 'example: deload week 5, retest week 6')
ok(one.retest_week.order[0] === 'Screens and jumps first' && one.retest_week.order.some((x) => /Back Squat 1RM: test day/.test(x)), 'example: retest order screens → priority lift (U12)')
ok(one.goals.length === 1 && one.goals[0].role === 'priority' && one.goals[0].track === 'Max strength', 'example: the goal maps to its track')
ok(one.rule_refs.includes('U2') && one.rule_refs.includes('U9') && one.rule_refs.includes('U14'), 'example: rule refs cited')
ok(weekLines(one).length === 7 && /Rec basketball \(counts as load\)/.test(weekLines(one)[3]), 'example: week lines read')

// ---- worked example, part 2: add a half-marathon goal -------------------------------------------
const halfGoal = { id: 'goal-half', name: 'Half marathon under 2:00', test: 'Half marathon', weight: 'priority' as const, due_date: '2027-01-24' }
const two = compose(base({ goals: [...base().goals, halfGoal] }))
const inter = two.trade_offs.find((t) => t.id === 'interference')
ok(!!inter && inter.chosen === null && two.needs_decision, 'half: the preview flags the strength-goal trade-off for the athlete to decide')
ok(inter?.default === 'endurance_first', 'half: the race (due first) leads by default')
ok(two.priorities.join() === 'aerobic', 'half: running becomes the priority quality')
ok(track(two, 'aerobic')?.role === 'priority' && track(two, 'aerobic')?.params.modality === 'run', 'half: aerobic is a priority run track')
ok(track(two, 'aerobic')?.params.polarized_easy_fraction === 0.8 && track(two, 'aerobic')?.params.weekly_volume_increase_max === 0.1, 'half: 80/20 and ≤10%/wk apply')
ok(track(two, 'max_strength')?.role === 'maintenance' && track(two, 'max_strength')?.engine_type === 'maintenance', 'half: lifting volume drops to maintenance')
const sq = two.goals.find((g) => g.id === 'goal-squat')
ok(!!sq && sq.role === 'maintenance' && sq.track === 'Max strength' && /not dropped/i.test(sq.note ?? ''), 'half: the strength goal is held, not dropped, and says why')
ok(two.goals.length === 2, 'half: both goals still in the block')
ok(units(two, 'aerobic').length === 3 && units(two, 'aerobic').filter((u) => u.hiit).length === 1, 'half: 3 added runs, 1 hard (80/20)')
ok(two.prehab.items.some((i) => i.key === 'calf_achilles') || two.prehab.deferred.includes('calf_achilles'), 'half: running brings calf/Achilles prehab')
ok(two.screens.some((s) => s.key === 'calf_raise_capacity'), 'half: and the endurance screens')
ok(composeKey(base()) !== composeKey(base({ goals: [...base().goals, halfGoal] })), 'half: adding a goal changes the compose key')
const picked = compose(base({ goals: [...base().goals, halfGoal], resolutions: { interference: 'strength_first' } }))
ok(picked.trade_offs[0].chosen === 'strength_first' && picked.priorities.join() === 'max_strength' && !picked.needs_decision, 'half: the athlete picks strength first → strength stays priority')
ok(picked.goals.find((g) => g.id === 'goal-half')?.role === 'maintenance', 'half: and the race is held at maintenance, not dropped')
const both = compose(base({ goals: [...base().goals, halfGoal], resolutions: { interference: 'both' } }))
ok(both.priorities.length === 2 && both.priorities.includes('aerobic') && both.priorities.includes('max_strength'), 'half: both as priorities is an option')
ok(compose(base({ goals: [...base().goals, halfGoal], resolutions: { interference: 'bogus' } })).trade_offs[0].chosen === null, 'half: an unknown pick is not a pick')

// ---- U2: max 2 priorities; never drop a goal ------------------------------------------------------
const three = compose(base({
  goals: [
    { id: 'g1', name: 'Back Squat 1RM', weight: 'priority', due_date: '2027-02-01' },
    { id: 'g2', name: 'Vertical jump', weight: 'priority', due_date: '2027-01-01' },
    { id: 'g3', name: '5-10-5 agility', weight: 'priority', due_date: null },
  ],
}))
ok(three.priorities.length === 2, 'U2: at most 2 priorities')
const cap = three.trade_offs.find((t) => t.id === 'priority_cap')
ok(!!cap && cap.options.length === 3 && cap.chosen === null && three.needs_decision, 'U2: the cap is a trade-off with every pair as an option')
ok(cap?.default === 'keep:power+max_strength', 'U2: default keeps the two due first')
ok(three.goals.length === 3 && three.goals.every((g) => g.track != null), 'U2: all three goals kept, each with a track')
ok(three.goals.find((g) => g.id === 'g3')?.role !== 'priority' && /held at maintenance/i.test(three.goals.find((g) => g.id === 'g3')?.note ?? ''), 'U2: the third is held with a note')
const pickedCap = compose(base({ goals: three.goals.map((g) => ({ id: g.id, name: g.name, weight: 'priority' as const })), resolutions: { priority_cap: 'keep:max_strength+change_of_direction' } }))
ok(pickedCap.priorities.slice().sort().join() === 'change_of_direction,max_strength', 'U2: the athlete picks the two')
const unknown = compose(base({ goals: [...base().goals, { id: 'gx', name: 'Feel better', weight: 'priority' }] }))
ok(unknown.goals.length === 2 && unknown.goals.find((g) => g.id === 'gx')?.role === 'unassigned' && unknown.warnings.some((w) => /Feel better/.test(w)), 'a goal with no quality is kept and flagged, not dropped')

// Property: across many inputs, every goal in is a goal out.
const names = ['Back Squat 1RM', 'Half marathon', 'Vertical jump', 'Pro agility', 'Deep squat mobility', 'Calf raise reps', 'Shuttle repeat sprint', 'Bench 1RM']
let dropped = 0
for (let i = 0; i < 64; i++) {
  const goals = names.filter((_, j) => ((i >> (j % 6)) & 1) === 1).slice(0, 3)
    .map((n, j) => ({ id: `p${i}-${j}`, name: n, weight: (j + i) % 2 === 0 ? 'priority' as const : 'maintenance' as const, due_date: j === 1 ? '2027-01-01' : null }))
  const acts = MODULE_KEYS.filter((_, j) => ((i >> j) & 1) === 1).map((m, j) => ({ id: `a${i}-${j}`, module: m, name: m, sessions_per_week: 1 + (j % 3), season: j % 2 ? 'off' as const : 'in' as const, days: [(j * 2 + 1) % 7] }))
  const b = compose(base({ goals, activities: acts, schedule: { days_per_week: 1 + (i % 5), minutes_per_session: 45 + (i % 4) * 15, rest_days: [6] } }))
  if (b.goals.length !== goals.length || !goals.every((g) => b.goals.some((o) => o.id === g.id))) dropped++
  if (b.priorities.length > 2) dropped++
  if (b.week.some((d) => d.kind === 'session' && d.dow === 6)) dropped++
  const before = JSON.stringify(b)
  if (JSON.stringify(compose(base({ goals, activities: acts, schedule: { days_per_week: 1 + (i % 5), minutes_per_session: 45 + (i % 4) * 15, rest_days: [6] } }))) !== before) dropped++
}
ok(dropped === 0, `64 generated inputs: no goal dropped, ≤2 priorities, rest days kept, deterministic (${dropped} bad)`)

// ---- time budget: work that doesn't fit is a trade-off, not a silent drop ---------------------
const tight = compose(base({ schedule: { days_per_week: 2, minutes_per_session: 50, rest_days: [] } }))
const tb = tight.trade_offs.find((t) => t.id === 'time_budget')
ok(!!tb && tb.chosen === null && tight.needs_decision, 'tight week: the time budget is a trade-off for the athlete')
ok(tb?.options.some((o) => o.id === 'add_day') === true, 'tight week: adding a day is an option')
const added = compose(base({ schedule: { days_per_week: 2, minutes_per_session: 50, rest_days: [] }, resolutions: { time_budget: 'add_day' } }))
ok(added.week.filter((d) => d.kind === 'session').length <= 3, 'tight week: add_day uses at most one more day')
ok(added.goals.length === 1 && added.goals[0].role === 'priority', 'tight week: the goal keeps its role')

// ---- prehab: deduped, ordered by injury history then pain, capped ---------------------------------
const multi = compose(base({
  activities: [
    { id: 'a1', module: 'court', name: 'Volleyball', sessions_per_week: 2, season: 'in', days: [1] },
    { id: 'a2', module: 'strength', name: 'Powerlifting club', sessions_per_week: 1, season: 'in', days: [5] },
    { id: 'a3', module: 'general', name: 'Gym class', sessions_per_week: 1, season: 'off', days: [] },
  ],
  injuries: [
    { region: 'shoulder', history: true, pain: null },
    { region: 'ankle', history: false, pain: 3 },
  ],
}))
const keys = multi.prehab.items.map((i) => i.key)
ok(new Set(keys).size === keys.length && !keys.filter((k) => k === 'hip_ir_work').slice(1).length, 'prehab: hip IR listed once across court and strength')
ok(['shoulder_flexion_work', 'pull_volume', 'overhead_reach_work'].includes(keys[0]), 'prehab: injury history first (shoulder)')
const ankleAt = keys.indexOf('knee_ankle_tolerance')
ok(ankleAt >= 0 && keys.slice(0, ankleAt).every((k) => PREHAB[k].regions.includes('shoulder')), 'prehab: then current pain (ankle)')
ok(multi.prehab.minutes <= COMPOSER_V1.prehab_minutes[1], 'prehab: capped at 15 min a session')
ok(multi.prehab.deferred.length > 0 && multi.warnings.some((w) => /rotate/.test(w)), 'prehab: what does not fit rotates in next block, said out loud')
ok(new Set(multi.screens.map((s) => s.key)).size === multi.screens.length && multi.screens.filter((s) => s.key === 'hip_ir').length === 1, 'screens: union, deduped')

// ---- activity load: logged sessions count, off-season weighs less -----------------------------------
const logged = compose(base({ logged_sessions_per_week: { 'act-bball': 2 } }))
ok(track(logged, 'aerobic')?.supplied_by_activities === 2 && units(logged, 'aerobic').length === 0, 'logged games count as load: 2 logged → no added aerobic')
const off = compose(base({ activities: [{ id: 'act-bball', module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'off', days: [3] }] }))
ok(off.contacts.level !== 'return_or_sport_week', 'off-season: contacts follow training age, not the sport week')

// ---- red flags: never loaded --------------------------------------------------------------------------
const flagged = compose(base({ blocked_regions: ['knee'] }))
ok(units(flagged, 'power').length === 0 && flagged.held.some((h) => /Jumps/.test(h.what) && h.regions.includes('knee')), 'red flag: no jumps for a blocked knee, held with a refer-out')
ok(!flagged.prehab.items.some((i) => PREHAB[i.key].regions.includes('knee')), 'red flag: no prehab loading the knee')
ok(flagged.warnings.some((w) => /knee is red-flagged/.test(w)), 'red flag: lower-body lifting warned (U7)')
ok(flagged.goals.length === 1, 'red flag: the goal is still there')
const runFlag = compose(base({ goals: [...base().goals, halfGoal], blocked_regions: ['achilles'], resolutions: { interference: 'endurance_first' } }))
ok(units(runFlag, 'aerobic').every((u) => u.regions.length === 0) && runFlag.warnings.some((w) => /bike or rower/.test(w)), 'red flag: running moves to bike or rower for a blocked Achilles')

// ---- minors: tightened, never loosened ------------------------------------------------------------------
const kid = compose(base({ minor: true, age: 15, activities: [], training_age: '10plus' }))
const st = track(kid, 'max_strength')!
ok((st.params.top_single_rpe as number[])[1] <= 8 && (st.params.base_rpe as number[])[1] <= 8 && st.params.max_rpe === 8, 'minor: no RPE above 8')
ok(kid.contacts.per_session[1] <= MINORS.contacts_per_session_max && kid.contacts.per_session[1] < P.U14.contacts_per_session.advanced[1], 'minor: lower contacts even at 10+ yrs')
ok(kid.retest_week.order.some((x) => /no max test under 18/.test(x)) && !kid.retest_week.order.some((x) => /RPE 10/.test(x)), 'minor: no max test in the retest week')
ok(kid.minor && kid.warnings.some((w) => /Under 18/.test(w)), 'minor: said out loud')

// ---- re-compose triggers ------------------------------------------------------------------------------
ok(recomposeReason(null, { key: 'k', today: '2026-11-10' }) === 'no_block', 'recompose: no block yet')
ok(recomposeReason({ key: 'k', end: '2026-12-20' }, { key: 'k', today: '2026-12-21' }) === 'block_boundary', 'recompose: at the block boundary')
ok(recomposeReason({ key: 'k', end: '2026-12-20' }, { key: 'k2', today: '2026-11-20' }) === 'inputs_changed', 'recompose: when an activity or goal changes')
ok(recomposeReason({ key: 'k', end: '2026-12-20' }, { key: 'k', today: '2026-11-20' }) === null, 'recompose: otherwise the block stands')

// ---- determinism ------------------------------------------------------------------------------------
ok(JSON.stringify(compose(base())) === JSON.stringify(compose(base())), 'deterministic: same input, same block')

// ---- intake -------------------------------------------------------------------------------------------
const ctx = { today: '2026-11-04', birthDateOnFile: null, params: P, minors: MINORS }
const answers = {
  birth_date: '1994-05-01',
  goals: [{ name: 'Back Squat 1RM', test: 'Back Squat 1RM', current: 275, target: 315, unit: 'lb', due_date: '2027-03-01', weight: 'priority' }],
  activities: [{ module: 'court', name: 'Rec basketball', sessions_per_week: 1, season: 'in', days: [3] }],
  schedule: { days_per_week: 4, minutes_per_session: 75, rest_days: [6], equipment: ['barbell'] },
  training_age: '3to10',
  injuries: { history: [{ region: 'ankle', note: 'sprain, healed' }], pain: [{ region: 'knee', score: 2, aggravators: 'stairs', red_flags: [] }] },
  screens: [{ key: 'knee_to_wall', value: 10, side: 'L' }],
  recovery: { sleep_hours: 7.5, stress: 2, soreness: 2 },
}
const good = parseIntake(answers, ctx)
ok(good.ok && good.stop === null && good.intake.goals.length === 1 && !good.intake.minor && good.intake.age === 32, 'intake: a clean adult intake parses')
const flagStop = parseIntake({ ...answers, injuries: { history: [], pain: [{ region: 'knee', score: 3, red_flags: ['giving_way'] }] } }, ctx)
ok(flagStop.ok && flagStop.stop !== null && flagStop.stop.regions[0].region === 'knee' && /giving way/.test(flagStop.stop.regions[0].why), 'intake: a red flag stops intake')
const painStop = parseIntake({ ...answers, injuries: { history: [], pain: [{ region: 'low_back', score: 6, red_flags: [] }] } }, ctx)
ok(painStop.ok && painStop.stop !== null, 'intake: pain above 5/10 stops intake')
const fiveOk = parseIntake({ ...answers, injuries: { history: [], pain: [{ region: 'low_back', score: 5, red_flags: [] }] } }, ctx)
ok(fiveOk.ok && fiveOk.stop === null, 'intake: 5/10 without a red flag does not stop it')
ok(!parseIntake({ ...answers, goals: [] }, ctx).ok && !parseIntake({ ...answers, goals: [1, 2, 3, 4].map((i) => ({ name: `G${i}`, weight: 'maintenance' })) }, ctx).ok, 'intake: 1–3 goals')
const kidNoConsent = parseIntake({ ...answers, birth_date: '2011-06-01' }, ctx)
ok(!kidNoConsent.ok && kidNoConsent.needs_consent === true, 'intake minor: no plan without parental consent')
const kidConsent = parseIntake({ ...answers, birth_date: '2011-06-01', parental_consent: { guardian_name: 'Sample Guardian', confirmed: true } }, ctx)
ok(kidConsent.ok && kidConsent.intake.minor && kidConsent.intake.parental_consent?.guardian_name === 'Sample Guardian', 'intake minor: consent recorded')
ok(kidConsent.ok && /no max test under 18/.test(kidConsent.intake.goals[0].test ?? '') && !/1RM/.test(kidConsent.intake.goals[0].test ?? ''), 'intake minor: a 1RM test becomes a submax rep PR')
const onFile = parseIntake({ ...answers, birth_date: '1990-01-01' }, { ...ctx, birthDateOnFile: '2012-02-02' })
ok(!onFile.ok && onFile.needs_consent === true, 'intake: a birth date on file wins (a minor cannot re-enter an adult one)')
ok(!parseIntake({ ...answers, screens: [{ key: 'knee_to_wall', value: 9 }] }, ctx).ok, 'intake: a sided screen needs its side')
ok(!parseIntake({ ...answers, schedule: { days_per_week: 9, minutes_per_session: 60, rest_days: [] } }, ctx).ok, 'intake: days a week is 1–7')

if (fails.length) {
  console.error(`${fails.length}/${checks} composer checks failed:\n- ${fails.join('\n- ')}`)
  process.exit(1)
}
console.log(`${checks} checks, 0 failed`)
console.log('composer: ok')
