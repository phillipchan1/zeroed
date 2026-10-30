// Standalone integrity check for the set logger's write path.
// Run: node --experimental-strip-types src/engine/setLogger.check.ts
//
// The property under test: what the athlete typed is what gets logged.
// A stale React closure used to apply each keystroke against the original
// empty row, so "225 then 2 then check" dropped the 225 and tap-to-complete
// filled the prescribed/suggested load (240) instead.

import {
  applySetField, applySetFields, completeSetLog, revertSetAutofill,
} from './setLogger.ts'
import type { SetLog } from '../types/database.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

function blank(set = 1): SetLog {
  return { set, weight: null, reps: null, rpe: null, done: false, duration: null, distance: null }
}

const prescribed = {
  trackingType: 'weight_reps' as const,
  carry: {},
  prescribedWeight: 240,
  prescribedReps: 2,
  prescribedDuration: null,
}

// Sequential edits compose — weight then reps keeps both, even before a re-render.
const typed = applySetFields(blank(), [['weight', 225], ['reps', 2]])
ok(typed.weight === 225, 'typed 225 stays on the log after the reps keystroke')
ok(typed.reps === 2, 'typed reps land next to the typed weight')

// Completing a set that already has numbers must not replace them with the target.
const kept = completeSetLog(typed, prescribed)
ok(kept.next.weight === 225, `typed 225 must beat the 240 target, got ${kept.next.weight}`)
ok(kept.next.reps === 2, 'typed reps are kept on complete')
ok(kept.next.done === true, 'complete marks the set done')
ok(kept.autofilled.length === 0, 'nothing was autofilled over a fully typed set')

// Empty fields still one-tap from the prescription — that path is intentional.
const filled = completeSetLog(blank(), prescribed)
ok(filled.next.weight === 240 && filled.next.reps === 2, 'empty set one-tap uses the prescribed load')
ok(filled.autofilled.includes('weight') && filled.autofilled.includes('reps'), 'one-tap records what it filled')

// Carry (previous set this session) beats the prescription.
const carried = completeSetLog(blank(), { ...prescribed, carry: { weight: 175, reps: 2 } })
ok(carried.next.weight === 175, 'in-session carry beats the prescribed 240')

// The stale-closure failure mode this check exists to pin: applying reps
// against the ORIGINAL empty log drops the weight, then complete fills 240.
const stale = applySetField(blank(), 'reps', 2)
const staleDone = completeSetLog(stale, prescribed)
ok(stale.weight == null, 'a stale apply of reps has no weight — that is the bug')
ok(staleDone.next.weight === 240, 'that stale log then one-taps the prescribed 240')

// Un-check reverts only what we filled, not what the athlete typed.
const reverted = revertSetAutofill(filled.next, filled.autofilled)
ok(reverted.done === false && reverted.weight == null && reverted.reps == null, 'un-check clears autofill')
const typedReverted = revertSetAutofill(kept.next, kept.autofilled)
ok(typedReverted.weight === 225 && typedReverted.reps === 2, 'un-check leaves typed numbers')

// Backoff set: typed 175 after a 225 working set, target still 240.
const backoff = completeSetLog(
  applySetFields(blank(5), [['weight', 175], ['reps', 2]]),
  { ...prescribed, carry: { weight: 225, reps: 2 } },
)
ok(backoff.next.weight === 175, 'a typed backoff is not overwritten by carry or the target')

if (fails.length) {
  console.error(`setLogger.check: ${fails.length}/${checks} FAILED`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`setLogger.check: ${checks} checks passed`)
