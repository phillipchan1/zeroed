/**
 * Zeroed Intelligence Engine — stub interface
 *
 * This module defines the typed surface for the 8 AI agents and deterministic
 * ranking logic. ALL implementations in this file are placeholders.
 * Prompt 3 fills these in with real LLM calls and Supabase Edge Functions.
 *
 * Architecture note:
 *   Client code should only call functions exported from this file.
 *   Never call Supabase or OpenAI directly from screen components.
 */

import type {
  DiagnosticResults,
  InsightInsert,
  InsightRow,
  InsightStatus,
  Priority,
  PhaseName,
  ExerciseTemplate,
} from '../types/database'
import { MOVEMENT_PATTERNS } from '../types/database'

// ---- Types -----------------------------------------------------------------

export interface GeneratedInsight extends InsightInsert {
  athlete_id: string
}

export interface GeneratedProgram {
  goal: string
  retest_date: string          // ISO date string, today + 28 days
  phase: {
    name: PhaseName
    week_start: string
    week_end: string
    non_negotiables: string[]
    advancement_criteria: string[]
  }
  routines: Array<{
    name: string
    session_type: string
    exercises: ExerciseTemplate[]
    intent: string
  }>
}

// ---- Agent stubs (TODO: Prompt 3) ------------------------------------------

/**
 * TODO (Prompt 3): DiagnosticAnalysisAgent
 * Real behavior: sends raw_results to Claude, gets structured weak-link analysis,
 * writes InsightDraft rows, then promotes to Insight via the promotion engine.
 */
export async function runDiagnosticAnalysisAgent(
  _athleteId: string,
  _results: DiagnosticResults,
): Promise<void> {
  // no-op until Prompt 3
}

/**
 * TODO (Prompt 3): SessionReviewAgent
 * Real behavior: after each workout, reads session_observations, compares
 * to existing insights, updates confidence, generates new drafts if warranted.
 */
export async function runSessionReviewAgent(
  _athleteId: string,
  _workoutId: string,
): Promise<void> {
  // no-op until Prompt 3
}

/**
 * TODO (Prompt 3): WeeklyReviewAgent
 * Real behavior: synthesizes week of sessions into a WeeklyReview row,
 * adjusts next-week prescription.
 */
export async function runWeeklyReviewAgent(
  _athleteId: string,
  _programId: string,
): Promise<void> {
  // no-op until Prompt 3
}

/**
 * TODO (Prompt 3): PhaseAdvancementAgent
 * Real behavior: checks advancement_criteria against accumulated session data,
 * triggers phase promotion if criteria are met.
 */
export async function checkPhaseAdvancement(
  _athleteId: string,
  _phaseId: string,
): Promise<boolean> {
  return false
}

// ---- Deterministic placeholder functions (used NOW) ------------------------
// These will be replaced in Prompt 3 but produce correct enough output
// for the Prompt 1 UI to work end-to-end.

const WEAK_LINK_DESCRIPTIONS: Record<string, string> = {
  deep_squat:        'Hip and ankle mobility limiting squat depth.',
  hurdle_step:       'Single-leg hip stability showing asymmetry.',
  inline_lunge:      'Hip flexor or ankle restricting lunge pattern.',
  shoulder_mobility: 'Shoulder posterior capsule or lat tightness.',
  aslr:              'Hamstring or hip flexor length asymmetry.',
  trunk_stability:   'Reflexive core stability under load is limited.',
  rotary_stability:  'Multi-planar coordination and anti-rotation weak.',
}

const PROGRAM_IMPACTS: Record<string, string> = {
  deep_squat:        'Load progression on squat patterns gated until score ≥ 2.',
  hurdle_step:       'Single-leg work prioritised; bilateral loading conservative.',
  inline_lunge:      'Lunge volume capped; hip flexor work added pre-session.',
  shoulder_mobility: 'Overhead pressing load held; CARs added daily.',
  aslr:              'Posterior chain loading conservative; lengthen first.',
  trunk_stability:   'No heavy spinal loading until trunk stability baseline clears.',
  rotary_stability:  'Rotational work excluded until pattern resolves.',
}

