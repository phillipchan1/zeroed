// Run: node --experimental-strip-types worker/src/data.check.ts
import {
  bindOwner,
  ownerPredicate,
  parseSelectList,
  SESSION_LOOKUP_SQL,
  safeClientMessage,
  unsignedSessionToken,
} from './data.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const items = parseSelectList('performed_at, rpe, actual_weights, routine!inner(program_id)')
ok(items.some((i) => i.kind === 'col' && i.name === 'performed_at'), 'parse: root columns')
ok(items.some((i) => i.kind === 'embed' && i.alias === 'routine' && i.inner), 'parse: routine!inner embed')

const nested = parseSelectList('severity, workout!inner(routine!inner(program_id))')
const workout = nested.find((i) => i.kind === 'embed')
ok(workout?.kind === 'embed' && workout.items.some((i) => i.kind === 'embed'), 'parse: nested workout.routine embed')

const hinted = parseSelectList('*, program:program_id(athlete_id)')
ok(hinted.some((i) => i.kind === 'star'), 'parse: star plus fk hint')
ok(hinted.some((i) => i.kind === 'embed' && i.fkHint && i.alias === 'program'), 'parse: program:program_id hint')

ok(ownerPredicate('athlete').includes('id = ${athleteId}'), 'owner: athlete self id')
ok(ownerPredicate('insight') === 'athlete_id = ${athleteId}', 'owner: insight athlete_id')
ok(ownerPredicate('phase').includes('athlete_id = ${athleteId}'), 'owner: phase via program')
ok(ownerPredicate('workout').includes('p.athlete_id = ${athleteId}'), 'owner: workout via program join')
ok(ownerPredicate('session_observation').includes('p.athlete_id = ${athleteId}'), 'owner: observation via workout join')

const bound = bindOwner('insight', '11111111-1111-1111-1111-111111111111', 3)
ok(bound.text === 'athlete_id = $3', 'bindOwner: $n replacement')
ok(bound.params[0] === '11111111-1111-1111-1111-111111111111', 'bindOwner: athlete id param')
const qualified = bindOwner('phase', '11111111-1111-1111-1111-111111111111', 1, 'phase')
ok(qualified.text.startsWith('phase.program_id IN'), 'bindOwner: qualify program_id for joins')
ok(unsignedSessionToken('tok.signature') === 'tok', 'cookie token strips Better Auth signature')
ok(unsignedSessionToken('tok') === 'tok', 'unsigned bearer is unchanged')
ok(unsignedSessionToken('tok%2Esig') === 'tok', 'url-encoded cookie signature is stripped')
ok(SESSION_LOOKUP_SQL.includes('s.user_id') && SESSION_LOOKUP_SQL.includes('s.expires_at'), 'session SQL matches better-auth.sql')
ok(!SESSION_LOOKUP_SQL.includes('"userId"') && !SESSION_LOOKUP_SQL.includes('"expiresAt"'), 'session SQL is not camelCase')
ok(safeClientMessage(new Error('column xmin does not exist')) === 'request failed', 'raw DB errors are generic')
ok(safeClientMessage(new Error('unknown column routine.xmin')) === 'unknown column routine.xmin', 'allowlist errors stay specific')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('data query parser: ok')
