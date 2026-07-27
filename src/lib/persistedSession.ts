/* Synchronous read of the Supabase session that's already on this device.
 *
 * `supabase.auth.getSession()` is async: it takes an internal lock, and if the
 * access token has expired it goes to the network to refresh before resolving.
 * Gating the app's first render on it means a returning athlete stares at the
 * splash spinner on every cold launch — and on a dead connection, until the
 * refresh times out.
 *
 * Supabase persists the whole session as JSON in localStorage, so we can read
 * the athlete's identity synchronously and paint the app from cache on frame
 * one. The async client still runs behind it and remains the authority: it
 * refreshes the token, and `onAuthStateChange` corrects us if the session turns
 * out to be dead.
 *
 * This is a read of what's already stored — no token is validated or trusted
 * here. Every actual data request still carries the real token and is still
 * checked by the server's row-level security.
 */
import type { User } from '@supabase/supabase-js'

// supabase-js writes under `sb-<project-ref>-auth-token`. The project ref is
// derived from the URL at build time, so rather than recompute it we match the
// shape — there's only ever one Supabase project in this app.
const KEY_PATTERN = /^sb-.+-auth-token$/

interface StoredSession {
  user?: User | null
}

function parse(raw: string): StoredSession | null {
  try {
    // Some supabase-js builds base64-encode the payload; tolerate both forms.
    const json = raw.startsWith('base64-') ? atob(raw.slice('base64-'.length)) : raw
    const parsed = JSON.parse(json)
    // Older shapes nested the session under `currentSession`.
    return (parsed?.currentSession ?? parsed) as StoredSession
  } catch {
    return null
  }
}

/**
 * The user from the persisted session, or null if this device has none. Never
 * throws (private mode / storage disabled just reads as "signed out").
 */
export function persistedUser(): User | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !KEY_PATTERN.test(key)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const session = parse(raw)
      if (session?.user?.id) return session.user as User
    }
  } catch {
    /* storage unavailable — fall back to the async path */
  }
  return null
}
