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

// Arena archetype — Convergence Move 1 ("what do you want to be able to do?").
// The persisted enum (athlete.arena_type, migration 20260602000001). The rich
// demand-table logic in engine/demandTables.ts imports this as its source.
export type ArenaType =
  | 'sport'        // "Excel at basketball"
  | 'number'       // "285 bench", "first pull-up"
  | 'body'         // "Get jacked", "lean down"
  | 'durability'   // "Stop getting hurt", "pain-free at 45"
  | 'event'        // "Spartan in October", "marathon"
  | 'all_around'   // "Be a complete athlete" — the default wide cloud

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
  arena_type: ArenaType | null
  arena_raw: string | null
  limiter_choice: string | null
  // What the athlete has told the coach they want their training to include,
  // newest first. Written by the program editor on Apply and fed to phase design
  // as the emphasis, so a preference outlives the block it was stated in.
  training_preferences: string | null
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
  intended_dow: number | null   // soft day-pin: 0=Mon..6=Sun, null=any (never enforced)
}

export interface WorkoutRow {
  id: string
  routine_id: string
  performed_at: string
  actual_weights: Record<string, SetLog[]> | null
  actual_reps: Record<string, number[]> | null
  rpe: number | null
  duration_mins: number | null
  /**
   * The routine's exercises AS THEY WERE when this session was logged.
   * `actual_weights` is index-keyed against THIS array — not the routine's live
   * one, which the program editor rewrites in place. Null only for sessions
   * logged before the snapshot shipped; `resolveLoggedExercises` falls back to
   * the routine for those.
   */
  exercises_snapshot: ExerciseTemplate[] | null
}

/** How a reprogramming event came about. */
export type RevisionTrigger = 'editor' | 'phase_boundary' | 'retest' | 'deload'

/** One session's shape inside a revision snapshot — a frozen DraftSession. */
export interface RevisionSession {
  name: string
  intent: string
  session_type: string
  intended_dow: number | null
  exercises: ExerciseTemplate[]
}

/**
 * An append-only record of one reprogramming event (table program_revision).
 * Never updated, never deleted: it is both the athlete's journey and the memory
 * that reprogramming reads back so each block knows what came before it.
 */
export interface ProgramRevisionRow {
  id: string
  program_id: string
  phase_id: string | null
  created_at: string
  trigger: RevisionTrigger
  /** When the change takes effect — today for an immediate apply, next Monday for a deferred one. */
  effective_on: string
  /** The athlete's own words, newest first. */
  requests: string[]
  /** The full week before the change — the restore point. */
  snapshot: RevisionSession[]
  /** What moved, precomputed so a timeline renders without replaying snapshots. */
  diff: RevisionDiff
  summary: string | null
}

export interface RevisionDiff {
  added: number
  removed: number
  changed: number
  new_sessions: number
  sessions: Array<{
    name: string
    changes: Array<{ kind: string; name: string; before?: string; after?: string }>
  }>
}

// An in-progress session, autosaved as it's logged (table workout_draft). Staged
// separately from `workout` so it's never mistaken for a completed session;
// promoted to a real workout row and deleted on "Complete workout".
export interface WorkoutDraftRow {
  id: string
  athlete_id: string
  routine_id: string
  set_logs: Record<string, SetLog[]>
  feedback: Record<string, ExerciseFeedback>
  elapsed_seconds: number
  started_at: string
  updated_at: string
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
  adjustments: WeeklyReviewAdjustments | null
  next_week_prescription: WeeklyPrescription | null
}

export type CoachMessageRole = 'coach' | 'athlete'
export type CoachMessageKind = 'note' | 'weekly_review' | 'phase_change' | 'retest' | 'chat'

export interface CoachMessageRow {
  id: string
  athlete_id: string
  role: CoachMessageRole
  kind: CoachMessageKind
  body: string
  ref_id: string | null
  created_at: string
}

// ---- Weekly review value types (deterministic autoregulation, §4.3) --------

// RECOVERY is the explicit injury / time-off directive — an athlete-declared
// back-off that the deterministic engine never infers on its own.
export type WeeklyDirective = 'PROGRESS' | 'DELOAD' | 'HOLD' | 'HOLD (missed)' | 'RECOVERY'

export interface WeeklyReviewAdjustments {
  avgRPE: number | null
  adherence: number
  painCount: number
  positiveCount: number
  flagged_categories: string[]
}

