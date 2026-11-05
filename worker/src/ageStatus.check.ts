// Round 3 PR A (spec section 11b) against a real schema: unknown age gets the
// under-18 rules, the athlete's own "I'm 18 or older", a guardian
// confirmation for a minor's (or unknown-age athlete's) red-flag clear, and a
// coach downgraded to read losing its open previews and proposals.
//
//   Static: no direct birth-date age check outside worker/src/ageStatus.ts.
//   Flag off: age is decided exactly as before (unknown = adult rules, the
//   confirmation is never read); routes and tools as before.
//   Flag on: unknown = minor in every rule; confirmed = adult; a birth date
//   under 18 beats a confirmation; the confirmation is a logged athlete
//   write, undoable, never a coach's; the operator cut-over SQL is
//   idempotent and leaves the birth date null; clears need a guardian under
//   18 or with no age; a downgrade voids like a revoke and an upgrade
//   revives nothing. Athletes A and B never touch each other's rows, and a
//   coach without health access still sees no clear details.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/ageStatus.check.ts

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openIsolationHarness } from './isolationDb.ts'
import { ageStatusFrom, athleteAge, minorRulesFor, overrideAgeOf } from './ageStatus.ts'
import { ageView, confirmAdult } from './adultConfirmation.ts'
import { createApproval } from './approvals.ts'
import { executeDataQuery } from './data.ts'
import { athleteChangeLogAction } from './changeLogRoute.ts'
import { resolveMethodology } from './methodology.ts'
import { checkOverride, resolveParams } from './methodology/resolve.ts'
import { CURRENT_METHODOLOGY } from './methodology/v1.ts'
import { parseIntake } from './coach/intake.ts'
import { athleteReadinessAction, clearRedFlag, clearRegion, HEALTH_HIDDEN, saveCheckin, setCoachHealth, setCoachRole } from './readiness.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')

// ---- pure: the rule --------------------------------------------------------------------------
const T0 = '2026-11-04'
ok(ageStatusFrom({ birthDate: '1990-01-01', adultConfirmed: false, today: T0 }) === 'adult', 'pure: a birth date 18+ is adult')
ok(ageStatusFrom({ birthDate: '2012-01-01', adultConfirmed: false, today: T0 }) === 'minor', 'pure: a birth date under 18 is minor')
ok(ageStatusFrom({ birthDate: null, adultConfirmed: true, today: T0 }) === 'adult', 'pure: no birth date + 18+ confirmation is adult')
ok(ageStatusFrom({ birthDate: null, adultConfirmed: false, today: T0 }) === 'unknown', 'pure: neither is unknown')
ok(ageStatusFrom({ birthDate: '2012-01-01', adultConfirmed: true, today: T0 }) === 'minor', 'pure: a birth date under 18 beats a confirmation')
ok(ageStatusFrom({ birthDate: '2008-11-04', adultConfirmed: false, today: T0 }) === 'adult' && ageStatusFrom({ birthDate: '2008-11-05', adultConfirmed: false, today: T0 }) === 'minor', 'pure: the 18th birthday is the line')
ok(minorRulesFor('unknown') && minorRulesFor('minor') && !minorRulesFor('adult'), 'pure: unknown gets the under-18 rules')
ok(overrideAgeOf('unknown') === null && overrideAgeOf('minor') === true && overrideAgeOf('adult') === false, 'pure: the override guard sees unknown as unknown')

// The override guards: unknown is refused what a minor is.
const kidRules = resolveParams(CURRENT_METHODOLOGY, [], { minor: true })
const adultRules = resolveParams(CURRENT_METHODOLOGY, [], { minor: false })
const guard = (path: string, value: unknown, minor: boolean | null) => checkOverride({
  path, value, clear: false, trackId: null, now: minor === false ? adultRules : kidRules, withoutThis: minor === false ? adultRules : kidRules,
  minor, actorType: 'mcp', exists: false,
})
ok(!guard('U7.regions.knee.raised_cap', true, null).ok && guard('U7.regions.knee.raised_cap', true, false).ok, 'guard: unknown age gets no raised pain cap; an adult can')
const loosen = guard('U5.base_rpe', [7, 8.5], null)
ok(!loosen.ok && /age isn't on file/.test(loosen.text), 'guard: unknown age can\'t loosen anything (named as unknown)')
ok(guard('U5.base_rpe', [6, 7], null).ok, 'guard: unknown age can still tighten')
ok(!guard('minors.max_rpe', 8.5, false).ok, 'guard: under-18 rules never loosen, for anyone')

