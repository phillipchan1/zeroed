import postgres from 'postgres'
import type { Env } from './env.ts'
import { databaseUrl } from './env.ts'

export type Sql = postgres.Sql

const cache = new WeakMap<object, Sql>()

export function getSql(env: Env): Sql {
  const cached = cache.get(env)
  if (cached) return cached
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  const sql = postgres(url, {
    max: 5,
    fetch_types: false,
    prepare: false,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require',
  })
  cache.set(env, sql)
  return sql
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
