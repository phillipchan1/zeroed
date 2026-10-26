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

export interface ZonedDay {
  y: number
  m: number
  day: number
  dow: number
}

/** Calendar Y/M/D and weekday as they are in `timeZone`. */
export function zonedParts(d: Date, timeZone = ATHLETE_TIME_ZONE): ZonedDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    day: Number(get('day')),
    dow: DOW_FROM_WEEKDAY[get('weekday')] ?? 0,
  }
}

export function isoDateInZone(d: Date, timeZone = ATHLETE_TIME_ZONE): string {
  const { y, m, day } = zonedParts(d, timeZone)
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export interface WeekWindow {
  weekStart: string
  weekEnd: string
}

/** Monday–Sunday containing `at` in `timeZone`. */
export function weekWindowInZone(at: Date, timeZone = ATHLETE_TIME_ZONE): WeekWindow {
  const { y, m, day, dow } = zonedParts(at, timeZone)
  const weekStart = addDaysISO(
    `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    -((dow + 6) % 7),
  )
  return { weekStart, weekEnd: addDaysISO(weekStart, 6) }
}

/** The Mon–Sun week after the one containing `at`. */
export function upcomingWeekWindow(at: Date, timeZone = ATHLETE_TIME_ZONE): WeekWindow {
  const { weekStart } = weekWindowInZone(at, timeZone)
  const next = addDaysISO(weekStart, 7)
  return { weekStart: next, weekEnd: addDaysISO(next, 6) }
}

export function isSundayInZone(at: Date, timeZone = ATHLETE_TIME_ZONE): boolean {
  return zonedParts(at, timeZone).dow === 0
}

function civilStampInZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00`
}

/** Civil clock time in `timeZone` as a real UTC instant. Device TZ is ignored. */
export function zonedCivilTime(
  dateStr: string,
  hour: number,
  minute = 0,
  timeZone = ATHLETE_TIME_ZONE,
): Date {
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  const wanted = `${dateStr}T${hh}:${mm}:00`
  let utc = Date.parse(`${wanted}Z`)
  for (let i = 0; i < 4; i++) {
    const shown = civilStampInZone(new Date(utc), timeZone)
    const delta = Date.parse(`${wanted}Z`) - Date.parse(`${shown}Z`)
    utc += delta
    if (delta === 0) break
  }
  return new Date(utc)
}

/**
 * When a session is started for a week the athlete is not currently in
 * (Sunday → next week), stamp the log on that week's Monday noon so it
 * counts for the upcoming week, not the closed one.
 *
 * Noon is the athlete/program timezone (America/Los_Angeles by default), never
 * the device's local zone — a UTC+10 phone would otherwise land Monday noon
 * local on Sunday afternoon in LA and log into the closed week.
 */
export function logTimestampForWeek(
  at: Date,
  weekStart: string,
  weekEnd: string,
  timeZone = ATHLETE_TIME_ZONE,
): Date {
  const day = isoDateInZone(at, timeZone)
  if (day >= weekStart && day <= weekEnd) return at
  if (day < weekStart) return zonedCivilTime(weekStart, 12, 0, timeZone)
  return at
}

/** True when `iso` (timestamp or YYYY-MM-DD) falls on a day inside the week. */
export function isoInWeek(
  iso: string,
  weekStart: string,
  weekEnd: string,
  timeZone = ATHLETE_TIME_ZONE,
): boolean {
  const day = iso.includes('T') || iso.endsWith('Z')
    ? isoDateInZone(new Date(iso), timeZone)
    : iso.slice(0, 10)
  return day >= weekStart && day <= weekEnd
}

/** The Monday a deferred change would land on, in the athlete's timezone. */
export function nextMondayISO(from: Date = new Date(), timeZone = ATHLETE_TIME_ZONE): string {
  return upcomingWeekWindow(from, timeZone).weekStart
}

export type PagerWeekSource = 'active' | 'queued'

export interface PagerWeekPlan {
  weekStart: string
  weekEnd: string
  source: PagerWeekSource
}

/**
 * Weeks the Train pager can open after this Monday.
 *
 * Week+1 is always included so Sunday can open the upcoming week. Later weeks
 * run through the later of the live block's end and a queued block's end.
 * A week whose Monday is on or after the queued start reads as queued.
 */
export function planPagerFutureWeeks(opts: {
  thisMonday: string
  activeWeekEnd?: string | null
  queued?: { weekStart: string; weekEnd?: string | null } | null
  maxForward?: number
}): PagerWeekPlan[] {
  const max = opts.maxForward ?? 6
  const ends = [opts.activeWeekEnd, opts.queued?.weekEnd]
    .filter((d): d is string => !!d)
    .sort()
  const horizon = ends.length ? ends[ends.length - 1] : addDaysISO(opts.thisMonday, 6)

  const out: PagerWeekPlan[] = []
  for (let k = 1; k <= max; k++) {
    const weekStart = addDaysISO(opts.thisMonday, 7 * k)
    const weekEnd = addDaysISO(weekStart, 6)
    if (k > 1 && weekStart > horizon) break
    const queued = !!opts.queued && weekStart >= opts.queued.weekStart
    out.push({ weekStart, weekEnd, source: queued ? 'queued' : 'active' })
  }
  return out
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
