// Preview validators (G5) and methodology resolution (G3), the pure halves.
// Each validator rule fires on a synthetic case and stays silent on a clean
// week; U13 blocks without rewrite=true; unknown exercises never warn.
// Resolution: global → athlete → track overrides, the under-18 clamp, and
// every override guard. Engine defaults equal the lift model's constants.
// Synthetic exercises only.
// Run: node --experimental-strip-types worker/src/previewValidators.check.ts

import type { ExerciseTemplate } from '../../src/types/database.ts'
import {
  buildLiftModel, DELOAD_RPE_CAP, DELOAD_TM_PCT, PUSH_PCT, TM_FRACTION, type LiftSet,
} from '../../src/engine/liftModel.ts'
import { classify } from './methodology/classify.ts'
import { validateEdit, type WeekSession } from './methodology/validators.ts'
import { checkOverride, engineParams, resolveParams, specFor, strictness, type OverrideRecord } from './methodology/resolve.ts'
import { METHODOLOGY_V1 } from './methodology/v1.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const P = METHODOLOGY_V1.params
const ex = (name: string, extra: Partial<ExerciseTemplate> = {}): ExerciseTemplate => ({ name, sets: 3, reps: '5', ...extra })
const s = (key: string, dow: number | null, exercises: ExerciseTemplate[]): WeekSession => ({ key, name: key, dow, exercises })

// A clean week: warm-up → plyo → heavy → accessories → conditioning.
const lower = s('Lower', 0, [ex('Warm-up flow'), ex('Box Jump'), ex('Back Squat'), ex('Romanian Deadlift'), ex('Bike', { reps: '10 min' })])
const upper = s('Upper', 2, [ex('Bench Press'), ex('Chest-Supported Row', { superset_group: 'A1' }), ex('Overhead Press', { superset_group: 'A2', sets: 3, reps: '8' })])
const conditioning = s('Engine', 4, [ex('Assault Bike', { sets: 1, reps: '8 × 15s on / 45s off' })])
const clean = [lower, upper, conditioning]
const run = (after: WeekSession[], o: { before?: WeekSession[]; changed?: number; total?: number; rewrite?: boolean; blocked?: string[] } = {}) =>
  validateEdit({
    before: o.before ?? clean,
    after,
    params: P,
    changed: o.changed ?? 1,
    total: o.total ?? 11,
    rewrite: o.rewrite ?? false,
    blockedRegions: o.blocked ?? [],
  })

// ---- classification ----------------------------------------------------------------------
ok(classify(ex('Back Squat')).classes.has('heavy') && classify(ex('Back Squat')).classes.has('heavy_lower'), 'classify: back squat is a heavy lower compound')
ok(classify(ex('Bench Press')).classes.has('heavy_press'), 'classify: bench is a heavy press')
ok(classify(ex('Box Jump')).classes.has('plyo') && classify(ex('Box Jump')).rank === 1, 'classify: box jump is plyo, speed rank')
ok(classify(ex('Triceps Pushdown')).classes.has('triceps'), 'classify: pushdown is triceps-dominant')
ok(classify(ex('Farmer Carry')).classes.has('grip'), 'classify: farmer carry is grip-heavy')
ok(classify(ex('Assault Bike', { sets: 1, reps: '8 × 15s on / 45s off' })).classes.has('hiit'), 'classify: an interval block is HIIT')
ok(!classify(ex('Bike', { reps: '10 min' })).classes.has('hiit'), 'classify: steady bike is conditioning, not HIIT')
const unknown = classify(ex('Zorbulator Thing'))
ok(unknown.rank == null && unknown.classes.size === 0 && unknown.regions.length === 0, 'classify: an unknown exercise has no class, rank or region')

// ---- clean week is silent ------------------------------------------------------------------
const same = run(clean)
ok(same.warnings.length === 0 && same.blocked == null, 'clean: no warnings on a clean week')

