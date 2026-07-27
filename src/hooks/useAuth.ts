import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { clearAllCache } from '../lib/cache'
import { clearAllDraftsLocal } from '../lib/workoutDraft'
import { persistedUser } from '../lib/persistedSession'

interface AuthState {
  user: User | null
  loading: boolean
}

export function useAuth(): AuthState {
  // Hydrate synchronously from the session already stored on this device, so a
  // returning athlete never sees the splash — not on a cold launch, not on a
  // dead connection. `loading` is true only for a device that has never signed
  // in, where there genuinely is nothing to paint yet.
  //
  // supabase.auth stays the authority: it refreshes the token in the background
  // and, if the session turns out to be dead, SIGNED_OUT arrives through
  // onAuthStateChange and swaps the app back to onboarding.
  const [user, setUser]       = useState<User | null>(() => persistedUser())
  const [loading, setLoading] = useState(() => persistedUser() === null)

  useEffect(() => {
    // Reconcile with the real session (token refresh, expiry, another tab).
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // Subscribe to auth changes (magic link confirm, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Drop every cached view and any local workout draft on sign-out so the
      // next account on this device starts clean.
      if (event === 'SIGNED_OUT') { clearAllCache(); clearAllDraftsLocal() }
      setUser(session?.user ?? null)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  return { user, loading }
}
