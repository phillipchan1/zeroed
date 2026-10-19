// Soft day-pinning — an optional, never-enforced "I mean to do this session on
// this day" hint. Scheduling stays count-based (computeWeekSchedule is
// untouched); this only labels the cards so the athlete can plan a week without
// the app policing it.
//
// Persisted on routine.intended_dow (migration 20260628000001), so a plan syncs
// across devices. The value rides along with the routine rows the app already
// loads; this module just writes it. dow: 0 = Monday … 6 = Sunday; null = "any".

import { supabase } from './supabaseClient'

export { orderByPlannedDay, dayFromName } from './weekOrder.ts'

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** Set (or clear, with null) a session's intended day. Owner-scoped by RLS. */
export async function setIntendedDay(routineId: string, dow: number | null): Promise<void> {
  await supabase.from('routine').update({ intended_dow: dow }).eq('id', routineId)
}
