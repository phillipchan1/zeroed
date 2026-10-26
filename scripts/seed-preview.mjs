#!/usr/bin/env node
/**
 * Apply the Neon app schema + synthetic workers.dev preview seed.
 * No production / Supabase data. Requires an explicit --preview flag.
 *
 *   NEON_DIRECT_URL=postgres://... node scripts/seed-preview.mjs --preview
 *
 * Also accepts NEON_DB_URL, DATABASE_URL, or TARGET_DATABASE_URL.
 * Requires psql. Target host must be *.neon.tech; inherited PG* is stripped.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isExecutedDirectly,
  isNeonHost,
  isSocketHost,
  isSupabaseHost,
  libpqCleanEnv,
  postgresUrlParts,
} from './migrate-supabase-to-neon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function redactSecrets(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

function run(cmd, args, opts = {}) {
  const { env: optsEnv, ...rest } = opts
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...rest,
    env: libpqCleanEnv(optsEnv || process.env),
  })
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

/** Neon-only allowlist — same host rules as the live migrate target. */
export function previewTargetRefuseReason(url) {
  let dst
  try {
    dst = postgresUrlParts(url)
  } catch {
    return 'target URL is not a valid postgres URL'
  }
  if (dst.isSocket || isSocketHost(dst.host) || isSocketHost(dst.queryHost) || isSocketHost(dst.hostaddr) || isSocketHost(dst.urlHost)) {
    return 'target host is a socket path'
  }
  if (dst.queryHost && !isNeonHost(dst.queryHost)) return 'target host override must end in .neon.tech'
  if (dst.hostaddr && !isNeonHost(dst.hostaddr)) return 'target host override must end in .neon.tech'
  if (isSupabaseHost(dst.host) || isSupabaseHost(dst.urlHost) || isSupabaseHost(dst.queryHost)) {
    return 'target host looks like Supabase'
  }
  if (!isNeonHost(dst.host)) return 'target host must end in .neon.tech'
  return ''
}

function main(argv = process.argv.slice(2), env = process.env) {
  const preview = argv.includes('--preview')
  const target = resolveTargetUrl(env)

  if (!preview) {
    console.error('Refusing to seed without --preview (synthetic workers.dev data only).')
    return 2
  }

  if (!target) {
    console.error('Set NEON_DIRECT_URL (or NEON_DB_URL / DATABASE_URL).')
    return 2
  }

  const refuse = previewTargetRefuseReason(target)
  if (refuse) {
    console.error(`Refusing to seed: ${refuse}. Preview seed is Neon-only.`)
    return 2
  }

  const psql = spawnSync('psql', ['--version'], {
    encoding: 'utf8',
    env: libpqCleanEnv(env),
  })
  if (psql.status !== 0) throw new Error('Missing psql. Install PostgreSQL client tools.')

  const files = [
    join(root, 'worker/schema/app.sql'),
    join(root, 'worker/schema/better-auth.sql'),
    join(root, 'worker/schema/preview-seed.sql'),
  ]

  for (const file of files) {
    console.log(`applying ${file.slice(root.length + 1)}…`)
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', file], { env })
  }

  console.log('preview seed ok (synthetic data only)')
  return 0
}

if (isExecutedDirectly(import.meta.url, process.argv[1])) {
  try {
    process.exit(main())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(redactSecrets(message))
    process.exit(1)
  }
}
