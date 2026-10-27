// Standalone integrity check for the program editor's deterministic half (no
// test runner installed, same convention as demandTables.check.ts).
// Run: node --experimental-strip-types src/engine/programDraft.check.ts
//
// Proves the properties the surface is sold on:
//   · additive by default — an "add jumps" turn adds and drops NOTHING else
//     (the churn that made the old rebuild useless: +6 / −5 for no net change)
//   · edits stack across turns instead of re-rolling the week
//   · a new session raises training days, or it would never come up on Train
//   · bounds hold: sets, exercises per session, sessions, RPE, loads
//   · a removal only happens when a removal was asked for
//   · the minute estimate moves in the direction volume moves

import { readFileSync } from 'node:fs'
import {
  applyEditsToDraft, diffDraft, estimateSessionMinutes, summarizeEdit, mergePreferences,
  MAX_EXERCISES_PER_SESSION, MAX_SETS,
  type ProgramDraft,
} from './programDraft.ts'
import type { ProgramEdit } from './agentClient.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// An edit with every field nulled — the shape the model actually returns.
function edit(e: Partial<ProgramEdit> & { type: ProgramEdit['type'] }): ProgramEdit {
  return {
    rationale: 'because',
    session_name: null, exercise_name: null, after_exercise: null,
    set_name: null, set_intent: null, set_session_type: null, set_intended_dow: null,
    sets: null, reps: null, load: null, cue: null, target_rpe: null,
    sessions_per_week: null, note: null, exercises: [],
    ...e,
  }
}

