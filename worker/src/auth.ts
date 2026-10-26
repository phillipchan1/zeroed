import { betterAuth } from 'better-auth'
import { bearer, emailOTP } from 'better-auth/plugins'
import { Client, type Pool } from 'pg'
import { authCookieSecure, isLocalAuthHost, resolveAuthBaseURL } from './authUrl.ts'
import { NATIVE_APP_ORIGINS } from './cors.ts'
import { sessionFromRequest } from './data.ts'
import { withSql, type WaitUntil } from './db.ts'
import { databaseUrl, pgClientSsl, type Env } from './env.ts'

type AuthInstance = ReturnType<typeof createAuth>

/**
 * Better Auth 1.7 defaults to camelCase columns. The committed schema
 * (`worker/schema/better-auth.sql` and the Neon migrate script) is snake_case.
 */
export const BETTER_AUTH_SNAKE_CASE = {
  user: {
    modelName: 'user',
    fields: {
      name: 'name',
      email: 'email',
      emailVerified: 'email_verified',
      image: 'image',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    modelName: 'session',
    fields: {
      expiresAt: 'expires_at',
      token: 'token',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
  },
  account: {
    modelName: 'account',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      scope: 'scope',
      password: 'password',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  verification: {
    modelName: 'verification',
    fields: {
      identifier: 'identifier',
      value: 'value',
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
} as const

async function sendOtpEmail(env: Env, email: string, otp: string, type: string): Promise<void> {
  const subject = type === 'forget-password'
    ? 'Reset your Zeroed sign-in'
    : 'Your Zeroed sign-in code'
  const text = `Your code is ${otp}. It expires in 5 minutes.\n\nNo password. If you did not request this, ignore the email.`
  if (!env.RESEND_API_KEY) {
    console.log(`[auth] OTP for ${email} (${type}): ${otp}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Zeroed <noreply@localhost>',
      to: email,
      subject,
      text,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`)
  }
}

/**
 * First-time adoption safety net for SELECT lookups only.
 * UPDATE/INSERT `"email" = $n` assignments must stay intact.
 *
 * Better Auth 1.7 qualifies the column as `"user"."email"`. Rewriting only
 * `"email" = $n` produces `"user".lower("email")`, which Postgres reads as
 * schema "user" and fails with `schema "user" does not exist`.
 */
export function rewriteUserEmailLookup(text: string): string {
  if (!/"user"/.test(text)) return text
  if (!/^\s*select\b/i.test(text)) return text
  return text.replace(
    /(?:"user"\.)?"email"\s*=\s*(\$\d+)/g,
    (match, param: string) => {
      const col = match.includes('"user"') ? '"user"."email"' : '"email"'
      return `lower(${col}) = lower(${param})`
    },
  )
}

/** Exact match on the persisted (lowercase) email — the BA user id lives on this row. */
export const FIND_ADOPTED_USER_SQL =
  'SELECT id, email FROM "user" WHERE email = $1 LIMIT 1'

export const FIND_MIXED_CASE_USER_SQL =
  `SELECT id, email FROM "user" WHERE lower(email) = lower($1) AND email <> lower(email) ORDER BY created_at ASC LIMIT 1`

export const PERSIST_ADOPTED_EMAIL_SQL =
  `UPDATE "user" SET email = lower(email), updated_at = NOW() WHERE id = $1 AND email <> lower(email)`

export async function persistAdoptedUserEmail(
  query: (text: string, params: unknown[]) => Promise<{ rows: { id: string }[] }>,
  email: string,
): Promise<string | null> {
  const key = email.trim().toLowerCase()
  if (!key.includes('@')) return null
  const exact = await query(FIND_ADOPTED_USER_SQL, [key])
  if (exact.rows[0]?.id) return exact.rows[0].id
  const mixed = await query(FIND_MIXED_CASE_USER_SQL, [key])
  const id = mixed.rows[0]?.id
  if (!id) return null
  await query(PERSIST_ADOPTED_EMAIL_SQL, [id])
  return id
}

export async function emailFromAuthRequest(req: Request): Promise<string | null> {
  if (req.method !== 'POST') return null
  try {
    const body = await req.clone().json() as { email?: unknown }
    return typeof body.email === 'string' ? body.email : null
  } catch {
    return null
  }
}

/** Drop the raw DB session token from get-session / sign-in JSON. */
export function stripSessionToken(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const rec = body as Record<string, unknown>
  const session = rec.session
  if (!session || typeof session !== 'object' || !('token' in session)) return body
  const { token: _token, ...rest } = session as Record<string, unknown>
  return { ...rec, session: rest }
}

export async function mapAuthJson(res: Response, map: (body: unknown) => unknown): Promise<Response> {
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) return res
  const text = await res.text()
  if (!text) return new Response(text, { status: res.status, headers: res.headers })
  try {
    const next = JSON.stringify(map(JSON.parse(text)))
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    return new Response(next, { status: res.status, headers })
  } catch {
    return new Response(text, { status: res.status, headers: res.headers })
  }
}

export function authFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (
    message.includes('BETTER_AUTH_URL must be set')
    || message.includes('BETTER_AUTH_SECRET is not set')
    || message.includes('database is not configured')
  ) return message
  return 'request failed'
}

export function installEmailAdoption<T extends { query: Client['query'] }>(db: T): T {
  const orig = db.query.bind(db) as Client['query']
  const wrapped: Client['query'] = ((textOrConfig: unknown, values?: unknown, cb?: unknown) => {
    if (typeof textOrConfig === 'string') {
      return (orig as (text: string, values?: unknown, cb?: unknown) => unknown)(
        rewriteUserEmailLookup(textOrConfig),
        values,
        cb,
      )
    }
    if (textOrConfig && typeof textOrConfig === 'object' && 'text' in textOrConfig) {
      const cfg = textOrConfig as { text: string }
      return (orig as (q: { text: string }, values?: unknown, cb?: unknown) => unknown)(
        { ...cfg, text: rewriteUserEmailLookup(cfg.text) },
        values,
        cb,
      )
    }
    return (orig as (q: unknown, values?: unknown, cb?: unknown) => unknown)(textOrConfig, values, cb)
  }) as Client['query']
  db.query = wrapped
  return db
}

function clientOptions(url: string, env: Env) {
  return {
    connectionString: url,
    ssl: pgClientSsl(url, env),
    connectionTimeoutMillis: 5_000,
    keepAlive: false,
  }
}

/** Duck-typed Pool for Better Auth's Kysely dialect. One Client, no pg-pool. */
function clientAsAuthDb(client: Client): Pool {
  const query = client.query.bind(client) as Pool['query']
  return {
    query,
    connect: async () => ({ query, release() {} }),
    end: () => client.end(),
  } as unknown as Pool
}

async function openAuthDb(url: string, env: Env): Promise<{
  db: Pool
  client: Client
  close: () => Promise<void>
}> {
  const client = new Client(clientOptions(url, env))
  await client.connect()
  installEmailAdoption(client)
  return {
    db: clientAsAuthDb(client),
    client,
    close: () => client.end().then(() => undefined, () => undefined),
  }
}

export function createAuth(env: Env, pool: Pool) {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set')
  const baseURL = resolveAuthBaseURL(env)
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    database: pool,
    emailAndPassword: { enabled: false },
    user: BETTER_AUTH_SNAKE_CASE.user,
    session: BETTER_AUTH_SNAKE_CASE.session,
    account: BETTER_AUTH_SNAKE_CASE.account,
    verification: BETTER_AUTH_SNAKE_CASE.verification,
    trustedOrigins: [
      ...(isLocalAuthHost(baseURL)
        ? [baseURL, 'http://localhost:5173', 'http://localhost:8787', 'http://[::1]:5173', 'http://[::1]:8787']
        : [baseURL]),
      ...NATIVE_APP_ORIGINS,
    ],
    advanced: {
      database: {
        // athlete.auth_user_id is UUID. The pg adapter treats generateId:'uuid'
        // as "let the DB default it", but better-auth.sql has no DEFAULT on id.
        generateId: () => crypto.randomUUID(),
      },
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: authCookieSecure(baseURL),
        httpOnly: true,
        path: '/',
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            if (typeof user.email !== 'string') return
            return { data: { ...user, email: user.email.trim().toLowerCase() } }
          },
        },
        update: {
          async before(user) {
            if (typeof user.email !== 'string') return
            return { data: { ...user, email: user.email.trim().toLowerCase() } }
          },
        },
      },
    },
    plugins: [
      bearer({ requireSignature: true }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOTP: async ({ email, otp, type }) => {
          await sendOtpEmail(env, email, otp, type)
        },
      }),
    ],
  })
}

/** One Client per request; `waitUntil` finishes `client.end()` after the response. */
export async function withAuth<T>(
  env: Env,
  fn: (auth: AuthInstance) => Promise<T>,
  waitUntil?: WaitUntil,
  req?: Request,
): Promise<T> {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  const { db, close, client } = await openAuthDb(url, env)
  try {
    if (req) {
      const email = await emailFromAuthRequest(req)
      if (email) {
        await persistAdoptedUserEmail(
          (text, params) => client.query(text, params) as Promise<{ rows: { id: string }[] }>,
          email,
        )
      }
    }
    return await fn(createAuth(env, db))
  } finally {
    const ending = close()
    if (waitUntil) waitUntil(ending)
    else await ending
  }
}

export async function handleAuthRequest(
  env: Env,
  req: Request,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const res = await withAuth(env, (auth) => auth.handler(req), waitUntil, req)
  return mapAuthJson(res, stripSessionToken)
}

export async function sessionUser(
  env: Env,
  req: Request,
  waitUntil?: WaitUntil,
): Promise<{ id: string; email?: string | null } | null> {
  try {
    return await withSql(env, (sql) => sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET), waitUntil)
  } catch {
    return null
  }
}
