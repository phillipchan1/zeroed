/**
 * Logged RPE. Until `VITE_RPE_HALF_STEPS` / `RPE_HALF_STEPS` is flipped,
 * writes stay on whole numbers 1–10 so they fit live INTEGER `workout.rpe`.
 * With the flag on, the picker, /api/data, commitSession, and the follow-up
 * NUMERIC CHECK all accept 1–10 in 0.5 steps.
 */

export const RPE_MIN = 1
export const RPE_MAX = 10
export const RPE_STEP = 0.5

/** Every legal logged RPE once half-steps are on, 1 through 10 inclusive. */
export const RPE_SCALE: readonly number[] = Array.from(
  { length: Math.round((RPE_MAX - RPE_MIN) / RPE_STEP) + 1 },
  (_, i) => RPE_MIN + i * RPE_STEP,
)

/** Integers only — live Supabase `workout.rpe` is INTEGER CHECK 1–10. */
export const RPE_SCALE_INTEGERS: readonly number[] = RPE_SCALE.filter((n) => Number.isInteger(n))

/** Picker values. Half-steps stay hidden until the flag is on. */
export function pickerRpeScale(halfSteps: boolean): readonly number[] {
  return halfSteps ? RPE_SCALE : RPE_SCALE_INTEGERS
}

export function parseRpeHalfStepsFlag(raw: string | undefined | null): boolean {
  const v = String(raw ?? '').trim().toLowerCase().replace(/^['"]+|['"]+$/g, '')
  return v === '1' || v === 'true'
}

function readRpeHalfStepsEnv(): string | undefined {
  try {
    const meta = (import.meta as { env?: Record<string, string | undefined> }).env
    if (meta?.VITE_RPE_HALF_STEPS != null && String(meta.VITE_RPE_HALF_STEPS).trim() !== '') {
      return meta.VITE_RPE_HALF_STEPS
    }
    if (meta?.RPE_HALF_STEPS != null && String(meta.RPE_HALF_STEPS).trim() !== '') {
      return meta.RPE_HALF_STEPS
    }
  } catch { /* no import.meta.env */ }
  if (typeof process !== 'undefined' && process.env) {
    return process.env.RPE_HALF_STEPS ?? process.env.VITE_RPE_HALF_STEPS
  }
  const DenoObj = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno
  if (DenoObj?.env?.get) {
    return DenoObj.env.get('RPE_HALF_STEPS') ?? DenoObj.env.get('VITE_RPE_HALF_STEPS')
  }
  return undefined
}

/** True only when VITE_RPE_HALF_STEPS / RPE_HALF_STEPS is `1` or `true`. */
export function rpeHalfStepsOn(): boolean {
  return parseRpeHalfStepsFlag(readRpeHalfStepsEnv())
}

function asRpeNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function inRange(n: number): boolean {
  return n >= RPE_MIN && n <= RPE_MAX
}

/** True when `value` is empty or a 1–10 half-step (1, 1.5, …, 10). */
export function isHalfStepLoggedRpe(value: unknown): boolean {
  if (value == null || value === '') return true
  const n = asRpeNumber(value)
  if (n == null || !inRange(n)) return false
  return Math.abs(n * 2 - Math.round(n * 2)) < 1e-9
}

/** True when `value` is empty or a whole number 1–10 (INTEGER-safe). */
export function isIntegerLoggedRpe(value: unknown): boolean {
  if (value == null || value === '') return true
  const n = asRpeNumber(value)
  if (n == null || !inRange(n)) return false
  return Math.abs(n - Math.round(n)) < 1e-9
}

/** Empty, or on the scale the current flag allows. */
export function isLoggedRpe(value: unknown, halfSteps = rpeHalfStepsOn()): boolean {
  return halfSteps ? isHalfStepLoggedRpe(value) : isIntegerLoggedRpe(value)
}

export function loggedRpeError(value: unknown, halfSteps = rpeHalfStepsOn()): string | null {
  if (isLoggedRpe(value, halfSteps)) return null
  return halfSteps
    ? `unsupported rpe ${String(value)}: log 1–10 in 0.5 steps`
    : `unsupported rpe ${String(value)}: log 1–10 as a whole number`
}

/** Nearest half-step, clamped to the scale. */
export function roundLoggedRpe(value: number): number {
  const stepped = Math.round(value / RPE_STEP) * RPE_STEP
  return Math.min(RPE_MAX, Math.max(RPE_MIN, Math.round(stepped * 10) / 10))
}

/**
 * Session-average rounding. When half-steps are off, a 7+8 mix must not
 * write 7.5 into the live INTEGER column.
 */
export function roundSessionRpe(value: number, halfSteps: boolean): number {
  if (halfSteps) return roundLoggedRpe(value)
  return Math.min(RPE_MAX, Math.max(RPE_MIN, Math.round(value)))
}

function setRpesFromWeights(weights: unknown): unknown[] {
  if (weights == null) return []
  if (typeof weights !== 'object') return []
  const out: unknown[] = []
  for (const sets of Object.values(weights as Record<string, unknown>)) {
    if (!Array.isArray(sets)) continue
    for (const row of sets) {
      if (row && typeof row === 'object' && 'rpe' in row) out.push((row as { rpe: unknown }).rpe)
    }
  }
  return out
}

/** Session `rpe` plus every set RPE in `actual_weights`. */
export function workoutRpeError(
  row: { rpe?: unknown; actual_weights?: unknown },
  halfSteps = rpeHalfStepsOn(),
): string | null {
  if ('rpe' in row) {
    const err = loggedRpeError(row.rpe, halfSteps)
    if (err) return err
  }
  if ('actual_weights' in row) {
    for (const rpe of setRpesFromWeights(row.actual_weights)) {
      const err = loggedRpeError(rpe, halfSteps)
      if (err) return err
    }
  }
  return null
}
