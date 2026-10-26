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
  assertNoBlankEmails,
  assertNoEmailDupes,
  assertSourceUsersReady,
  findBlankEmails,
  findCaseInsensitiveEmailDupes,
  formatBlankEmailAbort,
  formatEmailDupeAbort,
  loadAuthUsersInTransaction,
  migrateAuthUsers,
  migrateTarget,
  writeTargetOrCleanup,
} from './migrate-users.lib.mjs'

const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required for check:migrate-users')

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
if (!formatEmailDupeAbort(found).includes('wrote nothing')) {
  throw new Error('formatEmailDupeAbort must say wrote nothing')
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

const client = new Client({ connectionString: url })
await client.connect()
const query = (text, params) => client.query(text, params)

async function resetTarget() {
  await client.query('DROP TABLE IF EXISTS verification, session, account, "user" CASCADE')
  await client.query('DROP TABLE IF EXISTS auth.users CASCADE')
  await client.query(STUB_AUTH_SQL)
  await client.query(BETTER_AUTH_TABLES_SQL)
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

  await client.query('DROP TABLE IF EXISTS verification, session, account, "user" CASCADE')
  await client.query('DROP TABLE IF EXISTS auth.users CASCADE')
  await client.query('DROP TABLE IF EXISTS public.athlete CASCADE')
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

  await client.query('DROP TABLE IF EXISTS verification, session, account, "user" CASCADE')
  await client.query('DROP TABLE IF EXISTS auth.users CASCADE')
  await client.query('DROP TABLE IF EXISTS public.athlete CASCADE')
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
} finally {
  await client.query('DROP TABLE IF EXISTS verification, session, account, "user", public.athlete CASCADE').catch(() => {})
  await client.query('DROP TABLE IF EXISTS auth.users CASCADE').catch(() => {})
  await client.end()
}
