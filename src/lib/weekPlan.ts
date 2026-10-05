// Soft day-pinning — an optional, never-enforced "I mean to do this session on
// this day" hint. Scheduling stays count-based (computeWeekSchedule is
// untouched); this only labels the cards so the athlete can plan a week without
// the app policing it.
//
// Persisted on routine.intended_dow (migration 20260628000001), so a plan syncs
// across devices. The value rides along with the routine rows the app already
// loads; this module just writes it. dow: 0 = Monday … 6 = Sunday; null = "any".

import { supabase } from './supabaseClient'

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** Set (or clear, with null) a session's intended day. Owner-scoped by RLS. */
export async function setIntendedDay(routineId: string, dow: number | null): Promise<void> {
  await supabase.from('routine').update({ intended_dow: dow }).eq('id', routineId)
}

/**
 * The week list in calendar order: sessions pinned to a day run Mon → Sun, and
 * unpinned ones follow. Ties (same day, or both "any") keep name order. Without
 * this the list is alphabetical, so a session planned for Friday can open the
 * week.
 */
export function orderByPlannedDay<T extends { name: string }>(
  routines: T[],
  dowFor: (r: T) => number | null,
): T[] {
  const key = (r: T) => dowFor(r) ?? 7
  return [...routines].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name))
}
