#!/usr/bin/env node
/**
 * Dump a Zeroed Supabase project into Neon (schema + data) and map
 * auth.users → Better Auth `user` with the same UUIDs so athlete.auth_user_id
 * foreign keys still hold.
 *
 * Does NOT run against prod unless you pass real URLs. Never deletes the source.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgres://... NEON_DB_URL=postgres://... \
 *     node scripts/migrate-supabase-to-neon.mjs
 *
 *   node scripts/migrate-supabase-to-neon.mjs --dry-run
 *
 * Requires: pg_dump, psql, pg_restore (PostgreSQL client tools).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const source = process.env.SUPABASE_DB_URL || process.env.SOURCE_DATABASE_URL || ''
const target = process.env.NEON_DB_URL || process.env.TARGET_DATABASE_URL || ''

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim()
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${err}`)
  }
  return res.stdout
}

function needBin(name) {
  const res = spawnSync(name, ['--version'], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`Missing ${name}. Install PostgreSQL client tools.`)
}

const TRANSFORM_SQL = `
-- Drop Supabase-only RLS / auth helpers. Access is enforced in the Worker.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END $$;

DROP POLICY IF EXISTS athlete_select ON public.athlete;
DROP FUNCTION IF EXISTS public.get_current_athlete_id();

-- Better Auth tables (ids are text so we can keep the Supabase UUIDs).
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

-- athlete.auth_user_id pointed at auth.users. After the dump it is a bare UUID.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'athlete'
      AND constraint_name = 'athlete_auth_user_id_fkey'
  ) THEN
    ALTER TABLE public.athlete DROP CONSTRAINT athlete_auth_user_id_fkey;
  END IF;
END $$;
`

function checksumQuery() {
  return `
    SELECT 'athlete' AS t, COUNT(*)::bigint AS n FROM public.athlete
    UNION ALL SELECT 'program', COUNT(*) FROM public.program
    UNION ALL SELECT 'phase', COUNT(*) FROM public.phase
    UNION ALL SELECT 'routine', COUNT(*) FROM public.routine
    UNION ALL SELECT 'workout', COUNT(*) FROM public.workout
    UNION ALL SELECT 'insight', COUNT(*) FROM public.insight
    UNION ALL SELECT 'mcp_token', COUNT(*) FROM public.mcp_token
    ORDER BY 1;
  `
}

function parseCounts(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)\s*\|\s*(\d+)/)
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

if (dryRun && !source && !target) {
  console.log('dry-run: would pg_dump public + auth.users from SUPABASE_DB_URL')
  console.log('dry-run: would pg_restore into NEON_DB_URL')
  console.log('dry-run: would insert auth.users into Better Auth "user" with the same ids')
  console.log('dry-run: would disable RLS and drop auth.users FKs')
  console.log('dry-run: would compare row counts per table and abort on mismatch')
  console.log('tools required: pg_dump, pg_restore, psql')
  process.exit(0)
}

if (!source || !target) {
  console.error('Set SUPABASE_DB_URL and NEON_DB_URL (or pass --dry-run).')
  process.exit(2)
}

needBin('pg_dump')
needBin('pg_restore')
needBin('psql')

const dir = mkdtempSync(join(tmpdir(), 'zeroed-migrate-'))
const dumpPath = join(dir, 'public.dump')
const usersPath = join(dir, 'auth_users.csv')
const transformPath = join(dir, 'transform.sql')

try {
  writeFileSync(transformPath, TRANSFORM_SQL)
  console.log('dumping public schema + data (no-owner, no-acl)…')
  run('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--schema=public',
    `--file=${dumpPath}`,
    source,
  ])

  console.log('exporting auth.users…')
  const usersCopy = `
    COPY (
      SELECT id::text, COALESCE(raw_user_meta_data->>'name', split_part(email, '@', 1), ''),
             email, COALESCE(email_confirmed_at IS NOT NULL, false),
             created_at, updated_at
      FROM auth.users
    ) TO STDOUT WITH CSV
  `
  const csv = run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', source, '-c', usersCopy])
  writeFileSync(usersPath, csv)

  if (dryRun) {
    console.log(`dry-run: dump at ${dumpPath} (${readFileSync(dumpPath).length} bytes)`)
    console.log(`dry-run: ${csv.trim().split('\n').filter(Boolean).length} auth.users rows`)
    process.exit(0)
  }

  console.log('restoring into Neon…')
  run('pg_restore', ['--no-owner', '--no-acl', '--dbname', target, dumpPath])
  run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', transformPath])

  console.log('mapping auth.users → "user"…')
  const loadUsers = `
    CREATE TEMP TABLE auth_users_import (
      id TEXT, name TEXT, email TEXT, email_verified BOOLEAN,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    );
    \\copy auth_users_import FROM '${usersPath}' WITH CSV
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    SELECT id, name, email, email_verified, created_at, COALESCE(updated_at, created_at)
    FROM auth_users_import
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      email_verified = EXCLUDED.email_verified;
  `
  writeFileSync(join(dir, 'load_users.sql'), loadUsers)
  run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(dir, 'load_users.sql')])

  const srcCounts = parseCounts(run('psql', ['-d', source, '-c', checksumQuery()]))
  const dstCounts = parseCounts(run('psql', ['-d', target, '-c', checksumQuery()]))
  let mismatch = false
  for (const table of Object.keys(srcCounts)) {
    const a = srcCounts[table]
    const b = dstCounts[table] ?? -1
    const mark = a === b ? 'ok' : 'MISMATCH'
    console.log(`  ${table}: source=${a} neon=${b} ${mark}`)
    if (a !== b) mismatch = true
  }
  if (mismatch) {
    console.error('Row-count mismatch — abort. Neon was written but is not trusted.')
    process.exit(1)
  }
  console.log('migration ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
