#!/usr/bin/env node
/**
 * Source email pre-check writes nothing (dupes and blank emails);
 * user/auth load is one transaction; a later failure drops restored tables.
 */
import { Client } from 'pg'
import {
  BETTER_AUTH_TABLES_SQL,
  applyLowerEmailUniqueIndex,
  STUB_AUTH_SQL,
  filterRestoreToc,
  objectHash,
  assertCountsMatch,
  assertNoBlankEmails,
  assertNoEmailDupes,
  assertSourceUsersReady,
  assertTargetEmpty,
  findBlankEmails,
  findCaseInsensitiveEmailDupes,
  formatBlankEmailAbort,
  formatSourceUsersAbort,
  loadAuthUsersInTransaction,
  dropCreatedObjects,
  listUserObjects,
  migrateAuthUsers,
  migrateTarget,
  parseCounts,
  writeTargetOrCleanup,
} from './migrate-users.lib.mjs'
import { refuseUnsafeTestUrl } from '../worker/src/refuseTestUrl.ts'

const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required for check:migrate-users')
refuseUnsafeTestUrl(url, 'DATABASE_URL')

const dupA = '11111111-1111-1111-1111-111111111111'
const dupB = '22222222-2222-2222-2222-222222222222'
const okId = '33333333-3333-3333-3333-333333333333'
const blankNullId = '44444444-4444-4444-4444-444444444444'
const blankEmptyId = '55555555-5555-5555-5555-555555555555'
const blankWsId = '66666666-6666-6666-6666-666666666666'

const sourceDupes = [
  { id: dupA, name: 'A', email: 'dup@example.com', email_verified: true },
  { id: dupB, name: 'B', email: 'DUP@example.com', email_verified: true },
]
const found = findCaseInsensitiveEmailDupes(sourceDupes)
if (found.length !== 1 || found[0].rows.length !== 2) {
  throw new Error('findCaseInsensitiveEmailDupes missed dup@ / DUP@')
}
try {
  assertNoEmailDupes(sourceDupes)
  throw new Error('assertNoEmailDupes accepted source dupes')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted source/.test(msg)) throw err
  if (!msg.includes(dupA) || !msg.includes(dupB) || !msg.includes('dup@example.com') || !msg.includes('DUP@example.com')) {
    throw new Error(`dupe abort missing ids/emails: ${msg}`)
  }
  if (!msg.includes('wrote nothing')) throw new Error(`dupe abort missing wrote-nothing: ${msg}`)
}
if (!formatSourceUsersAbort({ blanks: [], dupes: found }).includes('wrote nothing')) {
  throw new Error('source abort must say wrote nothing')
}

let writes = 0
const denyWrite = async () => {
  writes += 1
  throw new Error('target write must not run after dupe abort')
}
try {
  await migrateAuthUsers(denyWrite, sourceDupes)
  throw new Error('migrateAuthUsers accepted source dupes')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted source|must not run/.test(msg)) throw err
}
if (writes !== 0) throw new Error(`dupe abort wrote to the target (${writes} query calls)`)
console.log('migrate users: source dupe pre-check aborts and writes nothing')

const sourceBlanks = [
  { id: blankNullId, name: 'N', email: null },
  { id: blankEmptyId, name: 'E', email: '' },
  { id: blankWsId, name: 'W', email: '   ' },
]
const blanks = findBlankEmails(sourceBlanks)
if (blanks.length !== 3) throw new Error(`findBlankEmails missed null/empty/whitespace (got ${blanks.length})`)
try {
  assertNoBlankEmails(sourceBlanks)
  throw new Error('assertNoBlankEmails accepted blank emails')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted blank/.test(msg)) throw err
  if (!msg.includes(blankNullId) || !msg.includes(blankEmptyId) || !msg.includes(blankWsId)) {
    throw new Error(`blank abort missing ids: ${msg}`)
  }
  if (!msg.includes('wrote nothing')) throw new Error(`blank abort missing wrote-nothing: ${msg}`)
}
if (!formatBlankEmailAbort(blanks).includes(blankNullId)) {
  throw new Error('formatBlankEmailAbort must list ids')
}
try {
  assertSourceUsersReady([
    { id: okId, email: 'ok@example.com' },
    { id: blankNullId, email: null },
  ])
  throw new Error('assertSourceUsersReady accepted a null email')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted a null/.test(msg)) throw err
  if (!msg.includes(blankNullId)) throw new Error(`source ready abort missing id: ${msg}`)
}
let blankWrites = 0
try {
  await migrateAuthUsers(async () => {
    blankWrites += 1
    throw new Error('target write must not run after blank abort')
  }, sourceBlanks)
  throw new Error('migrateAuthUsers accepted blank emails')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted blank|must not run/.test(msg)) throw err
}
if (blankWrites !== 0) throw new Error(`blank abort wrote to the target (${blankWrites} query calls)`)
console.log('migrate users: blank email pre-check aborts and writes nothing')