export interface WeeklyPrescription {
  directive: WeeklyDirective
  load_delta_pct: number
  rpe_target: number
  rationale: string
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

// How a movement is measured — drives which inputs the SetRow renders and what
// "a rep" means to the engine. A CLOSED vocabulary: the agent never invents one.
// tracking_type is resolved deterministically from the exercise library (with a
// heuristic fallback) — see src/engine/exerciseLibrary.ts. "agent proposes the
// exercise, code disposes the metric."
export const TRACKING_TYPES = [
  'weight_reps',      // external load × reps (barbell, DB, machine, cable)
  'bodyweight_reps',  // reps, optional added load (push-up, BSS, pull-up)
  'time',             // a held or worked duration in seconds (planks, carries, holds)
  'distance',         // a measured length (broad jump, sprint, loaded carry)
] as const

export type TrackingType = typeof TRACKING_TYPES[number]

export interface ExerciseTemplate {
  name: string
  sets: number
  reps: string        // e.g. "8" | "8-10" | "30s"
  load?: string       // e.g. "light" | "moderate" | "bodyweight"
  cue?: string
  // Intended effort for THIS lift (1–10). Drives per-exercise RPE autoregulation
  // in gatherSessionPrescription — each lift tunes to its own target rather than a
  // single program-wide number. Optional; falls back to the week's target.
  target_rpe?: number
  insight_id?: string // the insight this exercise was placed to address (Shift 5)
  // How this movement is logged. Optional on disk: legacy/agent routines omit it
  // and the WorkoutScreen resolves an effective type from the library at render.
  tracking_type?: TrackingType
  // Info-gain "test me" item — at most one per session. Marks the single
  // highest-info-gain pattern check, shown as a static computing-cyan READING
  // tag with tap-to-see-why. Its observation feeds the session debrief.
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
  // Type-specific metrics — only the field for the exercise's tracking_type is
  // ever populated. JSONB-backed (workout.actual_weights), so additive & safe.
  duration?: number | null   // seconds, for tracking_type 'time'
  distance?: number | null   // in the athlete's distance unit, for 'distance'
}

// ---- Per-session feedback (the loop's fuel) --------------------------------
// Captured in the WorkoutScreen and written as session_observation rows (the
// table's category is free-text), so NO migration is required. The session
// debrief agent mines these into insight movement; a deterministic fallback
// maps each felt chip to an observation if the agent is unavailable.

// One-tap per-exercise "felt" signal — the Notion log's "Felt" column. severity
// maps onto session_observation.severity (1–5).
export const FELT_CHIPS = [
  { label: 'Easy',   tone: 'good', severity: 1 },
  { label: 'Solid',  tone: 'good', severity: 1 },
  { label: 'Hard',   tone: 'mid',  severity: 3 },
  { label: 'Off',    tone: 'mid',  severity: 2 },
  { label: 'Tweak',  tone: 'bad',  severity: 4 },
  { label: 'Pain',   tone: 'veto', severity: 5 },
] as const

export type FeltLabel = typeof FELT_CHIPS[number]['label']

export interface ExerciseFeedback {
  name: string             // exercise name, so the agent can attribute it
  felt: FeltLabel | null
  note: string             // optional free text ("weaker on left side")
  // The athlete deliberately went above the recommendation on this lift. Not the
  // same as simply logging a heavier set: it is a stated intention to test the
  // cap, which is what makes the result EVIDENCE rather than noise. A pushed set
  // that lands pain-free argues against the limiter; one that hurts argues for it.
  pushed?: boolean
}

// ---- The clearance test (how a limiter is allowed to end) ------------------
// A limiter used to be a wall with no door: load stayed capped "until the pattern
// clears", and nothing in the system could ever decide it had. This makes the
// exit condition explicit, dated, and falsifiable — the athlete can read exactly
// what would clear it and go and do that.
//
// Stored inside insight.evidence (JSONB, already a list of typed entries), so no
// migration. Code owns every number here; the agent may only draft prose.

export interface ClearanceCriterion {
  top_sets: number        // qualifying top sets required per session
  min_rpe: number         // ...at or above this effort
  sessions: number        // ...across this many separate sessions
  pain_free: true         // always — a painful rep never counts toward clearing
}

export interface ClearanceTest {
  kind: 'clearance_test'
  lift: string            // the exercise that has to carry the proof
  criterion: ClearanceCriterion
  opened_at: string
  sessions_passed: number
  status: 'open' | 'passed' | 'reconfirmed'
  // Each qualifying session, newest last — so progress survives a reload and the
  // athlete can see which sessions actually counted.
  log?: Array<{ workout_id: string; passed: boolean; at: string }>
}

export function isClearanceTest(e: unknown): e is ClearanceTest {
  return !!e && typeof e === 'object' && (e as { kind?: string }).kind === 'clearance_test'
}

// Pre-session readiness — JuggernautAI's gate. 1–5 quick taps, all optional.
export interface Readiness {
  sleep: number | null
  energy: number | null
  soreness: number | null
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

export type WorkoutDraftInsert = Omit<WorkoutDraftRow, 'id' | 'started_at' | 'updated_at'>

export type SessionObservationInsert = Omit<SessionObservationRow, 'id' | 'logged_at'>

export type WeeklyReviewInsert = Omit<WeeklyReviewRow, 'id'>

export type CoachMessageInsert = Omit<CoachMessageRow, 'id' | 'created_at'>

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