// ---- U8 ------------------------------------------------------------------------------------
const badOrder = run([s('Lower', 0, [ex('Warm-up flow'), ex('Back Squat'), ex('Box Jump'), ex('Romanian Deadlift'), ex('Bike', { reps: '10 min' })]), upper, conditioning])
ok(badOrder.warnings.some((w) => w.rule === 'U8' && w.target.includes('Box Jump')), 'U8: plyo after the heavy lift warns')
ok(badOrder.blocked == null, 'U8: a warning, not a block')
const condFirst = run([s('Lower', 0, [ex('Bike', { reps: '10 min' }), ...lower.exercises.filter((e) => e.name !== 'Bike')]), upper, conditioning])
ok(condFirst.warnings.filter((w) => w.rule === 'U8').length >= 1, 'U8: conditioning before lifting warns')
const unknownAdded = run([s('Lower', 0, [...lower.exercises, ex('Zorbulator Thing')]), upper, conditioning])
ok(unknownAdded.warnings.length === 0, 'U8: an unknown exercise added at the end never warns')
const preExisting = s('Lower', 0, [ex('Back Squat'), ex('Box Jump')])
ok(run([preExisting, upper, conditioning], { before: [preExisting, upper, conditioning] }).warnings.length === 0, 'U8: a break already in the week is not repeated')

// ---- U9 ------------------------------------------------------------------------------------
const hiit = (key: string, dow: number) => s(key, dow, [ex('Assault Bike', { sets: 1, reps: '8 × 15s on / 45s off' })])
const threeHiit = run([...clean, hiit('Extra 1', 5), hiit('Extra 2', 6)])
ok(threeHiit.warnings.some((w) => w.rule === 'U9' && w.message.includes('3 sessions with HIIT')), 'U9: a third HIIT session warns')
const eve = run([lower, upper, s('Engine', 6, conditioning.exercises)])
ok(eve.warnings.some((w) => w.rule === 'U9' && w.message.includes('day before')), 'U9: HIIT the day before a heavy lower day warns (Sun → Mon wraps)')
ok(run(clean).warnings.every((w) => w.rule !== 'U9'), 'U9: silent with one HIIT session two days from heavy legs')

// ---- U10 -----------------------------------------------------------------------------------
const ss = (a: ExerciseTemplate, b: ExerciseTemplate) => run([lower, s('Upper', 2, [{ ...a, superset_group: 'B1' }, { ...b, superset_group: 'B2' }]), conditioning], { before: [lower, s('Upper', 2, [a, b]), conditioning] })
ok(ss(ex('Back Squat'), ex('Bench Press')).warnings.some((w) => w.rule === 'U10' && w.message.includes('two heavy compounds')), 'U10: two heavy compounds warn')
ok(ss(ex('Dumbbell Bench Press'), ex('Triceps Pushdown')).warnings.some((w) => w.message.includes('triceps')), 'U10: press + triceps warns')
ok(ss(ex('Box Jump'), ex('Face Pull')).warnings.some((w) => w.message.includes('plyos')), 'U10: anything + plyo warns')
ok(ss(ex('Farmer Carry'), ex('Deadlift')).warnings.some((w) => w.message.includes('grip')), 'U10: grip-heavy + deadlift warns')
ok(ss(ex('Dumbbell Bench Press'), ex('Chest-Supported Row')).warnings.length === 0, 'U10: press + pull is allowed')
const topSet = run([lower, s('Upper', 2, [ex('Bench Press', { superset_group: 'C1', target_rpe: 9 }), ex('Plank', { superset_group: 'C2' })]), conditioning])
ok(topSet.warnings.some((w) => w.rule === 'U10' && w.message.includes('straight sets')), 'U10: a top set ≥ RPE 9 in a superset warns')
const rest = run([lower, s('Upper', 2, [ex('Bench Press', { rest_s: 60 })]), conditioning])
ok(rest.warnings.some((w) => w.rule === 'U10' && w.message.includes('rest')), 'U10: main-lift rest under 2 min warns')

// ---- U13 -----------------------------------------------------------------------------------
const big = run(clean, { changed: 4, total: 11 })
ok(big.blocked?.rule === 'U13' && big.blocked.blocking === true, 'U13: 4 of 11 exercises (36%) without rewrite blocks')
ok(run(clean, { changed: 4, total: 11, rewrite: true }).blocked == null, 'U13: rewrite=true lets it through')
ok(run(clean, { changed: 3, total: 11 }).blocked == null, 'U13: 3 of 11 (27%) is a small edit')
ok(run(clean, { changed: 1, total: 2 }).blocked == null, 'U13: one exercise is always surgical')
const tighter = validateEdit({ before: clean, after: clean, params: { ...P, U13: { small_edit_max_fraction: 0.2 } }, changed: 3, total: 11, rewrite: false, blockedRegions: [] })
ok(tighter.blocked?.rule === 'U13', 'U13: the cap comes from the methodology params')

