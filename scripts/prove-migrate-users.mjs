#!/usr/bin/env node
/**
 * Source email-dupe pre-check writes nothing; user/auth load is one
 * transaction; creating the lower(email) index fails with ids + emails.
 */
import { Client } from 'pg'
import {
  BETTER_AUTH_TABLES_SQL,
  applyLowerEmailUniqueIndex,
  STUB_AUTH_SQL,
  assertNoEmailDupes,
  findCaseInsensitiveEmailDupes,
  formatEmailDupeAbort,
  loadAuthUsersInTransaction,
  migrateAuthUsers,
} from './migrate-users.lib.mjs'

const url = process.env.DATABASE_URL?.trim()
if (!url) throw new Error('DATABASE_URL is required for check:migrate-users')

const dupA = '11111111-1111-1111-1111-111111111111'
const dupB = '22222222-2222-2222-2222-222222222222'
const okId = '33333333-3333-3333-3333-333333333333'

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
} finally {
  await client.end()
}
