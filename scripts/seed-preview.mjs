#!/usr/bin/env node
/**
 * Apply the Neon app schema + synthetic workers.dev preview seed.
 * No production / Supabase data. Requires an explicit --preview flag.
 *
 *   NEON_DIRECT_URL=postgres://... node scripts/seed-preview.mjs --preview
 *
 * Also accepts NEON_DB_URL, DATABASE_URL, or TARGET_DATABASE_URL.
 * Requires psql.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function redactSecrets(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim()
    const safeArgs = args.map((a) => (/postgres(?:ql)?:\/\//i.test(a) ? '[redacted-url]' : a))
    throw new Error(`${cmd} ${safeArgs.join(' ')} failed (${res.status}): ${redactSecrets(err)}`)
  }
  return res.stdout
}

function resolveTargetUrl(env = process.env) {
  return env.NEON_DIRECT_URL || env.NEON_DB_URL || env.DATABASE_URL || env.TARGET_DATABASE_URL || ''
}

const preview = process.argv.includes('--preview')
const target = resolveTargetUrl()

if (!preview) {
  console.error('Refusing to seed without --preview (synthetic workers.dev data only).')
  process.exit(2)
}

if (!target) {
  console.error('Set NEON_DIRECT_URL (or NEON_DB_URL / DATABASE_URL).')
  process.exit(2)
}

if (/supabase\.(co|com)/i.test(target)) {
  console.error('Refusing to seed a Supabase URL. Preview seed is Neon-only.')
  process.exit(2)
}

const psql = spawnSync('psql', ['--version'], { encoding: 'utf8' })
if (psql.status !== 0) throw new Error('Missing psql. Install PostgreSQL client tools.')

const files = [
  join(root, 'worker/schema/app.sql'),
  join(root, 'worker/schema/better-auth.sql'),
  join(root, 'worker/schema/preview-seed.sql'),
]

for (const file of files) {
  console.log(`applying ${file.slice(root.length + 1)}…`)
  run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', file])
}

console.log('preview seed ok (synthetic data only)')
