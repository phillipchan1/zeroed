/**
 * Logged RPE is 1–10 in 0.5 steps — the same scale on the picker, the
 * /api/data write path, commitSession (Supabase-path), and the DB CHECK.
 * Prescription `target_rpe` already used 1–10; this is the logged-set /
 * session-average number the athlete actually entered.
 */

export const RPE_MIN = 1
export const RPE_MAX = 10
export const RPE_STEP = 0.5

/** Every legal logged RPE, 1 through 10 inclusive. */
export const RPE_SCALE: readonly number[] = Array.from(
  { length: Math.round((RPE_MAX - RPE_MIN) / RPE_STEP) + 1 },
  (_, i) => RPE_MIN + i * RPE_STEP,
)

/** True when `value` is empty or a 1–10 half-step (1, 1.5, …, 10). */
export function isLoggedRpe(value: unknown): boolean {
  if (value == null || value === '') return true
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return false
  if (n < RPE_MIN || n > RPE_MAX) return false
  return Math.abs(n * 2 - Math.round(n * 2)) < 1e-9
}

export function loggedRpeError(value: unknown): string | null {
  if (isLoggedRpe(value)) return null
  return `unsupported rpe ${String(value)}: log 1–10 in 0.5 steps`
}

/** Nearest half-step, clamped to the scale. */
export function roundLoggedRpe(value: number): number {
  const stepped = Math.round(value / RPE_STEP) * RPE_STEP
  return Math.min(RPE_MAX, Math.max(RPE_MIN, Math.round(stepped * 10) / 10))
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
export function workoutRpeError(row: { rpe?: unknown; actual_weights?: unknown }): string | null {
  if ('rpe' in row) {
    const err = loggedRpeError(row.rpe)
    if (err) return err
  }
  if ('actual_weights' in row) {
    for (const rpe of setRpesFromWeights(row.actual_weights)) {
      const err = loggedRpeError(rpe)
      if (err) return err
    }
  }
  return null
}