// ---- U7 red flags ----------------------------------------------------------------------------
const knee = run([s('Lower', 0, [...lower.exercises, ex('Bulgarian Split Squat')]), upper, conditioning], { blocked: ['knee'] })
ok(knee.blocked?.rule === 'U7' && knee.blocked.message.includes('knee'), 'U7: adding knee work with a knee red flag blocks')
ok(run([s('Lower', 0, [...lower.exercises, ex('Face Pull')]), upper, conditioning], { blocked: ['knee'] }).blocked == null, 'U7: work that spares the region is fine')

// ---- resolution ------------------------------------------------------------------------------
const T = 'tttttttt-0000-4000-8000-000000000001'
const ov = (path: string, value: unknown, track: string | null = null): OverrideRecord => ({ id: `${path}:${track}`, track_id: track, path, value })
const rows = [ov('U10.main_lift_rest_s', [150, 240]), ov('U10.main_lift_rest_s', [180, 300], T), ov('U9.hiit_max_per_week', 1)]
const athlete = resolveParams(METHODOLOGY_V1, rows, { minor: false })
const track = resolveParams(METHODOLOGY_V1, rows, { minor: false, trackId: T })
ok(JSON.stringify(athlete.params.U10.main_lift_rest_s) === '[150,240]' && athlete.params.U9.hiit_max_per_week === 1, 'resolve: athlete overrides apply over the global version')
ok(JSON.stringify(track.params.U10.main_lift_rest_s) === '[180,300]' && track.params.U9.hiit_max_per_week === 1, 'resolve: a track override applies over the athlete one, for that track')
ok(JSON.stringify(resolveParams(METHODOLOGY_V1, [], { minor: false }).params) === JSON.stringify(P), 'resolve: no overrides is the global version')
ok(resolveParams(METHODOLOGY_V1, [], { minor: false }).version === 'v1' && athlete.version.startsWith('v1+') && athlete.version !== track.version, 'resolve: the version names the override set')
ok(JSON.stringify(METHODOLOGY_V1.params.U10.main_lift_rest_s) === '[120,180]', 'resolve: the global version is never mutated')
const minor = resolveParams(METHODOLOGY_V1, [ov('U7.regions.knee.raised_cap', true)], { minor: true })
ok(minor.params.U5.top_single_rpe[1] === 8 && minor.params.U14.contacts_per_session.advanced[1] === 80, 'resolve: the under-18 clamp caps RPE at 8 and contacts at 80')
ok(minor.params.U7.regions.knee?.raised_cap !== true, 'resolve: a raised cap never survives for a minor')

// ---- engine defaults reproduce today's numbers --------------------------------------------------
const eng = engineParams(resolveParams(METHODOLOGY_V1, [], { minor: false }))
ok(eng.tmFraction === TM_FRACTION && eng.pushPct?.upper === PUSH_PCT.upper && eng.pushPct?.lower === PUSH_PCT.lower
  && eng.deloadTmPct === DELOAD_TM_PCT && eng.deloadRpeCap === DELOAD_RPE_CAP && eng.maxRpe == null, 'engine: v1 defaults equal the lift model constants')
const sets: LiftSet[] = [
  { date: '2026-10-19', exercise: 'Back Squat', lift: 'squat', weight: 225, reps: 5, rpe: 7, missedReps: 0, workoutId: null },
  { date: '2026-10-26', exercise: 'Back Squat', lift: 'squat', weight: 230, reps: 5, rpe: 7.5, missedReps: 0, workoutId: null },
]
const base = { lift: 'squat' as const, sets, today: '2026-11-04', prescription: { reps: '5', sets: 3, targetRpe: 8 } }
const without = buildLiftModel(base)
const withDefaults = buildLiftModel({ ...base, params: eng })
ok(without.recommendation != null && without.trainingMax != null, 'engine: the synthetic log yields a prescription')
ok(JSON.stringify(without) === JSON.stringify(withDefaults), 'engine: the default params give a byte-identical lift model')
const lowerTm = buildLiftModel({ ...base, params: { ...eng, tmFraction: 0.85 } })
ok(lowerTm.trainingMax!.value < without.trainingMax!.value, 'engine: a TM fraction override moves the training max')
const capped = buildLiftModel({ ...base, prescription: { reps: '3', sets: 3, targetRpe: 9 }, params: { ...eng, maxRpe: 8 } })
ok(capped.recommendation?.targetRpe === 8, 'engine: under 18, a target above RPE 8 is prescribed at 8')

