// Skill blocks vs intervals (spec §12, skill_blocks_v1). Synthetic sessions only.
// Run: node --experimental-strip-types src/engine/skillBlock.check.ts
//
// The properties that matter:
//
//   · repro: a basketball finishing station written with loose work/rest times
//     ("6 × 10s / 50s") never gets the interval timer with the flag on; the
//     athlete taps Done / Next
//   · counter: a real HIIT / Tabata block still runs on the auto-advancing timer
//   · a mixed session uses the skill UI for the station and the timer for the
//     conditioning after it
//   · suggested window and rest are copy: nothing in the clocks advances anything
//   · flag off: every exercise reads exactly as before
//   · coach edits carry the kind only when sent, and diff the same otherwise

import {
  buildTimeline, fmtDose, intervalPlanFor, isIntervalBlock, readClock,
} from './intervals.ts'
import {
  fmtSkillDose, isSkillBlock, readRest, skillDone, skillDoneLogs, skillView, STOPWATCH_IDLE,
  stopwatchSeconds, toggleStopwatch,
} from './skillBlock.ts'
import { isSetLogged, tallySession } from './volume.ts'
import { applyEditsToDraft, type ProgramDraft } from './programDraft.ts'
import { describePrescription } from './weekDiff.ts'
import type { ExerciseTemplate, SetLog } from '../types/database.ts'
import type { ProgramEdit } from './agentClient.ts'
import { readFileSync } from 'node:fs'

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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const ex = (name: string, reps: string, sets = 1, extra: Partial<ExerciseTemplate> = {}): ExerciseTemplate =>
  ({ name, reps, sets, ...extra })
const blank = (set: number): SetLog => ({ set, weight: null, reps: null, rpe: null, done: false, duration: null, distance: null })

// ---- 1. repro: the finishing station -------------------------------------------------------------
// What happened on court: a skill block written as interval syntax ran the
// HIIT timer. Untagged, by name, and tagged by the coach.

const finishing = ex('Finishing — layups', '6 × 10s / 50s')
ok(intervalPlanFor(finishing) != null, 'flag off: the finishing station still reads as a block (exactly as before)')
eq(intervalPlanFor(finishing, true), null, 'flag on: a finishing station never gets the interval timer')
ok(isSkillBlock(finishing), 'a finishing station is a skill block')

const tagged = ex('Court station', '6 × 10s / 50s', 1, { kind: 'skill', window_s: 480, rest_s: 45, cue: 'Skip if the knee talks. Miss = one extra.' })
eq(intervalPlanFor(tagged, true), null, 'flag on: kind "skill" never launches the timer, whatever the reps say')
ok(intervalPlanFor(tagged) != null, 'flag off: the kind is ignored')

for (const [why, e] of [
  ['makes', ex('Mikan drill', '6 makes · 10s on / 50s off')],
  ['possessions', ex('Half court', '8 possessions, 30s on / 30s off')],
  ['per side', ex('Lateral bound stick', '4/side 10s on / 20s off')],
  ['per side, spelled', ex('Crossover series', '5 per side 20s on / 40s off')],
  ['each hand', ex('Wall dribble', '3 x 20s on / 10s off each hand')],
  ['technique', ex('Jab technique', '6 × 30s / 30s')],
  ['shooting', ex('Free throw shooting', '10 × 15s / 45s')],
] as const) {
  ok(intervalPlanFor(e) != null, `${why}: parses as a block with the flag off (the bug as shipped)`)
  eq(intervalPlanFor(e, true), null, `${why}: no interval timer with the flag on`)
  ok(!isIntervalBlock(e, true), `${why}: not an interval block with the flag on`)
}

// ---- 2. counter: real conditioning still runs on the clock ---------------------------------------

