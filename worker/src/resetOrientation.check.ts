// #40 QA repro: reset_athlete_orientation must stay a full reset.
// 1. Applying worker/schema/starter-pack.sql by hand on Neon must not change
//    reset_athlete_orientation(): an athlete with a workout note resets without
//    23514, and goals, measurements and autoreg rules are deleted.
// 2. The Worker data route resets fully (200, onboarding_step -> hook) on a
//    schema that lacks the starter-pack columns, same as master.
// Run: node --experimental-strip-types worker/src/resetOrientation.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { openIsolationHarness } from './isolationDb.ts'
import { executeDataQuery } from './data.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, '../schema')
const read = (f: string) => readFileSync(join(schemaDir, f), 'utf8')
const starterPackSql = read('starter-pack.sql')
const PREVIEW = '11111111-1111-4111-8111-111111111111'

ok(!/FUNCTION\s+(public\.)?reset_athlete_orientation/i.test(starterPackSql), 'starter-pack.sql does not replace reset_athlete_orientation()')
ok(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(starterPackSql), 'starter-pack.sql defines no functions')

async function neonDb(dropStarterCols: boolean) {
  const db = new PGlite()
  await db.exec(read('app.sql'))
  await db.exec(read('better-auth.sql'))
  await db.exec(read('preview-seed.sql'))
  if (dropStarterCols) {
    // An older Neon snapshot: no starter-pack columns yet.
    await db.exec(`
      ALTER TABLE public.athlete DROP CONSTRAINT IF EXISTS athlete_starter_pack_check;
      ALTER TABLE public.athlete DROP COLUMN starter_pack, DROP COLUMN starter_pack_settings, DROP COLUMN onboarding_answers;
    `)
  }
  return db
}

async function seed(db: PGlite, note: boolean) {
  const p = await db.query<{ id: string }>(`INSERT INTO program (athlete_id, goal, start_date, retest_date, status) VALUES ('${PREVIEW}','qa',CURRENT_DATE,CURRENT_DATE+28,'active') RETURNING id`)
  const r = await db.query<{ id: string }>(`INSERT INTO routine (program_id, name, session_type, exercises) VALUES ('${p.rows[0].id}','S1','strength','[]'::jsonb) RETURNING id`)
  const g = await db.query<{ id: string }>(`INSERT INTO athlete_goal (athlete_id, name, metric, direction) VALUES ('${PREVIEW}','qa goal','qa','higher') RETURNING id`)
  await db.query(`INSERT INTO goal_measurement (athlete_id, goal_id, measured_on, value) VALUES ('${PREVIEW}','${g.rows[0].id}',CURRENT_DATE,1)`)
  await db.query(`INSERT INTO autoreg_rule (athlete_id, scope_type, signal, op, action, message) VALUES ('${PREVIEW}','program','rpe','>','hold','qa')`)
  if (note) await db.query(`INSERT INTO workout_note (athlete_id, session_id, body) VALUES ('${PREVIEW}','${r.rows[0].id}','qa note')`)
  await db.query(`UPDATE athlete SET onboarding_step = 'first_session_pending' WHERE id = '${PREVIEW}'`)
}

async function remaining(db: PGlite) {
  let n = 0
  for (const t of ['workout_note', 'goal_measurement', 'athlete_goal', 'autoreg_rule', 'program']) {
    n += (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t} WHERE athlete_id = '${PREVIEW}'`)).rows[0].n
  }
  return n
}

async function sqlReset(db: PGlite): Promise<string | null> {
  const uid = (await db.query<{ u: string }>(`SELECT auth_user_id::text AS u FROM athlete WHERE id = '${PREVIEW}'`)).rows[0].u
  await db.query(`SELECT set_config('app.current_auth_user_id', '${uid}', false)`)
  try {
    await db.query(`SELECT public.reset_athlete_orientation()`)
    return null
  } catch (e) {
    return String((e as { code?: string }).code ?? (e as Error).message)
  }
}

const fnDef = async (db: PGlite) =>
  (await db.query<{ d: string }>(`SELECT pg_get_functiondef('public.reset_athlete_orientation()'::regprocedure) AS d`)).rows[0].d

for (const [label, dropCols] of [['current app.sql', false], ['older Neon (no starter-pack columns)', true]] as const) {
  for (const note of [true, false]) {
    const db = await neonDb(dropCols)
    const before = await fnDef(db)
    await db.exec(starterPackSql)
    await db.exec(starterPackSql)
    const cols = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'athlete' AND column_name IN ('starter_pack','starter_pack_settings','onboarding_answers')`)).rows[0].n
    ok(cols === 3, `${label}: starter-pack.sql x2 leaves the 3 columns`)
    ok((await fnDef(db)) === before, `${label}: starter-pack.sql leaves reset_athlete_orientation() unchanged`)
    await seed(db, note)
    const err = await sqlReset(db)
    const tag = `${label}, ${note ? 'with' : 'without'} a workout note`
    ok(err == null, `${tag}: SQL reset does not throw (got ${err})`)
    ok((await remaining(db)) === 0, `${tag}: SQL reset deletes notes, goals, measurements, autoreg rules and programs`)
    const step = (await db.query<{ s: string }>(`SELECT onboarding_step AS s FROM athlete WHERE id = '${PREVIEW}'`)).rows[0].s
    ok(step === 'hook', `${tag}: SQL reset returns onboarding_step to hook`)
    await db.close()
  }
}

// 2. Worker data route on a schema without the starter-pack columns (flag off).
const harness = await openIsolationHarness()
const sql = harness.sql
const A = '11111111-1111-1111-1111-111111111111'
await sql`ALTER TABLE athlete DROP COLUMN starter_pack CASCADE`
await sql`ALTER TABLE athlete DROP COLUMN starter_pack_settings`
await sql`ALTER TABLE athlete DROP COLUMN onboarding_answers`
await sql`UPDATE athlete SET onboarding_step = ${'first_session_pending'} WHERE id = ${A}`
await sql`INSERT INTO program (athlete_id, goal, start_date, retest_date, status) VALUES (${A}, ${'qa'}, CURRENT_DATE, CURRENT_DATE + 28, ${'active'})`
const [authA] = await sql<{ u: string }[]>`SELECT auth_user_id::text AS u FROM athlete WHERE id = ${A}`
const res = await executeDataQuery(sql, { userId: authA?.u ?? '', athleteId: A }, {
  table: 'athlete',
  op: 'rpc',
  fn: 'reset_athlete_orientation',
})
ok(res.status === 200 && res.error == null, `no starter-pack columns: data-route reset returns 200 (got ${res.status})`)
const [progs] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM program WHERE athlete_id = ${A}`
ok(progs?.n === 0, 'no starter-pack columns: data-route reset deletes programs')
const [stepA] = await sql<{ s: string }[]>`SELECT onboarding_step AS s FROM athlete WHERE id = ${A}`
ok(stepA?.s === 'hook', 'no starter-pack columns: data-route reset returns onboarding_step to hook')
await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('reset orientation: ok')
