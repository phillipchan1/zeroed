// log_session_v1 on the client: the shared rules (engine/sportLog.ts), the
// queued row (engine/sportLogPending.ts), where Today offers it, and that with
// the flag off nothing on Today, the session sheet, "Log outside the plan" or
// the outbox behaves differently. The Worker side is worker/src/sportSessions.check.ts.
// Run: node --experimental-strip-types src/engine/sportLog.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addSessionVisible, dateProblem, isSportCard, loggableDates, loggableWeekStart, logThisSessionVisible, outsidePlanEntryVisible,
  parseSportLog, sessionLoadAu, sportSummary, SPORT_STARTERS,
} from './sportLog.ts'
import { isoDateInZone, weekWindowInZone } from './weekDates.ts'
import { buildSportLogPending, sportLogBody } from './sportLogPending.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

const TODAY = '2026-11-13'

// ---- the rules -------------------------------------------------------------------
ok(JSON.stringify(SPORT_STARTERS) === JSON.stringify(['Basketball', 'Run', 'Ride', 'Class', 'Match', 'Other']), 'starters: Basketball, Run, Ride, Class, Match, Other')
// The window is the current training week (weekDates.ts: Monday → Sunday), Monday through today.
// TODAY is Friday 2026-11-13; its week began Monday 2026-11-09.
ok(loggableWeekStart(TODAY) === '2026-11-09', 'week start: Friday 13 Nov is in the week of Monday 9 Nov')
ok(JSON.stringify(loggableDates(TODAY)) === JSON.stringify(['2026-11-13', '2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09']), 'loggable dates: today back to this week\'s Monday, newest first')
ok(dateProblem('2026-11-09', TODAY) === null, 'date: the Monday the week began is fine')
ok(dateProblem(TODAY, TODAY) === null, 'date: today is fine')
ok(/training week: Monday 2026-11-09/.test(dateProblem('2026-11-08', TODAY) ?? ''), 'date: the Sunday before the week began is refused')
ok(/future/.test(dateProblem('2026-11-14', TODAY) ?? ''), 'date: tomorrow (Saturday, same week) is refused')
ok(/future/.test(dateProblem('2026-11-15', TODAY) ?? ''), 'date: Sunday of this week, still ahead, is refused')
ok(JSON.stringify(loggableDates('2026-11-09')) === JSON.stringify(['2026-11-09']) && dateProblem('2026-11-08', '2026-11-09') != null, 'Monday: only Monday; yesterday is last week')
ok(loggableDates('2026-11-15').length === 7 && loggableDates('2026-11-15')[6] === '2026-11-09', 'Sunday: the whole week, Monday through Sunday')
ok(loggableWeekStart('2026-03-09') === '2026-03-09' && loggableWeekStart('2026-03-08') === '2026-03-02', 'week start across the March DST change')
ok(!parseSportLog({ activity: 'Run', date: '2026-11-08', duration_min: 30, session_rpe: 5 }, TODAY).ok, 'parse: a date before the week began is refused')
ok(!parseSportLog({ date: '2026-11-08' }, TODAY, { partial: true }).ok && parseSportLog({ date: '2026-11-09' }, TODAY, { partial: true }).ok, 'parse (edit): moving a date out of the week is refused; to Monday is fine')
// Midnight in Phil's zone, at fixed instants: the calendar date and week are Los Angeles's, not UTC's.
const LA = 'America/Los_Angeles'
const sunLate = new Date('2026-11-16T07:30:00Z') // Sunday 15 Nov, 23:30 PST (already Monday in UTC)
const monEarly = new Date('2026-11-16T08:30:00Z') // Monday 16 Nov, 00:30 PST
const sunToday = isoDateInZone(sunLate, LA)
const monToday = isoDateInZone(monEarly, LA)
ok(sunToday === '2026-11-15' && loggableWeekStart(sunToday) === weekWindowInZone(sunLate, LA).weekStart && loggableWeekStart(sunToday) === '2026-11-09', 'Sunday 23:30 PT is still Sunday, in the week of Monday 9 Nov')
ok(dateProblem('2026-11-15', sunToday) === null && dateProblem('2026-11-09', sunToday) === null && dateProblem('2026-11-16', sunToday) != null, 'Sunday 23:30 PT: Sunday and that Monday are fine; UTC\'s Monday is the future')
ok(monToday === '2026-11-16' && loggableWeekStart(monToday) === weekWindowInZone(monEarly, LA).weekStart && loggableWeekStart(monToday) === '2026-11-16', 'Monday 00:30 PT starts the next week')
ok(dateProblem('2026-11-16', monToday) === null && /training week/.test(dateProblem('2026-11-15', monToday) ?? ''), 'Monday 00:30 PT: the Sunday just gone is before the week start, refused')
ok(/YYYY-MM-DD/.test(dateProblem('2026-11-31', TODAY) ?? '') && /YYYY-MM-DD/.test(dateProblem('13/11/2026', TODAY) ?? ''), 'date: bad dates refused')
const full = { activity: 'basketball', date: TODAY, duration_min: 25, session_rpe: 6 }
const okParse = parseSportLog(full, TODAY)
ok(okParse.ok && okParse.value.activity === 'Basketball' && okParse.value.pain?.length === 0 && okParse.value.notes === null, 'parse: a minimal log; activity tidied; pain and notes empty')
const bad = (raw: Record<string, unknown>, re: RegExp, msg: string) => {
  const r = parseSportLog({ ...full, ...raw }, TODAY)
  ok(!r.ok && re.test(r.error), msg)
}
bad({ activity: '' }, /activity is required/, 'parse: activity required')
bad({ date: undefined }, /date is required/, 'parse: date required')
bad({ duration_min: undefined }, /duration_min is required/, 'parse: minutes required')
bad({ duration_min: 0 }, /1–600/, 'parse: 0 min refused')
bad({ duration_min: 601 }, /1–600/, 'parse: 601 min refused')
bad({ session_rpe: 0 }, /1–10/, 'parse: RPE 0 refused (a session that happened has effort)')
bad({ session_rpe: 11 }, /1–10/, 'parse: RPE 11 refused')
bad({ session_rpe: undefined }, /session_rpe is required/, 'parse: RPE required')
bad({ pain: [{ region: 'knee', score: -1 }] }, /0–10/, 'parse: pain score below 0 refused')
bad({ pain: [{ region: 'nose', score: 1 }] }, /region/, 'parse: unknown region refused')
const noRpe = parseSportLog({ ...full, session_rpe: undefined }, TODAY, { requireRpe: false })
ok(noRpe.ok && noRpe.value.session_rpe === null, 'parse: without health access, RPE may be absent')
const partial = parseSportLog({ duration_min: 30 }, TODAY, { partial: true })
ok(partial.ok && Object.keys(partial.value).join() === 'duration_min', 'parse (edit): only the fields given')
ok(sessionLoadAu(6, 25) === 150 && sessionLoadAu(null, 25) === null, 'session load = RPE × minutes')
ok(sportSummary({ activity: 'Basketball', duration_min: 25, session_rpe: 6 }) === 'Basketball · 25 min · effort 6', 'summary line')