const conditioning: ExerciseTemplate[] = [
  ex('Assault Bike', '8 × 20s on / 10s off'),
  ex('Assault Bike', 'Tabata'),
  ex('Rower', 'EMOM 10 min'),
  ex('Bike finisher 8x(15s hard / 45s easy)', '8 rounds'),
  ex('Suicides', '6 × 30s on / 60s off'),
  ex('Assault Bike', '10 x 30/30'),
  ex('Shooting conditioning — Tabata', 'Tabata'),     // named protocol beats the skill word
  ex('Finishing', '6 × 10s / 50s', 1, { kind: 'interval' }), // the coach's tag beats the name
]
for (const e of conditioning) {
  const off = intervalPlanFor(e)
  const on = intervalPlanFor(e, true)
  ok(on != null, `counter: "${e.name}" / "${e.reps}" still launches the interval timer`)
  ok(same(on, off), `counter: "${e.name}" runs the identical plan with the flag on`)
}
// The beep advances: the clock moves from work to rest to the next round on its own.
const tabata = intervalPlanFor(ex('Assault Bike', 'Tabata'), true)!
const line = buildTimeline(tabata)
const r1 = readClock(line, 5 + 1)    // ready beat is 5s
const r2 = readClock(line, 5 + 21)
const r3 = readClock(line, 5 + 31)
ok(r1.phase.kind === 'work' && r1.phase.round === 1, 'Tabata: round 1 work')
ok(r2.phase.kind === 'rest', 'Tabata: the clock moves on to rest by itself')
ok(r3.phase.kind === 'work' && r3.phase.round === 2, 'Tabata: and on to round 2 by itself')

// ---- 3. a mixed session -------------------------------------------------------------------------

const mixed: ExerciseTemplate[] = [
  ex('Finishing — layups', '6 × 10s / 50s', 1, { kind: 'skill', window_s: 480, rest_s: 45 }),
  ex('Suicides', '6 × 30s on / 60s off'),
]
const ui = (e: ExerciseTemplate, flag: boolean) =>
  flag && isSkillBlock(e) ? 'skill' : intervalPlanFor(e, flag) ? 'interval' : 'sets'
eq(ui(mixed[0], true), 'skill', 'mixed: the station gets the skill UI')
eq(ui(mixed[1], true), 'interval', 'mixed: the conditioning after it gets the interval timer')
// Train's "Start intervals" runs the first block still to run: the suicides, not the station.
eq(mixed.findIndex((e) => intervalPlanFor(e, true) != null), 1, 'mixed: Start intervals goes to the conditioning, not the station')
eq(mixed.findIndex((e) => intervalPlanFor(e) != null), 0, 'mixed, flag off: exactly as before (the station first)')

// ---- 4. the station: target, advisory time, Done / Next -----------------------------------------

const v = skillView(ex('Finishing — layups', '6 makes', 1, { kind: 'skill', window_s: 480, rest_s: 45, cue: 'Skip if the knee talks. Miss = one extra.' }))
eq(v.target, '6 makes', 'target is the quality count')
eq(v.window, '~8 min', 'suggested window as copy')
eq(v.rest, '~45s', 'suggested rest as copy')
eq(v.cue, 'Skip if the knee talks. Miss = one extra.', 'quality notes stay on the cue')
eq(skillView(ex('Crossover series', '4/side', 3)).target, '3 × 4/side', 'sets ahead of the target')
const bare = skillView(ex('Footwork', '8 possessions'))
ok(bare.window === null && bare.rest === null, 'no suggestion written, none shown')
eq(fmtSkillDose(ex('Finishing', '6 makes', 1, { window_s: 480 })), '6 makes · ~8 min', 'one-line dose')
eq(fmtDose(ex('Finishing', '6 × 10s / 50s', 1, { kind: 'skill', window_s: 90 }), true), '6 × 10s / 50s · ~1:30', 'fmtDose on a station with the flag on')
eq(fmtDose(ex('Finishing', '6 × 10s / 50s', 1, { kind: 'skill' })), '6 × 10s / 50s', 'fmtDose flag off: as before (the interval read)')

// The clocks the athlete owns: count-up and rest. Past the suggestion they say
// so; neither reaches the next exercise — there is no "advance" anywhere in them.
let w = toggleStopwatch(STOPWATCH_IDLE, 1_000)
eq(stopwatchSeconds(w, 61_000), 60, 'elapsed counts up from the athlete\'s tap')
w = toggleStopwatch(w, 61_000)
eq(stopwatchSeconds(w, 999_000), 60, 'paused, it holds')
eq(stopwatchSeconds(w, 10_000_000), 60, 'and holds forever — no cutover')
const rest = readRest(0, 45, 600_000)
ok(rest.pastSuggestion && rest.elapsed === 600, 'rest past ~45s only says so, ten minutes later still the same station')
ok(same(Object.keys(rest).sort(), ['elapsed', 'pastSuggestion']), 'the rest read has nothing that advances')
ok(!readRest(0, null, 600_000).pastSuggestion, 'no suggestion, never "past" it')

