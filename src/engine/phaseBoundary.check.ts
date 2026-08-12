// Standalone integrity check for phase-boundary dates (no test runner
// installed, same convention as loggedSets.check.ts).
// Run: node --experimental-strip-types src/engine/phaseBoundary.check.ts
//
// The property under test is the one that was silently false on 2026-08-11:
// A BLOCK MUST START ON A MONDAY AND END ON A SUNDAY.
//
// It matters because phase advancement fires on the first app open once
// `today >= week_end`. A block that ends mid-week therefore advances mid-week,
// splitting the athlete's week across two phases — and the new block, stamped
// with `today` as its week_start, ends mid-week too. One mid-week start in the
// past keeps re-infecting every block after it, which is exactly how a Stability
// block that began on a Wednesday in July handed a Tuesday end date to the block
// that replaced a real training week with a template one in August.

import {
  sundayOnOrAfterISO, addDaysISO, nextMondayISO, startOfWeekMonday, weekEndingISO, isoDate,
} from './weekDates.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const dow = (iso: string) => new Date(`${iso}T12:00:00`).getDay() // 0 = Sunday, 1 = Monday

// ---- sundayOnOrAfterISO snaps any day to the Sunday that ends its week ------

// 2026-08-10 is a Monday, so 08-10 … 08-16 all belong to the week ending 08-16.
const MONDAY = '2026-08-10'
for (let i = 0; i < 7; i++) {
  const day = addDaysISO(MONDAY, i)
  ok(sundayOnOrAfterISO(day) === '2026-08-16',
    `${day} should snap to the Sunday 2026-08-16, got ${sundayOnOrAfterISO(day)}`)
}

// A Sunday is already a Sunday — snapping must not push it out a whole week.
ok(sundayOnOrAfterISO('2026-08-16') === '2026-08-16', 'a Sunday must snap to itself')
ok(sundayOnOrAfterISO(sundayOnOrAfterISO('2026-08-12')) === sundayOnOrAfterISO('2026-08-12'),
  'snapping must be idempotent')

// The real regression: the Tuesday end date that let a block expire mid-week.
ok(dow(sundayOnOrAfterISO('2026-08-11')) === 0, 'a Tuesday end date must become a Sunday')

// ---- a Monday-anchored block ends on a Sunday ------------------------------

// generatePhase runs week_end = start + (PHASE_LENGTH_DAYS - 1), i.e. +27. That
// only lands on a Sunday if the start is a Monday, which is why the boundary has
// to anchor rather than stamp `today`.
const PHASE_LENGTH_DAYS = 28
ok(dow(addDaysISO(MONDAY, PHASE_LENGTH_DAYS - 1)) === 0,
  'a 28-day block anchored to Monday must end on a Sunday')

// The shape of the bug, pinned: the Tuesday start that actually shipped ends on
// a Monday, so the block expires mid-week and advancement fires mid-week.
ok(dow(addDaysISO('2026-08-11', PHASE_LENGTH_DAYS - 1)) !== 0,
  'a mid-week start cannot produce a Sunday end — if this ever passes, the anchor is moot')

// ---- startOfWeekMonday / weekEndingISO agree on the same week --------------

// The week containing the incident: Mon 2026-08-10 → Sun 2026-08-16. Phil logged
// on the Monday; the swap landed on the Tuesday and hid it.
for (const d of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-16']) {
  const mon = startOfWeekMonday(new Date(`${d}T12:00:00`))
  ok(isoDate(mon) === MONDAY, `${d} belongs to the week starting ${MONDAY}, got ${isoDate(mon)}`)
  ok(weekEndingISO(mon) === '2026-08-16', `${d}'s week must end 2026-08-16, got ${weekEndingISO(mon)}`)
  ok(dow(weekEndingISO(mon)) === 0, 'weekEndingISO must always return a Sunday')
}

// ---- nextMondayISO always lands on a Monday --------------------------------

for (const d of ['2026-08-10', '2026-08-12', '2026-08-16', '2026-01-01']) {
  const m = nextMondayISO(new Date(`${d}T12:00:00`))
  ok(dow(m) === 1, `nextMondayISO(${d}) must be a Monday, got ${m}`)
  ok(m > d, `nextMondayISO(${d}) must be in the future, got ${m}`)
}

// ---- report ----------------------------------------------------------------

if (fails.length) {
  console.error(`phaseBoundary.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`phaseBoundary.check: ${checks} checks passed`)
