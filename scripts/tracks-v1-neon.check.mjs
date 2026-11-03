// Proves worker/schema/tracks-v1.sql is Neon-safe: no Supabase roles,
// no RLS / GRANT / get_current_athlete_id(), and it applies cleanly on
// top of app.sql to a plain engine that has none of those.
//
// Run: node --experimental-strip-types scripts/tracks-v1-neon.check.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fails = []
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) fails.push(msg)
}

const tracks = readFileSync(join(root, 'worker/schema/tracks-v1.sql'), 'utf8')
const app = readFileSync(join(root, 'worker/schema/app.sql'), 'utf8')
const seed = readFileSync(join(root, 'worker/schema/preview-seed.sql'), 'utf8')
const code = tracks.replace(/--.*$/gm, '')

ok(!/ENABLE ROW LEVEL SECURITY/i.test(code), 'tracks-v1.sql has no ENABLE ROW LEVEL SECURITY')
ok(!/CREATE POLICY/i.test(code), 'tracks-v1.sql has no CREATE POLICY')
ok(!/DROP POLICY/i.test(code), 'tracks-v1.sql has no DROP POLICY')
ok(!/\bGRANT\b/.test(code), 'tracks-v1.sql has no GRANT')
ok(!/\bauthenticated\b/.test(code), 'tracks-v1.sql has no authenticated role')
ok(!/get_current_athlete_id/.test(code), 'tracks-v1.sql has no get_current_athlete_id()')
ok(!/auth\.uid\(\)/i.test(code), 'tracks-v1.sql has no auth.uid()')
ok(/CREATE TABLE IF NOT EXISTS public\.track/.test(tracks), 'tracks-v1.sql creates track IF NOT EXISTS')
ok(/ADD COLUMN IF NOT EXISTS/.test(tracks), 'tracks-v1.sql uses ADD COLUMN IF NOT EXISTS')
ok(/NOT EXISTS/.test(tracks), 'General backfill is NOT EXISTS (no-op when present)')
ok(/seed-phil-tracks\.sql/.test(tracks), 'tracks-v1.sql points at the one-off Phil seed')
ok(!/INSERT INTO public\.athlete_goal/.test(tracks), 'tracks-v1.sql does not insert personal goals')
ok(!/\\\\bohp\\\\b/.test(tracks) && !/\\\\bohp\\\\b/.test(seed), 'schema files do not double-escape \\bohp\\b')
ok(!tracks.includes('(\\\\.[0-9]+)'), 'tm_override_value does not double-escape the decimal')
ok(tracks.includes('(\\.[0-9]+)'), 'tm_override_value uses a single-backslash decimal')

ok(!/ENABLE ROW LEVEL SECURITY/i.test(app.replace(/--.*$/gm, '')), 'app.sql still has no RLS')

const db = new PGlite()
try {
  await db.exec(app)
} catch (err) {
  ok(false, `app.sql applies on plain PGlite: ${err instanceof Error ? err.message : err}`)
}

const rolesBefore = await db.query(`
  SELECT rolname FROM pg_roles
  WHERE rolname IN ('authenticated', 'anon', 'service_role')
`)
ok(rolesBefore.rows.length === 0, 'plain engine has no Supabase roles before tracks-v1')

const fnBefore = await db.query(`
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_current_athlete_id'
`)
ok(fnBefore.rows.length === 0, 'plain engine has no get_current_athlete_id()')

try {
  await db.exec(tracks)
  ok(true, 'tracks-v1.sql applies on plain PGlite after app.sql')
} catch (err) {
  ok(false, `tracks-v1.sql applies on plain PGlite after app.sql: ${err instanceof Error ? err.message : err}`)
}

try {
  await db.exec(tracks)
  ok(true, 'tracks-v1.sql reapplies as a no-op')
} catch (err) {
  ok(false, `tracks-v1.sql second apply: ${err instanceof Error ? err.message : err}`)
}

const policies = await db.query(`SELECT COUNT(*)::int AS n FROM pg_policy`)
ok(Number(policies.rows[0]?.n ?? -1) === 0, 'tracks-v1.sql created no RLS policies')

const rls = await db.query(`
  SELECT COUNT(*)::int AS n FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity
`)
ok(Number(rls.rows[0]?.n ?? -1) === 0, 'tracks-v1.sql did not enable RLS')

const rolesAfter = await db.query(`
  SELECT rolname FROM pg_roles
  WHERE rolname IN ('authenticated', 'anon', 'service_role')
`)
ok(rolesAfter.rows.length === 0, 'tracks-v1.sql does not create Supabase roles')

const decimal = await db.query(`
  SELECT
    public.tm_override_value('{"bench": {"value": "225.5"}}'::jsonb, 'bench') AS dotted,
    public.tm_override_value('{"bench": {"value": "225"}}'::jsonb, 'bench') AS whole
`)
ok(Number(decimal.rows[0]?.dotted) === 225.5, 'tm_override_value reads a decimal value')
ok(Number(decimal.rows[0]?.whole) === 225, 'tm_override_value reads a whole value')

const seeded = new PGlite()
await seeded.exec(app)
await seeded.exec(readFileSync(join(root, 'worker/schema/better-auth.sql'), 'utf8'))
await seeded.exec(seed)
const generalBefore = await seeded.query(`SELECT COUNT(*)::int AS n FROM track WHERE name = 'General'`)
await seeded.exec(tracks)
await seeded.exec(tracks)
const generalAfter = await seeded.query(`SELECT COUNT(*)::int AS n FROM track WHERE name = 'General'`)
ok(
  Number(generalBefore.rows[0]?.n) === Number(generalAfter.rows[0]?.n),
  're-applying tracks-v1.sql does not duplicate General tracks',
)

await db.close()
await seeded.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('tracks-v1-neon: ok')
