// Run: node --experimental-strip-types scripts/tracks-flag.check.mjs
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { athleteEmail as flagEmail, refuseReason as flagRefuse } from './enable-tracks-flag.mjs'
import { refuseReason as seedRefuse, seedSqlPath } from './seed-athlete-tracks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fails = []
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) fails.push(msg)
}

const migration = readFileSync(join(root, 'supabase/migrations/20261103000001_tracks_v1.sql'), 'utf8')
const hand = readFileSync(join(root, 'worker/schema/tracks-v1.sql'), 'utf8')
const example = readFileSync(join(root, 'scripts/seed-athlete-tracks.example.sql'), 'utf8')
const treeHint = [migration, hand, example].join('\n')

ok(!existsSync(join(root, 'supabase/seed/phil_health_import.sql')), 'phil_health_import.sql is gone')
ok(!existsSync(join(root, 'scripts/seed-phil-tracks.sql')), 'seed-phil-tracks.sql is gone')
ok(!existsSync(join(root, 'scripts/seed-phil-tracks.check.mjs')), 'seed-phil-tracks.check.mjs is gone')
ok(!existsSync(join(root, 'scripts/seed-phil-tracks.mjs')), 'seed-phil-tracks.mjs is gone')

ok(!/phillipchan1@gmail\.com/i.test(treeHint), 'schema / example files do not hardcode the personal email')
ok(!/seed-phil-tracks/.test(treeHint), 'schema files do not point at the deleted Phil seed')
ok(!/UPDATE public\.athlete[\s\S]*lower\(u\.email\)/.test(migration), 'migration does not enable the flag by email')
ok(!/UPDATE public\.athlete[\s\S]*lower\(u\.email\)/.test(hand), 'hand-apply does not enable the flag by email')
ok(/:'athlete_email'/.test(example), 'example seed binds :athlete_email')

ok(flagEmail({ ZEROED_TRACKS_FLAG_EMAIL: 'a@example.com' }) === 'a@example.com', 'flag email comes from env')
ok(flagRefuse([], { ZEROED_TRACKS_FLAG_EMAIL: 'a@example.com', DATABASE_URL: 'postgresql://x' }) === 'Refusing to write without --confirm', 'flag runner requires --confirm')
ok(flagRefuse(['--confirm'], { DATABASE_URL: 'postgresql://x' }) === 'Set ZEROED_TRACKS_FLAG_EMAIL (or ZEROED_SEED_ATHLETE_EMAIL)', 'flag runner requires an email')
ok(flagRefuse(['--confirm'], { ZEROED_TRACKS_FLAG_EMAIL: 'a@example.com' }) === 'Set ZEROED_SEED_DATABASE_URL (or NEON_DIRECT_URL / DATABASE_URL)', 'flag runner requires a URL')
ok(
  flagRefuse(['--confirm'], {
    ZEROED_TRACKS_FLAG_EMAIL: 'a@example.com',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/zeroed_test',
  }).includes('throwaway'),
  'flag runner refuses the CI test URL',
)

ok(seedRefuse([], { ZEROED_SEED_ATHLETE_EMAIL: 'a@example.com', DATABASE_URL: 'postgresql://x' }) === 'Refusing to seed without --confirm', 'seed runner requires --confirm')
ok(seedRefuse(['--confirm'], { DATABASE_URL: 'postgresql://x' }) === 'Set ZEROED_SEED_ATHLETE_EMAIL', 'seed runner requires an email')
ok(
  seedRefuse(['--confirm'], { ZEROED_SEED_ATHLETE_EMAIL: 'a@example.com' }) === 'Set ZEROED_SEED_DATABASE_URL (or NEON_DIRECT_URL / DATABASE_URL)',
  'seed runner requires a URL',
)
ok(seedSqlPath({}).endsWith('local/seed-athlete-tracks.sql'), 'default seed path is gitignored local/')
ok(
  seedRefuse(['--confirm'], {
    ZEROED_SEED_ATHLETE_EMAIL: 'a@example.com',
    DATABASE_URL: 'postgresql://x',
    ZEROED_SEED_SQL: 'scripts/does-not-exist.sql',
  }).includes('Missing'),
  'seed runner refuses when the local SQL file is missing',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('tracks-flag: ok')
