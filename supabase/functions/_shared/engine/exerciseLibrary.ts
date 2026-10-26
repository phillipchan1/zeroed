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
// It is also what makes a swap possible. Every entry carries the movement
// PATTERN it trains and the EQUIPMENT it needs, so "the T-bar is taken" or "the
// hotel gym is two dumbbells and a bench" becomes a ranked list of movements
// that train the same thing with what is actually there (suggestSwaps below).
//
// This is intentionally a closed, code-owned table (doctrine: exercise library
// is hardcoded). Names are matched on a normalized form (case/punctuation/paren
// qualifiers stripped, equipment spellings folded, plurals dropped) plus
// explicit aliases.
// =============================================================================

import type { ExerciseTemplate, TrackingType } from './types.ts'

export type LibraryCategory =
  | 'Lower Chain' | 'Upper Chain' | 'Posterior Chain' | 'Core' | 'Conditioning'

/**
 * What a movement trains, at the grain a substitution cares about. Two entries
 * with the same pattern are interchangeable for a session's purpose; RELATED
 * patterns below are the next-best fallback when the first list runs thin.
 */
export type MovementPattern =
  // lower — knee-dominant
  | 'squat' | 'single_leg' | 'knee_extension' | 'calf'
  // posterior — hip-dominant
  | 'hinge' | 'hip_extension' | 'knee_flexion' | 'back_extension'
  | 'hip_abduction' | 'hip_adduction'
  // upper — press
  | 'horizontal_push' | 'vertical_push' | 'chest_fly'
  // upper — pull
  | 'horizontal_pull' | 'vertical_pull'
  // upper — accessory
  | 'elbow_flexion' | 'elbow_extension' | 'shoulder_raise' | 'rear_delt' | 'scapular' | 'shrug'
  // trunk
  | 'anti_extension' | 'anti_rotation' | 'lateral_core' | 'trunk_flexion' | 'hip_flexion'
  // conditioning / power
  | 'carry' | 'jump' | 'throw' | 'power' | 'sprint' | 'sled' | 'cardio'
  // mobility / prep
  | 'hip_mobility' | 'hamstring_mobility' | 'ankle_mobility' | 'shoulder_mobility'
  | 'thoracic_mobility' | 'recovery'

/**
 * The one implement a movement can't be done without. `bodyweight` needs
 * nothing (a floor, a wall, a chair at most) and is always available; `bar` is
 * anything to hang from — pull-up bar, rings, dip station; `other` is small
 * specialty kit (ab wheel, med ball, jump rope, foam roller).
 */
export type Equipment =
  | 'barbell' | 'dumbbell' | 'kettlebell' | 'cable' | 'machine' | 'band'
  | 'bar' | 'bodyweight' | 'cardio' | 'sled' | 'other'

export interface LibraryExercise {
  name: string                 // canonical display name
  tracking: TrackingType
  category: LibraryCategory
  pattern: MovementPattern
  equipment: Equipment
  unilateral?: boolean         // one side at a time
  aliases?: string[]           // alternate names the agent / coach might emit
  contra?: boolean             // ballistic/maximal — unsafe on an unscreened session
  // A second way this movement is honestly measured. Carries are walked for time
  // OR distance; an erg piece is minutes OR meters. Only an explicit unit in the
  // prescription ("40 yd", "500m") moves an exercise onto it — a bare count never.
  alt?: TrackingType
  noteAs?: string              // borrow this entry's coaching note (a split-off variant)
}

// ---- the table -------------------------------------------------------------
// Grouped by pattern for readability only; order does not matter. Equipment
// variants are separate entries (Barbell Curl ≠ Hammer Curl ≠ Cable Curl) so a
// swap can route around the implement that isn't there.

