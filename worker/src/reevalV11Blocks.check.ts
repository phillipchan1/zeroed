// The one-time v1.2 re-check of v1.1 persistent blocks (spec section 11b),
// pure and against a real schema.
//
//   Pure: each v1.2 criterion keeps a block (red flag, > 5 twice in 14 days,
//   rising across 3 sessions); a single > 5 drops to temporary, or to
//   unblocked once its window has passed. Minors and unknown age: never
//   lifted. v1.2-stamped blocks and the athlete's own re-blocks: untouched.
//   The output names regions and counts only. The Neon HTTP executor sends
//   the documented request shapes and never leaks the connection string.
//   DB: dry run writes nothing; apply writes one system change_log row per
//   lifted block (v1.2, the job, before → after) plus a superseding status
//   row, deletes and edits nothing, all in one transaction (a mid-batch
//   failure writes nothing); twice changes nothing the second time; a block
//   that moved between plan and apply is left alone; the athlete's undo makes
//   the block persistent again; A and B never mix; tracks_v1-off athletes are
//   not read or written.
// Synthetic athletes and data only (isolation-seed.sql + rows made here).
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/reevalV11Blocks.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import {
  applyReeval, applyStatements, beforeV12, decide, formatSummary, JOB, JOB_ACTOR, neonHttpExecutor, planReeval, summarize,
  type BlockRow, type Executor, type PainInput, type ReevalInputs,
} from './reevalV11Blocks.ts'
import { main as runner } from '../../scripts/reeval-v11-blocks.mjs'
import { athleteReadinessAction, clearRegion } from './readiness.ts'
import { blockedDuring, blocksNow, loadRegionStatus, statusBlockedRegions } from './regionStatus.ts'
import { athleteChangeLogAction } from './changeLogRoute.ts'
import { listChanges } from './changeLog.ts'
import { athleteToday } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import { addDays } from './readiness/rules.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ---- pure: which blocks are from before v1.2 ---------------------------------------------------
ok(beforeV12(null) && beforeV12('v1') && beforeV12('v1.1') && beforeV12('v1.1+1a2b3c4d') && beforeV12('v1+00ff00ff'), 'version: none, v1 and v1.1 (with overrides) are before v1.2')
ok(!beforeV12('v1.2') && !beforeV12('v1.2+1a2b3c4d') && !beforeV12('v1.10'), 'version: v1.2 is not')

// ---- pure: the decision ---------------------------------------------------------------------------
const NOW = new Date('2026-06-10T18:00:00Z')
const D = '2026-06-10' // the athlete's local date at NOW (America/Los_Angeles)
const ADULT = 'a0000000-0000-4000-8000-000000000001'
let seq = 0
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
function scenario(reports: Array<{ ago: number; score: number; red?: string[] }>, trigger: number, opts: {
  birth?: string | null; confirmed?: boolean; version?: string | null; tool?: string | null; workouts?: number[]; voided?: boolean
} = {}): ReevalInputs {
  const pain: PainInput[] = reports.map((r, i) => ({
    id: `p${i}`, athlete_id: ADULT, region: 'knee', date: addDays(D, -r.ago), score: r.score, red_flags: r.red ?? [],
    created_at: `${addDays(D, -r.ago)}T12:00:00Z`, voided: opts.voided === true && i === trigger,
  }))
  const block: BlockRow = {
    id: 'b0', athlete_id: ADULT, region: 'knee', reason: 'knee at 6/10 (over 5). No loading there (U7).', pain_report_id: `p${trigger}`,
    created_at: pain[trigger].created_at, methodology_version: opts.version === undefined ? 'v1.1' : opts.version,
    change_tool: opts.tool === undefined ? 'log_checkin' : opts.tool,
  }
  return {
    ready: true, as_of: NOW.toISOString(), blocks: [block], pain,
    athletes: [{ id: ADULT, birth_date: opts.birth === undefined ? '1990-01-01' : opts.birth, adult_confirmed_at: opts.confirmed ? '2026-01-01T00:00:00Z' : null, time_zone: null, ran: false }],
    workouts: (opts.workouts ?? []).map((ago) => ({ athlete_id: ADULT, performed_at: `${addDays(D, -ago)}T19:00:00Z` })),
  }
}
const one = (inputs: ReevalInputs) => decide(inputs, { now: NOW, newId: id }).decisions[0]
const kept = (inputs: ReevalInputs) => one(inputs)?.kind === 'kept'
const lifted = (inputs: ReevalInputs) => { const d = one(inputs); return d?.kind === 'lifted' ? d.after : null }

