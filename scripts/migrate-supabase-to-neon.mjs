#!/usr/bin/env node
/**
 * Dump Zeroed public data from Supabase into Neon and map auth users →
 * Better Auth `user` with the same UUIDs so athlete.auth_user_id still matches.
 *
 * SOURCE IS READ-ONLY. The script only runs pg_dump and (unless skipped)
 * COPY … TO STDOUT against the source URL. It never ALTER/DROP/DISABLE
 * anything on the source.
 *
 * Schema then data (the script handles this):
 *   1. Apply worker/schema/app.sql + better-auth.sql on Neon if needed
 *   2. Load auth user mappings into auth.users + Better Auth "user"
 *   3. Data-only restore of public.* (no Supabase RLS / GRANT dump)
 *
 * The migration role often cannot read auth.users. In that case:
 *   --skip-auth-users --auth-users-file=users.json
 * The file is CSV or JSON of (id, email, created_at). Those ids are written
 * into Better Auth "user" unchanged.
 * A live restore with --skip-auth-users and no mapping file exits 2.
 *
 * Usage:
 *   SUPABASE_READONLY_URL=… NEON_DIRECT_URL=… \
 *     node scripts/migrate-supabase-to-neon.mjs --skip-auth-users --auth-users-file=users.csv
 *
 *   node scripts/migrate-supabase-to-neon.mjs --dry-run
 *   node scripts/migrate-supabase-to-neon.mjs --relax-target-rls
 *
 * Env aliases: SUPABASE_DB_URL / SOURCE_DATABASE_URL,
 *              NEON_DB_URL / TARGET_DATABASE_URL,
 *              AUTH_USERS_FILE
 *
 * Requires: pg_dump, psql, pg_restore (PostgreSQL client tools).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

export function redactSecrets(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

export function postgresUrlParts(url) {
  const parsed = new URL(url)
  return {
    user: decodeURIComponent(parsed.username || ''),
    host: decodeURIComponent(parsed.hostname || ''),
  }
}

/** GitHub Actions masks. Call before any pg_dump / psql / pg_restore. */
export function addMaskLines(urls) {
  const values = new Set()
  for (const url of urls) {
    if (!url) continue
    try {
      const { user, host } = postgresUrlParts(url)
      if (user) values.add(user)
      if (host) values.add(host)
    } catch {
      // unparseable URL — skip rather than print it
    }
  }
  return [...values].map((v) => `::add-mask::${v}`)
}

export function maskDatabaseUrls(...urls) {
  for (const line of addMaskLines(urls)) console.log(line)
}

export function argValue(argv, name) {
  const prefix = `${name}=`
  const eq = argv.find((a) => a.startsWith(prefix))
  if (eq) return eq.slice(prefix.length)
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
  return ''
}

export function parseMigrateArgs(argv = [], env = process.env) {
  const dryRun = argv.includes('--dry-run')
  const relaxTargetRls = argv.includes('--relax-target-rls')
  const authUsersFile = argValue(argv, '--auth-users-file') || env.AUTH_USERS_FILE || ''
  const skipAuthUsers = argv.includes('--skip-auth-users') || Boolean(authUsersFile)
  return { dryRun, relaxTargetRls, skipAuthUsers, authUsersFile }
}

export function resolveSourceUrl(env = process.env) {
  return env.SUPABASE_READONLY_URL || env.SUPABASE_DB_URL || env.SOURCE_DATABASE_URL || ''
}

export function resolveTargetUrl(env = process.env) {
  return env.NEON_DIRECT_URL || env.NEON_DB_URL || env.TARGET_DATABASE_URL || ''
}

export function isExecutedDirectly(metaUrl, argv1) {
  if (!argv1) return false
  try {
    return metaUrl === pathToFileURL(resolve(argv1)).href
  } catch {
    return false
  }
}

function csvEscape(value) {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 1
        } else {
          inQ = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQ = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export function normalizeAuthUser(row) {
  const id = String(row.id ?? row.user_id ?? '').trim()
  const email = String(row.email ?? '').trim()
  if (!id || !email) throw new Error('auth user mapping requires id and email')
  const createdAt = row.created_at ?? row.createdAt ?? ''
  const updatedAt = row.updated_at ?? row.updatedAt ?? createdAt
  const name = String(row.name ?? email.split('@')[0] ?? '').trim()
  return {
    id,
    email,
    name,
    created_at: createdAt ? String(createdAt) : '',
    updated_at: updatedAt ? String(updatedAt) : '',
    email_verified: Boolean(row.email_verified ?? row.emailVerified ?? false),
  }
}

export function parseAuthUsersCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (!lines.length) return []
  const first = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const hasHeader = first.includes('id') && first.includes('email')
  const headers = hasHeader ? first : ['id', 'email', 'created_at']
  const start = hasHeader ? 1 : 0
  const rows = []
  for (let i = start; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const rec = {}
    headers.forEach((h, idx) => {
      rec[h] = cols[idx]
    })
    if (!hasHeader) {
      rec.id = cols[0]
      rec.email = cols[1]
      rec.created_at = cols[2]
    }
    rows.push(normalizeAuthUser(rec))
  }
  return rows
}

