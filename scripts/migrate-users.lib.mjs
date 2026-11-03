/**
 * Auth-user cutover helpers. Source is read-only. Target writes happen only
 * after source-user validation and a non-empty-target refusal. Created objects
 * are tracked; failure drops only those. Never DROP SCHEMA public.
 */
import { createHash } from 'node:crypto'

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
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
`

/** First target write. Snapshot first so a this-run CREATE is in the cleanup diff. */
export const REQUIRED_EXTENSIONS_SQL = `CREATE EXTENSION IF NOT EXISTS pgcrypto;
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

export const CREATE_LOWER_EMAIL_INDEX_SQL =
  `${CHECK_LOWER_EMAIL_DUPES_SQL}\n${CREATE_LOWER_EMAIL_INDEX_ONLY_SQL}\n`

export async function applyLowerEmailUniqueIndex(query) {
  await query(CHECK_LOWER_EMAIL_DUPES_SQL)
  await query(CREATE_LOWER_EMAIL_INDEX_ONLY_SQL)
}

export const CHECKSUM_TABLES = [
  'athlete',
  'athlete_goal',
  'athlete_profile',
  'autoreg_rule',
  'coach_message',
  'diagnostic',
  'goal_measurement',
  'insight',
  'insight_draft',
  'mcp_token',
  'phase',
  'probe_throttle',
  'program',
  'program_revision',
  'progression_rule',
  'routine',
  'session_observation',
  'track',
  'weekly_review',
  'workout',
  'workout_draft',
  'workout_note',
]

export function checksumQuery() {
  return CHECKSUM_TABLES
    .map((table, i) => (
      i === 0
        ? `SELECT '${table}' AS t, COUNT(*)::bigint AS n FROM public.${table}`
        : `UNION ALL SELECT '${table}', COUNT(*) FROM public.${table}`
    ))
    .join('\n')
    + '\nORDER BY 1'
}

export function parseCountLine(line) {
  const trimmed = String(line).trim()
  if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('(')) return null
  const pipe = trimmed.match(/^(\w+)\s*\|\s*(-?\d+)\s*$/)
  if (pipe && pipe[1] !== 't') return { table: pipe[1], n: Number(pipe[2]) }
  const ta = trimmed.match(/^(\w+)\|(-?\d+)$/)
  if (ta && ta[1] !== 't') return { table: ta[1], n: Number(ta[2]) }
  return null
}

export function parseCounts(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const parsed = parseCountLine(line)
    if (parsed) out[parsed.table] = parsed.n
  }
  return out
}

export function assertCountsMatch(src, dst, tables = CHECKSUM_TABLES) {
  const problems = []
  for (const table of tables) {
    const a = src?.[table]
    const b = dst?.[table]
    if (!Number.isFinite(a)) problems.push(`${table}: source count missing or unparsable`)
    if (!Number.isFinite(b)) problems.push(`${table}: target count missing or unparsable`)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      problems.push(`${table}: source=${a} target=${b}`)
    }
  }
  if (problems.length) {
    throw new Error(`row-count mismatch — abort:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  }
}

const USER_OBJECT_FROM = `
SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, '' AS args
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'auth')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE d.objid = c.oid AND d.deptype = 'e'
  )
UNION ALL
SELECT n.nspname, p.proname, 'f', pg_get_function_identity_arguments(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE d.objid = p.oid AND d.deptype = 'e'
  )
UNION ALL
SELECT n.nspname, t.typname, 't', ''
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname IN ('public', 'auth')
  AND t.typtype IN ('e', 'c', 'd')
  AND (t.typrelid = 0 OR NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = t.typrelid AND c.relkind IN ('r', 'p', 'v', 'm')
  ))
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE d.objid = t.oid AND d.deptype = 'e'
  )
