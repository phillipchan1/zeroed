// Load mcp/.env and the app's .env.local without adding a dotenv dependency.
// Existing process.env wins so Claude Desktop / Cursor `env` blocks stay authoritative.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function loadFile(path: string): void {
  if (!existsSync(path)) return
  const parsed = parseDotEnv(readFileSync(path, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value
    }
  }
}

export function loadEnvFiles(): void {
  loadFile(resolve(here, '../.env'))
  loadFile(resolve(here, '../../.env.local'))
}

function first(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return undefined
}

/**
 * Bridge mode: since the Oct 27 cutover, production is the Cloudflare Worker on
 * Neon, and Supabase is the frozen rollback copy. With ZEROED_MCP_URL set, this
 * server forwards every tool to that Worker's MCP endpoint instead of reading
 * Supabase. Null when unset (Supabase mode). Throws when the URL is set but the
 * token isn't, rather than quietly serving the stale copy.
 */
export function readRemoteEnv(): { url: string; token: string } | null {
  const url = first('ZEROED_MCP_URL')
  if (!url) return null
  const token = first('ZEROED_MCP_TOKEN')
  if (!token) {
    throw new Error(
      'ZEROED_MCP_URL is set but ZEROED_MCP_TOKEN is empty. In the app: Profile → Claude connector → Create token, then paste it into mcp/.env as ZEROED_MCP_TOKEN.',
    )
  }
  return { url, token }
}

export interface ZeroedEnv {
  url: string
  anonKey?: string
  serviceRoleKey?: string
  email?: string
  password?: string
  athleteId?: string
  athleteEmail?: string
  unit: string
}

export function readEnv(): ZeroedEnv {
  loadEnvFiles()
  const url = first('ZEROED_SUPABASE_URL', 'SUPABASE_URL', 'VITE_SUPABASE_URL')
  if (!url) {
    throw new Error(
      'Missing ZEROED_SUPABASE_URL (or VITE_SUPABASE_URL). Add it to mcp/.env or the MCP server env block.',
    )
  }
  const unit = (first('ZEROED_WEIGHT_UNIT', 'WEIGHT_UNIT') ?? 'lb').toLowerCase()
  return {
    url: url.replace(/\/+$/, ''),
    anonKey: first('ZEROED_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'),
    serviceRoleKey: first('ZEROED_SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    email: first('ZEROED_EMAIL'),
    password: first('ZEROED_PASSWORD'),
    athleteId: first('ZEROED_ATHLETE_ID'),
    athleteEmail: first('ZEROED_ATHLETE_EMAIL', 'ZEROED_EMAIL'),
    unit: unit === 'kg' ? 'kg' : 'lb',
  }
}

export function describeAuth(env: ZeroedEnv): string {
  if (env.serviceRoleKey) {
    return env.athleteId
      ? `service-role → athlete ${env.athleteId}`
      : env.athleteEmail
        ? `service-role → ${env.athleteEmail}`
        : 'service-role (athlete unresolved until first call)'
  }
  if (env.anonKey && env.email) return `athlete login as ${env.email}`
  return 'not configured'
}
