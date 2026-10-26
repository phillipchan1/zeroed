#!/usr/bin/env node
/**
 * Full migrate-supabase-to-neon.mjs against a fresh Postgres target,
 * seeded source, no error-tolerant wrappers.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { applyIsolationSchemaPg } from '../worker/src/isolationDb.ts'
import { CHECKSUM_TABLES, checksumQuery, parseCounts } from './migrate-users.lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const adminUrl = process.env.DATABASE_URL?.trim()
if (!adminUrl) throw new Error('DATABASE_URL is required for check:migrate-e2e')

const SRC = 'zeroed_mig_src'
const DST = 'zeroed_mig_dst'

function dbUrl(name) {
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.toString()
}

function run(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...extraEnv },
  })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${out}`)
  }
  return out
}

const srcUrl = dbUrl(SRC)
const dstUrl = dbUrl(DST)

const admin = new Client({ connectionString: adminUrl })
await admin.connect()
try {
  await admin.query(`DROP DATABASE IF EXISTS ${SRC} WITH (FORCE)`)
  await admin.query(`DROP DATABASE IF EXISTS ${DST} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${SRC}`)
  await admin.query(`CREATE DATABASE ${DST}`)
} finally {
  await admin.end()
}

const src = new Client({ connectionString: srcUrl })
await src.connect()
try {
  await applyIsolationSchemaPg(src)
} finally {
  await src.end()
}
console.log('migrate e2e: seeded source')

const migrateOut = run(process.execPath, [join(here, 'migrate-supabase-to-neon.mjs')], {
  SUPABASE_DB_URL: srcUrl,
  NEON_DB_URL: dstUrl,
})
if (!migrateOut.includes('migration ok')) {
  throw new Error(`migrate script did not finish cleanly:\n${migrateOut}`)
}
console.log(migrateOut)

const dst = new Client({ connectionString: dstUrl })
await dst.connect()
try {
  const users = await dst.query('SELECT id, email FROM "user" ORDER BY email')
  if (users.rows.length !== 2) {
    throw new Error(`expected 2 Better Auth users, got ${users.rows.length}`)
  }
  if (users.rows[0].email !== 'a@example.com' || users.rows[1].email !== 'b@example.com') {
    throw new Error(`unexpected emails: ${users.rows.map((r) => r.email).join(',')}`)
  }
  const srcCounts = parseCounts(run('psql', ['-v', 'ON_ERROR_STOP=1', '-tA', '-d', srcUrl, '-c', checksumQuery()]))
  const dstCounts = parseCounts(run('psql', ['-v', 'ON_ERROR_STOP=1', '-tA', '-d', dstUrl, '-c', checksumQuery()]))
  for (const table of CHECKSUM_TABLES) {
    if (srcCounts[table] !== dstCounts[table]) {
      throw new Error(`${table} count drifted after migrate: source=${srcCounts[table]} dest=${dstCounts[table]}`)
    }
  }
} finally {
  await dst.end()
}
console.log('migrate e2e: fresh-target restore + user load ok')

try {
  run(process.execPath, [join(here, 'migrate-supabase-to-neon.mjs')], {
    SUPABASE_DB_URL: srcUrl,
    NEON_DB_URL: dstUrl,
  })
  throw new Error('second migrate onto a full target succeeded')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/second migrate/.test(msg)) throw err
  if (!/not empty/.test(msg)) throw new Error(`expected non-empty refuse, got: ${msg}`)
}
console.log('migrate e2e: non-empty target refused')