const base: ProgramDraft = {
  sessionsPerWeek: 3,
  sessions: [
    {
      routineId: 'r1', name: 'Session A', intent: 'Lower', sessionType: 'strength', intendedDow: 0,
      exercises: [
        { name: 'Squat (no belt)', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
        { name: 'Romanian Deadlift', sets: 3, reps: '8', load: 'moderate' },
      ],
    },
    {
      routineId: 'r2', name: 'Session B', intent: 'Upper', sessionType: 'strength', intendedDow: 2,
      exercises: [
        { name: 'Bench press', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
        { name: 'Chin-up', sets: 3, reps: '6', load: 'bodyweight' },
      ],
    },
  ],
}

// ---- additive by default ---------------------------------------------------

const addJumps = applyEditsToDraft(base, [
  edit({ type: 'add_exercise', session_name: 'Session A', exercise_name: 'Box Jump', sets: 4, reps: '3', load: 'bodyweight', after_exercise: 'Squat (no belt)' }),
  edit({ type: 'add_exercise', session_name: 'Session B', exercise_name: 'Depth Jump', sets: 3, reps: '3', load: 'bodyweight' }),
])
ok(addJumps.outcomes.every((o) => o.applied), 'both jump additions should apply')
const jumpDiff = diffDraft(base, addJumps.draft)
ok(jumpDiff.added === 2, `expected +2, got +${jumpDiff.added}`)
ok(jumpDiff.removed === 0, `additive edit dropped ${jumpDiff.removed} exercises`)
ok(jumpDiff.changed === 0, `additive edit retuned ${jumpDiff.changed} exercises`)
ok(jumpDiff.mainLiftsDropped.length === 0, 'no main lift may vanish from an addition')
ok(jumpDiff.dirty, 'an addition must read as dirty')

// Placement honours the anchor: Box Jump lands right after the squat.
const aNames = addJumps.draft.sessions[0].exercises.map((e) => e.name)
ok(aNames[1] === 'Box Jump', `anchor ignored: ${aNames.join(', ')}`)

// The metric is resolved by code, never by the model.
ok(addJumps.draft.sessions[0].exercises[1].tracking_type === 'bodyweight_reps',
  'box jump should resolve to bodyweight_reps')

// ---- edits stack across turns ----------------------------------------------

const turn2 = applyEditsToDraft(addJumps.draft, [
  edit({ type: 'add_exercise', session_name: 'Session A', exercise_name: 'Nordic Curl', sets: 3, reps: '5', load: 'bodyweight' }),
])
const stacked = diffDraft(base, turn2.draft)
ok(stacked.added === 3, `turn 2 should stack on turn 1 (+3), got +${stacked.added}`)
ok(stacked.removed === 0, 'stacking must not churn earlier turns')

// ---- a new session raises training days ------------------------------------

const withSession = applyEditsToDraft(base, [
  edit({
    type: 'add_session', session_name: 'Bounce', set_intent: 'Explosive work', set_session_type: 'power', set_intended_dow: 4,
    exercises: [
      { name: 'Broad Jump', sets: 4, reps: '3', load: 'bodyweight', cue: 'Land quiet', target_rpe: 7 },
      { name: 'Jump Rope', sets: 3, reps: '60s', load: 'bodyweight', cue: 'Stay tall', target_rpe: null },
    ],
  }),
])
ok(withSession.outcomes[0].applied, 'add_session should apply')
ok(withSession.draft.sessions.length === 3, 'the week should carry a third session')
ok(withSession.draft.sessionsPerWeek === 3, 'days/week must cover the new session count')
const sessDiff = diffDraft(base, withSession.draft)
ok(sessDiff.newSessions === 1, `expected 1 new session, got ${sessDiff.newSessions}`)
ok(sessDiff.sessions[2].isNew, 'the added session must read as new')

// With 4 sessions and 3 days/week, days/week has to move or the 4th never shows.
const fourth = applyEditsToDraft(withSession.draft, [
  edit({
    type: 'add_session', session_name: 'Engine', set_session_type: 'conditioning',
    exercises: [{ name: 'Assault Bike', sets: 6, reps: '30s', load: 'moderate', cue: 'Hard', target_rpe: 9 }],
  }),
])
ok(fourth.draft.sessionsPerWeek === 4, `days/week should follow session count, got ${fourth.draft.sessionsPerWeek}`)

// ---- interval blocks land where the timer reads them ----------------------
// Over MCP, a free-text coach wrote the dose into the name and "8 rounds" into
// reps, so the app saw a lift. Code puts it back in the canonical shape.

const finisher = applyEditsToDraft(base, [
  edit({
    type: 'add_exercise', session_name: 'Session A', exercise_name: 'Bike finisher 8x(15s hard / 45s easy)',
    sets: 1, reps: '8 rounds', load: 'moderate',
  }),
])
const finExs = finisher.draft.sessions[0].exercises
const fin = finExs[finExs.length - 1]
ok(fin.name === 'Bike finisher', `the block's name is the movement, got "${fin.name}"`)
ok(fin.reps === '8 × 15s on / 45s off', `the dose moves to reps, got "${fin.reps}"`)
ok(fin.tracking_type === 'time', `a block logs as time, got ${fin.tracking_type}`)
ok(fin.load === 'bodyweight', `a block has no weight to find, got ${fin.load}`)

const engineDay = applyEditsToDraft(base, [
  edit({
    type: 'add_session', session_name: 'Engine', set_session_type: 'conditioning',
    exercises: [{ name: 'Assault Bike Tabata', sets: 1, reps: '1', load: 'heavy', cue: 'All out', target_rpe: 9 }],
  }),
])
ok(engineDay.draft.sessions[engineDay.draft.sessions.length - 1].exercises[0].reps === '8 × 20s on / 10s off',
  'a Tabata named in an add_session lands as its spec')

const straight = applyEditsToDraft(base, [
  edit({ type: 'add_exercise', session_name: 'Session A', exercise_name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' }),
])
const straightExs = straight.draft.sessions[0].exercises
ok(straightExs[straightExs.length - 1].reps === '30s', 'straight sets are left exactly as written')

// An 8 × 20s on / 40s off block is about eight minutes, not one set of twenty seconds.
const blockMins = estimateSessionMinutes([{ name: 'Assault Bike', sets: 1, reps: '8 × 20s on / 40s off' }])
ok(blockMins >= 15 && blockMins <= 17, `warm-up + an 8-minute block + transition ≈ 16 min, got ${blockMins}`)

// ---- bounds ----------------------------------------------------------------

const clamped = applyEditsToDraft(base, [
  edit({ type: 'add_exercise', session_name: 'Session A', exercise_name: 'Calf Raise', sets: 99, reps: '15', load: 'nonsense', target_rpe: 42 }),
])
const clampedExs = clamped.draft.sessions[0].exercises
const added = clampedExs[clampedExs.length - 1]
ok(added.sets === MAX_SETS, `sets should clamp to ${MAX_SETS}, got ${added.sets}`)
ok(added.load === undefined, 'an unknown load must be dropped, not passed through')
ok(added.target_rpe === 10, `RPE should clamp to 10, got ${added.target_rpe}`)

const packed = applyEditsToDraft(base, Array.from({ length: 20 }, (_, i) =>
  edit({ type: 'add_exercise', session_name: 'Session A', exercise_name: `Filler ${i}`, sets: 2, reps: '10', load: 'light' })))
ok(packed.draft.sessions[0].exercises.length === MAX_EXERCISES_PER_SESSION,
  `session should cap at ${MAX_EXERCISES_PER_SESSION}, got ${packed.draft.sessions[0].exercises.length}`)
ok(packed.outcomes.some((o) => !o.applied && (o.reason ?? '').includes('already at')),
  'the overflow must be reported, never silently dropped')

// ---- removals only on request ----------------------------------------------

const removal = applyEditsToDraft(base, [
  edit({ type: 'remove_exercise', session_name: 'Session A', exercise_name: 'Squat' }),
])
ok(removal.outcomes[0].applied, 'an explicit removal should apply (fuzzy name match)')
const remDiff = diffDraft(base, removal.draft)
ok(remDiff.removed === 1, `expected −1, got −${remDiff.removed}`)
ok(remDiff.mainLiftsDropped.includes('Squat (no belt)'), 'dropping the squat must raise the main-lift alarm')

const emptied = applyEditsToDraft(
  { sessionsPerWeek: 1, sessions: [{ routineId: 'r9', name: 'Solo', intent: '', sessionType: 'strength', intendedDow: null, exercises: [{ name: 'Plank', sets: 3, reps: '30s' }] }] },
  [edit({ type: 'remove_exercise', session_name: 'Solo', exercise_name: 'Plank' })],
)
ok(!emptied.outcomes[0].applied, 'a session may never be emptied to nothing')

// ---- misses are reported, not guessed --------------------------------------

const missed = applyEditsToDraft(base, [
  edit({ type: 'add_exercise', session_name: 'Session Z', exercise_name: 'Sled Push', sets: 3, reps: '20', load: 'heavy' }),
  edit({ type: 'update_exercise', session_name: 'Session A', exercise_name: 'Overhead Press', sets: 5 }),
])
ok(missed.outcomes.every((o) => !o.applied), 'edits against things that do not exist must not apply')
ok(missed.outcomes.every((o) => !!o.reason), 'every skipped edit needs a stated reason')
ok(!diffDraft(base, missed.draft).dirty, 'a fully-skipped turn leaves the draft clean')

// ---- retuning --------------------------------------------------------------

const retuned = applyEditsToDraft(base, [
  edit({ type: 'update_exercise', session_name: 'Session B', exercise_name: 'Bench press', sets: 5, reps: '3', load: 'heavy', target_rpe: 9 }),
])
const retDiff = diffDraft(base, retuned.draft)
ok(retDiff.changed === 1 && retDiff.added === 0 && retDiff.removed === 0,
  `a retune is a change, not a swap (+${retDiff.added} −${retDiff.removed} ~${retDiff.changed})`)

// A rename is not a new session.
const renamed = applyEditsToDraft(base, [
  edit({ type: 'update_session', session_name: 'Session A', set_name: 'Lower — Bounce' }),
])
const renDiff = diffDraft(base, renamed.draft)
ok(renDiff.newSessions === 0, 'renaming a session must not read as adding one')
ok(renDiff.sessions[0].previousName === 'Session A', 'a rename should show what it was')
ok(renDiff.dirty, 'a rename is a real change')

// ---- days/week on its own --------------------------------------------------

const days = applyEditsToDraft(base, [edit({ type: 'set_sessions_per_week', sessions_per_week: 5 })])
ok(days.draft.sessionsPerWeek === 5, 'days/week should follow an explicit request')
ok(diffDraft(base, days.draft).dirty, 'a days/week change alone is still a change')

// ---- time estimate ---------------------------------------------------------

const shortSession = estimateSessionMinutes(base.sessions[0].exercises)
const longSession = estimateSessionMinutes(addJumps.draft.sessions[0].exercises)
ok(longSession > shortSession, 'adding work must raise the estimate')
ok(shortSession > 8 && shortSession < 120, `estimate out of plausible range: ${shortSession}`)
ok(estimateSessionMinutes([]) === 0, 'an empty session estimates at zero')

// ---- labels ----------------------------------------------------------------

ok(summarizeEdit(edit({ type: 'add_exercise', session_name: 'Session A', exercise_name: 'Box Jump' })).includes('Box Jump'),
  'an edit label should name the movement')
ok(summarizeEdit(edit({ type: 'set_sessions_per_week', sessions_per_week: 6 })).includes('6'),
  'a days/week label should name the number')

// ---- standing preferences --------------------------------------------------

ok(mergePreferences(null, ['more basketball explosiveness']) === 'more basketball explosiveness',
  'a first preference should store as-is')

const merged = mergePreferences('more basketball explosiveness', ['add a short HIIT day'])
ok(merged === 'add a short HIIT day\nmore basketball explosiveness',
  `newest first, older kept — got ${JSON.stringify(merged)}`)

ok(mergePreferences('Add jumps', ['add jumps']) === 'add jumps',
  'a repeated ask should not stack up twice')

const many = mergePreferences(
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'),
  ['newest'],
)!
ok(many.split('\n').length === 6, `the list should cap at 6, got ${many.split('\n').length}`)
ok(many.split('\n')[0] === 'newest', 'the newest ask should lead')

ok(mergePreferences(null, ['   ']) === null, 'blank input should not create a preference')

// ---- report ----------------------------------------------------------------

// ---- drift guard ----------------------------------------------------------------
{
  // The edge function and the Worker apply edits with a copy; it may differ only
  // in its type imports. A drifted copy would read a block one way on the phone
  // and write it another way over MCP.
  const strip = (t: string) => t.replace(/^import type \{[^}]*\} from '[^']*'\n/gm, '')
  const here = readFileSync(new URL('./programDraft.ts', import.meta.url), 'utf8')
  const copy = readFileSync(new URL('../../supabase/functions/_shared/engine/programDraft.ts', import.meta.url), 'utf8')
  ok(strip(here) === strip(copy), 'supabase/functions/_shared/engine/programDraft.ts is in sync with src/engine/programDraft.ts')
}

if (fails.length) {
  console.error(`programDraft.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`programDraft.check: ${checks} checks passed`)