// Red flag.
const red = one(scenario([{ ago: 2, score: 2, red: ['swelling'] }], 0))
ok(red?.kind === 'kept' && red.why === 'persistent_under_v12' && red.criterion === 'red_flag', 'red flag: kept (persistent under v1.2)')
ok(lifted(scenario([{ ago: 2, score: 6 }], 0)) === 'temporary', 'red flag counterpart: the same > 5 without a red flag is lifted')
// > 5 twice within 14 days (inclusive).
const twice = one(scenario([{ ago: 16, score: 7 }, { ago: 2, score: 6 }], 1))
ok(twice?.kind === 'kept' && twice.criterion === 'over_twice', '> 5 twice, 14 days apart: kept')
ok(lifted(scenario([{ ago: 17, score: 7 }, { ago: 2, score: 6 }], 1)) === 'temporary', '> 5 twice, 15 days apart: lifted')
ok(kept(scenario([{ ago: 10, score: 7 }, { ago: 3, score: 6 }], 0)), '> 5 again after the block was set (logged while blocked): kept')
ok(lifted(scenario([{ ago: 10, score: 7 }, { ago: 3, score: 5 }], 0)) === 'temporary', '7 then 5 is not "> 5 twice": lifted (temporary: no session in the 10 days since)')
ok(lifted(scenario([{ ago: 10, score: 7 }, { ago: 3, score: 5 }], 0, { workouts: [8] })) === 'unblocked', '7 then 5, a session since the 7: unblocked')
// Rising across 3 sessions.
const rise = one(scenario([{ ago: 6, score: 2 }, { ago: 4, score: 4 }, { ago: 2, score: 6 }], 2))
ok(rise?.kind === 'kept' && rise.criterion === 'rising', 'rising 2 → 4 → 6: kept')
ok(lifted(scenario([{ ago: 6, score: 4 }, { ago: 4, score: 3 }, { ago: 2, score: 6 }], 2)) === 'temporary', '4 → 3 → 6 is not rising: lifted')
// Single > 5: temporary while the window is open, unblocked once it has passed.
ok(lifted(scenario([{ ago: 0, score: 6 }], 0, { workouts: [0] })) === 'temporary', 'single > 5 today: temporary (a session today doesn\'t end it today)')
ok(lifted(scenario([{ ago: 3, score: 6 }], 0)) === 'temporary', 'single > 5, no session since: temporary')
ok(lifted(scenario([{ ago: 3, score: 6 }], 0, { workouts: [1] })) === 'unblocked', 'single > 5, a session logged since: unblocked')
ok(lifted(scenario([{ ago: 3, score: 6 }], 0, { workouts: [3] })) === 'temporary', 'single > 5, a session the same day only: still temporary')
// v1.3 (section 11c): only a session that loads the region ends the window, as readiness reads it.
const withLoads = (loads: string[]) => { const s = scenario([{ ago: 3, score: 6 }], 0, { workouts: [1] }); s.workouts = s.workouts.map((w) => ({ ...w, loads })); return s }
ok(lifted(withLoads(['shoulder', 'elbow'])) === 'temporary', 'v1.3: an upper-body session since a knee > 5 leaves it temporary')
ok(lifted(withLoads(['knee'])) === 'unblocked', 'v1.3: a session since that loads the knee: unblocked')
ok(lifted(scenario([{ ago: 14, score: 6 }], 0)) === 'temporary' && lifted(scenario([{ ago: 15, score: 6 }], 0)) === 'unblocked', 'single > 5: the 14-day window is inclusive, then unblocked')
// Worse the next morning (v1.1's 4 → 5): v1.2 blocks it too, temporarily.
ok(lifted(scenario([{ ago: 3, score: 4 }, { ago: 2, score: 5 }], 1)) === 'temporary', 'worse the next morning 4 → 5: lifted to temporary')
// Age: under 18 and unknown are never lifted; an adult by confirmation is.
const minor = one(scenario([{ ago: 2, score: 6 }], 0, { birth: '2012-01-01' }))
ok(minor?.kind === 'kept' && minor.why === 'minor_or_unknown_age' && minor.age === 'minor', 'minor: kept (v1.1 behaviour)')
ok(minor?.kind === 'kept' && kept(scenario([{ ago: 2, score: 6 }], 0, { birth: '2012-01-01', confirmed: true })), 'minor: a birth date under 18 beats an 18+ confirmation')
const unknown = one(scenario([{ ago: 2, score: 6 }], 0, { birth: null }))
ok(unknown?.kind === 'kept' && unknown.why === 'minor_or_unknown_age' && unknown.age === 'unknown', 'unknown age: kept')
ok(lifted(scenario([{ ago: 2, score: 6 }], 0, { birth: null, confirmed: true })) === 'temporary', 'adult by 18+ confirmation: lifted')
// Not touched at all, or not judgeable.
ok(decide(scenario([{ ago: 2, score: 6 }], 0, { version: 'v1.2' }), { now: NOW }).decisions.length === 0, 'a v1.2-stamped block: not touched')
ok(decide(scenario([{ ago: 2, score: 6 }], 0, { version: 'v1.1', tool: 'revert_change' }), { now: NOW }).decisions.length === 0, 'the athlete\'s re-block (undoing a clear): not touched')
ok(lifted(scenario([{ ago: 2, score: 6 }], 0, { version: null, tool: null })) === 'temporary', 'no version on record: re-checked like v1.1')
const voided = one(scenario([{ ago: 2, score: 6 }], 0, { voided: true }))
ok(voided?.kind === 'kept' && voided.why === 'not_reevaluable', 'the report that set it was voided: kept')
const ran = scenario([{ ago: 2, score: 6 }], 0)
ran.athletes[0].ran = true
const ranPlan = decide(ran, { now: NOW })
ok(ranPlan.decisions.length === 0 && ranPlan.already_ran === 1 && applyStatements(ranPlan).length === 0, 'an athlete already re-checked: skipped, nothing to write')

