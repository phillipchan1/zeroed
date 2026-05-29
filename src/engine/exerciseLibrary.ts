// =============================================================================
// Exercise library — the DETERMINISTIC source of truth for how a movement is
// measured. "Agent proposes the exercise; code disposes the metric."
//
// The agent (program_design) is free to name any exercise. This library decides
// its tracking_type — never the agent — so the WorkoutScreen renders the right
// inputs and the engine knows what a "rep" means. A known exercise gets the
// library's type; an unknown one falls to a conservative heuristic. The library
// grows by curating the unknowns the agent emits; it does not need to be
// exhaustive to be safe.
//
// This is intentionally a closed, code-owned table (doctrine: exercise library
// is hardcoded). Names are matched on a normalized form (case/punctuation/paren
// qualifiers stripped) plus explicit aliases.
// =============================================================================

import type { TrackingType } from '../types/database'

export type LibraryCategory =
  | 'Lower Chain' | 'Upper Chain' | 'Posterior Chain' | 'Core' | 'Conditioning'

export interface LibraryExercise {
  name: string                 // canonical display name
  tracking: TrackingType
  category: LibraryCategory
  aliases?: string[]           // alternate names the agent / coach might emit
  contra?: boolean             // ballistic/maximal — unsafe on an unscreened session
}

// ---- the table -------------------------------------------------------------
// Grouped for readability only; order does not matter.

