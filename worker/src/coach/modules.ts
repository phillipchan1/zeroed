/**
 * Activity modules v1 (G6, coach_v1; spec section 4): one config entry per
 * sport or activity, next to the methodology (methodology/v1.ts) and
 * versioned the same way. Each module lists the qualities the activity
 * demands, its weak-link screens, its default prehab, and how one session of
 * it counts as load. The composer (composer.ts) runs on these; nothing here
 * is prose in a prompt.
 *
 * All five are editable defaults. The asterisked rows of the spec table are
 * standard-practice defaults pending Director of Product sign-off (adopted as
 * editable defaults in D6); `standard_practice` names them per module.
 *
 * Changing a number here is a new version: bump MODULES_V1_VERSION's
 * successor and keep v1 reproducible for blocks already stamped with it.
 *
 * Numbers are coaching defaults, not medical prescriptions.
 */
import type { PainRegion } from '../methodology/v1.ts'

export const MODULES_V1_VERSION = 'modules-v1'

/** The qualities an athlete can need (section 4). Each becomes at most one track. */
export const QUALITIES = [
  'max_strength', 'power', 'aerobic', 'alactic', 'change_of_direction', 'tissue_capacity', 'mobility',
] as const
export type Quality = typeof QUALITIES[number]

export const QUALITY_LABEL: Record<Quality, string> = {
  max_strength: 'Max strength',
  power: 'Power',
  aerobic: 'Aerobic',
  alactic: 'Repeat sprint',
  change_of_direction: 'Change of direction',
  tissue_capacity: 'Tissue capacity',
  mobility: 'Mobility',
}

export const MODULE_KEYS = ['court', 'endurance', 'field', 'strength', 'general'] as const
export type ModuleKey = typeof MODULE_KEYS[number]

export type ScreenKey =
  | 'knee_to_wall' | 'hip_ir' | 'single_leg_landing' | 'calf_raise_capacity' | 'single_leg_bridge'
  | 'nordic_eccentric' | 'copenhagen_hold' | 'shoulder_flexion' | 'overhead_reach' | 'deep_squat' | 'balance'

export type PrehabKey =
  | 'knee_ankle_tolerance' | 'hip_ir_work' | 'calf_achilles' | 'single_leg_bridge_work' | 'nordics' | 'copenhagen'
  | 'shoulder_flexion_work' | 'pull_volume' | 'overhead_reach_work' | 'deep_squat_work' | 'balance_work'

export interface Screen {
  key: ScreenKey
  name: string
  /** What the baseline is logged in (log_goal_measurement). */
  unit: 'cm' | 'deg' | 'reps' | 's' | 'pass'
  direction: 'higher' | 'pass'
  /** Tested per side: logged as L and R. */
  sided: boolean
  regions: PainRegion[]
  standard_practice?: true
}

export interface PrehabItem {
  key: PrehabKey
  name: string
  dose: string
  minutes: number
  regions: PainRegion[]
  standard_practice?: true
}

export interface SessionLoad {
  /** Qualities one session of this activity already trains (section 4 rule 3). */
  supplies: Quality[]
  /** Impact contacts one session counts as (U14). */
  contacts: number
  /** Counts as hard legs for the next day (U9). */
  hard_legs: boolean
  /** Counts as a strength exposure (U1). */
  strength_exposure: boolean
}

export interface ActivityModule {
  key: ModuleKey
  label: string
  examples: string[]
  /** 0–1: how much the activity leans on each quality. */
  demands: Partial<Record<Quality, number>>
  load: SessionLoad
  screens: ScreenKey[]
  prehab: PrehabKey[]
  /** Module-specific defaults the composer applies when the module drives a priority. */
  rules: {
    /** Endurance: share of conditioning kept easy (polarized). */
    polarized_easy_fraction?: number
    /** Endurance: weekly volume never up more than this. */
    weekly_volume_increase_max?: number
    /** Endurance: strides per week. */
    strides_per_week?: number
    /** Strength sports: pull sets ≥ this × push sets. */
    pull_to_push_min?: number
    /** Strength sports: dynamic-effort speed work. */
    dynamic_effort?: boolean
    /** General fitness: engine finisher, minutes. */
    finisher_minutes?: [number, number]
  }
  /** Dotted paths in this module that are standard-practice defaults (spec section 4 asterisks, D6). */
  standard_practice: string[]
}

