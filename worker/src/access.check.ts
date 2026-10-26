// Standalone access-isolation check (no test runner).
// Run: node --experimental-strip-types worker/src/access.check.ts
// Proves: athlete A cannot read athlete B's rows after the RLS → app move.

import {
  athleteForUser,
  athleteOwnsRow,
  restrictToAthlete,
  takeOwned,
  type OwnershipIndex,
  type TableName,
} from './access.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const PROG_A = 'prog-a'
const PROG_B = 'prog-b'
const ROUTINE_A = 'routine-a'
const ROUTINE_B = 'routine-b'
const WORKOUT_A = 'workout-a'
const WORKOUT_B = 'workout-b'
const INSIGHT_A = 'insight-a'
const INSIGHT_B = 'insight-b'
const TOKEN_A = 'token-a'
const TOKEN_B = 'token-b'

const index: OwnershipIndex = {
  athletes: [
    { id: A, auth_user_id: USER_A },
    { id: B, auth_user_id: USER_B },
  ],
  programs: [
    { id: PROG_A, athlete_id: A },
    { id: PROG_B, athlete_id: B },
  ],
  routines: [
    { id: ROUTINE_A, program_id: PROG_A },
    { id: ROUTINE_B, program_id: PROG_B },
  ],
  workouts: [
    { id: WORKOUT_A, routine_id: ROUTINE_A },
    { id: WORKOUT_B, routine_id: ROUTINE_B },
  ],
}

const mixed = {
  athlete: [
    { id: A, auth_user_id: USER_A, name: 'A' },
    { id: B, auth_user_id: USER_B, name: 'B' },
  ],
  insight: [
    { id: INSIGHT_A, athlete_id: A, claim: 'A only' },
    { id: INSIGHT_B, athlete_id: B, claim: 'B only' },
  ],
  mcp_token: [
    { id: TOKEN_A, athlete_id: A, name: 'claude-a' },
    { id: TOKEN_B, athlete_id: B, name: 'claude-b' },
  ],
  program: [
    { id: PROG_A, athlete_id: A },
    { id: PROG_B, athlete_id: B },
  ],
  phase: [
    { id: 'phase-a', program_id: PROG_A, name: 'Strength' },
    { id: 'phase-b', program_id: PROG_B, name: 'Strength' },
  ],
  routine: [
    { id: ROUTINE_A, program_id: PROG_A, name: 'A day' },
    { id: ROUTINE_B, program_id: PROG_B, name: 'B day' },
  ],
  workout: [
    { id: WORKOUT_A, routine_id: ROUTINE_A },
    { id: WORKOUT_B, routine_id: ROUTINE_B },
  ],
  session_observation: [
    { id: 'obs-a', workout_id: WORKOUT_A, signal: 'A felt good' },
    { id: 'obs-b', workout_id: WORKOUT_B, signal: 'B felt good' },
  ],
  coach_message: [
    { id: 'note-a', athlete_id: A, body: 'private A' },
    { id: 'note-b', athlete_id: B, body: 'private B' },
  ],
} as const

ok(athleteForUser(index, USER_A)?.id === A, 'user A resolves to athlete A')
ok(athleteForUser(index, USER_B)?.id === B, 'user B resolves to athlete B')
ok(athleteForUser(index, 'nobody') === null, 'unknown user has no athlete')

const tables = Object.keys(mixed) as Array<keyof typeof mixed>
for (const table of tables) {
  const aRows = restrictToAthlete(A, table as TableName, [...mixed[table]], index)
  const bRows = restrictToAthlete(B, table as TableName, [...mixed[table]], index)
  ok(aRows.length === 1, `${table}: A sees exactly one row`)
  ok(bRows.length === 1, `${table}: B sees exactly one row`)
  const aIds = new Set(aRows.map((r) => r.id))
  const bIds = new Set(bRows.map((r) => r.id))
  for (const id of aIds) {
    ok(!bIds.has(id), `${table}: A and B must not share row ${id}`)
  }
}

ok(takeOwned(A, 'workout', mixed.workout[1], index) === null, 'A cannot take B workout')
ok(takeOwned(A, 'workout', mixed.workout[0], index)?.id === WORKOUT_A, 'A can take own workout')
ok(takeOwned(B, 'insight', mixed.insight[0], index) === null, 'B cannot take A insight')
ok(takeOwned(A, 'mcp_token', mixed.mcp_token[1], index) === null, 'A cannot take B mcp token')
ok(takeOwned(A, 'session_observation', mixed.session_observation[1], index) === null, 'A cannot take B observation')

ok(
  athleteOwnsRow(A, 'workout', { id: WORKOUT_B, routine_id: ROUTINE_B }, index) === false,
  'A does not own B workout via program join',
)
ok(
  athleteOwnsRow(A, 'phase', { id: 'phase-b', program_id: PROG_B }, index) === false,
  'A does not own B phase',
)
ok(
  athleteOwnsRow(B, 'routine', { id: ROUTINE_A, program_id: PROG_A }, index) === false,
  'B does not own A routine',
)

// MCP get_workout contract: asking for the other athlete's id is a miss, not a leak.
function mcpGetWorkout(actorAthleteId: string, workoutId: string) {
  const row = mixed.workout.find((w) => w.id === workoutId) ?? null
  return takeOwned(actorAthleteId, 'workout', row, index)
}
ok(mcpGetWorkout(A, WORKOUT_B) === null, 'MCP: A asking for B workout_id gets null')
ok(mcpGetWorkout(A, WORKOUT_A)?.id === WORKOUT_A, 'MCP: A asking for own workout_id succeeds')
ok(mcpGetWorkout(B, WORKOUT_A) === null, 'MCP: B asking for A workout_id gets null')

// Writes: an UPDATE/INSERT that targets the other athlete's program must fail the check.
function wouldWriteRoutine(actorAthleteId: string, programId: string): boolean {
  return athleteOwnsRow(actorAthleteId, 'routine', { id: 'new', program_id: programId }, index)
}
ok(wouldWriteRoutine(A, PROG_B) === false, 'A cannot insert a routine on B program')
ok(wouldWriteRoutine(A, PROG_A) === true, 'A can insert a routine on own program')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('access isolation: ok')