// Done / Next logs complete; session RPE is the session's, taken where it always is.
const before = [blank(1)]
ok(!skillDone(before), 'not done before the tap')
const after = skillDoneLogs(before, 1, blank)
ok(skillDone(after) && after.every(isSetLogged), 'Done marks the station complete')
ok(after.every((r) => r.weight == null && r.reps == null && r.duration == null && r.rpe == null), 'nothing but complete is claimed (no makes vs attempts)')
eq(tallySession({ 0: after }).loggedSets, 1, 'counts as a logged set for the session')
eq(skillDoneLogs([], 3, blank).length, 3, 'a three-round station marks three rows')

// ---- 5. flag off: unchanged ---------------------------------------------------------------------

const corpus: ExerciseTemplate[] = [
  ...conditioning, ...mixed, finishing, tagged,
  ex('Back Squat', '5', 3), ex('Bulgarian Split Squat', '10/10', 3), ex('Plank', '30s', 3),
  ex('Tempo Squat', '5 (3s down, 1s pause)', 3), ex('Mikan drill', '6 makes'),
]
for (const e of corpus) {
  ok(same(intervalPlanFor(e), intervalPlanFor(e, false)), `flag off: "${e.name}" plan identical`)
  eq(fmtDose(e, false), fmtDose(e), `flag off: "${e.name}" dose identical`)
}
// Straight sets are straight sets either way.
for (const e of [ex('Back Squat', '5', 3), ex('Bulgarian Split Squat', '10/10', 3), ex('Plank', '30s', 3)]) {
  ok(intervalPlanFor(e, true) == null && !isSkillBlock(e), `straight sets: "${e.name}" untouched`)
}

// ---- 6. coach edits carry the kind ---------------------------------------------------------------

const draft: ProgramDraft = {
  sessionsPerWeek: 3,
  sessions: [{ routineId: 'r1', name: 'Court', intent: '', sessionType: 'conditioning', intendedDow: 1, exercises: [ex('Back Squat', '5', 3)] }],
}
const edit = (over: Partial<ProgramEdit>): ProgramEdit => ({
  type: 'add_exercise', rationale: '', session_name: 'Court', exercise_name: 'Finishing — layups', after_exercise: null,
  set_name: null, set_intent: null, set_session_type: null, set_intended_dow: null, sets: 1, reps: '6 makes',
  load: 'bodyweight', cue: 'Miss = one extra.', target_rpe: null, sessions_per_week: null, note: null, exercises: [], ...over,
})
const plain = applyEditsToDraft(draft, [edit({})]).draft.sessions[0].exercises[1]
ok(!('kind' in plain) && !('window_s' in plain), 'no kind sent: the exercise is written exactly as before')
const skilled = applyEditsToDraft(draft, [edit({ kind: 'skill', window_s: 480, rest_s: 45 })]).draft.sessions[0].exercises[1]
ok(skilled.kind === 'skill' && skilled.window_s === 480 && skilled.rest_s === 45, 'kind, window and rest written')
const retag = applyEditsToDraft(draft, [edit({ type: 'update_exercise', exercise_name: 'Back Squat', sets: null, reps: null, load: null, cue: null, kind: 'interval' })])
ok(retag.outcomes[0].applied && retag.draft.sessions[0].exercises[0].kind === 'interval', 'update_exercise can set the kind alone')
eq(describePrescription(ex('Back Squat', '5', 3, { load: 'heavy' })), '3×5 · heavy', 'untagged prescriptions describe as before')
eq(describePrescription(skilled), '1×6 makes · bodyweight · RPE 1 · skill block ~480s', 'a tagged station says so in the diff')

// ---- drift guard ----------------------------------------------------------------
{
  // intervals.ts imports this module, and the edge function / Worker copy of it
  // imports theirs: the copy may differ only in its type imports.
  const strip = (t: string) => t.replace(/^import type \{[^}]*\} from '[^']*'\n/gm, '')
  const here = readFileSync(new URL('./skillBlock.ts', import.meta.url), 'utf8')
  const copy = readFileSync(new URL('../../supabase/functions/_shared/engine/skillBlock.ts', import.meta.url), 'utf8')
  ok(strip(here) === strip(copy), 'supabase/functions/_shared/engine/skillBlock.ts is in sync with src/engine/skillBlock.ts')
}

if (fails.length) {
  console.error(`${fails.length} of ${checks} checks failed:`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`${checks} checks, 0 failed`)
console.log('skillBlock: ok')
