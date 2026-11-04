// Run: node --experimental-strip-types src/engine/coachActions.check.ts
//
// The confirm card renders from these parts, so what has to hold is that every
// field the model can set shows up exactly once, that nothing the model did NOT
// set is invented, and that the card never gets an empty title.

import { describeCoachAction, describeCoachActionParts } from './coachActions.ts'
import type { CoachAction } from './agentClient.ts'

const fails: string[] = []
let checks = 0
function eq<T>(actual: T, expected: T, msg: string) {
  checks++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fails.push(`${msg}\n    expected ${e}\n    got      ${a}`)
}

const blank: CoachAction = {
  type: 'update_exercise', rationale: '', insight_id: null, routine_name: null, exercise_name: null,
  set_confidence: null, set_status: null, set_priority: null, set_claim: null,
  set_load: null, set_sets: null, set_reps: null, set_cue: null, set_target_rpe: null, note: null,
}

// ---- exercise ---------------------------------------------------------------------------

const ex = describeCoachActionParts({
  ...blank, routine_name: 'Lower A — Squat pattern', exercise_name: 'Back Squat',
  set_load: '205 lbs', set_sets: 4, set_reps: '5', set_target_rpe: 7, set_cue: 'Brace before you unrack.',
})
eq(ex.kind, 'exercise', 'exercise kind')
eq([ex.title, ex.subtitle], ['Back Squat', 'Lower A — Squat pattern'], 'exercise title and routine')
eq(ex.fields, [
  { label: 'Load', value: '205 lbs' }, { label: 'Sets', value: '4' },
  { label: 'Reps', value: '5' }, { label: 'Target RPE', value: '7' },
], 'every numeric field becomes a chip, in a stable order')
eq(ex.quote, { label: 'Cue', text: 'Brace before you unrack.' }, 'the cue is kept whole as the quote')

eq(describeCoachActionParts({ ...blank, exercise_name: 'Row', set_sets: 0 }).fields, [{ label: 'Sets', value: '0' }], 'a zero is a value, not an absence')
eq(describeCoachActionParts({ ...blank, exercise_name: 'Row', set_load: '40 lbs' }).fields.length, 1, 'only what was set is shown')
eq(describeCoachActionParts({ ...blank }).title, 'Exercise', 'a missing exercise name never yields an empty title')
eq(describeCoachActionParts({ ...blank, exercise_name: 'Row' }).subtitle, undefined, 'a missing routine is omitted, not "null"')

// ---- read -----------------------------------------------------------------------------------

const rd = describeCoachActionParts(
  { ...blank, type: 'update_insight', insight_id: 'ins-1', set_status: 'confirmed', set_confidence: 0.8, set_priority: 'P1', set_claim: 'Left hip folds first.' },
  { insightLabel: (id) => (id === 'ins-1' ? 'Lower Chain' : undefined) },
)
eq(rd.kind, 'read', 'read kind')
eq(rd.title, 'Lower Chain read', 'a read is named by its category when the id resolves')
eq(rd.fields, [
  { label: 'Status', value: 'confirmed' }, { label: 'Confidence', value: '80%' }, { label: 'Priority', value: 'P1' },
], 'read chips')
eq(rd.quote, { label: 'New claim', text: 'Left hip folds first.' }, 'a rewritten claim is the quote')
eq(describeCoachActionParts({ ...blank, type: 'update_insight', insight_id: 'gone', set_status: 'likely' }, { insightLabel: () => undefined }).title, 'A read', 'an unknown id falls back to a generic title')
eq(describeCoachActionParts({ ...blank, type: 'update_insight', set_status: 'likely' }).title, 'A read', 'no id and no lookup is fine')

// ---- note -----------------------------------------------------------------------------------

const nt = describeCoachActionParts({ ...blank, type: 'add_note', note: 'Single-leg leads.' })
eq([nt.kind, nt.title, nt.fields, nt.quote], ['note', 'Coach note', [], { label: 'Note', text: 'Single-leg leads.' }], 'note')
eq(describeCoachActionParts({ ...blank, type: 'add_note' }).quote, undefined, 'an empty note has no quote')

// ---- unknown type -----------------------------------------------------------------------------

eq(describeCoachActionParts({ ...blank, type: 'future_thing' as CoachAction['type'] }).title, 'Change', 'an action type this build does not know still renders')

// ---- the one-liner stays what the apply report relies on ---------------------------------------

eq(describeCoachAction({ ...blank, routine_name: 'Lower A', exercise_name: 'Back Squat', set_load: '205 lbs' }), 'Back Squat (Lower A) — load → 205 lbs', 'one-line exercise summary is unchanged')
eq(describeCoachAction({ ...blank, type: 'add_note', note: 'hi' }), 'Coach note — "hi"', 'one-line note summary is unchanged')
eq(describeCoachAction({ ...blank, type: 'update_insight', set_status: 'likely' }), 'Update read — status → likely', 'one-line read summary is unchanged')

if (fails.length) {
  console.error(`coachActions.check: ${fails.length} of ${checks} checks FAILED`)
  for (const f of fails) console.error(` ✗ ${f}`)
  process.exit(1)
}
console.log(`coachActions.check: ${checks} checks passed`)
