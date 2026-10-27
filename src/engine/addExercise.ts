// =============================================================================
// ADDING TO A SESSION — a movement the program didn't call for, today.
//
// The library already knows what a movement IS (its pattern, its metric, its
// kit); this decides what a first dose of it looks like, so picking one is a
// single tap rather than a form. Two sources, in order:
//
//   · what the athlete did with it last time — their own sets and reps are a
//     better default than any table, and the set grid already carries last
//     session's weights into the first set
//   · otherwise an ordinary S&C dose for the pattern: a compound 3×8, an
//     isolation 3×12, a hold 3×30s, a carry 3×40s, steady cardio 10 minutes
//
// Like a swap, an addition is for THIS session only: the program isn't edited,
// the movement is filed in the session's exercises_snapshot (flagged `added`),
// and its sets count toward the week like any other.
//
// Pure, no I/O (see addExercise.check.ts).
// =============================================================================

import type { ExerciseTemplate, SetLog, TrackingType } from '../types/database.ts'
import {
  findLibraryExercise, resolvePattern, resolveTrackingType, LIBRARY_EXERCISES,
  type LibraryExercise, type MovementPattern,
} from './exerciseLibrary.ts'
import { fmtDuration } from './intervals.ts'

interface Dose { sets: number; reps: string; load: string }

const COMPOUND: ReadonlySet<MovementPattern> = new Set([
  'squat', 'hinge', 'horizontal_push', 'vertical_push',
])
const BIG_ACCESSORY: ReadonlySet<MovementPattern> = new Set([
  'horizontal_pull', 'vertical_pull', 'single_leg', 'hip_extension',
])
const MOBILITY: ReadonlySet<MovementPattern> = new Set([
  'hip_mobility', 'hamstring_mobility', 'ankle_mobility', 'shoulder_mobility', 'thoracic_mobility', 'recovery',
])

function tableDose(pattern: MovementPattern | null, tracking: TrackingType, lib: LibraryExercise | null): Dose {
  const bodyweight = lib?.equipment === 'bodyweight' || lib?.equipment === 'bar'
  if (tracking === 'time') {
    if (pattern === 'cardio') return { sets: 1, reps: '10 min', load: 'bodyweight' }
    if (pattern === 'carry') return { sets: 3, reps: '40s', load: 'moderate' }
    if (pattern && MOBILITY.has(pattern)) return { sets: 2, reps: '45s', load: 'bodyweight' }
    return { sets: 3, reps: '30s', load: bodyweight ? 'bodyweight' : 'light' }
  }
  if (tracking === 'distance') {
    if (pattern === 'jump') return { sets: 3, reps: '3 jumps', load: 'bodyweight' }
    if (pattern === 'sled') return { sets: 4, reps: '20m', load: 'moderate' }
    return { sets: 6, reps: '20m', load: 'bodyweight' }
  }
  if (tracking === 'bodyweight_reps') {
    if (pattern === 'jump') return { sets: 3, reps: '5', load: 'bodyweight' }
    return { sets: 3, reps: '10', load: lib?.equipment === 'band' ? 'light' : 'bodyweight' }
  }
  if (pattern === 'power') return { sets: 4, reps: '3', load: 'moderate' }
  if (pattern === 'throw') return { sets: 3, reps: '5', load: 'light' }
  if (pattern && COMPOUND.has(pattern)) return { sets: 3, reps: '8', load: 'moderate' }
  if (pattern && BIG_ACCESSORY.has(pattern)) return { sets: 3, reps: '10', load: 'moderate' }
  if (pattern == null) return { sets: 3, reps: '10', load: 'moderate' }
  return { sets: 3, reps: '12', load: 'light' }
}

// The most frequent value, the later one winning a tie — the athlete's top
// sets drift up over a session, and the number they settled on is the one to
// repeat.
function mode(values: number[]): number | null {
  if (!values.length) return null
  const counts = new Map<number, number>()
  let best = values[0]
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1
    counts.set(v, n)
    if (n >= (counts.get(best) ?? 0)) best = v
  }
  return best
}

const logged = (s: SetLog) => s.done || s.reps != null || s.duration != null || s.distance != null