const STABILITY_ROUTINES_BY_CATEGORY: Record<string, ExerciseTemplate[][]> = {
  'Lower Chain': [
    [
      { name: 'Goblet Squat', sets: 3, reps: '8', load: 'light', cue: 'Chest tall — knees track toes' },
      { name: 'Single-Leg RDL', sets: 3, reps: '6 each side', load: 'light', cue: 'Soft knee — hip hinge, not back bend' },
      { name: 'Copenhagen Plank', sets: 3, reps: '20s hold', load: 'bodyweight', cue: 'Straight line hip to ankle' },
      { name: 'Ankle CARs', sets: 2, reps: '10 each direction', load: 'bodyweight', cue: 'Full range — deliberate and slow' },
    ],
    [
      { name: 'Split Squat', sets: 3, reps: '8 each side', load: 'light', cue: 'Back knee drops — front shin vertical' },
      { name: 'Hip Thrust', sets: 3, reps: '10', load: 'moderate', cue: 'Full hip extension — squeeze at top' },
      { name: 'Dead Bug', sets: 3, reps: '6 each side', load: 'bodyweight', cue: 'Lumbar flat to floor throughout' },
      { name: 'Hip 90/90 Stretch', sets: 2, reps: '60s each side', load: 'bodyweight', cue: 'Breathe into the stretch' },
    ],
    [
      { name: 'Step-Up', sets: 3, reps: '8 each side', load: 'light', cue: 'Drive through heel — control the descent' },
      { name: 'Glute Bridge', sets: 3, reps: '12', load: 'moderate', cue: 'Brace first — full squeeze at top' },
      { name: 'Pallof Press', sets: 3, reps: '10 each side', load: 'light', cue: 'Anti-rotate — slow and deliberate' },
      { name: "World's Greatest Stretch", sets: 2, reps: '5 each side', load: 'bodyweight', cue: 'Sequence fully through each position' },
    ],
  ],
  'Upper Chain': [
    [
      { name: 'Shoulder CARs', sets: 2, reps: '5 each direction', load: 'bodyweight', cue: 'Maximum range — zero compensation' },
      { name: 'Band Pull-Apart', sets: 3, reps: '15', load: 'light', cue: 'Scapulae retract and depress' },
      { name: 'Incline DB Row', sets: 3, reps: '10', load: 'moderate', cue: 'Lead with elbow — no trunk rotation' },
      { name: 'Wall Slide', sets: 3, reps: '10', load: 'bodyweight', cue: 'Elbows maintain contact with wall throughout' },
    ],
    [
      { name: 'Cable Face Pull', sets: 3, reps: '15', load: 'light', cue: 'External rotation at end range' },
      { name: 'Trap-3 Raise', sets: 3, reps: '12', load: 'light', cue: 'Scapular depression leads the lift' },
      { name: 'Serratus Wall Slide', sets: 2, reps: '10', load: 'bodyweight', cue: 'Protract fully at top' },
      { name: 'Thoracic Rotation', sets: 2, reps: '8 each side', load: 'bodyweight', cue: 'Eyes follow the hand' },
    ],
    [
      { name: 'Dead Hang', sets: 3, reps: '20s', load: 'bodyweight', cue: 'Active shoulders — not passive hang' },
      { name: 'DB External Rotation', sets: 3, reps: '12 each side', load: 'light', cue: 'Elbow pinned to side' },
      { name: 'Ring Row', sets: 3, reps: '8', load: 'bodyweight', cue: 'Chest to handles — control down' },
      { name: 'Lat Stretch', sets: 2, reps: '45s each side', load: 'bodyweight', cue: 'Side-bend — feel the pull' },
    ],
  ],
  'Core': [
    [
      { name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight', cue: 'Brace — don\'t hold breath' },
      { name: 'Dead Bug', sets: 3, reps: '8 each side', load: 'bodyweight', cue: 'Lumbar flat — exhale on extension' },
      { name: 'Bird Dog', sets: 3, reps: '8 each side', load: 'bodyweight', cue: 'Hips level — no rotation' },
      { name: 'McGill Curl-Up', sets: 2, reps: '8', load: 'bodyweight', cue: 'Neck neutral — raise shoulder blades only' },
    ],
    [
      { name: 'Side Plank', sets: 3, reps: '25s each side', load: 'bodyweight', cue: 'Hips forward — straight line' },
      { name: 'Pallof Press', sets: 3, reps: '10 each side', load: 'light', cue: 'Exhale on press — resist rotation' },
      { name: 'Hollow Body Hold', sets: 3, reps: '20s', load: 'bodyweight', cue: 'Low back imprinted — chin tucked' },
      { name: "Stir the Pot", sets: 2, reps: '8 each direction', load: 'bodyweight', cue: 'Controlled circles — no hip sway' },
    ],
    [
      { name: 'Bear Crawl', sets: 3, reps: '20m', load: 'bodyweight', cue: 'Knees hover 2 inches — opposite limbs move' },
      { name: 'Ab Wheel', sets: 3, reps: '6', load: 'bodyweight', cue: 'Brace hard — go only as far as pattern holds' },
      { name: 'Copenhagen Plank', sets: 3, reps: '20s each side', load: 'bodyweight', cue: 'Straight line top to bottom' },
      { name: 'Diaphragmatic Breathing', sets: 2, reps: '10 breaths', load: 'bodyweight', cue: '4 in — 6 out — full exhale resets' },
    ],
  ],
  'Posterior Chain': [
    [
      { name: 'Hip Hinge (Dowel)', sets: 3, reps: '10', load: 'bodyweight', cue: 'Dowel contact: head, thoracic, sacrum' },
      { name: 'Romanian Deadlift', sets: 3, reps: '8', load: 'light', cue: 'Hinge — bar traces shins, hamstring tension' },
      { name: 'Nordic Curl (Eccentric)', sets: 3, reps: '4', load: 'bodyweight', cue: 'Lower as slow as possible — 5s minimum' },
      { name: 'Supine Hip Extension', sets: 3, reps: '12', load: 'bodyweight', cue: 'Drive hips — squeeze at top' },
    ],
    [
      { name: 'Trap Bar Deadlift', sets: 3, reps: '6', load: 'light', cue: 'Push the floor away — chest stays up' },
      { name: 'GHR or Leg Curl', sets: 3, reps: '10', load: 'light', cue: 'Hamstring engages first — not glute' },
      { name: 'Single-Leg Hip Thrust', sets: 3, reps: '8 each side', load: 'bodyweight', cue: 'Full hip lock-out — no tilt' },
      { name: 'Supine Hip Flexor Stretch', sets: 2, reps: '60s each side', load: 'bodyweight', cue: 'Posterior tilt maintained' },
    ],
    [
      { name: 'Kettlebell Swing', sets: 4, reps: '10', load: 'moderate', cue: 'Hinge — not squat. Hip snap, not arm swing.' },
      { name: 'Back Extension', sets: 3, reps: '12', load: 'bodyweight', cue: 'Squeeze glutes at top — not low back hyperextension' },
      { name: 'Hamstring Stretch (90/90)', sets: 2, reps: '45s each side', load: 'bodyweight', cue: 'Dorsiflexion + knee extension' },
      { name: 'Cat-Cow', sets: 2, reps: '10', load: 'bodyweight', cue: 'Breathe into each position' },
    ],
  ],
}