// ---- guards -------------------------------------------------------------------------------------
const none = resolveParams(METHODOLOGY_V1, [], { minor: false })
const asMinor = resolveParams(METHODOLOGY_V1, [], { minor: true })
const check = (path: string, value: unknown, o: { minor?: boolean | null; actor?: 'athlete' | 'mcp'; now?: typeof none; trackId?: string | null; clear?: boolean; exists?: boolean } = {}) =>
  checkOverride({
    path, value, clear: o.clear ?? false, trackId: o.trackId ?? null,
    now: o.now ?? (o.minor ? asMinor : none), withoutThis: o.minor ? asMinor : none,
    minor: o.minor === undefined ? false : o.minor, actorType: o.actor ?? 'mcp', exists: o.exists ?? false,
  })
ok(!check('U99.anything', 1).ok && (check('U99.anything', 1) as { text: string }).text.includes('unknown methodology path'), 'guard: an unknown path is refused')
ok(!check('U5.top_single_rpe.hi', 9).ok, 'guard: a made-up sub-path is refused')
ok(!check('U4.tm_fraction', 'ninety').ok && !check('U4.tm_fraction', 0.5).ok, 'guard: wrong type or out of range is refused')
ok(check('U4.tm_fraction', 0.88).ok, 'guard: an in-range engine override passes')
ok(!check('U4.tm_fraction', 0.88, { trackId: T }).ok, 'guard: an athlete-scope path refuses a track')
ok(!check('U7.red_flags_block', false).ok, 'guard: red flags always block (fixed)')
ok(!check('preview_ttl_hours', 48).ok, 'guard: the 24 h preview expiry is fixed')
ok(!check('minors.max_rpe', 9).ok, 'guard: minors.max_rpe cannot go above 8')
ok(check('minors.max_rpe', 7).ok, 'guard: under-18 rules can be tightened')
const tightenedNow = resolveParams(METHODOLOGY_V1, [ov('minors.max_rpe', 7)], { minor: true })
ok(!check('minors.max_rpe', 7.5, { minor: true, now: tightenedNow }).ok, 'guard: once tightened, under-18 rules never loosen again')
ok(!check('U5.top_single_rpe', [8, 9], { minor: true }).ok, 'guard: for a minor, a looser RPE range is refused')
ok(check('U5.top_single_rpe', [7, 7.5], { minor: true }).ok, 'guard: for a minor, a stricter RPE range passes')
ok(!check('U7.regions.knee.raised_cap', true, { minor: true }).ok, 'guard: a raised pain cap is refused for a minor')
ok(!check('U7.regions.knee.raised_cap', true, { minor: null }).ok, 'guard: a raised pain cap is refused when age is unknown')
ok(check('U7.regions.knee.raised_cap', true, { minor: false }).ok, 'guard: an adult can opt one region into the raised cap')
ok(!check('U7.pain_cap', 5).ok && (check('U7.pain_cap', 5) as { text: string }).text.includes('3/10'), 'guard: the universal pain cap never goes above 3')
const flagged = resolveParams(METHODOLOGY_V1, [ov('U7.regions.knee.blocked', true)], { minor: false })
ok(!check('U7.regions.knee.raised_cap', true, { now: flagged }).ok, 'guard: no raised cap on a red-flagged region')
ok(check('U7.regions.knee.blocked', true).ok, 'guard: a coach can set a red flag')
ok(!check('U7.regions.knee.blocked', null, { now: flagged, clear: true, exists: true }).ok, 'guard: a coach cannot clear a red flag')
ok(check('U7.regions.knee.blocked', null, { now: flagged, clear: true, exists: true, actor: 'athlete' }).ok, 'guard: the athlete clears it')
ok(!check('U4.tm_fraction', 0.9).ok, 'guard: a no-op override is refused')
ok(strictness(specFor('U9.hiit_max_per_week')!, 2, 1) === -1 && strictness(specFor('U9.hiit_max_per_week')!, 2, 3) === 1, 'guard: strictness reads the direction')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('preview validators + methodology resolution: ok')
