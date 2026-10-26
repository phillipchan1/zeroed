/**
 * Auth-user cutover helpers. Source is read-only. Target writes happen only
 * after a case-insensitive email pre-check; the load itself is one transaction.
 */
export const STUB_AUTH_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY,
  email TEXT,
  raw_user_meta_data JSONB,
  email_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
`

export const BETTER_AUTH_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_user_id_idx ON session(user_id);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account(user_id);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
`

/** Fails with ids + emails when lower(email) is not unique. One statement for pg. */
export const CHECK_LOWER_EMAIL_DUPES_SQL = `
DO $$
DECLARE
  listing text;
BEGIN
  SELECT string_agg(format('%s %s', id, email), E'\\n' ORDER BY lower(email), id)
  INTO listing
  FROM "user" u
  WHERE EXISTS (
    SELECT 1 FROM "user" o
    WHERE lower(o.email) = lower(u.email) AND o.id <> u.id
  );
  IF listing IS NOT NULL THEN
    RAISE EXCEPTION 'cannot create unique index user_email_lower_uidx: case-insensitive email duplicates:%', E'\\n' || listing;
  END IF;
END $$;
`

export const CREATE_LOWER_EMAIL_INDEX_ONLY_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS user_email_lower_uidx ON "user" (lower(email));`

/** psql script: clear error if dupes exist, then create the index. */
export const CREATE_LOWER_EMAIL_INDEX_SQL =
  `${CHECK_LOWER_EMAIL_DUPES_SQL}\n${CREATE_LOWER_EMAIL_INDEX_ONLY_SQL}\n`

/** pg client cannot run two statements in one query. */
export async function applyLowerEmailUniqueIndex(query) {
  await query(CHECK_LOWER_EMAIL_DUPES_SQL)
  await query(CREATE_LOWER_EMAIL_INDEX_ONLY_SQL)
}

export const SOURCE_EMAIL_DUPE_SQL = `
SELECT id::text AS id, email
FROM auth.users
WHERE email IS NOT NULL
  AND lower(email) IN (
    SELECT lower(email) FROM auth.users
    WHERE email IS NOT NULL
    GROUP BY lower(email)
    HAVING count(*) > 1
  )
ORDER BY lower(email), id
`

export function parseAuthUsersCsv(csv) {
  const users = []
  for (const line of String(csv).split(/\r?\n/)) {
    if (!line.trim()) continue
    const cols = parseCsvLine(line)
    if (cols.length < 3) continue
    users.push({
      id: cols[0],
      name: cols[1] ?? '',
      email: cols[2] ?? '',
      email_verified: cols[3] === 't' || cols[3] === 'true' || cols[3] === '1',
      created_at: cols[4] || null,
      updated_at: cols[5] || null,
    })
  }
  return users
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
        continue
      }
      if (ch === '"') {
        quoted = false
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

export function findCaseInsensitiveEmailDupes(users) {
  const groups = new Map()
  for (const user of users) {
    const email = typeof user.email === 'string' ? user.email : ''
    const key = email.toLowerCase()
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(user)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([emailKey, rows]) => ({ emailKey, rows }))
}

export function formatEmailDupeAbort(dupes) {
  const lines = dupes.flatMap((group) =>
    group.rows.map((row) => `  ${row.id} ${row.email}`),
  )
  return `case-insensitive email duplicates — abort, wrote nothing:\n${lines.join('\n')}`
}

export function assertNoEmailDupes(users) {
  const dupes = findCaseInsensitiveEmailDupes(users)
  if (dupes.length) throw new Error(formatEmailDupeAbort(dupes))
}

export function loadAuthUsersSql(csvPath) {
  return `
BEGIN;
CREATE TEMP TABLE auth_users_import (
  id TEXT, name TEXT, email TEXT, email_verified BOOLEAN,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
) ON COMMIT DROP;
\\copy auth_users_import FROM '${csvPath}' WITH CSV
INSERT INTO auth.users (id, email, created_at, updated_at)
SELECT id::uuid, email, created_at, COALESCE(updated_at, created_at)
FROM auth_users_import
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
SELECT id, name, lower(email), email_verified, created_at, COALESCE(updated_at, created_at)
FROM auth_users_import
ON CONFLICT (id) DO UPDATE SET
  email = lower(EXCLUDED.email),
  name = EXCLUDED.name,
  email_verified = EXCLUDED.email_verified;
${CREATE_LOWER_EMAIL_INDEX_SQL}
COMMIT;
`
}

/** Target writes. Caller must have already run assertNoEmailDupes. */
export async function loadAuthUsersInTransaction(query, rows) {
  await query('BEGIN')
  try {
    for (const row of rows) {
      await query(
        `INSERT INTO auth.users (id, email, created_at, updated_at)
         VALUES ($1::uuid, $2, COALESCE($3::timestamptz, NOW()), COALESCE($4::timestamptz, NOW()))
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        [row.id, row.email, row.created_at ?? null, row.updated_at ?? null],
      )
      await query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ($1, $2, lower($3), $4, COALESCE($5::timestamptz, NOW()), COALESCE($6::timestamptz, NOW()))
         ON CONFLICT (id) DO UPDATE SET
           email = lower(EXCLUDED.email),
           name = EXCLUDED.name,
           email_verified = EXCLUDED.email_verified`,
        [
          row.id,
          row.name ?? '',
          row.email,
          Boolean(row.email_verified),
          row.created_at ?? null,
          row.updated_at ?? null,
        ],
      )
    }
    await applyLowerEmailUniqueIndex(query)
    await query('COMMIT')
  } catch (err) {
    try { await query('ROLLBACK') } catch { /* already aborted */ }
    throw err
  }
}

/**
 * Pre-check, then load. If dupes exist this throws and `query` is never
 * called — the target is not written.
 */
export async function migrateAuthUsers(query, rows) {
  assertNoEmailDupes(rows)
  return loadAuthUsersInTransaction(query, rows)
}
