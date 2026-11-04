import { useSyncExternalStore } from 'react'

/**
 * Live `matchMedia`. A screen that lays out differently by width (Coach: a
 * folded read + docked chat on a phone, a split pane on a desktop) needs to
 * *render* different things, not just hide them with CSS — hiding a second
 * copy of a stateful component leaves it mounted and diverging.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  )
}
