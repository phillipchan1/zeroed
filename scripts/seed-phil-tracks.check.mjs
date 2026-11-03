// Run: node --experimental-strip-types scripts/seed-phil-tracks.check.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refuseReason, seedSql } from './seed-phil-tracks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fails = []
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) fails.push(msg)
}

const sql = seedSql()
const migration = readFileSync(join(root, 'supabase/migrations/20261103000001_tracks_v1.sql'), 'utf8')
const hand = readFileSync(join(root, 'worker/schema/tracks-v1.sql'), 'utf8')

ok(sql.includes("lower(u.email) = 'phillipchan1@gmail.com'"), 'seed targets Phil by email')
ok(!/a@example\.com|b@example\.com/.test(sql), 'seed does not mention isolation emails')
ok(!/training_max_overrides\s*=/.test(sql), 'seed never writes training_max_overrides')
ok(/ON CONFLICT \(athlete_id, name\) DO NOTHING/.test(sql), 'goals are ON CONFLICT DO NOTHING')
ok(/NOT EXISTS/.test(sql), 'tracks / rules use NOT EXISTS')
ok(!/2026-10-01/.test(sql), 'seed does not invent a Broad jump measured_on')
ok(!/INSERT INTO public\.goal_measurement/.test(sql), 'seed does not insert invented measurements')
ok(/Deadlift held/.test(sql) && /410/.test(sql), 'deadlift held target 410 stays in the seed, not the athlete row')
ok(/e->>'track_id' IS NULL/.test(sql), 'exercise reassignment is a no-op when track_id is already set')

ok(/tracks_v1/.test(migration) && /phillipchan1@gmail.com/.test(migration), 'migration still turns the flag on for Phil')
ok(!/Bench 1RM/.test(migration), 'migration no longer inserts Bench 1RM')
ok(!/INSERT INTO public.athlete_goal/.test(migration), 'migration no longer inserts athlete_goal')
ok(!/INSERT INTO public.autoreg_rule/.test(migration), 'migration no longer inserts autoreg_rule')
ok(!/COALESCE\(p\.name, 'Nov–Dec 2026'\)/.test(migration), 'migration no longer writes Phil block dates')
ok(!/Bench 1RM/.test(hand), 'hand-apply copy matches: no Phil goals')
ok(/seed-phil-tracks\.sql/.test(migration) && /seed-phil-tracks\.sql/.test(hand), 'both schema files point at the one-off script')
ok(/\\bohp\\b/.test(sql) && !/\\\\bohp\\\\b/.test(sql), 'seed uses a single-backslash \\bohp\\b')
ok(hand.includes('(\\.[0-9]+)') && !hand.includes('(\\\\.[0-9]+)'), 'hand-apply tm_override_value uses a single-backslash decimal')
ok(!/ENABLE ROW LEVEL SECURITY|CREATE POLICY|\\bGRANT\\b|get_current_athlete_id|\\bauthenticated\\b/.test(hand.replace(/--.*$/gm, '')), 'hand-apply copy has no Supabase RLS / GRANT / roles')

ok(refuseReason([], { DATABASE_URL: 'postgresql://x' }) === 'Refusing to seed without --confirm', 'runner requires --confirm')
ok(refuseReason(['--confirm'], {}) === 'Set ZEROED_SEED_DATABASE_URL (or NEON_DIRECT_URL / DATABASE_URL)', 'runner requires a URL')
ok(
  refuseReason(['--confirm'], { DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/zeroed_test' }).includes('throwaway'),
  'runner refuses the CI test URL',
)

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('seed-phil-tracks: ok')
