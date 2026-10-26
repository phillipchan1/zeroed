// Standalone check for timezone-aware week windows and the Sunday next-week path.
// Run: node --experimental-strip-types src/engine/weekDates.check.ts
//
// The property under test: in America/Los_Angeles, Sunday Oct 25 2026 — even
// 11pm, when UTC is already Monday — still belongs to Oct 19–25, and the
// upcoming week is Oct 26–Nov 1 (not Nov 2).

import {
  ATHLETE_TIME_ZONE, addDaysISO, isoDateInZone, weekWindowInZone, upcomingWeekWindow,
  isSundayInZone, nextMondayISO, logTimestampForWeek, isoInWeek, planPagerFutureWeeks,
} from './weekDates.ts'
import { logTimestampForWeek as logTs } from './weekDates.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}
function eq<T>(actual: T, expected: T, msg: string) {
  checks++
  if (actual !== expected) fails.push(`${msg} — expected ${String(expected)}, got ${String(actual)}`)
}

const TZ = ATHLETE_TIME_ZONE

// Sunday Oct 25 2026 10:00 PDT = 17:00 UTC
const sundayMorning = new Date('2026-10-25T17:00:00.000Z')
// Sunday Oct 25 2026 23:00 PDT = Monday Oct 26 06:00 UTC
const sundayNight = new Date('2026-10-26T06:00:00.000Z')
// Monday Oct 26 2026 01:00 PDT
const mondayMorning = new Date('2026-10-26T08:00:00.000Z')

eq(isoDateInZone(sundayMorning, TZ), '2026-10-25', 'Sunday morning PDT is still Oct 25')
eq(isoDateInZone(sundayNight, TZ), '2026-10-25', 'Sunday 11pm PDT is still Oct 25, not UTC Monday')
eq(isoDateInZone(mondayMorning, TZ), '2026-10-26', 'Monday 1am PDT is Oct 26')

ok(isSundayInZone(sundayMorning, TZ), 'Sunday morning is Sunday')
ok(isSundayInZone(sundayNight, TZ), 'Sunday night PDT is still Sunday')
ok(!isSundayInZone(mondayMorning, TZ), 'Monday morning is not Sunday')

eq(weekWindowInZone(sundayMorning, TZ).weekStart, '2026-10-19', 'Sunday belongs to the Oct 19 week')
eq(weekWindowInZone(sundayMorning, TZ).weekEnd, '2026-10-25', 'that week ends Oct 25')
eq(weekWindowInZone(sundayNight, TZ).weekStart, '2026-10-19', 'Sunday night still Oct 19–25')
eq(weekWindowInZone(mondayMorning, TZ).weekStart, '2026-10-26', 'Monday opens Oct 26–Nov 1')
eq(weekWindowInZone(mondayMorning, TZ).weekEnd, '2026-11-01', 'Monday week ends Nov 1')

eq(upcomingWeekWindow(sundayMorning, TZ).weekStart, '2026-10-26', 'on Sunday, next week starts Oct 26')
eq(upcomingWeekWindow(sundayMorning, TZ).weekEnd, '2026-11-01', 'on Sunday, next week ends Nov 1')
eq(upcomingWeekWindow(sundayNight, TZ).weekStart, '2026-10-26', 'Sunday night next week is Oct 26, not Nov 2')
eq(nextMondayISO(sundayNight, TZ), '2026-10-26', 'nextMondayISO on Sunday night PDT is Oct 26, not Nov 2')

// Starting a next-week session on Sunday stamps the log into next week.
const stamped = logTimestampForWeek(sundayNight, '2026-10-26', '2026-11-01', TZ)
eq(isoDateInZone(stamped, TZ), '2026-10-26', 'Sunday start for next week logs as Oct 26')
ok(!isoInWeek(stamped.toISOString(), '2026-10-19', '2026-10-25', TZ),
  'that log is not in the closed week')
ok(isoInWeek(stamped.toISOString(), '2026-10-26', '2026-11-01', TZ),
  'that log is in the upcoming week')

const sameDay = logTs(mondayMorning, '2026-10-26', '2026-11-01', TZ)
eq(sameDay.toISOString(), mondayMorning.toISOString(), 'a start already inside the week keeps its timestamp')

// Pager: Sunday's next week is always present, including a queued block's sessions.
const sundayPlans = planPagerFutureWeeks({
  thisMonday: '2026-10-19',
  activeWeekEnd: '2026-10-25',
  queued: { weekStart: '2026-11-02', weekEnd: '2026-12-06' },
})
eq(sundayPlans[0]?.weekStart, '2026-10-26', 'week+1 is always planned, even past the live block end')
eq(sundayPlans[0]?.source, 'active', 'Oct 26 is still the live block if the queue starts Nov 2')
ok(sundayPlans.some((p) => p.weekStart === '2026-11-02' && p.source === 'queued'),
  'queued Power week is in the pager')

const queuedMonday = planPagerFutureWeeks({
  thisMonday: '2026-10-19',
  activeWeekEnd: '2026-10-25',
  queued: { weekStart: '2026-10-26', weekEnd: '2026-11-22' },
})
eq(queuedMonday[0]?.source, 'queued', 'when the queue starts next Monday, week+1 is the queued block')
eq(queuedMonday[0]?.weekEnd, '2026-11-01', 'that upcoming week is Oct 26–Nov 1')

void addDaysISO

if (fails.length) {
  console.error(`weekDates.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`weekDates.check: ${checks} checks passed`)
