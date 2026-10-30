// Run: node --experimental-strip-types src/lib/workoutCommit.check.ts
//
// Timeout-then-success: the commit request dies after the server wrote the row.
// The outbox retries with the same client_key; we must return that row, not
// insert a second copy.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitFailedUnreachable, resolveWorkoutInsert } from './workoutCommit.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const engineSrc = readFileSync(join(here, '../engine/index.ts'), 'utf8')
const outboxSrc = readFileSync(join(here, 'workoutOutbox.ts'), 'utf8')
const accessSrc = readFileSync(join(here, '../../worker/src/access.check.ts'), 'utf8')
const dataSrc = readFileSync(join(here, '../../worker/src/data.ts'), 'utf8')

ok(engineSrc.includes('resolveWorkoutInsert'), 'commitSession uses the shared insert resolver')
ok(engineSrc.includes('existingWorkoutIdForClientKey'), 'commitSession looks up the row by client_key on insert failure')
ok(engineSrc.includes('client_key: p.id'), 'outbox session id is sent as client_key')
ok(outboxSrc.includes('client_key'), 'outbox documents client_key idempotency')
ok(outboxSrc.includes('rejectionCode(err) !== null'), 'outbox does not retire an entry on a timeout (no server code)')
ok(dataSrc.includes('uniqueViolation'), 'worker maps a unique violation back to the existing row')
ok(accessSrc.includes('idempotent insert: same key returns the same id'), 'worker check covers same-key retry')

// Attempt 1: the write landed, the client timed out, lookup also missed (same
// slow link). Stay queued — no server code, so the outbox must not block.
const timedOut = resolveWorkoutInsert({
  insertedId: null,
  error: { message: 'The operation was aborted' },
  existingId: null,
})
ok(timedOut.ok === false, 'timeout with no lookup is a failure')
ok(commitFailedUnreachable(timedOut.ok ? null : timedOut.error),
  'timeout has no rejection code — outbox keeps the entry queued')

function workoutIdOf(result: ReturnType<typeof resolveWorkoutInsert>): string | null {
  return result.ok ? result.workoutId : null
}

// Same attempt, but the lookup found the row the server already wrote.
const recoveredSameAttempt = resolveWorkoutInsert({
  insertedId: null,
  error: { message: 'The operation was aborted' },
  existingId: 'workout-1',
})
ok(workoutIdOf(recoveredSameAttempt) === 'workout-1',
  'timeout + client_key lookup returns the written row')

// Attempt 2: retry after timeout. Insert unique-violates; lookup returns the id.
const retryConflict = resolveWorkoutInsert({
  insertedId: null,
  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
  existingId: 'workout-1',
})
ok(workoutIdOf(retryConflict) === 'workout-1',
  'timeout-then-retry unique violation returns the original id (no duplicate)')

// Clean first write.
const first = resolveWorkoutInsert({
  insertedId: 'workout-1',
  error: null,
  existingId: null,
})
ok(workoutIdOf(first) === 'workout-1', 'first insert returns the new id')

// Two resolves with the same existing id — the outbox retry after a lost
// committed-id trail — must agree.
const again = resolveWorkoutInsert({
  insertedId: null,
  error: { code: '23505', message: 'duplicate key' },
  existingId: 'workout-1',
})
ok(workoutIdOf(again) === workoutIdOf(retryConflict),
  'repeated timeout-then-success resolves to one workout id')

ok(!commitFailedUnreachable({ code: '23505', message: 'duplicate key' }),
  '23505 is a server answer — the insert path must resolve it, not treat it as unreachable')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('workout commit timeout-then-success: ok')
