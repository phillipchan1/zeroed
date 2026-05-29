// Supabase database types — generated from migration schema
// Keep in sync with supabase/migrations/20260528000001_schema.sql

export type Priority = 'P1' | 'P2' | 'P3' | 'P4'

export type InsightStatus =
  | 'hypothesis'
  | 'likely'
  | 'confirmed'
  | 'resolved'
  | 'disproved'

export type PhaseName = 'Stability' | 'Strength' | 'Power' | 'Sport'

export type PhaseStatus = 'pending' | 'active' | 'completed' | 'skipped'

export type ProgramStatus = 'draft' | 'active' | 'completed' | 'paused'

// Onboarding state machine — Confidence-Driven Read (migration 20260601000001).
// Gates the SESSION, not the read: no movement-screen gate. The probe is
// pre-auth/ephemeral (no athlete row yet) so it lives in HookAct sub-state under
// 'hook'; the provisional first session is built in an ephemeral "calibrating"
// beat during the orientation → first_session_pending transition (no DB step).
export type OnboardingStep =
  | 'hook'                    // pre-auth: splash → obstacle → probe → reveal (ephemeral sub-states)
  | 'orientation'             // post-auth: trimmed calibrate fields + ephemeral build beat
  | 'first_session_pending'   // session handed over, not yet logged
  | 'first_session_complete'  // session logged; post-session revelation
  | 'complete'                // in the daily loop

// Onboarding steps that render inside the OnboardingRouter (no nav, no URL).
// first_session_pending onward render the daily loop (routed by App).
export const ONBOARDING_FUNNEL_STEPS: ReadonlySet<OnboardingStep> = new Set([
  'hook', 'orientation',
])

// ---- Row types (returned by SELECT) ----------------------------------------

export interface AthleteRow {
  id: string
  auth_user_id: string
  name: string | null
  sport: string | null
  goals: string | null
  training_age: number | null
  sessions_per_week: number | null
  created_at: string
  onboarding_step: OnboardingStep
  obstacle: string | null
}

export interface DiagnosticRow {
  id: string
  athlete_id: string
  assessed_at: string
  test_battery: Record<string, unknown> | null
  raw_results: DiagnosticResults | null
  delta_from_prior: Record<string, unknown> | null
  version: number
}

export interface InsightRow {
  id: string
  athlete_id: string
  source_id: string | null
  claim: string
  category: string
  priority: Priority
  confidence: number
  status: InsightStatus
  evidence: unknown[] | null
  source: string | null
  program_impact: string | null
  generated_at: string
  resolved_at: string | null
  updated_at: string
  prev_status: InsightStatus | null
}

export interface InsightDraftRow extends InsightRow {
  reviewed: boolean
}

export interface AthleteProfileRow {
  id: string
  athlete_id: string
  last_updated: string
  current_phase: PhaseName | null
  retest_date: string | null
}

export interface ProgramRow {
  id: string
  athlete_id: string
  goal: string | null
  start_date: string
  retest_date: string | null
  status: ProgramStatus
}

export interface PhaseRow {
  id: string
  program_id: string
  name: PhaseName
  week_start: string
  week_end: string
  non_negotiables: string[] | null
  advancement_criteria: string[] | null
  status: PhaseStatus
}

export interface RoutineRow {
  id: string
  program_id: string
  phase_id: string | null
  name: string
  session_type: string | null
  exercises: ExerciseTemplate[]
  intent: string | null
}

export interface WorkoutRow {
  id: string
  routine_id: string
  performed_at: string
  actual_weights: Record<string, SetLog[]> | null
  actual_reps: Record<string, number[]> | null
  rpe: number | null
  duration_mins: number | null
}

export interface SessionObservationRow {
  id: string
  workout_id: string
  category: string
  signal: string
  severity: number
  logged_at: string
}

export interface WeeklyReviewRow {
  id: string
  program_id: string
  week_ending: string
  coach_notes: string | null
  adjustments: unknown | null
  next_week_prescription: unknown | null
}

// ---- Domain value types ----------------------------------------------------

export interface DiagnosticResults {
  movement: Record<string, number>       // pattern key → score 0–3
  strength: Record<string, number | null>
  subjective: {
    sleep: number
    energy: number
    stress: number
    pain: string
  }
  sport_profile?: {
    sport: string
    goals: string
    training_age: number
    sessions_per_week: number
  }
}

export interface ExerciseTemplate {
  name: string
  sets: number
  reps: string        // e.g. "8" | "8-10" | "30s"
  load?: string       // e.g. "light" | "moderate" | "bodyweight"
  cue?: string
  insight_id?: string // the insight this exercise was placed to address (Shift 5)
  // Info-gain "test me" item — at most one per session. Marks the single
  // highest-info-gain pattern check, shown as a static computing-cyan READING
  // tag with tap-to-see-why. Its observation feeds runSessionReviewAgent.
  reading?: boolean
  pattern_key?: string   // MovementPatternKey this reading probes
  reading_why?: string   // info-gain rationale, shown on tap
}

export interface SetLog {
  set: number
  weight: number | null
  reps: number | null
  rpe: number | null
  done: boolean
}

// ---- Insert types ----------------------------------------------------------

export type AthleteInsert = Omit<AthleteRow, 'id' | 'created_at'>

export type DiagnosticInsert = Omit<DiagnosticRow, 'id' | 'assessed_at'>

export type InsightInsert = Omit<
  InsightRow,
  'id' | 'generated_at' | 'resolved_at' | 'updated_at' | 'prev_status'
>

export type AthleteProfileInsert = Omit<AthleteProfileRow, 'id' | 'last_updated'>

export type ProgramInsert = Omit<ProgramRow, 'id'>

export type PhaseInsert = Omit<PhaseRow, 'id'>

export type RoutineInsert = Omit<RoutineRow, 'id'>

export type WorkoutInsert = Omit<WorkoutRow, 'id' | 'performed_at'>

export type SessionObservationInsert = Omit<SessionObservationRow, 'id' | 'logged_at'>

// ---- Movement screen constants ---------------------------------------------

export const MOVEMENT_PATTERNS = [
  { key: 'deep_squat',        label: 'Deep Squat',              category: 'Lower Chain' },
  { key: 'hurdle_step',       label: 'Hurdle Step',             category: 'Lower Chain' },
  { key: 'inline_lunge',      label: 'Inline Lunge',            category: 'Lower Chain' },
  { key: 'shoulder_mobility', label: 'Shoulder Mobility',       category: 'Upper Chain' },
  { key: 'aslr',              label: 'Active Straight-Leg Raise', category: 'Posterior Chain' },
  { key: 'trunk_stability',   label: 'Trunk Stability Push-Up', category: 'Core' },
  { key: 'rotary_stability',  label: 'Rotary Stability',        category: 'Core' },
] as const

export type MovementPatternKey = typeof MOVEMENT_PATTERNS[number]['key']

export const OBSERVATION_CATEGORIES = [
  'Form breakdown',
  'Energy flag',
  'Pain signal',
  'PR hit',
  'Felt strong',
  'Struggled with load',
] as const

export type ObservationCategory = typeof OBSERVATION_CATEGORIES[number]

// Maps observation category labels to insight category keys
export const OBS_TO_INSIGHT_CATEGORY: Record<string, string> = {
  'Form breakdown':    'Lower Chain',
  'Energy flag':       'Recovery',
  'Pain signal':       'Lower Chain',
  'PR hit':            'Strength',
  'Felt strong':       'Strength',
  'Struggled with load': 'Strength',
}
