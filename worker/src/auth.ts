import { betterAuth } from 'better-auth'
import { bearer, emailOTP } from 'better-auth/plugins'
import { Pool } from 'pg'
import { databaseUrl, type Env } from './env.ts'

type AuthInstance = ReturnType<typeof createAuth>

const cache = new WeakMap<object, AuthInstance>()

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

export function createAuth(env: Env) {
  const url = databaseUrl(env)
  if (!url) throw new Error('database is not configured (HYPERDRIVE or DATABASE_URL)')
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set')
  const baseURL = (env.BETTER_AUTH_URL || 'http://localhost:8787').replace(/\/+$/, '')
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    database: new Pool({ connectionString: url, max: 5 }),
    emailAndPassword: { enabled: false },
    trustedOrigins: [baseURL, 'http://localhost:5173', 'http://localhost:8787'],
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: !baseURL.startsWith('http://localhost'),
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

export function getAuth(env: Env): AuthInstance {
  const cached = cache.get(env)
  if (cached) return cached
  const auth = createAuth(env)
  cache.set(env, auth)
  return auth
}

export async function sessionUser(
  env: Env,
  req: Request,
): Promise<{ id: string; email?: string | null } | null> {
  try {
    const auth = getAuth(env)
    const session = await auth.api.getSession({ headers: req.headers })
    if (!session?.user?.id) return null
    return { id: session.user.id, email: session.user.email }
  } catch {
    return null
  }
}
