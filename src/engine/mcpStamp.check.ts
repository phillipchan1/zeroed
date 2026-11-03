// Run: node --experimental-strip-types src/engine/mcpStamp.check.ts
import { mcpStamp, writePreview } from './mcpStamp.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const s = mcpStamp(new Date('2026-11-03T20:00:00Z'), 'America/Los_Angeles')
ok(s.utc === '2026-11-03T20:00:00.000Z', `utc iso, got ${s.utc}`)
ok(s.local_date === '2026-11-03', `local_date, got ${s.local_date}`)
ok(s.local.startsWith('2026-11-03T'), `local companion, got ${s.local}`)

const preview = await writePreview([{ op: 'x' }], ['w'])
ok(typeof preview.preview_id === 'string' && String(preview.preview_id).length >= 8, 'preview_id is a hash')
ok(typeof preview.utc === 'string' && typeof preview.local_date === 'string', 'preview carries utc + local_date')
const warnings = Array.isArray(preview.warnings) ? preview.warnings : []
ok(Array.isArray(preview.diff) && warnings[0] === 'w', 'preview keeps diff and warnings')

const again = await writePreview([{ op: 'x' }], ['w'])
ok(again.preview_id === preview.preview_id, 'same payload hashes the same preview_id')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('mcpStamp: ok')
