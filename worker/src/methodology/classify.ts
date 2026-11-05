/**
 * What an exercise is, for the preview validators (G5): a small data table
 * over the exercise library's movement pattern, plus a few name rules. The
 * defaults are conservative: an exercise this can't place gets no class and
 * no rank, and the validators say nothing about it rather than guess.
 */
import type { ExerciseTemplate } from '../../../src/types/database.ts'
import { resolveCategory, resolvePattern, type MovementPattern } from '../../../src/engine/exerciseLibrary.ts'
import { isIntervalBlock } from '../../../src/engine/intervals.ts'
import { readLoggedExercises, resolveLoggedExercises, type LoggedWorkoutLike } from '../../../src/engine/loggedSets.ts'
import { canonicalLiftId } from '../../../src/engine/liftModel.ts'

export type ExerciseClass =
  | 'warmup' | 'speed' | 'plyo' | 'heavy' | 'heavy_lower' | 'heavy_press'
  | 'press' | 'pull' | 'triceps' | 'grip' | 'deadlift' | 'conditioning' | 'hiit'

/** U8 order: warm-up 0 → speed/plyo/agility 1 → heavy lift 2 → accessories 3 → conditioning 4. */
export type OrderRank = 0 | 1 | 2 | 3 | 4

export interface Classified {
  classes: Set<ExerciseClass>
  /** Null: no opinion on where it goes (mobility, core, carries, unknown). */
  rank: OrderRank | null
  /** Pain regions it loads (U7 red flags). Empty when unknown. */
  regions: string[]
}

interface PatternRow {
  classes: ExerciseClass[]
  rank: OrderRank | null
  regions: string[]
}

/** The table. Patterns not listed (mobility, recovery, trunk) carry no rank. */
const PATTERN_TABLE: Partial<Record<MovementPattern, PatternRow>> = {
  squat: { classes: [], rank: 3, regions: ['knee', 'hip'] },
  single_leg: { classes: [], rank: 3, regions: ['knee', 'hip'] },
  knee_extension: { classes: [], rank: 3, regions: ['knee'] },
  calf: { classes: [], rank: 3, regions: ['ankle', 'achilles'] },
  hinge: { classes: [], rank: 3, regions: ['low_back', 'hamstring', 'hip'] },
  hip_extension: { classes: [], rank: 3, regions: ['hip'] },
  knee_flexion: { classes: [], rank: 3, regions: ['hamstring', 'knee'] },
  back_extension: { classes: [], rank: 3, regions: ['low_back'] },
  hip_abduction: { classes: [], rank: 3, regions: ['hip'] },
  hip_adduction: { classes: [], rank: 3, regions: ['groin'] },
  horizontal_push: { classes: ['press'], rank: 3, regions: ['shoulder', 'elbow'] },
  vertical_push: { classes: ['press'], rank: 3, regions: ['shoulder', 'elbow'] },
  chest_fly: { classes: [], rank: 3, regions: ['shoulder'] },
  horizontal_pull: { classes: ['pull'], rank: 3, regions: ['upper_back', 'elbow'] },
  vertical_pull: { classes: ['pull'], rank: 3, regions: ['shoulder', 'elbow'] },
  elbow_flexion: { classes: [], rank: 3, regions: ['elbow'] },
  elbow_extension: { classes: ['triceps'], rank: 3, regions: ['elbow'] },
  shoulder_raise: { classes: [], rank: 3, regions: ['shoulder'] },
  rear_delt: { classes: [], rank: 3, regions: ['shoulder'] },
  scapular: { classes: [], rank: 3, regions: ['shoulder'] },
  shrug: { classes: ['grip'], rank: 3, regions: ['neck'] },
  carry: { classes: ['grip'], rank: null, regions: ['wrist'] },
  jump: { classes: ['plyo', 'speed'], rank: 1, regions: ['knee', 'ankle', 'achilles'] },
  throw: { classes: ['plyo', 'speed'], rank: 1, regions: ['shoulder'] },
  sprint: { classes: ['plyo', 'speed'], rank: 1, regions: ['hamstring', 'ankle', 'achilles'] },
  power: { classes: ['speed', 'heavy'], rank: 1, regions: ['knee', 'hip', 'low_back', 'shoulder'] },
  sled: { classes: ['conditioning'], rank: 4, regions: ['knee'] },
  cardio: { classes: ['conditioning'], rank: 4, regions: [] },
}