function getRoutinesForCategory(category: string): ExerciseTemplate[][] {
  return (
    STABILITY_ROUTINES_BY_CATEGORY[category] ??
    STABILITY_ROUTINES_BY_CATEGORY['Lower Chain']
  )
}

function priorityForIndex(index: number): Priority {
  const map: Priority[] = ['P1', 'P2', 'P3', 'P4']
  return map[Math.min(index, 3)]
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

/**
 * PLACEHOLDER — generates insights deterministically from movement scores.
 * Priority assigned by score severity (lowest score = P1).
 * Replace with real DiagnosticAnalysisAgent output in Prompt 3.
 */
export function generateInsightsFromDiagnostic(
  athleteId: string,
  diagnosticId: string,
  results: DiagnosticResults,
): GeneratedInsight[] {
  const insights: GeneratedInsight[] = []

  // Movement screen weak links (score < 2)
  const weakPatterns = MOVEMENT_PATTERNS
    .map((p) => ({ ...p, score: results.movement[p.key] ?? 3 }))
    .filter((p) => p.score < 2)
    .sort((a, b) => a.score - b.score)

  weakPatterns.forEach((pattern, idx) => {
    insights.push({
      athlete_id: athleteId,
      source_id: diagnosticId,
      claim: `${pattern.label} scored ${pattern.score}/3 — ${WEAK_LINK_DESCRIPTIONS[pattern.key] ?? 'Pattern is limited.'}`,
      category: pattern.category,
      priority: priorityForIndex(idx),
      confidence: 0.65,  // baseline from objective movement test
      status: 'likely',
      evidence: [{ test: 'movement_screen', score: pattern.score, pattern: pattern.key }],
      source: 'diagnostic',
      program_impact: PROGRAM_IMPACTS[pattern.key] ?? null,
    })
  })

  // Strength imbalances (simple ratio check)
  const { strength } = results
  if (strength.squat_1rm_est && strength.hinge_1rm_est) {
    const ratio = strength.squat_1rm_est / strength.hinge_1rm_est
    if (ratio > 1.15) {
      insights.push({
        athlete_id: athleteId,
        source_id: diagnosticId,
        claim: `Squat/hinge ratio ${ratio.toFixed(2)} — posterior chain relatively undertrained.`,
        category: 'Posterior Chain',
        priority: priorityForIndex(insights.length),
        confidence: 0.55,
        status: 'hypothesis',
        evidence: [{ squat: strength.squat_1rm_est, hinge: strength.hinge_1rm_est, ratio }],
        source: 'diagnostic',
        program_impact: 'Hip hinge volume increased relative to knee-dominant patterns.',
      })
    }
  }

  return insights
}

/**
 * PLACEHOLDER — generates a basic 4-week Stability program.
 * Selects routines based on the P1 insight (insights[0], highest priority).
 * Replace with ProgramDesignAgent in Prompt 3.
 *
 * Accepts the full ranked insight list so each exercise can be attributed to
 * the insight that placed it (Shift 5 — the "why" surface in WorkoutScreen).
 */
export function generateInitialProgram(
  insights: InsightRow[],
  startDateStr: string,
): GeneratedProgram {
  // P1 insight drives the whole Stability block.
  const p1Insight = insights[0] ?? null
  const p1Category = p1Insight?.category ?? 'Lower Chain'

  const retestDate = addDays(startDateStr, 28)
  const weekEnd = addDays(startDateStr, 27)

  const routineExercises = getRoutinesForCategory(p1Category)

  // ──────────────────────────────────────────────────────────────────────────
  // PROGRAM-DESIGN SEAM (TODO Prompt 3: ProgramDesignAgent)
  // The deterministic Stability block only ever builds P1-category routines, so
  // every exercise is attributed to the P1 insight. When the real
  // ProgramDesignAgent lands it should write per-exercise insight_id here,
  // mapping individual exercises to P2/P3 insights they address. This stamping
  // is the single place to do that — screens read exercise.insight_id directly.
  // ──────────────────────────────────────────────────────────────────────────
  const stamp = (exs: ExerciseTemplate[]): ExerciseTemplate[] =>
    p1Insight ? exs.map((ex) => ({ ...ex, insight_id: p1Insight.id })) : exs

  const routines = [
    { name: 'Session A', session_type: 'strength', exercises: stamp(routineExercises[0]), intent: `Primary address of ${p1Category} — pattern quality first.` },
    { name: 'Session B', session_type: 'strength', exercises: stamp(routineExercises[1]), intent: `${p1Category} variation — load exposure maintained low.` },
    { name: 'Session C', session_type: 'strength', exercises: stamp(routineExercises[2]), intent: `Integration session — patterns under mild fatigue.` },
  ]

  const nonNegotiables: Record<string, string[]> = {
    'Lower Chain': [
      'Single-leg work each session',
      'Hip hinge pattern daily',
      'Ankle mobility 5 min pre-session',
    ],
    'Upper Chain': [
      'Shoulder CARs daily (2 sets)',
      'Scapular control cues before pressing',
      'Pulling:Pressing ratio minimum 2:1',
    ],
    'Core': [
      'Bracing cue on every loaded exercise',
      'Anti-rotation work before loaded compound',
      'No heavy spinal loading until pattern clears',
    ],
    'Posterior Chain': [
      'Hamstring lengthening sequence pre-session',
      'Hip flexor mobilisation daily',
      'Foot position and shin angle awareness',
    ],
  }

  const advancementCriteria = [
    `Movement screen score ≥ 2 on ${p1Category} pattern`,
    'Zero pain signals in 3 consecutive sessions',
    'Strength baseline retest within 5% of initial',
  ]

  return {
    goal: `Address ${p1Category} weakness. Establish movement quality before loading.`,
    retest_date: retestDate,
    phase: {
      name: 'Stability',
      week_start: startDateStr,
      week_end: weekEnd,
      non_negotiables: nonNegotiables[p1Category] ?? nonNegotiables['Lower Chain'],
      advancement_criteria: advancementCriteria,
    },
    routines,
  }
}

/**
 * PLACEHOLDER — updates an insight's confidence after a session observation.
 * Positive signals (+1 confidence), negative signals keep or flag.
 * Replace with SessionReviewAgent logic in Prompt 3.
 */
export function computeConfidenceUpdate(
  currentConfidence: number,
  observationSignal: string,
): number {
  const positive = ['PR hit', 'Felt strong']
  const negative = ['Form breakdown', 'Pain signal', 'Struggled with load']

  if (positive.some((s) => observationSignal.includes(s))) {
    return Math.min(1, currentConfidence + 0.05)
  }
  if (negative.some((s) => observationSignal.includes(s))) {
    return Math.min(1, currentConfidence + 0.03)
  }
  return currentConfidence
}

// ============================================================================
// Session observation → insight mapping
// PLACEHOLDER — replace with SessionReviewAgent in Prompt 3.
// All mapping logic lives here so the real engine can swap it without touching
// any screen component.
// ============================================================================

/**
 * Maps an observation label + free-text signal to the closest insight category.
 * Uses keyword detection on the signal note for pain/form observations;
 * falls back to a fixed mapping for the other labels.
 */
export function mapObservationToInsightCategory(
  observationLabel: string,
  signalText: string,
): string {
  const text = signalText.toLowerCase()

  // Pain and form breakdowns: keyword-detect the body region from the note
  if (observationLabel === 'Pain signal' || observationLabel === 'Form breakdown') {
    if (/knee|ankle|hip|squat|lunge|calf|shin|quad|it.?band/.test(text)) return 'Lower Chain'
    if (/shoulder|elbow|wrist|press|push|overhead|rotator|pec/.test(text))  return 'Upper Chain'
    if (/hamstring|glute|deadlift|hinge|rdl|posterior/.test(text))          return 'Posterior Chain'
    if (/back|spine|core|ab|lumbar|thoracic/.test(text))                    return 'Core'
    return 'Lower Chain' // default: most common pain site
  }

  // Strength observations always map to Strength
  if (observationLabel === 'PR hit' ||
      observationLabel === 'Felt strong' ||
      observationLabel === 'Struggled with load') {
    return 'Strength'
  }

  // Energy maps to Recovery
  if (observationLabel === 'Energy flag') return 'Recovery'

  return 'Lower Chain' // catch-all fallback
}

export interface ObservationAction {
  insightCategory: string
  action: 'update' | 'create'
  // update
  existingInsightId: string | null
  updatedConfidence: number | null
  updatedEvidence: unknown[] | null
  updatedStatus: InsightStatus | null  // null = leave status unchanged
  // create
  newInsight: InsightInsert | null
}

// ────────────────────────────────────────────────────────────────────────────
// Status-advancement thresholds (DETERMINISTIC PLACEHOLDERS)
// TODO Prompt 3: SessionReviewAgent replaces these with model-driven judgement.
// Confidence thresholds at which an insight advances one tier:
//   Hypothesis → Likely   at ≥ 0.50
//   Likely     → Confirmed at ≥ 0.80
//   Resolved / Disproved stay MANUAL (never auto-advanced here).
// ────────────────────────────────────────────────────────────────────────────
const STATUS_THRESHOLDS = {
  likely: 0.50,
  confirmed: 0.80,
} as const

/**
 * Given a current status and a (possibly nudged) confidence, returns the new
 * status if a threshold was crossed, otherwise null. Only advances forward
 * through hypothesis → likely → confirmed. Resolved/disproved are terminal here.
 */
function advanceStatus(
  current: InsightStatus,
  confidence: number,
): InsightStatus | null {
  if (current === 'hypothesis' && confidence >= STATUS_THRESHOLDS.confirmed) return 'confirmed'
  if (current === 'hypothesis' && confidence >= STATUS_THRESHOLDS.likely)    return 'likely'
  if (current === 'likely'     && confidence >= STATUS_THRESHOLDS.confirmed) return 'confirmed'
  return null
}

/**
 * PLACEHOLDER — resolves what the insight stack should do after an observation.
 * One data point → Hypothesis only. Never jumps to Confirmed from a single session.
 * Replace with SessionReviewAgent in Prompt 3.
 */
export function resolveObservationAction(
  athleteId: string,
  workoutId: string,
  observationLabel: string,
  signalText: string,
  severity: number,
  existingInsights: InsightRow[],
): ObservationAction {
  const insightCategory = mapObservationToInsightCategory(observationLabel, signalText)

  const evidenceEntry = {
    workout_id: workoutId,
    observation: observationLabel,
    signal: signalText,
    severity,
    logged_at: new Date().toISOString(),
  }

  // Find the highest-priority active insight in this category
  const existing = existingInsights
    .filter((i) =>
      i.category === insightCategory &&
      i.status !== 'resolved' &&
      i.status !== 'disproved',
    )
    .sort((a, b) => a.priority.localeCompare(b.priority))[0] ?? null

  if (existing) {
    // Nudge confidence — small delta, single session is weak evidence
    const delta = severity >= 4 ? 0.04 : severity >= 3 ? 0.03 : 0.02
    const updatedConfidence = Math.min(0.95, existing.confidence + delta)
    const updatedEvidence   = [...(Array.isArray(existing.evidence) ? existing.evidence : []), evidenceEntry]

    // Advance status if the nudged confidence crosses a threshold (placeholder).
    const updatedStatus = advanceStatus(existing.status, updatedConfidence)

    return {
      insightCategory,
      action:            'update',
      existingInsightId: existing.id,
      updatedConfidence,
      updatedEvidence,
      updatedStatus,
      newInsight:        null,
    }
  }

  // No existing insight in this category — create a new Hypothesis
  const note = signalText.replace(`${observationLabel} — `, '').replace(observationLabel, '').trim()
  const claim = note
    ? `${observationLabel} reported — ${note}. Single data point.`
    : `${observationLabel} logged during session. Single data point.`

  return {
    insightCategory,
    action:            'create',
    existingInsightId: null,
    updatedConfidence: null,
    updatedEvidence:   null,
    updatedStatus:     null,
    newInsight: {
      athlete_id:     athleteId,
      source_id:      workoutId,
      claim,
      category:       insightCategory,
      priority:       'P3' as Priority,   // new, unconfirmed — starts at P3
      confidence:     0.25,               // one data point = Hypothesis
      status:         'hypothesis',
      evidence:       [evidenceEntry],
      source:         'session_observation',
      program_impact: null,
    },
  }
}

// ============================================================================
// Insight movement summary (Shift 4 panel + Shift 6 header metric)
// DETERMINISTIC PLACEHOLDER — reads the trigger-maintained updated_at /
// prev_status columns to describe what shifted this week.
// TODO Prompt 3: WeeklyReviewAgent will narrate this with real language.
// ============================================================================

export type InsightMovementKind = 'transition' | 'evidence' | 'new'

export interface InsightMovement {
  insight: InsightRow
  kind: InsightMovementKind
  fromStatus: InsightStatus | null  // populated for 'transition'
  toStatus: InsightStatus
  label: string                     // e.g. "Hypothesis → Likely" | "New signal" | "+ evidence"
}

export interface InsightMovementSummary {
  movements: InsightMovement[]
  movedCount: number      // transitions + new insights this week
  p1Progressing: number   // P1 insights that advanced status this week
  headline: string | null // e.g. "2 insights moved · 1 P1 progressing"
}

function capStatus(s: InsightStatus): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 }