export function parseAuthUsersMapping(content, filename = 'auth-users') {
  const trimmed = String(content ?? '').replace(/^\uFEFF/, '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${filename}: invalid JSON (${message})`)
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed.users || parsed.rows || [parsed]
    if (!Array.isArray(list)) throw new Error(`${filename}: JSON must be an array of {id, email, created_at}`)
    return list.map((row) => normalizeAuthUser(row))
  }
  return parseAuthUsersCsv(trimmed)
}

export function authUsersToCopyCsv(rows) {
  return rows.map((r) => {
    const created = r.created_at || ''
    const updated = r.updated_at || created
    return [
      r.id,
      csvEscape(r.name),
      csvEscape(r.email),
      r.email_verified ? 't' : 'f',
      created,
      updated,
    ].join(',')
  }).join('\n') + (rows.length ? '\n' : '')
}

export const REQUIRED_COUNT_TABLES = [
  'athlete', 'insight', 'mcp_token', 'phase', 'program', 'routine', 'workout',
]

export function checksumQuery() {
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

export function orphanAthleteQuery() {
  return `
    SELECT a.auth_user_id::text
    FROM public.athlete a
    LEFT JOIN "user" u ON u.id = a.auth_user_id::text
    WHERE u.id IS NULL
    ORDER BY 1;
  `
}

/** Default aligned psql, `psql -At`, and `psql --csv`. */
export function parseCounts(text) {
  const out = {}
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('(') || line.startsWith('-') || line.startsWith('+')) continue
    if (/^t\s*[,|]\s*n$/i.test(line)) continue
    const m = line.match(/^(\w+)\s*[,|]\s*(\d+)\s*$/)
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

export function requireCounts(counts, label) {
  const missing = REQUIRED_COUNT_TABLES.filter((t) => !Number.isFinite(counts?.[t]))
  if (missing.length) {
    throw new Error(`${label}: missing row counts for ${missing.join(', ')} (refusing to continue)`)
  }
  return counts
}

export function parseOrphanIds(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
}

export function formatCountComparison(srcCounts, dstCounts) {
  const tables = REQUIRED_COUNT_TABLES
  const lines = []
  let mismatch = false
  for (const table of tables) {
    const a = srcCounts?.[table]
    const b = dstCounts == null ? undefined : dstCounts[table]
    const aDisp = Number.isFinite(a) ? a : 'n/a'
    const bDisp = Number.isFinite(b) ? b : 'n/a'
    const mark = a === b && Number.isFinite(a) ? 'ok' : 'MISMATCH'
    if (mark !== 'ok') mismatch = true
    lines.push(`  ${table}: source=${aDisp} neon=${bDisp} ${mark}`)
  }
  return { lines, mismatch }
}

export const PUBLIC_RESTORE_ORDER = [
  'athlete',
  'diagnostic',
  'insight',
  'insight_draft',
  'athlete_profile',
  'program',
  'phase',
  'routine',
  'workout',
  'session_observation',
  'weekly_review',
  'coach_message',
  'probe_throttle',
  'workout_draft',
  'program_revision',
  'mcp_token',
]

const SKIP_RESTORE_TABLES = new Set(['user', 'session', 'account', 'verification'])

export function orderRestoreList(tocText) {
  const comments = []
  const tableData = []
  const rest = []
  for (const line of String(tocText ?? '').split('\n')) {
    if (!line.trim() || line.startsWith(';')) {
      comments.push(line)
      continue
    }
    const m = line.match(/\sTABLE DATA\s+public\s+("([^"]+)"|(\S+))\s/)
    if (m) {
      const table = m[2] || m[3]
      if (SKIP_RESTORE_TABLES.has(table)) continue
      tableData.push({ line, table })
      continue
    }
    rest.push(line)
  }
  tableData.sort((a, b) => {
    const ia = PUBLIC_RESTORE_ORDER.indexOf(a.table)
    const ib = PUBLIC_RESTORE_ORDER.indexOf(b.table)
    const ra = ia === -1 ? PUBLIC_RESTORE_ORDER.length + 1 : ia
    const rb = ib === -1 ? PUBLIC_RESTORE_ORDER.length + 1 : ib
    return ra - rb || a.table.localeCompare(b.table)
  })
  return [...comments, ...tableData.map((x) => x.line), ...rest].join('\n').replace(/\n*$/, '\n')
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim()
    const safeArgs = args.map((a) => (/postgres(?:ql)?:\/\//i.test(a) ? '[redacted-url]' : a))
    throw new Error(`${cmd} ${safeArgs.join(' ')} failed (${res.status}): ${redactSecrets(err)}`)
  }
  return res.stdout
}

function needBin(name) {
  const res = spawnSync(name, ['--version'], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`Missing ${name}. Install PostgreSQL client tools.`)
}

function psqlTuples(url, sql) {
  return run('psql', ['-v', 'ON_ERROR_STOP=1', '-At', '-F', ',', '-d', url, '-c', sql])
}

function readCounts(url, label, { required = true } = {}) {
  try {
    const counts = parseCounts(psqlTuples(url, checksumQuery()))
    if (required) return requireCounts(counts, label)
    if (REQUIRED_COUNT_TABLES.some((t) => !Number.isFinite(counts[t]))) {
      console.log(`${label}: incomplete row counts`)
      return counts
    }
    return counts
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!required && /does not exist|undefined_table/i.test(message)) {
      console.log(`${label}: tables not present yet`)
      return null
    }
    throw err
  }
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

function printOfflineDryRun(args) {
  console.log('dry-run: would apply worker/schema/app.sql then data-only restore of public.*')
  console.log('dry-run: would create Better Auth tables from worker/schema/better-auth.sql')
  if (args.skipAuthUsers) {
    console.log('dry-run: --skip-auth-users — will not read auth.users on the source')
    if (args.authUsersFile) {
      if (!existsSync(args.authUsersFile)) {
        throw new Error(`--auth-users-file not found: ${args.authUsersFile}`)
      }
      const rows = parseAuthUsersMapping(readFileSync(args.authUsersFile, 'utf8'), args.authUsersFile)
      console.log(`dry-run: would map ${rows.length} provided auth users → Better Auth "user" (same UUIDs)`)
    } else {
      console.log('dry-run: no --auth-users-file — Better Auth mapping would be skipped')
    }
  } else {
    console.log('dry-run: would COPY auth.users from source (pass --skip-auth-users if the role cannot read it)')
  }
  console.log(args.relaxTargetRls
    ? 'dry-run: --relax-target-rls is on — would DISABLE RLS and drop policy/function/FK on Neon only'
    : 'dry-run: would leave any leftover RLS artifacts on Neon (pass --relax-target-rls to drop them on the target)')
  console.log('dry-run: would compare row counts per table and abort on mismatch')
  console.log('dry-run: live restore without --auth-users-file exits 2')
  console.log('tools required: pg_dump, pg_restore, psql')
}

function loadProvidedAuthUsers(args) {
  if (!args.authUsersFile) {
    throw new Error('--skip-auth-users requires --auth-users-file (CSV or JSON of id, email, created_at)')
  }
  if (!existsSync(args.authUsersFile)) {
    throw new Error(`--auth-users-file not found: ${args.authUsersFile}`)
  }
  return parseAuthUsersMapping(readFileSync(args.authUsersFile, 'utf8'), args.authUsersFile)
}

function loadUsersSql(usersPath) {
  return `
    CREATE TEMP TABLE auth_users_import (
      id TEXT, name TEXT, email TEXT, email_verified BOOLEAN,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    );
    \\copy auth_users_import FROM '${usersPath}' WITH CSV
    INSERT INTO auth.users (id, email, created_at, updated_at)
    SELECT id::uuid, email, COALESCE(created_at, NOW()), COALESCE(updated_at, created_at, NOW())
    FROM auth_users_import
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    SELECT id, name, email, email_verified, COALESCE(created_at, NOW()), COALESCE(updated_at, created_at, NOW())
    FROM auth_users_import
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      email_verified = EXCLUDED.email_verified;
  `
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseMigrateArgs(argv, env)
  const source = resolveSourceUrl(env)
  const target = resolveTargetUrl(env)

  if (args.dryRun && !source && !target) {
    printOfflineDryRun(args)
    return 0
  }

  if (!source || !target) {
    console.error('Set SUPABASE_READONLY_URL and NEON_DIRECT_URL (or pass --dry-run).')
    return 2
  }

  if (source === target) {
    console.error('Source and target URLs must be different. Source is read-only.')
    return 2
  }

  maskDatabaseUrls(source, target)

  if (args.skipAuthUsers && !args.dryRun && !args.authUsersFile) {
    console.error('Live restore without --auth-users-file exits 2. Pass a CSV/JSON mapping; the migration role cannot read auth.users.')
    return 2
  }

  needBin('pg_dump')
  needBin('pg_restore')
  needBin('psql')

  const dir = mkdtempSync(join(tmpdir(), 'zeroed-migrate-'))
  const dumpPath = join(dir, 'public.dump')
  const usersPath = join(dir, 'auth_users.csv')
  const relaxPath = join(dir, 'relax_target.sql')

  try {
    writeFileSync(relaxPath, RELAX_TARGET_SQL)

    console.log('dumping public data only (no-owner, no-acl, no schema/RLS)…')
    run('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--data-only',
      '--schema=public',
      `--file=${dumpPath}`,
      source,
    ])

    let mappedUsers = 0
    if (args.skipAuthUsers) {
      console.log('skipping auth.users export (--skip-auth-users)')
      if (args.authUsersFile) {
        const rows = loadProvidedAuthUsers(args)
        mappedUsers = rows.length
        writeFileSync(usersPath, authUsersToCopyCsv(rows))
        console.log(`loaded ${mappedUsers} auth users from provided mapping`)
      } else {
        writeFileSync(usersPath, '')
        console.log('no --auth-users-file — Better Auth mapping skipped')
      }
    } else {
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
      mappedUsers = csv.trim().split('\n').filter(Boolean).length
      console.log(`exported ${mappedUsers} auth.users rows`)
    }

    const srcCounts = readCounts(source, 'source', { required: true })
    const dstCounts = readCounts(target, 'neon', { required: false })
    const before = formatCountComparison(srcCounts, dstCounts)
    console.log('row counts before restore:')
    for (const line of before.lines) console.log(line)

    if (args.skipAuthUsers && args.authUsersFile) {
      const needed = Number(psqlTuples(source, 'SELECT COUNT(DISTINCT auth_user_id)::text FROM public.athlete').trim())
      if (!Number.isFinite(needed)) throw new Error('source: could not count distinct athlete.auth_user_id')
      if (mappedUsers < needed) {
        console.error(`Partial --auth-users-file: mapped ${mappedUsers} users, source has ${needed} distinct athlete.auth_user_id values`)
        return 1
      }
    }

    if (args.dryRun) {
      console.log(`dry-run: dump at ${dumpPath} (${readFileSync(dumpPath).length} bytes)`)
      console.log(`dry-run: ${mappedUsers} auth users to map`)
      console.log(args.relaxTargetRls
        ? 'dry-run: would apply worker/schema/app.sql + data-only restore + --relax-target-rls on Neon only'
        : 'dry-run: would apply worker/schema/app.sql + data-only restore (no Neon writes in this dry-run)')
      return 0
    }

    console.log('applying worker/schema/app.sql + better-auth.sql on Neon…')
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(root, 'worker/schema/app.sql')])
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(root, 'worker/schema/better-auth.sql')])

    if (mappedUsers > 0) {
      console.log('mapping auth users → "user" + stub auth.users…')
      writeFileSync(join(dir, 'load_users.sql'), loadUsersSql(usersPath))
      run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(dir, 'load_users.sql')])
    }

    console.log('restoring public data into Neon (FK-safe order, triggers stay on)…')
    const tocPath = join(dir, 'restore.list')
    writeFileSync(tocPath, orderRestoreList(run('pg_restore', ['-l', dumpPath])))
    run('pg_restore', [
      '--exit-on-error',
      '--data-only',
      '--no-owner',
      '--no-acl',
      '-L',
      tocPath,
      '--dbname',
      target,
      dumpPath,
    ])

    if (args.relaxTargetRls) {
      console.log('relaxing leftover RLS / auth helpers on Neon (--relax-target-rls)…')
      run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', relaxPath])
    }

    const afterSrc = readCounts(source, 'source', { required: true })
    const afterDst = readCounts(target, 'neon', { required: true })
    const after = formatCountComparison(afterSrc, afterDst)
    console.log('row counts after restore:')
    for (const line of after.lines) console.log(line)
    if (after.mismatch) {
      console.error('Row-count mismatch — abort. Neon was written but is not trusted.')
      return 1
    }

    const orphans = parseOrphanIds(psqlTuples(target, orphanAthleteQuery()))
    if (orphans.length) {
      console.error(`Orphan athletes (auth_user_id with no Better Auth "user"): ${orphans.length}`)
      console.error('Partial --auth-users-file left athletes unmapped — abort.')
      return 1
    }

    console.log('migration ok')
    return 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (isExecutedDirectly(import.meta.url, process.argv[1])) {
  try {
    process.exit(main())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(redactSecrets(message))
    process.exit(1)
  }
}