UNION ALL
SELECT n.nspname, e.extname, 'e', ''
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE n.nspname IN ('public', 'auth')
UNION ALL
SELECT n.nspname, n.nspname, 'n', ''
FROM pg_namespace n
WHERE n.nspname = 'auth'
`

export const LIST_USER_OBJECTS_SQL = `
SELECT schema, name, kind, args FROM (${USER_OBJECT_FROM}) list
ORDER BY schema, kind, name, args
`

export const LIST_USER_OBJECTS_TEXT_SQL = `
SELECT schema || E'\\t' || kind || E'\\t' || name || E'\\t' || COALESCE(args, '')
FROM (${USER_OBJECT_FROM}) list
ORDER BY schema, kind, name, args
`

export function parseObjectList(text) {
  const rows = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const [schema, kind, name, ...rest] = line.split('\t')
    if (!schema || !kind || !name) continue
    rows.push({ schema, kind, name, args: rest.join('\t') })
  }
  return rows
}

export function objectKey(row) {
  return `${row.schema}\0${row.kind}\0${row.name}\0${row.args ?? ''}`
}

export function createdSince(before, after) {
  const keys = new Set((before ?? []).map(objectKey))
  return (after ?? []).filter((row) => !keys.has(objectKey(row)))
}

/** Stable fingerprint of tracked objects. Used to prove a failed run is a no-op. */
export function objectHash(objects) {
  const payload = (objects ?? [])
    .map((row) => `${row.schema}\t${row.kind}\t${row.name}\t${row.args ?? ''}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(payload).digest('hex')
}

/** Extensions may already exist on a fresh Neon DB; they do not make it dirty. */
export function isNonEmptyTargetObject(row) {
  return row.kind !== 'e'
}

export function quoteIdent(ident) {
  return `"${String(ident).replaceAll('"', '""')}"`
}

export function dropCreatedSql(created) {
  const lines = []
  for (const row of created) {
    if (row.kind === 'r' || row.kind === 'p') {
      lines.push(`DROP TABLE IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)} CASCADE;`)
    }
  }
  for (const row of created) {
    if (row.kind === 'v') {
      lines.push(`DROP VIEW IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)} CASCADE;`)
    }
    if (row.kind === 'm') {
      lines.push(`DROP MATERIALIZED VIEW IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)} CASCADE;`)
    }
  }
  for (const row of created) {
    if (row.kind === 'S') {
      lines.push(`DROP SEQUENCE IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)} CASCADE;`)
    }
  }
  for (const row of created) {
    if (row.kind === 'f') {
      lines.push(
        `DROP FUNCTION IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)}(${row.args ?? ''}) CASCADE;`,
      )
    }
  }
  for (const row of created) {
    if (row.kind === 't') {
      lines.push(`DROP TYPE IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)} CASCADE;`)
    }
  }
  for (const row of created) {
    if (row.kind === 'e') {
      lines.push(`DROP EXTENSION IF EXISTS ${quoteIdent(row.name)};`)
    }
  }
  if (created.some((row) => row.kind === 'n' && row.name === 'auth')) {
    lines.push('DROP SCHEMA IF EXISTS auth CASCADE;')
  }
  return lines.join('\n') + (lines.length ? '\n' : '')
}

export async function listUserObjects(query) {
  const res = await query(LIST_USER_OBJECTS_SQL)
  return res.rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    kind: row.kind,
    args: row.args ?? '',
  }))
}

export async function dropCreatedObjects(query, created) {
  const sql = dropCreatedSql(created)
  if (!sql.trim()) return
  for (const statement of sql.split('\n').map((s) => s.trim()).filter(Boolean)) {
    await query(statement)
  }
}

export function formatNonEmptyTargetAbort(objects) {
  const lines = objects.map((row) => `  ${row.schema}.${row.name} (${row.kind})`)
  return `target is not empty — abort, wrote nothing:\n${lines.join('\n')}`
}

export async function assertTargetEmpty(query) {
  const objects = (await listUserObjects(query)).filter(isNonEmptyTargetObject)
  if (objects.length) throw new Error(formatNonEmptyTargetAbort(objects))
}

export function filterRestoreToc(listText) {
  return String(listText)
    .split('\n')
    .filter((line) => {
      if (line.trimStart().startsWith(';')) return true
      if (/\bSCHEMA - public\b/.test(line) || /\bSCHEMA public\b/.test(line)) return false
      if (/\bCOMMENT\b/.test(line) && /\bSCHEMA public\b/.test(line)) return false
      if (/\bEXTENSION\b/.test(line)) return false
      return true
    })
    .join('\n')
}

