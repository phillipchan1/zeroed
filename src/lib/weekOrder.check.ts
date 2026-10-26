// Standalone check for the week-list ordering.
// Run: node --experimental-strip-types src/lib/weekOrder.check.ts
//
// The bug this stops: the list was alphabetical (Fri, Mon, Thu, Tue, Wed) because
// unpinned sessions all tied and fell back to name order.

import { orderByPlannedDay, dayFromName } from './weekOrder.ts'

let failed = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) { failed++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}

const names = [
  'Fri Bench Power + Hypertrophy Support',
  'Mon Power- Lower/Split',
  'Thu OHP Power + Basketball Intervals',
  'Tue Bench Strength + Row',
  'Wed Deadlift Power + Posterior Chain Volume',
]
const none = () => null

eq('unpinned, day-named sessions run Mon → Fri',
  orderByPlannedDay(names.map((name) => ({ name })), none).map((r) => r.name.slice(0, 3)),
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

eq('a pinned day beats the name',
  orderByPlannedDay([{ name: 'Mon A' }, { name: 'Tue B' }], (r) => (r.name === 'Mon A' ? 6 : null)).map((r) => r.name),
  ['Tue B', 'Mon A'])

eq('sessions with no day follow the dated ones, in name order',
  orderByPlannedDay([{ name: 'Zebra' }, { name: 'Alpha' }, { name: 'Fri X' }], none).map((r) => r.name),
  ['Fri X', 'Alpha', 'Zebra'])

eq('Monster is not Monday', dayFromName('Monster Carries'), null)
eq('Full day names count', dayFromName('Thursday Lower'), 3)
eq('Sat', dayFromName('Sat Long Run'), 5)
eq('No day', dayFromName('Upper A'), null)

eq('projected sessions sort Mon → Sun by planned day',
  orderByPlannedDay(
    [
      { name: 'Fri Speed Bench', intended_dow: 4 },
      { name: 'Mon Lower', intended_dow: 0 },
      { name: 'Wed Posterior', intended_dow: 2 },
    ],
    (r) => r.intended_dow,
  ).map((r) => r.name.slice(0, 3)),
  ['Mon', 'Wed', 'Fri'])

eq('name-led days fill in when intended_dow is missing',
  orderByPlannedDay(
    [{ name: 'Thu OHP' }, { name: 'Tue Bench' }, { name: 'Sun Easy' }],
    () => null,
  ).map((r) => r.name.slice(0, 3)),
  ['Tue', 'Thu', 'Sun'])

if (failed) { console.error(`${failed} failed`); process.exit(1) }
console.log('weekOrder.check: ok')