// Intake: unknown needs consent, gets no max tests; "I'm 18 or older" is adult; a birth date under 18 wins.
const intakeCtx = { today: T0, birthDateOnFile: null, params: CURRENT_METHODOLOGY.params, minors: CURRENT_METHODOLOGY.minors }
const answers = {
  goals: [{ name: 'Back squat', test: 'Back Squat 1RM', weight: 'priority' }],
  activities: [],
  schedule: { days_per_week: 3, minutes_per_session: 60, rest_days: [6] },
  training_age: '1to3',
}
const unknownIntake = parseIntake(answers, intakeCtx)
ok(!unknownIntake.ok && unknownIntake.needs_consent === true && /No age on file/.test(unknownIntake.errors[0]), 'intake: unknown age needs parental consent')
const unknownConsent = parseIntake({ ...answers, parental_consent: { guardian_name: 'Sample Guardian', confirmed: true } }, intakeCtx)
ok(unknownConsent.ok && unknownConsent.intake.minor && unknownConsent.intake.age_status === 'unknown' && /no max test/.test(unknownConsent.intake.goals[0].test ?? ''), 'intake: unknown age gets no max test')
const confirmedIntake = parseIntake({ ...answers, adult_confirmed: true }, intakeCtx)
ok(confirmedIntake.ok && !confirmedIntake.intake.minor && confirmedIntake.intake.adult_confirmed && confirmedIntake.intake.goals[0].test === 'Back Squat 1RM', 'intake: "I\'m 18 or older" is adult rules')
ok(parseIntake(answers, { ...intakeCtx, adultConfirmedOnFile: true }).ok, 'intake: a confirmation on file is adult rules')
const kidOverConfirm = parseIntake({ ...answers, birth_date: '2012-01-01', adult_confirmed: true }, intakeCtx)
ok(!kidOverConfirm.ok && kidOverConfirm.needs_consent === true, 'intake: a birth date under 18 beats the confirmation')

// ---- static: one place decides age ----------------------------------------------------------
// A direct birth-date age check: splitting or year-diffing a birth date, or
// comparing an age (or ageOn) against 18 / minors.age_under. Only ageStatus.ts
// may. IntakeScreen.tsx keeps a display-only hint (the Worker decides and
// refuses); it's listed here so a second one can't slip in unnoticed.
const ALLOWED = new Set(['worker/src/ageStatus.ts', 'src/screens/loop/IntakeScreen.tsx'])
const AGE_CHECKS: RegExp[] = [
  /\b(birth\w*|dob)\b[^\n]*\.split\(\s*['"]-['"]\s*\)/i,
  /\b(birth\w*|dob)\b[^\n]*getFullYear|getFullYear[^\n]*\b(birth\w*|dob)\b/i,
  /[<>]=?\s*[\w.]*\bage_under\b|\bage_under\b\s*[<>]/,
  /\b\w*(age|years|yrs)\w*\s*[<>]=?\s*18\b|\b18\s*[<>]=?\s*\w*(age|years|yrs)\w*\b/i,
  /\bageOn\([^)]*\)\s*[<>]/,
  /INTERVAL\s*'18 years'|\bAGE\(\s*\w*birth/i,
]
export function directAgeChecks(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    return AGE_CHECKS.some((re) => re.test(code)) ? [`${file}:${i + 1}`] : []
  })
}
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules') return []
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(name) && !/\.check\.ts$/.test(name) ? [p] : []
  })
}
const scanned = ['worker/src', 'src', 'supabase/functions'].flatMap((d) => walk(join(root, d)))
const hits = scanned.flatMap((p) => {
  const rel = relative(root, p)
  return ALLOWED.has(rel) ? [] : directAgeChecks(rel, readFileSync(p, 'utf8'))
})
ok(scanned.length > 100 && scanned.some((p) => p.endsWith('worker/src/sessionRx.ts')), `static: the scan covers the Worker and the app (${scanned.length} files)`)
ok(hits.length === 0, `static: no direct birth-date age check outside ageStatus.ts (${hits.join(', ')})`)
ok(directAgeChecks('worker/src/ageStatus.ts', readFileSync(join(here, 'ageStatus.ts'), 'utf8')).length > 0, 'static: ageStatus.ts is where the check lives')
for (const probe of [
  "const [y, m, d] = dob.slice(0, 10).split('-').map(Number)",
  'return age < CURRENT_METHODOLOGY.minors.age_under',
  'const minor = ageOn(row.birth_date, today) < 18',
  'if (years >= 18) adult = true',
  'const y = new Date(athlete.birth_date).getFullYear()',
  "WHERE birth_date > CURRENT_DATE - INTERVAL '18 years'",
]) ok(directAgeChecks('probe.ts', probe).length === 1, `static: a new direct check is caught (${probe.slice(0, 40)}…)`)
ok(directAgeChecks('probe.ts', "const age = await athleteAge(store)\nif (age.minorRules) clamp()").length === 0, 'static: going through the helper passes')

