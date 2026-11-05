/**
 * Methodology v1 (G3, spec section 3 + decisions D2, D5, D6): the coaching
 * rules U1–U15 as data the Worker runs, not prose in a prompt. One global,
 * versioned ruleset; athletes get overrides (methodology_override), never a
 * fork. Changing a number here is a new version: bump `version` and keep v1's
 * numbers reproducible for prescriptions already stamped with it.
 *
 * Where the engine already had the number (src/engine/liftModel.ts), the
 * default here equals that constant, so the defaults reproduce today's
 * prescriptions exactly (methodology.check.ts proves it):
 *   U4.tm_fraction        TM_FRACTION 0.9
 *   U3.push_pct           PUSH_PCT +2.5% upper / +5% lower
 *   U11.deload_tm_pct     DELOAD_TM_PCT 65
 *   U11.deload_rpe_cap    DELOAD_RPE_CAP 6
 *   preview_ttl_hours     PREVIEW_TTL_HOURS 24
 *   U13 small edit cap    30% (preview validator)
 *
 * U4 note: the spec names Epley for e1RM. Since the lift model, the working
 * max is read off the RTS reps × RPE chart (Epley is kept for PR display), so
 * v1 records what the engine does: e1rm_source 'rpe_chart'.
 *
 * v1.1 (spec section 11, Director of Product, Nov 4 2026) is v1 plus:
 *   U4.e1rm_without_rpe 'epley'   the RPE chart when a set has an RPE, Epley
 *                                 when it doesn't (v1 read it at RPE 10); each
 *                                 estimate records its method (e1rm_method)
 *   minors.contacts_per_session_max 60   was an 80 placeholder; still tighten-only
 * v1 stays resolvable (METHODOLOGIES) for prescriptions already stamped with it.
 *
 * v1.2 (spec section 11a, S&C review, Nov 4 2026) is v1.1 plus:
 *   U6  one day is a flag only at sleep < 5 h, stress 5 or soreness 5;
 *       sleep < 6 h and stress / soreness ≥ 4 count only as a 3-day streak.
 *       The main lift is never touched (as before).
 *   U7  "worse the next morning" needs the next-morning rating above the
 *       session's and ≥ 4. A rating > 5 blocks the region for that day and
 *       the next session, with the refer-out notice, then lapses. A block is
 *       persistent (clinician clearance) only on a red flag, > 5 twice within
 *       14 days, or a rating rising across 3 sessions. The 4–5 rule is unchanged.
 *   Under 18 the two loosenings (fewer single-day flags, blocks that lapse)
 *   don't apply: resolve.ts keeps the v1.1 behaviour for a minor (D6).
 * Absent keys (v1, v1.1) mean the v1.1 rules, so both still resolve exactly.
 *
 * Stored data under v1.2 (readiness.ts): nothing is rewritten. A temporary
 * block is derived from the pain report (no region_status row); a persistent
 * one writes a 'blocked' row as before. A 'blocked' row stored under v1.1
 * (e.g. a single 6/10) is not re-judged on deploy or at read time: it stays
 * until the athlete marks it cleared, as it always did. Section 11b: the
 * operator re-checks those once, under v1.2, with the logged system job
 * (reevalV11Blocks.ts, scripts/reeval-v11-blocks.mjs); a block v1.2 wouldn't
 * keep persistent drops to temporary there, never silently. Rollback:
 * tracks_v1 off (instant), or redeploy the v1.1 Worker; there is no schema
 * change to undo.
 *
 * Numbers are coaching defaults, not medical prescriptions.
 */

export const METHODOLOGY_V1_VERSION = 'v1'
export const METHODOLOGY_V1_1_VERSION = 'v1.1'
export const METHODOLOGY_V1_2_VERSION = 'v1.2'

/** Pain regions a cap or a red flag can be set on (U7). */
export const PAIN_REGIONS = [
  'neck', 'shoulder', 'elbow', 'wrist', 'upper_back', 'low_back', 'hip', 'groin',
  'hamstring', 'knee', 'shin', 'ankle', 'achilles', 'foot',
] as const
export type PainRegion = typeof PAIN_REGIONS[number]

export const CONTACT_LEVELS = ['return_or_sport_week', 'beginner', 'intermediate', 'advanced'] as const
export type ContactLevel = typeof CONTACT_LEVELS[number]

export type Range = [number, number]

