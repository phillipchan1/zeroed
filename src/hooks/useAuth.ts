import { useEffect, useState } from 'react'
import {
  getSessionUser,
  persistAuthUser,
  persistedBetterAuthUser,
  subscribeAuth,
  type AuthUser,
} from '../lib/authClient'
import { isCloudflareApi } from '../lib/api'
import { clearAllCache } from '../lib/cache'
import { clearAllDraftsLocal } from '../lib/workoutDraft'
import { persistedUser } from '../lib/persistedSession'

interface AuthState {
  user: AuthUser | null
  loading: boolean
}

function initialUser(): AuthUser | null {
  if (isCloudflareApi()) return persistedBetterAuthUser()
  const fromSb = persistedUser()
  return fromSb ? { id: fromSb.id, email: fromSb.email } : null
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(initialUser)
  const [loading, setLoading] = useState(() => initialUser() === null)

  useEffect(() => {
    getSessionUser().then((next) => {
      setUser(next)
      setLoading(false)
    })

    const unsubscribe = subscribeAuth((next) => {
      if (!next) {
        clearAllCache()
        clearAllDraftsLocal()
        persistAuthUser(null)
      }
      setUser(next)
      setLoading(false)
    })

    return unsubscribe
  }, [])

  return { user, loading }
}