const mixedSource = [...sourceDupes, ...sourceBlanks]
try {
  assertSourceUsersReady(mixedSource)
  throw new Error('assertSourceUsersReady accepted mixed dupes and blanks')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted mixed/.test(msg)) throw err
  for (const id of [dupA, dupB, blankNullId, blankEmptyId, blankWsId]) {
    if (!msg.includes(id)) throw new Error(`mixed abort missing ${id}: ${msg}`)
  }
  if (!msg.includes('blank source emails') || !msg.includes('case-insensitive email duplicates')) {
    throw new Error(`mixed abort must list both checks: ${msg}`)
  }
}
console.log('migrate users: mixed blank + dupe abort lists both')

const spacedCounts = parseCounts(' athlete   |     2\n program    |     0\n')
if (spacedCounts.athlete !== 2 || spacedCounts.program !== 0) {
  throw new Error(`parseCounts missed aligned psql output: ${JSON.stringify(spacedCounts)}`)
}
const taCounts = parseCounts('athlete|2\ninsight|3\n')
if (taCounts.athlete !== 2 || taCounts.insight !== 3) {
  throw new Error(`parseCounts missed -tA output: ${JSON.stringify(taCounts)}`)
}
try {
  assertCountsMatch({}, { athlete: 1 }, ['athlete'])
  throw new Error('assertCountsMatch accepted a missing source count')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted a missing/.test(msg)) throw err
  if (!/missing or unparsable/.test(msg)) throw new Error(`count abort missing unparsable: ${msg}`)
}
try {
  assertCountsMatch({ athlete: 2 }, { athlete: 1 }, ['athlete'])
  throw new Error('assertCountsMatch accepted a mismatch')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/accepted a mismatch/.test(msg)) throw err
  if (!msg.includes('athlete') || !msg.includes('source=2') || !msg.includes('target=1')) {
    throw new Error(`count abort missing values: ${msg}`)
  }
}
console.log('migrate users: count parse and mismatch abort')

const client = new Client({ connectionString: url })
await client.connect()
const query = (text, params) => client.query(text, params)

async function resetTarget() {
  await client.query('DROP TABLE IF EXISTS verification, session, account, "user" CASCADE')
  await client.query('DROP TABLE IF EXISTS auth.users CASCADE')
  await client.query(STUB_AUTH_SQL)
  await client.query(BETTER_AUTH_TABLES_SQL)
}

async function emptyTarget() {
  await dropCreatedObjects(query, await listUserObjects(query))
}

