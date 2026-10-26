/**
 * Apply supabase/migrations + isolation seed onto PGlite or throwaway Postgres.
 * Test-only (excluded from the Worker tsconfig).
 *
 * Real-PG wipes use ZEROED_TEST_DATABASE_URL only — never DATABASE_URL.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { Client } from 'pg'
import { isLoopbackHostname } from './authUrl.ts'
import { makeClientSql, type Sql } from './db.ts'
import { makePgliteSql } from './pgliteSql.ts'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '../../supabase/migrations')
const seedPath = join(here, '../schema/isolation-seed.sql')

const BOOTSTRAP = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY,
  email TEXT,
  raw_user_meta_data JSONB,
  email_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$roles$;
`

const RESET_PG = `
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO public;
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
`

export type IsolationBackend = 'postgres' | 'pglite'

export type IsolationHarness = {
  sql: Sql
  backend: IsolationBackend
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  exec(text: string): Promise<void>
  close(): Promise<void>
}

export function testDatabaseUrl(): string | undefined {
  const url = process.env.ZEROED_TEST_DATABASE_URL?.trim()
  return url || undefined
}

export function assertCiUsesRealPostgres(): void {
  if (!process.env.CI) return
  if (testDatabaseUrl()) return
  throw new Error(
    'CI must set ZEROED_TEST_DATABASE_URL to a throwaway Postgres service (never DATABASE_URL)',
  )
}

function refuseUnsafeTestUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('ZEROED_TEST_DATABASE_URL is not a valid URL')
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `ZEROED_TEST_DATABASE_URL host "${parsed.hostname}" is not loopback — refusing to wipe`,
    )
  }
}

function migrationFiles(): string[] {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  if (!files.length) throw new Error(`no migrations in ${migrationsDir}`)
  return files
}

export async function applyIsolationSchema(db: PGlite): Promise<void> {
  await db.exec(BOOTSTRAP)
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    try {
      await db.exec(sql)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${file}: ${message}`)
    }
  }
  await db.exec(readFileSync(seedPath, 'utf8'))
}

export async function applyIsolationSchemaPg(client: Client): Promise<void> {
  await client.query(RESET_PG)
  await client.query(BOOTSTRAP)
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    try {
      await client.query(sql)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${file}: ${message}`)
    }
  }
  await client.query(readFileSync(seedPath, 'utf8'))
}

export async function openIsolationHarness(): Promise<IsolationHarness> {
  assertCiUsesRealPostgres()
  const url = testDatabaseUrl()
  if (!url) {
    const db = new PGlite()
    await applyIsolationSchema(db)
    const sql = makePgliteSql(db)
    return {
      sql,
      backend: 'pglite',
      async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
        const result = await db.query(text, params)
        return result.rows as T[]
      },
      async exec(text) {
        await db.exec(text)
      },
      async close() {
        await db.close()
      },
    }
  }

  refuseUnsafeTestUrl(url)
  const client = new Client({ connectionString: url, ssl: false })
  await client.connect()
  await applyIsolationSchemaPg(client)
  const sql = makeClientSql((text, params) => client.query(text, params ?? []))
  return {
    sql,
    backend: 'postgres',
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params)
      return result.rows as T[]
    },
    async exec(text) {
      await client.query(text)
    },
    async close() {
      await client.end()
    },
  }
}

export async function openIsolationSql(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const url = process.env.ZEROED_REAL_PG === '1' ? process.env.DATABASE_URL?.trim() : ''
  if (!url) {
    const db = new PGlite()
    await applyIsolationSchema(db)
    return {
      sql: makePgliteSql(db),
      close: async () => {
        await db.close()
      },
    }
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  await applyIsolationSchemaPg(client)
  return {
    sql: makeClientSql((text, params) => client.query(text, params ?? [])),
    close: () => client.end(),
  }
}