/**
 * Classifies each insight's movement within the current week.
 *   • new        — generated this week
 *   • transition — status changed this week (prev_status set by the DB trigger)
 *   • evidence   — touched this week (updated_at) but status held steady
 * Insights untouched this week are omitted.
 */
export function summarizeInsightMovement(
  insights: InsightRow[],
  weekStart: Date,
): InsightMovementSummary {
  const startMs = weekStart.getTime()
  const movements: InsightMovement[] = []

  for (const insight of insights) {
    const generatedMs = new Date(insight.generated_at).getTime()
    const updatedMs   = new Date(insight.updated_at).getTime()

    const isNew       = generatedMs >= startMs
    const touched     = updatedMs >= startMs
    const transitioned =
      touched &&
      insight.prev_status != null &&
      insight.prev_status !== insight.status

    if (isNew) {
      movements.push({
        insight,
        kind: 'new',
        fromStatus: null,
        toStatus: insight.status,
        label: 'New signal',
      })
    } else if (transitioned) {
      movements.push({
        insight,
        kind: 'transition',
        fromStatus: insight.prev_status,
        toStatus: insight.status,
        label: `${capStatus(insight.prev_status!)} → ${capStatus(insight.status)}`,
      })
    } else if (touched) {
      movements.push({
        insight,
        kind: 'evidence',
        fromStatus: null,
        toStatus: insight.status,
        label: '+ evidence',
      })
    }
  }

  // Rank: transitions first, then new, then evidence; within each, by priority.
  const kindRank: Record<InsightMovementKind, number> = { transition: 0, new: 1, evidence: 2 }
  movements.sort((a, b) =>
    kindRank[a.kind] - kindRank[b.kind] ||
    PRIORITY_RANK[a.insight.priority] - PRIORITY_RANK[b.insight.priority],
  )

  const movedCount = movements.filter((m) => m.kind === 'transition' || m.kind === 'new').length
  const p1Progressing = movements.filter(
    (m) => m.kind === 'transition' && m.insight.priority === 'P1',
  ).length

  let headline: string | null = null
  if (movedCount > 0) {
    const parts = [`${movedCount} insight${movedCount === 1 ? '' : 's'} moved`]
    if (p1Progressing > 0) parts.push(`${p1Progressing} P1 progressing`)
    headline = parts.join(' · ')
  }

  return { movements, movedCount, p1Progressing, headline }
}

// ============================================================================
// Status counts (Shift 6 — ProfileScreen header)
// ============================================================================

export interface StatusCount {
  status: InsightStatus
  count: number
}

/**
 * Counts insights by status, in display order. Returns only statuses with > 0.
 */
export function countInsightsByStatus(insights: InsightRow[]): StatusCount[] {
  const order: InsightStatus[] = ['hypothesis', 'likely', 'confirmed', 'resolved', 'disproved']
  return order
    .map((status) => ({ status, count: insights.filter((i) => i.status === status).length }))
    .filter((s) => s.count > 0)
}
