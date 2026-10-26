import { createAuthClient } from 'better-auth/client'
import { emailOTPClient } from 'better-auth/client/plugins'
import { supabase } from './supabaseClient'
import { authBaseUrl, isCloudflareApi } from './api'

export interface AuthUser {
  id: string
  email?: string | null
}

export interface AuthSession {
  user: AuthUser | null
}

const PERSIST_KEY = 'zeroed_auth_user'

export function persistAuthUser(user: AuthUser | null): void {
  try {
    if (!user) localStorage.removeItem(PERSIST_KEY)
    else localStorage.setItem(PERSIST_KEY, JSON.stringify({ id: user.id, email: user.email ?? null }))
  } catch {
    /* private mode */
  }
}

export function persistedBetterAuthUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AuthUser
    return parsed?.id ? parsed : null
  } catch {
    return null
  }
}

function makeBetterAuthClient() {
  const base = authBaseUrl() ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787')
  return createAuthClient({
    baseURL: base,
    basePath: '/api/auth',
    plugins: [emailOTPClient()],
    fetchOptions: { credentials: 'include' },
  })
}

let _client: ReturnType<typeof makeBetterAuthClient> | null = null

export function betterAuthClient() {
  if (!_client) _client = makeBetterAuthClient()
  return _client
}

export async function sendSignInCode(email: string): Promise<{ error: { message: string } | null }> {
  if (!isCloudflareApi()) {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    return { error: error ? { message: error.message } : null }
  }
  const { error } = await betterAuthClient().emailOtp.sendVerificationOtp({
    email,
    type: 'sign-in',
  })
  return { error: error ? { message: error.message || 'Could not send code' } : null }
}

export async function verifySignInCode(
  email: string,
  otp: string,
): Promise<{ error: { message: string } | null }> {
  if (!isCloudflareApi()) {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'email',
    })
    return { error: error ? { message: error.message } : null }
  }
  const { data, error } = await betterAuthClient().signIn.emailOtp({ email, otp })
  if (error) return { error: { message: error.message || 'Invalid code' } }
  const user = data?.user
  if (user?.id) persistAuthUser({ id: user.id, email: user.email })
  window.dispatchEvent(new CustomEvent('zeroed:auth-changed', { detail: { user: user ?? null } }))
  return { error: null }
}

export async function signOutLocal(): Promise<void> {
  persistAuthUser(null)
  if (!isCloudflareApi()) {
    await supabase.auth.signOut({ scope: 'local' })
    return
  }
  try {
    await betterAuthClient().signOut()
  } catch {
    /* local clear is enough */
  }
  window.dispatchEvent(new CustomEvent('zeroed:auth-changed', { detail: { user: null } }))
}

export async function getSessionUser(): Promise<AuthUser | null> {
  if (!isCloudflareApi()) {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    return user ? { id: user.id, email: user.email } : null
  }
  const { data } = await betterAuthClient().getSession()
  const user = data?.user
  if (!user?.id) {
    persistAuthUser(null)
    return null
  }
  const next = { id: user.id, email: user.email }
  persistAuthUser(next)
  return next
}

export async function getAccessToken(): Promise<string | null> {
  if (!isCloudflareApi()) {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }
  const { data } = await betterAuthClient().getSession()
  const token = data?.session?.token
  return typeof token === 'string' ? token : null
}

export function subscribeAuth(handler: (user: AuthUser | null) => void): () => void {
  if (!isCloudflareApi()) {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      handler(session?.user ? { id: session.user.id, email: session.user.email } : null)
    })
    return () => subscription.unsubscribe()
  }
  const onCustom = (ev: Event) => {
    const detail = (ev as CustomEvent<{ user: AuthUser | null }>).detail
    handler(detail?.user ?? null)
  }
  window.addEventListener('zeroed:auth-changed', onCustom)
  return () => window.removeEventListener('zeroed:auth-changed', onCustom)
}
