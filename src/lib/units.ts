// =============================================================================
// units — the athlete's weight/distance units.
//
// Two units, not one. This file used to hold a single setting and no arithmetic,
// which made the unit switch a LIE: every weight in the database is a bare
// number, so flipping the toggle relabelled a 225 lb bench as "225 kg" and every
// number downstream of it — the recommended load, the e1RM, the forward
// projection — quietly inherited the new label without moving. Switching units
// was a data-integrity event dressed up as a display preference.
//
//   • STORAGE unit — what the numbers in `workout.actual_weights` actually mean.
//     Pinned once per device and never changed again, so history keeps meaning
//     what it meant. It is seeded from whatever the display unit was at the
//     moment this code first ran, which is exactly right: before this file
//     existed, displayed unit == stored unit by definition.
//   • DISPLAY unit — what the athlete reads and types. Free to change; every
//     conversion happens at the render / input boundary, so no stored number is
//     ever rewritten and no history is ever reinterpreted.
//
// The conversion helpers are PURE and take both units explicitly, so they can be
// checked without a browser (see units.check.ts). Only the three getters/setters
// at the bottom touch localStorage.
//
// A future pass can promote the display unit to an athlete-row column; the
// read/write surface here stays the same.
// =============================================================================

export type WeightUnit = 'lb' | 'kg'
export type DistanceUnit = 'in' | 'cm'

const WEIGHT_KEY = 'zeroed.weight_unit'
// The unit the stored numbers are in. Written once, then treated as immutable —
// changing it would silently reinterpret every set the athlete has ever logged.
const STORAGE_WEIGHT_KEY = 'zeroed.weight_unit_storage'

export const LB_PER_KG = 2.2046226218

// ---- pure conversion --------------------------------------------------------

/** Exact conversion between the two units. Identity when they match. */
export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value
  return from === 'kg' ? value * LB_PER_KG : value / LB_PER_KG
}

/**
 * The smallest load step that exists in a real gym, per unit: 5 lb (a pair of
 * 2.5s) or 2.5 kg (a pair of 1.25s). Rounding a kg recommendation to the nearest
 * 5 — which is what the whole engine used to do, in every unit — asks for a jump
 * of 11 lb where the athlete meant 5.
 */
export function loadIncrement(unit: WeightUnit): number {
  return unit === 'kg' ? 2.5 : 5
}

/** Round to a rackable number in `unit`. Never negative. */
export function roundToIncrement(value: number, unit: WeightUnit): number {
  const inc = loadIncrement(unit)
  return Math.max(0, Math.round(value / inc) * inc)
}

/**
 * A stored weight as the athlete should READ it. Rounded to one decimal so a
 * same-unit read is exact (225 → 225) and a cross-unit one is legible
 * (220.46 lb → 100 kg), never a float smear.
 */
export function displayWeight(
  stored: number, storageUnit: WeightUnit, displayUnit: WeightUnit,
): number {
  if (storageUnit === displayUnit) return stored
  return Math.round(convertWeight(stored, storageUnit, displayUnit) * 10) / 10
}

/** A weight the athlete TYPED, as it must be stored. Full precision — no rounding. */
export function storeWeight(
  shown: number, displayUnit: WeightUnit, storageUnit: WeightUnit,
): number {
  return convertWeight(shown, displayUnit, storageUnit)
}

/** `displayWeight`, formatted: no trailing `.0`, so "225" not "225.0". */
export function fmtWeight(
  stored: number, storageUnit: WeightUnit, displayUnit: WeightUnit,
): string {
  const v = displayWeight(stored, storageUnit, displayUnit)
  return `${Number.isInteger(v) ? v : Math.round(v * 10) / 10}`
}

/**
 * A prescribed load, ready to read AND to load onto a bar: converted into the
 * athlete's unit and rounded to that unit's plate increment. This is the one
 * function that should produce any "put this much on the bar" number.
 */