export const SCREENS: Record<ScreenKey, Screen> = {
  knee_to_wall: { key: 'knee_to_wall', name: 'Knee-to-wall', unit: 'cm', direction: 'higher', sided: true, regions: ['ankle', 'knee'] },
  hip_ir: { key: 'hip_ir', name: 'Hip internal rotation', unit: 'deg', direction: 'higher', sided: true, regions: ['hip', 'groin'] },
  single_leg_landing: { key: 'single_leg_landing', name: 'Single-leg landing (hop and stick)', unit: 'pass', direction: 'pass', sided: true, regions: ['knee', 'ankle'] },
  calf_raise_capacity: { key: 'calf_raise_capacity', name: 'Single-leg calf raise to fatigue', unit: 'reps', direction: 'higher', sided: true, regions: ['achilles', 'shin', 'ankle', 'foot'] },
  single_leg_bridge: { key: 'single_leg_bridge', name: 'Single-leg bridge to fatigue', unit: 'reps', direction: 'higher', sided: true, regions: ['hamstring', 'hip', 'low_back'] },
  nordic_eccentric: { key: 'nordic_eccentric', name: 'Nordic lower (controlled reps)', unit: 'reps', direction: 'higher', sided: false, regions: ['hamstring'], standard_practice: true },
  copenhagen_hold: { key: 'copenhagen_hold', name: 'Copenhagen side-plank hold', unit: 's', direction: 'higher', sided: true, regions: ['groin', 'hip'], standard_practice: true },
  shoulder_flexion: { key: 'shoulder_flexion', name: 'Shoulder flexion (back to wall)', unit: 'pass', direction: 'pass', sided: true, regions: ['shoulder', 'upper_back'] },
  overhead_reach: { key: 'overhead_reach', name: 'Overhead reach', unit: 'pass', direction: 'pass', sided: false, regions: ['shoulder', 'upper_back'] },
  deep_squat: { key: 'deep_squat', name: 'Deep squat (heels down)', unit: 'pass', direction: 'pass', sided: false, regions: ['hip', 'knee', 'ankle', 'low_back'] },
  balance: { key: 'balance', name: 'Single-leg balance, eyes closed', unit: 's', direction: 'higher', sided: true, regions: ['ankle', 'foot'] },
}

export const PREHAB: Record<PrehabKey, PrehabItem> = {
  knee_ankle_tolerance: { key: 'knee_ankle_tolerance', name: 'Knee/ankle tolerance: tibialis raise + Spanish squat hold', dose: '2 × 15 + 3 × 30 s', minutes: 4, regions: ['knee', 'ankle', 'shin'] },
  hip_ir_work: { key: 'hip_ir_work', name: 'Hip IR: 90/90 lift-offs', dose: '2 × 8 each side', minutes: 3, regions: ['hip', 'groin'] },
  calf_achilles: { key: 'calf_achilles', name: 'Calf/Achilles: slow single-leg calf raise', dose: '3 × 10 each side', minutes: 4, regions: ['achilles', 'shin', 'ankle', 'foot'] },
  single_leg_bridge_work: { key: 'single_leg_bridge_work', name: 'Single-leg bridge', dose: '2 × 12 each side', minutes: 3, regions: ['hamstring', 'hip', 'low_back'] },
  nordics: { key: 'nordics', name: 'Nordic hamstring curl', dose: '2 × 4–6', minutes: 4, regions: ['hamstring'], standard_practice: true },
  copenhagen: { key: 'copenhagen', name: 'Copenhagen plank', dose: '2 × 20 s each side', minutes: 3, regions: ['groin', 'hip'], standard_practice: true },
  shoulder_flexion_work: { key: 'shoulder_flexion_work', name: 'Shoulder flexion: wall slides', dose: '2 × 10', minutes: 3, regions: ['shoulder', 'upper_back'] },
  pull_volume: { key: 'pull_volume', name: 'Extra pulling (face pull or row) so pull ≥ push', dose: '2 × 15', minutes: 4, regions: ['shoulder', 'upper_back'] },
  overhead_reach_work: { key: 'overhead_reach_work', name: 'Overhead reach: thoracic opener', dose: '2 × 8', minutes: 3, regions: ['shoulder', 'upper_back'] },
  deep_squat_work: { key: 'deep_squat_work', name: 'Deep squat hold (goblet)', dose: '3 × 30 s', minutes: 3, regions: ['hip', 'knee', 'ankle'] },
  balance_work: { key: 'balance_work', name: 'Single-leg balance + reach', dose: '2 × 30 s each side', minutes: 2, regions: ['ankle', 'foot'] },
}

