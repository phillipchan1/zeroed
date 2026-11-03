#!/usr/bin/env node
/**
 * Turn on athlete.flags.tracks_v1 for one auth email.
 * Email comes from ZEROED_TRACKS_FLAG_EMAIL — never hardcoded.
 *
 *   ZEROED_TRACKS_FLAG_EMAIL=you@example.com \
 *   ZEROED_SEED_DATABASE_URL=postgres://... \
 *   node scripts/enable-tracks-flag.mjs --confirm
 */
import { spawnSync } from 'node:child_process'
import { isExecutedDirectly, libpqCleanEnv } from './migrate-supabase-to-neon.mjs'

const FLAG_SQL = `
UPDATE public.athlete a
SET flags = COALESCE(a.flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb
FROM auth.users u
WHERE a.auth_user_id = u.id
  AND lower(u.email) = lower(:'athlete_email');
`

function redact(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

export function athleteEmail(env = process.env) {
  return String(env.ZEROED_TRACKS_FLAG_EMAIL || env.ZEROED_SEED_ATHLETE_EMAIL || '').trim()
}

export function refuseReason(argv = process.argv.slice(2), env = process.env) {
  if (!argv.includes('--confirm')) return 'Refusing to write without --confirm'
  if (!athleteEmail(env)) return 'Set ZEROED_TRACKS_FLAG_EMAIL (or ZEROED_SEED_ATHLETE_EMAIL)'
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
  const email = athleteEmail(env)
  const res = spawnSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-v', `athlete_email=${email}`, '-d', url, '-c', FLAG_SQL],
    {
      encoding: 'utf8',
      env: libpqCleanEnv({ PATH: env.PATH || '/usr/bin', HOME: env.HOME || '', LANG: 'C' }),
    },
  )
  if (res.status !== 0) {
    console.error(redact((res.stderr || res.stdout || '').trim()))
    return res.status || 1
  }
  console.log('enable-tracks-flag: ok')
  return 0
}

if (isExecutedDirectly(import.meta.url)) {
  process.exit(main())
}