const LIBRARY: LibraryExercise[] = [
  // ── Lower chain — squat & knee-dominant ───────────────────────────────────
  { name: 'Back Squat',            tracking: 'weight_reps', category: 'Lower Chain', aliases: ['barbell back squat', 'high bar squat', 'low bar squat', 'barbell squat', 'squat'], contra: true },
  { name: 'Front Squat',           tracking: 'weight_reps', category: 'Lower Chain' },
  { name: 'Goblet Squat',          tracking: 'weight_reps', category: 'Lower Chain', aliases: ['kb goblet squat'] },
  { name: 'Box Squat',             tracking: 'weight_reps', category: 'Lower Chain' },
  { name: 'Bulgarian Split Squat', tracking: 'weight_reps', category: 'Lower Chain', aliases: ['bss', 'rear foot elevated split squat', 'rfess'] },
  { name: 'Split Squat',           tracking: 'weight_reps', category: 'Lower Chain' },
  { name: 'Step-Up',               tracking: 'weight_reps', category: 'Lower Chain', aliases: ['box step up', 'dumbbell step up'] },
  { name: 'Walking Lunge',         tracking: 'weight_reps', category: 'Lower Chain', aliases: ['db lunge', 'dumbbell lunge', 'barbell lunge'] },
  { name: 'Lunge',                 tracking: 'bodyweight_reps', category: 'Lower Chain', aliases: ['reverse lunge', 'forward lunge', 'bodyweight lunge'] },
  { name: 'Leg Press',             tracking: 'weight_reps', category: 'Lower Chain' },
  { name: 'Leg Extension',         tracking: 'weight_reps', category: 'Lower Chain', aliases: ['knee extension'] },
  { name: 'Terminal Knee Extension', tracking: 'bodyweight_reps', category: 'Lower Chain', aliases: ['tke', 'banded tke'] },
  { name: 'Calf Raise',            tracking: 'weight_reps', category: 'Lower Chain', aliases: ['standing calf raise', 'seated calf raise'] },
  { name: 'Wall Sit',              tracking: 'time', category: 'Lower Chain' },
  { name: 'Air Squat',             tracking: 'bodyweight_reps', category: 'Lower Chain', aliases: ['bodyweight squat'] },

  // ── Posterior chain — hinge & hamstring ───────────────────────────────────
  { name: 'Deadlift',              tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['conventional deadlift', 'sumo deadlift', 'barbell deadlift'], contra: true },
  { name: 'Trap Bar Deadlift',     tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['hex bar deadlift'] },
  { name: 'Romanian Deadlift',     tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['rdl', 'barbell rdl', 'db rdl'] },
  { name: 'Single-Leg RDL',        tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['single leg romanian deadlift', 'sl rdl'] },
  { name: 'Hip Thrust',            tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['barbell hip thrust'] },
  { name: 'Single-Leg Hip Thrust', tracking: 'bodyweight_reps', category: 'Posterior Chain' },
  { name: 'Glute Bridge',          tracking: 'bodyweight_reps', category: 'Posterior Chain', aliases: ['loaded glute bridge'] },
  { name: 'Hip Hinge (Dowel)',     tracking: 'bodyweight_reps', category: 'Posterior Chain', aliases: ['hip hinge', 'dowel hip hinge'] },
  { name: 'Kettlebell Swing',      tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['kb swing', 'russian swing'] },
  { name: 'Nordic Curl',           tracking: 'bodyweight_reps', category: 'Posterior Chain', aliases: ['nordic hamstring curl', 'nordic curl (eccentric)'] },
  { name: 'Leg Curl',              tracking: 'weight_reps', category: 'Posterior Chain', aliases: ['hamstring curl', 'lying leg curl', 'seated leg curl', 'ghr', 'glute ham raise'] },
  { name: 'Back Extension',        tracking: 'bodyweight_reps', category: 'Posterior Chain', aliases: ['hyperextension', '45 degree back extension'] },
  { name: 'Good Morning',          tracking: 'weight_reps', category: 'Posterior Chain' },
  { name: 'Supine Hip Extension',  tracking: 'bodyweight_reps', category: 'Posterior Chain' },

  // ── Upper chain — press ────────────────────────────────────────────────────
  { name: 'Bench Press',           tracking: 'weight_reps', category: 'Upper Chain', aliases: ['barbell bench press', 'flat bench'] },
  { name: 'DB Bench Press',        tracking: 'weight_reps', category: 'Upper Chain', aliases: ['dumbbell bench press', 'db bench', 'db bench (unilateral)', 'unilateral db bench'] },
  { name: 'Incline Bench Press',   tracking: 'weight_reps', category: 'Upper Chain', aliases: ['incline bench', 'incline db press'] },
  { name: 'Floor Press',           tracking: 'weight_reps', category: 'Upper Chain' },
  { name: 'Overhead Press',        tracking: 'weight_reps', category: 'Upper Chain', aliases: ['ohp', 'strict press', 'strict ohp', 'military press', 'barbell overhead press'] },
  { name: 'DB Shoulder Press',     tracking: 'weight_reps', category: 'Upper Chain', aliases: ['dumbbell shoulder press', 'seated db press'] },
  { name: 'Push Press',            tracking: 'weight_reps', category: 'Upper Chain' },
  { name: 'Landmine Press',        tracking: 'weight_reps', category: 'Upper Chain' },
  { name: 'Bottom-Up KB Press',    tracking: 'weight_reps', category: 'Upper Chain', aliases: ['bottoms up kettlebell press', 'bottom up kb press'] },
  { name: 'Push-Up',               tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['pushup', 'push up'] },
  { name: 'Push-Up Plus',          tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['pushup plus', 'scapular push-up plus'] },
  { name: 'Scapular Push-Up',      tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['scap push up', 'scapular pushup'] },
  { name: 'Dip',                   tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['parallel bar dip', 'tricep dip'] },

  // ── Upper chain — pull ─────────────────────────────────────────────────────
  { name: 'Pull-Up',               tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['pullup', 'pull up'] },
  { name: 'Chin-Up',               tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['chinup', 'chin up'] },
  { name: 'Lat Pulldown',          tracking: 'weight_reps', category: 'Upper Chain', aliases: ['pulldown'] },
  { name: 'Barbell Row',           tracking: 'weight_reps', category: 'Upper Chain', aliases: ['bent over row', 'pendlay row'] },
  { name: 'DB Row',                tracking: 'weight_reps', category: 'Upper Chain', aliases: ['dumbbell row', 'single arm row', 'one arm row'] },
  { name: 'Chest-Supported Row',   tracking: 'weight_reps', category: 'Upper Chain', aliases: ['chest supported db row', 'csr', 'seal row'] },
  { name: 'Cable Row',             tracking: 'weight_reps', category: 'Upper Chain', aliases: ['seated cable row'] },
  { name: 'Incline DB Row',        tracking: 'weight_reps', category: 'Upper Chain' },
  { name: 'Inverted Row',          tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['ring row', 'bodyweight row', 'trx row'] },
  { name: 'Face Pull',             tracking: 'weight_reps', category: 'Upper Chain', aliases: ['cable face pull'] },
  { name: 'Band Pull-Apart',       tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['band pull apart', 'band pull-apart (light)'] },
  { name: 'Trap-3 Raise',          tracking: 'weight_reps', category: 'Upper Chain', aliases: ['trap 3 raise', 'prone trap raise'] },

  // ── Upper chain — accessory / arms / delts ────────────────────────────────
  { name: 'Bicep Curl',            tracking: 'weight_reps', category: 'Upper Chain', aliases: ['db curl', 'barbell curl', 'hammer curl', 'curl'] },
  { name: 'Tricep Extension',      tracking: 'weight_reps', category: 'Upper Chain', aliases: ['tricep pushdown', 'skull crusher', 'overhead tricep extension'] },
  { name: 'Lateral Raise',         tracking: 'weight_reps', category: 'Upper Chain', aliases: ['side raise', 'db lateral raise'] },
  { name: 'Rear Delt Fly',         tracking: 'weight_reps', category: 'Upper Chain', aliases: ['reverse fly', 'rear delt raise'] },
  { name: 'DB External Rotation',  tracking: 'weight_reps', category: 'Upper Chain', aliases: ['external rotation', 'banded external rotation', 'cuff external rotation'] },

  // ── Shoulder / thoracic mobility & activation ─────────────────────────────
  { name: 'Wall Slide',            tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['wall slides'] },
  { name: 'Serratus Wall Slide',   tracking: 'bodyweight_reps', category: 'Upper Chain' },
  { name: 'Shoulder CARs',         tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['shoulder controlled articular rotations'] },
  { name: 'Thoracic Rotation',     tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['t-spine rotation', 'open book'] },
  { name: 'Thoracic Extension Over Foam Roller', tracking: 'bodyweight_reps', category: 'Upper Chain', aliases: ['thoracic extension', 'foam roller thoracic extension'] },
  { name: 'Lat Stretch',           tracking: 'time', category: 'Upper Chain' },
  { name: 'Pec Stretch',           tracking: 'time', category: 'Upper Chain', aliases: ['doorway pec stretch', 'doorframe pec stretch'] },
  { name: 'Dead Hang',             tracking: 'time', category: 'Upper Chain', aliases: ['active hang', 'bar hang'] },

  // ── Core / trunk ───────────────────────────────────────────────────────────
  { name: 'Plank',                 tracking: 'time', category: 'Core', aliases: ['front plank', 'forearm plank'] },
  { name: 'Side Plank',            tracking: 'time', category: 'Core' },
  { name: 'Copenhagen Plank',      tracking: 'time', category: 'Core', aliases: ['copenhagen'] },
  { name: 'Hollow Body Hold',      tracking: 'time', category: 'Core', aliases: ['hollow hold'] },
  { name: 'Dead Bug',              tracking: 'bodyweight_reps', category: 'Core' },
  { name: 'Bird Dog',              tracking: 'bodyweight_reps', category: 'Core', aliases: ['quadruped bird dog'] },
  { name: 'McGill Curl-Up',        tracking: 'bodyweight_reps', category: 'Core', aliases: ['mcgill curl up', 'curl-up'] },
  { name: 'Ab Wheel',              tracking: 'bodyweight_reps', category: 'Core', aliases: ['ab rollout', 'wheel rollout'] },
  { name: 'Pallof Press',          tracking: 'bodyweight_reps', category: 'Core', aliases: ['banded pallof press', 'cable pallof press'] },
  { name: 'Stir the Pot',          tracking: 'bodyweight_reps', category: 'Core' },
  { name: 'Hanging Leg Raise',     tracking: 'bodyweight_reps', category: 'Core', aliases: ['leg raise', 'knee raise'] },
  { name: 'Sit-Up',                tracking: 'bodyweight_reps', category: 'Core', aliases: ['situp', 'crunch'] },
  { name: 'Bear Crawl',            tracking: 'distance', category: 'Core' },
  { name: 'Diaphragmatic Breathing', tracking: 'time', category: 'Core', aliases: ['breathing', 'breathing + rib/lat expansion', '90/90 breathing', 'rib lat expansion'] },

  // ── Hip / ankle mobility (reps or holds) ──────────────────────────────────
  { name: 'Ankle CARs',            tracking: 'bodyweight_reps', category: 'Lower Chain' },
  { name: 'Hip 90/90 Stretch',    tracking: 'time', category: 'Lower Chain', aliases: ['90/90 hip stretch', '90/90 hip ir hold', 'hip 90/90'] },
  { name: 'Hip Flexor Stretch',    tracking: 'time', category: 'Lower Chain', aliases: ['couch stretch', 'half-kneel hip flexor', 'supine hip flexor stretch', 'kneeling hip flexor stretch'] },
  { name: 'Hamstring Stretch',     tracking: 'time', category: 'Posterior Chain', aliases: ['hamstring stretch (90/90)', 'standing hamstring stretch'] },
  { name: "World's Greatest Stretch", tracking: 'bodyweight_reps', category: 'Lower Chain' },
  { name: 'Cat-Cow',               tracking: 'bodyweight_reps', category: 'Core', aliases: ['cat cow'] },
  { name: 'Lateral Band Walk',     tracking: 'bodyweight_reps', category: 'Lower Chain', aliases: ['banded lateral walk', 'monster walk'] },

  // ── Isometrics / bench setup (the user's own movements) ───────────────────
  { name: 'Bench Setup Holds',     tracking: 'time', category: 'Upper Chain', aliases: ['bench setup holds (barbell or empty bar)', 'setup hold'] },
  { name: 'Isometric Press',       tracking: 'time', category: 'Upper Chain', aliases: ['isometric press (mid-range set)', 'iso press', 'pin press hold'] },

  // ── Conditioning / power (often contraindicated unscreened) ───────────────
  { name: 'Broad Jump',            tracking: 'distance', category: 'Conditioning', aliases: ['standing long jump', 'long jump'], contra: true },
  { name: 'Vertical Jump',         tracking: 'distance', category: 'Conditioning', aliases: ['vertical leap'], contra: true },
  { name: 'Box Jump',              tracking: 'bodyweight_reps', category: 'Conditioning', contra: true },
  { name: 'Depth Jump',            tracking: 'bodyweight_reps', category: 'Conditioning', contra: true },
  { name: 'Sprint',                tracking: 'distance', category: 'Conditioning', aliases: ['sprints', 'dash', '40 yard dash', 'court sprint'], contra: true },
  { name: 'Shuttle Run',           tracking: 'distance', category: 'Conditioning', aliases: ['shuttle', 'suicides'], contra: true },
  { name: 'Sled Push',             tracking: 'distance', category: 'Conditioning', aliases: ['prowler push'] },
  { name: 'Farmer Carry',          tracking: 'time', category: 'Conditioning', aliases: ['farmers carry', 'loaded carry', 'suitcase carry', 'single-arm carry'] },
  { name: 'Row (Erg)',             tracking: 'time', category: 'Conditioning', aliases: ['rowing machine', 'erg', 'concept2'] },
  { name: 'Assault Bike',          tracking: 'time', category: 'Conditioning', aliases: ['echo bike', 'air bike'] },
  { name: 'Jump Rope',             tracking: 'time', category: 'Conditioning', aliases: ['skipping'] },
]