export function parseAuthUsersCsv(csv) {
  const users = []
  for (const line of String(csv).split(/\r?\n/)) {
    if (!line.trim()) continue
    const cols = parseCsvLine(line)
    if (!cols[0]) continue
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

export function emailIsBlank(email) {
  if (email == null) return true
  if (typeof email !== 'string') return true
  return email.trim() === ''
}

export function describeSourceEmail(email) {
  if (email == null) return '<null>'
  if (typeof email !== 'string') return `<${typeof email}>`
  if (email === '') return '<empty>'
  if (email.trim() === '') return '<whitespace>'
  return email
}

export function findBlankEmails(users) {
  return users.filter((user) => emailIsBlank(user.email))
}

export function formatBlankEmailAbort(rows) {
  const lines = rows.map((row) => `  ${row.id} ${describeSourceEmail(row.email)}`)
  return `blank source emails:\n${lines.join('\n')}`
}

export function assertNoBlankEmails(users) {
  const blanks = findBlankEmails(users)
  if (blanks.length) {
    throw new Error(`source users invalid — abort, wrote nothing:\n${formatBlankEmailAbort(blanks)}`)
  }
}

export function findCaseInsensitiveEmailDupes(users) {
  const groups = new Map()
  for (const user of users) {
    if (emailIsBlank(user.email)) continue
    const key = String(user.email).toLowerCase()
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
  return `case-insensitive email duplicates:\n${lines.join('\n')}`
}

export function assertNoEmailDupes(users) {
  const dupes = findCaseInsensitiveEmailDupes(users)
  if (dupes.length) {
    throw new Error(`source users invalid — abort, wrote nothing:\n${formatEmailDupeAbort(dupes)}`)
  }
}

export function formatSourceUsersAbort({ blanks, dupes }) {
  const parts = ['source users invalid — abort, wrote nothing:']
  if (blanks.length) parts.push(formatBlankEmailAbort(blanks))
  if (dupes.length) parts.push(formatEmailDupeAbort(dupes))
  return parts.join('\n')
}

/** All source-user checks. Reports blank emails and dupes together. */
export function assertSourceUsersReady(users) {
  const blanks = findBlankEmails(users)
  const dupes = findCaseInsensitiveEmailDupes(users)
  if (blanks.length || dupes.length) throw new Error(formatSourceUsersAbort({ blanks, dupes }))
}

function authUsersImportSql(csvPath, extraInserts) {
  return `
BEGIN;
CREATE TEMP TABLE auth_users_import (
  id TEXT, name TEXT, email TEXT, email_verified BOOLEAN,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
) ON COMMIT DROP;
\\copy auth_users_import FROM '${csvPath}' WITH CSV
${extraInserts}
COMMIT;
`
}

/** Load the stub before pg_restore so public FKs to auth.users can land. */
export function loadStubAuthUsersSql(csvPath) {
  return authUsersImportSql(csvPath, `
INSERT INTO auth.users (id, email, created_at, updated_at)
SELECT id::uuid, email, created_at, COALESCE(updated_at, created_at)
FROM auth_users_import
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
`)
}

export function loadBetterAuthUsersSql(csvPath) {
  return authUsersImportSql(csvPath, `
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
SELECT id, name, lower(email), email_verified, created_at, COALESCE(updated_at, created_at)
FROM auth_users_import
ON CONFLICT (id) DO UPDATE SET
  email = lower(EXCLUDED.email),
  name = EXCLUDED.name,
  email_verified = EXCLUDED.email_verified;
${CREATE_LOWER_EMAIL_INDEX_SQL}
`)
}

export function loadAuthUsersSql(csvPath) {
  return authUsersImportSql(csvPath, `
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
`)
}

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

export async function migrateAuthUsers(query, rows) {
  assertSourceUsersReady(rows)
  return loadAuthUsersInTransaction(query, rows)
}

/** Run target writes; on failure drop only objects created since `before`. */
export async function writeTargetOrCleanup(query, work, before = null) {
  const snapshot = before ?? await listUserObjects(query)
  try {
    await work()
  } catch (err) {
    const after = await listUserObjects(query)
    try { await dropCreatedObjects(query, createdSince(snapshot, after)) } catch { /* still surface the load error */ }
    throw err
  }
}

export async function migrateTarget(query, rows, afterStub) {
  assertSourceUsersReady(rows)
  await assertTargetEmpty(query)
  return writeTargetOrCleanup(query, async () => {
    await query(REQUIRED_EXTENSIONS_SQL)
    await query(STUB_AUTH_SQL)
    if (afterStub) await afterStub(query)
    await query(BETTER_AUTH_TABLES_SQL)
    await loadAuthUsersInTransaction(query, rows)
  })
}