// Output: counts by region and totals, nothing else.
const mixed: ReevalInputs = scenario([{ ago: 2, score: 6 }], 0)
const second = scenario([{ ago: 3, score: 2, red: ['numbness_tingling'] }], 0)
mixed.blocks.push({ ...second.blocks[0], id: 'b1', region: 'ankle', pain_report_id: 'q0', reason: 'Red flag at the ankle: numbness or tingling. Sample note.' })
mixed.pain.push({ ...second.pain[0], id: 'q0', region: 'ankle' })
const mixedPlan = decide(mixed, { now: NOW, newId: id })
const text = formatSummary(mixedPlan, 'dry-run')
ok(text.includes('ankle: kept 1, lifted 0') && text.includes('knee: kept 0, lifted 1') && text.includes('total: kept 1, lifted 1 (temporary 1, unblocked 0)'), `output: counts by region and totals (${text})`)
ok(!/\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}|\/10|numbness|tingling|Sample note|swelling|over 5|U7/.test(text), 'output: no dates, ids, ratings, red flags, notes or reasons')
ok(!text.includes(ADULT) && !JSON.stringify(summarize(mixedPlan)).includes(ADULT), 'output: no athlete id, in the text or the summary')

// ---- pure: the Neon HTTP executor -------------------------------------------------------------------
const SECRET_URL = 'postgresql://owner:s3cret-pass@ep-sample-123.us-east-2.aws.neon.tech/zeroed?sslmode=require'
const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
let answer: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { rows: [{ n: '1' }] } }
const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
  return { ok: answer.ok, status: answer.status, json: async () => answer.body }
}
const http = neonHttpExecutor(SECRET_URL, fakeFetch)
const rows = await http.query('SELECT $1::text AS n', [1])
ok(sent[0].url === 'https://ep-sample-123.us-east-2.aws.neon.tech/sql' && rows[0]?.n === '1', 'http: POST https://<host>/sql, rows back')
ok(sent[0].headers['Neon-Connection-String'] === SECRET_URL && sent[0].headers['Content-Type'] === 'application/json' && !('Neon-Batch-Isolation-Level' in sent[0].headers), 'http: single query headers')
ok(JSON.stringify(sent[0].body) === JSON.stringify({ query: 'SELECT $1::text AS n', params: ['1'] }), 'http: single body {query, params}')
answer = { ok: true, status: 200, body: { results: [{ rows: [] }, { rows: [{ id: 'x' }] }] } }
const batch = await http.transaction([{ query: 'SELECT 1', params: [], kind: 'lock' }, { query: 'INSERT … $1::jsonb', params: [{ a: 1 }, null] }])
ok(sent.length === 2 && sent[1].headers['Neon-Batch-Isolation-Level'] === 'ReadCommitted', 'http: a batch is one request, ReadCommitted')
ok(JSON.stringify(sent[1].body) === JSON.stringify({ queries: [{ query: 'SELECT 1', params: [] }, { query: 'INSERT … $1::jsonb', params: ['{"a":1}', null] }] }) && batch[1][0]?.id === 'x', 'http: batch body {queries:[{query, params}]}, no extra keys sent')
answer = { ok: false, status: 400, body: { message: `duplicate key value: knee 7/10 ${SECRET_URL}`, code: '23505' } }
const httpErr = await http.query('SELECT 1').then(() => '', (e: Error) => e.message)
ok(httpErr.includes('400') && httpErr.includes('23505') && !httpErr.includes('s3cret') && !httpErr.includes('knee') && !httpErr.includes('neon.tech'), `http: errors carry status and SQLSTATE only (${httpErr})`)

