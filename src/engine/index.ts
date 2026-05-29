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
import { supabase } from '../lib/supabaseClient'
import {
  callProbe, callSessionReview, callProgramDesign, callInfoGain,
  type ProgramDesignResult, type InsightCategory,
} from './agentClient'
import { validateProvisionalProgram } from './safety'

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

// ────────────────────────────────────────────────────────────────────────────
// CONFIDENCE MATH (deterministic — agent CLASSIFIES, code DISPOSES)
// The agent never returns a number. It returns a direction + magnitude, and
// THIS table is the only place a confidence delta is decided. Bounded by design:
// no single observation can move confidence more than ±0.15.
// ────────────────────────────────────────────────────────────────────────────
const CONFIDENCE_STEP: Record<'confirming' | 'disconfirming' | 'neutral', Record<'weak' | 'moderate' | 'strong', number>> = {
  confirming:    { weak: 0.05, moderate: 0.10, strong: 0.15 },
  disconfirming: { weak: -0.05, moderate: -0.10, strong: -0.15 },
  neutral:       { weak: 0.0, moderate: 0.0, strong: 0.0 },
}

export function boundedConfidenceDelta(
  direction: 'confirming' | 'disconfirming' | 'neutral',
  magnitude: 'weak' | 'moderate' | 'strong',
): number {
  return CONFIDENCE_STEP[direction][magnitude]
}

function clampConfidence(c: number): number {
  return Math.max(0, Math.min(1, c))
}

/**
 * DiagnosticAnalysisAgent → reframed as the Probe (the new "first read").
 *
 * In the Confidence-Driven Read, the wall-of-7 diagnostic is retired: the first
 * read comes from the athlete's obstacle text via the agentic Probe. This calls
 * the `probe` task (server-side model) and returns a single early, falsifiable
 * hypothesis. If the model fails, it falls back to a deterministic keyword read
 * so the app always produces a (low-confidence) hypothesis.
 *
 * agent proposes → code disposes: the agent's confidence is clamped to [0,1] and
 * floored low here; nothing downstream trusts it as certainty.
 */
export interface ProbeOutcome {
  source: 'agent' | 'fallback'
  followupQuestion: string | null
  hypothesis: {
    claim: string
    category: string
    confidence: number
    rationale: string
  }
}

const OBSTACLE_CATEGORY_HINTS: Array<{ test: RegExp; category: string }> = [
  { test: /knee|ankle|squat|lunge|calf|shin|quad|hip(?!\s*flex)/i, category: 'Lower Chain' },
  { test: /shoulder|elbow|wrist|press|overhead|rotator|pec|bench/i, category: 'Upper Chain' },
  { test: /hamstring|glute|deadlift|hinge|rdl|posterior|sprint|run/i, category: 'Posterior Chain' },
  { test: /back|spine|core|ab|lumbar|brace|rotation/i, category: 'Core' },
  { test: /tired|sleep|energy|recover|stress|burn|fatigue/i, category: 'Recovery' },
  { test: /weak|strong|stall|plateau|stuck|1rm|max/i, category: 'Strength' },
]

function deterministicProbe(obstacle: string): ProbeOutcome {
  const category =
    OBSTACLE_CATEGORY_HINTS.find((h) => h.test.test(obstacle))?.category ?? 'Lower Chain'
  return {
    source: 'fallback',
    followupQuestion: 'When it shows up, is it a sharp limit you can point to, or a slow fade across the session?',
    hypothesis: {
      claim: `Most likely a ${category.toLowerCase()} limiter — we'll sharpen this as you train.`,
      category,
      confidence: 0.2, // one line of text, no screening yet: deliberately low
      rationale: 'Inferred from the language of your obstacle alone; unverified.',
    },
  }
}

export async function runDiagnosticAnalysisAgent(
  obstacle: string,
  followupAnswer?: string,
): Promise<ProbeOutcome> {
  const result = await callProbe({ obstacle, followup_answer: followupAnswer })

  if (result.ok) {
    const h = result.data.hypothesis
    return {
      source: 'agent',
      followupQuestion: result.data.followup_question,
      hypothesis: {
        claim: h.claim,
        category: h.category,
        confidence: clampConfidence(h.confidence), // code clamps; never trust raw
        rationale: h.rationale,
      },
    }
  }

  // Model failed / rate-limited / offline → deterministic floor.
  return deterministicProbe(obstacle)
}

