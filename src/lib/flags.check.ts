// Run: node --experimental-strip-types src/lib/flags.check.ts
import { onboardingAgentV1Enabled } from './flags.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(onboardingAgentV1Enabled({}, '') === false, 'off by default (empty env)')
ok(onboardingAgentV1Enabled({ VITE_ONBOARDING_AGENT_V1: '' }, '') === false, 'empty string env is off')
ok(onboardingAgentV1Enabled({ VITE_ONBOARDING_AGENT_V1: '0' }, '') === false, "env '0' is off")
ok(onboardingAgentV1Enabled({ VITE_ONBOARDING_AGENT_V1: 'true' }, '') === false, "env 'true' is off — only '1' counts")
ok(onboardingAgentV1Enabled({ VITE_ONBOARDING_AGENT_V1: '1' }, '') === true, "env '1' turns the flag on")
ok(
  onboardingAgentV1Enabled({ VITE_ONBOARDING_AGENT_V1: '1', DEV: false }, '?flag=nope') === true,
  "env '1' wins even in a production-shaped build",
)

ok(
  onboardingAgentV1Enabled({ DEV: true }, '?flag=onboarding_agent_v1') === true,
  'query override works when DEV is true',
)
ok(
  onboardingAgentV1Enabled({ DEV: true }, 'flag=onboarding_agent_v1') === true,
  'query override accepts a search string without ?',
)
ok(
  onboardingAgentV1Enabled({ DEV: true }, '?flag=other&x=1') === false,
  'a different ?flag= value does not turn it on',
)
ok(
  onboardingAgentV1Enabled({ DEV: false }, '?flag=onboarding_agent_v1') === false,
  'production (DEV=false) ignores the query override',
)
ok(
  onboardingAgentV1Enabled({}, '?flag=onboarding_agent_v1') === false,
  'missing DEV is treated as production and ignores the query',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('flags: ok')
