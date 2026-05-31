/**
 * Deterministic safety validator — the single most rigorous point in the system.
 *
 * The agent (callProgramDesign) PROPOSES a session; this code DISPOSES of load,
 * volume, and contraindications. The model is NEVER the last line of defense:
 * every prescription passes through here before it can reach the DB. For the
 * provisional first session — built before any movement screen — the ceiling is
 * deliberately low (mobility / bodyweight / light only).
 *
 * Pure, no I/O. On structurally unusable input it throws SafetyRejection so the
 * caller can fall back to the deterministic engine floor.
 *
 * NOTE on units: `trainingAge` is in YEARS (the app's slider is 0–25).
 */

import type { ProgramDesignResult, ProgramExercise } from './agentClient'

export class SafetyRejection extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafetyRejection'
  }
}

// Movements that must never appear in an UNSCREENED provisional session.
// Maximal/ballistic/heavy patterns: we have not verified how this athlete moves.
const CONTRAINDICATED =
  /\b(snatch|clean|jerk|1\s?-?\s?rep|1\s?rm|max(imal)?|plyo(metric)?|depth\s*jump|box\s*jump|broad\s*jump|sprint|heavy)\b|barbell\s+(back\s+)?squat|conventional\s+deadlift/i

// Safe, low-load substitutes spanning the common categories. Used to replace a
// dropped exercise and to pad a session up to the minimum count.
const SAFE_SUBSTITUTES: ProgramExercise[] = [
  { name: 'Goblet Squat',     sets: 3, reps: '8',            load: 'light',      cue: 'Chest tall — knees track over the toes' },
  { name: 'Glute Bridge',     sets: 3, reps: '12',           load: 'bodyweight', cue: 'Brace first — full squeeze at the top' },
  { name: 'Dead Bug',         sets: 3, reps: '8 each side',  load: 'bodyweight', cue: 'Lumbar flat to the floor throughout' },
  { name: 'Bird Dog',         sets: 3, reps: '8 each side',  load: 'bodyweight', cue: 'Hips level — no rotation' },
  { name: 'Band Pull-Apart',  sets: 3, reps: '15',           load: 'light',      cue: 'Scapulae retract and depress' },
  { name: 'Hip Hinge (Dowel)',sets: 3, reps: '10',           load: 'bodyweight', cue: 'Dowel stays in contact: head, mid-back, sacrum' },
]

const MIN_EXERCISES = 3
const MAX_EXERCISES = 6
const MAX_SETS = 4
const MIN_SETS = 1
const DEFAULT_SETS = 2
const MAX_TIME_HOLD = 60 // seconds

type Load = 'bodyweight' | 'light' | 'moderate'

// The provisional ceiling, scaled to training history so the first session can
// feel like real training without gambling on a body we haven't watched move:
//   < 1yr  (true novice)  → bodyweight only
//   1–2yr  (still green)  → light max
//   ≥ 2yr  (experienced)  → moderate max
// There is no path to HEAVY on an unscreened session at any training age, and the
// CONTRAINDICATED list still bans maximal/ballistic/barbell-max patterns outright.
const EXPERIENCED_TRAINING_AGE = 2

function loadCeiling(trainingAge: number): Load {
  if (trainingAge < 1) return 'bodyweight'
  if (trainingAge < EXPERIENCED_TRAINING_AGE) return 'light'
  return 'moderate'
}

const LOAD_RANK: Record<Load, number> = { bodyweight: 0, light: 1, moderate: 2 }

function clampLoad(load: unknown, ceiling: Load): Load {
  const l: Load = load === 'bodyweight' || load === 'light' || load === 'moderate' ? load : 'light'
  return LOAD_RANK[l] > LOAD_RANK[ceiling] ? ceiling : l
}

function clampSets(sets: unknown): number {
  const n = typeof sets === 'number' && Number.isFinite(sets) ? Math.round(sets) : DEFAULT_SETS
  return Math.max(MIN_SETS, Math.min(MAX_SETS, n))
}