// ---- where Today offers it ----------------------------------------------------------
ok(isSportCard({ name: 'Thu Basketball (conditioning)', session_type: 'conditioning' }), 'card: the primer-only basketball day is a sport card')
ok(isSportCard({ name: 'Thu Basketball', session_type: 'mobility' }), 'card: by name too')
ok(!isSportCard({ name: 'Upper A', session_type: 'strength' }) && !isSportCard({ name: 'Mobility primer', session_type: 'mobility' }), 'card: a lifting or mobility day is not')
for (const w of [-2, -1, 0, 1]) {
  ok(addSessionVisible({ flagOn: false, weekOffset: w }) === false, `flag off: no "Add session" (week ${w})`)
  ok(logThisSessionVisible({ flagOn: false, weekOffset: w, routine: { name: 'Thu Basketball', session_type: 'conditioning' } }) === false, `flag off: no "Log this session" (week ${w})`)
}
ok(addSessionVisible({ flagOn: true, weekOffset: 0 }) === true, 'flag on: "Add session" on the current week — whatever the week holds (no session-count input at all)')
ok(addSessionVisible({ flagOn: true, weekOffset: 1 }) === false && addSessionVisible({ flagOn: true, weekOffset: -1 }) === false, 'flag on: only the current week')
ok(logThisSessionVisible({ flagOn: true, weekOffset: 0, routine: { name: 'Thu Basketball (conditioning)', session_type: 'conditioning' } }), 'flag on: "Log this session" on the planned conditioning card')
ok(!logThisSessionVisible({ flagOn: true, weekOffset: 0, routine: { name: 'Upper A', session_type: 'strength' } }), 'flag on: not on a lifting card')
// "Log outside the plan" is exactly the old condition, and log_session_v1 is not an input to it.
for (const arcLoad of [false, true]) for (const weekOffset of [-1, 0, 1]) for (const liveCount of [0, 1, 3]) {
  ok(outsidePlanEntryVisible({ arcLoad, weekOffset, liveCount }) === (arcLoad && weekOffset === 0 && liveCount > 0),
    `outside the plan: unchanged rule (arc ${arcLoad}, week ${weekOffset}, ${liveCount} sessions)`)
}