const LIBRARY: LibraryExercise[] = [
  // ── Lower chain — squat ────────────────────────────────────────────────────
  { name: 'Back Squat',            tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'barbell', aliases: ['barbell back squat', 'high bar squat', 'low bar squat', 'barbell squat', 'squat', 'paused squat', 'pause squat', 'tempo squat'], contra: true },
  { name: 'Front Squat',           tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'barbell', aliases: ['barbell front squat'] },
  { name: 'Goblet Squat',          tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'dumbbell', aliases: ['kb goblet squat', 'db goblet squat', 'heel elevated goblet squat', 'heels elevated goblet squat'] },
  { name: 'Box Squat',             tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'barbell' },
  { name: 'Safety Bar Squat',      tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'barbell', aliases: ['ssb squat', 'safety squat bar squat', 'safety squat'], noteAs: 'Back Squat' },
  { name: 'Zercher Squat',         tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'barbell' },
  { name: 'Landmine Squat',        tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'barbell' },
  { name: 'DB Squat',              tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'dumbbell', aliases: ['db front squat', 'suitcase squat'] },
  { name: 'KB Front Squat',        tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'kettlebell', aliases: ['double kb front squat', 'kb rack squat'] },
  { name: 'Smith Machine Squat',   tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'machine', aliases: ['smith squat'] },
  { name: 'Hack Squat',            tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'machine', aliases: ['machine hack squat', 'hack squat machine'] },
  { name: 'Pendulum Squat',        tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'machine' },
  { name: 'Belt Squat',            tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'machine', aliases: ['belt squat machine'] },
  { name: 'Leg Press',             tracking: 'weight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'machine', aliases: ['45 degree leg press', 'horizontal leg press'] },
  { name: 'Band Squat',            tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'band', aliases: ['banded squat', 'resistance band squat'] },
  { name: 'Air Squat',             tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'squat', equipment: 'bodyweight', aliases: ['bodyweight squat', 'bw squat', 'tempo air squat'] },

  // ── Lower chain — single leg ──────────────────────────────────────────────
  { name: 'Bulgarian Split Squat', tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'dumbbell', unilateral: true, aliases: ['bss', 'rear foot elevated split squat', 'rfess', 'db bulgarian split squat'] },
  { name: 'Split Squat',           tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'dumbbell', unilateral: true, aliases: ['db split squat'] },
  { name: 'Front-Foot Elevated Split Squat', tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'dumbbell', unilateral: true, aliases: ['ffe split squat', 'front foot elevated split squat', 'deficit split squat'], noteAs: 'Bulgarian Split Squat' },
  { name: 'Smith Machine Split Squat', tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'machine', unilateral: true, aliases: ['smith split squat'] },
  { name: 'Step-Up',               tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'dumbbell', unilateral: true, aliases: ['box step up', 'db step up'] },
  { name: 'Walking Lunge',         tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'dumbbell', unilateral: true, aliases: ['db lunge', 'db walking lunge'] },
  { name: 'DB Reverse Lunge',      tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'dumbbell', unilateral: true, aliases: ['db reverse lunges'], noteAs: 'Walking Lunge' },
  { name: 'Barbell Lunge',         tracking: 'weight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'barbell', unilateral: true, aliases: ['barbell reverse lunge', 'barbell walking lunge'], noteAs: 'Walking Lunge' },
  { name: 'Lunge',                 tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true, aliases: ['reverse lunge', 'forward lunge', 'bodyweight lunge', 'bodyweight walking lunge'] },
  { name: 'Lateral Lunge',         tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true, aliases: ['side lunge'] },
  { name: 'Curtsy Lunge',          tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true },
  { name: 'Cossack Squat',         tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true },
  { name: 'Step-Down',             tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true, aliases: ['lateral step down', 'eccentric step down', 'box step down'] },
  { name: 'Skater Squat',          tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true },
  { name: 'Pistol Squat',          tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true, aliases: ['single leg squat', 'box pistol'] },
  { name: 'Isometric Split Squat', tracking: 'time', category: 'Lower Chain', pattern: 'single_leg', equipment: 'bodyweight', unilateral: true, aliases: ['split squat hold', 'iso split squat'] },

  // ── Lower chain — knee extension / quad isolation ─────────────────────────
  { name: 'Leg Extension',         tracking: 'weight_reps', category: 'Lower Chain', pattern: 'knee_extension', equipment: 'machine', aliases: ['knee extension', 'single leg extension'] },
  { name: 'Terminal Knee Extension', tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'knee_extension', equipment: 'band', aliases: ['tke', 'banded tke'] },
  { name: 'Spanish Squat',         tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'knee_extension', equipment: 'band', aliases: ['banded spanish squat'] },
  { name: 'Sissy Squat',           tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'knee_extension', equipment: 'bodyweight' },
  { name: 'Reverse Nordic',        tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'knee_extension', equipment: 'bodyweight', aliases: ['reverse nordic curl'] },
  { name: 'Wall Sit',              tracking: 'time', category: 'Lower Chain', pattern: 'knee_extension', equipment: 'bodyweight', aliases: ['wall squat hold'] },

  // ── Lower chain — calf / lower leg ────────────────────────────────────────
  { name: 'Calf Raise',            tracking: 'weight_reps', category: 'Lower Chain', pattern: 'calf', equipment: 'machine', aliases: ['standing calf raise', 'machine calf raise'] },
  { name: 'Seated Calf Raise',     tracking: 'weight_reps', category: 'Lower Chain', pattern: 'calf', equipment: 'machine', noteAs: 'Calf Raise' },
  { name: 'Leg Press Calf Raise',  tracking: 'weight_reps', category: 'Lower Chain', pattern: 'calf', equipment: 'machine', aliases: ['calf press'], noteAs: 'Calf Raise' },
  { name: 'DB Calf Raise',         tracking: 'weight_reps', category: 'Lower Chain', pattern: 'calf', equipment: 'dumbbell', aliases: ['single leg db calf raise'], noteAs: 'Calf Raise' },
  { name: 'Single-Leg Calf Raise', tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'calf', equipment: 'bodyweight', unilateral: true, aliases: ['bodyweight calf raise', 'step calf raise'], noteAs: 'Calf Raise' },
  { name: 'Tibialis Raise',        tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'calf', equipment: 'bodyweight', aliases: ['tib raise', 'tibia raise', 'wall tib raise'] },

  // ── Posterior chain — hinge ───────────────────────────────────────────────
  { name: 'Deadlift',              tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['conventional deadlift', 'sumo deadlift', 'barbell deadlift', 'deficit deadlift', 'paused deadlift'], contra: true },
  { name: 'Trap Bar Deadlift',     tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['hex bar deadlift', 'trap bar dl'] },
  { name: 'Romanian Deadlift',     tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['rdl', 'barbell rdl'] },
  { name: 'DB Romanian Deadlift',  tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'dumbbell', aliases: ['db rdl'], noteAs: 'Romanian Deadlift' },
  { name: 'Stiff-Leg Deadlift',    tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['sldl', 'stiff legged deadlift'], noteAs: 'Romanian Deadlift' },
  { name: 'Rack Pull',             tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['block pull'] },
  { name: 'KB Deadlift',           tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'kettlebell', aliases: ['kb sumo deadlift'] },
  { name: 'Single-Leg RDL',        tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'dumbbell', unilateral: true, aliases: ['single leg romanian deadlift', 'sl rdl', 'db single leg rdl', 'kb single leg rdl'] },
  { name: 'Bodyweight Single-Leg RDL', tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'bodyweight', unilateral: true, aliases: ['bw single leg rdl', 'bodyweight sl rdl', 'single leg reach'], noteAs: 'Single-Leg RDL' },
  { name: 'Good Morning',          tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['barbell good morning'] },
  { name: 'Band Good Morning',     tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'band', aliases: ['banded good morning'], noteAs: 'Good Morning' },
  { name: 'Cable Pull-Through',    tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'cable', aliases: ['pull through', 'cable pull through'] },
  { name: 'Kettlebell Swing',      tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'kettlebell', aliases: ['kb swing', 'russian swing', 'two hand kb swing', 'db swing'] },
  { name: 'Hip Hinge (Dowel)',     tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hinge', equipment: 'bodyweight', aliases: ['hip hinge', 'dowel hip hinge'] },
  { name: 'Isometric Mid-Thigh Pull', tracking: 'time', category: 'Posterior Chain', pattern: 'hinge', equipment: 'barbell', aliases: ['imtp', 'iso mid thigh pull'] },

  // ── Posterior chain — hip extension / glutes ──────────────────────────────
  { name: 'Hip Thrust',            tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'barbell', aliases: ['barbell hip thrust', 'loaded glute bridge', 'barbell glute bridge'] },
  { name: 'DB Hip Thrust',         tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'dumbbell', noteAs: 'Hip Thrust' },
  { name: 'Machine Hip Thrust',    tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'machine', aliases: ['hip thrust machine', 'glute drive'], noteAs: 'Hip Thrust' },
  { name: 'Single-Leg Hip Thrust', tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'bodyweight', unilateral: true },
  { name: 'Glute Bridge',          tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'bodyweight', aliases: ['bodyweight glute bridge', 'banded glute bridge'] },
  { name: 'Single-Leg Glute Bridge', tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'bodyweight', unilateral: true, aliases: ['sl glute bridge'], noteAs: 'Glute Bridge' },
  { name: 'Frog Pump',             tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'bodyweight' },
  { name: 'Supine Hip Extension',  tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'bodyweight' },
  { name: 'Cable Kickback',        tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'hip_extension', equipment: 'cable', unilateral: true, aliases: ['glute kickback', 'cable glute kickback'] },

  // ── Posterior chain — knee flexion / hamstrings ───────────────────────────
  { name: 'Leg Curl',              tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'machine', aliases: ['hamstring curl', 'lying leg curl', 'seated leg curl', 'machine leg curl'] },
  { name: 'Glute-Ham Raise',       tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'machine', aliases: ['ghr', 'glute ham raise', 'ghd raise'] },
  { name: 'Nordic Curl',           tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'bodyweight', aliases: ['nordic hamstring curl', 'nordic curl (eccentric)', 'nordic'] },
  { name: 'Slider Leg Curl',       tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'bodyweight', aliases: ['sliding leg curl', 'towel leg curl', 'slider hamstring curl'] },
  { name: 'Swiss Ball Leg Curl',   tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'other', aliases: ['stability ball leg curl', 'ball leg curl', 'swiss ball hamstring curl'] },
  { name: 'Band Leg Curl',         tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'band', aliases: ['band hamstring curl', 'banded leg curl'] },
  { name: 'DB Leg Curl',           tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'knee_flexion', equipment: 'dumbbell', aliases: ['prone db leg curl'] },

  // ── Posterior chain — back extension ──────────────────────────────────────
  { name: 'Back Extension',        tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'back_extension', equipment: 'machine', aliases: ['hyperextension', '45 degree back extension', 'roman chair back extension'] },
  { name: 'Reverse Hyper',         tracking: 'weight_reps', category: 'Posterior Chain', pattern: 'back_extension', equipment: 'machine', aliases: ['reverse hyperextension'] },
  { name: 'Superman',              tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'back_extension', equipment: 'bodyweight', aliases: ['prone superman', 'floor back extension'] },

  // ── Lower chain — hip abduction / adduction ───────────────────────────────
  { name: 'Lateral Band Walk',     tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_abduction', equipment: 'band', aliases: ['banded lateral walk', 'monster walk', 'band walk'] },
  { name: 'Clamshell',             tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_abduction', equipment: 'band', unilateral: true, aliases: ['clam shell', 'banded clamshell'] },
  { name: 'Side-Lying Hip Abduction', tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_abduction', equipment: 'bodyweight', unilateral: true, aliases: ['side lying leg raise', 'side lying hip abduction'] },
  { name: 'Hip Abduction Machine', tracking: 'weight_reps', category: 'Lower Chain', pattern: 'hip_abduction', equipment: 'machine', aliases: ['hip abduction', 'abductor machine', 'seated hip abduction'] },
  { name: 'Cable Hip Abduction',   tracking: 'weight_reps', category: 'Lower Chain', pattern: 'hip_abduction', equipment: 'cable', unilateral: true, aliases: ['standing cable abduction'] },
  { name: 'Hip Adduction Machine', tracking: 'weight_reps', category: 'Lower Chain', pattern: 'hip_adduction', equipment: 'machine', aliases: ['hip adduction', 'adductor machine', 'seated hip adduction'] },
  { name: 'Adductor Squeeze',      tracking: 'time', category: 'Lower Chain', pattern: 'hip_adduction', equipment: 'bodyweight', aliases: ['ball squeeze', 'adductor ball squeeze'] },

  // ── Upper chain — horizontal press ────────────────────────────────────────
  { name: 'Bench Press',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'barbell', aliases: ['barbell bench press', 'flat bench', 'paused bench press', 'flat barbell bench'] },
  { name: 'DB Bench Press',        tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'dumbbell', aliases: ['db bench', 'db bench (unilateral)', 'unilateral db bench', 'flat db press'] },
  { name: 'Incline Bench Press',   tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'barbell', aliases: ['incline bench', 'incline barbell press'] },
  { name: 'Incline DB Press',      tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'dumbbell', aliases: ['incline db bench', 'incline db bench press'], noteAs: 'Incline Bench Press' },
  { name: 'Close-Grip Bench Press', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'barbell', aliases: ['cgbp', 'close grip bench'], noteAs: 'Bench Press' },
  { name: 'Floor Press',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'barbell', aliases: ['barbell floor press'] },
  { name: 'DB Floor Press',        tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'dumbbell' },
  { name: 'KB Floor Press',        tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'kettlebell', unilateral: true },
  { name: 'Machine Chest Press',   tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'machine', aliases: ['chest press', 'chest press machine', 'hammer strength chest press', 'seated chest press'] },
  { name: 'Smith Machine Bench Press', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'machine', aliases: ['smith bench', 'smith bench press'] },
  { name: 'Cable Chest Press',     tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'cable', aliases: ['standing cable chest press', 'cable press'] },
  { name: 'Band Chest Press',      tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'band', aliases: ['banded chest press', 'resistance band chest press'] },
  { name: 'Push-Up',               tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'bodyweight', aliases: ['tempo push up'] },
  { name: 'Incline Push-Up',       tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'bodyweight', aliases: ['hands elevated push up'], noteAs: 'Push-Up' },
  { name: 'Decline Push-Up',       tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'bodyweight', aliases: ['feet elevated push up'], noteAs: 'Push-Up' },
  { name: 'Deficit Push-Up',       tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'bodyweight', aliases: ['push up on handles', 'parallette push up'], noteAs: 'Push-Up' },
  { name: 'Dip',                   tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'bar', aliases: ['parallel bar dip', 'tricep dip', 'chest dip', 'ring dip'] },
  { name: 'Bench Setup Holds',     tracking: 'time', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'barbell', aliases: ['bench setup holds (barbell or empty bar)', 'setup hold'] },
  { name: 'Isometric Press',       tracking: 'time', category: 'Upper Chain', pattern: 'horizontal_push', equipment: 'barbell', aliases: ['isometric press (mid-range set)', 'iso press', 'pin press hold'] },

  // ── Upper chain — chest fly ───────────────────────────────────────────────
  { name: 'DB Fly',                tracking: 'weight_reps', category: 'Upper Chain', pattern: 'chest_fly', equipment: 'dumbbell', aliases: ['db flye', 'chest fly', 'flat db fly', 'incline db fly'] },
  { name: 'Cable Fly',             tracking: 'weight_reps', category: 'Upper Chain', pattern: 'chest_fly', equipment: 'cable', aliases: ['cable crossover', 'cable flye', 'cable chest fly'] },
  { name: 'Pec Deck',              tracking: 'weight_reps', category: 'Upper Chain', pattern: 'chest_fly', equipment: 'machine', aliases: ['pec fly machine', 'machine fly', 'pec deck fly', 'machine chest fly'] },
  { name: 'Band Chest Fly',        tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'chest_fly', equipment: 'band', aliases: ['band fly', 'banded chest fly'] },

  // ── Upper chain — vertical press ──────────────────────────────────────────
  { name: 'Overhead Press',        tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'barbell', aliases: ['ohp', 'strict press', 'strict ohp', 'military press', 'barbell overhead press', 'standing press'] },
  { name: 'DB Shoulder Press',     tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'dumbbell', aliases: ['seated db press', 'db overhead press', 'standing db press'] },
  { name: 'Arnold Press',          tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'dumbbell', noteAs: 'DB Shoulder Press' },
  { name: 'Half-Kneeling DB Press', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'dumbbell', unilateral: true, aliases: ['half kneeling overhead press', 'half kneeling single arm press'], noteAs: 'DB Shoulder Press' },
  { name: 'Push Press',            tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'barbell' },
  { name: 'Landmine Press',        tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'barbell', unilateral: true, aliases: ['half kneeling landmine press', 'single arm landmine press'] },
  { name: 'KB Overhead Press',     tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'kettlebell', unilateral: true, aliases: ['kb press', 'kb strict press'] },
  { name: 'Bottom-Up KB Press',    tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'kettlebell', unilateral: true, aliases: ['bottoms up kb press', 'bottom up kb press'] },
  { name: 'Machine Shoulder Press', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'machine', aliases: ['shoulder press machine', 'machine overhead press', 'smith machine overhead press'] },
  { name: 'Band Overhead Press',   tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'band', aliases: ['band shoulder press', 'banded overhead press'] },
  { name: 'Pike Push-Up',          tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'bodyweight', aliases: ['pike press', 'feet elevated pike push up'] },
  { name: 'Handstand Push-Up',     tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_push', equipment: 'bodyweight', aliases: ['hspu', 'wall handstand push up'] },

  // ── Upper chain — horizontal pull ─────────────────────────────────────────
  { name: 'Barbell Row',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'barbell', aliases: ['bent over row', 'pendlay row', 'yates row', 'underhand row', 'barbell bent over row'] },
  { name: 'T-Bar Row',             tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'barbell', aliases: ['tbar row', 't row', 't row bar', 't bar', 'landmine row', 'landmine t bar row', 'chest supported t bar row', 'machine t bar row'], noteAs: 'Barbell Row' },
  { name: 'Meadows Row',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'barbell', unilateral: true, aliases: ['single arm landmine row'], noteAs: 'DB Row' },
  { name: 'DB Row',                tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'dumbbell', unilateral: true, aliases: ['single arm row', 'one arm row', 'single arm db row', 'kroc row', 'bench supported db row'] },
  { name: 'Chest-Supported Row',   tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'dumbbell', aliases: ['chest supported db row', 'csr', 'seal row'] },
  { name: 'Incline DB Row',        tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'dumbbell', noteAs: 'Chest-Supported Row' },
  { name: 'Renegade Row',          tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'dumbbell', unilateral: true },
  { name: 'KB Row',                tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'kettlebell', unilateral: true, aliases: ['single arm kb row'], noteAs: 'DB Row' },
  { name: 'Cable Row',             tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'cable', aliases: ['seated cable row', 'seated row', 'low row'] },
  { name: 'Single-Arm Cable Row',  tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'cable', unilateral: true, aliases: ['single arm cable row', 'half kneeling cable row'], noteAs: 'Cable Row' },
  { name: 'Machine Row',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'machine', aliases: ['seated machine row', 'hammer strength row', 'chest supported machine row', 'iso lateral row', 'plate loaded row'] },
  { name: 'Band Row',              tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'band', aliases: ['banded row', 'resistance band row', 'band seated row'] },
  { name: 'Inverted Row',          tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'bar', aliases: ['ring row', 'bodyweight row', 'trx row', 'suspension row', 'australian pull up'] },
  { name: 'Doorway Row',           tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'horizontal_pull', equipment: 'bodyweight', aliases: ['door row', 'towel row', 'doorframe row', 'table row'] },

  // ── Upper chain — vertical pull ───────────────────────────────────────────
  { name: 'Pull-Up',               tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'bar', aliases: ['wide grip pull up', 'neutral grip pull up'] },
  { name: 'Chin-Up',               tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'bar' },
  { name: 'Negative Pull-Up',      tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'bar', aliases: ['eccentric pull up', 'pull up negative', 'negative chin up'], noteAs: 'Pull-Up' },
  { name: 'Assisted Pull-Up',      tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'machine', aliases: ['machine assisted pull up', 'assisted chin up', 'band assisted pull up'], noteAs: 'Pull-Up' },
  { name: 'Lat Pulldown',          tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'cable', aliases: ['pulldown', 'wide grip pulldown', 'close grip pulldown', 'neutral grip pulldown'] },
  { name: 'Single-Arm Lat Pulldown', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'cable', unilateral: true, aliases: ['single arm pulldown', 'half kneeling single arm pulldown'], noteAs: 'Lat Pulldown' },
  { name: 'Band Lat Pulldown',     tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'band', aliases: ['band pulldown', 'kneeling band pulldown'], noteAs: 'Lat Pulldown' },
  { name: 'Straight-Arm Pulldown', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'cable', aliases: ['lat pushdown', 'straight arm lat pulldown', 'cable pullover'] },
  { name: 'DB Pullover',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'vertical_pull', equipment: 'dumbbell', aliases: ['pullover'] },

  // ── Upper chain — arms ────────────────────────────────────────────────────
  { name: 'Bicep Curl',            tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'dumbbell', aliases: ['db curl', 'curl', 'biceps curl', 'db bicep curl', 'alternating db curl'] },
  { name: 'Barbell Curl',          tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'barbell', aliases: ['ez bar curl', 'ez curl', 'bb curl'], noteAs: 'Bicep Curl' },
  { name: 'Hammer Curl',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'dumbbell', aliases: ['db hammer curl', 'cross body hammer curl'], noteAs: 'Bicep Curl' },
  { name: 'Incline DB Curl',       tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'dumbbell', aliases: ['incline curl'], noteAs: 'Bicep Curl' },
  { name: 'Preacher Curl',         tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'barbell', aliases: ['ez bar preacher curl', 'machine preacher curl', 'db preacher curl'], noteAs: 'Bicep Curl' },
  { name: 'Concentration Curl',    tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'dumbbell', unilateral: true, noteAs: 'Bicep Curl' },
  { name: 'Cable Curl',            tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'cable', aliases: ['cable bicep curl', 'rope hammer curl', 'bayesian curl'], noteAs: 'Bicep Curl' },
  { name: 'Band Curl',             tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'elbow_flexion', equipment: 'band', aliases: ['banded curl', 'resistance band curl', 'band bicep curl'], noteAs: 'Bicep Curl' },
  { name: 'Tricep Extension',      tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'dumbbell', aliases: ['triceps extension', 'db tricep extension'] },
  { name: 'Tricep Pushdown',       tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'cable', aliases: ['triceps pushdown', 'rope pushdown', 'cable pushdown', 'pushdown', 'rope tricep pushdown', 'v bar pushdown'], noteAs: 'Tricep Extension' },
  { name: 'Skull Crusher',         tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'barbell', aliases: ['skullcrusher', 'lying tricep extension', 'ez bar skull crusher', 'db skull crusher'], noteAs: 'Tricep Extension' },
  { name: 'Overhead Tricep Extension', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'dumbbell', aliases: ['db overhead extension', 'french press', 'overhead triceps extension'], noteAs: 'Tricep Extension' },
  { name: 'Cable Overhead Tricep Extension', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'cable', aliases: ['cable overhead extension', 'rope overhead extension', 'rope overhead tricep extension'], noteAs: 'Tricep Extension' },
  { name: 'DB Kickback',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'dumbbell', unilateral: true, aliases: ['tricep kickback', 'triceps kickback'], noteAs: 'Tricep Extension' },
  { name: 'Band Tricep Pushdown',  tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'band', aliases: ['band pushdown', 'banded tricep pushdown', 'band tricep extension'], noteAs: 'Tricep Extension' },
  { name: 'Bench Dip',             tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'bodyweight', aliases: ['chair dip', 'bench dips', 'bodyweight dip'] },
  { name: 'Diamond Push-Up',       tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'elbow_extension', equipment: 'bodyweight', aliases: ['close grip push up', 'triangle push up'], noteAs: 'Push-Up' },

  // ── Upper chain — delts / shrug ───────────────────────────────────────────
  { name: 'Lateral Raise',         tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shoulder_raise', equipment: 'dumbbell', aliases: ['side raise', 'db lateral raise', 'lateral raises'] },
  { name: 'Cable Lateral Raise',   tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shoulder_raise', equipment: 'cable', unilateral: true, aliases: ['single arm cable lateral raise'], noteAs: 'Lateral Raise' },
  { name: 'Machine Lateral Raise', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shoulder_raise', equipment: 'machine', aliases: ['lateral raise machine'], noteAs: 'Lateral Raise' },
  { name: 'Band Lateral Raise',    tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'shoulder_raise', equipment: 'band', aliases: ['banded lateral raise'], noteAs: 'Lateral Raise' },
  { name: 'Front Raise',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shoulder_raise', equipment: 'dumbbell', aliases: ['db front raise', 'plate front raise', 'plate raise'] },
  { name: 'Upright Row',           tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shoulder_raise', equipment: 'barbell', aliases: ['cable upright row', 'db upright row', 'barbell upright row'] },
  { name: 'Rear Delt Fly',         tracking: 'weight_reps', category: 'Upper Chain', pattern: 'rear_delt', equipment: 'dumbbell', aliases: ['reverse fly', 'rear delt raise', 'bent over reverse fly', 'db rear delt fly'] },
  { name: 'Reverse Pec Deck',      tracking: 'weight_reps', category: 'Upper Chain', pattern: 'rear_delt', equipment: 'machine', aliases: ['rear delt machine', 'reverse fly machine', 'machine rear delt fly'], noteAs: 'Rear Delt Fly' },
  { name: 'Cable Rear Delt Fly',   tracking: 'weight_reps', category: 'Upper Chain', pattern: 'rear_delt', equipment: 'cable', aliases: ['cable reverse fly', 'cable rear delt'], noteAs: 'Rear Delt Fly' },
  { name: 'Face Pull',             tracking: 'weight_reps', category: 'Upper Chain', pattern: 'rear_delt', equipment: 'cable', aliases: ['cable face pull', 'rope face pull'] },
  { name: 'Band Face Pull',        tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'rear_delt', equipment: 'band', aliases: ['banded face pull'], noteAs: 'Face Pull' },
  { name: 'Band Pull-Apart',       tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'rear_delt', equipment: 'band', aliases: ['band pull-apart (light)', 'pull apart', 'banded pull apart'] },
  { name: 'Barbell Shrug',         tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shrug', equipment: 'barbell', aliases: ['shrug', 'bb shrug', 'trap bar shrug'] },
  { name: 'DB Shrug',              tracking: 'weight_reps', category: 'Upper Chain', pattern: 'shrug', equipment: 'dumbbell' },

  // ── Upper chain — scapular / rotator cuff / serratus ──────────────────────
  { name: 'DB External Rotation',  tracking: 'weight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'dumbbell', aliases: ['external rotation', 'cuff external rotation', 'side lying external rotation', 'side lying db external rotation'] },
  { name: 'Band External Rotation', tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'band', aliases: ['banded external rotation', 'band er', 'band shoulder external rotation'], noteAs: 'DB External Rotation' },
  { name: 'Cable External Rotation', tracking: 'weight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'cable', unilateral: true, aliases: ['cable er'], noteAs: 'DB External Rotation' },
  { name: 'Trap-3 Raise',          tracking: 'weight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'dumbbell', aliases: ['trap 3 raise', 'prone trap raise'] },
  { name: 'Prone Y-T-W',           tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'bodyweight', aliases: ['ytw', 'y t w', 'prone ytw', 'y t w raise', 'prone y raise', 'blackburns'] },
  { name: 'Push-Up Plus',          tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'bodyweight', aliases: ['scapular push-up plus'] },
  { name: 'Scapular Push-Up',      tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'bodyweight', aliases: ['scap push up'] },
  { name: 'Scap Pull-Up',          tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'bar', aliases: ['scapular pull up', 'scap pull'] },
  { name: 'Wall Slide',            tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'bodyweight', aliases: ['wall slides', 'wall angel', 'wall angels'] },
  { name: 'Serratus Wall Slide',   tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'scapular', equipment: 'bodyweight', aliases: ['foam roller wall slide'] },

  // ── Shoulder / thoracic mobility ──────────────────────────────────────────
  { name: 'Shoulder CARs',         tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'shoulder_mobility', equipment: 'bodyweight', aliases: ['shoulder controlled articular rotations'] },
  { name: 'Band Dislocate',        tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'shoulder_mobility', equipment: 'band', aliases: ['band pass through', 'shoulder dislocates', 'pass throughs', 'dowel pass through'] },
  { name: 'Sleeper Stretch',       tracking: 'time', category: 'Upper Chain', pattern: 'shoulder_mobility', equipment: 'bodyweight', aliases: ['cross body stretch', 'posterior capsule stretch'] },
  { name: 'Lat Stretch',           tracking: 'time', category: 'Upper Chain', pattern: 'shoulder_mobility', equipment: 'bodyweight', aliases: ['bench lat stretch', 'childs pose', 'child pose', 'prayer stretch'] },
  { name: 'Pec Stretch',           tracking: 'time', category: 'Upper Chain', pattern: 'shoulder_mobility', equipment: 'bodyweight', aliases: ['doorway pec stretch', 'doorframe pec stretch', 'chest stretch'] },
  { name: 'Dead Hang',             tracking: 'time', category: 'Upper Chain', pattern: 'shoulder_mobility', equipment: 'bar', aliases: ['active hang', 'bar hang', 'passive hang'] },
  { name: 'Thoracic Rotation',     tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'thoracic_mobility', equipment: 'bodyweight', aliases: ['t-spine rotation', 'open book', 'quadruped thoracic rotation', 'thread the needle'] },
  { name: 'Thoracic Extension Over Foam Roller', tracking: 'bodyweight_reps', category: 'Upper Chain', pattern: 'thoracic_mobility', equipment: 'other', aliases: ['thoracic extension', 'foam roller thoracic extension', 't spine extension'] },

  // ── Core — anti-extension ─────────────────────────────────────────────────
  { name: 'Plank',                 tracking: 'time', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['front plank', 'forearm plank', 'high plank', 'weighted plank'] },
  { name: 'RKC Plank',             tracking: 'time', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['hardstyle plank'], noteAs: 'Plank' },
  { name: 'Hollow Body Hold',      tracking: 'time', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['hollow hold', 'hollow body'] },
  { name: 'Hollow Rock',           tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['hollow body rock'] },
  { name: 'Dead Bug',              tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['banded dead bug', 'weighted dead bug'] },
  { name: 'McGill Curl-Up',        tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['mcgill curl up', 'curl-up'] },
  { name: 'Ab Wheel',              tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'other', aliases: ['ab rollout', 'wheel rollout', 'ab wheel rollout', 'kneeling ab wheel'] },
  { name: 'Barbell Rollout',       tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'barbell', aliases: ['barbell ab rollout'], noteAs: 'Ab Wheel' },
  { name: 'Stir the Pot',          tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'other' },
  { name: 'Plank Shoulder Tap',    tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', aliases: ['shoulder taps', 'plank taps'] },
  { name: 'Bear Crawl',            tracking: 'distance', category: 'Core', pattern: 'anti_extension', equipment: 'bodyweight', alt: 'time', aliases: ['bear crawls', 'bear hold'] },

  // ── Core — anti-rotation / lateral ────────────────────────────────────────
  { name: 'Pallof Press',          tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_rotation', equipment: 'band', aliases: ['banded pallof press', 'cable pallof press', 'half kneeling pallof press', 'pallof hold'] },
  { name: 'Bird Dog',              tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_rotation', equipment: 'bodyweight', aliases: ['quadruped bird dog'] },
  { name: 'Cable Chop',            tracking: 'weight_reps', category: 'Core', pattern: 'anti_rotation', equipment: 'cable', aliases: ['wood chop', 'woodchop', 'cable woodchop', 'half kneeling cable chop', 'high to low chop'] },
  { name: 'Cable Lift',            tracking: 'weight_reps', category: 'Core', pattern: 'anti_rotation', equipment: 'cable', aliases: ['half kneeling cable lift', 'low to high chop'] },
  { name: 'Landmine Rotation',     tracking: 'weight_reps', category: 'Core', pattern: 'anti_rotation', equipment: 'barbell', aliases: ['landmine twist', 'landmine rainbow'] },
  { name: 'Russian Twist',         tracking: 'bodyweight_reps', category: 'Core', pattern: 'anti_rotation', equipment: 'bodyweight', aliases: ['seated twist'] },
  { name: 'Side Plank',            tracking: 'time', category: 'Core', pattern: 'lateral_core', equipment: 'bodyweight', aliases: ['side plank hold', 'forearm side plank'] },
  { name: 'Copenhagen Plank',      tracking: 'time', category: 'Core', pattern: 'lateral_core', equipment: 'bodyweight', aliases: ['copenhagen', 'copenhagen adductor plank', 'copenhagen side plank'] },
  { name: 'DB Side Bend',          tracking: 'weight_reps', category: 'Core', pattern: 'lateral_core', equipment: 'dumbbell', unilateral: true, aliases: ['side bend', 'suitcase side bend'] },
  { name: 'Turkish Get-Up',        tracking: 'weight_reps', category: 'Core', pattern: 'lateral_core', equipment: 'kettlebell', unilateral: true, aliases: ['tgu', 'get up', 'turkish getup', 'half get up'] },

  // ── Core — flexion ────────────────────────────────────────────────────────
  { name: 'Sit-Up',                tracking: 'bodyweight_reps', category: 'Core', pattern: 'trunk_flexion', equipment: 'bodyweight', aliases: ['crunch', 'decline sit up', 'weighted sit up'] },
  { name: 'Cable Crunch',          tracking: 'weight_reps', category: 'Core', pattern: 'trunk_flexion', equipment: 'cable', aliases: ['kneeling cable crunch', 'rope crunch'] },
  { name: 'Reverse Crunch',        tracking: 'bodyweight_reps', category: 'Core', pattern: 'trunk_flexion', equipment: 'bodyweight', aliases: ['bench reverse crunch'] },
  { name: 'V-Up',                  tracking: 'bodyweight_reps', category: 'Core', pattern: 'trunk_flexion', equipment: 'bodyweight', aliases: ['v sit up', 'jackknife'] },
  { name: 'Hanging Leg Raise',     tracking: 'bodyweight_reps', category: 'Core', pattern: 'hip_flexion', equipment: 'bar', aliases: ['hanging straight leg raise'] },
  { name: 'Hanging Knee Raise',    tracking: 'bodyweight_reps', category: 'Core', pattern: 'hip_flexion', equipment: 'bar', aliases: ['knee raise'], noteAs: 'Hanging Leg Raise' },
  { name: "Captain's Chair Knee Raise", tracking: 'bodyweight_reps', category: 'Core', pattern: 'hip_flexion', equipment: 'machine', aliases: ['captains chair', 'captains chair leg raise', 'roman chair leg raise', 'vertical knee raise'], noteAs: 'Hanging Leg Raise' },
  { name: 'Toes-to-Bar',           tracking: 'bodyweight_reps', category: 'Core', pattern: 'hip_flexion', equipment: 'bar', aliases: ['t2b', 'toes to bar'] },
  { name: 'Lying Leg Raise',       tracking: 'bodyweight_reps', category: 'Core', pattern: 'hip_flexion', equipment: 'bodyweight', aliases: ['leg raise', 'supine leg raise', 'bench leg raise'] },
  { name: 'Diaphragmatic Breathing', tracking: 'time', category: 'Core', pattern: 'recovery', equipment: 'bodyweight', aliases: ['breathing', 'breathing + rib/lat expansion', '90/90 breathing', 'rib lat expansion', 'crocodile breathing', 'box breathing'] },

  // ── Hip / ankle / hamstring mobility ──────────────────────────────────────
  { name: 'Ankle CARs',            tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'ankle_mobility', equipment: 'bodyweight', aliases: ['ankle circles'] },
  { name: 'Knee-to-Wall Ankle Mobilization', tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'ankle_mobility', equipment: 'bodyweight', aliases: ['knee to wall', 'ankle rocks', 'ankle dorsiflexion mobilization', 'banded ankle mobilization'] },
  { name: 'Calf Stretch',          tracking: 'time', category: 'Lower Chain', pattern: 'ankle_mobility', equipment: 'bodyweight', aliases: ['wall calf stretch', 'soleus stretch'] },
  { name: 'Hip 90/90 Stretch',     tracking: 'time', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['90/90 hip stretch', '90/90 hip ir hold', 'hip 90/90'] },
  { name: 'Hip Flexor Stretch',    tracking: 'time', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['couch stretch', 'half-kneel hip flexor', 'supine hip flexor stretch', 'kneeling hip flexor stretch'] },
  { name: 'Pigeon Stretch',        tracking: 'time', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['pigeon pose', 'figure 4 stretch', 'figure four stretch'] },
  { name: 'Frog Stretch',          tracking: 'time', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['frog pose'] },
  { name: 'Adductor Rockback',     tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['adductor rock back', 'frog rockback'] },
  { name: 'Deep Squat Hold',       tracking: 'time', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['squat hold', 'deep squat sit', 'bottom squat hold'] },
  { name: 'Hip CARs',              tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['hip controlled articular rotations'] },
  { name: 'Hip Airplane',          tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', unilateral: true },
  { name: 'Spiderman Lunge',       tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['spiderman stretch', 'lunge with rotation'] },
  { name: "World's Greatest Stretch", tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['worlds greatest stretch', 'wgs'] },
  { name: 'Leg Swing',             tracking: 'bodyweight_reps', category: 'Lower Chain', pattern: 'hip_mobility', equipment: 'bodyweight', aliases: ['front to back leg swing', 'lateral leg swing'] },
  { name: 'Cat-Cow',               tracking: 'bodyweight_reps', category: 'Core', pattern: 'thoracic_mobility', equipment: 'bodyweight' },
  { name: 'Hamstring Stretch',     tracking: 'time', category: 'Posterior Chain', pattern: 'hamstring_mobility', equipment: 'bodyweight', aliases: ['hamstring stretch (90/90)', 'standing hamstring stretch', 'supine hamstring stretch'] },
  { name: 'Active Straight-Leg Raise', tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hamstring_mobility', equipment: 'bodyweight', aliases: ['aslr', 'active straight leg raise drill'] },
  { name: 'Inchworm',              tracking: 'bodyweight_reps', category: 'Posterior Chain', pattern: 'hamstring_mobility', equipment: 'bodyweight', aliases: ['inch worm', 'walkout'] },
  { name: 'Foam Roll',             tracking: 'time', category: 'Core', pattern: 'recovery', equipment: 'other', aliases: ['foam rolling', 'foam roller', 'smr', 'self myofascial release'] },

  // ── Carries ───────────────────────────────────────────────────────────────
  { name: 'Farmer Carry',          tracking: 'time', category: 'Conditioning', pattern: 'carry', equipment: 'dumbbell', alt: 'distance', aliases: ['farmers carry', 'loaded carry', 'farmer walk', 'farmers walk', 'kb farmer carry'] },
  { name: 'Suitcase Carry',        tracking: 'time', category: 'Core', pattern: 'carry', equipment: 'dumbbell', unilateral: true, alt: 'distance', aliases: ['single arm carry', 'single arm farmer carry', 'suitcase walk'], noteAs: 'Farmer Carry' },
  { name: 'Trap Bar Carry',        tracking: 'time', category: 'Conditioning', pattern: 'carry', equipment: 'barbell', alt: 'distance', aliases: ['trap bar farmer carry'], noteAs: 'Farmer Carry' },
  { name: 'Front Rack Carry',      tracking: 'time', category: 'Core', pattern: 'carry', equipment: 'kettlebell', alt: 'distance', aliases: ['rack carry', 'kb rack carry', 'front rack walk'] },
  { name: 'Overhead Carry',        tracking: 'time', category: 'Core', pattern: 'carry', equipment: 'kettlebell', alt: 'distance', aliases: ['waiter carry', 'waiters walk', 'overhead walk', 'bottoms up carry'] },
  { name: 'Sandbag Carry',         tracking: 'time', category: 'Conditioning', pattern: 'carry', equipment: 'other', alt: 'distance', aliases: ['bear hug carry', 'sandbag bear hug carry'] },

  // ── Conditioning — jumps / throws / power (often contraindicated unscreened) ─
  { name: 'Broad Jump',            tracking: 'distance', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', aliases: ['standing long jump', 'long jump'], contra: true },
  { name: 'Vertical Jump',         tracking: 'distance', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', aliases: ['vertical leap', 'countermovement jump', 'cmj'], contra: true },
  { name: 'Box Jump',              tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', contra: true },
  { name: 'Depth Jump',            tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', aliases: ['drop jump'], contra: true },
  { name: 'Squat Jump',            tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', aliases: ['jump squat'], contra: true },
  { name: 'Lateral Bound',         tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', aliases: ['skater jump', 'skater bound', 'lateral hop'], contra: true },
  { name: 'Pogo Jump',             tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'jump', equipment: 'bodyweight', alt: 'time', aliases: ['pogo', 'pogo hop', 'ankle hop'], contra: true },
  { name: 'Med Ball Slam',         tracking: 'weight_reps', category: 'Conditioning', pattern: 'throw', equipment: 'other', aliases: ['ball slam', 'slam ball', 'medicine ball slam'] },
  { name: 'Med Ball Chest Pass',   tracking: 'weight_reps', category: 'Conditioning', pattern: 'throw', equipment: 'other', aliases: ['chest pass', 'med ball chest throw'] },
  { name: 'Med Ball Rotational Throw', tracking: 'weight_reps', category: 'Conditioning', pattern: 'throw', equipment: 'other', unilateral: true, aliases: ['rotational med ball throw', 'med ball scoop toss', 'scoop toss'] },
  { name: 'Power Clean',           tracking: 'weight_reps', category: 'Conditioning', pattern: 'power', equipment: 'barbell', aliases: ['clean', 'squat clean'], contra: true },
  { name: 'Hang Power Clean',      tracking: 'weight_reps', category: 'Conditioning', pattern: 'power', equipment: 'barbell', aliases: ['hang clean'], contra: true },
  { name: 'Kettlebell Clean',      tracking: 'weight_reps', category: 'Conditioning', pattern: 'power', equipment: 'kettlebell', unilateral: true, aliases: ['kb clean'], contra: true },
  { name: 'Kettlebell Snatch',     tracking: 'weight_reps', category: 'Conditioning', pattern: 'power', equipment: 'kettlebell', unilateral: true, aliases: ['kb snatch'], contra: true },
  { name: 'DB Snatch',             tracking: 'weight_reps', category: 'Conditioning', pattern: 'power', equipment: 'dumbbell', unilateral: true, aliases: ['single arm db snatch'], contra: true },
  { name: 'Thruster',              tracking: 'weight_reps', category: 'Conditioning', pattern: 'power', equipment: 'barbell', aliases: ['db thruster', 'barbell thruster'] },

  // ── Conditioning — sprint / sled / machines ───────────────────────────────
  { name: 'Sprint',                tracking: 'distance', category: 'Conditioning', pattern: 'sprint', equipment: 'bodyweight', alt: 'time', aliases: ['sprints', 'dash', '40 yard dash', 'court sprint', 'flying sprint'], contra: true },
  { name: 'Hill Sprint',           tracking: 'distance', category: 'Conditioning', pattern: 'sprint', equipment: 'bodyweight', alt: 'time', aliases: ['hill sprints', 'hill run'], contra: true },
  { name: 'Shuttle Run',           tracking: 'distance', category: 'Conditioning', pattern: 'sprint', equipment: 'bodyweight', alt: 'time', aliases: ['shuttle', 'suicides', 'pro agility', '5 10 5'], contra: true },
  { name: 'Sled Push',             tracking: 'distance', category: 'Conditioning', pattern: 'sled', equipment: 'sled', alt: 'time', aliases: ['prowler push', 'prowler'] },
  { name: 'Sled Drag',             tracking: 'distance', category: 'Conditioning', pattern: 'sled', equipment: 'sled', alt: 'time', aliases: ['sled pull', 'backward sled drag', 'reverse sled drag'] },
  { name: 'Rowing Machine',        tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', alt: 'distance', aliases: ['row erg', 'erg row', 'rower', 'erg', 'concept2', 'concept 2', 'concept2 row', 'rowing', 'indoor row', 'ergometer'] },
  { name: 'Assault Bike',          tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', aliases: ['echo bike', 'air bike', 'airdyne', 'fan bike'] },
  { name: 'Stationary Bike',       tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', alt: 'distance', aliases: ['bike', 'exercise bike', 'spin bike', 'cycling', 'upright bike', 'recumbent bike', 'bike erg', 'bikeerg'] },
  { name: 'Ski Erg',               tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', alt: 'distance', aliases: ['skierg', 'ski machine'] },
  { name: 'Treadmill Run',         tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', alt: 'distance', aliases: ['treadmill', 'treadmill jog'] },
  { name: 'Incline Walk',          tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', alt: 'distance', aliases: ['incline treadmill walk', 'treadmill incline walk', '12 3 30'] },
  { name: 'Stair Climber',         tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', aliases: ['stairmaster', 'stair master', 'stepmill', 'stair stepper'] },
  { name: 'Elliptical',            tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'cardio', aliases: ['cross trainer', 'elliptical trainer'] },
  { name: 'Run',                   tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'bodyweight', alt: 'distance', aliases: ['jog', 'easy run', 'running', 'zone 2 run', 'outdoor run', 'tempo run'] },
  { name: 'Walk',                  tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'bodyweight', alt: 'distance', aliases: ['walking', 'brisk walk', 'zone 2 walk', 'ruck', 'rucking'] },
  { name: 'Swim',                  tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'other', alt: 'distance', aliases: ['swimming', 'laps', 'lap swim'] },
  { name: 'Jump Rope',             tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'other', aliases: ['skipping', 'jumping rope', 'double unders'] },
  { name: 'Battle Ropes',          tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'other', aliases: ['battle rope', 'rope waves', 'battle rope waves'] },
  { name: 'Burpee',                tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'cardio', equipment: 'bodyweight', alt: 'time' },
  { name: 'Mountain Climber',      tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'cardio', equipment: 'bodyweight', alt: 'time' },
  { name: 'Jumping Jack',          tracking: 'bodyweight_reps', category: 'Conditioning', pattern: 'cardio', equipment: 'bodyweight', alt: 'time', aliases: ['star jump'] },
  { name: 'High Knees',            tracking: 'time', category: 'Conditioning', pattern: 'cardio', equipment: 'bodyweight', aliases: ['high knee', 'high knee run'] },
]

// Second-best matches when the same-pattern list runs thin: what a coach would
// reach for next. Not symmetric on purpose — a shrug can stand in for nothing,
// but a row can stand in for a pulldown.
const RELATED: Partial<Record<MovementPattern, MovementPattern[]>> = {
  squat: ['single_leg', 'knee_extension'],
  single_leg: ['squat'],
  knee_extension: ['squat', 'single_leg'],
  hinge: ['hip_extension', 'back_extension', 'knee_flexion'],
  hip_extension: ['hinge'],
  knee_flexion: ['hinge'],
  back_extension: ['hinge', 'hip_extension'],
  hip_abduction: ['hip_extension'],
  hip_adduction: ['lateral_core'],
  horizontal_push: ['chest_fly', 'vertical_push'],
  vertical_push: ['horizontal_push', 'shoulder_raise'],
  chest_fly: ['horizontal_push'],
  horizontal_pull: ['vertical_pull', 'rear_delt'],
  vertical_pull: ['horizontal_pull'],
  elbow_flexion: ['vertical_pull'],
  elbow_extension: ['horizontal_push'],
  shoulder_raise: ['vertical_push'],
  rear_delt: ['scapular', 'horizontal_pull'],
  scapular: ['rear_delt'],
  shrug: ['carry'],
  anti_extension: ['anti_rotation', 'trunk_flexion'],
  anti_rotation: ['anti_extension', 'lateral_core'],
  lateral_core: ['anti_rotation', 'carry'],
  trunk_flexion: ['hip_flexion', 'anti_extension'],
  hip_flexion: ['trunk_flexion'],
  carry: ['lateral_core'],
  jump: ['throw', 'power'],
  throw: ['jump', 'power'],
  power: ['jump', 'throw', 'hinge'],
  sprint: ['cardio', 'sled'],
  sled: ['cardio', 'carry'],
  cardio: ['sled'],
  hip_mobility: ['hamstring_mobility', 'ankle_mobility'],
  hamstring_mobility: ['hip_mobility'],
  ankle_mobility: ['hip_mobility'],
  shoulder_mobility: ['thoracic_mobility', 'scapular'],
  thoracic_mobility: ['shoulder_mobility'],
  recovery: ['thoracic_mobility', 'hip_mobility'],
}

export const PATTERN_LABEL: Record<MovementPattern, string> = {
  squat: 'Squat', single_leg: 'Single-leg', knee_extension: 'Quad', calf: 'Calf',
  hinge: 'Hinge', hip_extension: 'Glute', knee_flexion: 'Hamstring curl', back_extension: 'Back extension',
  hip_abduction: 'Hip abduction', hip_adduction: 'Adductor',
  horizontal_push: 'Horizontal press', vertical_push: 'Overhead press', chest_fly: 'Chest fly',
  horizontal_pull: 'Row', vertical_pull: 'Vertical pull',
  elbow_flexion: 'Biceps', elbow_extension: 'Triceps', shoulder_raise: 'Delt raise', rear_delt: 'Rear delt',
  scapular: 'Shoulder health', shrug: 'Shrug',
  anti_extension: 'Anti-extension core', anti_rotation: 'Anti-rotation core', lateral_core: 'Lateral core',
  trunk_flexion: 'Ab flexion', hip_flexion: 'Leg raise',
  carry: 'Carry', jump: 'Jump', throw: 'Throw', power: 'Power', sprint: 'Sprint', sled: 'Sled', cardio: 'Cardio',
  hip_mobility: 'Hip mobility', hamstring_mobility: 'Hamstring mobility', ankle_mobility: 'Ankle mobility',
  shoulder_mobility: 'Shoulder mobility', thoracic_mobility: 'T-spine mobility', recovery: 'Recovery',
}

export const EQUIPMENT_LABEL: Record<Equipment, string> = {
  barbell: 'Barbell', dumbbell: 'Dumbbells', kettlebell: 'Kettlebell', cable: 'Cable',
  machine: 'Machine', band: 'Bands', bar: 'Pull-up bar', bodyweight: 'Bodyweight',
  cardio: 'Cardio machine', sled: 'Sled', other: 'Other gear',
}

/** How each metric reads in a sentence ("logs as time"). */
export const TRACKING_LABEL: Record<TrackingType, string> = {
  weight_reps: 'weight × reps', bodyweight_reps: 'reps', time: 'time', distance: 'distance',
}

// ---- normalization & lookup -------------------------------------------------

// Strip case, parenthetical qualifiers ("(Light)", "(90/90)"), and punctuation
// so "Scapular Push-Up" and "scapular pushup" collapse to the same key.
// Exported and relied on by coachingNotes — its behaviour is deliberately left
// alone; the library's own matching layers more folding on top (matchKeys).
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // drop "(...)" qualifiers
    .replace(/[^a-z0-9\s]/g, ' ')  // punctuation → space (handles hyphens, slashes)
    .replace(/\s+/g, ' ')
    .trim()
}

// Spellings that mean the same thing. Applied to both sides of every lookup, so
// "Dumbbell Romanian Deadlift", "DB RDL" and "db romanian deadlift" all meet.
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bdumbbells?\b/g, 'db'],
  [/\bkettlebells?\b/g, 'kb'],
  [/\b(pushup|push ups)\b/g, 'push up'],
  [/\b(pullup|pull ups)\b/g, 'pull up'],
  [/\b(chinup|chin ups)\b/g, 'chin up'],
  [/\b(situp|sit ups)\b/g, 'sit up'],
  [/\b(stepup|step ups)\b/g, 'step up'],
  [/\b(one|1) (arm|leg)\b/g, 'single $2'],
  [/\bsingle(arm|leg)\b/g, 'single $1'],
  [/\bflyes?\b/g, 'fly'],
  [/\bflies\b/g, 'fly'],
  [/\b(triceps|tri)\b/g, 'tricep'],
  [/\bbiceps\b/g, 'bicep'],
  [/\bfarmer s\b/g, 'farmers'],
]

function fold(base: string): string {
  let s = base
  for (const [re, to] of SYNONYMS) s = s.replace(re, to)
  return s.replace(/\s+/g, ' ').trim()
}

// "Row (Erg)" has to keep its qualifier to mean anything — stripped, it is just
// "Row", and every row in the program would have been timed like a rowing
// machine. So a name is tried WITH its parenthetical content first, then without.
function withQualifiers(name: string): string {
  return name.toLowerCase().replace(/[()]/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// A plural is the same movement: "Pull-Ups", "Face Pulls", "Box Jumps". Only
// the last word, and never a word that is singular already ("press", "abs").
function singular(key: string): string {
  return key.replace(/\b(\w+)$/, (w) => {
    if (w.length < 4) return w
    if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2)   // "presses" → "press"
    if (/(ss|us)$/.test(w)) return w                        // "press" stays
    return w.endsWith('s') ? w.slice(0, -1) : w             // "raises" → "raise"
  })
}

// Leading modifiers that change HOW a movement is loaded or set up, not what it
// is. Only peeled off when the full name isn't known, so "Incline Bench Press"
// still finds itself before it would ever be read as "Bench Press".
const MODIFIER =
  /^(db|kb|bb|barbell|cable|machine|smith machine|smith|banded|band|weighted|seated|standing|tempo|paused|pause|deficit|half kneeling|tall kneeling|kneeling|single arm|single leg|alternating|incline|decline|landmine|ring|trx|isometric|iso|eccentric|explosive|light|heavy)\s+/

function matchKeys(name: string): string[] {
  const bases = [fold(withQualifiers(name)), fold(normalizeName(name))]
  const keys: string[] = []
  const push = (k: string) => { if (k && !keys.includes(k)) keys.push(k) }
  for (const b of bases) { push(b); push(singular(b)) }
  // Peel modifiers one at a time, newest key last, so the most specific name wins.
  for (const b of bases) {
    let k = b
    while (MODIFIER.test(k)) {
      k = k.replace(MODIFIER, '')
      push(k); push(singular(k))
    }
  }
  return keys
}

const LOOKUP = new Map<string, LibraryExercise>()
// Two entries claiming one key is a curation bug (one of them silently loses);
// collected rather than thrown so the check script can name every one at once.
export const LIBRARY_COLLISIONS: string[] = []
function register(key: string, ex: LibraryExercise) {
  if (!key) return
  const prior = LOOKUP.get(key)
  if (prior && prior !== ex) { LIBRARY_COLLISIONS.push(`"${key}": ${prior.name} vs ${ex.name}`); return }
  LOOKUP.set(key, ex)
}
for (const ex of LIBRARY) {
  for (const n of [ex.name, ...(ex.aliases ?? [])]) {
    register(fold(withQualifiers(n)), ex)
    register(fold(normalizeName(n)), ex)
  }
}

function lookup(name: string): LibraryExercise | null {
  for (const k of matchKeys(name)) {
    const hit = LOOKUP.get(k)
    if (hit) return hit
  }
  return null
}

export function findLibraryExercise(name: string): LibraryExercise | null {
  return lookup(name)
}

/** Every curated movement — read-only, for search and the integrity check. */
export const LIBRARY_EXERCISES: readonly LibraryExercise[] = LIBRARY

// Keyword fallback for a movement the library hasn't curated yet. Deliberately
// narrow — it only claims a category when the name says so plainly, and returns
// null otherwise so the caller can decide what "unknown" is worth.
//
// ORDER MATTERS, and Upper Chain goes LAST because its keywords are the greediest
// ("press", "row", "lat"). Posterior before Lower so "single-leg RDL" reads as
// posterior; Lower before Upper so "overhead squat" reads as a squat; Conditioning
// before Upper so "row erg" isn't mistaken for a barbell row.
const CATEGORY_KEYWORDS: Array<[RegExp, LibraryCategory]> = [
  [/\b(deadlift|rdl|hinge|hip thrust|glute|hamstring|leg curl|good ?morning|kettlebell swing|kb swing|back extension|hyperextension|nordic|pull ?through)\b/, 'Posterior Chain'],
  [/\b(squat|lunge|step ?up|leg press|leg extension|calf|quad|tke)\b/, 'Lower Chain'],
  [/\b(plank|dead ?bug|bird ?dog|hollow|pallof|anti ?rotation|carry|crunch|sit ?up|ab wheel|core|oblique|side bend)\b/, 'Core'],
  [/\b(run|sprint|bike|erg|sled|prowler|jump rope|skipping|conditioning|intervals?|shuttle)\b/, 'Conditioning'],
  [/\b(bench|press|push ?up|dip|fly|flye|overhead|ohp|lateral raise|shoulder|scap|rotator|cuff|row|pull ?up|chin ?up|pulldown|lat|bicep|hammer curl|preacher|tricep|face pull|shrug)\b/, 'Upper Chain'],
]

/**
 * Which chain a movement belongs to. Library hit wins; then a narrow keyword
 * read; then null for "genuinely don't know".
 *
 * This exists so a limiter can be scoped to the work it actually concerns. The
 * load cap used to apply to every exercise in a phase, which meant a shoulder
 * read held back an athlete's squat — the cap was right, its blast radius was
 * not. Callers should treat null as "no opinion" and fall back to whatever the
 * program already recorded, rather than guessing in either direction.
 */
export function resolveCategory(name: string): LibraryCategory | null {
  const hit = lookup(name)
  if (hit) return hit.category
  const n = normalizeName(name)
  for (const [re, category] of CATEGORY_KEYWORDS) if (re.test(n)) return category
  return null
}

// The same idea at pattern grain, for an uncurated name that still needs swaps.
// ORDER MATTERS the same way: leg curl before curl, row erg before row, the
// specific press before the generic one.
const PATTERN_KEYWORDS: Array<[RegExp, MovementPattern]> = [
  [/\b(erg|rower|bike|treadmill|elliptical|stair|swim|jog|run)\b/, 'cardio'],
  [/\b(sprint|dash|shuttle)\b/, 'sprint'],
  [/\b(sled|prowler)\b/, 'sled'],
  [/\b(carry|walk)\b/, 'carry'],
  [/\b(jump|bound|hop|plyo)\b/, 'jump'],
  [/\b(clean|snatch|jerk)\b/, 'power'],
  [/\b(leg curl|hamstring curl|nordic|ghr)\b/, 'knee_flexion'],
  [/\b(deadlift|rdl|good ?morning|swing|hinge|pull ?through)\b/, 'hinge'],
  [/\b(hip thrust|glute bridge|bridge|kickback)\b/, 'hip_extension'],
  [/\b(back extension|hyperextension|reverse hyper)\b/, 'back_extension'],
  [/\b(lunge|split squat|step ?up|step ?down|pistol)\b/, 'single_leg'],
  [/\b(squat|leg press)\b/, 'squat'],
  [/\b(leg extension|knee extension|tke)\b/, 'knee_extension'],
  [/\b(calf|tib)\b/, 'calf'],
  [/\b(abduction|clamshell|band walk)\b/, 'hip_abduction'],
  [/\b(adduction|adductor)\b/, 'hip_adduction'],
  [/\b(plank|rollout|ab wheel|dead ?bug|hollow)\b/, 'anti_extension'],
  [/\b(pallof|chop|twist|anti ?rotation)\b/, 'anti_rotation'],
  [/\b(crunch|sit ?up)\b/, 'trunk_flexion'],
  [/\b(leg raise|knee raise|toes to bar)\b/, 'hip_flexion'],
  [/\b(face pull|rear delt|reverse fly|pull ?apart)\b/, 'rear_delt'],
  [/\b(external rotation|cuff|ytw|serratus|scap)\b/, 'scapular'],
  [/\b(lateral raise|side raise|front raise|upright row)\b/, 'shoulder_raise'],
  [/\b(shrug)\b/, 'shrug'],
  [/\b(pull ?up|chin ?up|pulldown|pullover)\b/, 'vertical_pull'],
  [/\b(row)\b/, 'horizontal_pull'],
  [/\b(curl)\b/, 'elbow_flexion'],
  [/\b(tricep|pushdown|skull ?crusher|kickback)\b/, 'elbow_extension'],
  [/\b(fly|crossover|pec deck)\b/, 'chest_fly'],
  [/\b(overhead|shoulder press|military|ohp|pike|landmine press)\b/, 'vertical_push'],
  [/\b(bench|chest press|push ?up|floor press|dip)\b/, 'horizontal_push'],
  [/\b(stretch|mobility|cars)\b/, 'hip_mobility'],
]

/** The pattern a movement trains: library first, then a narrow keyword read. */
export function resolvePattern(name: string): MovementPattern | null {
  const hit = lookup(name)
  if (hit) return hit.pattern
  const n = fold(normalizeName(name))
  for (const [re, pattern] of PATTERN_KEYWORDS) if (re.test(n)) return pattern
  return null
}

// ---- reading the prescription's unit ---------------------------------------

/**
 * What the LEADING quantity of a prescription is measured in. "30s" → time,
 * "40 yd" → distance, "8" → reps, "AMRAP" → null.
 *
 * The leading quantity, not any quantity. The old read fired on a seconds unit
 * ANYWHERE in the string, so a tempo note made a row a timed hold: "8 (3s
 * eccentric)" and "8-10, 2s squeeze" both came out in seconds. The count comes
 * first; whatever follows it is coaching.
 */
export function prescribedUnit(reps?: string): 'time' | 'distance' | 'reps' | null {
  if (!reps) return null
  let r = reps.toLowerCase().replace(/\([^)]*\)/g, ' ').trim()
  // "3x30s", "3 × 8", "3 sets of 10" — the set count isn't the quantity.
  r = r.replace(/^\s*\d+\s*(?:x|×|sets? of)\s*/, '')
  if (/^\D*\d+:\d{2}/.test(r)) return 'time'          // "1:30"
  const m = r.match(
    /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*(seconds?|secs?|s|minutes?|mins?|min|meters?|metres?|m|km|yards?|yds?|feet|foot|ft|miles?|mi|reps?|cal|kcal)?(?![a-z])/,
  )
  if (!m) return /\b(hold|max hold)\b/.test(r) ? 'time' : null
  const unit = m[2] ?? ''
  if (/^(seconds?|secs?|s|minutes?|mins?|min)$/.test(unit)) return 'time'
  if (/^(meters?|metres?|m|km|yards?|yds?|feet|foot|ft|miles?|mi)$/.test(unit)) return 'distance'
  if (/^(cal|kcal)$/.test(unit)) return null
  return 'reps'
}

// ---- heuristic fallback for unknown exercises ------------------------------
// Conservative: the prescription's own unit first (most reliable), then name
// keywords, then load. Defaults to weight_reps. The library covers the tricky
// cases so this rarely fires; when it does, a wrong guess is a cosmetic input
// layout, not a safety issue.
function heuristicTracking(name: string, reps?: string, load?: string): TrackingType {
  const unit = prescribedUnit(reps)
  if (unit === 'time') return 'time'
  if (unit === 'distance') return 'distance'

  const n = fold(normalizeName(name))
  // A jump is measured by how far it went, however many of them there are.
  if (/\b(broad jump|long jump|vertical|sprint|dash|shuttle|bound|sled|prowler)\b/.test(n)) return 'distance'
  // A hold is timed — unless the prescription counted reps, which says otherwise
  // ("Plank Shoulder Tap: 10" is ten taps, not ten seconds).
  if (unit !== 'reps' && /\b(plank|hold|hang|carry|wall sit|isometric|breathing|stretch)\b/.test(n)) return 'time'
  if (load === 'bodyweight') return 'bodyweight_reps'
  if (/\b(push up|pull up|chin up|dip|sit up|crunch|burpee|air squat|nordic)\b/.test(n)) {
    return 'bodyweight_reps'
  }
  return 'weight_reps'
}

/**
 * Resolve how an exercise is measured. Library hit wins (an explicit unit in the
 * prescription may move it to the entry's `alt`); otherwise heuristic.
 * Idempotent and pure — safe to call at build time (to persist) AND at render
 * time (as a fallback for legacy/agent rows that lack tracking_type).
 */
export function resolveTrackingType(
  name: string,
  reps?: string,
  load?: string,
): TrackingType {
  const hit = lookup(name)
  if (hit) {
    if (hit.alt) {
      const unit = prescribedUnit(reps)
      const unitType: TrackingType | null =
        unit === 'time' ? 'time' : unit === 'distance' ? 'distance' : null
      if (unitType === hit.alt) return hit.alt
    }
    return hit.tracking
  }
  return heuristicTracking(name, reps, load)
}

/**
 * The metric an exercise is logged in, right now. A curated movement is the
 * library's call, always — including over a stamp written into the routine
 * before the library knew it (a T-bar row the heuristic once filed as a timed
 * hold stays wrong forever otherwise). An uncurated one keeps whatever it was
 * stamped with, so a heuristic change never moves the inputs under a lift the
 * athlete has already been logging.
 */
export function effectiveTrackingType(ex: Pick<ExerciseTemplate, 'name' | 'reps' | 'load' | 'tracking_type'>): TrackingType {
  if (lookup(ex.name)) return resolveTrackingType(ex.name, ex.reps, ex.load)
  return ex.tracking_type ?? resolveTrackingType(ex.name, ex.reps, ex.load)
}

// ---- swaps: the same work with what's actually there -----------------------

export interface SwapSuggestion {
  exercise: LibraryExercise
  /** One short phrase on why it's on the list. */
  reason: string
  /** Same pattern (true) or the next-best related one (false). */
  samePattern: boolean
}

export interface SwapOptions {
  /** Equipment on hand. Empty/absent = a full gym. Bodyweight is always on hand. */
  available?: readonly Equipment[]
  /** Substitutes the athlete picked for this movement before, most recent first. */
  recent?: readonly string[]
  /** Whether the athlete has logged a movement before (known working numbers). */
  hasHistory?: (name: string) => boolean
  /** Names to leave out (the movements already in the session). */
  exclude?: readonly string[]
  /** Unscreened session: never suggest a ballistic/maximal movement. */
  screened?: boolean
}

function repFamily(t: TrackingType): 'reps' | 'time' | 'distance' {
  return t === 'time' ? 'time' : t === 'distance' ? 'distance' : 'reps'
}

export function equipmentAvailable(eq: Equipment, available?: readonly Equipment[]): boolean {
  return !available || available.length === 0 || eq === 'bodyweight' || available.includes(eq)
}

/**
 * Ranked stand-ins for a movement. Pure and deterministic — no model in the
 * loop, because "what trains the same thing" is a fact about the movement, and
 * the athlete is standing at the rack waiting for an answer.
 *
 * Ranking, in order of weight: the same pattern over a related one; a pick the
 * athlete made last time for this movement (the gym that has no T-bar still has
 * no T-bar next week); one that logs the same way, so the numbers stay
 * comparable; one they already have numbers on; matching laterality. Within
 * that, equipment is spread so the top of the list isn't five dumbbell rows.
 *
 * A movement flagged ballistic/maximal is only ever offered in place of another
 * one — a swap never makes a session riskier than the one that was programmed.
 */
export function suggestSwaps(originalName: string, opts: SwapOptions = {}): SwapSuggestion[] {
  const orig = lookup(originalName)
  const pattern = orig?.pattern ?? resolvePattern(originalName)
  if (!pattern) return []
  const origTracking = orig?.tracking ?? resolveTrackingType(originalName)
  const related = new Set(RELATED[pattern] ?? [])
  const excluded = new Set((opts.exclude ?? []).map((n) => lookup(n)?.name ?? n))
  const recent = (opts.recent ?? []).map((n) => lookup(n)?.name ?? n)

  const scored: Array<{ ex: LibraryExercise; score: number; same: boolean; recentIdx: number }> = []
  for (const ex of LIBRARY) {
    if (ex === orig || excluded.has(ex.name)) continue
    const same = ex.pattern === pattern
    if (!same && !related.has(ex.pattern)) continue
    if (ex.contra && !orig?.contra) continue
    if (ex.contra && opts.screened === false) continue
    if (!equipmentAvailable(ex.equipment, opts.available)) continue

    let score = same ? 100 : 40
    const recentIdx = recent.indexOf(ex.name)
    if (recentIdx >= 0) score += 40 - Math.min(recentIdx, 3) * 5
    if (ex.tracking === origTracking) score += 20
    else if (repFamily(ex.tracking) === repFamily(origTracking)) score += 12
    if (opts.hasHistory?.(ex.name)) score += 10
    if (!!ex.unilateral === !!orig?.unilateral) score += 5
    if (orig && ex.category === orig.category) score += 3
    scored.push({ ex, score, same, recentIdx })
  }

  // Greedy pick with a small penalty for repeating an implement already chosen,
  // so the first screen offers a dumbbell, a cable and a bodyweight option
  // rather than three flavours of the same one.
  const out: SwapSuggestion[] = []
  const seenEquipment = new Map<Equipment, number>()
  const pool = [...scored]
  while (pool.length) {
    let bestI = 0
    let bestScore = -Infinity
    pool.forEach((c, i) => {
      const s = c.score - (seenEquipment.get(c.ex.equipment) ?? 0) * 6
      if (s > bestScore || (s === bestScore && c.ex.name < pool[bestI].ex.name)) { bestScore = s; bestI = i }
    })
    const [c] = pool.splice(bestI, 1)
    seenEquipment.set(c.ex.equipment, (seenEquipment.get(c.ex.equipment) ?? 0) + 1)
    out.push({ exercise: c.ex, samePattern: c.same, reason: swapReason(c.ex, c.same, c.recentIdx, origTracking, opts) })
  }
  return out
}

function swapReason(
  ex: LibraryExercise, same: boolean, recentIdx: number, origTracking: TrackingType, opts: SwapOptions,
): string {
  const bits: string[] = []
  if (recentIdx === 0) bits.push('Your pick last time')
  else if (recentIdx > 0) bits.push("You've used this")
  else bits.push(same ? 'Same movement' : `Close cousin · ${PATTERN_LABEL[ex.pattern].toLowerCase()}`)
  if (repFamily(ex.tracking) !== repFamily(origTracking)) bits.push(`logs ${TRACKING_LABEL[ex.tracking]}`)
  else if (recentIdx < 0 && opts.hasHistory?.(ex.name)) bits.push('you have numbers on it')
  return bits.join(' · ')
}

/** Free-text search across the whole library — for "none of those, I want X". */
export function searchLibrary(query: string, limit = 12): LibraryExercise[] {
  const q = fold(normalizeName(query))
  if (!q) return []
  const scored: Array<{ ex: LibraryExercise; rank: number }> = []
  for (const ex of LIBRARY) {
    const names = [ex.name, ...(ex.aliases ?? [])].map((n) => fold(normalizeName(n)))
    let rank = Infinity
    names.forEach((n, i) => {
      const r = n === q ? 0 : n.startsWith(q) ? 1 : n.split(' ').some((w) => w.startsWith(q)) ? 2 : n.includes(q) ? 3 : Infinity
      // An alias match ranks just behind the same kind of match on the name.
      rank = Math.min(rank, r + (i === 0 ? 0 : 0.5))
    })
    if (rank < Infinity) scored.push({ ex, rank })
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.ex.name.localeCompare(b.ex.name))
    .slice(0, limit)
    .map((s) => s.ex)
}

// A first dose when the stand-in measures in a different unit than what it
// replaces — "8 reps" means nothing on a plank. Conservative middles; the athlete
// adjusts on the first set.
const DEFAULT_DOSE: Record<'reps' | 'time' | 'distance', string> = {
  reps: '10', time: '30s', distance: '20m',
}

/**
 * The prescription for a stand-in: the slot's sets, effort and purpose carried
 * over, the movement and its metric replaced. `swapped_from` always names the
 * PROGRAMMED movement, so swapping a swap still remembers what the plan was.
 *
 * Carried: sets, target RPE, the insight the slot serves (a swap trains the same
 * thing, so it answers to the same read). Dropped: the program's cue (written
 * for the other lift) and the reading tag (a probe of THAT pattern on THAT lift).
 */
export function buildSwap(original: ExerciseTemplate, substituteName: string): ExerciseTemplate {
  const lib = lookup(substituteName)
  const name = lib?.name ?? substituteName.trim()
  const origTracking = effectiveTrackingType(original)
  let reps = original.reps
  // The stand-in's natural metric, given the slot's existing prescription.
  let tracking = resolveTrackingType(name, reps, original.load)
  if (repFamily(tracking) !== repFamily(origTracking)) {
    // A carry for a carry keeps "40 yd" if the stand-in can be walked for distance.
    if (lib?.alt && repFamily(lib.alt) === repFamily(origTracking)) tracking = lib.alt
    else reps = DEFAULT_DOSE[repFamily(tracking)]
  }

  let load = original.load
  // Hanging off a bar or working against the floor is bodyweight work; a band's
  // light/moderate still means something (which band), so it keeps the slot's.
  if ((lib?.equipment === 'bodyweight' || lib?.equipment === 'bar') && tracking === 'bodyweight_reps') load = 'bodyweight'
  else if (load === 'bodyweight' && tracking === 'weight_reps') load = 'light'

  const ex: ExerciseTemplate = {
    name,
    sets: original.sets,
    reps,
    tracking_type: tracking,
    swapped_from: original.swapped_from ?? original.name,
  }
  if (load) ex.load = load
  if (original.target_rpe != null) ex.target_rpe = original.target_rpe
  if (original.insight_id) ex.insight_id = original.insight_id
  return ex
}