export const MODULES: Record<ModuleKey, ActivityModule> = {
  court: {
    key: 'court',
    label: 'Court sports',
    examples: ['basketball', 'volleyball', 'tennis', 'pickleball', 'badminton'],
    demands: { aerobic: 0.6, alactic: 0.9, power: 0.9, change_of_direction: 0.8, tissue_capacity: 0.5 },
    load: { supplies: ['aerobic', 'alactic', 'change_of_direction'], contacts: 100, hard_legs: true, strength_exposure: false },
    screens: ['knee_to_wall', 'hip_ir', 'single_leg_landing'],
    prehab: ['knee_ankle_tolerance', 'hip_ir_work'],
    rules: {},
    standard_practice: [],
  },
  endurance: {
    key: 'endurance',
    label: 'Endurance',
    examples: ['running', 'cycling', 'rowing', 'swimming', 'triathlon'],
    demands: { aerobic: 1, tissue_capacity: 0.6, power: 0.2 },
    load: { supplies: ['aerobic'], contacts: 0, hard_legs: false, strength_exposure: false },
    screens: ['calf_raise_capacity', 'single_leg_bridge'],
    prehab: ['calf_achilles', 'single_leg_bridge_work'],
    rules: { polarized_easy_fraction: 0.8, weekly_volume_increase_max: 0.1, strides_per_week: 2 },
    standard_practice: ['rules.polarized_easy_fraction', 'rules.weekly_volume_increase_max'],
  },
  field: {
    key: 'field',
    label: 'Field sports',
    examples: ['soccer', 'rugby', 'field hockey', 'ultimate', 'lacrosse'],
    demands: { alactic: 0.9, change_of_direction: 0.9, power: 0.8, aerobic: 0.7, tissue_capacity: 0.7 },
    load: { supplies: ['aerobic', 'alactic', 'change_of_direction'], contacts: 80, hard_legs: true, strength_exposure: false },
    screens: ['nordic_eccentric', 'copenhagen_hold'],
    prehab: ['nordics', 'copenhagen'],
    rules: {},
    standard_practice: ['screens.nordic_eccentric', 'screens.copenhagen_hold', 'prehab.nordics', 'prehab.copenhagen'],
  },
  strength: {
    key: 'strength',
    label: 'Strength sports',
    examples: ['powerlifting', 'weightlifting', 'strongman'],
    demands: { max_strength: 1, power: 0.5, mobility: 0.3 },
    load: { supplies: ['max_strength'], contacts: 0, hard_legs: true, strength_exposure: true },
    screens: ['shoulder_flexion', 'hip_ir'],
    prehab: ['shoulder_flexion_work', 'hip_ir_work', 'pull_volume'],
    rules: { pull_to_push_min: 1, dynamic_effort: true },
    standard_practice: [],
  },
  general: {
    key: 'general',
    label: 'General fitness',
    examples: ['gym classes', 'hiking', 'general training'],
    demands: { aerobic: 0.6, max_strength: 0.5, mobility: 0.5, tissue_capacity: 0.3 },
    load: { supplies: ['aerobic'], contacts: 0, hard_legs: false, strength_exposure: false },
    screens: ['overhead_reach', 'deep_squat', 'balance'],
    prehab: ['overhead_reach_work', 'deep_squat_work', 'balance_work'],
    rules: { finisher_minutes: [8, 12] },
    standard_practice: [],
  },
}

/**
 * How the composer doses each quality (section 4 worked example, U2, U9,
 * U14). Per week unless named otherwise. Activity sessions that supply a
 * quality count against these before the engine adds any work.
 */