// reps is free-text ("8" | "8-10" | "30s" | "8 each side"). Cap unsafe values.
function clampReps(reps: unknown): string {
  if (typeof reps !== 'string' || !reps.trim()) return '8-10'
  const r = reps.trim()

  // time hold, e.g. "30s" / "45 sec" / "60s each side"
  const time = r.match(/^(\d+)\s*(s|sec|secs|seconds)\b(.*)$/i)
  if (time) {
    const secs = Math.min(MAX_TIME_HOLD, parseInt(time[1], 10))
    return `${secs}s${time[3] ?? ''}`.trim()
  }

  // explicit range, e.g. "8-12" — keep as-is
  if (/^\d+\s*-\s*\d+/.test(r)) return r

  // leading integer rep count — cap a runaway count into a safe band
  const lead = r.match(/^(\d+)(.*)$/)
  if (lead) {
    const n = parseInt(lead[1], 10)
    if (n > 20) return `8-12${lead[2] ?? ''}`.trim()
    return r
  }

  // non-parseable (e.g. "AMRAP", "to failure") — replace with a safe band
  return '8-10'
}

function sanitizeExercise(ex: ProgramExercise, ceiling: Load): ProgramExercise {
  return {
    name: ex.name.trim(),
    sets: clampSets(ex.sets),
    reps: clampReps(ex.reps),
    load: clampLoad(ex.load, ceiling),
    cue: typeof ex.cue === 'string' ? ex.cue : '',
  }
}

/**
 * Clamp/repair a model-proposed program into a provably-safe provisional session.
 * Returns a sanitized ProgramDesignResult, or throws SafetyRejection if the input
 * is too malformed to repair (→ caller falls back to the deterministic engine).
 */
export function validateProvisionalProgram(
  design: ProgramDesignResult,
  ctx: { trainingAge: number },
): ProgramDesignResult {
  if (!design || !Array.isArray(design.sessions) || design.sessions.length === 0) {
    throw new SafetyRejection('no sessions')
  }

  const ceiling = loadCeiling(ctx.trainingAge)
  let subIdx = 0
  const nextSubstitute = (): ProgramExercise => {
    const base = SAFE_SUBSTITUTES[subIdx % SAFE_SUBSTITUTES.length]
    subIdx += 1
    return sanitizeExercise({ ...base }, ceiling)
  }

  const sessions = design.sessions.map((session) => {
    const raw = Array.isArray(session.exercises) ? session.exercises : []

    // Drop contraindicated or nameless exercises; sanitize the rest.
    let exercises = raw
      .filter((ex) => ex && typeof ex.name === 'string' && ex.name.trim().length > 0)
      .filter((ex) => !CONTRAINDICATED.test(ex.name))
      .map((ex) => sanitizeExercise(ex, ceiling))

    // De-dupe by name (model sometimes repeats).
    const seen = new Set<string>()
    exercises = exercises.filter((ex) => {
      const key = ex.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Pad up to the minimum with safe substitutes; cap at the maximum.
    while (exercises.length < MIN_EXERCISES) {
      const sub = nextSubstitute()
      if (!exercises.some((e) => e.name.toLowerCase() === sub.name.toLowerCase())) {
        exercises.push(sub)
      }
    }
    if (exercises.length > MAX_EXERCISES) exercises = exercises.slice(0, MAX_EXERCISES)

    return {
      name: typeof session.name === 'string' && session.name.trim() ? session.name.trim() : 'Session A',
      intent: typeof session.intent === 'string' ? session.intent : '',
      exercises,
    }
  })

  return {
    goal: typeof design.goal === 'string' && design.goal.trim() ? design.goal.trim() : 'Build a base safely while the read sharpens.',
    non_negotiables: Array.isArray(design.non_negotiables) ? design.non_negotiables.filter((s) => typeof s === 'string') : [],
    sessions,
  }
}
