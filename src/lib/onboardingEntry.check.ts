// Run: node --experimental-strip-types src/lib/onboardingEntry.check.ts
import { ONBOARDING_FUNNEL_STEPS } from '../types/database.ts'
import { resolveOnboardingEntry } from './onboardingEntry.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// Flag-off parity: every existing funnel step resolves to itself — today's
// OnboardingRouter mapping, byte-for-byte.
for (const step of ONBOARDING_FUNNEL_STEPS) {
  const got = resolveOnboardingEntry({
    flagOn: false,
    user: { id: 'u1' },
    athlete: { onboarding_step: step },
  })
  ok(got === step, `flag off + ${step} → ${step} (got ${got})`)
}

ok(
  resolveOnboardingEntry({ flagOn: false, user: null, athlete: null }) === 'hook',
  'flag off, signed out, no athlete → hook',
)
ok(
  resolveOnboardingEntry({
    flagOn: false,
    user: null,
    athlete: { onboarding_step: 'orientation' },
  }) === 'hook',
  'flag off, signed out, stale athlete → hook (matches today)',
)
ok(
  resolveOnboardingEntry({ flagOn: false, user: { id: 'u1' }, athlete: null }) === 'bootstrap',
  'flag off, signed in, no athlete → bootstrap',
)
ok(
  resolveOnboardingEntry({
    flagOn: false,
    user: { id: 'u1' },
    athlete: { onboarding_step: 'first_session_pending' },
  }) === 'loop',
  'flag off, loop step → loop',
)

ok(
  resolveOnboardingEntry({ flagOn: true, user: null, athlete: null }) === 'pack_picker',
  'flag on, signed out → pack picker',
)
ok(
  resolveOnboardingEntry({
    flagOn: true,
    user: { id: 'u1' },
    athlete: { onboarding_step: 'hook' },
  }) === 'pack_picker',
  'flag on, authed hook → pack picker',
)
ok(
  resolveOnboardingEntry({
    flagOn: true,
    user: { id: 'u1' },
    athlete: { onboarding_step: 'orientation' },
  }) === 'orientation',
  'flag on leaves orientation alone (mid-flow / post-pack)',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('onboarding entry: ok')
