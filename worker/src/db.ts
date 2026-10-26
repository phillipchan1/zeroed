import { Client } from 'pg'
import { isLoopbackHostname } from './authUrl.ts'
import type { Env } from './env.ts'
import { databaseUrl, useDatabaseSsl } from './env.ts'

export type WaitUntil = (task: Promise<unknown>) => void

export type WaitUntilCtx = {
  waitUntil(promise: Promise<unknown>): void
}

export type WaitUntilArg = WaitUntil | WaitUntilCtx

export function asWaitUntil(arg?: WaitUntilArg): WaitUntil | undefined {
  if (!arg) return undefined
  if (typeof arg === 'function') return arg
  return (task) => arg.waitUntil(task)
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

const JSON_PARAM = Symbol('pg-json')
const ARRAY_PARAM = Symbol('pg-array')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface JsonParam {
  readonly [JSON_PARAM]: true
  readonly value: unknown
}

export interface ArrayParam {
  readonly [ARRAY_PARAM]: true
  readonly value: unknown[]
  readonly type: 'uuid' | 'text'
}

export interface Sql {
  <T extends readonly object[] = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>
  json(value: unknown): JsonParam
  array(value: unknown[], type?: 'uuid' | 'text'): ArrayParam
  unsafe<T extends object = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
}

function isJsonParam(value: unknown): value is JsonParam {
  return typeof value === 'object' && value !== null && JSON_PARAM in value
}

function isArrayParam(value: unknown): value is ArrayParam {
  return typeof value === 'object' && value !== null && ARRAY_PARAM in value
}

function arrayType(value: unknown[]): 'uuid' | 'text' {
  return value.length > 0 && value.every((item) => typeof item === 'string' && UUID_RE.test(item))
    ? 'uuid'
    : 'text'
}

/** Explicit `sql.array` / `::uuid[]` so JS arrays bind as Postgres arrays. */
export function taggedArray(value: unknown[], type?: 'uuid' | 'text'): ArrayParam {
  return { [ARRAY_PARAM]: true, value, type: type ?? arrayType(value) }
}

export function compileTagged(
  strings: TemplateStringsArray,
  values: unknown[],
): { text: string; params: unknown[] } {
  let text = ''
  const params: unknown[] = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i >= values.length) continue
    const value = values[i]
    if (isJsonParam(value)) {
      params.push(JSON.stringify(value.value))
      text += `$${params.length}::jsonb`
      continue
    }
    if (isArrayParam(value)) {
      params.push(value.value)
      text += `$${params.length}::${value.type}[]`
      continue
    }
    params.push(value)
    if (Array.isArray(value)) {
      text += `$${params.length}::${arrayType(value)}[]`
    } else {
      text += `$${params.length}`
    }
  }
  return { text, params }
}

export function makeClientSql(
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
): Sql {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const compiled = compileTagged(strings, values)
    const result = await query(compiled.text, compiled.params)
    return result.rows
  }) as Sql
  sql.json = (value: unknown): JsonParam => ({ [JSON_PARAM]: true, value })
  sql.array = taggedArray
  sql.unsafe = async <T extends object>(text: string, params: unknown[] = []) => {
    const result = await query(text, params)
    return result.rows as T[]
  }
  return sql
}

function createClient(env: Env): Client {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  return new Client({
    connectionString: url,
    ssl: useDatabaseSsl(url, env) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5_000,
    keepAlive: false,
  })
}

function closeClient(client: Client, waitUntil?: WaitUntil): Promise<void> | void {
  const ending = client.end().catch(() => undefined)
  if (waitUntil) {
    waitUntil(ending)
    return
  }
  return ending
}

/**
 * One TCP client per request. workerd cannot reuse sockets across requests.
 * Close through `waitUntil` so the response is not blocked on `client.end()`.
 */
export async function withSql<T>(
  env: Env,
  fn: (sql: Sql) => Promise<T>,
  waitUntil?: WaitUntilArg,
): Promise<T> {
  const client = createClient(env)
  await client.connect()
  try {
    return await fn(makeClientSql((text, params) => client.query(text, params ?? [])))
  } finally {
    await closeClient(client, asWaitUntil(waitUntil))
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

/** Bind a JSON value as jsonb. */
export function jsonParam(sql: Sql, value: unknown): JsonParam {
  return sql.json(JSON.parse(JSON.stringify(value)))
}

/**
 * Postgres array literal for `fetch_types:false`. `sql.array()` does not
 * serialize to `{…}` unless type OIDs were fetched, so a JS array becomes
 * `String(ids)` (a bare uuid) and `ANY($1::uuid[])` raises 22P02.
 */
export function pgArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
