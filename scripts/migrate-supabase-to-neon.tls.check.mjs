#!/usr/bin/env node
/**
 * Prove Node pg source clients verify TLS: matching CA connects, wrong CA fails.
 * Never prints URLs, secrets, or query results.
 *
 * Run: ZEROED_REQUIRE_TLS=1 node --experimental-strip-types scripts/migrate-supabase-to-neon.tls.check.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import {
  assertSourcePgSsl,
  redactSecrets,
  sourcePgClientConfig,
  stripSslMode,
} from './migrate-supabase-to-neon.mjs'

const fails = []
let checks = 0
function ok(cond, msg) {
  checks += 1
  if (!cond) fails.push(msg)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (res.status !== 0) {
    throw new Error(redactSecrets((res.stderr || res.stdout || `${cmd} ${res.status}`).trim()))
  }
  return res.stdout
}

function openssl(...args) {
  return run('openssl', args)
}

const required = process.env.ZEROED_REQUIRE_TLS === '1'
const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' })
if (docker.status !== 0) {
  if (required) {
    console.error('migrate-tls requires docker')
    process.exit(1)
  }
  console.log('migrate-tls skipped (no docker)')
  process.exit(0)
}

const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'zeroed-tls-'))
const name = `zeroed-pg-tls-${process.pid}`
const port = String(process.env.ZEROED_TLS_PG_PORT || '55432')
try {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'),
    '-days', '1', '-subj', '/CN=zeroed-test-ca')
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'wrong.key'), '-out', join(dir, 'wrong.crt'),
    '-days', '1', '-subj', '/CN=zeroed-wrong-ca')
  openssl('req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.csr'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1')
  openssl('x509', '-req', '-in', join(dir, 'server.csr'),
    '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial',
    '-out', join(dir, 'server.crt'), '-days', '1', '-sha256',
    '-copy_extensions', 'copy')

  const started = spawnSync('docker', [
    'run', '-d', '--name', name,
    '-e', 'POSTGRES_USER=src',
    '-e', 'POSTGRES_PASSWORD=dummy',
    '-e', 'POSTGRES_DB=srcdb',
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:17',
  ], { encoding: 'utf8' })
  if (started.status !== 0) {
    throw new Error(redactSecrets((started.stderr || started.stdout || 'docker run failed').trim()))
  }

  function waitSql(sql, expect) {
    const deadline = Date.now() + 60000
    let consecutive = 0
    while (Date.now() < deadline) {
      // TCP, not the unix socket: the official image accepts socket
      // connections during init, then shuts down before the main server.
      const probe = spawnSync('docker', [
        'exec', '-e', 'PGPASSWORD=dummy', name,
        'psql', '-h', '127.0.0.1', '-p', '5432', '-U', 'src', '-d', 'srcdb',
        '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql,
      ], { encoding: 'utf8' })
      const out = String(probe.stdout || '').trim()
      if (probe.status === 0 && (expect == null || out === expect)) {
        consecutive += 1
        if (consecutive >= 3) return true
      } else {
        consecutive = 0
      }
      spawnSync('sleep', ['1'])
    }
    return false
  }

  function retryExec(args, attempts = 8) {
    let last = ''
    for (let i = 0; i < attempts; i++) {
      const res = spawnSync('docker', args, { encoding: 'utf8' })
      if (res.status === 0) return res.stdout
      last = redactSecrets((res.stderr || res.stdout || `docker ${res.status}`).trim())
      spawnSync('sleep', ['1'])
    }
    throw new Error(last || 'docker exec failed')
  }

  ok(waitSql('SELECT 1', '1'), 'postgres became ready')

  run('docker', ['cp', join(dir, 'server.crt'), `${name}:/var/lib/postgresql/data/server.crt`])
  run('docker', ['cp', join(dir, 'server.key'), `${name}:/var/lib/postgresql/data/server.key`])
  run('docker', ['exec', '-u', 'root', name, 'chown', 'postgres:postgres',
    '/var/lib/postgresql/data/server.crt', '/var/lib/postgresql/data/server.key'])
  run('docker', ['exec', '-u', 'root', name, 'chmod', '644', '/var/lib/postgresql/data/server.crt'])
  run('docker', ['exec', '-u', 'root', name, 'chmod', '600', '/var/lib/postgresql/data/server.key'])
  for (const sql of [
    'ALTER SYSTEM SET ssl = on',
    "ALTER SYSTEM SET ssl_cert_file = 'server.crt'",
    "ALTER SYSTEM SET ssl_key_file = 'server.key'",
  ]) {
    retryExec(['exec', name, 'psql', '-U', 'src', '-d', 'srcdb', '-v', 'ON_ERROR_STOP=1', '-c', sql])
  }
  retryExec(['exec', name, 'psql', '-U', 'src', '-d', 'srcdb', '-tA', '-v', 'ON_ERROR_STOP=1', '-c',
    'SELECT pg_reload_conf()'])
  if (!waitSql('SHOW ssl', 'on')) {
    run('docker', ['restart', name])
    ok(waitSql('SELECT 1', '1'), 'TLS postgres became ready after restart')
  }
  ok(waitSql('SHOW ssl', 'on'), 'postgres ssl is on')

  const url = `postgresql://src:dummy@127.0.0.1:${port}/srcdb?sslmode=require`
  ok(!stripSslMode(url).includes('sslmode='), 'stripSslMode removes sslmode before node-pg')

  const goodEnv = { ZEROED_SOURCE_CA_FILE: join(dir, 'ca.crt') }
  const goodCfg = sourcePgClientConfig(url, goodEnv)
  goodCfg.ssl.servername = 'localhost'
  assertSourcePgSsl(goodCfg)
  ok(goodCfg.ssl.rejectUnauthorized === true, 'matching-CA client sets rejectUnauthorized: true')
  ok(String(goodCfg.ssl.ca).includes('BEGIN CERTIFICATE'), 'matching-CA client has a CA')

  const good = new pg.Client(goodCfg)
  try {
    await good.connect()
    await good.query('SELECT 1')
    ok(true, 'matching CA verifies and connects')
  } catch (err) {
    ok(false, `matching CA should connect (${redactSecrets(err instanceof Error ? err.message : String(err))})`)
  } finally {
    try { await good.end() } catch { /* ignore */ }
  }

  const badEnv = { ZEROED_SOURCE_CA_FILE: join(dir, 'wrong.crt') }
  let badCfg
  try {
    badCfg = sourcePgClientConfig(url, badEnv)
    badCfg.ssl.servername = 'localhost'
    assertSourcePgSsl(badCfg)
  } catch (err) {
    ok(false, `wrong-CA config should still build (${redactSecrets(err instanceof Error ? err.message : String(err))})`)
  }
  const bad = new pg.Client(badCfg)
  let failed = false
  try {
    await bad.connect()
    ok(false, 'wrong CA must not connect')
  } catch (err) {
    failed = true
    const message = redactSecrets(err instanceof Error ? err.message : String(err))
    ok(/certificate|self-signed|unable to verify|UNABLE_TO_VERIFY/i.test(message), 'wrong CA fails TLS verification')
    ok(!/postgresql:\/\//i.test(message), 'wrong-CA error does not print a URL')
  } finally {
    try { await bad.end() } catch { /* ignore */ }
  }
  ok(failed, 'wrong CA is rejected')

  let missingCaFailed = false
  try {
    assertSourcePgSsl({
      connectionString: stripSslMode(url),
      ssl: { rejectUnauthorized: true },
    })
  } catch {
    missingCaFailed = true
  }
  ok(missingCaFailed, 'source pg client built without a CA is refused')
} finally {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
}

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} migrate-tls checks failed:`)
  for (const f of fails) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✓ all ${checks} migrate-tls checks passed`)
