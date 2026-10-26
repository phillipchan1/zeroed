// Standalone access-isolation check against throwaway Postgres
// (ZEROED_TEST_DATABASE_URL) or PGlite when that URL is unset.
// Run: node --experimental-strip-types worker/src/access.check.ts
// Proves: athlete A cannot read, edit, or delete athlete B's rows on every
// store / edits query path. Mutating those SQL filters must make this fail.

import {
  applyEdits,
  assertOwnedForeignKeys,
  athleteOwnsPhase,
  athleteOwnsProgram,
  athleteOwnsRoutine,
  insertOwnedRoutine,
  insertProgramRevision,
  liveToDraft,
  rollbackPhaseWeekEnd,
  scheduleDraftForNextWeek,
  updateOwnedRoutineFks,
  upsertOwnedRoutine,
  writeDraftInPlace,
  type EditInput,
} from './edits.ts'
import { openIsolationHarness } from './isolationDb.ts'
import { resolveMcpToken, sha256Hex } from './mcpToken.ts'
import {
  loadAthlete,
  loadInsights,
  loadJourney,
  loadLiftHistory,
  loadLiveProgram,
  loadNotes,
  loadWorkout,
  loadWorkouts,
  hydrateOwnedWorkout,
  makeStore,
  programIds,
  selectOwnedWorkout,
  workoutProgramOwned,
} from './store.ts'
import { executeZeroedTool } from './tools.ts'
import { executeDataQuery } from './data.ts'
import type { LiveProgram } from './store.ts'
import type { ProgramDraft } from '../../supabase/functions/_shared/engine/programDraft.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

function utcDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const raw = String(value ?? '')
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString().slice(0, 10)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PROG_B = '44444444-4444-4444-4444-444444444444'
const PHASE_A = '55555555-5555-5555-5555-555555555555'
const PHASE_B = '66666666-6666-6666-6666-666666666666'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const ROUTINE_B = '88888888-8888-8888-8888-888888888888'
const WORKOUT_A = '99999999-9999-9999-9999-999999999999'
const WORKOUT_B = 'bbbb9999-9999-4999-8999-999999999999'
const INSIGHT_B = 'bbbb2222-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)

async function count(table: string, where: string, params: unknown[]): Promise<number> {
  const rows = await harness.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params)
  return Number(rows[0]?.n ?? 0)
}

async function scalar<T>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await harness.query<Record<string, T>>(text, params)
  const row = rows[0]
  if (!row) return undefined
  return Object.values(row)[0]
}

// --- reads ---
ok((await programIds(storeA)).join() === PROG_A, 'programIds: A sees only own program')
ok((await programIds(storeB)).join() === PROG_B, 'programIds: B sees only own program')

const athleteA = await loadAthlete(storeA)
const athleteB = await loadAthlete(storeB)
ok(athleteA.id === A && athleteA.name === 'Athlete A', 'loadAthlete: A is A')
ok(athleteA.goals === 'A only goal', 'loadAthlete: A does not see B goals')
ok(athleteB.id === B, 'loadAthlete: B is B')
ok(athleteA.current_phase === 'Strength' && utcDay(athleteA.retest_date) === '2026-12-01', 'loadAthlete profile: A phase is A')
ok(athleteB.current_phase === 'Power' && utcDay(athleteB.retest_date) === '2026-12-15', 'loadAthlete profile: B phase is B')

const liveA = await loadLiveProgram(storeA)
const liveB = await loadLiveProgram(storeB)
ok(liveA?.programId === PROG_A && liveA.sessions.every((s) => s.routineId === ROUTINE_A), 'loadLiveProgram: A week only')
ok(liveB?.programId === PROG_B && !liveA?.sessions.some((s) => s.name === 'B day'), 'loadLiveProgram: A does not see B day')
ok(liveA?.phaseName === 'Strength' && liveB?.phaseName === 'Power', 'loadLiveProgram: phases stay separate')
ok(liveA?.standingPreferences === 'A prefers hills' && liveA.sessionsPerWeek === 3, 'loadLiveProgram prefs: A standing prefs')
ok(liveB?.standingPreferences === 'B prefers ergs' && liveB.sessionsPerWeek === 4, 'loadLiveProgram prefs: B standing prefs')

const insightsA = await loadInsights(storeA, true)
const insightsB = await loadInsights(storeB, true)
ok(insightsA.every((i) => i.claim !== 'B only') && insightsA.some((i) => i.claim === 'A only'), 'loadInsights settled: A cannot read B claim')
ok(insightsB.length === 1 && insightsB[0]?.claim === 'B only', 'loadInsights settled: B sees own claim')
const openA = await loadInsights(storeA)
const openB = await loadInsights(storeB)
ok(openA.length === 1 && openA[0]?.claim === 'A only' && openA[0]?.status !== 'resolved', 'loadInsights open: A open only')
ok(!openA.some((i) => i.claim === 'B only'), 'loadInsights open: A cannot read B claim')
ok(openB.length === 1 && openB[0]?.claim === 'B only', 'loadInsights open: B open only')