export interface QualityDose {
  /** Exposures a week when it is a priority. */
  priority_sessions: number
  /** Exposures a week at maintenance (activity sessions count toward it). */
  maintenance_sessions: number
  /** One added session of it, as the athlete reads it. */
  session: string
  minutes: number
}

export interface ComposerConfig {
  /** Off-season activity sessions weigh this much in the demand merge (in-season: 1). */
  off_season_weight: number
  /** A quality below this merged demand (0–1) and with no goal is left out. */
  min_demand: number
  /** Prehab + screens per session, minutes (section 4 rule 4). The cap is the high end. */
  prehab_minutes: [number, number]
  /** Lifting minutes per session: priority, maintenance. */
  lift_minutes: { priority: number; maintenance: number }
  /** Lifting sessions a week: priority, maintenance. */
  lift_sessions: { priority: number; maintenance: number }
  dose: Record<'aerobic' | 'alactic' | 'power' | 'change_of_direction', QualityDose>
  /** Power when an in-season activity already brings contacts (worked example). */
  power_in_sport_week: string
  /** Build weeks before the deload; then one deload week and one retest week (U11, U12). */
  build_weeks: number
  /** Sessions/week and minutes when nobody said. */
  default_days_per_week: number
  default_minutes: number
}

export const COMPOSER_V1: ComposerConfig = {
  off_season_weight: 0.6,
  min_demand: 0.25,
  prehab_minutes: [10, 15],
  lift_minutes: { priority: 40, maintenance: 30 },
  lift_sessions: { priority: 3, maintenance: 2 },
  dose: {
    aerobic: { priority_sessions: 4, maintenance_sessions: 2, session: 'Aerobic 30–40 min easy, HR ~120–150', minutes: 35 },
    alactic: { priority_sessions: 2, maintenance_sessions: 2, session: 'Alactic 8–10 × 8–10 s hard, 50–60 s rest', minutes: 15 },
    power: { priority_sessions: 2, maintenance_sessions: 1, session: 'Acceleration starts 6–10 × 5–10 yd, full rest', minutes: 10 },
    change_of_direction: { priority_sessions: 2, maintenance_sessions: 1, session: 'Change of direction: 5-10-5 and lateral starts, 6–8 reps, full rest', minutes: 10 },
  },
  power_in_sport_week: 'Acceleration starts 6–10 × 5–10 yd, full rest, plus jumps (conservative: games share the week)',
  build_weeks: 4,
  default_days_per_week: 3,
  default_minutes: 60,
}

/** Every version the Worker can still resolve. */
export const MODULE_VERSIONS: Record<string, { modules: Record<ModuleKey, ActivityModule>; composer: ComposerConfig }> = {
  [MODULES_V1_VERSION]: { modules: MODULES, composer: COMPOSER_V1 },
}

export function isModuleKey(v: unknown): v is ModuleKey {
  return typeof v === 'string' && (MODULE_KEYS as readonly string[]).includes(v)
}

export function isQuality(v: unknown): v is Quality {
  return typeof v === 'string' && (QUALITIES as readonly string[]).includes(v)
}

/** A sport name to the module that covers it, when one obviously does. */
export function moduleForSport(name: string): ModuleKey | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  for (const m of MODULE_KEYS) {
    if (MODULES[m].examples.some((e) => n.includes(e))) return m
  }
  if (/\b(run|jog|marathon|bike|cycl|ride|swim|row)/.test(n)) return 'endurance'
  if (/\b(lift|gym|weights?)\b/.test(n)) return 'strength'
  return null
}

/** The catalog as coaches read it (get_activities). */
export function moduleCatalog() {
  return MODULE_KEYS.map((k) => {
    const m = MODULES[k]
    return {
      key: m.key,
      label: m.label,
      examples: m.examples,
      demands: m.demands,
      counts_as: m.load,
      screens: m.screens.map((s) => ({ key: s, name: SCREENS[s].name, unit: SCREENS[s].unit, sided: SCREENS[s].sided, ...(SCREENS[s].standard_practice ? { standard_practice: true } : {}) })),
      prehab: m.prehab.map((p) => ({ key: p, name: PREHAB[p].name, dose: PREHAB[p].dose, ...(PREHAB[p].standard_practice ? { standard_practice: true } : {}) })),
      rules: m.rules,
      standard_practice: m.standard_practice,
    }
  })
}
