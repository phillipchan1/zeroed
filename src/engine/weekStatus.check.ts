// Completion and adherence for a week instance — not a session id.
// Run: node --experimental-strip-types src/engine/weekStatus.check.ts
//
// apply_program_edits timing=now reuses routine ids. A log from Oct 20 must
// stay DONE on the Oct 19–25 week and must NOT mark the same id DONE on
// Oct 26–Nov 1. Adherence for a 1-of-5 week must ignore last week's duplicates.

import {
  sessionStateForWeek, weekLoggedDays, weekAdherence, workoutsInWeek, activeBlockRetestDate,
} from './weekStatus.ts'
import { logTimestampForWeek, isoInWeek, ATHLETE_TIME_ZONE } from './weekDates.ts'
import { tallyWeek, type WeekWorkout } from './prescription.ts'

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

const LAST = { weekStart: '2026-10-19', weekEnd: '2026-10-25' }
const NEXT = { weekStart: '2026-10-26', weekEnd: '2026-11-01' }
const TZ = ATHLETE_TIME_ZONE

const oct20 = { routineId: 'sess-a', performedAt: '2026-10-20T18:00:00.000Z' }
const oct20b = { routineId: 'sess-a', performedAt: '2026-10-20T20:00:00.000Z' }
const oct21 = { routineId: 'sess-b', performedAt: '2026-10-21T18:00:00.000Z' }
const all = [oct20, oct20b, oct21]

eq(workoutsInWeek(all, LAST.weekStart, LAST.weekEnd, TZ).length, 3, 'last week keeps its own logs')
eq(workoutsInWeek(all, NEXT.weekStart, NEXT.weekEnd, TZ).length, 0, 'next week does not inherit them')

const lastState = sessionStateForWeek({
  routineId: 'sess-a', ...LAST, workouts: all, timeZone: TZ,
})
eq(lastState.kind, 'done', 'Oct 20 log marks the session done on Oct 19–25')
ok(lastState.lastPerformedAt?.startsWith('2026-10-20') === true, 'done chip points at the Oct 20 log')

const nextState = sessionStateForWeek({
  routineId: 'sess-a', ...NEXT, workouts: all, timeZone: TZ,
})
eq(nextState.kind, 'todo', 'rewritten / reused session starts not-done in the new week')
eq(nextState.count, 0, 'no in-week logs → count 0')

eq(weekLoggedDays(all, LAST.weekStart, LAST.weekEnd, TZ), 2,
  'header counts distinct days (Tue+Wed), not raw rows')
eq(weekLoggedDays(all, NEXT.weekStart, NEXT.weekEnd, TZ), 0,
  'header on the new week ignores last week')

const adh = weekAdherence(5, all, NEXT.weekStart, NEXT.weekEnd, TZ)
eq(adh.done, 0, '1-of-5 next week is not padded by last week')
eq(adh.adherence, 0, 'adherence is 0%, not 100%')

const lastAdh = weekAdherence(5, all, LAST.weekStart, LAST.weekEnd, TZ)
eq(lastAdh.done, 2, 'closed week has 2 distinct days')
eq(lastAdh.adherence, 0.4, '2/5 = 40%')

// A Sunday start for next week must not change the closed week's counts.
const sunday = new Date('2026-10-26T06:00:00.000Z') // 11pm PDT Sunday
const nextLog = {
  routineId: 'sess-a',
  performedAt: logTimestampForWeek(sunday, NEXT.weekStart, NEXT.weekEnd, TZ).toISOString(),
}
ok(isoInWeek(nextLog.performedAt, NEXT.weekStart, NEXT.weekEnd, TZ), 'Sunday start lands in next week')
ok(!isoInWeek(nextLog.performedAt, LAST.weekStart, LAST.weekEnd, TZ), 'and not in the closed week')

const closedAfter = weekAdherence(5, [...all, nextLog], LAST.weekStart, LAST.weekEnd, TZ)
eq(closedAfter.done, lastAdh.done, 'closed-week count is unchanged by a next-week start')
eq(weekAdherence(5, [...all, nextLog], NEXT.weekStart, NEXT.weekEnd, TZ).done, 1,
  'the new log counts on next week')

eq(sessionStateForWeek({
  routineId: 'sess-a', ...NEXT, workouts: all,
  draftStartedAt: '2026-10-20T16:00:00.000Z', timeZone: TZ,
}).kind, 'todo', 'a last-week draft is not in-progress on the new week')

eq(sessionStateForWeek({
  routineId: 'sess-a', ...LAST, workouts: [],
  draftStartedAt: '2026-10-20T16:00:00.000Z', timeZone: TZ,
}).kind, 'in_progress', 'a draft started inside the week is in progress there')

// tallyWeek uses the same week-instance rule (adherence bleed).
const mixed: WeekWorkout[] = [
  { performed_at: '2026-10-20T18:00:00.000Z', rpe: 8, actual_weights: null },
  { performed_at: '2026-10-20T20:00:00.000Z', rpe: 8, actual_weights: null },
  { performed_at: '2026-10-21T18:00:00.000Z', rpe: 7, actual_weights: null },
  { performed_at: '2026-10-27T18:00:00.000Z', rpe: 5, actual_weights: null },
]
const nextTally = tallyWeek(5, mixed, [], NEXT)
eq(nextTally.done, 1, 'tallyWeek next week: only the Oct 27 log')
eq(nextTally.adherence, 0.2, 'tallyWeek next week: 1/5')
const lastTally = tallyWeek(5, mixed, [], LAST)
eq(lastTally.done, 2, 'tallyWeek last week: two distinct days, not three rows')
ok(lastTally.adherence < 1, 'last week is not 100% from leftover rows')

eq(activeBlockRetestDate({ programRetest: '2026-08-12', phaseStart: '2026-11-09', phaseEnd: '2026-12-06' }),
  '2026-12-07', 'stale profile retest yields the Monday after the active block')
eq(activeBlockRetestDate({ programRetest: '2026-12-07', phaseStart: '2026-11-09', phaseEnd: '2026-12-06' }),
  '2026-12-07', 'a program retest on this block is kept')

if (fails.length) {
  console.error(`weekStatus.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`weekStatus.check: ${checks} checks passed`)
