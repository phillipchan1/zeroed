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
 *   1. Live run: DROP SCHEMA public/auth and recreate, then apply
 *      worker/schema/app.sql + better-auth.sql (reruns start empty)
 *   2. Before any Neon write, every distinct source athlete.auth_user_id
 *      must appear in the mapping (id match, not just counts)
 *   3. Load mappings + data-only restore in one transaction
 *      (failure rolls back to empty tables)
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
 *   node scripts/migrate-supabase-to-neon.mjs --confirm-drop=neondb \
 *     --skip-auth-users --auth-users-file=users.csv
 *
 * Live-run guards (any one refuses before a write):
 *   - source and target normalize to the same host (lowercased) + port + dbname
 *   - target host matches supabase.co / supabase.com / pooler.supabase
 *   - target host does not end in .neon.tech
 *   - --confirm-drop is missing or is not the target dbname
 *   - target has a storage schema, any pg_policies row, or the same
 *     current_database() plus inet_server_addr()/port/start time/system_identifier
 *   - either fingerprint is unreadable (fail closed, no DROP)
 *   - a session advisory lock held on the source is visible in the
 *     target's pg_locks (same server)
 *   - target ?host= / hostaddr= is a socket or does not end in .neon.tech
 *
 * Env aliases: SUPABASE_DB_URL / SOURCE_DATABASE_URL,
 *              NEON_DB_URL / TARGET_DATABASE_URL,
 *              AUTH_USERS_FILE
 *
 * Requires: pg_dump, psql, pg_restore (PostgreSQL client tools).
 */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