// ---- pure: the runner ---------------------------------------------------------------------------------
const out: string[] = []
const io = { log: (l: string) => out.push(l), error: (l: string) => out.push(l) }
ok(await runner([], {}, io) === 2 && /DATABASE_URL/.test(out.join('\n')), 'runner: refuses without DATABASE_URL')
ok(await runner(['--apply', '--yes'], { DATABASE_URL: SECRET_URL }, io) === 2, 'runner: refuses unknown flags')
out.length = 0
answer = { ok: false, status: 500, body: { message: `boom ${SECRET_URL}` } }
ok(await runner([], { DATABASE_URL: SECRET_URL }, { ...io, fetch: fakeFetch }) === 1, 'runner: a failing endpoint exits 1')
ok(!out.join('\n').includes('s3cret') && !out.join('\n').includes('ep-sample-123') && !out.join('\n').includes('boom'), 'runner: never prints the connection string or the server\'s message')

// ---- against a real schema --------------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = 'c3c3c3c3-0000-4000-8000-0000000000c3' // under 18
const U = 'd4d4d4d4-0000-4000-8000-0000000000d4' // no age on file
const F = 'e5e5e5e5-0000-4000-8000-0000000000e5' // adult, tracks_v1 off
const G = 'f6f6f6f6-0000-4000-8000-0000000000f6' // adult, flagged after the first run
const A_DAY = '77777777-7777-7777-7777-777777777777'

