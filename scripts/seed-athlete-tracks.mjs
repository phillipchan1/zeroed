#!/usr/bin/env node
/**
 * Apply a local, gitignored athlete-tracks SQL file for one auth email.
 * No personal data ships in git. Prod is already loaded — this is for
 * a new environment only.
 *
 *   ZEROED_SEED_ATHLETE_EMAIL=you@example.com \
 *   ZEROED_SEED_SQL=local/seed-athlete-tracks.sql \
 *   ZEROED_SEED_DATABASE_URL=postgres://... \
 *   node scripts/seed-athlete-tracks.mjs --confirm
 *
 * The SQL file may use :'athlete_email' (psql variable). Copy
 * scripts/seed-athlete-tracks.example.sql to local/ and edit.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly, libpqCleanEnv } from './migrate-supabase-to-neon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

export function athleteEmail(env = process.env) {
  return String(env.ZEROED_SEED_ATHLETE_EMAIL || env.ZEROED_TRACKS_FLAG_EMAIL || '').trim()
}

export function seedSqlPath(env = process.env) {
  const raw = String(env.ZEROED_SEED_SQL || 'local/seed-athlete-tracks.sql').trim()
  return isAbsolute(raw) ? raw : join(root, raw)
}

function redact(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

export function refuseReason(argv = process.argv.slice(2), env = process.env) {
  if (!argv.includes('--confirm')) return 'Refusing to seed without --confirm'
  if (!athleteEmail(env)) return 'Set ZEROED_SEED_ATHLETE_EMAIL'
  const url = env.ZEROED_SEED_DATABASE_URL || env.NEON_DIRECT_URL || env.DATABASE_URL || ''
  if (!url) return 'Set ZEROED_SEED_DATABASE_URL (or NEON_DIRECT_URL / DATABASE_URL)'
  if (/zeroed_test|isolation|127\.0\.0\.1:5432\/zeroed_test/i.test(url)) {
    return 'Refusing a throwaway test URL'
  }
  const sqlPath = seedSqlPath(env)
  if (!existsSync(sqlPath)) {
    return `Missing ${sqlPath}. Copy scripts/seed-athlete-tracks.example.sql to a gitignored local file.`
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
  const email = athleteEmail(env)
  const sqlPath = seedSqlPath(env)
  const res = spawnSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-v', `athlete_email=${email}`, '-d', url, '-f', sqlPath],
    {
      encoding: 'utf8',
      env: libpqCleanEnv({ PATH: env.PATH || '/usr/bin', HOME: env.HOME || '', LANG: 'C' }),
    },
  )
  if (res.status !== 0) {
    console.error(redact((res.stderr || res.stdout || '').trim()))
    return res.status || 1
  }
  console.log('seed-athlete-tracks: ok (idempotent; existing rows left in place)')
  return 0
}

if (isExecutedDirectly(import.meta.url)) {
  process.exit(main())
}
