import postgres from 'postgres'
import { isLoopbackHostname } from './authUrl.ts'
import type { Env } from './env.ts'
import { databaseUrl } from './env.ts'

export type Sql = postgres.Sql

export type WaitUntilCtx = {
  waitUntil(promise: Promise<unknown>): void
}

/**
 * TLS from the connection URL only — hostname + sslmode, never a substring of
 * the user, db name, or query values.
 */
export function sslForConnection(url: string): false | 'require' {
  try {
    const parsed = new URL(url)
    const mode = (parsed.searchParams.get('sslmode') ?? '').trim().toLowerCase()
    if (mode === 'disable') return false
    if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full') return 'require'
    if (isLoopbackHostname(parsed.hostname) && (mode === '' || mode === 'allow' || mode === 'prefer')) {
      return false
    }
    return 'require'
  } catch {
    return 'require'
  }
}

/** New client every call. Workers cannot reuse I/O across requests. */
export function openSql(env: Env): Sql {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  return postgres(url, {
    max: 1,
    fetch_types: false,
    prepare: false,
    ssl: sslForConnection(url),
  })
}

/**
 * Open a client for this request, run `fn`, then close. On Workers, close is
 * handed to `ctx.waitUntil` so it does not burn isolate CPU on the response
 * path. Tests without a ctx await the close.
 */
export async function withSql<T>(
  env: Env,
  fn: (sql: Sql) => Promise<T>,
  ctx?: WaitUntilCtx,
): Promise<T> {
  const sql = openSql(env)
  try {
    return await fn(sql)
  } finally {
    const closing = Promise.resolve(sql.end({ timeout: 5 })).catch((err) => {
      console.error('[db] close', err)
    })
    if (ctx?.waitUntil) ctx.waitUntil(closing)
    else await closing
  }
}

export function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : value == null ? null : String(value)
}

/** postgres.js JSONValue is invariant; clone through JSON so we can bind objects. */
export function jsonParam(sql: Sql, value: unknown): ReturnType<Sql['json']> {
  return sql.json(JSON.parse(JSON.stringify(value)) as Parameters<Sql['json']>[0])
}

/**
 * Postgres array literal for `fetch_types:false`. `sql.array()` does not
 * serialize to `{…}` unless type OIDs were fetched, so a JS array becomes
 * `String(ids)` (a bare uuid) and `ANY($1::uuid[])` raises 22P02.
 */
export function pgArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