/** Heavy compounds the library files as variations of a main lift. */
const HEAVY_NAME = /\b(front squat|trap bar deadlift|hex bar deadlift|sumo deadlift|push press|power clean|hang clean|clean and jerk|snatch)\b/
const WARMUP_NAME = /\b(warm ?-?up|activation|general prep)\b/
const TRICEPS_NAME = /\b(close ?-?grip bench|jm press|dips?)\b/
const GRIP_NAME = /\b(farmer|suitcase|dead ?hang|plate pinch|grip|wrist curl|forearm|towel)\b/
const DEADLIFT_NAME = /\b(deadlift|rack pull)\b/
const HIIT_NAME = /\b(hiit|tabata|e\d?mom|intervals?)\b/
const RUN_NAME = /\b(run|running|sprint|jog|treadmill)\b/
const CORE_PATTERNS = new Set<MovementPattern>(['anti_extension', 'anti_rotation', 'lateral_core', 'trunk_flexion', 'hip_flexion'])

export function classify(ex: Pick<ExerciseTemplate, 'name' | 'reps' | 'sets' | 'load'>): Classified {
  const name = (ex.name ?? '').toLowerCase()
  const pattern = resolvePattern(ex.name ?? '')
  const row = pattern ? PATTERN_TABLE[pattern] : undefined
  const classes = new Set<ExerciseClass>(row?.classes ?? [])
  let rank: OrderRank | null = row?.rank ?? null
  const regions = [...(row?.regions ?? [])]
  const interval = isIntervalBlock(ex)

  if (WARMUP_NAME.test(name)) return { classes: new Set(['warmup']), rank: 0, regions: [] }
  if (pattern && CORE_PATTERNS.has(pattern)) rank = null

  const lift = canonicalLiftId(ex.name)
  if (!interval && (lift || HEAVY_NAME.test(name))) {
    classes.add('heavy')
    if (lift === 'squat' || lift === 'deadlift' || /squat|deadlift|clean|snatch/.test(name)) classes.add('heavy_lower')
    if (lift === 'bench' || lift === 'ohp' || /push press|jerk/.test(name)) {
      classes.add('heavy_press')
      classes.add('press')
    }
    if (rank !== 1) rank = 2
  }
  if (TRICEPS_NAME.test(name)) classes.add('triceps')
  if (GRIP_NAME.test(name)) classes.add('grip')
  if (lift === 'deadlift' || DEADLIFT_NAME.test(name)) classes.add('deadlift')
  if (resolveCategory(ex.name ?? '') === 'Conditioning' && !classes.has('plyo')) {
    classes.add('conditioning')
    rank = 4
  }
  if (interval || HIIT_NAME.test(name)) {
    if (classes.has('conditioning') || classes.has('plyo') || RUN_NAME.test(name) || interval) {
      classes.add('hiit')
      classes.add('conditioning')
      rank = 4
    }
  }
  return { classes, rank, regions: [...new Set(regions)] }
}

// ---- what a logged session loads (U7, v1.3) ------------------------------------------------

/** Knee, ankle, hip (section 11c, v1): these load the region, and nothing else does. */
const LOWER_REGIONS = new Set(['knee', 'ankle', 'hip'])
const LOWER_NAME = /\b(squats?|lunges?|jumps?|jumping|cuts?|cutting|basketball)\b/

/**
 * True when a logged session loads `region`, for ending a temporary U7 block
 * (v1.3). Knee, ankle, hip: an exercise (or the session's name) with squats,
 * lunges, jumps, cuts or basketball. Any other region: an exercise tagged to
 * it in the table above. Nothing else counts, so an unplaced region keeps its
 * block until a tagged match or the 14-day lapse.
 */
export function sessionLoadsRegion(session: { name?: string | null; exercises: Array<Pick<ExerciseTemplate, 'name' | 'reps' | 'sets' | 'load'>> }, region: string): boolean {
  if (LOWER_REGIONS.has(region)) {
    const lower = (n: string | null | undefined) => LOWER_NAME.test((n ?? '').toLowerCase()) || resolvePattern(n ?? '') === 'jump'
    return lower(session.name) || session.exercises.some((ex) => lower(ex.name))
  }
  return session.exercises.some((ex) => classify(ex).regions.includes(region))
}

/**
 * Of `regions`, those a logged workout loads. The session is what was
 * prescribed when it was logged (the snapshot, else the routine) plus anything
 * logged by name: the work a block kept it off still counts as the session
 * that loads the region.
 */
export function loggedSessionRegions(w: LoggedWorkoutLike & { name?: string | null }, regions: readonly string[]): string[] {
  const exercises = [
    ...resolveLoggedExercises(w),
    ...readLoggedExercises(w).map((x) => x.exercise ?? { name: x.name, sets: x.sets.length, reps: '', load: '' }),
  ]
  return regions.filter((region) => sessionLoadsRegion({ name: w.name, exercises }, region))
}