// ---- normalization & lookup -------------------------------------------------

// Strip case, parenthetical qualifiers ("(Light)", "(90/90)"), and punctuation
// so "Scapular Push-Up" and "scapular pushup" collapse to the same key.
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // drop "(...)" qualifiers
    .replace(/[^a-z0-9\s]/g, ' ')  // punctuation → space (handles hyphens, slashes)
    .replace(/\s+/g, ' ')
    .trim()
}

const LOOKUP = new Map<string, LibraryExercise>()
for (const ex of LIBRARY) {
  LOOKUP.set(normalizeName(ex.name), ex)
  for (const alias of ex.aliases ?? []) LOOKUP.set(normalizeName(alias), ex)
}

export function findLibraryExercise(name: string): LibraryExercise | null {
  return LOOKUP.get(normalizeName(name)) ?? null
}

// ---- heuristic fallback for unknown exercises ------------------------------
// Conservative: reps-unit signals first (most reliable), then name keywords,
// then load. Defaults to weight_reps. The library covers the tricky cases so
// this rarely fires; when it does, a wrong guess is a cosmetic input layout,
// not a safety issue.
function heuristicTracking(name: string, reps?: string, load?: string): TrackingType {
  const r = (reps ?? '').toLowerCase()

  // explicit time unit in the rep string ("30s", "60 sec", "2 min", "hold")
  if (/\d\s*(s|sec|secs|second|seconds|min|mins|minute|minutes)\b/.test(r) || /\bhold\b/.test(r)) {
    return 'time'
  }
  // explicit distance unit ("20m", "10 yd", "6 ft", feet/inch marks)
  if (/\d\s*(m|meter|meters|metre|metres|yd|yard|yards|ft|foot|feet|in|inch|inches|cm)\b/.test(r) || /['"]/.test(r)) {
    return 'distance'
  }

  const n = normalizeName(name)
  if (/\b(broad jump|long jump|vertical|sprint|dash|shuttle|bound|sled|prowler)\b/.test(n)) return 'distance'
  if (/\b(plank|hold|hang|carry|wall sit|isometric|breathing|stretch)\b/.test(n)) return 'time'
  if (load === 'bodyweight') return 'bodyweight_reps'
  if (/\b(push up|pushup|pull up|pullup|chin up|dip|sit up|crunch|burpee|air squat|nordic)\b/.test(n)) {
    return 'bodyweight_reps'
  }
  return 'weight_reps'
}

/**
 * Resolve how an exercise is measured. Library hit wins; otherwise heuristic.
 * Idempotent and pure — safe to call at build time (to persist) AND at render
 * time (as a fallback for legacy/agent rows that lack tracking_type).
 */
export function resolveTrackingType(
  name: string,
  reps?: string,
  load?: string,
): TrackingType {
  const hit = LOOKUP.get(normalizeName(name))
  if (hit) return hit.tracking
  return heuristicTracking(name, reps, load)
}