// ---- against a real schema ---------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const A_PROGRAM = '33333333-3333-3333-3333-333333333333'
const A_PHASE = '55555555-5555-5555-5555-555555555555'
const C_DAY = 'cccc0000-0000-4000-8000-0000000000a9'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_D_ID = 'aaaa6666-0000-4000-8000-0000000000d1'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'
const OPS_ATHLETE = 'dddd0000-0000-4000-8000-0000000000d1'
const OPS_DOB_ATHLETE = 'dddd0000-0000-4000-8000-0000000000d2'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const athleteA: OverrideActor = { type: 'athlete', id: A }
const athleteB: OverrideActor = { type: 'athlete', id: B }
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachD: OverrideActor = { type: 'mcp', id: TOKEN_D_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const appCoach: OverrideActor = { type: 'app_coach', id: 'app_coach' }
const T = await athleteToday(storeA)
const yearsAgo = (n: number) => `${Number(T.slice(0, 4)) - n}${T.slice(4)}`

await harness.query(
  `INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
   VALUES ($1, $2, $3, 'Age day', 'strength', $4::jsonb, 'Age intent', 2)`,
  [C_DAY, A_PROGRAM, A_PHASE, JSON.stringify([
    { name: 'Back Squat', sets: 3, reps: '3', load: 'heavy', rpe: 9 },
    { name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' },
    { name: 'Walking Lunge', sets: 3, reps: '10', load: 'moderate', rpe: 9 },
  ])],
)
await harness.query(`UPDATE phase SET week_start = $2::date, week_end = $3::date WHERE id = $1`, [A_PHASE, `${T.slice(0, 8)}01`, `${Number(T.slice(0, 4)) + 1}-12-31`])
await harness.query(`INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four) VALUES ($1, $2, 'downgrade coach', 'synthetic-hash-d', 'aad1')`, [TOKEN_D_ID, A])

const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const setAge = (athleteId: string, birth: string | null, confirmed: boolean) =>
  harness.query(`UPDATE athlete SET birth_date = $2::date, adult_confirmed_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END WHERE id = $1`, [athleteId, birth, confirmed])
const rx = async (athleteId = A) => {
  const [out] = await sessionRxForAthlete(sql, athleteId, { routine_id: C_DAY, unit: 'lb', storage_unit: 'lb' })
  return JSON.stringify(out)
}
const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const chp = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? /preview_id: (chp_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const tap = async (previewId: string, store = storeA, actor = athleteA) => {
  const r = await createApproval(store, actor, { preview_id: previewId })
  return r.ok ? r.approval_ref : `refused: ${r.text}`
}
type Row = { id: string; tool: string; actor_type: string; actor_id: string; diff: Record<string, unknown>; approval_ref: string | null; methodology_version: string | null; rationale: string | null }
const lastLog = async (athleteId: string, tool: string) => (await harness.query<Row>(
  `SELECT id::text AS id, tool, actor_type, actor_id, diff, approval_ref, methodology_version, rationale FROM change_log
   WHERE athlete_id = $1 AND tool = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [athleteId, tool],
))[0]
const athleteRow = async (id: string) => (await harness.query<{ birth_date: string | null; adult_confirmed_at: string | null; rest: string }>(
  `SELECT birth_date::text AS birth_date, adult_confirmed_at::text AS adult_confirmed_at,
          (to_jsonb(a) - 'adult_confirmed_at')::text AS rest FROM athlete a WHERE id = $1`, [id],
))[0]
const tapRevert = async (changeId: string, store = storeA): Promise<{ ok: boolean; text: string }> => {
  const [p] = await athleteChangeLogAction(store, { action: 'preview_revert', id: changeId }) as [{ ok: boolean; preview_id?: string; text: string }, number]
  if (!p.ok) return p
  return (await athleteChangeLogAction(store, { action: 'revert', id: changeId, preview_id: p.preview_id }))[0] as { ok: boolean; text: string }
}

// ---- flag OFF: exactly as before ----------------------------------------------------------------
await setAge(A, null, false)
const offUnknown = await athleteAge(storeA)
ok(offUnknown.status === 'unknown' && offUnknown.minorRules === false, 'flag off: no age on file still gets the adult rules (as before)')
const offRx = await rx()
await setAge(A, null, true)
ok((await athleteAge(storeA)).adultConfirmedAt === null && (await athleteAge(storeA)).status === 'unknown', 'flag off: the confirmation is never read')
ok(await rx() === offRx, 'flag off: session-rx byte-identical whether or not a confirmation is stored')
await setAge(A, yearsAgo(15), true)
ok((await athleteAge(storeA)).minorRules === true, 'flag off: a minor by birth date is a minor (as before)')
await setAge(A, null, false)
ok((await athleteReadinessAction(storeA, { action: 'age' }))[1] === 404 && (await athleteReadinessAction(storeA, { action: 'confirm_adult' }))[1] === 404, 'flag off: the age routes read as absent')
ok(!(await confirmAdult(storeA, athleteA)).ok && (await athleteRow(A)).adult_confirmed_at === null, 'flag off: nothing confirms')
ok(JSON.stringify(await zeroedToolsFor(sql, A)) === JSON.stringify(ZEROED_TOOLS), 'flag off: MCP tool list exactly ZEROED_TOOLS')

// ---- flag ON: unknown age is every under-18 rule ------------------------------------------------
await flag(A, true)
await flag(B, true)
const unknown = await resolveMethodology(storeA)
const unknownRx = await rx()
ok(unknown.minor === true && (await athleteAge(storeA)).status === 'unknown', 'unknown: the under-18 rules apply')
ok(unknown.params.U5.top_single_rpe[1] <= 8 && unknown.params.U5.base_rpe[1] <= 8, 'unknown: RPE ≤ 8')
ok(Object.values(unknown.params.U14.contacts_per_session).every((r) => r[1] <= 60), 'unknown: contacts ≤ 60 a session')
ok(unknown.params.U6.single_day_sleep_under_hours === undefined && unknown.params.U7.temporary_blocks !== true, 'unknown: v1.1 behaviour for the two rules v1.2 loosens')
ok(unknown.version !== CURRENT_METHODOLOGY.version && unknown.version.startsWith(`${CURRENT_METHODOLOGY.version}+`), 'unknown: the version records the under-18 rules')
ok(!/"rpe":\s*(8\.5|9|9\.5|10)\b/.test(unknownRx), 'unknown: no prescribed RPE above 8')
await setAge(A, yearsAgo(15), false)
const minorRules = await resolveMethodology(storeA)
ok(JSON.stringify(minorRules.params) === JSON.stringify(unknown.params) && minorRules.version === unknown.version, 'unknown: exactly the rules a minor gets')
ok(await rx() === unknownRx, 'unknown: session-rx identical to a minor\'s')
await setAge(A, null, false)
ok((await call('preview_methodology_override', { path: 'U7.regions.knee.raised_cap', value: true })).includes('18+'), 'unknown: no raised pain cap (MCP)')
ok((await call('preview_methodology_override', { path: 'U5.top_single_rpe', value: [8, 9.5] })).startsWith('Refused'), 'unknown: no loosening (MCP)')
const methView = JSON.parse(await call('get_methodology', {})) as { age_status: string; under_18_rules: boolean; under_18: boolean | null }
ok(methView.age_status === 'unknown' && methView.under_18_rules === true && methView.under_18 === null, 'unknown: get_methodology says so')
// U7: a single 6/10 is a persistent block under 18 rules (v1.1), a temporary one for an adult (v1.2).
const kneeUnknown = await saveCheckin(storeA, athleteA, { pain: [{ region: 'knee', score: 6 }] })
const todayUnknown = (await athleteReadinessAction(storeA, { action: 'today' }))[0] as { blocked: Array<{ region: string }>; temporary_blocked: Array<{ region: string }>; guardian_required: boolean }
ok(kneeUnknown.ok && todayUnknown.blocked.some((b) => b.region === 'knee') && !todayUnknown.temporary_blocked.some((b) => b.region === 'knee'), 'unknown: a single 6/10 blocks until a clinician clears it (v1.1)')
ok(todayUnknown.guardian_required === true, 'unknown: today says a clear needs a guardian')

// ---- the athlete's "I'm 18 or older" ------------------------------------------------------------
ok(!(await confirmAdult(storeA, coachA)).ok, 'confirm: an MCP coach can\'t set it')
ok(!(await confirmAdult(storeA, appCoach)).ok, 'confirm: app_coach can\'t set it')
ok(!(await confirmAdult(storeA, athleteB)).ok, 'confirm: another athlete can\'t set it')
ok((await zeroedToolsFor(sql, A)).every((t) => !/adult|age_status|confirm_age/.test(t.name)), 'confirm: no MCP tool for it')
await executeDataQuery(sql, { userId: USER_A, athleteId: A }, { table: 'athlete', op: 'update', values: { adult_confirmed_at: new Date().toISOString() }, filters: [{ column: 'id', op: 'eq', value: A }] })
ok((await athleteRow(A)).adult_confirmed_at === null, 'confirm: /api/data can\'t write it')
ok((await count('change_log', `athlete_id = $1 AND tool = 'confirm_adult'`, [A])) === 0, 'confirm: nothing logged by the refusals')
const viewBefore = (await athleteReadinessAction(storeA, { action: 'age' }))[0] as { age_status: string; can_confirm: boolean }
ok(viewBefore.age_status === 'unknown' && viewBefore.can_confirm === true, 'confirm: the app offers it')
const confirmed = (await athleteReadinessAction(storeA, { action: 'confirm_adult' }))[0] as { ok: boolean; change_id: string }
const confirmRow = await lastLog(A, 'confirm_adult')
ok(confirmed.ok && confirmRow?.id === confirmed.change_id && confirmRow.actor_type === 'athlete' && /^tap:/.test(String(confirmRow.approval_ref))
  && confirmRow.diff.before === null && typeof confirmRow.diff.after === 'string' && confirmRow.methodology_version != null, 'confirm: a logged athlete write with their tap and the version')
const adult = await resolveMethodology(storeA)
ok((await athleteAge(storeA)).status === 'adult' && adult.minor === false && adult.version === CURRENT_METHODOLOGY.version, 'confirmed: adult rules')
const confirmedRx = await rx()
await setAge(A, yearsAgo(30), false)
ok(await rx() === confirmedRx, 'confirmed: session-rx identical to an adult by birth date')
ok(confirmedRx.includes(`"methodology_version":"${CURRENT_METHODOLOGY.version}"`) && unknownRx.includes(`"methodology_version":"${CURRENT_METHODOLOGY.version}+`), 'confirmed: the prescription records adult rules; unknown age recorded the under-18 ones')
await setAge(A, null, true)
ok((await confirmAdult(storeA, athleteA)).text === 'Already confirmed.', 'confirm: once')
ok(!(await ageView(storeA)).can_confirm, 'confirm: not offered again')
// A birth date under 18 wins over the confirmation.
await harness.query(`UPDATE athlete SET birth_date = $2::date WHERE id = $1`, [A, yearsAgo(15)])
ok((await athleteAge(storeA)).status === 'minor' && (await resolveMethodology(storeA)).minor === true, 'birth date under 18 beats the confirmation')
ok(!(await confirmAdult(storeA, athleteA)).ok, 'confirm: refused while a birth date under 18 is on file')
await harness.query(`UPDATE athlete SET birth_date = NULL WHERE id = $1`, [A])
// Undo: back to unknown, the under-18 rules (it only tightens).
await setAge(A, null, false)
const again = await confirmAdult(storeA, athleteA)
const undo = await tapRevert(String(again.change_id))
ok(again.ok && undo.ok && (await athleteAge(storeA)).status === 'unknown' && (await resolveMethodology(storeA)).minor === true, 'confirm undo: back to unknown, the under-18 rules')
ok((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM change_log WHERE athlete_id = $1 AND tool = 'revert_change' AND revert_of = $2`, [A, again.change_id]))[0].n === '1', 'confirm undo: logged as a revert')

// ---- operator cut-over (worker/schema/ops/confirm-adult.sql) -----------------------------------
const opsSql = readFileSync(join(root, 'worker/schema/ops/confirm-adult.sql'), 'utf8')
ok(opsSql.includes('__ATHLETE_ID__') && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(opsSql), 'ops: a placeholder, never a real id')
ok(opsSql.includes(`'${CURRENT_METHODOLOGY.version}'`), `ops: records the current methodology version (${CURRENT_METHODOLOGY.version})`)
ok(!/\b(DROP|DELETE|TRUNCATE|ALTER)\b/i.test(opsSql.replace(/^--.*$/gm, '')) && !/SET\s+birth_date|training_max_overrides\s*=/i.test(opsSql.replace(/^--.*$/gm, '')), 'ops: never touches the birth date, program data or the schema')
for (const [id, user, name] of [[OPS_ATHLETE, 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'ops synthetic'], [OPS_DOB_ATHLETE, 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'ops synthetic dob']]) {
  await harness.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, `${user.slice(-1)}-ops@example.com`])
  await harness.query(`INSERT INTO athlete (id, auth_user_id, name, training_max_overrides, flags) VALUES ($1, $2, $3, '{"squat": 300}'::jsonb, '{"tracks_v1": true}'::jsonb)`, [id, user, name])
}
await harness.query(`UPDATE athlete SET birth_date = '1990-01-01' WHERE id = $1`, [OPS_DOB_ATHLETE])
let placeholderFails = false
try { await harness.exec(opsSql) } catch { placeholderFails = true }
await harness.exec('ROLLBACK').catch(() => undefined)
ok(placeholderFails && await count('change_log', `actor_id = 'operator'`) === 0, 'ops: unedited, the placeholder fails and nothing is written')
const before = await athleteRow(OPS_ATHLETE)
const opsFor = (id: string) => opsSql.replaceAll('__ATHLETE_ID__', id)
await harness.exec(opsFor(OPS_ATHLETE))
const after = await athleteRow(OPS_ATHLETE)
const opsRow = await lastLog(OPS_ATHLETE, 'confirm_adult')
ok(after.adult_confirmed_at != null && after.birth_date === null && after.rest === before.rest, 'ops: sets the confirmation, leaves the birth date null and every other column alone')
ok(opsRow?.actor_type === 'system' && opsRow.actor_id === 'operator' && opsRow.approval_ref === null && opsRow.methodology_version === CURRENT_METHODOLOGY.version
  && opsRow.diff.summary === 'Adult status confirmed by operator at round-3 cut-over' && opsRow.diff.before === null, 'ops: one system change_log row, the summary and the version')
ok((await athleteAge(makeStore(sql, OPS_ATHLETE))).status === 'adult', 'ops: the athlete is an adult now')
await harness.exec(opsFor(OPS_ATHLETE))
ok((await athleteRow(OPS_ATHLETE)).adult_confirmed_at === after.adult_confirmed_at && await count('change_log', `athlete_id = $1`, [OPS_ATHLETE]) === 1, 'ops: idempotent (run again, nothing changes, no second row)')
await harness.exec(opsFor(OPS_DOB_ATHLETE))
ok((await athleteRow(OPS_DOB_ATHLETE)).adult_confirmed_at === null && (await athleteRow(OPS_DOB_ATHLETE)).birth_date === '1990-01-01' && await count('change_log', `athlete_id = $1`, [OPS_DOB_ATHLETE]) === 0, 'ops: a birth date on file → nothing')
const opsUndo = await tapRevert(opsRow.id, makeStore(sql, OPS_ATHLETE))
ok(opsUndo.ok && (await athleteAge(makeStore(sql, OPS_ATHLETE))).status === 'unknown', 'ops: the athlete can undo the operator\'s confirmation (back to under-18 rules)')
ok(await count('change_log', `athlete_id = ANY($1::uuid[]) AND actor_id = 'operator'`, [[A, B]]) === 0, 'ops: A and B untouched')

// ---- red-flag clears: a guardian under 18 or with no age ----------------------------------------
const flagRegion = async (region: string, store = storeA, actor = coachA, athlete = A) => {
  const p = chp(await call('preview_methodology_override', { path: `U7.regions.${region}.blocked`, value: true, rationale: 'Synthetic red flag (U7).' }, actor, athlete))
  return (await call('apply_methodology_override', { preview_id: p, confirm: true, approval_ref: await tap(p, store, { type: 'athlete', id: athlete }) }, actor, athlete)).includes('change_id')
}
// Unknown age (A has a check-in block on the knee from above).
const alone = await clearRegion(storeA, athleteA, 'knee')
ok(!alone.ok && /age isn't on file/.test(alone.text) && /guardian/.test(alone.text), 'unknown: a check-in clear without a guardian is refused')
ok(!(await clearRegion(storeA, athleteA, 'knee', { confirmed: false, name: 'Sample Guardian' })).ok, 'unknown: an unticked guardian box is refused')
ok(!(await clearRegion(storeA, coachA, 'knee', { confirmed: true })).ok && !(await clearRegion(storeA, appCoach, 'knee', { confirmed: true })).ok, 'clear: no coach can, guardian or not')
const withGuardian = await clearRegion(storeA, athleteA, 'knee', { confirmed: true, name: 'Sample Guardian', relationship: 'parent' })
const regionRow = await lastLog(A, 'clear_region')
const g = regionRow?.diff.guardian as { guardian_confirmed?: boolean; confirmed_at?: string; name?: string; relationship?: string } | undefined
ok(withGuardian.ok && regionRow.id === withGuardian.change_id && g?.guardian_confirmed === true && typeof g.confirmed_at === 'string' && g.name === 'Sample Guardian' && g.relationship === 'parent', 'unknown: accepted with a guardian, recorded in the row')
// A minor by birth date, the rule kind.
await setAge(A, yearsAgo(15), false)
ok(await flagRegion('hip'), 'setup: a red flag on the hip')
ok(!(await clearRedFlag(storeA, athleteA, 'hip')).ok, 'minor: a red-flag clear without a guardian is refused')
const minorFlag = await clearRedFlag(storeA, athleteA, 'hip', { confirmed: true })
const flagRow = await lastLog(A, 'clear_red_flag')
ok(minorFlag.ok && (flagRow?.diff.guardian as { guardian_confirmed?: boolean })?.guardian_confirmed === true && /guardian/.test(String(flagRow.rationale)), 'minor: accepted with a guardian, recorded')
ok(!(await resolveMethodology(storeA)).params.U7.regions.hip?.blocked, 'minor: the red flag is cleared')
// An adult: unchanged, nothing extra asked or recorded.
await setAge(A, null, true)
ok(await flagRegion('elbow'), 'setup: a red flag on the elbow')
const adultClear = await clearRedFlag(storeA, athleteA, 'elbow')
const adultRow = await lastLog(A, 'clear_red_flag')
ok(adultClear.ok && !('guardian' in adultRow.diff) && adultRow.rationale === 'Cleared by a clinician.', 'adult: clears alone, exactly as before')
ok(((await athleteReadinessAction(storeA, { action: 'today' }))[0] as { guardian_required: boolean }).guardian_required === false, 'adult: today asks for no guardian')

// Health off: a coach without health access sees none of it.
ok((await setCoachHealth(storeA, athleteA, TOKEN_A_ID, false)).ok, 'setup: health sharing off for the coach')
const hiddenLog = await call('get_change_log', { since: '2000-01-01', limit: 200 })
ok(!hiddenLog.includes('Sample Guardian') && !hiddenLog.includes('"knee"') && !hiddenLog.includes('guardian_confirmed'), 'health off: no clear details, no guardian, no region')
ok((await call('get_region_status', {})) === HEALTH_HIDDEN, 'health off: region status still hidden')
await setCoachHealth(storeA, athleteA, TOKEN_A_ID, true)

// ---- downgrading a coach voids like a revoke ----------------------------------------------------
const editArgs = { edits: [{ type: 'add_exercise', session_name: 'Age day', exercise_name: 'Face Pull', sets: 2, reps: '15', load: 'light' }] }
const dPreview = chp(await call('preview_program_edits', editArgs, coachD))
const dApproval = await tap(dPreview)
const parked = await call('preview_program_edits', { ...editArgs, edits: [{ ...editArgs.edits[0], exercise_name: 'Band Pull-Apart' }], propose: true, title: 'Synthetic: add a pull-apart' }, coachD)
const proposalId = /proposal ([0-9a-f-]{36})/.exec(parked)?.[1] ?? ''
const aPreview = chp(await call('preview_program_edits', editArgs, coachA))
const bPreview = chp(await call('preview_program_edits', { edits: [{ ...editArgs.edits[0], session_name: 'B day' }] }, coachB, B))
ok(dPreview !== '' && /^tap:/.test(dApproval) && proposalId !== '' && aPreview !== '' && bPreview !== '', 'setup: the coach has an open preview (approved) and a parked proposal')
const down = await setCoachRole(storeA, athleteA, TOKEN_D_ID, 'read')
ok(down.ok && /voided/.test(down.text), 'downgrade: the athlete sets read; told its open work was voided')
ok(await count('change_preview', `preview_id = $1 AND voided_at IS NOT NULL`, [dPreview]) === 1, 'downgrade: its open preview is voided')
ok(await count('coach_proposal', `id = $1 AND status = 'stale' AND voided_at IS NOT NULL`, [proposalId]) === 1, 'downgrade: its pending proposal is voided')
ok(await count('approval', `preview_id = $1 AND voided_at IS NOT NULL`, [dPreview]) === 1, 'downgrade: the athlete\'s approval of it is voided')
const roleRow = await lastLog(A, 'set_coach_role')
const sysRow = await lastLog(A, 'downgrade_coach')
ok(roleRow?.actor_type === 'athlete' && (roleRow.diff.role as { after?: string })?.after === 'read', 'downgrade: the role change is logged (athlete)')
ok(sysRow?.actor_type === 'system' && sysRow.diff.role_change_id === roleRow.id && (sysRow.diff.voided_previews as string[]).includes(dPreview)
  && (sysRow.diff.voided_proposals as string[]).includes(proposalId), 'downgrade: one system row lists what was voided, like a revoke')
ok(await count('change_preview', `preview_id = ANY($1::text[]) AND voided_at IS NULL`, [[aPreview, bPreview]]) === 2, 'downgrade: other coaches\' previews (A\'s other coach, B\'s) untouched')
// Upgrading back revives nothing.
ok((await setCoachRole(storeA, athleteA, TOKEN_D_ID, 'propose')).ok, 'upgrade: back to propose')
ok(await count('change_preview', `preview_id = $1 AND voided_at IS NULL`, [dPreview]) === 0 && await count('coach_proposal', `id = $1 AND status = 'pending'`, [proposalId]) === 0, 'upgrade: nothing revived')
const stale = await call('apply_program_edits', { ...editArgs, preview_id: dPreview, confirm: true, approval_ref: dApproval }, coachD)
ok(/voided|Refused/.test(stale) && !(await call('get_current_program', {})).includes('Face Pull'), 'upgrade: the voided preview can\'t be applied')
ok((await createApproval(storeA, athleteA, { preview_id: dPreview })).ok === false, 'upgrade: the athlete can\'t approve the voided preview again')
ok(await count('change_log', `athlete_id = $1 AND tool = 'downgrade_coach'`, [A]) === 1, 'upgrade: no new void row')
// The undo of the upgrade is a downgrade again: it voids the new work too.
const dPreview2 = chp(await call('preview_program_edits', editArgs, coachD))
const upgradeRow = await lastLog(A, 'set_coach_role')
ok((await tapRevert(upgradeRow.id)).ok && await count('change_preview', `preview_id = $1 AND voided_at IS NOT NULL`, [dPreview2]) === 1, 'downgrade by undo: voids the same way')
ok(await count('change_log', `athlete_id = $1 AND tool = 'downgrade_coach'`, [A]) === 2, 'downgrade by undo: logged')

// ---- isolation ------------------------------------------------------------------------------------
await setAge(B, null, false)
ok((await athleteAge(storeB)).status === 'unknown' && (await resolveMethodology(storeB)).minor === true, 'isolation: A\'s confirmation doesn\'t make B an adult')
ok(!(await setCoachRole(storeB, athleteB, TOKEN_D_ID, 'read')).ok, 'isolation: B can\'t change A\'s coach')
ok(!(await clearRedFlag(storeB, athleteB, 'hip', { confirmed: true })).ok, 'isolation: B can\'t clear A\'s blocks')
ok((await confirmAdult(storeB, athleteB)).ok && (await athleteAge(storeA)).adultConfirmedAt != null, 'isolation: B confirms only B')
ok(await count('change_log', `athlete_id = $1 AND tool IN ('clear_region', 'clear_red_flag', 'downgrade_coach', 'set_coach_role')`, [B]) === 0, 'isolation: none of A\'s writes landed on B')
ok(await count('change_preview', `preview_id = $1 AND voided_at IS NULL`, [bPreview]) === 1, 'isolation: B\'s coach\'s preview is still open')

await harness.close()
console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`age-status: ok (${harness.backend})`)
