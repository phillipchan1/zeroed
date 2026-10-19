// Pure ordering for the Today week list. Kept apart from weekPlan.ts (which
// pulls in the Supabase client) so the *.check.ts convention can run it in node.

const NAME_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * The day a session name leads with ("Fri Bench Power…" → 4), or null. Programs
 * name their sessions by day, and a session the athlete never pinned should still
 * sit where its name says it belongs. Word-bounded, so "Monster Carries" isn't Monday.
 */
export function dayFromName(name: string): number | null {
  const m = /^\s*(mon|tue|wed|thu|fri|sat|sun)(?:s|sday|nesday|rsday|urday|day)?\b/i.exec(name)
  return m ? NAME_DAYS.indexOf(m[1].toLowerCase()) : null
}

/**
 * The week list in calendar order. A day the athlete pinned wins; otherwise a day
 * the session's name leads with; sessions with neither follow. Ties keep name
 * order. Without this the list is alphabetical, so Friday can open the week.
 */
export function orderByPlannedDay<T extends { name: string }>(
  routines: T[],
  dowFor: (r: T) => number | null,
): T[] {
  const key = (r: T) => dowFor(r) ?? dayFromName(r.name) ?? 7
  return [...routines].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name))
}
