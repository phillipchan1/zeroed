// =============================================================================
// WEEK DATES — the one place that decides where a training week begins and ends.
//
// A block runs Monday → Sunday. Everything downstream assumes it: the week
// pager, the weekly review's week_ending, the recap window, and — critically —
// phase advancement, which fires on the first app open once `today >= week_end`.
//
// When these are computed ad hoc, they drift, and the drift compounds. A block
// stamped with `today` as its week_start ends mid-week; advancement then fires
// mid-week and stamps the NEXT block with a mid-week start too. One mid-week
// start in July is enough to keep re-infecting every block after it — which is
// how a block that began on a Wednesday handed a Tuesday end date to the block
// that swapped out a real training week in the middle of it.
//
// Pure and dependency-free on purpose, so it can be checked without a database
// (see phaseBoundary.check.ts).
// =============================================================================

/** Monday of the week containing `d`, local time. */
export function startOfWeekMonday(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7))
  return r
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Noon avoids the DST edge: at midnight a spring-forward day can land the Date
// on the previous day once local time is applied.
export function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

/** The Sunday ending the week that starts on `monday`. */
export function weekEndingISO(monday: Date): string {
  const sun = new Date(monday)
  sun.setDate(monday.getDate() + 6)
  return isoDate(sun)
}

/** The Monday a deferred change would land on. */
export function nextMondayISO(from: Date = new Date()): string {
  return addDaysISO(isoDate(startOfWeekMonday(from)), 7)
}

/**
 * The Sunday on or after `dateStr` — blocks end on a Sunday.
 *
 * Use this on any end date inherited from elsewhere (a block that keeps its
 * predecessor's runway inherits its weekday too). This is what stops a legacy
 * mid-week date propagating forward forever.
 */
export function sundayOnOrAfterISO(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`)
  return addDaysISO(dateStr, (7 - d.getDay()) % 7)
}