export function redactSecrets(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

export function isSocketHost(host) {
  const h = String(host || '')
  return h.startsWith('/') || h.startsWith('@') || h.includes('/')
}

/**
 * Parse a postgres URL the way libpq does: ?host=, hostaddr=, dbname=, and
 * port= override the URI authority / path.
 */
export function postgresUrlParts(url) {
  const parsed = new URL(url)
  const urlHost = decodeURIComponent(parsed.hostname || '').toLowerCase()
  const queryHost = decodeURIComponent(parsed.searchParams.get('host') || '').toLowerCase()
  const hostaddr = decodeURIComponent(parsed.searchParams.get('hostaddr') || '').toLowerCase()
  const queryDb = decodeURIComponent(parsed.searchParams.get('dbname') || '').toLowerCase()
  const queryPort = parsed.searchParams.get('port') || ''
  const host = hostaddr || queryHost || urlHost
  const socket = isSocketHost(host) || isSocketHost(queryHost) || isSocketHost(urlHost)
  let port = queryPort || parsed.port || ''
  if (!port && host && !socket) port = '5432'
  const dbname = queryDb || decodeURIComponent((parsed.pathname || '').replace(/^\//, '').split('/')[0] || '').toLowerCase()
  return {
    user: decodeURIComponent(parsed.username || ''),
    host,
    port,
    dbname,
    urlHost,
    queryHost,
    hostaddr,
    isSocket: socket,
  }
}

export function isSupabaseHost(host) {
  const h = String(host || '').toLowerCase()
  return h === 'supabase.co'
    || h === 'supabase.com'
    || h.endsWith('.supabase.co')
    || h.endsWith('.supabase.com')
    || h.includes('pooler.supabase')
}

export function isNeonHost(host) {
  return String(host || '').toLowerCase().endsWith('.neon.tech')
}

/** URL-only: same host+port+db, or a target that is not Neon / looks like Supabase. */
export function refuseSourceWipeReason(source, target) {
  let src
  let dst
  try {
    src = postgresUrlParts(source)
  } catch {
    return 'source URL is not a valid postgres URL'
  }
  try {
    dst = postgresUrlParts(target)
  } catch {
    return 'target URL is not a valid postgres URL'
  }
  if (dst.isSocket || isSocketHost(dst.host) || isSocketHost(dst.queryHost) || isSocketHost(dst.hostaddr) || isSocketHost(dst.urlHost)) {
    return 'target host is a socket path'
  }
  if (dst.queryHost && !isNeonHost(dst.queryHost)) return 'target host override must end in .neon.tech'
  if (dst.hostaddr && !isNeonHost(dst.hostaddr)) return 'target host override must end in .neon.tech'
  if (isSupabaseHost(dst.host) || isSupabaseHost(dst.urlHost) || isSupabaseHost(dst.queryHost)) {
    return 'target host looks like Supabase'
  }
  if (!isNeonHost(dst.host)) return 'target host must end in .neon.tech'
  if (src.host && dst.host && src.host === dst.host && src.port === dst.port && src.dbname && src.dbname === dst.dbname) {
    return 'source and target resolve to the same host, port, and database'
  }
  return ''
}

/** Its own query — do not fold into fingerprintQuery. */
export function canExecutePgControlSystemQuery() {
  return `SELECT has_function_privilege('pg_control_system()', 'EXECUTE')`
}

export function systemIdentifierQuery() {
  return `SELECT system_identifier::text FROM pg_control_system()`
}

export function fingerprintQuery() {
  return `
    SELECT json_build_object(
      'db', current_database(),
      'addr', COALESCE(host(inet_server_addr()), ''),
      'port', COALESCE(inet_server_port()::text, ''),
      'start', COALESCE(pg_postmaster_start_time()::text, ''),
      'has_storage', to_regnamespace('storage') IS NOT NULL,
      'has_policies', EXISTS (SELECT 1 FROM pg_policies)
    )
  `
}

export function parseFingerprint(text) {
  const raw = String(text ?? '').trim().split('\n').filter(Boolean).pop() || ''
  if (!raw) throw new Error('empty fingerprint')
  const parsed = JSON.parse(raw)
  return {
    db: String(parsed.db ?? ''),
    addr: String(parsed.addr ?? ''),
    port: String(parsed.port ?? ''),
    start: String(parsed.start ?? ''),
    sysid: String(parsed.sysid ?? ''),
    has_storage: Boolean(parsed.has_storage),
    has_policies: Boolean(parsed.has_policies),
  }
}

export function readFingerprint(url) {
  const fp = parseFingerprint(psqlTuples(url, fingerprintQuery()))
  const allowed = String(psqlTuples(url, canExecutePgControlSystemQuery()) || '').trim()
  if (allowed === 't' || allowed === 'true') {
    fp.sysid = String(psqlTuples(url, systemIdentifierQuery()) || '').trim()
  }
  return fp
}

/** Fail closed: unreadable either side, same server/db, or no proof they differ. */
export function refuseTargetFingerprintReason(targetFp, sourceFp) {
  if (!targetFp) return 'could not read target fingerprint'
  if (!sourceFp) return 'could not read source fingerprint'
  if (targetFp.has_storage) return 'target has a storage schema (Supabase)'
  if (targetFp.has_policies) return 'target has pg_policies rows (Supabase RLS)'

  const sameDb = Boolean(targetFp.db && sourceFp.db && targetFp.db === sourceFp.db)
  const sameSysid = Boolean(targetFp.sysid && sourceFp.sysid && targetFp.sysid === sourceFp.sysid)
  const sameAddr = Boolean(
    targetFp.addr
    && sourceFp.addr
    && targetFp.addr === sourceFp.addr
    && (!targetFp.port || !sourceFp.port || targetFp.port === sourceFp.port),
  )
  const sameStart = Boolean(targetFp.start && sourceFp.start && targetFp.start === sourceFp.start)
  if (sameDb && (sameSysid || sameAddr || sameStart)) {
    return 'target server identity matches the source'
  }

  const differentDb = Boolean(targetFp.db && sourceFp.db && targetFp.db !== sourceFp.db)
  const differentSysid = Boolean(targetFp.sysid && sourceFp.sysid && targetFp.sysid !== sourceFp.sysid)
  const differentAddr = Boolean(
    (targetFp.addr && sourceFp.addr && targetFp.addr !== sourceFp.addr)
    || (targetFp.port && sourceFp.port && targetFp.port !== sourceFp.port),
  )
  const differentStart = Boolean(targetFp.start && sourceFp.start && targetFp.start !== sourceFp.start)
  if (differentDb || differentSysid || differentAddr || differentStart) return ''
  return 'could not prove target is a different server from the source'
}

/** Strip inherited libpq env so a URL is the only connection target. */
export function libpqCleanEnv(base = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG')) delete env[key]
  }
  return env
}

export function newAdvisoryLockKey() {
  const buf = randomBytes(8)
  let key = buf.readBigInt64BE()
  if (key === 0n) key = 1n
  return key.toString()
}

export function advisoryLockParts(key) {
  const k = BigInt(key)
  return {
    classid: Number(BigInt.asIntN(32, k >> 32n)),
    objid: Number(BigInt.asIntN(32, k & 0xffffffffn)),
  }
}

export function advisoryLockAcquireSql(key) {
  return `SELECT pg_try_advisory_lock(${String(key)}::bigint)`
}

export function advisoryUnlockSql(key) {
  return `SELECT pg_advisory_unlock(${String(key)}::bigint)`
}

export function advisoryLockVisibleSql(key) {
  const { classid, objid } = advisoryLockParts(key)
  return `
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted
        AND objsubid = 1
        AND classid = ${classid}
        AND objid = ${objid}
    )
  `
}

const heldLockSessions = []
let lockSignalHandlersInstalled = false

export function releaseHeldAdvisoryLocks() {
  while (heldLockSessions.length) {
    const session = heldLockSessions.pop()
    try { session.release() } catch { /* already closed */ }
  }
}

function installLockSignalHandlers() {
  if (lockSignalHandlersInstalled) return
  lockSignalHandlersInstalled = true
  const onSignal = (sig) => {
    releaseHeldAdvisoryLocks()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

export async function holdSourceAdvisoryLock(sourceUrl, key) {
  installLockSignalHandlers()
  const client = new pg.Client({
    connectionString: sourceUrl,
    connectionTimeoutMillis: 10000,
  })
  const session = {
    client,
    key: String(key),
    released: false,
    release() {
      if (this.released) return
      this.released = true
      try {
        const stream = this.client.connection?.stream
        if (stream && typeof stream.destroy === 'function') stream.destroy()
      } catch { /* already closed */ }
      try { this.client.end().catch(() => {}) } catch { /* ignore */ }
    },
  }
  heldLockSessions.push(session)
  try {
    await client.connect()
    const got = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS got', [key])
    if (!got.rows[0]?.got) {
      session.release()
      throw new Error('could not acquire source advisory lock')
    }
    return session
  } catch (err) {
    session.release()
    throw err
  }
}

/**
 * Write-free same-server proof: hold a session advisory lock on the source,
 * then look for that objid in the target's pg_locks. Visible → same server.
 * A target query error fails closed.
 */
export async function checkSourceLockAbsentOnTarget(sourceUrl, targetUrl, key = newAdvisoryLockKey(), opts = {}) {
  let session
  try {
    session = await holdSourceAdvisoryLock(sourceUrl, key)
  } catch {
    return 'could not acquire source advisory lock'
  }
  try {
    const holdMs = Number(opts.holdMs || 0)
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs))
    let visible
    try {
      visible = String(psqlTuples(targetUrl, advisoryLockVisibleSql(key)) || '').trim()
    } catch {
      return 'could not query target pg_locks'
    }
    if (visible === 't' || visible === 'true') return 'source advisory lock is visible on the target'
    return ''
  } finally {
    try { session?.release() } catch { /* ignore */ }
  }
}

/** Live run only: --confirm-drop must equal the parsed target dbname. */
export function confirmDropMismatchReason(confirmDrop, targetUrl) {
  let expected
  try {
    expected = postgresUrlParts(targetUrl).dbname
  } catch {
    return 'target URL is not a valid postgres URL'
  }
  const got = String(confirmDrop ?? '').trim()
  if (!got) return 'live restore requires --confirm-drop=<target dbname>'
  if (!expected) return 'target URL is missing a database name'
  if (got.toLowerCase() !== expected) {
    return `--confirm-drop=${got} does not match target database ${expected}`
  }
  return ''
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
  const confirmDrop = argValue(argv, '--confirm-drop') || env.CONFIRM_DROP || ''
  return { dryRun, relaxTargetRls, skipAuthUsers, authUsersFile, confirmDrop }
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

export function parseIdList(text) {
  return [...new Set(String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean))]
}

export function distinctAuthUserIdQuery() {
  return `SELECT DISTINCT auth_user_id::text FROM public.athlete ORDER BY 1;`
}

export function normalizeAuthUserId(id) {
  return String(id ?? '').trim().toLowerCase()
}

/** Source athlete.auth_user_id values that do not appear in the mapping. */
export function missingMappedAuthUserIds(sourceIds, mappingRows) {
  const mapped = new Set((mappingRows ?? []).map((r) => normalizeAuthUserId(r.id)))
  return parseIdList(Array.isArray(sourceIds) ? sourceIds.join('\n') : sourceIds)
    .map(normalizeAuthUserId)
    .filter((id) => id && !mapped.has(id))
}

export function wrapRestoreTransaction(userSql, restoreSql) {
  return ['BEGIN;', userSql || '', restoreSql || '', 'COMMIT;'].join('\n')
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
  const { env, ...rest } = opts
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env || libpqCleanEnv(),
    ...rest,
  })
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
  console.log('dry-run: would require every source auth_user_id to appear in the mapping (ids, not counts)')
  console.log('dry-run: live restore drops and recreates public/auth, then restores in one transaction')
  console.log('dry-run: live restore without --auth-users-file exits 2')
  console.log('dry-run: live restore requires --confirm-drop=<target dbname> and a .neon.tech target')
  console.log('dry-run: live restore refuses an unreadable fingerprint or a source advisory lock visible on the target')
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

export function loadUsersSql(usersPath) {
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

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseMigrateArgs(argv, env)
  const source = resolveSourceUrl(env)
  const target = resolveTargetUrl(env)
  const readFp = typeof deps.readFingerprint === 'function' ? deps.readFingerprint : readFingerprint
  const checkLock = typeof deps.checkSourceLock === 'function'
    ? deps.checkSourceLock
    : checkSourceLockAbsentOnTarget

  if (args.dryRun && !source && !target) {
    printOfflineDryRun(args)
    return 0
  }

  if (!source || !target) {
    console.error('Set SUPABASE_READONLY_URL and NEON_DIRECT_URL (or pass --dry-run).')
    return 2
  }

  maskDatabaseUrls(source, target)

  const wipeReason = refuseSourceWipeReason(source, target)
  if (wipeReason) {
    console.error(`Refusing to continue: ${wipeReason}. Source is read-only.`)
    return 2
  }

  if (!args.dryRun) {
    const confirmReason = confirmDropMismatchReason(args.confirmDrop, target)
    if (confirmReason) {
      console.error(`${confirmReason}.`)
      return 2
    }
  }

  if (args.skipAuthUsers && !args.dryRun && !args.authUsersFile) {
    console.error('Live restore without --auth-users-file exits 2. Pass a CSV/JSON mapping; the migration role cannot read auth.users.')
    return 2
  }

  if (!args.dryRun) {
    if (typeof deps.readFingerprint !== 'function') needBin('psql')
    console.log('probing target identity before drop…')
    try {
      let targetFp
      let sourceFp
      try {
        targetFp = readFp(target)
      } catch {
        console.error('Refusing to drop target: could not read target fingerprint. Source is read-only.')
        return 2
      }
      try {
        sourceFp = readFp(source)
      } catch {
        console.error('Refusing to drop target: could not read source fingerprint. Source is read-only.')
        return 2
      }
      const fpReason = refuseTargetFingerprintReason(targetFp, sourceFp)
      if (fpReason) {
        console.error(`Refusing to drop target: ${fpReason}. Source is read-only.`)
        return 2
      }
      const holdMs = Number(env.ZEROED_TEST_HOLD_LOCK_MS || 0)
      const lockReason = await checkLock(source, target, newAdvisoryLockKey(), { holdMs })
      if (lockReason) {
        console.error(`Refusing to drop target: ${lockReason}. Source is read-only.`)
        return 2
      }
    } finally {
      releaseHeldAdvisoryLocks()
    }
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
    let mappingRows = []
    if (args.skipAuthUsers) {
      console.log('skipping auth.users export (--skip-auth-users)')
      if (args.authUsersFile) {
        mappingRows = loadProvidedAuthUsers(args)
        mappedUsers = mappingRows.length
        writeFileSync(usersPath, authUsersToCopyCsv(mappingRows))
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
      const sourceIds = parseIdList(psqlTuples(source, distinctAuthUserIdQuery()))
      const missing = missingMappedAuthUserIds(sourceIds, mappingRows)
      if (missing.length) {
        console.error(`--auth-users-file is missing ${missing.length} source auth_user_id(s) (id match, not counts)`)
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

    console.log('resetting Neon public/auth schemas so a rerun starts empty…')
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-c', `
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      CREATE SCHEMA public;
    `])
    console.log('applying worker/schema/app.sql + better-auth.sql on Neon…')
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(root, 'worker/schema/app.sql')])
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(root, 'worker/schema/better-auth.sql')])

    console.log('restoring users + public data in one transaction…')
    const tocPath = join(dir, 'restore.list')
    const restoreSqlPath = join(dir, 'restore.sql')
    writeFileSync(tocPath, orderRestoreList(run('pg_restore', ['-l', dumpPath])))
    run('pg_restore', [
      '--data-only',
      '--no-owner',
      '--no-acl',
      '-L',
      tocPath,
      '-f',
      restoreSqlPath,
      dumpPath,
    ])
    writeFileSync(
      join(dir, 'restore_txn.sql'),
      wrapRestoreTransaction(
        mappedUsers > 0 ? loadUsersSql(usersPath) : '',
        readFileSync(restoreSqlPath, 'utf8'),
      ),
    )
    run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', target, '-f', join(dir, 'restore_txn.sql')])

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
    process.exit(await main())
  } catch (err) {
    releaseHeldAdvisoryLocks()
    const message = err instanceof Error ? err.message : String(err)
    console.error(redactSecrets(message))
    process.exit(1)
  }
}
