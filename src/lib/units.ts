// =============================================================================
// units — the athlete's weight/distance units.
//
// Stored client-side (localStorage) so it needs no migration and works against
// the live DB immediately. Defaults to imperial (lb / in) — the primary user
// lifts in pounds. A future pass can promote this to an athlete-row column and
// a Profile control; the read/write surface here stays the same.
// =============================================================================

export type WeightUnit = 'lb' | 'kg'
export type DistanceUnit = 'in' | 'cm'

const WEIGHT_KEY = 'zeroed.weight_unit'

export function getWeightUnit(): WeightUnit {
  try {
    const v = localStorage.getItem(WEIGHT_KEY)
    return v === 'kg' ? 'kg' : 'lb'
  } catch {
    return 'lb'
  }
}

export function setWeightUnit(unit: WeightUnit): void {
  try {
    localStorage.setItem(WEIGHT_KEY, unit)
  } catch {
    /* ignore — non-persistent session */
  }
}

// Distance unit tracks the weight unit's system (imperial vs metric). Jumps and
// short sprints read most naturally in inches / centimetres.
export function getDistanceUnit(weightUnit: WeightUnit = getWeightUnit()): DistanceUnit {
  return weightUnit === 'kg' ? 'cm' : 'in'
}
