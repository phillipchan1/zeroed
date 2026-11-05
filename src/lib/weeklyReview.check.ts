// The weekly review in the app (tracks_v1, G8 / U15): the week picker, the
// wording of each section, the empty week, and the wiring — the card sits
// under Program only with tracksOn(), so flag off renders exactly as before.
// Synthetic numbers only.
// Run: node --experimental-strip-types src/lib/weeklyReview.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CALL_TONE, checkinLine, complianceLine, isEmptyWeek, liftLine, liftName, painLine, sessionLoadLine, weekChoices,
  weekRangeLabel, whyLine, type LiftTrend, type WeeklyReview,
} from './weeklyReview.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const fmt = (n: number) => String(n)
const lift = (o: Partial<LiftTrend>): LiftTrend => ({
  lift: 'squat', e1rm_week: null, e1rm_prior: null, e1rm_week_method: null, e1rm_prior_method: null, change_pct: null, trend: 'no_data', down_sessions: 0, ...o,
})
const review = (o: Partial<WeeklyReview> = {}): WeeklyReview => ({
  week_start: '2026-03-02',
  week_end: '2026-03-08',
  methodology_version: 'v1.1',
  compliance: { planned: 4, logged: 3, ratio: 0.75, target: 0.8, met: false },
  priority_lifts: [lift({ e1rm_week: 262, e1rm_prior: 255, e1rm_week_method: 'rpe_chart', e1rm_prior_method: 'epley', change_pct: 2.7, trend: 'up' })],
  maintenance: [{ exercise: 'Overhead Press', held: true, why: 'Moved 95 or more at RPE ≤ 8 (U12).' }],
  pain: { regions: [{ region: 'low_back', avg: 2.5, max: 4, prior_avg: 3.5, trend: 'better' }], blocked: [], cap: 3 },
  checkins: { days: 5, sleep_avg: 7.2, stress_avg: 2.4, soreness_avg: 3, flag_days: 1 },
  session_load: { rated: 3, with_duration: 3, rating_avg: 6.3, load_au: 1140, usual_au: 900, vs_usual: 1.27 },
  call: 'hold',
  rule_refs: ['U7', 'U15'],
  why: 'Hold: compliance 75%, under the 80% target.',
  ...o,
})

// ---- picker -------------------------------------------------------------------------------------
const picks = weekChoices('2026-03-02')
ok(picks[0].key === 'this' && picks[0].week === undefined, 'picker: this week asks without a date (the Worker\'s own today)')
ok(picks[1].key === 'previous' && picks[1].week === '2026-02-23', 'picker: last week is the Monday before')
ok(weekChoices('2026-01-05')[1].week === '2025-12-29', 'picker: across a year boundary')
ok(weekRangeLabel('2026-03-02', '2026-03-08') === '2–8 Mar' && weekRangeLabel('2026-03-30', '2026-04-05') === '30 Mar – 5 Apr', 'range: same month and across months')

// ---- sections -----------------------------------------------------------------------------------
const r = review()
ok(complianceLine(r.compliance).main === '3 of 4 sessions · 75%' && complianceLine(r.compliance).target === 'target 80%', 'compliance: logged vs planned against the target')
ok(complianceLine({ planned: 0, logged: 0, ratio: null, target: 0.8, met: null }).main === 'No sessions planned', 'compliance: nothing planned')
ok(complianceLine({ planned: 1, logged: 1, ratio: 1, target: 0.8, met: true }).main === '1 of 1 session · 100%', 'compliance: singular')
const up = liftLine(r.priority_lifts[0], fmt, 'lb')
ok(up.value === 'e1RM 262 lb (RPE chart), was 255 (Epley)' && up.change === '+2.7%', 'lift: e1RM, the U4 method on each estimate, and the change')
ok(liftLine(lift({ e1rm_week: 240, e1rm_prior: 250, change_pct: -4, trend: 'down', down_sessions: 2 }), fmt, 'kg').change === '−4% · down 2 sessions running', 'lift: a drop and its run')
ok(liftLine(lift({ e1rm_week: 240, e1rm_week_method: 'epley' }), fmt, 'lb').change === 'first week on record', 'lift: no prior')
ok(liftLine(lift({ e1rm_prior: 250 }), fmt, 'lb').value.startsWith('Not trained this week'), 'lift: not trained')
ok(liftLine(lift({}), fmt, 'lb').value === 'No top sets logged', 'lift: no data')
ok(liftLine(lift({ e1rm_week: 100 }), (n) => String(Math.round(n / 2.2)), 'kg').value === 'e1RM 45 kg', 'lift: weights through the unit formatter')
ok(liftName('squat') === 'Squat' && liftName('ohp') === 'Overhead press' && liftName('front_squat') === 'Front squat', 'lift: names')
ok(painLine(r.pain!.regions[0]) === 'avg 2.5, max 4 / 10 · better (was 3.5)', 'pain: average, max and trend')
ok(checkinLine(r.checkins!) === '5 days · sleep 7.2 h, stress 2.4/5, soreness 3/5 · 1 flag day', 'check-ins: averages and flag days')
ok(checkinLine({ days: 0, sleep_avg: null, stress_avg: null, soreness_avg: null, flag_days: 0 }) === 'No check-ins', 'check-ins: none')
ok(sessionLoadLine(r.session_load!) === '1,140 AU · heavier than usual (1.27×) · 3 rated, avg 6.3/10', 'session load: against the usual')
ok(sessionLoadLine({ rated: 0, with_duration: 0, rating_avg: null, load_au: 0, usual_au: null, vs_usual: null }) === 'No sessions rated', 'session load: none')
ok(whyLine(r) === 'Compliance 75%, under the 80% target.', 'why: the chip says the call, the line says why')
ok(CALL_TONE.progress === 'done' && CALL_TONE.hold === 'pending' && CALL_TONE.deload === 'info', 'call: a tone each')

// ---- empty week ---------------------------------------------------------------------------------
ok(!isEmptyWeek(r), 'empty: a week with data is not empty')
const blank = review({
  compliance: { planned: 4, logged: 0, ratio: 0, target: 0.8, met: false },
  priority_lifts: [lift({ e1rm_prior: 250 })],
  maintenance: [{ exercise: 'Overhead Press', held: null, why: 'Not trained this week.' }],
  pain: { regions: [], blocked: [], cap: 3 },
  checkins: { days: 0, sleep_avg: null, stress_avg: null, soreness_avg: null, flag_days: 0 },
  session_load: { rated: 0, with_duration: 0, rating_avg: null, load_au: 0, usual_au: null, vs_usual: null },
})
ok(isEmptyWeek(blank), 'empty: nothing logged reads as empty')
ok(isEmptyWeek({ ...blank, pain: null, checkins: null, session_load: null, health_hidden: true }), 'empty: hidden health sections count as nothing')

// ---- wiring: flag off unchanged -------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const programSrc = readFileSync(join(here, '../screens/loop/ProgramScreen.tsx'), 'utf8')
const cardSrc = readFileSync(join(here, '../screens/loop/WeeklyReviewCard.tsx'), 'utf8')
ok(/\{tracksOn\(\) && \(\s*<Disclosure label="Weekly review">\s*<WeeklyReviewCard /.test(programSrc), 'flag off: the review renders only under tracksOn()')
ok((programSrc.match(/<WeeklyReviewCard /g) ?? []).length === 1, 'flag off: no other mount of the card')
ok(/fetchWeeklyReview\(chosen\.week\)/.test(cardSrc) && /status === 'off'/.test(cardSrc) && /<Skeleton/.test(cardSrc), 'card: fetches the picked week, with loading, off and error states')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