export interface RegionRule {
  /** D2: "≤ 5/10 if it settles by the next morning" for this region. Never for minors. */
  raised_cap?: boolean
  /** Section 8 red flag: no loading of the region until a clinician clears it. */
  blocked?: boolean
}

export interface MethodologyParams {
  U1: { strength_exposures_per_week: number; strength_exposure_min_pct_tm: number; strength_exposure_min_rpe: number }
  U2: { max_priority_tracks: number; maintenance_volume_fraction: Range; higher_end_from_age: number }
  U3: { load_step_lb: { upper: Range; lower: Range }; load_step_kg: { upper: Range; lower: Range }; push_pct: { upper: number; lower: number } }
  U4: {
    tm_fraction: number; e1rm_source: 'rpe_chart'; written_load_wins: true
    /** v1.1: how a set with no RPE is estimated. Absent (v1): the chart at RPE 10. */
    e1rm_without_rpe?: 'epley'
  }
  U5: {
    base_rpe: Range; top_single_rpe: Range; rpe_10: 'test_days_only'
    hold_after_weeks_over: number; deload_or_swap_after_weeks_over: number
    cut_backoffs_when_top_over_by: number; backoff_pct_under_top: Range
  }
  U6: {
    trim_accessories_at_flags: number; pull_hiit_plyo_at_flags: number; cut_order: string[]
    sleep_flag_hours: number; sleep_flag_nights: number; stress_soreness_flag_at: number; stress_soreness_flag_days: number
    /** v1.2: one day alone is a flag only under this many hours. Absent (v1, v1.1): sleep_flag_hours. */
    single_day_sleep_under_hours?: number
    /** v1.2: one day alone is a flag only at this stress / soreness. Absent (v1, v1.1): stress_soreness_flag_at. */
    single_day_stress_soreness_at?: number
  }
  U7: {
    pain_cap: number; regress_band: Range; stop_above: number
    raised_cap: number; raised_cap_requires: 'settled_by_next_morning'
    red_flags_block: true
    regions: Partial<Record<PainRegion, RegionRule>>
    /**
     * v1.2: "worse the next morning" blocks when the next-morning rating is
     * above the session's and at least this. Absent (v1, v1.1): the session's
     * rating was over pain_cap and the next morning's above it.
     */
    worse_next_morning_at?: number
    /**
     * v1.2: a block that meets no persistent_after criterion (and has no red
     * flag) covers that day and the next session, then lapses. Absent or
     * false (v1, v1.1, under 18): every block stays until a clinician clears it.
     */
    temporary_blocks?: boolean
    /** v1.2: what makes a block persistent, besides a red flag. */
    persistent_after?: { over_stop_times: number; within_days: number; rising_sessions: number }
  }
  U8: { order: Array<'warmup' | 'speed' | 'heavy' | 'accessory' | 'conditioning'> }
  U9: { hiit_minutes: Range; hiit_max_per_week: number; conditioning_gap_hours: number; prefer_modalities: string[]; no_hiit_day_before_heavy_lower: true }
  U10: { straight_sets_at_or_above_rpe: number; main_lift_rest_s: Range }
  U11: { deload_every_weeks: Range; volume_cut_pct: Range; intensity_pct: Range; deload_tm_pct: number; deload_rpe_cap: number; compliance_trigger: number }
  U12: { maintenance_held_at_rpe: number; max_test_maintenance_lifts: false }
  U13: { small_edit_max_fraction: number }
  U14: { contacts_per_session: Record<ContactLevel, Range> }
  U15: { compliance_target: number }
}

export interface MinorsRules {
  /** Under this age the rules below apply, and can only be tightened (D6). */
  age_under: number
  parental_consent_required: true
  /** No RPE above this, anywhere. */
  max_rpe: number
  /** Plyo contacts per session never above this. */
  contacts_per_session_max: number
  max_testing: false
  /** D2: never a raised pain cap for a minor. */
  raised_pain_cap: false
}

export interface Methodology {
  version: string
  params: MethodologyParams
  minors: MinorsRules
  /** A preview applies only while younger than this (section 6). Not overridable. */
  preview_ttl_hours: number
}