const workoutsA = await loadWorkouts(storeA)
const workoutsB = await loadWorkouts(storeB)
ok(workoutsA.length === 1 && workoutsA[0]?.id === WORKOUT_A, 'loadWorkouts: A lists own workout')
ok(!workoutsA.some((w) => w.id === WORKOUT_B), 'loadWorkouts: A cannot list B workout')
ok(workoutsB.length === 1 && workoutsB[0]?.id === WORKOUT_B, 'loadWorkouts: B lists own workout')

const ownWorkout = await loadWorkout(storeA, WORKOUT_A)
const crossed = await loadWorkout(storeA, WORKOUT_B)
const bOwn = await loadWorkout(storeB, WORKOUT_B)
ok(ownWorkout?.workout.id === WORKOUT_A, 'loadWorkout: A can read own id')
ok(crossed === null, 'loadWorkout: A asking for B workout_id gets null')
ok(bOwn?.workout.id === WORKOUT_B, 'loadWorkout: B can read own id')
ok(ownWorkout?.observations.every((o) => o.signal !== 'B felt good') ?? false, 'loadWorkout: A observations are A')
ok(await loadWorkout(storeB, WORKOUT_A) === null, 'loadWorkout: B asking for A workout_id gets null')
ok(await selectOwnedWorkout(storeA, WORKOUT_B) === null, 'selectOwnedWorkout: SQL athlete_id hides B')
ok((await selectOwnedWorkout(storeA, WORKOUT_A))?.id === WORKOUT_A, 'selectOwnedWorkout: A own row')
ok(await workoutProgramOwned(storeA, PROG_A), 'loadWorkout second check: A owns A program')
ok(!(await workoutProgramOwned(storeA, PROG_B)), 'loadWorkout second check: A does not own B program')
ok(!(await workoutProgramOwned(storeB, PROG_A)), 'loadWorkout second check: B does not own A program')
const bRowForA = await selectOwnedWorkout(storeB, WORKOUT_B)
ok(bRowForA?.r_program_id === PROG_B, 'seed: B workout row has B program')
ok(
  await hydrateOwnedWorkout(storeA, bRowForA ?? null, WORKOUT_B) === null,
  'loadWorkout second check: A cannot hydrate B row',
)
ok(
  (await hydrateOwnedWorkout(storeB, bRowForA ?? null, WORKOUT_B))?.workout.id === WORKOUT_B,
  'loadWorkout second check: B can hydrate own row',
)

const liftsA = await loadLiftHistory(storeA, 'Deadlift')
const liftsB = await loadLiftHistory(storeB, 'Deadlift')
ok(liftsA.points.length === 0, 'loadLiftHistory: A cannot see B deadlifts')
ok(liftsB.points.length === 1, 'loadLiftHistory: B sees own deadlifts')

const journeyA = await loadJourney(storeA)
const journeyB = await loadJourney(storeB)
ok(journeyA.revisions.every((r) => r.summary !== 'B revision'), 'loadJourney: A cannot read B revisions')
ok(journeyB.revisions.some((r) => r.summary === 'B revision'), 'loadJourney: B sees own revisions')
ok(journeyA.blocks.every((b) => b.name !== 'Power'), 'loadJourney: A blocks are not B Power')

const notesA = await loadNotes(storeA)
const notesB = await loadNotes(storeB)
ok(notesA.weekly.every((w) => w.coach_notes !== 'B weekly note'), 'loadNotes: A cannot read B weekly')
ok(notesA.coach.every((m) => m.body !== 'private B'), 'loadNotes: A cannot read B coach log')
ok(notesB.coach.some((m) => m.body === 'private B'), 'loadNotes: B sees own coach log')

const mcpAsA = await executeZeroedTool(sql, A, 'get_workout', { workout_id: WORKOUT_B })
ok(mcpAsA.includes('No workout') && !mcpAsA.includes('Deadlift'), 'MCP get_workout: A asking for B is a miss')
const mcpOwn = await executeZeroedTool(sql, A, 'get_workout', { workout_id: WORKOUT_A })
ok(mcpOwn.includes('Back Squat'), 'MCP get_workout: A own workout succeeds')

const tokenA = await resolveMcpToken(sql, 'not-a-real-token')
ok(tokenA === null, 'resolveMcpToken: unknown token is null')
const [hashRow] = await sql<{ token_hash: string; athlete_id: string }[]>`
  SELECT token_hash, athlete_id FROM mcp_token WHERE athlete_id = ${B} LIMIT 1
`
ok(hashRow?.athlete_id === B, 'seed: B token exists')
const [bTok] = await sql<{ athlete_id: string }[]>`
  SELECT athlete_id FROM mcp_token WHERE token_hash = ${'hash-b'} AND revoked_at IS NULL LIMIT 1
`
ok(bTok?.athlete_id === B, 'mcp_token lookup by hash does not leak A')