/** What last time says, when it says enough to be a dose. */
function historyDose(last: readonly SetLog[] | null | undefined, tracking: TrackingType): Pick<Dose, 'sets' | 'reps'> | null {
  const sets = (last ?? []).filter(logged)
  if (!sets.length) return null
  const n = Math.max(1, Math.min(6, sets.length))
  if (tracking === 'time') {
    const secs = mode(sets.map((s) => s.duration).filter((d): d is number => d != null && d > 0))
    return secs != null ? { sets: n, reps: fmtDuration(secs) } : null
  }
  if (tracking === 'distance') return null   // the unit isn't on the log; the table's dose is safer
  const reps = mode(sets.map((s) => s.reps).filter((r): r is number => r != null && r > 0))
  return reps != null ? { sets: n, reps: String(reps) } : null
}

/**
 * The prescription for a movement added mid-session. `last` is the athlete's
 * most recent sets of it anywhere in the program, when there are any.
 */
export function buildAddition(name: string, last?: readonly SetLog[] | null): ExerciseTemplate {
  const lib = findLibraryExercise(name)
  const canonical = lib?.name ?? name.trim()
  const tracking = lib?.tracking ?? resolveTrackingType(canonical)
  const pattern = lib?.pattern ?? resolvePattern(canonical)
  const table = tableDose(pattern, tracking, lib)
  const fromHistory = historyDose(last, tracking)
  return {
    name: canonical,
    sets: fromHistory?.sets ?? table.sets,
    reps: fromHistory?.reps ?? table.reps,
    load: table.load,
    tracking_type: tracking,
    added: true,
  }
}

// The movements a session most often wants one more of, one per pattern. A
// pattern already in the session is skipped: the suggestion is for what today
// is MISSING, not a second squat.
const STAPLES = [
  'Chest-Supported Row', 'Pull-Up', 'Romanian Deadlift', 'Bulgarian Split Squat', 'Hip Thrust',
  'Face Pull', 'Pallof Press', 'Hanging Leg Raise', 'Lateral Raise', 'Hammer Curl',
  'Tricep Pushdown', 'Calf Raise', 'Copenhagen Plank', 'Nordic Curl', 'Farmer Carry', 'Push-Up',
]

/**
 * What to offer first when the sheet opens: the movements this athlete has added
 * before (most recent first), then staples for patterns today doesn't train.
 */
export function suggestAdditions(
  sessionNames: readonly string[],
  recent: readonly string[] = [],
  limit = 8,
): LibraryExercise[] {
  const inSession = new Set<string>()
  const patterns = new Set<MovementPattern>()
  for (const n of sessionNames) {
    const hit = findLibraryExercise(n)
    inSession.add(hit?.name ?? n)
    const p = hit?.pattern ?? resolvePattern(n)
    if (p) patterns.add(p)
  }
  const out: LibraryExercise[] = []
  const push = (ex: LibraryExercise | null) => {
    if (!ex || inSession.has(ex.name) || out.some((o) => o.name === ex.name)) return
    out.push(ex)
  }
  for (const n of recent) push(findLibraryExercise(n))
  for (const n of STAPLES) {
    const ex = findLibraryExercise(n)
    if (ex && !patterns.has(ex.pattern)) push(ex)
  }
  return out.slice(0, limit)
}

/** The library, grouped for browsing, conditioning last. */
export const BROWSE_CATEGORIES = ['Lower Chain', 'Posterior Chain', 'Upper Chain', 'Core', 'Conditioning'] as const

export function browseLibrary(category: typeof BROWSE_CATEGORIES[number]): LibraryExercise[] {
  return LIBRARY_EXERCISES
    .filter((e) => e.category === category)
    .slice()
    .sort((a, b) => a.pattern.localeCompare(b.pattern) || a.name.localeCompare(b.name))
}

/** Movements an interval block is usually run on, in the order a gym has them. */
export const INTERVAL_MOVEMENTS = [
  'Assault Bike', 'Rowing Machine', 'Ski Erg', 'Sprint', 'Treadmill Run',
  'Jump Rope', 'Burpee', 'Battle Ropes', 'Kettlebell Swing', 'Sled Push',
] as const
