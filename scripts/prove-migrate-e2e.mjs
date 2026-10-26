#!/usr/bin/env node
/**
 * Loopback e2e for migrate-supabase-to-neon.mjs: refuse before any write
 * when the target is not *.neon.tech, when --confirm-drop is missing, or
 * when source and target are the same database. A successful two-server
 * restore is covered by the migrate-pg CI job.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { refuseUnsafeTestUrl } from '../worker/src/refuseTestUrl.ts'
import { applyIsolationSchemaPg } from '../worker/src/isolationDb.ts'
import { libpqCleanEnv } from './migrate-supabase-to-neon.mjs'
import {
  LIST_USER_OBJECTS_TEXT_SQL,
  objectHash,
  parseObjectList,
} from './migrate-users.lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const adminUrl = process.env.DATABASE_URL?.trim()
if (!adminUrl) throw new Error('DATABASE_URL is required for check:migrate-e2e')
refuseUnsafeTestUrl(adminUrl, 'DATABASE_URL')

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
    env: libpqCleanEnv({ ...process.env, NODE_NO_WARNINGS: '1', ...extraEnv }),
  })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${out}`)
  }
  return out
}

function migrate(args, extraEnv) {
  const res = spawnSync(process.execPath, [join(here, 'migrate-supabase-to-neon.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: libpqCleanEnv({ ...process.env, NODE_NO_WARNINGS: '1', ...extraEnv }),
  })
  return {
    status: res.status,
    out: `${res.stdout || ''}\n${res.stderr || ''}`.trim(),
  }
}

const srcUrl = dbUrl(SRC)
const dstUrl = dbUrl(DST)
refuseUnsafeTestUrl(srcUrl, 'DATABASE_URL')
refuseUnsafeTestUrl(dstUrl, 'DATABASE_URL')

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

function listDst() {
  return parseObjectList(run('psql', ['-v', 'ON_ERROR_STOP=1', '-tA', '-d', dstUrl, '-c', LIST_USER_OBJECTS_TEXT_SQL]))
}

function sourceAthleteCount() {
  return run('psql', ['-v', 'ON_ERROR_STOP=1', '-tA', '-d', srcUrl, '-c', 'SELECT COUNT(*) FROM public.athlete']).trim()
}

const tmp = mkdtempSync(join(tmpdir(), 'zeroed-migrate-e2e-'))
const mapPath = join(tmp, 'users.json')
writeFileSync(mapPath, JSON.stringify([
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a@example.com', created_at: '2026-01-01' },
]))

const beforeFail = listDst()
const beforeHash = objectHash(beforeFail)
const beforeAthletes = sourceAthleteCount()

const loopback = migrate(
  ['--skip-auth-users', `--confirm-drop=${DST}`, '--auth-users-file', mapPath],
  { SUPABASE_READONLY_URL: srcUrl, NEON_DIRECT_URL: dstUrl },
)
if (loopback.status === 0) {
  throw new Error(`loopback target was accepted:\n${loopback.out}`)
}
if (!/must end in \.neon\.tech/.test(loopback.out)) {
  throw new Error(`expected neon.tech refuse for loopback target, got: ${loopback.out}`)
}
console.log('migrate e2e: loopback target refused before write')

const noConfirm = migrate(
  ['--skip-auth-users', '--auth-users-file', mapPath],
  {
    SUPABASE_READONLY_URL: srcUrl,
    NEON_DIRECT_URL: 'postgresql://dst:dummy@ep-dst.neon.tech:55419/dstdb',
  },
)
if (noConfirm.status !== 2) {
  throw new Error(`missing --confirm-drop exited ${noConfirm.status}:\n${noConfirm.out}`)
}
if (!/confirm-drop/.test(noConfirm.out)) {
  throw new Error(`expected confirm-drop refuse, got: ${noConfirm.out}`)
}
if (/dumping|resetting/i.test(noConfirm.out)) {
  throw new Error(`missing --confirm-drop reached a write:\n${noConfirm.out}`)
}
console.log('migrate e2e: missing --confirm-drop refused before write')

const sameDb = migrate(
  ['--skip-auth-users', '--confirm-drop=samedb', '--auth-users-file', mapPath],
  {
    SUPABASE_READONLY_URL: 'postgresql://src:dummy@ep-src.neon.tech:5432/samedb',
    NEON_DIRECT_URL: 'postgresql://dst:dummy@ep-src.neon.tech:5432/samedb',
  },
)
if (sameDb.status !== 2) {
  throw new Error(`same-database pair exited ${sameDb.status}:\n${sameDb.out}`)
}
if (!/same host, port, and database/.test(sameDb.out)) {
  throw new Error(`expected same-database refuse, got: ${sameDb.out}`)
}
console.log('migrate e2e: same host+port+dbname refused before write')

const afterFail = listDst()
const afterHash = objectHash(afterFail)
if (afterHash !== beforeHash) {
  const leftover = afterFail.map((row) => `${row.schema}.${row.name} (${row.kind})`).join(', ')
  throw new Error(`refused migrate changed the target object hash (${leftover || 'hash-only drift'})`)
}
if (sourceAthleteCount() !== beforeAthletes) {
  throw new Error('refused migrate changed source athlete rows')
}
rmSync(tmp, { recursive: true, force: true })
console.log('migrate e2e: source and dest hashes unchanged after refuses')