const revokedPlain = 'zeroed-mcp-revoked-access-check'
const expiredPlain = 'zeroed-mcp-expired-access-check'
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(revokedPlain)} WHERE name = ${'revoked-a'}`
await sql`UPDATE mcp_token SET token_hash = ${await sha256Hex(expiredPlain)} WHERE name = ${'expired-a'}`
ok(await resolveMcpToken(sql, revokedPlain) === null, 'resolveMcpToken: revoked token is null')
ok(await resolveMcpToken(sql, expiredPlain) === null, 'resolveMcpToken: expired token is null')
ok(await athleteOwnsProgram(storeA, PROG_A) && !(await athleteOwnsProgram(storeA, PROG_B)), 'athleteOwnsProgram: A cannot claim B program')
ok(await athleteOwnsPhase(storeA, PHASE_A) && !(await athleteOwnsPhase(storeA, PHASE_B)), 'athleteOwnsPhase: A cannot claim B phase')
ok(await athleteOwnsRoutine(storeA, ROUTINE_A) && !(await athleteOwnsRoutine(storeA, ROUTINE_B)), 'athleteOwnsRoutine: A cannot claim B routine')
ok(await assertOwnedForeignKeys(storeA, { programId: PROG_A, phaseId: PHASE_A, routineId: ROUTINE_A }), 'assertOwnedForeignKeys: A own tree')
ok(!(await assertOwnedForeignKeys(storeA, { programId: PROG_B })), 'assertOwnedForeignKeys: A cannot take B program')
ok(!(await assertOwnedForeignKeys(storeA, { phaseId: PHASE_B })), 'assertOwnedForeignKeys: A cannot take B phase')
ok(!(await assertOwnedForeignKeys(storeA, { routineId: ROUTINE_B })), 'assertOwnedForeignKeys: A cannot take B routine')

// --- edits / writes ---
if (!liveA || !liveB) throw new Error('expected both live programs')

const forgedLive: LiveProgram = {
  ...liveB,
  sessions: liveB.sessions.map((s) => ({ ...s })),
}
const stolenDraft: ProgramDraft = {
  sessionsPerWeek: liveB.sessionsPerWeek,
  sessions: liveB.sessions.map((s) => ({
    routineId: s.routineId,
    name: 'Hacked by A',
    intent: 'steal',
    sessionType: s.sessionType,
    intendedDow: s.intendedDow,
    exercises: s.exercises.map((ex) => ({ ...ex })),
  })),
}
const writeErrors: string[] = []
const writtenStolen = await writeDraftInPlace(storeA, forgedLive, stolenDraft, writeErrors)
ok(writtenStolen === 0, 'writeDraftInPlace: A cannot UPDATE B routine')
ok(writeErrors.some((e) => e.includes('not found') || e.includes('not owned')), 'writeDraftInPlace: B routine refused')
ok((await scalar<string>('SELECT name FROM routine WHERE id = $1', [ROUTINE_B])) === 'B day', 'writeDraftInPlace: B routine name unchanged')

const insertDraft: ProgramDraft = {
  sessionsPerWeek: 1,
  sessions: [{
    routineId: null,
    name: 'A planted on B',
    intent: 'steal',
    sessionType: 'strength',
    intendedDow: 2,
    exercises: [{ name: 'Hack', sets: 1, reps: '1', load: 'light', cue: '' }],
  }],
}
const insertErrors: string[] = []
const planted = await writeDraftInPlace(storeA, forgedLive, insertDraft, insertErrors)
ok(planted === 0, 'writeDraftInPlace: A cannot INSERT onto B program')
ok((await count('routine', 'program_id = $1', [PROG_B])) === 1, 'writeDraftInPlace: B still has one routine')

const phasePlantErrors: string[] = []
const plantedOnBPhase = await writeDraftInPlace(
  storeA,
  { ...liveA, phaseId: PHASE_B },
  insertDraft,
  phasePlantErrors,
)
ok(plantedOnBPhase === 0, 'writeDraftInPlace: A cannot INSERT routine onto B phase')
ok((await count('routine', 'phase_id = $1', [PHASE_B])) === 1, 'writeDraftInPlace: B phase still has one routine')

const NEW_ROUTINE = 'cccccccc-0000-4000-8000-000000000001'
ok(
  (await insertOwnedRoutine(storeA, {
    programId: PROG_B,
    phaseId: PHASE_A,
    name: 'A on B program',
    sessionType: 'strength',
    exercises: [],
    intent: 'steal',
    intendedDow: 2,
  })) === null,
  'insertOwnedRoutine: A cannot insert onto B program + A phase',
)
ok(
  (await insertOwnedRoutine(storeA, {
    programId: PROG_A,
    phaseId: PHASE_B,
    name: 'A on B phase',
    sessionType: 'strength',
    exercises: [],
    intent: 'steal',
    intendedDow: 2,
  })) === null,
  'insertOwnedRoutine: A cannot insert onto A program + B phase',
)
ok((await count('routine', 'name = $1', ['A on B program'])) === 0, 'insertOwnedRoutine: B-program name absent')
ok((await count('routine', 'name = $1', ['A on B phase'])) === 0, 'insertOwnedRoutine: B-phase name absent')

const upsertStealId = await upsertOwnedRoutine(storeA, {
  id: ROUTINE_B,
  programId: PROG_A,
  phaseId: PHASE_A,
  name: 'stolen upsert',
  sessionType: 'strength',
  exercises: [],
  intent: 'steal',
  intendedDow: 1,
})
ok(upsertStealId === 0, 'upsertOwnedRoutine: A cannot take B routine id')
ok((await scalar<string>('SELECT name FROM routine WHERE id = $1', [ROUTINE_B])) === 'B day', 'upsertOwnedRoutine: B name unchanged')

const upsertBProgram = await upsertOwnedRoutine(storeA, {
  id: NEW_ROUTINE,
  programId: PROG_B,
  phaseId: PHASE_A,
  name: 'upsert B program',
  sessionType: 'strength',
  exercises: [],
  intent: 'steal',
  intendedDow: 2,
})
ok(upsertBProgram === 0, 'upsertOwnedRoutine: A cannot insert onto B program')
ok((await count('routine', 'id = $1', [NEW_ROUTINE])) === 0, 'upsertOwnedRoutine: new id on B program absent')

const upsertBPhase = await upsertOwnedRoutine(storeA, {
  id: NEW_ROUTINE,
  programId: PROG_A,
  phaseId: PHASE_B,
  name: 'upsert B phase',
  sessionType: 'strength',
  exercises: [],
  intent: 'steal',
  intendedDow: 2,
})
ok(upsertBPhase === 0, 'upsertOwnedRoutine: A cannot insert onto B phase')
ok((await count('routine', 'name = $1', ['upsert B phase'])) === 0, 'upsertOwnedRoutine: B-phase upsert absent')

ok(
  (await updateOwnedRoutineFks(storeA, ROUTINE_A, { programId: PROG_B, phaseId: PHASE_A })) === 0,
  'updateOwnedRoutineFks: A cannot repoint own routine to B program',
)
ok(
  (await scalar<string>('SELECT program_id::text FROM routine WHERE id = $1', [ROUTINE_A])) === PROG_A,
  'updateOwnedRoutineFks: A routine still on A program',
)
ok(
  (await updateOwnedRoutineFks(storeA, ROUTINE_A, { programId: PROG_A, phaseId: PHASE_B })) === 0,
  'updateOwnedRoutineFks: A cannot repoint own routine to B phase',
)
ok(
  (await scalar<string>('SELECT phase_id::text FROM routine WHERE id = $1', [ROUTINE_A])) === PHASE_A,
  'updateOwnedRoutineFks: A routine still on A phase',
)
ok(
  (await updateOwnedRoutineFks(storeA, ROUTINE_B, { programId: PROG_A, phaseId: PHASE_A })) === 0,
  'updateOwnedRoutineFks: A cannot steal B routine onto A program',
)
ok(
  (await scalar<string>('SELECT program_id::text FROM routine WHERE id = $1', [ROUTINE_B])) === PROG_B,
  'updateOwnedRoutineFks: B routine still on B program',
)

const rename: EditInput[] = [{
  type: 'update_session',
  session_name: 'A day',
  set_name: 'A day retuned',
  rationale: 'isolation write',
}]
const applied = await applyEdits(storeA, rename, { confirm: true, timing: 'now' })
ok(applied.includes('Applied now') || applied.includes('Wrote'), 'applyEdits: A can edit own week')
ok((await scalar<string>('SELECT name FROM routine WHERE id = $1', [ROUTINE_A])) === 'A day retuned', 'applyEdits: A routine updated')
ok((await scalar<string>('SELECT name FROM routine WHERE id = $1', [ROUTINE_B])) === 'B day', 'applyEdits: B routine untouched')
ok((await count('program_revision', 'program_id = $1', [PROG_B])) === 1, 'applyEdits: no extra B revision')
ok((await scalar<string>('SELECT name FROM athlete WHERE id = $1', [B])) === 'Athlete B', 'applyEdits: B athlete row untouched')

const sneakB: EditInput[] = [{
  type: 'update_session',
  session_name: 'B day',
  set_name: 'should not apply',
  rationale: 'cross',
}]
const sneak = await applyEdits(storeA, sneakB, { confirm: true, timing: 'now' })
ok(!sneak.includes('should not apply') || sneak.includes('skipped') || sneak.includes('Nothing'), 'applyEdits: A cannot target B session name on A week')
ok((await scalar<string>('SELECT name FROM routine WHERE id = $1', [ROUTINE_B])) === 'B day', 'applyEdits sneak: B name still B day')

const bSessions = Number(await scalar<number | string>('SELECT sessions_per_week FROM athlete WHERE id = $1', [B]))
const bPrefs = await scalar<string>('SELECT training_preferences FROM athlete WHERE id = $1', [B])
await applyEdits(storeA, [{
  type: 'set_sessions_per_week',
  sessions_per_week: 5,
  rationale: 'isolation days',
}], { confirm: true, timing: 'now', request: 'A wants more days' })
ok(Number(await scalar<number | string>('SELECT sessions_per_week FROM athlete WHERE id = $1', [A])) === 5, 'applyEdits: A sessions_per_week updated')
ok(Number(await scalar<number | string>('SELECT sessions_per_week FROM athlete WHERE id = $1', [B])) === bSessions, 'applyEdits: B sessions_per_week untouched')
ok((await scalar<string>('SELECT training_preferences FROM athlete WHERE id = $1', [B])) === bPrefs, 'applyEdits: B training_preferences untouched')
ok(
  String(await scalar<string>('SELECT training_preferences FROM athlete WHERE id = $1', [A])).includes('A wants more days'),
  'applyEdits: A training_preferences updated',
)

const bWeekEnd = await scalar<string>('SELECT week_end::text FROM phase WHERE id = $1', [PHASE_B])
const closeErrors: string[] = []
const closedB = await scheduleDraftForNextWeek(storeA, liveB, liveToDraft(liveB), closeErrors, '2026-11-02')
ok(closedB === 0, 'scheduleDraft: A cannot close B phase')
ok(closeErrors.some((e) => e.includes("couldn't close")), 'scheduleDraft: close refused (athlete filter)')
ok((await scalar<string>('SELECT week_end::text FROM phase WHERE id = $1', [PHASE_B])) === bWeekEnd, 'scheduleDraft: B week_end unchanged')
ok((await count('phase', 'program_id = $1', [PROG_B])) === 1, 'scheduleDraft: no extra B phase after close attempt')

const bPhaseCount = await count('phase', 'program_id = $1', [PROG_B])
const plantErrors: string[] = []
const plantedPhase = await scheduleDraftForNextWeek(
  storeA,
  { ...liveA, programId: PROG_B },
  liveToDraft(liveA),
  plantErrors,
  '2026-11-02',
)
ok(plantedPhase === 0, 'scheduleDraft: A cannot INSERT phase onto B program')
ok(plantErrors.some((e) => e.includes("couldn't schedule") || e.includes("couldn't close")), 'scheduleDraft: B program insert refused')
ok((await count('phase', 'program_id = $1', [PROG_B])) === bPhaseCount, 'scheduleDraft: B phase count unchanged')

const bEndBeforeRollback = await scalar<string>('SELECT week_end::text FROM phase WHERE id = $1', [PHASE_B])
await rollbackPhaseWeekEnd(storeA, PHASE_B, '2020-01-05')
ok(
  (await scalar<string>('SELECT week_end::text FROM phase WHERE id = $1', [PHASE_B])) === bEndBeforeRollback,
  'rollbackPhase: A cannot rewrite B week_end',
)

const bRevs = await count('program_revision', 'program_id = $1', [PROG_B])
const stolenRevOnAPhase = await insertProgramRevision(storeA, { programId: PROG_B, phaseId: PHASE_A }, {
  trigger: 'editor',
  effectiveOn: '2026-10-26',
  requests: ['steal-program'],
  snapshot: [],
  diff: {},
  summary: 'stolen-program',
})
ok(stolenRevOnAPhase === 0, 'insertProgramRevision: A cannot write B program + A phase')
ok((await count('program_revision', 'summary = $1', ['stolen-program'])) === 0, 'insertProgramRevision: stolen-program absent')

const stolenRevOnBPhase = await insertProgramRevision(storeA, { programId: PROG_A, phaseId: PHASE_B }, {
  trigger: 'editor',
  effectiveOn: '2026-10-26',
  requests: ['steal-phase'],
  snapshot: [],
  diff: {},
  summary: 'stolen-phase',
})
ok(stolenRevOnBPhase === 0, 'insertProgramRevision: A cannot write A program + B phase')
ok((await count('program_revision', 'summary = $1', ['stolen-phase'])) === 0, 'insertProgramRevision: stolen-phase absent')

const stolenRev = await insertProgramRevision(storeA, { programId: PROG_B, phaseId: PHASE_B }, {
  trigger: 'editor',
  effectiveOn: '2026-10-26',
  requests: ['steal'],
  snapshot: [],
  diff: {},
  summary: 'stolen',
})
ok(stolenRev === 0, 'insertProgramRevision: A cannot write B revision')
ok((await count('program_revision', 'program_id = $1', [PROG_B])) === bRevs, 'insertProgramRevision: B revision count unchanged')
ok((await count('program_revision', 'summary = $1', ['stolen'])) === 0, 'insertProgramRevision: stolen summary absent')

// --- client data plane (/api/data) — same owner predicates, no RLS ---
const AUTH_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const AUTH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ctxA = { userId: AUTH_A, athleteId: A }
const ctxB = { userId: AUTH_B, athleteId: B }

const dataAthletes = await executeDataQuery(sql, ctxA, { table: 'athlete', op: 'select', columns: 'id, name' })
ok(
  Array.isArray(dataAthletes.data)
    && (dataAthletes.data as { id: string }[]).every((r) => r.id === A)
    && (dataAthletes.data as { id: string }[]).length === 1,
  'data athlete: A lists only self',
)

const dataInsights = await executeDataQuery(sql, ctxA, { table: 'insight', op: 'select', columns: 'claim' })
ok(
  Array.isArray(dataInsights.data)
    && (dataInsights.data as { claim: string }[]).every((r) => r.claim !== 'B only')
    && (dataInsights.data as { claim: string }[]).some((r) => r.claim === 'A only'),
  'data insight: A cannot list B claims',
)

const dataPhases = await executeDataQuery(sql, ctxA, { table: 'phase', op: 'select', columns: 'name' })
ok(
  Array.isArray(dataPhases.data)
    && (dataPhases.data as { name: string }[]).every((r) => r.name !== 'Power'),
  'data phase: A cannot list B Power',
)

const dataWorkouts = await executeDataQuery(sql, ctxA, { table: 'workout', op: 'select', columns: 'id' })
ok(
  Array.isArray(dataWorkouts.data)
    && (dataWorkouts.data as { id: string }[]).every((r) => r.id === WORKOUT_A)
    && !(dataWorkouts.data as { id: string }[]).some((r) => r.id === WORKOUT_B),
  'data workout: A lists only own',
)

const dataObs = await executeDataQuery(sql, ctxA, { table: 'session_observation', op: 'select', columns: 'signal' })
ok(
  Array.isArray(dataObs.data)
    && (dataObs.data as { signal: string }[]).every((r) => r.signal !== 'B felt good'),
  'data observation: A cannot list B signal',
)

const loadedOwn = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'select',
  columns: 'id, rpe, routine!inner(program_id)',
  filters: [{ column: 'id', op: 'eq', value: WORKOUT_A }],
  single: 'maybe',
})
ok((loadedOwn.data as { id: string } | null)?.id === WORKOUT_A, 'smoke load workout: A reads own row')
ok((loadedOwn.data as { routine?: { program_id: string } } | null)?.routine?.program_id === PROG_A, 'data workout embed: routine.program_id is A')

const loadedB = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'select',
  columns: '*',
  filters: [{ column: 'id', op: 'eq', value: WORKOUT_B }],
  single: 'maybe',
})
ok(loadedB.data == null, 'data workout: A asking for B id is empty')

const plantedWorkout = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'insert',
  values: { routine_id: ROUTINE_B, rpe: 5, performed_at: '2026-10-23T12:00:00Z' },
  returning: '*',
  single: 'one',
})
ok(Boolean(plantedWorkout.error) || plantedWorkout.data == null, 'data insert: A cannot save onto B routine')
ok((await count('workout', 'routine_id = $1', [ROUTINE_B])) === 1, 'data insert: B still has one workout')

const savedWorkout = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'insert',
  values: { routine_id: ROUTINE_A, rpe: 6, performed_at: '2026-10-23T15:00:00Z' },
  returning: '*',
  single: 'one',
})
const savedId = (savedWorkout.data as { id: string } | null)?.id
ok(savedId != null && savedWorkout.error == null, 'smoke save workout: A insert succeeds')
ok((await count('workout', 'id = $1 AND routine_id = $2', [savedId, ROUTINE_A])) === 1, 'smoke save workout: row landed on A routine')

const savedAgain = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'update',
  values: { rpe: 7 },
  filters: [{ column: 'id', op: 'eq', value: savedId }],
  returning: '*',
  single: 'maybe',
})
ok((savedAgain.data as { rpe: number } | null)?.rpe === 7, 'smoke save workout: A update succeeds')

const stealUpdate = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'update',
  values: { rpe: 1 },
  filters: [{ column: 'id', op: 'eq', value: WORKOUT_B }],
})
ok(stealUpdate.error == null, 'data update: forged B id is not an error')
ok(Number(await scalar<number | string>('SELECT rpe FROM workout WHERE id = $1', [WORKOUT_B])) === 9, 'data update: B rpe unchanged')

const stealProfile = await executeDataQuery(sql, ctxA, {
  table: 'athlete_profile',
  op: 'update',
  values: { current_phase: 'Hacked' },
  filters: [{ column: 'athlete_id', op: 'eq', value: B }],
})
ok((await scalar<string>('SELECT current_phase FROM athlete_profile WHERE athlete_id = $1', [B])) === 'Power', 'data profile: B phase unchanged')
ok(stealProfile.error == null, 'data profile: forged B athlete_id update is a no-op')

const ownDraft = await executeDataQuery(sql, ctxA, {
  table: 'workout_draft',
  op: 'upsert',
  values: {
    athlete_id: B,
    routine_id: ROUTINE_A,
    set_logs: { '0': [] },
    feedback: {},
    elapsed_seconds: 12,
    started_at: '2026-10-21T12:00:00Z',
    updated_at: '2026-10-21T12:00:00Z',
  },
  onConflict: 'athlete_id,routine_id',
  returning: '*',
  single: 'maybe',
})
ok((ownDraft.data as { athlete_id: string } | null)?.athlete_id === A, 'data draft: insert forces A athlete_id')
ok((await count('workout_draft', 'athlete_id = $1', [B])) === 0, 'data draft: B has no planted draft')

const bDraft = await executeDataQuery(sql, ctxB, { table: 'workout_draft', op: 'select', columns: 'athlete_id' })
ok(Array.isArray(bDraft.data) && (bDraft.data as unknown[]).length === 0, 'data draft: B cannot read A draft')

const stealToken = await executeDataQuery(sql, ctxA, {
  table: 'mcp_token',
  op: 'update',
  values: { revoked_at: '2026-10-21T00:00:00Z' },
  filters: [{ column: 'athlete_id', op: 'eq', value: B }],
})
ok((await count('mcp_token', 'athlete_id = $1 AND revoked_at IS NOT NULL', [B])) === 0, 'data mcp_token: B token not revoked by A')
ok(stealToken.error == null, 'data mcp_token: forged update is a no-op')

// --- deletes (same athlete_id / program-join scoping as store/edits) ---
const deletedWorkout = await sql<{ id: string }[]>`
  DELETE FROM workout w
  USING routine r, program p
  WHERE w.id = ${WORKOUT_B}
    AND r.id = w.routine_id
    AND p.id = r.program_id
    AND p.athlete_id = ${storeA.athleteId}
  RETURNING w.id
