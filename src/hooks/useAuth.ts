import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { clearAllCache, loadCache, saveCache } from '../lib/cache'
import { clearAllDraftsLocal } from '../lib/workoutDraft'

interface AuthState {
  user: User | null
  loading: boolean
}

// The last authenticated user id, persisted so the app can key its per-user
// cache and hydrate the whole UI from localStorage on the next launch — BEFORE
// getSession() resolves. That's the difference between an instant, offline-first
// open and a Splash that waits on the wire. Stored under the versioned cache
// prefix, so clearAllCache() (sign-out) sweeps it along with everything else.
const UID_KEY = 'auth:uid'

/** The last known signed-in user id, or null. Synchronous — safe to read during
 *  render to seed a cache key before auth has resolved. */
export function getCachedUserId(): string | null {
  return loadCache<string>(UID_KEY)
}

export function useAuth(): AuthState {
  const [user, setUser]       = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Get the current session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null
      if (u) saveCache(UID_KEY, u.id)
      setUser(u)
      setLoading(false)
    })

    // Subscribe to auth changes (magic link confirm, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Drop every cached view and any local workout draft on sign-out so the
      // next account on this device starts clean.
      if (event === 'SIGNED_OUT') { clearAllCache(); clearAllDraftsLocal() }
      const u = session?.user ?? null
      if (u) saveCache(UID_KEY, u.id)
      setUser(u)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  return { user, loading }
}