// Today wires them as above: every new surface is behind its helper and the flag.
const today = read('../screens/loop/TodayScreen.tsx')
ok(/addSessionVisible\(\{ flagOn: logSessionOn\(\), weekOffset: wOffset \}\) &&/.test(today), 'Today: "Add session" renders only through addSessionVisible(logSessionOn())')
ok(/outsidePlanEntryVisible\(\{ arcLoad: arcLoadOn\(\), weekOffset: wOffset, liveCount: liveList\.length \}\)/.test(today), 'Today: "Log outside the plan" keeps arc_load_v1\'s rule')
ok(/onLogSession=\{logThisSessionVisible\(\{ flagOn: logSessionOn\(\)[^\n]*\n\s*\? [^\n]*\n\s*: undefined\}/.test(today), 'Today: "Log this session" is undefined (no button) unless the flag is on')
ok(/const actions = logAction \? <>\{planActions\}\{logAction\}<\/> : planActions/.test(today), 'Today: without it the sheet\'s actions are exactly the plan\'s')
ok((today.match(/<SportSessionSheet/g) ?? []).length === 1 && /\{sportSheet && \(/.test(today), 'Today: the sheet opens only from those two entries')
const history = read('../screens/loop/HistoryScreen.tsx')
ok(/if \(!sportOn\) return null/.test(history) && /sportOn \? `sport-logs:/.test(history), 'History: flag off, no sport fetch and every card as before')

// ---- the queued row -----------------------------------------------------------------
const fields = { activity: 'Basketball', date: TODAY, duration_min: 25, session_rpe: 6, pain: [{ region: 'knee', score: 4, red_flags: [] }], notes: 'two games' }
const offPlan = buildSportLogPending({ id: 'q-1', athleteId: 'a', athleteName: null, fields, plannedRoutineId: null, today: TODAY, queuedAt: '2026-11-13T20:00:00Z', now: new Date('2026-11-13T20:00:00Z') })
ok(offPlan.routineId === '' && offPlan.outsidePlan?.activity === 'Basketball', 'queued off-plan: no routine, outsidePlan set — fills no planned slot while it waits')
ok(offPlan.sportLog?.pain[0].score === 4 && offPlan.sessionRpe === 6 && offPlan.rpe === null && offPlan.durationMins === 25, 'queued: pain and session RPE travel with the row; set RPE stays null')
ok(offPlan.performedAt === '2026-11-13T20:00:00.000Z', 'queued: today is now')
const fromCard = buildSportLogPending({ id: 'q-2', athleteId: 'a', athleteName: null, fields, plannedRoutineId: 'r-thu', today: TODAY, queuedAt: '2026-11-13T20:00:00Z' })
ok(fromCard.routineId === 'r-thu' && fromCard.outsidePlan == null && fromCard.sportLog?.plannedRoutineId === 'r-thu', 'queued from a card: carries the card (the Worker decides if it closes it)')
const body = sportLogBody(fromCard)
ok(body?.action === 'log' && body.client_key === 'q-2' && body.session_id === 'r-thu' && body.duration_min === 25 && body.session_rpe === 6, 'commit body: idempotent on the outbox id, with the planned link')
ok(sportLogBody(offPlan)?.session_id === undefined, 'commit body: off-plan sends no planned link')
ok(sportLogBody({ ...offPlan, sportLog: undefined }) === null, 'commit body: a normal session is not a sport log')

// ---- flag off: no new outbox / queue behavior -----------------------------------------------
// Only a sport log (which only exists with the flag on) takes the new paths.
const engine = read('./index.ts')
ok(/export async function commitSession\(p: PendingSession\): Promise<CommitResult> \{\n {2}\/\/ log_session_v1[^\n]*\n {2}if \(p\.sportLog\) \{/.test(engine), 'commitSession: the new path runs only for a sportLog row')
const outbox = read('../lib/workoutOutbox.ts')
ok(/if \(!entry\?\.session\.sportLog\) return false/.test(outbox), 'outbox: the one-row discard only touches a sport log')
ok(!/sessionRpeQueue|enqueueTap/.test(read('./sportLogPending.ts') + read('../lib/sportSessionApi.ts') + read('../components/SportSessionSheet.tsx')),
  'a sport log never goes through the session-RPE tap queue (two same-day logs never share its key)')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('sport log: ok')