export const METHODOLOGY_V1: Methodology = {
  version: METHODOLOGY_V1_VERSION,
  params: {
    U1: { strength_exposures_per_week: 1, strength_exposure_min_pct_tm: 85, strength_exposure_min_rpe: 8 },
    U2: { max_priority_tracks: 2, maintenance_volume_fraction: [0.33, 0.4], higher_end_from_age: 35 },
    U3: {
      load_step_lb: { upper: [2.5, 5], lower: [5, 10] },
      load_step_kg: { upper: [1, 2.5], lower: [2.5, 5] },
      push_pct: { upper: 2.5, lower: 5 },
    },
    U4: { tm_fraction: 0.9, e1rm_source: 'rpe_chart', written_load_wins: true },
    U5: {
      base_rpe: [7, 8],
      top_single_rpe: [8, 9],
      rpe_10: 'test_days_only',
      hold_after_weeks_over: 2,
      deload_or_swap_after_weeks_over: 3,
      cut_backoffs_when_top_over_by: 1,
      backoff_pct_under_top: [5, 10],
    },
    U6: {
      trim_accessories_at_flags: 1,
      pull_hiit_plyo_at_flags: 2,
      cut_order: ['hiit', 'accessories'],
      sleep_flag_hours: 6,
      sleep_flag_nights: 3,
      stress_soreness_flag_at: 4,
      stress_soreness_flag_days: 3,
    },
    U7: {
      pain_cap: 3,
      regress_band: [4, 5],
      stop_above: 5,
      raised_cap: 5,
      raised_cap_requires: 'settled_by_next_morning',
      red_flags_block: true,
      regions: {},
    },
    U8: { order: ['warmup', 'speed', 'heavy', 'accessory', 'conditioning'] },
    U9: {
      hiit_minutes: [10, 20],
      hiit_max_per_week: 2,
      conditioning_gap_hours: 6,
      prefer_modalities: ['bike', 'rower'],
      no_hiit_day_before_heavy_lower: true,
    },
    U10: { straight_sets_at_or_above_rpe: 9, main_lift_rest_s: [120, 180] },
    U11: {
      deload_every_weeks: [4, 6],
      volume_cut_pct: [40, 50],
      intensity_pct: [70, 80],
      deload_tm_pct: 65,
      deload_rpe_cap: 6,
      compliance_trigger: 0.7,
    },
    U12: { maintenance_held_at_rpe: 8, max_test_maintenance_lifts: false },
    U13: { small_edit_max_fraction: 0.3 },
    U14: {
      contacts_per_session: {
        return_or_sport_week: [40, 80],
        beginner: [80, 100],
        intermediate: [100, 120],
        advanced: [120, 140],
      },
    },
    U15: { compliance_target: 0.8 },
  },
  minors: {
    age_under: 18,
    parental_consent_required: true,
    max_rpe: 8,
    contacts_per_session_max: 80,
    max_testing: false,
    raised_pain_cap: false,
  },
  preview_ttl_hours: 24,
}

/** v1.1 (section 11): U4 Epley fallback with the method recorded; under-18 contacts ≤ 60 a session. */
export const METHODOLOGY_V1_1: Methodology = {
  ...METHODOLOGY_V1,
  version: METHODOLOGY_V1_1_VERSION,
  params: {
    ...METHODOLOGY_V1.params,
    U4: { ...METHODOLOGY_V1.params.U4, e1rm_without_rpe: 'epley' },
  },
  minors: { ...METHODOLOGY_V1.minors, contacts_per_session_max: 60 },
}

/** v1.2 (section 11a): the S&C review's U6 and U7 fixes. Everything else is v1.1. */
export const METHODOLOGY_V1_2: Methodology = {
  ...METHODOLOGY_V1_1,
  version: METHODOLOGY_V1_2_VERSION,
  params: {
    ...METHODOLOGY_V1_1.params,
    U6: { ...METHODOLOGY_V1_1.params.U6, single_day_sleep_under_hours: 5, single_day_stress_soreness_at: 5 },
    U7: {
      ...METHODOLOGY_V1_1.params.U7,
      worse_next_morning_at: 4,
      temporary_blocks: true,
      persistent_after: { over_stop_times: 2, within_days: 14, rising_sessions: 3 },
    },
  },
}

/** Every version the Worker can still resolve, by version string. */
export const METHODOLOGIES: Record<string, Methodology> = {
  [METHODOLOGY_V1_VERSION]: METHODOLOGY_V1,
  [METHODOLOGY_V1_1_VERSION]: METHODOLOGY_V1_1,
  [METHODOLOGY_V1_2_VERSION]: METHODOLOGY_V1_2,
}

/** The version new prescriptions run on. */
export const CURRENT_METHODOLOGY = METHODOLOGY_V1_2
