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

/** The athlete's training calendar. Sunday 5pm here is still Sunday, even if UTC has rolled to Monday. */
export const ATHLETE_TIME_ZONE = 'America/Los_Angeles'

const DOW_FROM_WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/** The Monday a deferred change would land on, in the athlete's timezone. */
export function nextMondayISO(from: Date = new Date(), timeZone = ATHLETE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(from)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const todayISO = `${Number(get('year'))}-${String(Number(get('month'))).padStart(2, '0')}-${String(Number(get('day'))).padStart(2, '0')}`
  const dow = DOW_FROM_WEEKDAY[get('weekday')] ?? 0
  return addDaysISO(addDaysISO(todayISO, -((dow + 6) % 7)), 7)
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
