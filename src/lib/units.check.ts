// Standalone integrity check for the unit conversion layer (no test runner
// installed, same convention as the engine's *.check.ts files).
// Run: node --experimental-strip-types src/lib/units.check.ts
//
// The properties that matter, and the bug each one exists to stop:
//
//   · a same-unit read is the IDENTITY — the overwhelmingly common case must be
//     byte-for-byte what it was before conversion existed
//   · a cross-unit read never rewrites storage — display is a lens, not an edit
//   · type → store → read round-trips to what was typed
//   · a prescribed load lands on a real plate increment IN THE ATHLETE'S UNIT
//     (5 lb / 2.5 kg) — rounding a kg recommendation to the nearest 5 was the
//     original defect and moved the bar 11 lb when the athlete meant 5

import {
  LB_PER_KG, convertWeight, loadIncrement, roundToIncrement,
  displayWeight, storeWeight, fmtWeight, prescribedWeight, fmtVolume,
  type WeightUnit,
} from './units.ts'

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
function close(actual: number, expected: number, tol: number, msg: string) {
  checks++
  if (Math.abs(actual - expected) > tol) fails.push(`${msg} — expected ~${expected}, got ${actual}`)
}

// ---- identity: same unit in, same number out --------------------------------

for (const u of ['lb', 'kg'] as WeightUnit[]) {
  for (const w of [0, 2.5, 45, 100, 137.5, 225, 405]) {
    eq(convertWeight(w, u, u), w, `convertWeight is identity in ${u} for ${w}`)
    eq(displayWeight(w, u, u), w, `displayWeight is identity in ${u} for ${w}`)
    eq(storeWeight(w, u, u), w, `storeWeight is identity in ${u} for ${w}`)
  }
}
eq(fmtWeight(225, 'lb', 'lb'), '225', 'an lb-stored, lb-shown weight prints exactly')
eq(fmtWeight(102.5, 'kg', 'kg'), '102.5', 'a half-kilo prints its half')

// ---- conversion is the real one, both directions ----------------------------

close(convertWeight(100, 'kg', 'lb'), 220.462, 0.001, '100 kg is 220.46 lb')
close(convertWeight(225, 'lb', 'kg'), 102.058, 0.001, '225 lb is 102.06 kg')
eq(displayWeight(225, 'lb', 'kg'), 102.1, '225 lb reads as 102.1 kg (one decimal)')
eq(displayWeight(100, 'kg', 'lb'), 220.5, '100 kg reads as 220.5 lb (one decimal)')

// The pre-fix behaviour, stated as the thing that must NOT happen: a stored 225
// must never simply reappear as "225" under the other unit.
ok(displayWeight(225, 'lb', 'kg') !== 225, 'switching units does not relabel 225 lb as 225 kg')

// ---- round trip: what you type is what you read back ------------------------

for (const [display, storage] of [['kg', 'lb'], ['lb', 'kg'], ['lb', 'lb'], ['kg', 'kg']] as Array<[WeightUnit, WeightUnit]>) {
  for (const typed of [1, 20, 60, 100, 142.5, 315]) {
    const stored = storeWeight(typed, display, storage)
    close(displayWeight(stored, storage, display), typed, 0.05,
      `typing ${typed}${display} against ${storage} storage reads back as ${typed}`)
  }
}

// ---- plate increments -------------------------------------------------------

eq(loadIncrement('lb'), 5, 'lb steps in 5s')
eq(loadIncrement('kg'), 2.5, 'kg steps in 2.5s')
eq(roundToIncrement(227, 'lb'), 225, '227 lb racks as 225')
eq(roundToIncrement(103.4, 'kg'), 102.5, '103.4 kg racks as 102.5')
eq(roundToIncrement(101, 'kg'), 100, '101 kg racks down to 100')
eq(roundToIncrement(-40, 'lb'), 0, 'a negative load can never be prescribed')

// A kg athlete taking 5% off a 100 kg lift should be sent to 105, not 105 rounded
// through an lb-shaped increment.
eq(prescribedWeight(105, 'kg', 'kg'), 105, '105 kg is already rackable')
eq(prescribedWeight(103.95, 'kg', 'kg'), 105, '103.95 kg rounds up to 105, a real bar')
// The same lift stored in lb, read by a kg athlete: converted THEN racked in kg.
close(prescribedWeight(225, 'lb', 'kg'), 102.5, 0.001, '225 lb is prescribed as 102.5 kg')
eq(prescribedWeight(227, 'lb', 'lb'), 225, '227 lb is prescribed as 225 lb')

// ---- volume -----------------------------------------------------------------

eq(fmtVolume(12450, 'lb', 'lb'), (12450).toLocaleString(), 'volume prints with separators')
eq(fmtVolume(1000, 'kg', 'lb'), Math.round(1000 * LB_PER_KG).toLocaleString(), 'volume converts too')

// ---- report -----------------------------------------------------------------

if (fails.length) {
  console.error(`✗ ${fails.length} of ${checks} unit checks failed:`)
  fails.forEach((f) => console.error(`  · ${f}`))
  process.exit(1)
}
console.log(`✓ all ${checks} unit checks passed`)
