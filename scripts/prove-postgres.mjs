#!/usr/bin/env node
/**
 * Real-Postgres gate: sequential per-request clients, owner isolation,
 * and Better Auth against worker/schema/better-auth.sql.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refuseUnsafeTestUrl } from '../worker/src/refuseTestUrl.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required for check:postgres')
refuseUnsafeTestUrl(url, 'DATABASE_URL')

function run(label, args, extraEnv = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', DATABASE_URL: url, ...extraEnv },
  })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
  console.log(`=== ${label} ===`)
  console.log(out)
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status})`)
  return out
}

const { withSql } = await import('../worker/src/db.ts')
const env = { DATABASE_URL: url, ENVIRONMENT: 'local' }
for (let i = 1; i <= 5; i++) {
  const rows = await withSql(env, (sql) => sql`SELECT ${i}::int AS n`)
  const n = Number(rows[0]?.n)
  if (n !== i) throw new Error(`sequential withSql ${i}: expected ${i}, got ${rows[0]?.n}`)
  console.log(`sequential withSql ${i}/5 ok`)
}

run('access isolation on Postgres', ['--experimental-strip-types', 'worker/src/access.check.ts'])
run(
  'better-auth schema',
  ['--experimental-strip-types', 'scripts/prove-better-auth-schema.mjs'],
)
run(
  'migrate users',
  ['--experimental-strip-types', 'scripts/prove-migrate-users.mjs'],
)
run(
  'migrate e2e',
  ['--experimental-strip-types', 'scripts/prove-migrate-e2e.mjs'],
)
run(
  'workerd get-session',
  ['--experimental-strip-types', 'scripts/prove-workerd-auth.mjs'],
)

console.log('postgres gate: ok')
