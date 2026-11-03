#!/usr/bin/env node
/**
 * Idempotent one-off: Phil's named tracks, goals, rules, block dates.
 * Schema migrations stay schema + the tracks_v1 flag. Prod already has
 * this data — re-running is a no-op when rows exist.
 *
 *   DATABASE_URL=postgres://... node scripts/seed-phil-tracks.mjs --confirm
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly, libpqCleanEnv } from './migrate-supabase-to-neon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, 'seed-phil-tracks.sql')

export function seedSql() {
  return readFileSync(sqlPath, 'utf8')
}

function redact(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

export function refuseReason(argv = process.argv.slice(2), env = process.env) {
  if (!argv.includes('--confirm')) return 'Refusing to seed without --confirm'
  const url = env.ZEROED_SEED_DATABASE_URL || env.NEON_DIRECT_URL || env.DATABASE_URL || ''
  if (!url) return 'Set ZEROED_SEED_DATABASE_URL (or NEON_DIRECT_URL / DATABASE_URL)'
  if (/zeroed_test|isolation|127\.0\.0\.1:5432\/zeroed_test/i.test(url)) {
    return 'Refusing a throwaway test URL'
  }
  return ''
}

function main(argv = process.argv.slice(2), env = process.env) {
  const reason = refuseReason(argv, env)
  if (reason) {
    console.error(reason)
    return 2
  }
  const url = env.ZEROED_SEED_DATABASE_URL || env.NEON_DIRECT_URL || env.DATABASE_URL
  const res = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-d', url, '-f', sqlPath], {
    encoding: 'utf8',
    env: libpqCleanEnv({ PATH: env.PATH || '/usr/bin', HOME: env.HOME || '', LANG: 'C' }),
  })
  if (res.status !== 0) {
    console.error(redact((res.stderr || res.stdout || '').trim()))
    return res.status || 1
  }
  console.log('seed-phil-tracks: ok (idempotent; existing rows left in place)')
  return 0
}

if (isExecutedDirectly(import.meta.url)) {
  process.exit(main())
}