const harness = await openIsolationHarness()
const sql = harness.sql
const exec: Executor = {
  query: (q, p = []) => harness.query(q, p),
  async transaction(qs) {
    await harness.exec('BEGIN')
    try {
      const res: Array<Record<string, unknown>[]> = []
      for (const q of qs) res.push(await harness.query(q.query, q.params))
      await harness.exec('COMMIT')
      return res
    } catch (e) {
      await harness.exec('ROLLBACK')
      throw e
    }
  },
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const snapshot = async () => JSON.stringify(await harness.query(`
  SELECT (SELECT count(*) FROM change_log)::text AS log, (SELECT count(*) FROM region_status)::text AS status,
         (SELECT count(*) FROM pain_report)::text AS pain,
         (SELECT md5(string_agg(to_jsonb(s)::text, ',' ORDER BY s.id)) FROM region_status s) AS status_md5
`))

await harness.query(`DELETE FROM session_observation`)
await harness.query(`DELETE FROM workout`)
const storeA = makeStore(sql, A)
const T = await athleteToday(storeA)
for (const [aid, user, name] of [[C, 'c3c3c3c3-1111-4000-8000-0000000000c3', 'Athlete C'], [U, 'd4d4d4d4-1111-4000-8000-0000000000d4', 'Athlete U'], [F, 'e5e5e5e5-1111-4000-8000-0000000000e5', 'Athlete F'], [G, 'f6f6f6f6-1111-4000-8000-0000000000f6', 'Athlete G']]) {
  await harness.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, `${name.slice(-1).toLowerCase()}@example.com`])
  await harness.query(`INSERT INTO athlete (id, auth_user_id, name, training_age, sessions_per_week) VALUES ($1, $2, $3, 2, 3)`, [aid, user, name])
}
for (const aid of [A, B, C, U]) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${aid}`
await sql`UPDATE athlete SET birth_date = ${addDays(T, -30 * 365)}::date WHERE id = ${A}`
await sql`UPDATE athlete SET adult_confirmed_at = NOW() WHERE id = ${B}`
await sql`UPDATE athlete SET birth_date = ${addDays(T, -15 * 365)}::date WHERE id = ${C}`
await sql`UPDATE athlete SET birth_date = ${addDays(T, -40 * 365)}::date WHERE id IN (${F}, ${G})`

const painRow = async (athlete: string, region: string, ago: number, score: number, red: string[] = []) => (await harness.query<{ id: string }>(
  `INSERT INTO pain_report (athlete_id, date, region, score, red_flags, created_at)
   VALUES ($1, $2::date, $3, $4, $5::text[], NOW() - make_interval(days => $6::int)) RETURNING id::text AS id`,
  [athlete, addDays(T, -ago), region, score, `{${red.join(',')}}`, ago],
))[0].id
/** A block as the v1.1 Worker stored it: the check-in's change_log row (stamped `version`) and a 'blocked' row. */
async function storedBlock(athlete: string, region: string, reports: Array<{ ago: number; score: number; red?: string[] }>, trigger: number,
  opts: { version?: string | null; tool?: string; noLog?: boolean; noReport?: boolean } = {}): Promise<string> {
  const ids: string[] = []
  for (const r of reports) ids.push(await painRow(athlete, region, r.ago, r.score, r.red))
  const ago = reports[trigger]?.ago ?? 5
  let changeId: string | null = null
  if (!opts.noLog) {
    changeId = (await harness.query<{ id: string }>(
      `INSERT INTO change_log (athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, approval_ref, methodology_version, created_at)
       VALUES ($1, 'athlete', $6, $2, 'checkin', $3, '{}'::jsonb, 'standing:logging', $4, NOW() - make_interval(days => $5::int)) RETURNING id::text AS id`,
      [athlete, opts.tool ?? 'log_checkin', addDays(T, -ago), opts.version === undefined ? 'v1.1' : opts.version, ago, athlete],
    ))[0].id
  }
  return (await harness.query<{ id: string }>(
    `INSERT INTO region_status (athlete_id, region, status, reason, pain_report_id, change_id, created_at)
     VALUES ($1, $2, 'blocked', $3, $4, $5, NOW() - make_interval(days => $6::int)) RETURNING id::text AS id`,
    [athlete, region, `Synthetic ${region} block (U7).`, opts.noReport ? null : ids[trigger], changeId, ago],
  ))[0].id
}

// A (adult by birth date): four lifted, three kept, two untouched.
await storedBlock(A, 'knee', [{ ago: 0, score: 6 }], 0) //                         single > 5 today → temporary
await storedBlock(A, 'low_back', [{ ago: 3, score: 6 }], 0) //                     single > 5, session since → unblocked
await storedBlock(A, 'elbow', [{ ago: 20, score: 7 }], 0) //                       window passed → unblocked
await storedBlock(A, 'neck', [{ ago: 25, score: 6 }], 0, { noLog: true }) //       no version on record → unblocked
await storedBlock(A, 'ankle', [{ ago: 5, score: 2, red: ['swelling'] }], 0) //     red flag → kept
await storedBlock(A, 'hip', [{ ago: 10, score: 7 }, { ago: 3, score: 6 }], 0) //   > 5 twice in 14 days → kept
await storedBlock(A, 'shoulder', [{ ago: 6, score: 2 }, { ago: 4, score: 4 }, { ago: 2, score: 6 }], 2) // rising → kept
await storedBlock(A, 'hamstring', [{ ago: 4, score: 6 }], 0, { noReport: true }) // no report to judge → kept
await storedBlock(A, 'wrist', [{ ago: 3, score: 6 }], 0, { version: 'v1.2' }) //   stamped v1.2 → untouched
await storedBlock(A, 'foot', [{ ago: 3, score: 6 }], 0, { tool: 'revert_change' }) // the athlete's re-block → untouched
await painRow(A, 'groin', 6, 7) // A's groin 7: would make B's groin "> 5 twice" if the athletes mixed
await harness.query(
  `INSERT INTO workout (routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
   VALUES ($1, $2::timestamptz, 7, 40, '{}'::jsonb, '[{"name":"Deadlift","sets":3,"reps":"5","load":"heavy"}]'::jsonb)`, [A_DAY, `${addDays(T, -1)}T19:00:00Z`],
) // A's session loads the low back (v1.3): lapses A's low back, and must not lapse B's groin
await storedBlock(B, 'groin', [{ ago: 2, score: 6 }], 0) // B (adult by confirmation): lifted, still temporary
await storedBlock(C, 'knee', [{ ago: 2, score: 6 }], 0) //  under 18: kept
await storedBlock(U, 'knee', [{ ago: 2, score: 6 }], 0) //  no age on file: kept
await storedBlock(F, 'knee', [{ ago: 2, score: 6 }], 0) //  tracks_v1 off: not read, not written
const fBefore = JSON.stringify(await harness.query(`SELECT to_jsonb(s) AS s FROM region_status s WHERE athlete_id = $1 ORDER BY id`, [F]))
const blockedBefore = await count('region_status', `status = 'blocked'`)

// Flag off: nothing about F's world changes, before or after.
ok(JSON.stringify(await zeroedToolsFor(sql, F)) === JSON.stringify(ZEROED_TOOLS), 'flag off: tool list unchanged')

// ---- dry run (the runner's default): reads only ----------------------------------------------------
const before = await snapshot()
const dry: string[] = []
ok(await runner([], {}, { executor: exec, log: (l: string) => dry.push(l), error: (l: string) => dry.push(l) }) === 0, 'dry run: exits 0')
const dryText = dry.join('\n')
ok(await snapshot() === before, 'dry run: writes nothing')
const want = [
  'ankle: kept 1, lifted 0', 'elbow: kept 0, lifted 1', 'groin: kept 0, lifted 1', 'hamstring: kept 1, lifted 0', 'hip: kept 1, lifted 0',
  'knee: kept 2, lifted 1', 'low_back: kept 0, lifted 1', 'neck: kept 0, lifted 1', 'shoulder: kept 1, lifted 0',
  'total: kept 6, lifted 5 (temporary 2, unblocked 3)',
  'kept because: under 18 or no age on file 2, persistent under v1.2 3, not re-checkable 1',
]
ok(want.every((l) => dryText.includes(l)) && /DRY RUN/.test(dryText), `dry run: counts by region and totals (${dryText})`)
ok(!/wrist|foot/.test(dryText), 'dry run: v1.2 blocks and re-blocks are not counted')
ok(!/[0-9a-f]{8}-[0-9a-f]{4}-|\d{4}-\d{2}-\d{2}|\/10|Synthetic|swelling|Athlete|@example/.test(dryText), 'dry run: no ids, dates, ratings, notes, red flags or names')
const plan = await planReeval(exec)
ok(!plan.decisions.some((d) => d.block.athlete_id === F), 'flag off: F\'s block is not even read')

// ---- atomicity: a failure mid-batch writes nothing ---------------------------------------------
const breaking: Executor = {
  query: exec.query,
  transaction: (qs) => {
    const mid = Math.floor(qs.length / 2)
    return exec.transaction([...qs.slice(0, mid), { query: 'SELECT (1 / 0)::text AS boom', params: [] }, ...qs.slice(mid)])
  },
}
ok(applyStatements(plan).length > 4, 'atomicity: the batch has writes on both sides of the failure')
const broke = await applyReeval(breaking, plan).then(() => false, () => true)
ok(broke && await snapshot() === before, 'atomicity: a statement failing mid-batch rolls every write back')
const failRun: string[] = []
ok(await runner(['--apply'], {}, { executor: breaking, log: (l: string) => failRun.push(l), error: (l: string) => failRun.push(l) }) === 1 && await snapshot() === before, 'atomicity: the runner\'s apply fails as a whole')
ok(!/[0-9a-f]{8}-[0-9a-f]{4}-|Synthetic|\/10/.test(failRun.join('\n')), 'atomicity: the failure prints no detail')

// ---- apply ----------------------------------------------------------------------------------------------
const applied: string[] = []
ok(await runner(['--apply'], {}, { executor: exec, log: (l: string) => applied.push(l), error: (l: string) => applied.push(l) }) === 0, 'apply: exits 0')
ok(applied.join('\n').includes('written: 5 lifted, 4 athletes marked (one transaction)'), `apply: writes the plan (${applied.join(' | ')})`)
type Log = { id: string; athlete_id: string; actor_type: string; actor_id: string; tool: string; target_type: string; target_id: string | null; diff: Record<string, any>; approval_ref: string | null; methodology_version: string | null; rationale: string | null }
const logs = await harness.query<Log>(`SELECT id::text AS id, athlete_id::text AS athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, approval_ref, methodology_version, rationale FROM change_log WHERE tool IN ('apply_block_reeval', 'apply_block_reeval_run') ORDER BY athlete_id, target_id`)
const lifts = logs.filter((l) => l.tool === 'apply_block_reeval')
ok(lifts.length === 5 && lifts.every((l) => l.actor_type === 'system' && l.actor_id === JOB_ACTOR && l.methodology_version === 'v1.2' && l.approval_ref === null && l.diff.job === JOB && l.diff.methodology_version === 'v1.2'), 'apply: one system row per lifted block, methodology v1.2, the job, no approval_ref')
ok(lifts.every((l) => l.diff.before?.status === 'blocked' && l.diff.before?.block === 'persistent' && l.diff.after?.status === 'ok' && /v1\.2/.test(l.rationale ?? '') && /U7/.test(l.rationale ?? '')), 'apply: before → after and the rule in each row')
ok(lifts.filter((l) => l.athlete_id === A).map((l) => l.target_id).sort().join() === 'elbow,knee,low_back,neck' && lifts.filter((l) => l.athlete_id === B).map((l) => l.target_id).join() === 'groin', 'apply: exactly the planned regions')
ok(lifts.find((l) => l.athlete_id === A && l.target_id === 'neck')?.diff.before?.methodology_version === null && lifts.find((l) => l.target_id === 'elbow')?.diff.before?.methodology_version === 'v1.1', 'apply: the version each block was stored under is recorded')
const markers = logs.filter((l) => l.tool === 'apply_block_reeval_run')
ok(markers.length === 4 && markers.map((m) => m.athlete_id).sort().join() === [A, B, C, U].sort().join(), 'apply: one marker per re-checked athlete, none for F')
ok(markers.find((m) => m.athlete_id === A)?.diff.lifted === 4 && markers.find((m) => m.athlete_id === A)?.diff.kept === 4 && markers.find((m) => m.athlete_id === C)?.diff.kept === 1, 'apply: each marker counts what landed')
ok(await count('region_status', `status = 'blocked'`) === blockedBefore && await count('region_status', `status = 'blocked' AND cleared_at IS NOT NULL`) === 0, 'apply: no block row deleted or edited')
ok(await count('region_status', `status = 'ok' AND change_id::text IN (SELECT id::text FROM change_log WHERE tool = 'apply_block_reeval')`) === 5, 'apply: each lift is a new status row linked to its change')
ok(JSON.stringify(await harness.query(`SELECT to_jsonb(s) AS s FROM region_status s WHERE athlete_id = $1 ORDER BY id`, [F])) === fBefore && await count('change_log', 'athlete_id = $1', [F]) === 1, 'flag off: F untouched')

// What the engine makes of it now.
type Today = { temporary_blocked: Array<{ region: string }>; blocked: Array<{ region: string }> }
const todayOf = async (aid: string) => (await athleteReadinessAction(makeStore(sql, aid), { action: 'today' }))[0] as Today
const aNow = await statusBlockedRegions(storeA)
ok(aNow.join() === 'ankle,foot,hamstring,hip,shoulder,wrist', `engine: A's kept blocks stay, the lifted ones are gone (${aNow.join()})`)
const aToday = await todayOf(A)
// v1.3: A's groin 7 (the isolation row) stays temporary too: a deadlift session doesn't load the groin.
ok(aToday.temporary_blocked.map((t) => t.region).join() === 'groin,knee' && !aToday.blocked.some((b) => ['knee', 'low_back', 'elbow', 'neck'].includes(b.region)), 'engine: A\'s knee is temporary (today), low back / elbow / neck unblocked')
const bToday = await todayOf(B)
ok(bToday.temporary_blocked.map((t) => t.region).join() === 'groin' && (await statusBlockedRegions(makeStore(sql, B))).length === 0, 'isolation: B\'s groin is temporary — A\'s pain and A\'s session never counted for B')
ok((await statusBlockedRegions(makeStore(sql, C))).join() === 'knee' && (await statusBlockedRegions(makeStore(sql, U))).join() === 'knee', 'age: the minor\'s and the unknown-age athlete\'s blocks stay')
ok(!(await clearRegion(storeA, { type: 'athlete', id: A }, 'elbow')).ok, 'engine: a lifted block needs no clinician clear')
// blockedDuring compares dates as UTC midnights (as before); two days on is past the lift in any zone.
ok(!(await blockedDuring(storeA, addDays(T, 2), addDays(T, 2))).includes('elbow') && (await blockedDuring(storeA, addDays(T, -21), addDays(T, -14))).includes('elbow'), 'weekly review: the lifted block ends where it was lifted, its history stays')
const feed = (await listChanges(storeA, { limit: 50 }))!.changes
const kneeFeed = feed.find((c) => c.tool === 'apply_block_reeval' && c.target_id === 'knee')
ok(/^Knee re-checked under v1\.2: no clinician clear needed \(off until next session\)$/.test(kneeFeed?.summary ?? '') && kneeFeed?.revertible === true, `feed: the athlete sees the re-check and can undo it (${kneeFeed?.summary})`)
ok(/4 kept, 4 lifted/.test(feed.find((c) => c.tool === 'apply_block_reeval_run')?.summary ?? '') && feed.find((c) => c.tool === 'apply_block_reeval_run')?.revertible === false, 'feed: the marker shows the counts, nothing to undo')
// D3: the rows are health data (target region): a coach without the toggle sees that a row exists, not what it says.
const TOKEN_A = 'aaaa6666-0000-4000-8000-000000000001'
const coachLog = async () => executeZeroedTool(sql, A, 'get_change_log', { since: addDays(T, -1) }, {}, { type: 'mcp', id: TOKEN_A }).catch((e: Error) => e.message)
await harness.query('UPDATE mcp_token SET share_health = false WHERE id = $1', [TOKEN_A])
const hiddenLog = await coachLog()
ok(!/knee|elbow|low.back|neck|Synthetic|re-checked/i.test(hiddenLog), `privacy: a coach without health access reads no region or reason (${hiddenLog.slice(0, 120)})`)
await harness.query('UPDATE mcp_token SET share_health = true WHERE id = $1', [TOKEN_A])
ok(/re-checked under v1\.2/.test(await coachLog()), 'privacy: with health access the coach sees the re-check')

// ---- idempotent ---------------------------------------------------------------------------------------
const afterFirst = await snapshot()
const again = await planReeval(exec)
ok(again.decisions.length === 0 && again.already_ran === 3 && applyStatements(again).length === 0, 'twice: nothing left to decide or write (A, C, U skipped)')
const second2: string[] = []
ok(await runner(['--apply'], {}, { executor: exec, log: (l: string) => second2.push(l), error: (l: string) => second2.push(l) }) === 0 && second2.join('\n').includes('written: 0 lifted, 0 athletes marked'), 'twice: the second apply writes nothing')
ok(await snapshot() === afterFirst, 'twice: the database is exactly as after the first run')
// A replayed batch (the same plan sent again) writes nothing either.
ok((await applyReeval(exec, plan)).lifted === 0 && await snapshot() === afterFirst, 'twice: replaying the first plan writes nothing (guards)')

// ---- the plan is re-checked at apply: what moved since is left alone ------------------------------------
await storedBlock(G, 'knee', [{ ago: 2, score: 6 }], 0)
await storedBlock(G, 'hip', [{ ago: 3, score: 6 }], 0)
await storedBlock(G, 'ankle', [{ ago: 3, score: 6 }], 0)
ok((await planReeval(exec)).decisions.length === 0, 'flag off: G is not re-checked before tracks_v1 is on')
await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${G}`
const gPlan = await planReeval(exec)
ok(gPlan.decisions.filter((d) => d.kind === 'lifted').length === 3 && gPlan.decisions.every((d) => d.block.athlete_id === G), 'later: an athlete flagged after the run is re-checked on its own')
ok((await clearRegion(makeStore(sql, G), { type: 'athlete', id: G }, 'knee')).ok, 'drift: G clears the knee after the plan')
await painRow(G, 'hip', 0, 6) // drift: a new hip report after the plan
const gApplied = await applyReeval(exec, gPlan)
const gMarker = (await harness.query<{ diff: Record<string, number> }>(`SELECT diff FROM change_log WHERE athlete_id = $1 AND tool = 'apply_block_reeval_run'`, [G]))[0]
ok(gApplied.lifted === 1 && gMarker?.diff.lifted === 1 && gMarker?.diff.kept === 2, 'drift: only the unchanged block is lifted; the marker counts the rest as kept')
ok((await statusBlockedRegions(makeStore(sql, G))).join() === 'hip', 'drift: the hip (new report) stays blocked, the cleared knee stays cleared')

// ---- revert: the athlete's undo makes the block persistent again ----------------------------------------
const kneeLift = lifts.find((l) => l.athlete_id === A && l.target_id === 'knee')!
const preview = (await athleteChangeLogAction(storeA, { action: 'preview_revert', id: kneeLift.id }))[0] as { ok: boolean; preview_id?: string; text: string }
ok(preview.ok, `revert: previews (${preview.text})`)
const undo = (await athleteChangeLogAction(storeA, { action: 'revert', id: kneeLift.id, preview_id: preview.preview_id }))[0] as { ok: boolean; change_id?: string; text: string }
ok(undo.ok, `revert: applies (${undo.text})`)
const kneeNow = (await loadRegionStatus(storeA)).find((s) => s.region === 'knee')
ok(blocksNow(kneeNow) && kneeNow?.reason === 'Synthetic knee block (U7).' && (await statusBlockedRegions(storeA)).includes('knee'), 'revert: the knee is persistently blocked again, with its original reason')
ok((await todayOf(A)).blocked.some((b) => b.region === 'knee') && !(await todayOf(A)).temporary_blocked.some((t) => t.region === 'knee'), 'revert: listed to clear, not temporary')
const redo = (await athleteChangeLogAction(storeA, { action: 'preview_revert', id: String(undo.change_id) }))[0] as { ok: boolean; text: string }
ok(!redo.ok && /clinician/.test(redo.text) && blocksNow((await loadRegionStatus(storeA)).find((s) => s.region === 'knee')), 'revert: redoing the lift is refused; still blocked')
const markerA = markers.find((m) => m.athlete_id === A)!
const markerUndo = (await athleteChangeLogAction(storeA, { action: 'preview_revert', id: markerA.id }))[0] as { ok: boolean; text: string }
ok(!markerUndo.ok && /re-check/.test(markerUndo.text), 'revert: the marker is not revertible')
ok((await planReeval(exec)).decisions.length === 0, 'revert: the re-blocked knee is not re-checked again')

// ---- isolation --------------------------------------------------------------------------------------------
const crossed = await count('region_status s', `change_id IS NOT NULL AND EXISTS (SELECT 1 FROM change_log c WHERE c.id = s.change_id AND c.athlete_id <> s.athlete_id)`)
ok(crossed === 0, 'isolation: every status row links to its own athlete\'s change')
const bOnA = (await athleteChangeLogAction(makeStore(sql, B), { action: 'preview_revert', id: lifts.find((l) => l.athlete_id === A && l.target_id === 'elbow')!.id }))[0] as { ok: boolean; reason?: string }
ok(!bOnA.ok && bOnA.reason === 'not_found', 'isolation: B cannot undo A\'s lift')
ok(!JSON.stringify(markers.find((m) => m.athlete_id === B)?.diff).includes(A) && !lifts.filter((l) => l.athlete_id === B).some((l) => JSON.stringify(l.diff).includes(A)), 'isolation: B\'s rows name nothing of A\'s')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`reeval-v11-blocks: ok (${harness.backend})`)
