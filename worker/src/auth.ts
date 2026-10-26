import { betterAuth } from 'better-auth'
import { bearer, emailOTP } from 'better-auth/plugins'
import { Pool } from 'pg'
import { authCookieSecure, isLocalAuthHost, resolveAuthBaseURL } from './authUrl.ts'
import { NATIVE_APP_ORIGINS } from './cors.ts'
import { sessionFromRequest } from './data.ts'
import { withSql, type WaitUntil } from './db.ts'
import { databaseUrl, useDatabaseSsl, type Env } from './env.ts'

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

function authPool(url: string, env: Env): Pool {
  return new Pool({
    connectionString: url,
    max: 1,
    allowExitOnIdle: true,
    ssl: useDatabaseSsl(url, env) ? { rejectUnauthorized: false } : false,
  })
}

export function createAuth(env: Env, pool?: Pool) {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set')
  const baseURL = resolveAuthBaseURL(env)
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    database: pool ?? authPool(url, env),
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
    plugins: [
      bearer(),
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

/** One Pool per request; `waitUntil` finishes `pool.end()` after the response. */
export async function withAuth<T>(
  env: Env,
  fn: (auth: AuthInstance) => Promise<T>,
  waitUntil?: WaitUntil,
): Promise<T> {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  const pool = authPool(url, env)
  try {
    return await fn(createAuth(env, pool))
  } finally {
    const ending = pool.end().catch(() => undefined)
    if (waitUntil) waitUntil(ending)
    else await ending
  }
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
