// Run: node --experimental-strip-types src/lib/flags.check.ts
import { arcLoadV1Enabled, onboardingAgentV1Enabled, readAthleteFlags } from './flags.ts'

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

// ---- arc_load_v1: build ceiling AND the athlete's row ----------------------
const ON = { arc_load_v1: true }
ok(arcLoadV1Enabled({}, ON, '') === false, 'arc: off without the build ceiling, even when the athlete row says on')
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: '1' }, null, '') === false, 'arc: ceiling alone is off (no athlete flags)')
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: '1' }, {}, '') === false, 'arc: ceiling alone is off (empty flags)')
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: '1' }, ON, '') === true, 'arc: ceiling + athlete flag is on')
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: 'true' }, ON, '') === false, "arc: only ceiling '1' counts")
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: '1' }, { arc_load_v1: 'true' }, '') === false, 'arc: a string "true" in the row is off')
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: '1' }, { arc_load_v1: false }, '') === false, 'arc: false in the row is the rollback')
ok(arcLoadV1Enabled({ VITE_ARC_LOAD_V1: '1' }, '{"arc_load_v1":true}', '') === false, 'arc: an unparsed JSON string is off')
ok(arcLoadV1Enabled({ DEV: true }, null, '?flag=arc_load_v1') === true, 'arc: DEV query override works without the row')
ok(arcLoadV1Enabled({ DEV: false }, null, '?flag=arc_load_v1') === false, 'arc: production ignores the query override')
ok(
  arcLoadV1Enabled({ DEV: true }, null, '?flag=onboarding_agent_v1&flag=arc_load_v1') === true,
  'arc: a second ?flag= is read too',
)
ok(
  onboardingAgentV1Enabled({ DEV: true }, '?flag=arc_load_v1&flag=onboarding_agent_v1') === true,
  'onboarding: still read when it is the second ?flag=',
)
ok(Object.keys(readAthleteFlags([true])).length === 0, 'readAthleteFlags: an array is no flags')
ok(readAthleteFlags({ a: true, b: 1, c: 'yes' }).a === true && Object.keys(readAthleteFlags({ a: true, b: 1 })).length === 1,
  'readAthleteFlags: only literal true survives')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('flags: ok')