export function prescribedWeight(
  stored: number, storageUnit: WeightUnit, displayUnit: WeightUnit,
): number {
  return roundToIncrement(convertWeight(stored, storageUnit, displayUnit), displayUnit)
}

/** Total load moved, formatted with thousands separators (e.g. "12,450"). */
export function fmtVolume(
  stored: number, storageUnit: WeightUnit, displayUnit: WeightUnit,
): string {
  const v = Math.round(convertWeight(stored, storageUnit, displayUnit))
  return v.toLocaleString()
}

// ---- stored settings --------------------------------------------------------

function readUnit(key: string): WeightUnit | null {
  try {
    const v = localStorage.getItem(key)
    return v === 'kg' || v === 'lb' ? v : null
  } catch {
    return null
  }
}

/** The unit the athlete reads and types in. Free to change. */
export function getWeightUnit(): WeightUnit {
  return readUnit(WEIGHT_KEY) ?? 'lb'
}

export function setWeightUnit(unit: WeightUnit): void {
  // Pin the storage unit BEFORE the first switch can move the display one, so a
  // device that flips units on its very first run still records what its
  // existing numbers meant rather than inheriting the new label.
  getStorageWeightUnit()
  try {
    localStorage.setItem(WEIGHT_KEY, unit)
  } catch {
    /* ignore — non-persistent session */
  }
}

/**
 * The unit every stored weight is in. Seeded from the display unit the first
 * time it's asked for and immutable thereafter: the numbers on disk were written
 * under whatever unit was showing, and no later preference can change that.
 */
export function getStorageWeightUnit(): WeightUnit {
  const pinned = readUnit(STORAGE_WEIGHT_KEY)
  if (pinned) return pinned
  const seed = getWeightUnit()
  try {
    localStorage.setItem(STORAGE_WEIGHT_KEY, seed)
  } catch {
    /* ignore — falls back to the same seed on the next read */
  }
  return seed
}

// Distance unit tracks the weight unit's system (imperial vs metric). Jumps and
// short sprints read most naturally in inches / centimetres.
export function getDistanceUnit(weightUnit: WeightUnit = getWeightUnit()): DistanceUnit {
  return weightUnit === 'kg' ? 'cm' : 'in'
}

// ---- the bound pair ---------------------------------------------------------

/**
 * Both units in one object, plus the conversions bound to them — what a screen
 * or an engine read actually wants. Passing this instead of a bare unit STRING
 * is what makes it impossible to print a stored number next to a unit label it
 * isn't in: the label and the arithmetic arrive together.
 */
export interface UnitContext {
  /** What the athlete reads — the label to print. */
  unit: WeightUnit
  /** What the numbers on disk mean. */
  storage: WeightUnit
  distance: DistanceUnit
  /** A stored weight, as a number to show. */
  show: (stored: number) => number
  /** A stored weight, as a string to show (no trailing `.0`). */
  fmt: (stored: number) => string
  /** A typed weight, as it must be stored. */
  store: (shown: number) => number
  /** A stored weight, rounded to a rackable number in the display unit. */
  prescribe: (stored: number) => number
  /** Total load moved, with thousands separators. */
  volume: (stored: number) => string
}

export function unitContext(
  displayUnit: WeightUnit = getWeightUnit(),
  storageUnit: WeightUnit = getStorageWeightUnit(),
): UnitContext {
  return {
    unit: displayUnit,
    storage: storageUnit,
    distance: getDistanceUnit(displayUnit),
    show:      (w) => displayWeight(w, storageUnit, displayUnit),
    fmt:       (w) => fmtWeight(w, storageUnit, displayUnit),
    store:     (w) => storeWeight(w, displayUnit, storageUnit),
    prescribe: (w) => prescribedWeight(w, storageUnit, displayUnit),
    volume:    (w) => fmtVolume(w, storageUnit, displayUnit),
  }
}
