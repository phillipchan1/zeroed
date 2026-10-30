// Pure set-grid writes. The WorkoutScreen's SetRow used to spread a stale
// `log` prop on every keystroke, so typing weight then reps (or tapping done
// before the parent re-rendered) dropped the weight and let tap-to-complete
// fill the prescribed/suggested load instead.

import type { SetLog, TrackingType } from '../types/database'

export type SetMetricField = 'weight' | 'reps' | 'rpe' | 'duration' | 'distance'

export function applySetField(log: SetLog, field: SetMetricField, value: number | null): SetLog {
  return { ...log, [field]: value }
}

export function applySetFields(
  log: SetLog,
  fields: Array<readonly [SetMetricField, number | null]>,
): SetLog {
  return fields.reduce((acc, [field, value]) => applySetField(acc, field, value), log)
}

export interface CompleteSetOpts {
  trackingType: TrackingType
  carry: Partial<SetLog>
  /** Prescribed load already in the storage weight unit. */
  prescribedWeight: number | null
  prescribedReps: number | null
  prescribedDuration: number | null
}

export function completeSetLog(
  log: SetLog,
  opts: CompleteSetOpts,
): { next: SetLog; autofilled: SetMetricField[] } {
  const next: SetLog = { ...log, done: true }
  const autofilled: SetMetricField[] = []
  const fill = (field: SetMetricField, value: number | null | undefined) => {
    if (value != null && next[field] == null) {
      next[field] = value
      autofilled.push(field)
    }
  }
  if (opts.trackingType === 'weight_reps') {
    fill('weight', opts.carry.weight ?? opts.prescribedWeight)
    fill('reps', opts.carry.reps ?? opts.prescribedReps)
    fill('rpe', opts.carry.rpe)
  } else if (opts.trackingType === 'bodyweight_reps') {
    fill('reps', opts.carry.reps ?? opts.prescribedReps)
    fill('weight', opts.carry.weight)
    fill('rpe', opts.carry.rpe)
  } else if (opts.trackingType === 'time') {
    fill('duration', opts.carry.duration ?? opts.prescribedDuration)
    fill('rpe', opts.carry.rpe)
  } else if (opts.trackingType === 'distance') {
    fill('distance', opts.carry.distance)
  }
  return { next, autofilled }
}

export function revertSetAutofill(log: SetLog, autofilled: SetMetricField[]): SetLog {
  const next: SetLog = { ...log, done: false }
  for (const field of autofilled) next[field] = null
  return next
}
