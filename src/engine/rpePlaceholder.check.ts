// Run: node --experimental-strip-types src/engine/rpePlaceholder.check.ts
import {
  isPlaceholderTargetRpe, mergeCoachActions, placeholderRpePreviewSection,
  proposePlaceholderRpeFixes, stampCoachTargetRpe, suggestedTargetRpe,
} from './rpePlaceholder.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(isPlaceholderTargetRpe({ name: 'OHP', target_rpe: 1 }), 'RPE 1 without a coach stamp is a placeholder')
ok(!isPlaceholderTargetRpe({ name: 'OHP', target_rpe: 1, rpe_source: 'coach' }), 'coach-stamped RPE 1 is left alone')
ok(!isPlaceholderTargetRpe({ name: 'OHP', target_rpe: 7 }), 'a real target is not a placeholder')
ok(!isPlaceholderTargetRpe({ name: 'OHP' }), 'unset target is not a placeholder (displays as —)')
ok(suggestedTargetRpe('Strength') === 8, 'Strength suggests RPE 8')
ok(suggestedTargetRpe('Stability') === 6, 'Stability suggests RPE 6')
ok(suggestedTargetRpe(null) === 7, 'no phase rounds the default 6.5 to 7')
ok(suggestedTargetRpe(null) !== 1, 'suggested RPE is never 1')

const stamped = stampCoachTargetRpe({ name: 'OHP', target_rpe: 1 }, 8)
ok(stamped.target_rpe === 8 && stamped.rpe_source === 'coach', 'stamp writes the target and the coach source')
ok(!isPlaceholderTargetRpe(stamped), 'after a stamp it is no longer a placeholder')

const actions = proposePlaceholderRpeFixes(
  [
    {
      name: 'Upper',
      exercises: [
        { name: 'Strict OHP', target_rpe: 1 },
        { name: 'Face Pull', target_rpe: 1, rpe_source: 'coach' },
        { name: 'DB Bench', target_rpe: 8 },
      ],
    },
  ],
  'Strength',
)
ok(actions.length === 1, `only the unstamped RPE 1 is proposed, got ${actions.length}`)
ok(actions[0].exercise_name === 'Strict OHP' && actions[0].set_target_rpe === 8, 'proposal is OHP → 8')
ok(actions[0].type === 'update_exercise', 'proposal is an update_exercise the athlete must approve')
ok(/placeholder/.test(actions[0].rationale), 'rationale says it is a placeholder')

const none = proposePlaceholderRpeFixes(
  [{ name: 'Upper', exercises: [{ name: 'OHP', target_rpe: 1, rpe_source: 'coach' }] }],
  'Strength',
)
ok(none.length === 0, 'coach-set RPE 1 does not generate a proposal')

const preview = placeholderRpePreviewSection(
  [{ name: 'Upper', exercises: [{ name: 'Strict OHP', target_rpe: 1 }] }],
  'Strength',
)
ok(/Suggested RPE fixes/.test(preview) && /not applied/.test(preview), 'preview section is approve-only')
ok(/Strict OHP/.test(preview) && /8/.test(preview), 'preview names the lift and the suggested RPE')
ok(placeholderRpePreviewSection([{ name: 'Upper', exercises: [{ name: 'OHP', target_rpe: 1, rpe_source: 'coach' }] }]) === '', 'coach-stamped RPE 1 is not previewed')

const merged = mergeCoachActions(actions, actions)
ok(merged.length === 1, 'merge does not duplicate the same proposal')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('rpePlaceholder: ok')