/**
 * SessionReviewAgent → classify one observation, then DISPOSE deterministically.
 *
 * The agent classifies (direction + magnitude + which insight + warm claim). The
 * confidence change and status transition are computed HERE with a bounded step.
 * On model failure we fall back to the existing rule-based resolveObservationAction.
 */
export async function runSessionReviewAgent(
  athleteId: string,
  workoutId: string,
  observationLabel: string,
  signalText: string,
  severity: number,
  existingInsights: InsightRow[],
): Promise<ObservationAction> {
  const review = await callSessionReview({
    observation: { label: observationLabel, signal: signalText, severity },
    insights: existingInsights.map((i) => ({
      id: i.id,
      category: i.category,
      claim: i.claim,
      confidence: i.confidence,
      status: i.status,
    })),
  })

  if (!review.ok) {
    // Deterministic fallback floor.
    return resolveObservationAction(
      athleteId,
      workoutId,
      observationLabel,
      signalText,
      severity,
      existingInsights,
    )
  }

  const c = review.data
  const evidenceEntry = {
    workout_id: workoutId,
    observation: observationLabel,
    signal: signalText,
    severity,
    direction: c.direction,
    magnitude: c.magnitude,
    rationale: c.rationale,
    logged_at: new Date().toISOString(),
  }

  // The agent named a target insight → update it with a bounded delta.
  const target = c.target_insight_id
    ? existingInsights.find(
        (i) => i.id === c.target_insight_id && i.status !== 'resolved' && i.status !== 'disproved',
      ) ?? null
    : null

  if (target) {
    const delta = boundedConfidenceDelta(c.direction, c.magnitude)
    const updatedConfidence = clampConfidence(target.confidence + delta)
    const updatedEvidence = [
      ...(Array.isArray(target.evidence) ? target.evidence : []),
      evidenceEntry,
    ]
    return {
      insightCategory: c.category,
      action: 'update',
      existingInsightId: target.id,
      updatedConfidence,
      updatedEvidence,
      // status only advances on rising confidence; disconfirming never advances.
      updatedStatus: delta > 0 ? advanceStatus(target.status, updatedConfidence) : null,
      newInsight: null,
    }
  }

  // No target → a new low-confidence hypothesis, claim in the agent's voice.
  return {
    insightCategory: c.category,
    action: 'create',
    existingInsightId: null,
    updatedConfidence: null,
    updatedEvidence: null,
    updatedStatus: null,
    newInsight: {
      athlete_id: athleteId,
      source_id: workoutId,
      claim: c.claim,
      category: c.category,
      priority: 'P3' as Priority,
      confidence: clampConfidence(0.2 + boundedConfidenceDelta(c.direction, c.magnitude)),
      status: 'hypothesis',
      evidence: [evidenceEntry],
      source: 'session_observation',
      program_impact: null,
    },
  }
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

// ============================================================================
// PROVISIONAL FIRST SESSION (Confidence-Driven Read)
// Built from the probe hypothesis — NO diagnostic, NO movement screen. The agent
// PROPOSES a session; the deterministic safety validator DISPOSES of load/volume;
// on model failure we fall back to generateInitialProgram (the floor). Then one
// info-gain "test me" item is tagged. Inserts mirror the legacy ComputeScreen.
// ============================================================================

export interface ProvisionalProfile {
  name: string | null
  trainingAge: number
  sessions: number
  obstacle: string | null
}

export interface ProvisionalBuildResult {
  insightCount: number
  p1Count: number
}

function programDesignToGenerated(
  design: ProgramDesignResult,
  startDateStr: string,
  p1: InsightRow | null,
): GeneratedProgram {
  const retestDate = addDays(startDateStr, 28)
  const weekEnd = addDays(startDateStr, 27)
  const routines = design.sessions.map((s, i) => ({
    name: s.name || `Session ${String.fromCharCode(65 + i)}`,
    session_type: 'strength',
    exercises: s.exercises.map((ex): ExerciseTemplate => ({
      name: ex.name,
      sets: ex.sets,
      reps: ex.reps,
      load: ex.load,
      cue: ex.cue,
      insight_id: p1?.id,
    })),
    intent: s.intent,
  }))
  return {
    goal: design.goal,
    retest_date: retestDate,
    phase: {
      name: 'Stability',
      week_start: startDateStr,
      week_end: weekEnd,
      non_negotiables: design.non_negotiables.length
        ? design.non_negotiables
        : ['Move well before you move heavy', 'Log how each session felt'],
      advancement_criteria: [
        'Pattern quality holds across all sets',
        'Zero pain signals for 3 consecutive sessions',
      ],
    },
    routines,
  }
}

// Tag ONE exercise (first routine) as the info-gain "test me" reading item.
// Non-fatal: model failure → no tag (the session still ships).
async function tagInfoGainItem(plan: GeneratedProgram, ranked: InsightRow[], p1: InsightRow | null) {
  if (!plan.routines.length || !plan.routines[0].exercises.length) return
  const res = await callInfoGain({
    goal: plan.goal,
    insights: ranked.map((i) => ({ category: i.category, confidence: i.confidence, status: i.status })),
    already_screened: [],
  })
  if (!res.ok) return
  const pattern = MOVEMENT_PATTERNS.find((p) => p.key === res.data.pattern_key)
  const label = pattern?.label ?? 'a key pattern'
  const ex = plan.routines[0].exercises[0]
  ex.reading = true
  ex.pattern_key = res.data.pattern_key
  ex.reading_why =
    `${res.data.rationale} Watching your ${label.toLowerCase()} here is the fastest way to ` +
    `sharpen the read${p1 ? ` on your ${p1.category.toLowerCase()}` : ''}.`
}

/**
 * Build the athlete's provisional first session from the probe hypothesis.
 * Idempotent (skips if an active program already exists). Always produces a
 * safe session: agent → safety validator → (on failure) deterministic floor.
 */
export async function buildProvisionalProgram(
  athleteId: string,
  profile: ProvisionalProfile,
  startDateStr: string,
): Promise<ProvisionalBuildResult> {
  // Ranked insights — the probe P1 hypothesis is already here from bootstrap.
  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const ranked = (insightRows ?? []) as InsightRow[]
  const p1 = ranked[0] ?? null
  const counts: ProvisionalBuildResult = {
    insightCount: ranked.length,
    p1Count: ranked.filter((i) => i.priority === 'P1').length,
  }

  // Idempotency: a reload mid-build must not double-write.
  const { data: existing } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (existing) return counts

  // Build the plan: agent proposes → safety disposes → deterministic floor.
  let plan: GeneratedProgram
  const designed = await callProgramDesign({
    profile: {
      name: profile.name,
      training_age: profile.trainingAge,
      sessions_per_week: profile.sessions,
      obstacle: profile.obstacle,
    },
    hypothesis: p1
      ? { claim: p1.claim, category: p1.category as InsightCategory, confidence: p1.confidence, rationale: '' }
      : null,
    insights: ranked.map((i) => ({ category: i.category, confidence: i.confidence, status: i.status, claim: i.claim })),
  })

  if (designed.ok) {
    try {
      const safe = validateProvisionalProgram(designed.data, { trainingAge: profile.trainingAge })
      plan = programDesignToGenerated(safe, startDateStr, p1)
    } catch {
      plan = generateInitialProgram(ranked, startDateStr)
    }
  } else {
    plan = generateInitialProgram(ranked, startDateStr)
  }

  // One info-gain "test me" item (non-fatal).
  await tagInfoGainItem(plan, ranked, p1)

  // Persist: program → phase → routines → profile.
  const { data: prog } = await supabase
    .from('program')
    .insert({ athlete_id: athleteId, goal: plan.goal, start_date: startDateStr, retest_date: plan.retest_date, status: 'active' })
    .select().single()
  if (!prog) return counts

  const { data: phase } = await supabase
    .from('phase')
    .insert({
      program_id: prog.id,
      name: plan.phase.name,
      week_start: plan.phase.week_start,
      week_end: plan.phase.week_end,
      non_negotiables: plan.phase.non_negotiables,
      advancement_criteria: plan.phase.advancement_criteria,
      status: 'active',
    })
    .select().single()

  const routineInserts = plan.routines.map((r) => ({
    program_id: prog.id,
    phase_id: phase?.id ?? null,
    name: r.name,
    session_type: r.session_type,
    exercises: r.exercises,
    intent: r.intent,
  }))
  await supabase.from('routine').insert(routineInserts)

  await supabase.from('athlete_profile').upsert({
    athlete_id: athleteId,
    current_phase: plan.phase.name,
    retest_date: plan.retest_date,
    last_updated: new Date().toISOString(),
  }, { onConflict: 'athlete_id' })

  return counts
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
// Ambient Work — life-integration movements tied to weak-link categories
// Lifted from Phil's Health life-integration menu. Every other app says "do
// these at the gym"; Zeroed meets the athlete in their life. Shown on the
// Zeroed In screen (Act 5), mapped to the P1/P2 insight categories.
// TODO Prompt 3: the ProgramDesignAgent personalises these per athlete.
// ============================================================================

export interface AmbientItem {
  label: string
  when: string
  priority: Priority   // inherited from the insight whose category placed it
}

const AMBIENT_WORK_BY_CATEGORY: Record<string, Array<{ label: string; when: string }>> = {
  'Lower Chain': [
    { label: 'Assisted deep squat hold', when: 'Grab a doorframe or pole — heels down, 30–60s' },
    { label: '90/90 floor sitting',       when: 'Meetings, TV, reading — swap the chair' },
    { label: 'Ankle mobility sequence',   when: 'Any wall, morning or pre-session' },
  ],
  'Upper Chain': [
    { label: 'Scapular wall hold',           when: 'Waiting for coffee, the elevator, anywhere' },
    { label: 'Doorframe pec stretch',        when: 'Every doorway you walk through' },
    { label: 'Chin tuck + thoracic extension', when: 'Over the back of your desk chair' },
  ],
  'Core': [
    { label: '90/90 floor sitting', when: 'Meetings, TV, reading — swap the chair' },
    { label: 'Single-arm carry',    when: 'Groceries, a bag — intentionally one-sided' },
    { label: 'Dead bug, slow',      when: 'Floor time at home — 5 reps a side' },
  ],
  'Posterior Chain': [
    { label: 'Assisted deep squat hold', when: 'Doorframe or pole — heels down, 30–60s' },
    { label: 'Standing hamstring float', when: 'Heel on a low step — soft knee, hinge in' },
    { label: 'Half-kneel hip flexor',    when: 'By the couch — 45s a side' },
  ],
  'Recovery': [
    { label: 'Box breathing',  when: '4 in · 4 hold · 6 out — a few rounds' },
    { label: 'Evening walk',   when: '10 minutes after dinner, no phone' },
  ],
}

const AMBIENT_FALLBACK = AMBIENT_WORK_BY_CATEGORY['Lower Chain']

/**
 * Picks 2–3 ambient items tied to the athlete's top weak links (P1/P2). Walks
 * insights in priority order, pulling each category's menu and stamping the
 * item with that insight's priority, deduped by label, capped at 3.
 */
export function getAmbientWork(insights: InsightRow[]): AmbientItem[] {
  const ranked = [...insights].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  )

  const items: AmbientItem[] = []
  const seen = new Set<string>()

  for (const insight of ranked) {
    if (items.length >= 3) break
    const menu = AMBIENT_WORK_BY_CATEGORY[insight.category] ?? AMBIENT_FALLBACK
    for (const entry of menu) {
      if (items.length >= 3) break
      if (seen.has(entry.label)) continue
      seen.add(entry.label)
      items.push({ ...entry, priority: insight.priority })
    }
  }

  // No insights at all — give a sane starting pair so the block never renders empty.
  if (items.length === 0) {
    return AMBIENT_FALLBACK.slice(0, 2).map((e) => ({ ...e, priority: 'P1' as Priority }))
  }

  return items
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