try {
  await resetTarget()
  try {
    await loadAuthUsersInTransaction(query, sourceDupes)
    throw new Error('load of dup@ / DUP@ succeeded')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/succeeded/.test(msg)) throw err
  }
  const users = await client.query('SELECT count(*)::int AS n FROM "user"')
  const stubs = await client.query('SELECT count(*)::int AS n FROM auth.users')
  if (Number(users.rows[0].n) !== 0 || Number(stubs.rows[0].n) !== 0) {
    throw new Error(`load rollback left rows user=${users.rows[0].n} auth.users=${stubs.rows[0].n}`)
  }
  console.log('migrate users: failed load rolls back auth.users and "user"')

  await resetTarget()
  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'A', $2, true, NOW(), NOW()), ($3, 'B', $4, true, NOW(), NOW())`,
    [dupA, 'dup@example.com', dupB, 'DUP@example.com'],
  )
  try {
    await applyLowerEmailUniqueIndex(query)
    throw new Error('index created on existing dupes')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/index created/.test(msg)) throw err
    if (!/user_email_lower_uidx/.test(msg) || !msg.includes(dupA) || !msg.includes(dupB)) {
      throw new Error(`index dupe error was not clear: ${msg}`)
    }
    if (!msg.includes('dup@example.com') || !msg.includes('DUP@example.com')) {
      throw new Error(`index dupe error missing emails: ${msg}`)
    }
  }
  console.log('migrate users: index creation fails with ids and emails')

  await resetTarget()
  await migrateAuthUsers(query, [
    { id: okId, name: 'Ok', email: 'ok@example.com', email_verified: true },
  ])
  const ok = await client.query('SELECT email FROM "user" WHERE id = $1', [okId])
  if (ok.rows[0]?.email !== 'ok@example.com') {
    throw new Error(`clean load did not land (got ${ok.rows[0]?.email})`)
  }
  console.log('migrate users: clean load ok')

  await emptyTarget()
  try {
    await writeTargetOrCleanup(query, async () => {
      await client.query(STUB_AUTH_SQL)
      await client.query('CREATE TABLE public.athlete (id TEXT PRIMARY KEY, name TEXT)')
      await client.query(`INSERT INTO public.athlete (id, name) VALUES ('restored', 'leftover')`)
      await client.query(BETTER_AUTH_TABLES_SQL)
      await loadAuthUsersInTransaction(query, sourceBlanks)
    })
    throw new Error('blank load after restore succeeded')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/succeeded/.test(msg)) throw err
  }
  const leftoverAthlete = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'athlete'`,
  )
  const leftoverAuth = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'auth' AND table_name = 'users'`,
  )
  if (Number(leftoverAthlete.rows[0].n) !== 0 || Number(leftoverAuth.rows[0].n) !== 0) {
    throw new Error(
      `failed load left restored tables athlete=${leftoverAthlete.rows[0].n} auth.users=${leftoverAuth.rows[0].n}`,
    )
  }
  console.log('migrate users: failed load after restore drops public tables and auth stub')

  await emptyTarget()
  try {
    await migrateTarget(query, [
      { id: okId, name: 'Ok', email: 'ok@example.com', email_verified: true },
    ], async (q) => {
      await q(`CREATE TABLE public.athlete (id TEXT PRIMARY KEY, name TEXT)`)
      await q(`INSERT INTO public.athlete (id, name) VALUES ('restored', 'keep')`)
    })
  } catch (err) {
    throw new Error(`clean migrateTarget failed: ${err instanceof Error ? err.message : err}`)
  }
  const kept = await client.query('SELECT name FROM public.athlete WHERE id = $1', ['restored'])
  if (kept.rows[0]?.name !== 'keep') {
    throw new Error('clean migrateTarget dropped a successful restore')
  }
  console.log('migrate users: successful restore is kept')

  await emptyTarget()
  await client.query('CREATE TABLE public.keep_me (id int PRIMARY KEY)')
  try {
    await migrateTarget(query, [
      { id: okId, name: 'Ok', email: 'ok@example.com', email_verified: true },
    ])
    throw new Error('migrateTarget accepted a non-empty target')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/accepted a non-empty/.test(msg)) throw err
    if (!/not empty/.test(msg) || !msg.includes('keep_me')) {
      throw new Error(`non-empty abort missing keep_me: ${msg}`)
    }
  }
  const keptUnrelated = await client.query('SELECT count(*)::int AS n FROM public.keep_me')
  if (Number(keptUnrelated.rows[0].n) !== 0) {
    throw new Error('non-empty refuse wrote into keep_me')
  }
  const leftoverUser = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'user'`,
  )
  if (Number(leftoverUser.rows[0].n) !== 0) {
    throw new Error('non-empty refuse still created "user"')
  }
  console.log('migrate users: non-empty target is refused and left intact')

  await emptyTarget()
  await client.query(`CREATE TYPE public.keep_status AS ENUM ('open', 'closed')`)
  try {
    await migrateTarget(query, [
      { id: okId, name: 'Ok', email: 'ok@example.com', email_verified: true },
    ])
    throw new Error('migrateTarget accepted a target with a public enum')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/accepted a target with a public enum/.test(msg)) throw err
    if (!/not empty/.test(msg) || !msg.includes('keep_status')) {
      throw new Error(`enum abort missing keep_status: ${msg}`)
    }
  }
  const keptEnum = await client.query(
    `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'keep_status'`,
  )
  if (!keptEnum.rows.length) throw new Error('enum refuse dropped keep_status')
  console.log('migrate users: public enum makes the target non-empty')

  await emptyTarget()
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  const preExt = await listUserObjects(query)
  const preExtHash = objectHash(preExt)
  try {
    await writeTargetOrCleanup(query, async () => {
      await client.query(STUB_AUTH_SQL)
      await client.query('CREATE TABLE public.athlete (id TEXT PRIMARY KEY, name TEXT)')
      throw new Error('simulated fail with pre-existing pgcrypto')
    }, preExt)
    throw new Error('pre-existing pgcrypto fail was swallowed')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/swallowed/.test(msg)) throw err
    if (!/pre-existing pgcrypto/.test(msg)) throw err
  }
  const keptExt = await client.query(`SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`)
  if (!keptExt.rows.length) throw new Error('cleanup dropped a pre-existing pgcrypto')
  if (objectHash(await listUserObjects(query)) !== preExtHash) {
    throw new Error('pre-existing pgcrypto run changed the object hash')
  }
  console.log('migrate users: pre-existing pgcrypto is preserved on failure')

  await emptyTarget()
  const freshHash = objectHash(await listUserObjects(query))
  try {
    await writeTargetOrCleanup(query, async () => {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
      await client.query(STUB_AUTH_SQL)
      throw new Error('simulated fail after creating pgcrypto')
    })
    throw new Error('this-run pgcrypto fail was swallowed')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/swallowed/.test(msg)) throw err
    if (!/after creating pgcrypto/.test(msg)) throw err
  }
  const leftoverExt = await client.query(`SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`)
  if (leftoverExt.rows.length) throw new Error('this-run pgcrypto was left behind')
  if (objectHash(await listUserObjects(query)) !== freshHash) {
    throw new Error('this-run pgcrypto cleanup changed the object hash')
  }
  console.log('migrate users: this-run pgcrypto is dropped on failure')

  const toc = [
    '1234; 3079 1 EXTENSION - pgcrypto',
    '1235; 0 0 COMMENT - EXTENSION pgcrypto',
    '1236; 1259 2 TABLE public athlete',
  ].join('\n')
  const filtered = filterRestoreToc(toc)
  if (filtered.includes('EXTENSION')) throw new Error('restore TOC still has EXTENSION')
  if (!filtered.includes('TABLE public athlete')) throw new Error('restore TOC dropped TABLE athlete')
  console.log('migrate users: restore TOC excludes extensions')

  await emptyTarget()
  await assertTargetEmpty(query)
  try {
    await writeTargetOrCleanup(query, async () => {
      await client.query(STUB_AUTH_SQL)
      await client.query('CREATE TABLE public.athlete (id TEXT PRIMARY KEY, name TEXT)')
      await client.query(`CREATE OR REPLACE FUNCTION public.this_run_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`)
      throw new Error('simulated later-step failure')
    })
    throw new Error('later-step failure was swallowed')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/swallowed/.test(msg)) throw err
    if (!/simulated later-step/.test(msg)) throw err
  }
  const afterFail = await listUserObjects(query)
  if (afterFail.length) {
    throw new Error(`rerun leftover after failure: ${afterFail.map((o) => `${o.schema}.${o.name}`).join(',')}`)
  }
  await migrateTarget(query, [
    { id: okId, name: 'Ok', email: 'ok@example.com', email_verified: true },
  ])
  const rerun = await client.query('SELECT email FROM "user" WHERE id = $1', [okId])
  if (rerun.rows[0]?.email !== 'ok@example.com') {
    throw new Error(`rerun after failure did not load (got ${rerun.rows[0]?.email})`)
  }
  console.log('migrate users: rerun after failure succeeds on a cleaned target')
} finally {
  await client.query('DROP TABLE IF EXISTS verification, session, account, "user", public.athlete, public.keep_me CASCADE').catch(() => {})
  await client.query('DROP FUNCTION IF EXISTS public.this_run_fn() CASCADE').catch(() => {})
  await client.query('DROP TYPE IF EXISTS public.keep_status CASCADE').catch(() => {})
  await client.query('DROP SCHEMA IF EXISTS auth CASCADE').catch(() => {})
  await client.end()
}
