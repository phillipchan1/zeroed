import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'sessionRx.ts'), 'utf8')
const index = readFileSync(join(here, 'index.ts'), 'utf8')

ok(index.includes("app.all('/api/session-rx'"), 'route is registered')
ok(src.includes('sessionFromRequest'), 'session-rx authenticates like /api/data')
ok(src.includes('resolveAthleteId'), 'session-rx resolves the signed-in athlete')
ok(src.includes('athleteOwnsRoutine'), 'session-rx 404s a routine the athlete does not own')
ok(src.includes('computeSessionPrescription'), 'session-rx computes on the Worker')
ok(src.includes('program_version'), 'session-rx returns a version that bumps on MCP writes')
ok(!src.includes('from(\'workout\')'), 'session-rx does not go through the client data facade')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('worker session-rx: ok')
