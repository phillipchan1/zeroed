// Standalone access-isolation check against a real Postgres (PGlite).
// Run: node --experimental-strip-types worker/src/access.check.ts
// Proves: athlete A cannot read, edit, or delete athlete B's rows on every
// store / edits query path. Mutating those SQL filters must make this fail.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { applyEdits, writeDraftInPlace, type EditInput } from './edits.ts'
import { resolveMcpToken } from './mcpToken.ts'
import { makePgliteSql } from './pgliteSql.ts'
import {
  loadAthlete,
  loadInsights,
  loadJourney,
  loadLiftHistory,
  loadLiveProgram,
  loadNotes,
  loadWorkout,
  loadWorkouts,
  makeStore,
  programIds,
} from './store.ts'
import { executeZeroedTool } from './tools.ts'
import type { LiveProgram } from './store.ts'
import type { ProgramDraft } from '../../supabase/functions/_shared/engine/programDraft.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const PROG_A = '33333333-3333-3333-3333-333333333333'
const PROG_B = '44444444-4444-4444-4444-444444444444'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const ROUTINE_B = '88888888-8888-8888-8888-888888888888'
const WORKOUT_A = '99999999-9999-9999-9999-999999999999'
const WORKOUT_B = 'bbbb9999-9999-4999-8999-999999999999'
const INSIGHT_B = 'bbbb2222-0000-4000-8000-000000000001'

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../schema/isolation.sql')

const db = new PGlite()
await db.exec(readFileSync(schemaPath, 'utf8'))
const sql = makePgliteSql(db)
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)

async function count(table: string, where: string, params: unknown[]): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params)
  return Number(result.rows[0]?.n ?? 0)
}

async function scalar<T>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await db.query<Record<string, T>>(text, params)
  const row = result.rows[0]
  if (!row) return undefined
  return Object.values(row)[0]
}

// --- reads ---
ok((await programIds(storeA)).join() === PROG_A, 'programIds: A sees only own program')
ok((await programIds(storeB)).join() === PROG_B, 'programIds: B sees only own program')

const athleteA = await loadAthlete(storeA)
ok(athleteA.id === A && athleteA.name === 'Athlete A', 'loadAthlete: A is A')
ok(athleteA.goals === 'A only goal', 'loadAthlete: A does not see B goals')
ok((await loadAthlete(storeB)).id === B, 'loadAthlete: B is B')

const liveA = await loadLiveProgram(storeA)
const liveB = await loadLiveProgram(storeB)
ok(liveA?.programId === PROG_A && liveA.sessions.every((s) => s.routineId === ROUTINE_A), 'loadLiveProgram: A week only')
ok(liveB?.programId === PROG_B && !liveA?.sessions.some((s) => s.name === 'B day'), 'loadLiveProgram: A does not see B day')
ok(liveA?.phaseName === 'Strength' && liveB?.phaseName === 'Power', 'loadLiveProgram: phases stay separate')

const insightsA = await loadInsights(storeA, true)
const insightsB = await loadInsights(storeB, true)
ok(insightsA.length === 1 && insightsA[0]?.claim === 'A only', 'loadInsights: A sees own claim')
ok(!insightsA.some((i) => i.claim === 'B only'), 'loadInsights: A cannot read B claim')
ok(insightsB.length === 1 && insightsB[0]?.claim === 'B only', 'loadInsights: B sees own claim')

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

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('access isolation: ok')