`
ok(deletedWorkout.length === 0, 'DELETE workout: A cannot delete B workout')
ok((await count('workout', 'id = $1', [WORKOUT_B])) === 1, 'DELETE workout: B row still present')

const deletedInsight = await sql<{ id: string }[]>`
  DELETE FROM insight
  WHERE id = ${INSIGHT_B} AND athlete_id = ${storeA.athleteId}
  RETURNING id
`
ok(deletedInsight.length === 0, 'DELETE insight: A cannot delete B insight')
ok((await count('insight', 'id = $1', [INSIGHT_B])) === 1, 'DELETE insight: B row still present')

const deletedRoutine = await sql<{ id: string }[]>`
  DELETE FROM routine r
  USING program p
  WHERE r.id = ${ROUTINE_B}
    AND r.program_id = p.id
    AND p.athlete_id = ${storeA.athleteId}
  RETURNING r.id
`
ok(deletedRoutine.length === 0, 'DELETE routine: A cannot delete B routine')
ok((await count('routine', 'id = $1', [ROUTINE_B])) === 1, 'DELETE routine: B row still present')

const deletedNote = await sql<{ id: string }[]>`
  DELETE FROM coach_message
  WHERE athlete_id = ${storeA.athleteId} AND body = ${'private B'}
  RETURNING id
