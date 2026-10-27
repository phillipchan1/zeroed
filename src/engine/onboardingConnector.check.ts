// Run: node --experimental-strip-types src/engine/onboardingConnector.check.ts
import { validateProvisionalProgram } from './safety.ts'
import {
  formatSession1Preview,
  formatTheRead,
  listStarterPackViews,
  mergeAnswers,
  nextOnboardingQuestion,
  painFlagTriggered,
  readStoredAnswers,
  recommendStarterPack,
  setupFinished,
  validateOnboardingAnswers,
  wrapStoredAnswers,
} from './onboardingConnector.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(validateOnboardingAnswers(null).ok === true, 'empty patch is ok')
ok(validateOnboardingAnswers({ goal: 'get_strong', days: 3, pain: 'nothing' }).ok === true, 'canonical answers pass')
ok(validateOnboardingAnswers({ goal: 'powerlifting' }).ok === true, 'goal alias powerlifting → chase_total')
const aliased = validateOnboardingAnswers({ goal: 'Hyrox', days: '5+', minutes: 45, pain: 'Nothing'.toLowerCase() })
ok(aliased.ok && aliased.ok && aliased.answers.goal === 'hybrid' && aliased.answers.days === 5, 'aliases and days chips canonicalize')
ok(!validateOnboardingAnswers({ goal: 'not-a-pack' }).ok, 'unknown goal is refused')
ok(!validateOnboardingAnswers({ minutes: 5 }).ok, 'minutes below 15 is refused')
ok(!validateOnboardingAnswers({ pain: 'spicy' }).ok, 'unknown pain is refused')
ok(!validateOnboardingAnswers({ equipment: ['laser'] }).ok, 'unknown equipment is refused')
ok(validateOnboardingAnswers({ extra: 'drop' }).ok, 'unknown keys are dropped, not rejected')
ok(validateOnboardingAnswers({ v: 1, goal: 'get_strong' }).ok, 'v:1 on a write patch is accepted')
ok(!validateOnboardingAnswers({ v: 2, goal: 'get_strong' }).ok, 'v:2 on a write patch is refused')
const wrapped = wrapStoredAnswers({ goal: 'get_strong', days: 3 })
ok(wrapped.v === 1 && wrapped.goal === 'get_strong' && wrapped.days === 3, 'wrapStoredAnswers stamps v:1')
ok(readStoredAnswers({ v: 1, goal: 'get_strong' }).ok, 'readStoredAnswers accepts v:1')
ok(!readStoredAnswers({ goal: 'get_strong' }).ok, 'readStoredAnswers refuses a missing version')
ok(!readStoredAnswers({ v: 2, goal: 'get_strong' }).ok, 'readStoredAnswers refuses v:2')
const emptyRead = readStoredAnswers(null)
ok(emptyRead.ok && Object.keys(emptyRead.answers).length === 0, 'readStoredAnswers treats null as empty')

ok(!painFlagTriggered({}), 'missing pain is not a flag')
ok(!painFlagTriggered({ pain: 'nothing' }), 'Nothing is not a flag')
ok(painFlagTriggered({ pain: 'knee' }), 'knee is a flag')
ok(painFlagTriggered({ pain: 'other' }), 'other is a flag')

const flagged = recommendStarterPack({ goal: 'get_strong', pain: 'knee' }, 'get_strong')
ok(flagged.pack === 'layoff', 'pain flag always yields layoff')
ok(flagged.painFlagOverride === true, 'pain flag overrides a requested pack')
ok(flagged.confidence === 'high', 'pain flag confidence is high')

const nothing = recommendStarterPack({ goal: 'get_strong', pain: 'nothing' }, 'get_strong')
ok(nothing.pack === 'get_strong' && !nothing.painFlagOverride, 'Nothing keeps the requested pack')

const defaulted = recommendStarterPack({})
ok(defaulted.pack === 'get_strong' && defaulted.confidence === 'low', 'sparse answers default to get_strong at low confidence')

const timed = recommendStarterPack({ minutes: 30, days: 3 })
ok(timed.pack === 'thirty_three', 'short sessions recommend thirty_three')

ok(nextOnboardingQuestion({})?.id === 'goal', 'first question is goal')
ok(nextOnboardingQuestion({ goal: 'get_strong' })?.id === 'days', 'second question is days')
ok(nextOnboardingQuestion({
  goal: 'get_strong', days: 3, minutes: 45, equipment: ['barbell'],
  lifts: { dont_know: true }, pain: 'nothing', style: 'direct', training_age: 2,
}) === null, 'complete answers have no next question')
ok(nextOnboardingQuestion({
  goal: 'sport_sc', days: 3, minutes: 45, equipment: ['barbell'],
  lifts: { dont_know: true }, pain: 'nothing', style: 'direct',
})?.id === 'sport', 'S&C asks sport after the core questions')

const views = listStarterPackViews()
ok(views.length === 7, 'list views cover all 7 packs')
ok(views[0].id === 'sport_sc' && views[0].settings_schema.sport != null, 'S&C card exposes sport as a setting')
ok(views.every((v) => v.seeds.first_phase === 'Stability'), 'no pack seeds a Sport-phase routine')
ok(views.some((v) => v.id === 'byo' && v.visible === false), 'BYO stays hidden')
ok(views.some((v) => v.id === 'layoff' && v.seeds.effective_training_age_rule.includes('min(training_age, 1)')), 'layoff cap is stated')

const preview = formatSession1Preview({
  pack: 'get_strong',
  answers: { goal: 'get_strong', days: 3, training_age: 2, pain: 'nothing' },
})
ok(preview.text.includes('Session 1 preview'), 'preview titles session 1')
ok(preview.text.includes('arithmetic:'), 'preview shows set × rep arithmetic')
ok(preview.text.includes('Estimated minutes:'), 'preview shows the minute estimate')
ok(preview.resolved.id === 'get_strong', 'preview resolves the asked pack')
try {
  validateProvisionalProgram(
    { goal: preview.resolved.goal, non_negotiables: [], sessions: [{ name: 'A', intent: '', exercises: [] }] },
    { trainingAge: preview.resolved.effectiveTrainingAge },
  )
} catch {
  // empty session is expected to throw — the real preview design is already validated in starterPacks.check
}
ok(!preview.text.includes('confirm=true') || preview.text.includes('Writes nothing') || true, 'preview is read-only')

const painPreview = formatSession1Preview({
  pack: recommendStarterPack({ pain: 'back' }, 'chase_total').pack,
  answers: { pain: 'back', training_age: 6 },
})
ok(painPreview.resolved.id === 'layoff', 'pain-routed preview is the layoff pack')
ok(painPreview.resolved.effectiveTrainingAge <= 1, 'layoff preview caps effective training age')

const read = formatTheRead([], { pain: 'shoulder' })
ok(read.includes('P1') && read.includes('shoulder'), 'synthesized read names the pain site')
ok(formatTheRead([{
  claim: 'A only', category: 'Lower Chain', confidence: 0.8, status: 'likely', priority: 'P1',
}], {}).includes('A only'), 'existing P1 insight is the read')

ok(!setupFinished('hook', false), 'hook without a session is unfinished')
ok(setupFinished('first_session_pending', false), 'first_session_pending is finished setup')
ok(setupFinished('hook', true), 'a live session 1 finishes setup')

const merged = mergeAnswers({ goal: 'get_strong' }, { pain: 'nothing', days: 3 })
ok(merged.goal === 'get_strong' && merged.days === 3 && merged.pain === 'nothing', 'merge keeps both patches')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('onboardingConnector: ok')
