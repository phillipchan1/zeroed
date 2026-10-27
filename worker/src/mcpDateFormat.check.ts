// MCP date output must match the old Supabase edge function exactly.
// The old function read rows through PostgREST, which serializes timestamptz as ISO
// ("2026-10-27T19:00:00+00:00", i.e. to_json) and DATE as "YYYY-MM-DD". shortDate()
// only formats the ISO form; Postgres' ::text form ("2026-10-27 19:00:00+00") fell
// through raw, and an untyped DATE came back as a JS Date ("Wed Aug 12 2026 00:00:00 GMT…").
// Expected strings are what the old function rendered for the same rows (live, 2026-10-27).
// Run: TZ=UTC node --experimental-strip-types worker/src/mcpDateFormat.check.ts
import { openIsolationHarness } from './isolationDb.ts'
import { executeZeroedTool } from './tools.ts'
import { shortDate } from '../../supabase/functions/_shared/zeroedFormat.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const WORKOUT_A = '99999999-9999-9999-9999-999999999999'
const TS = '2026-10-27 19:00:00+00'
const POSTGREST_TS = '2026-10-27T19:00:00+00:00' // what supabase-js handed the old renderer
const OLD_DAY = 'Tue, Oct 27' // old live output for that timestamp

const harness = await openIsolationHarness()
await harness.exec(`SET TimeZone = 'UTC'`) // Supabase and Neon sessions both run in UTC
await harness.query(`UPDATE workout SET performed_at = $1 WHERE id = $2`, [TS, WORKOUT_A])
await harness.query(`UPDATE coach_message SET created_at = $1 WHERE athlete_id = $2`, [TS, A])
await harness.query(`UPDATE athlete_profile SET retest_date = '2026-08-12' WHERE athlete_id = $1`, [A])

ok(shortDate(POSTGREST_TS) === OLD_DAY, `old path: shortDate(PostgREST ISO) is "${OLD_DAY}"`)
const [{ s }] = await harness.query<{ s: string }>(`SELECT to_json($1::timestamptz) #>> '{}' AS s`, [TS])
ok(s === POSTGREST_TS, `to_json timestamptz text is the PostgREST shape (got ${s})`)

const RAW = /\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d|GMT|Coordinated Universal Time/
const calls: Array<[string, Record<string, unknown>, string[]]> = [
  ['get_workout', { workout_id: WORKOUT_A }, [`— ${OLD_DAY}`]],
  ['list_workouts', { limit: 10 }, [`— ${OLD_DAY}`]],
  ['get_coach_notes', { limit: 10 }, [`- ${OLD_DAY} [`]],
  ['get_athlete', {}, ['Retest: 2026-08-12']],
  ['get_training_brief', {}, ['Retest: 2026-08-12', OLD_DAY]],
]
for (const [name, args, want] of calls) {
  const text = await executeZeroedTool(harness.sql, A, name, args)
  for (const w of want) ok(text.includes(w), `${name}: contains "${w}" like the old function`)
  const raw = text.match(RAW)
  ok(!raw, `${name}: no raw timestamp/Date string${raw ? ` (found "${raw[0]}")` : ''}`)
}

await harness.close()
console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL ${f}`)
  process.exit(1)
}
console.log('mcp date format: ok')