`
ok(deletedNote.length === 0, 'DELETE coach_message: A cannot delete B note')

// A can still delete (or update) own scoped rows — insight is athlete_id gated.
const deletedOwnInsight = await sql<{ id: string }[]>`
  DELETE FROM insight
  WHERE athlete_id = ${storeA.athleteId} AND claim = ${'A only'}
  RETURNING id
`
ok(deletedOwnInsight.length === 1, 'DELETE insight: A can delete own row')
ok((await count('insight', 'athlete_id = $1', [B])) === 1, 'DELETE insight: B insight survived A own delete')

ok((await loadWorkout(storeA, WORKOUT_A))?.workout.routine_id === ROUTINE_A, 'post-write: A workout still readable')
ok((await loadWorkout(storeA, WORKOUT_B)) === null, 'post-write: B workout still hidden from A')

// --- B1 cross-user upsert (must fail before owner WHERE on DO UPDATE) ---
const stealProgram = await executeDataQuery(sql, ctxA, {
  table: 'program',
  op: 'upsert',
  values: { id: PROG_B, goal: 'stolen-by-A', status: 'active' },
  onConflict: 'id',
  returning: '*',
  single: 'maybe',
})
ok(stealProgram.status === 404, 'data upsert: stealing B program is 404')
ok(
  Boolean(stealProgram.error) || stealProgram.data == null || (stealProgram.data as { id?: string }).id !== PROG_B,
  'data upsert: A cannot take B program id',
)
ok((await scalar<string>('SELECT athlete_id::text FROM program WHERE id = $1', [PROG_B])) === B, 'data upsert: B program athlete_id unchanged')
ok((await count('workout', 'id = $1', [WORKOUT_B])) === 1, 'data upsert: B workout still on B tree')

const stealWorkout = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'upsert',
  values: { id: WORKOUT_B, routine_id: ROUTINE_A, rpe: 1, performed_at: '2026-10-23T12:00:00Z' },
  onConflict: 'id',
  returning: '*',
  single: 'maybe',
})
ok(stealWorkout.status === 404, 'data upsert: stealing B workout is 404')
ok(Boolean(stealWorkout.error) || stealWorkout.data == null, 'data upsert: A cannot take B workout id')
ok((await scalar<string>('SELECT routine_id::text FROM workout WHERE id = $1', [WORKOUT_B])) === ROUTINE_B, 'data upsert: B workout routine unchanged')

// --- B2 FK repoint into B's tree ---
const plantedDraft = await executeDataQuery(sql, ctxA, {
  table: 'workout_draft',
  op: 'upsert',
  values: {
    routine_id: ROUTINE_A,
    set_logs: {},
    feedback: {},
    elapsed_seconds: 1,
    started_at: '2026-10-21T12:00:00Z',
    updated_at: '2026-10-21T12:00:00Z',
  },
  onConflict: 'athlete_id,routine_id',
  returning: '*',
  single: 'one',
})
const draftId = (plantedDraft.data as { id: string } | null)?.id
ok(draftId != null && plantedDraft.error == null, 'data draft: A can upsert own draft')

const repointObs = await executeDataQuery(sql, ctxA, {
  table: 'session_observation',
  op: 'update',
  values: { workout_id: WORKOUT_B },
  filters: [{ column: 'id', op: 'eq', value: 'aaaa1111-0000-4000-8000-000000000001' }],
  returning: '*',
})
ok(
  Boolean(repointObs.error) || Number(repointObs.count ?? 0) === 0,
  'data update: A cannot repoint observation onto B workout',
)
ok(
  (await scalar<string>('SELECT workout_id::text FROM session_observation WHERE id = $1', ['aaaa1111-0000-4000-8000-000000000001'])) === WORKOUT_A,
  'data update: A observation still on A workout',
)

const aRoutinePhase = await scalar<string>('SELECT phase_id::text FROM routine WHERE id = $1', [ROUTINE_A])
const repointPhase = await executeDataQuery(sql, ctxA, {
  table: 'routine',
  op: 'update',
  values: { phase_id: PHASE_B },
  filters: [{ column: 'id', op: 'eq', value: ROUTINE_A }],
  returning: '*',
})
ok(
  Boolean(repointPhase.error) || Number(repointPhase.count ?? 0) === 0,
  'data update: A cannot repoint routine onto B phase',
)
ok((await scalar<string>('SELECT phase_id::text FROM routine WHERE id = $1', [ROUTINE_A])) === aRoutinePhase, 'data update: A routine phase unchanged')

const repointDraft = await executeDataQuery(sql, ctxA, {
  table: 'workout_draft',
  op: 'update',
  values: { routine_id: ROUTINE_B },
  filters: [{ column: 'id', op: 'eq', value: draftId }],
})
ok(
  Boolean(repointDraft.error) || Number(repointDraft.count ?? 0) === 0,
  'data update: A cannot repoint draft onto B routine',
)
ok((await scalar<string>('SELECT routine_id::text FROM workout_draft WHERE id = $1', [draftId])) === ROUTINE_A, 'data update: A draft still on A routine')

// --- B3 embed must not leak B's child after a repoint attempt ---
const embedDraft = await executeDataQuery(sql, ctxA, {
  table: 'workout_draft',
  op: 'select',
  columns: 'id, routine:routine_id(name,exercises,program_id)',
  filters: [{ column: 'id', op: 'eq', value: draftId }],
  single: 'maybe',
})
const embedRoutine = (embedDraft.data as { routine?: { name?: string; program_id?: string } } | null)?.routine
ok(embedRoutine?.name !== 'B day', 'data embed: A draft does not leak B routine name')
ok(embedRoutine?.program_id !== PROG_B, 'data embed: A draft does not leak B program_id')

const xminEmbed = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'select',
  columns: 'id, routine!inner(xmin)',
})
ok(Boolean(xminEmbed.error), 'data embed: xmin is not an allowed column')
ok(!String(xminEmbed.error?.message ?? '').includes('does not exist'), 'data embed: xmin error is generic')

const deleteProgram = await executeDataQuery(sql, ctxA, {
  table: 'program',
  op: 'delete',
  filters: [{ column: 'id', op: 'eq', value: PROG_A }],
})
ok(Boolean(deleteProgram.error), 'data delete: program is not deletable')
ok((await count('program', 'id = $1', [PROG_A])) === 1, 'data delete: A program still present')
ok((await count('program', 'id = $1', [PROG_B])) === 1, 'data delete: B program still present')

const NOTE_A = 'aaaa5555-0000-4000-8000-000000000001'
const deleteOwnNote = await executeDataQuery(sql, ctxA, {
  table: 'coach_message',
  op: 'delete',
  filters: [{ column: 'id', op: 'eq', value: NOTE_A }],
})
ok(deleteOwnNote.status === 404, 'data delete: coach_message is not deletable')
ok((await count('coach_message', 'id = $1', [NOTE_A])) === 1, 'data delete: A coach_message still present')

const PLANTED_DRAFT = 'aaaa7777-0000-4000-8000-000000000001'
await sql.unsafe(
  `INSERT INTO workout_draft (id, athlete_id, routine_id, set_logs, feedback, elapsed_seconds, started_at, updated_at)
   VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 1, '2026-10-21T12:00:00Z', '2026-10-21T12:00:00Z')`,
  [PLANTED_DRAFT, A, ROUTINE_B],
)
const plantedEmbed = await executeDataQuery(sql, ctxA, {
  table: 'workout_draft',
  op: 'select',
  columns: 'id, routine:routine_id(name,program_id)',
  filters: [{ column: 'id', op: 'eq', value: PLANTED_DRAFT }],
  single: 'maybe',
})
const plantedRoutine = (plantedEmbed.data as { routine?: { name?: string; program_id?: string } } | null)?.routine
ok(plantedRoutine?.name !== 'B day', 'data embed: planted A draft does not leak B routine name')
ok(plantedRoutine?.program_id !== PROG_B, 'data embed: planted A draft does not leak B program_id')

const inFilter = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'select',
  columns: 'id',
  filters: [{ column: 'id', op: 'in', value: [WORKOUT_A, WORKOUT_B] }],
})
const inIds = Array.isArray(inFilter.data) ? (inFilter.data as { id: string }[]).map((r) => r.id) : []
ok(inFilter.error == null, 'data in: uuid[] filter succeeds')
ok(inIds.includes(WORKOUT_A) && !inIds.includes(WORKOUT_B), 'data in: A sees own id only from mixed list')

const emptyIn = await executeDataQuery(sql, ctxA, {
  table: 'workout',
  op: 'select',
  columns: 'id',
  filters: [{ column: 'id', op: 'in', value: [] }],
})
ok(emptyIn.error == null && emptyIn.status === 200, 'empty in[] on uuid does not 400')
ok(Array.isArray(emptyIn.data) && (emptyIn.data as unknown[]).length === 0, 'empty in[] on uuid returns []')

ok((await loadNotes(storeA)).weekly.length >= 1, 'loadNotes: ANY(uuid[]) returns A weekly reviews')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed (${harness.backend})`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log(`access isolation: ok (${harness.backend})`)
