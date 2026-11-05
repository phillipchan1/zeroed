// Run: node --experimental-strip-types src/lib/flags.check.ts
import { arcLoadV1Enabled, coachV1Enabled, onboardingAgentV1Enabled, readAthleteFlags, skillBlocksV1Enabled, tracksV1Enabled } from './flags.ts'

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

// ---- tracks_v1: athlete row only, no build ceiling --------------------------
ok(tracksV1Enabled({}, { tracks_v1: true }, '') === true, 'tracks: athlete row on is enough (no VITE ceiling)')
ok(tracksV1Enabled({}, null, '') === false, 'tracks: missing row is off')
ok(tracksV1Enabled({}, {}, '') === false, 'tracks: empty flags is off')
ok(tracksV1Enabled({}, { tracks_v1: 'true' }, '') === false, 'tracks: a string "true" is off')
ok(tracksV1Enabled({}, { tracks_v1: false }, '') === false, 'tracks: false is the rollback')
ok(tracksV1Enabled({ DEV: true }, null, '?flag=tracks_v1') === true, 'tracks: DEV query override works without the row')
ok(tracksV1Enabled({ DEV: false }, null, '?flag=tracks_v1') === false, 'tracks: production ignores the query override')
ok(
  tracksV1Enabled({ DEV: true }, null, '?flag=arc_load_v1&flag=tracks_v1') === true,
  'tracks: a second ?flag= is read too',
)

// ---- coach_v1: athlete row only, and only with tracks_v1 ----------------------
ok(coachV1Enabled({}, { tracks_v1: true, coach_v1: true }, '') === true, 'coach: both flags on is on')
ok(coachV1Enabled({}, { coach_v1: true }, '') === false, 'coach: without tracks_v1 it is off')

// skill_blocks_v1: default off, athlete-row only, independent of tracks_v1 / coach_v1.
ok(skillBlocksV1Enabled({}, null, '') === false, 'skill: off with no flags')
ok(skillBlocksV1Enabled({}, { tracks_v1: true, coach_v1: true }, '') === false, 'skill: tracks_v1 + coach_v1 do not turn it on')
ok(skillBlocksV1Enabled({}, { skill_blocks_v1: 'true' }, '') === false, 'skill: only literal true counts')
ok(skillBlocksV1Enabled({}, { skill_blocks_v1: true }, '') === true, 'skill: the athlete row turns it on')
ok(skillBlocksV1Enabled({ DEV: false }, null, '?flag=skill_blocks_v1') === false, 'skill: production ignores the query')
ok(skillBlocksV1Enabled({ DEV: true }, null, '?flag=skill_blocks_v1') === true, 'skill: DEV query override')
ok(coachV1Enabled({}, { skill_blocks_v1: true }, '') === false && tracksV1Enabled({}, { skill_blocks_v1: true }, '') === false, 'skill on does not turn on coach_v1 or tracks_v1')
ok(coachV1Enabled({}, { tracks_v1: true }, '') === false, 'coach: tracks_v1 alone is off')
ok(coachV1Enabled({}, null, '') === false, 'coach: missing row is off')
ok(coachV1Enabled({}, { tracks_v1: true, coach_v1: 'true' }, '') === false, 'coach: a string "true" is off')
ok(coachV1Enabled({}, { tracks_v1: true, coach_v1: false }, '') === false, 'coach: false is the rollback')
ok(coachV1Enabled({ DEV: true }, null, '?flag=tracks_v1&flag=coach_v1') === true, 'coach: DEV query override with tracks_v1')
ok(coachV1Enabled({ DEV: true }, null, '?flag=coach_v1') === false, 'coach: DEV override alone still needs tracks_v1')
ok(coachV1Enabled({ DEV: false }, null, '?flag=tracks_v1&flag=coach_v1') === false, 'coach: production ignores the query override')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('flags: ok')
