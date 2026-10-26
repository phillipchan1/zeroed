/**
 * Apply supabase/migrations onto PGlite, then the isolation seed.
 * Test-only (excluded from the Worker tsconfig).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PGlite } from '@electric-sql/pglite'

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

export async function applyIsolationSchema(db: PGlite): Promise<void> {
  await db.exec(BOOTSTRAP)
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  if (!files.length) throw new Error(`no migrations in ${migrationsDir}`)
  for (const file of files) {
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
