#!/usr/bin/env node
/**
 * Dump a Zeroed Supabase project into Neon (schema + data) and map
 * auth.users → Better Auth `user` with the same UUIDs so athlete.auth_user_id
 * still matches.
 *
 * SOURCE IS READ-ONLY. The script only runs pg_dump and COPY … TO STDOUT
 * against SUPABASE_DB_URL. It never ALTER/DROP/DISABLE anything on the source.
 *
 * Target-only optional relax (`--relax-target-rls`): disable RLS, drop
 * athlete_select / get_current_athlete_id() / athlete_auth_user_id_fkey on
 * the Neon database after restore. Off by default — the Worker connects as
 * the table owner (RLS does not apply unless FORCE ROW LEVEL SECURITY).
 * A stub `auth.users` + `auth.uid()` is created on the target before restore
 * so dumped FKs and SQL functions can land on a fresh Postgres.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgres://... NEON_DB_URL=postgres://... \
 *     node scripts/migrate-supabase-to-neon.mjs
 *
 *   node scripts/migrate-supabase-to-neon.mjs --dry-run
 *   node scripts/migrate-supabase-to-neon.mjs --relax-target-rls
 *
 * Requires: pg_dump, psql, pg_restore (PostgreSQL client tools).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BETTER_AUTH_TABLES_SQL,
  CHECKSUM_TABLES,
  LIST_USER_OBJECTS_TEXT_SQL,
  STUB_AUTH_SQL,
  assertCountsMatch,
  assertSourceUsersReady,
  checksumQuery,
  createdSince,
  dropCreatedSql,
  filterRestoreToc,
  formatNonEmptyTargetAbort,
  loadBetterAuthUsersSql,
  loadStubAuthUsersSql,
  parseAuthUsersCsv,
  parseCounts,
  parseObjectList,
} from './migrate-users.lib.mjs'

const dryRun = process.argv.includes('--dry-run')
const relaxTargetRls = process.argv.includes('--relax-target-rls')
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

function psql(url, extraArgs, sql) {
  return run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', url, ...extraArgs, '-c', sql])
}

/** Neon target only. Never concatenated into a source session. */
const RELAX_TARGET_SQL = `
-- TARGET ONLY (--relax-target-rls). Access is enforced in the Worker.
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

if (dryRun && !source && !target) {
  console.log('dry-run: would pg_dump public + auth.users from SUPABASE_DB_URL (read-only)')
  console.log('dry-run: would abort before any Neon write if an email is blank or lower(email) is duplicated (both lists)')
  console.log('dry-run: would refuse a non-empty target (any user object in public or auth)')
  console.log('dry-run: would create stub auth.users + auth.uid() on NEON_DB_URL, then pg_restore --exit-on-error')
  console.log('dry-run: would insert auth.users into Better Auth "user" (and stub auth.users) with the same ids in one transaction')
  console.log(relaxTargetRls
    ? 'dry-run: --relax-target-rls is on — would DISABLE RLS and drop policy/function/FK on Neon only'
    : 'dry-run: would leave RLS / athlete_select / get_current_athlete_id / auth_user_id FK on Neon (pass --relax-target-rls to drop them on the target)')
  console.log('dry-run: would compare row counts per table with psql -tA and abort on mismatch or unparsable counts')
  console.log('tools required: pg_dump, pg_restore, psql')
  process.exit(0)
}

if (!source || !target) {
  console.error('Set SUPABASE_DB_URL and NEON_DB_URL (or pass --dry-run).')
  process.exit(2)
}

if (source === target) {
  console.error('SUPABASE_DB_URL and NEON_DB_URL must be different. Source is read-only.')
  process.exit(2)
}

needBin('pg_dump')
needBin('pg_restore')
needBin('psql')

const dir = mkdtempSync(join(tmpdir(), 'zeroed-migrate-'))
const dumpPath = join(dir, 'public.dump')
const usersPath = join(dir, 'auth_users.csv')
const stubAuthPath = join(dir, 'stub_auth.sql')
const betterAuthPath = join(dir, 'better_auth.sql')
const relaxPath = join(dir, 'relax_target.sql')
try {
  writeFileSync(stubAuthPath, STUB_AUTH_SQL)
  writeFileSync(betterAuthPath, BETTER_AUTH_TABLES_SQL)
  writeFileSync(relaxPath, RELAX_TARGET_SQL)

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

  console.log('pre-checking source emails (read-only)…')
  assertSourceUsersReady(parseAuthUsersCsv(csv))

  if (dryRun) {
    console.log(`dry-run: dump at ${dumpPath} (${readFileSync(dumpPath).length} bytes)`)
    console.log(`dry-run: ${csv.trim().split('\n').filter(Boolean).length} auth.users rows`)
    console.log(relaxTargetRls
      ? 'dry-run: would apply --relax-target-rls on Neon only'
      : 'dry-run: would keep RLS artifacts on Neon')
    process.exit(0)
  }

  console.log('checking target is empty…')
  const before = parseObjectList(psql(target, ['-tA'], LIST_USER_OBJECTS_TEXT_SQL))
  if (before.length) throw new Error(formatNonEmptyTargetAbort(before))

  let wroteTarget = false
  try {
    console.log('creating stub auth.users + auth.uid() on Neon (target only)…')
    wroteTarget = true
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', stubAuthPath])
    const stubUsersPath = join(dir, 'load_stub_users.sql')
    writeFileSync(stubUsersPath, loadStubAuthUsersSql(usersPath))
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', stubUsersPath])

    console.log('restoring into Neon…')
    const tocPath = join(dir, 'restore.toc')
    const filteredTocPath = join(dir, 'restore.filtered.toc')
    writeFileSync(tocPath, run('pg_restore', ['-l', dumpPath]))
    writeFileSync(filteredTocPath, filterRestoreToc(readFileSync(tocPath, 'utf8')))
    run('pg_restore', [
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '-L', filteredTocPath,
      '--dbname', target,
      dumpPath,
    ])
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', betterAuthPath])
    if (relaxTargetRls) {
      console.log('relaxing RLS / auth helpers on Neon (--relax-target-rls)…')
      run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', relaxPath])
    } else {
      console.log('keeping RLS / auth helpers on Neon (pass --relax-target-rls to drop them on the target)')
    }

    console.log('mapping auth.users → "user" (one transaction)…')
    const loadPath = join(dir, 'load_users.sql')
    writeFileSync(loadPath, loadBetterAuthUsersSql(usersPath))
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', loadPath])

    const srcCounts = parseCounts(psql(source, ['-tA'], checksumQuery()))
    const dstCounts = parseCounts(psql(target, ['-tA'], checksumQuery()))
    for (const table of CHECKSUM_TABLES) {
      console.log(`  ${table}: source=${srcCounts[table]} neon=${dstCounts[table]}`)
    }
    assertCountsMatch(srcCounts, dstCounts)
    console.log('migration ok')
  } catch (err) {
    if (wroteTarget) {
      console.error('load failed — dropping objects this run created…')
      const after = parseObjectList(psql(target, ['-tA'], LIST_USER_OBJECTS_TEXT_SQL))
      const created = createdSince(before, after)
      const cleanupPath = join(dir, 'cleanup_this_run.sql')
      writeFileSync(cleanupPath, dropCreatedSql(created))
      if (readFileSync(cleanupPath, 'utf8').trim()) {
        run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', cleanupPath])
      }
    }
    throw err
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
