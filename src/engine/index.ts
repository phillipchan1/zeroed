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
  SetLog,
  RoutineRow,
  PhaseRow,
  WeeklyDirective,
  WeeklyPrescription,
  WeeklyReviewAdjustments,
  CoachMessageInsert,
} from '../types/database'
import { MOVEMENT_PATTERNS } from '../types/database'
import { supabase } from '../lib/supabaseClient'
import {
  callProbe, callSessionReview, callSessionDebrief, callProgramDesign, callInfoGain, callTarget,
  callCoachChat,
  type ProgramDesignResult, type InsightCategory,
  type CoachContext, type CoachChatTurn, type CoachAction,
} from './agentClient'
import { FELT_CHIPS, type FeltLabel } from '../types/database'
import { validateProvisionalProgram } from './safety'
import {
  OBSTACLE_CATEGORY_HINTS, buildReadSkeleton, READ_FLOORS,
  type ReadAxis, type ArenaType,
} from './demandTables'

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

// Obstacle keyword hints are owned by the demand tables (Convergence §4c — one
// source, extended to also name a limiter). The probe fallback uses the
// category-only view; the read synthesis (Phase D) uses the richer prior.
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

// ────────────────────────────────────────────────────────────────────────────
// READ SYNTHESIS (Phase D) — the multi-axis first read.
//
// agent PROPOSES (claim language) → code DISPOSES (which axes, categories, P1/P2,
// confidence floors + clamps, aggregate). The structure comes from the demand
// tables (buildReadSkeleton, pure + deterministic); the agent only rewrites the
// claim sentences in a warmer voice. On model failure the table read stands
// alone — coherent, S&C-valid, confidence clamped. Never presented as certainty.
// ────────────────────────────────────────────────────────────────────────────

export interface ReadSynthesis {
  source: 'agent' | 'fallback'
  followupQuestion: string | null
  axes: ReadAxis[]
  aggregateConfidence: number
  // Back-compat single hypothesis (= the P1 axis) for existing consumers
  // (persist, Today anchor, Target). The stack lives in `axes`.
  hypothesis: { claim: string; category: string; confidence: number; rationale: string }
}

export interface ReadInput {
  arenaType: ArenaType
  arenaRaw: string | null
  limiterChoice: string | null
  obstacle: string
  trainingAge?: number | null
  arenaConfidence?: 'high' | 'low'
  followupAnswer?: string
}

function aggregate(axes: ReadAxis[]): number {
  const mean = axes.reduce((s, a) => s + a.confidence, 0) / Math.max(1, axes.length)
  return clampConfidence(Math.min(READ_FLOORS.aggregateCap, mean))
}

export async function synthesizeRead(input: ReadInput): Promise<ReadSynthesis> {
  // 1. CODE builds the structure — this alone is a valid read (the fallback floor).
  const skeleton = buildReadSkeleton({
    arenaType: input.arenaType,
    arenaRaw: input.arenaRaw,
    limiterChoice: input.limiterChoice,
    obstacle: input.obstacle,
    trainingAge: input.trainingAge ?? null,
    arenaConfidence: input.arenaConfidence ?? 'high',
  })
  const axes: ReadAxis[] = skeleton.axes.map((a) => ({ ...a }))
  const p1 = axes.find((a) => a.id === 'limiter_p1')!

  // 2. AGENT drafts language on top. Pass the code-built skeleton so a redeployed
  //    probe can fill every axis; the live probe just returns hypothesis (→ P1).
  const res = await callProbe({
    obstacle: input.obstacle,
    followup_answer: input.followupAnswer,
    arena: { type: input.arenaType, raw: input.arenaRaw },
    limiter: { choice: input.limiterChoice, label: p1.label, category: p1.category },
    axes: axes.map((a) => ({ axis_id: a.id, label: a.label, category: a.category })),
  })

  if (!res.ok) {
    return {
      source: 'fallback',
      followupQuestion: null,
      axes,
      aggregateConfidence: aggregate(axes),
      hypothesis: {
        claim: p1.claim,
        category: p1.category,
        confidence: p1.confidence,
        rationale: 'Inferred from your answers and the demand tables; unverified until you train.',
      },
    }
  }

  // Agent succeeded — override LANGUAGE only. Code keeps category + structure.
  // P1 gets the agent's hypothesis claim; its confidence is the agent's read,
  // floored at the table floor and CAPPED so the read never overstates itself.
  const h = res.data.hypothesis
  p1.claim = h.claim
  p1.confidence = clampConfidence(
    Math.min(READ_FLOORS.limiterP1Cap, Math.max(READ_FLOORS.limiterP1, h.confidence)),
  )

  // Any per-axis claims the (redeployed) probe drafted → map by id. Language only.
  for (const ac of res.data.axis_claims ?? []) {
    const ax = axes.find((a) => a.id === ac.axis_id && a.id !== 'limiter_p1')
    if (ax && ac.claim.trim()) ax.claim = ac.claim.trim()
  }

  return {
    source: 'agent',
    followupQuestion: res.data.followup_question,
    axes,
    aggregateConfidence: aggregate(axes),
    hypothesis: {
      claim: p1.claim,
      category: p1.category,
      confidence: p1.confidence,
      rationale: h.rationale,
    },
  }
}

/**
 * TargetAgent → a tailored "what are you chasing?" question + a concrete
 * suggested target, inferred from the obstacle and the working hypothesis. Asked
 * in orientation; the system should look like it already inferred the answer.
 * On model failure, a plain deterministic question with no pre-fill.
 */
export interface TargetPrompt {
  source: 'agent' | 'fallback'
  question: string
  suggested: string
}

export async function generateTargetPrompt(
  obstacle: string,
  hypothesis?: { claim: string; category: string } | null,
): Promise<TargetPrompt> {
  const res = await callTarget({ obstacle, hypothesis: hypothesis ?? null })
  if (res.ok) {
    return {
      source: 'agent',
      question: res.data.target_question,
      suggested: res.data.suggested_target ?? '',
    }
  }
  return {
    source: 'fallback',
    question: 'What are you chasing? A number, a lift, or a moment to be ready for.',
    suggested: '',
  }
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

// ────────────────────────────────────────────────────────────────────────────
// SESSION DEBRIEF — the throughput upgrade (agent classifies MANY, code disposes)
// Where runSessionReviewAgent took ONE tap, this mines the whole session's felt
// signal (prose reflection + per-exercise feel + a planted check-in answer) into
// every insight it bears on. Each classification gets the SAME bounded-delta
// treatment; deltas compound on a working snapshot so two signals on one insight
// don't both read stale confidence. On model failure we fall back to a
// deterministic read of the per-exercise feel chips.
// ────────────────────────────────────────────────────────────────────────────

export interface DebriefExerciseInput {
  name: string
  felt: FeltLabel | null
  note: string
  prescribed: string
  performed: string
}

export interface DebriefInput {
  reflection: string
  readiness: { sleep: number | null; energy: number | null; soreness: number | null } | null
  exercises: DebriefExerciseInput[]
  reading: { name: string; question: string; answer: string } | null
}

export interface DebriefOutcome {
  source: 'agent' | 'fallback'
  summary: string | null
  actions: ObservationAction[]
}

function magnitudeToSeverity(
  direction: 'confirming' | 'disconfirming' | 'neutral',
  magnitude: 'weak' | 'moderate' | 'strong',
): number {
  if (direction === 'neutral') return 1
  return magnitude === 'strong' ? 4 : magnitude === 'moderate' ? 3 : 2
}

// Collapse so the DB sees one write per insight: keep the last (compounded)
// update per insight id, and at most one create per category.
function collapseActions(actions: ObservationAction[]): ObservationAction[] {
  const updates = new Map<string, ObservationAction>()
  const createsByCat = new Map<string, ObservationAction>()
  for (const a of actions) {
    if (a.action === 'update' && a.existingInsightId) {
      updates.set(a.existingInsightId, a)            // last wins (compounded value)
    } else if (a.action === 'create' && a.newInsight) {
      if (!createsByCat.has(a.insightCategory)) createsByCat.set(a.insightCategory, a)
    }
  }
  return [...updates.values(), ...createsByCat.values()]
}

interface Classification {
  target_insight_id: string | null
  direction: 'confirming' | 'disconfirming' | 'neutral'
  magnitude: 'weak' | 'moderate' | 'strong'
  category: string
  claim: string
  rationale: string
  signal: string
}

// Turn N classifications into N bounded, collapsed ObservationActions. Deltas
// compound across classifications that touch the same insight.
function disposeClassifications(
  athleteId: string,
  workoutId: string,
  classifications: Classification[],
  existingInsights: InsightRow[],
): ObservationAction[] {
  const working = new Map<string, { confidence: number; status: InsightStatus; evidence: unknown[] }>()
  for (const i of existingInsights) {
    working.set(i.id, {
      confidence: i.confidence,
      status: i.status,
      evidence: Array.isArray(i.evidence) ? [...i.evidence] : [],
    })
  }

  const raw: ObservationAction[] = []
  for (const c of classifications) {
    const severity = magnitudeToSeverity(c.direction, c.magnitude)
    const evidenceEntry = {
      workout_id: workoutId,
      observation: c.signal,
      signal: c.signal,
      severity,
      direction: c.direction,
      magnitude: c.magnitude,
      rationale: c.rationale,
      logged_at: new Date().toISOString(),
    }

    const orig = c.target_insight_id ? existingInsights.find((i) => i.id === c.target_insight_id) ?? null : null
    const canUpdate = !!orig && orig.status !== 'resolved' && orig.status !== 'disproved'

    if (canUpdate && c.target_insight_id) {
      const w = working.get(c.target_insight_id)!
      const delta = boundedConfidenceDelta(c.direction, c.magnitude)
      const updatedConfidence = clampConfidence(w.confidence + delta)
      const updatedEvidence = [...w.evidence, evidenceEntry]
      const updatedStatus = delta > 0 ? advanceStatus(w.status, updatedConfidence) : null
      // Compound the working copy so the next classification on this insight
      // reads the already-moved confidence/status.
      w.confidence = updatedConfidence
      w.evidence = updatedEvidence
      if (updatedStatus) w.status = updatedStatus
      raw.push({
        insightCategory: c.category,
        action: 'update',
        existingInsightId: c.target_insight_id,
        updatedConfidence,
        updatedEvidence,
        updatedStatus,
        newInsight: null,
      })
    } else {
      raw.push({
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
      })
    }
  }
  return collapseActions(raw)
}

// Deterministic floor: read each per-exercise feel chip as one observation via
// the existing rule-based resolver. Prose is NOT parsed here (no model) — it's
// still persisted as an observation row by the caller.
const FELT_TO_OBSERVATION: Record<FeltLabel, string> = {
  Easy:  'Felt strong',
  Solid: 'Felt strong',
  Hard:  'Struggled with load',
  Off:   'Energy flag',
  Tweak: 'Pain signal',
  Pain:  'Pain signal',
}

function fallbackDebrief(
  athleteId: string,
  workoutId: string,
  input: DebriefInput,
  existingInsights: InsightRow[],
): ObservationAction[] {
  const raw: ObservationAction[] = []
  for (const ex of input.exercises) {
    if (!ex.felt) continue
    const label = FELT_TO_OBSERVATION[ex.felt]
    const severity = FELT_CHIPS.find((c) => c.label === ex.felt)?.severity ?? 2
    const signal = `${ex.name} — felt ${ex.felt}${ex.note ? ` — ${ex.note}` : ''}`
    raw.push(resolveObservationAction(athleteId, workoutId, label, signal, severity, existingInsights))
  }
  return collapseActions(raw)
}

/**
 * Review a whole logged session. Agent proposes many classifications; code
 * disposes each with a bounded delta. Returns collapsed actions for the caller
 * to execute, plus a warm one-line summary when the agent produced one.
 */
export async function runSessionDebriefAgent(
  athleteId: string,
  workoutId: string,
  input: DebriefInput,
  existingInsights: InsightRow[],
): Promise<DebriefOutcome> {
  const res = await callSessionDebrief({
    reflection: input.reflection,
    readiness: input.readiness,
    exercises: input.exercises.map((e) => ({
      name: e.name, felt: e.felt, note: e.note, prescribed: e.prescribed, performed: e.performed,
    })),
    reading: input.reading,
    insights: existingInsights.map((i) => ({
      id: i.id, category: i.category, claim: i.claim, confidence: i.confidence, status: i.status,
    })),
  })

  if (res.ok && res.data.observations.length > 0) {
    const classifications: Classification[] = res.data.observations.map((o) => ({
      target_insight_id: o.target_insight_id,
      direction: o.direction,
      magnitude: o.magnitude,
      category: o.category,
      claim: o.claim,
      rationale: o.rationale,
      signal: o.claim,
    }))
    return {
      source: 'agent',
      summary: res.data.session_summary?.trim() || null,
      actions: disposeClassifications(athleteId, workoutId, classifications, existingInsights),
    }
  }

  return {
    source: 'fallback',
    summary: null,
    actions: fallbackDebrief(athleteId, workoutId, input, existingInsights),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// COACH CHAT — the conversational layer (Agent #8). STRICTLY READ-ONLY.
//
// The athlete asks "why" (why this program, why this read, what's the limiter,
// what's the prognosis). The coach answers from a SCOPED slice of the athlete —
// never SELECT *. It writes NOTHING: it cannot move an insight, a confidence
// number, a status, or a load. When the athlete reports something new, it directs
// them to the session log (the only place a signal becomes evidence). On model
// failure it falls back to a grounded, in-voice canned reply so the surface never
// dead-ends.
// ────────────────────────────────────────────────────────────────────────────

// Compact one logged set: prefer the populated metric for its tracking type,
// append RPE when present. "225×5 @8" | "12 reps" | "45s @7" | "18m".
function formatSet(s: SetLog): string | null {
  let core: string | null = null
  if (s.weight != null && s.reps != null) core = `${s.weight}×${s.reps}`
  else if (s.reps != null)                core = `${s.reps} reps`
  else if (s.duration != null)            core = `${s.duration}s`
  else if (s.distance != null)            core = `${s.distance}m`
  if (core == null) return null
  return s.rpe != null ? `${core} @${s.rpe}` : core
}

// Turn a workout's per-exercise SetLog map into compact lines the coach can read
// and quote — one line per exercise, only sets that carry data.
function formatWorkoutSets(map: Record<string, SetLog[]> | null): string[] {
  if (!map) return []
  const lines: string[] = []
  for (const [exercise, sets] of Object.entries(map)) {
    if (!Array.isArray(sets)) continue
    const cells = sets.map(formatSet).filter((c): c is string => c != null)
    if (cells.length) lines.push(`${exercise}: ${cells.join(', ')}`)
  }
  return lines
}

/**
 * Assemble the scoped read the Coach is allowed to see. This is the doctrine's
 * "scoped read on demand": the active insight stack, the target, the current
 * program/phase, and the few most recent observations — not the whole profile.
 * Read once when the conversation opens; reused for every message in the thread.
 */
export async function gatherCoachContext(athleteId: string): Promise<CoachContext> {
  const [{ data: athlete }, { data: insightRows }, { data: prog }] = await Promise.all([
    supabase.from('athlete').select('name, goals, obstacle, training_age, sessions_per_week').eq('id', athleteId).maybeSingle(),
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
    supabase.from('program').select('id, goal').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
  ])

  const insights = ((insightRows ?? []) as InsightRow[])
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
    .map((i) => ({ id: i.id, priority: i.priority, category: i.category, claim: i.claim, confidence: i.confidence, status: i.status }))

  // Current phase (non-negotiables) for the active program, if any.
  let phase: { name: string | null; week: string | null; non_negotiables: string[] } | null = null
  if (prog?.id) {
    const { data: phaseRow } = await supabase
      .from('phase').select('name, week_start, week_end, non_negotiables, status')
      .eq('program_id', prog.id).eq('status', 'active').maybeSingle()
    if (phaseRow) {
      phase = {
        name: phaseRow.name ?? null,
        week: phaseRow.week_start && phaseRow.week_end ? `${phaseRow.week_start} → ${phaseRow.week_end}` : null,
        non_negotiables: Array.isArray(phaseRow.non_negotiables) ? phaseRow.non_negotiables : [],
      }
    }
  }

  // The prescribed week — the actual sessions + their exercises. This is what
  // lets the coach answer "what's my workout this week" concretely.
  let sessions: CoachContext['sessions'] = []
  if (prog?.id) {
    const { data: routineRows } = await supabase
      .from('routine').select('name, intent, exercises').eq('program_id', prog.id)
    if (Array.isArray(routineRows)) {
      sessions = (routineRows as Array<{ name: string; intent: string | null; exercises: ExerciseTemplate[] | null }>).map((r) => ({
        name: r.name,
        intent: r.intent ?? null,
        exercises: (Array.isArray(r.exercises) ? r.exercises : []).map(
          (ex) => `${ex.name} — ${ex.sets}×${ex.reps}${ex.load ? ` (${ex.load})` : ''}`,
        ),
      }))
    }
  }

  // The most recent session observations (append-only event log). Best-effort —
  // joins through workout→routine→program; an empty result is fine (early days).
  let recent_observations: CoachContext['recent_observations'] = []
  const { data: obs } = await supabase
    .from('session_observation')
    .select('signal, category, severity, logged_at, workout!inner(routine!inner(program!inner(athlete_id)))')
    .eq('workout.routine.program.athlete_id', athleteId)
    .order('logged_at', { ascending: false })
    .limit(5)
  if (Array.isArray(obs)) {
    recent_observations = obs.map((o) => ({
      signal: (o as { signal: string }).signal,
      category: (o as { category: string }).category,
      severity: (o as { severity: number }).severity,
      logged_at: (o as { logged_at: string }).logged_at,
    }))
  }

  // What the athlete has actually logged recently — the week's real activity,
  // down to the set ("Bench Press: 225×5 @7, 245×3 @8"). Per-set grain lives in
  // workout.actual_weights (Record<exerciseName, SetLog[]>).
  let recent_workouts: CoachContext['recent_workouts'] = []
  const { data: workouts } = await supabase
    .from('workout')
    .select('performed_at, rpe, actual_weights, routine!inner(name, program!inner(athlete_id))')
    .eq('routine.program.athlete_id', athleteId)
    .order('performed_at', { ascending: false })
    .limit(5)
  if (Array.isArray(workouts)) {
    recent_workouts = workouts.map((w) => ({
      session: (w as { routine?: { name?: string } }).routine?.name ?? 'Session',
      performed_at: (w as { performed_at: string }).performed_at,
      rpe: (w as { rpe: number | null }).rpe ?? null,
      sets: formatWorkoutSets((w as { actual_weights: Record<string, SetLog[]> | null }).actual_weights),
    }))
  }

  return {
    name: athlete?.name ?? null,
    target: athlete?.goals ?? null,
    obstacle: athlete?.obstacle ?? null,
    training_age: athlete?.training_age ?? null,
    sessions_per_week: athlete?.sessions_per_week ?? null,
    program: prog ? { goal: prog.goal ?? null, phase: phase?.name ?? null, week: phase?.week ?? null, non_negotiables: phase?.non_negotiables ?? [] } : null,
    sessions,
    insights,
    recent_observations,
    recent_workouts,
  }
}

/**
 * Deterministic starter prompts, grounded in the athlete's own context. Shown as
 * tappable suggestion bubbles BEFORE any message — instant, no model call, always
 * relevant to what the system actually believes about this athlete.
 */
export function coachStarterPrompts(ctx: CoachContext): string[] {
  // Short, tappable — these are chips, not sentences.
  const prompts: string[] = []
  const p1 = ctx.insights[0] ?? null
  if (p1) prompts.push(`Why my ${p1.category.toLowerCase()}?`)
  if (ctx.program?.goal) prompts.push('Why this program?')
  if (p1) prompts.push('What moves this read?')
  if (ctx.target) prompts.push("What's in my way?")
  prompts.push('What are you least sure of?')
  return prompts.slice(0, 3)
}

export interface CoachReply {
  source: 'agent' | 'fallback'
  reply: string
  followups: string[]
  // Proposed changes — NEVER applied here. Surfaced for the athlete to confirm in
  // CoachScreen, then disposed by applyCoachActions. Always [] on the fallback path.
  actions: CoachAction[]
}

/**
 * Ask the Coach a question. The agent proposes (prose + optional change actions);
 * the actions are not applied until the athlete confirms them. The call can fail,
 * so we fall back to a grounded, in-voice reply built from the scoped context
 * (and never any actions).
 */
export async function runCoachChat(
  context: CoachContext,
  history: CoachChatTurn[],
  question: string,
): Promise<CoachReply> {
  const res = await callCoachChat({ context, history, question })
  if (res.ok) {
    return {
      source: 'agent',
      reply: res.data.reply,
      followups: res.data.followups ?? [],
      actions: Array.isArray(res.data.actions) ? res.data.actions : [],
    }
  }

  // Deterministic floor — never dead-end the surface. Stay in voice, route
  // correctly, and lean on the real read in context. No actions on this path.
  const p1 = context.insights[0] ?? null
  const reply = p1
    ? `Can't reach my full read this second. The short version stands: your ${p1.category.toLowerCase()} is the working limiter — ${p1.claim} It's at ${Math.round(p1.confidence * 100)}% and sharpens every session you log.`
    : `Can't reach my full read this second. Log a session and I'll have something concrete to work from.`
  return { source: 'fallback', reply, followups: [], actions: [] }
}

// ---- Coach write actions (proposal-gated) ----------------------------------
// The coach can PROPOSE changes; these appliers DISPOSE them — but only after the
// athlete taps Apply. Every write is RLS-scoped to the athlete (the agent / OpenAI
// key is never involved). Each applier is defensive: bad refs fail soft with a
// readable error rather than throwing.

/** One-line human summary of a proposed/applied action, for the confirm card. */
export function describeCoachAction(a: CoachAction): string {
  switch (a.type) {
    case 'update_insight': {
      const bits: string[] = []
      if (a.set_status) bits.push(`status → ${a.set_status}`)
      if (a.set_confidence != null) bits.push(`confidence → ${Math.round(a.set_confidence * 100)}%`)
      if (a.set_priority) bits.push(`priority → ${a.set_priority}`)
      if (a.set_claim) bits.push(`claim → "${a.set_claim}"`)
      return `Update read — ${bits.join(', ') || 'no change'}`
    }
    case 'update_exercise': {
      const bits: string[] = []
      if (a.set_load) bits.push(`load → ${a.set_load}`)
      if (a.set_sets != null) bits.push(`sets → ${a.set_sets}`)
      if (a.set_reps) bits.push(`reps → ${a.set_reps}`)
      if (a.set_cue) bits.push(`cue → "${a.set_cue}"`)
      if (a.set_target_rpe != null) bits.push(`target → RPE ${a.set_target_rpe}`)
      return `${a.exercise_name ?? 'Exercise'} (${a.routine_name ?? 'routine'}) — ${bits.join(', ') || 'no change'}`
    }
    case 'add_note':
      return `Coach note — "${a.note ?? ''}"`
    default:
      return 'Change'
  }
}

export interface AppliedAction {
  ok: boolean
  label: string
  error?: string
}

/**
 * Apply a batch of coach-proposed actions. Called from CoachScreen ONLY after the
 * athlete confirms. Returns a per-action result so the UI can report what landed.
 */
export async function applyCoachActions(
  athleteId: string,
  actions: CoachAction[],
): Promise<AppliedAction[]> {
  const results: AppliedAction[] = []

  // Resolve the active program once (needed for exercise edits).
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()

  for (const a of actions) {
    const label = describeCoachAction(a)
    try {
      if (a.type === 'update_insight') {
        if (!a.insight_id) { results.push({ ok: false, label, error: 'no insight id' }); continue }
        const VALID_STATUS = ['hypothesis', 'likely', 'confirmed', 'resolved', 'disproved']
        const VALID_PRIORITY = ['P1', 'P2', 'P3', 'P4']
        const patch: Record<string, unknown> = {}
        if (a.set_confidence != null) patch.confidence = Math.max(0, Math.min(1, a.set_confidence))
        if (a.set_status && VALID_STATUS.includes(a.set_status)) patch.status = a.set_status
        if (a.set_priority && VALID_PRIORITY.includes(a.set_priority)) patch.priority = a.set_priority
        if (a.set_claim) patch.claim = a.set_claim
        if (Object.keys(patch).length === 0) { results.push({ ok: false, label, error: 'nothing to change' }); continue }
        const { error } = await supabase
          .from('insight').update(patch).eq('id', a.insight_id).eq('athlete_id', athleteId)
        results.push({ ok: !error, label, error: error?.message })

      } else if (a.type === 'update_exercise') {
        if (!prog?.id) { results.push({ ok: false, label, error: 'no active program' }); continue }
        if (!a.routine_name || !a.exercise_name) { results.push({ ok: false, label, error: 'missing routine/exercise' }); continue }
        const { data: routines } = await supabase
          .from('routine').select('id, exercises').eq('program_id', prog.id).ilike('name', `%${a.routine_name}%`).limit(1)
        const routine = routines?.[0] as { id: string; exercises: ExerciseTemplate[] | null } | undefined
        if (!routine) { results.push({ ok: false, label, error: `routine "${a.routine_name}" not found` }); continue }
        const exs = Array.isArray(routine.exercises) ? [...routine.exercises] : []
        const want = a.exercise_name.toLowerCase()
        const idx = exs.findIndex((e) => (e.name ?? '').toLowerCase().includes(want))
        if (idx < 0) { results.push({ ok: false, label, error: `exercise "${a.exercise_name}" not found` }); continue }
        const ex: ExerciseTemplate = { ...exs[idx] }
        if (a.set_load) ex.load = a.set_load
        if (a.set_sets != null) ex.sets = a.set_sets
        if (a.set_reps) ex.reps = a.set_reps
        if (a.set_cue) ex.cue = a.set_cue
        if (a.set_target_rpe != null) ex.target_rpe = Math.max(1, Math.min(10, a.set_target_rpe))
        exs[idx] = ex
        const { error } = await supabase.from('routine').update({ exercises: exs }).eq('id', routine.id)
        results.push({ ok: !error, label, error: error?.message })

      } else if (a.type === 'add_note') {
        if (!a.note) { results.push({ ok: false, label, error: 'empty note' }); continue }
        const { error } = await supabase
          .from('coach_message').insert({ athlete_id: athleteId, role: 'coach', kind: 'note', body: a.note })
        results.push({ ok: !error, label, error: error?.message })

      } else {
        results.push({ ok: false, label, error: 'unknown action type' })
      }
    } catch (e) {
      results.push({ ok: false, label, error: String(e) })
    }
  }

  return results
}

// ════════════════════════════════════════════════════════════════════════════
// THE OUTER CADENCES (deterministic — agent CLASSIFIES later, code DISPOSES now)
//
// Weekly review, phase advancement, retest. Each closes a nested loop in §1.
// These implement the S&C decision rules deterministically behind the same
// signatures the LLM agents will later fill. Triggers are lazy (on app open) —
// no cron. See runLoopTriggers() for the single entry point screens call.
// ════════════════════════════════════════════════════════════════════════════

// ---- shared week math (local time; Mon–Sun weeks) --------------------------

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfWeekMonday(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7)) // back up to Monday
  return r
}

function weekEndingISO(monday: Date): string {
  const sun = new Date(monday)
  sun.setDate(monday.getDate() + 6)
  return isoDate(sun)
}

// The max-weight (or, for unloaded work, the last) logged set in a set list.
function topWorkingSet(sets: SetLog[] | undefined): SetLog | null {
  if (!Array.isArray(sets) || sets.length === 0) return null
  const loaded = sets.filter((s) => s.weight != null)
  if (loaded.length) return loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  const logged = sets.filter((s) => s.done || s.reps != null || s.duration != null || s.distance != null)
  return logged.length ? logged[logged.length - 1] : null
}

interface WeekWorkout {
  performed_at: string
  rpe: number | null
  actual_weights: Record<string, SetLog[]> | null
}
interface WeekObservation {
  severity: number
  signal: string
  logged_at: string
}

interface WeeklyTally {
  planned: number
  done: number
  adherence: number
  avgRPE: number | null
  painCount: number
  positiveCount: number
  flagged_categories: string[]
}

const POSITIVE_SIGNAL = /\b(easy|solid|strong|pr)\b/i

function tallyWeek(planned: number, workouts: WeekWorkout[], observations: WeekObservation[]): WeeklyTally {
  const done = workouts.length
  const adherence = planned > 0 ? done / planned : 0

  const rpes: number[] = []
  for (const w of workouts) {
    const sets = w.actual_weights ? Object.values(w.actual_weights).flat() : []
    const setRpes = sets.map((s) => s.rpe).filter((r): r is number => r != null)
    if (setRpes.length) rpes.push(...setRpes)
    else if (w.rpe != null) rpes.push(w.rpe) // fall back to the session-level RPE
  }
  const avgRPE = rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10 : null

  const painObs = observations.filter((o) => o.severity >= 3)
  const positiveCount = observations.filter((o) => POSITIVE_SIGNAL.test(o.signal)).length
  const flagged_categories = [
    ...new Set(painObs.map((o) => o.signal.split('—')[0].trim()).filter(Boolean)),
  ].slice(0, 5)

  return { planned, done, adherence, avgRPE, painCount: painObs.length, positiveCount, flagged_categories }
}

// The §4.3 decision tree — the only place a directive is chosen.
function decidePrescription(t: WeeklyTally): WeeklyPrescription {
  if (t.painCount >= 2 || (t.avgRPE != null && t.avgRPE >= 8.5)) {
    return {
      directive: 'DELOAD',
      load_delta_pct: -10,
      rpe_target: 6,
      rationale: t.painCount >= 2
        ? `${t.painCount} pain flags this week — backing load off 10% to let the pattern settle.`
        : `Average RPE ${t.avgRPE} is into the red — backing off 10% to recover.`,
    }
  }
  if (t.adherence >= 0.8 && t.avgRPE != null && t.avgRPE <= 6.5 && t.painCount === 0) {
    return {
      directive: 'PROGRESS',
      load_delta_pct: 5,
      rpe_target: 7,
      rationale: `Adherence ${Math.round(t.adherence * 100)}% and RPE ${t.avgRPE} with no pain — adding 5%.`,
    }
  }
  if (t.adherence < 0.5) {
    return {
      directive: 'HOLD (missed)',
      load_delta_pct: 0,
      rpe_target: 7,
      rationale: `Only ${t.done}/${t.planned} sessions logged — holding load and resetting the week.`,
    }
  }
  return {
    directive: 'HOLD',
    load_delta_pct: 0,
    rpe_target: 7,
    rationale: 'Holding load — not enough signal to push or back off yet.',
  }
}

function weeklyCoachNotes(weekEnding: string, t: WeeklyTally, p: WeeklyPrescription): string {
  const rpeStr = t.avgRPE != null ? `avg RPE ${t.avgRPE}` : 'RPE not logged'
  const tally = `Week to ${weekEnding}: ${t.done}/${t.planned} sessions · ${rpeStr} · ${t.painCount} pain flag${t.painCount === 1 ? '' : 's'} · ${t.positiveCount} strong set${t.positiveCount === 1 ? '' : 's'}.`
  return `${tally} ${p.rationale}`
}

/**
 * WeeklyReviewAgent (deterministic, §4.2–4.3). Synthesizes every COMPLETED
 * Mon–Sun week that has ≥1 workout and no review yet into a weekly_review row +
 * a coach_message. Idempotent: one review per (program_id, week_ending).
 */
export async function runWeeklyReviewAgent(athleteId: string, programId: string): Promise<number> {
  const [{ data: ath }, { data: existingReviews }, { data: workoutRows }, { data: obsRows }] = await Promise.all([
    supabase.from('athlete').select('sessions_per_week').eq('id', athleteId).maybeSingle(),
    supabase.from('weekly_review').select('week_ending').eq('program_id', programId),
    supabase.from('workout').select('performed_at, rpe, actual_weights, routine!inner(program_id)').eq('routine.program_id', programId),
    supabase.from('session_observation').select('severity, signal, logged_at, workout!inner(routine!inner(program_id))').eq('workout.routine.program_id', programId),
  ])

  const planned = (ath?.sessions_per_week as number | null) ?? 3
  const reviewed = new Set((existingReviews ?? []).map((r) => r.week_ending as string))
  const workouts = (workoutRows ?? []) as unknown as WeekWorkout[]
  const observations = (obsRows ?? []) as unknown as WeekObservation[]
  if (workouts.length === 0) return 0

  const thisMonday = startOfWeekMonday(new Date())

  // Bucket workouts + observations by their week-ending Sunday.
  const weeks = new Map<string, { monday: Date; workouts: WeekWorkout[]; observations: WeekObservation[] }>()
  const bucketFor = (dateStr: string) => {
    const monday = startOfWeekMonday(new Date(dateStr))
    const key = weekEndingISO(monday)
    if (!weeks.has(key)) weeks.set(key, { monday, workouts: [], observations: [] })
    return weeks.get(key)!
  }
  for (const w of workouts) bucketFor(w.performed_at).workouts.push(w)
  for (const o of observations) bucketFor(o.logged_at).observations.push(o)

  // Process each completed week (its Monday strictly before this week's Monday)
  // that has ≥1 workout and no review yet — oldest first.
  const pending = [...weeks.entries()]
    .filter(([key, wk]) => wk.monday.getTime() < thisMonday.getTime() && wk.workouts.length > 0 && !reviewed.has(key))
    .sort((a, b) => a[1].monday.getTime() - b[1].monday.getTime())

  let created = 0
  for (const [weekEnding, wk] of pending) {
    const tally = tallyWeek(planned, wk.workouts, wk.observations)
    const prescription = decidePrescription(tally)
    const adjustments: WeeklyReviewAdjustments = {
      avgRPE: tally.avgRPE,
      adherence: Math.round(tally.adherence * 100) / 100,
      painCount: tally.painCount,
      positiveCount: tally.positiveCount,
      flagged_categories: tally.flagged_categories,
    }
    const coach_notes = weeklyCoachNotes(weekEnding, tally, prescription)

    const { data: review } = await supabase
      .from('weekly_review')
      .insert({ program_id: programId, week_ending: weekEnding, coach_notes, adjustments, next_week_prescription: prescription })
      .select()
      .single()

    if (review) {
      created++
      await insertCoachMessage(athleteId, { kind: 'weekly_review', body: coach_notes, ref_id: (review as { id: string }).id })
    }
  }
  return created
}

/**
 * PhaseAdvancementAgent gate (deterministic proxy, §5.2). Returns true only when
 * ALL hold: duration elapsed, ≥70% adherence over the phase, and no severity-≥3
 * observation in the last 3 logged sessions. Pure read — side effects (advance
 * or extend) live in runPhaseAdvancement so this signature matches the LLM swap.
 */
export async function checkPhaseAdvancement(athleteId: string, phaseId: string): Promise<boolean> {
  const { data: phaseRow } = await supabase
    .from('phase')
    .select('week_start, week_end, program_id, status')
    .eq('id', phaseId)
    .maybeSingle()
  if (!phaseRow) return false

  // 1. Duration — the phase's scheduled end has passed.
  const todayIso = isoDate(new Date())
  if (todayIso < (phaseRow.week_end as string)) return false

  // 2. Adherence — ≥70% of the planned sessions across the phase window.
  const { data: ath } = await supabase.from('athlete').select('sessions_per_week').eq('id', athleteId).maybeSingle()
  const perWeek = (ath?.sessions_per_week as number | null) ?? 3
  const start = new Date(phaseRow.week_start as string)
  const end = new Date(phaseRow.week_end as string)
  const weeks = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24) / 7) + 1)
  const planned = perWeek * weeks

  const { data: phaseWorkouts } = await supabase
    .from('workout')
    .select('performed_at, routine!inner(phase_id)')
    .eq('routine.phase_id', phaseId)
    .order('performed_at', { ascending: false })
  const done = (phaseWorkouts ?? []).length
  if (planned > 0 && done / planned < 0.7) return false

  // 3. Safety — no severity-≥3 observation in the last 3 logged sessions.
  const lastThree = (phaseWorkouts ?? []).slice(0, 3) as Array<{ performed_at: string }>
  if (lastThree.length) {
    const since = lastThree[lastThree.length - 1].performed_at
    const { data: recentObs } = await supabase
      .from('session_observation')
      .select('severity, workout!inner(routine!inner(phase_id))')
      .eq('workout.routine.phase_id', phaseId)
      .gte('logged_at', since)
    if ((recentObs ?? []).some((o) => (o as { severity: number }).severity >= 3)) return false
  }

  return true
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

// ────────────────────────────────────────────────────────────────────────────
// PHASE SCHEMES (§5.1) — same movement pool, different prescription.
// The exercise pool is fixed per category; the phase reassigns sets/reps/load
// intent so the SAME pattern is trained for stability, then strength, then
// power, then sport. Deterministic by design — the LLM ProgramDesignAgent will
// later personalise the pool; this just re-scores it per block.
// ────────────────────────────────────────────────────────────────────────────

interface PhaseScheme {
  sets: number
  reps: string                 // numeric-rep default; holds/carries keep their own
  rpeLabel: string             // athlete-facing intent
  intentVerb: string
  loadFloor: 'keep' | 'moderate'   // 'moderate' bumps non-bodyweight loads up
}

const PHASE_SCHEMES: Record<PhaseName, PhaseScheme> = {
  Stability: { sets: 3, reps: '8-12', rpeLabel: 'RPE 5–6 · control the pattern', intentVerb: 'Pattern quality', loadFloor: 'keep' },
  Strength:  { sets: 4, reps: '4-6',  rpeLabel: 'RPE 7–8 · moderate–heavy',       intentVerb: 'Build strength', loadFloor: 'moderate' },
  Power:     { sets: 4, reps: '2-3',  rpeLabel: 'RPE 7 · move it fast',           intentVerb: 'Express power',  loadFloor: 'moderate' },
  Sport:     { sets: 3, reps: '3-5',  rpeLabel: 'RPE 6–8 · sport-specific',       intentVerb: 'Integrate for sport', loadFloor: 'keep' },
}

// One jump/throw added to each Power session — the velocity intent the table
// calls for. Cycled so the three sessions aren't identical.
const POWER_EXPRESSIONS: ExerciseTemplate[] = [
  { name: 'Box Jump', sets: 4, reps: '3', load: 'bodyweight', cue: 'Land soft — reset every rep, max height' },
  { name: 'Med Ball Slam', sets: 4, reps: '3', load: 'moderate', cue: 'Full overhead — drive through the floor' },
  { name: 'Broad Jump', sets: 4, reps: '3', load: 'bodyweight', cue: 'Stick the landing — quality over distance' },
]

// Keep holds/carries/mobility on their native prescription; only re-rep true
// counted-rep lifts. Detects seconds, metres, breaths, and "each direction".
function isCountedReps(reps: string): boolean {
  return /^\d/.test(reps) && !/s\b|sec|m\b|min|breath|direction|hold/i.test(reps)
}

function applyScheme(ex: ExerciseTemplate, scheme: PhaseScheme): ExerciseTemplate {
  const next: ExerciseTemplate = { ...ex }
  if (isCountedReps(ex.reps)) {
    next.sets = scheme.sets
    next.reps = /each side/i.test(ex.reps) ? `${scheme.reps} each side` : scheme.reps
  }
  if (scheme.loadFloor === 'moderate' && ex.load && ex.load !== 'bodyweight' && ex.load === 'light') {
    next.load = 'moderate'
  }
  return next
}

const NON_NEGOTIABLES_BY_CATEGORY: Record<string, string[]> = {
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

// Phase length in days (week_end is inclusive of the last day → length - 1).
const PHASE_LENGTH_DAYS = 28

/**
 * Build one phase (any of Stability → Strength → Power → Sport) over the same
 * category pool, re-scored to the phase scheme. The single place that turns a
 * phase name + a weak-link category into a phase row + its routines, so phase
 * N+1 (§5) and the initial Stability block share one generator.
 */
export function generatePhase(
  phaseName: PhaseName,
  p1Category: string,
  startDateStr: string,
  opts?: { p1InsightId?: string | null },
): GeneratedProgram {
  const scheme = PHASE_SCHEMES[phaseName]
  const retestDate = addDays(startDateStr, PHASE_LENGTH_DAYS)
  const weekEnd = addDays(startDateStr, PHASE_LENGTH_DAYS - 1)
  const p1InsightId = opts?.p1InsightId ?? null

  const routineExercises = getRoutinesForCategory(p1Category)

  // ──────────────────────────────────────────────────────────────────────────
  // PROGRAM-DESIGN SEAM (TODO Prompt 3: ProgramDesignAgent)
  // Every exercise is attributed to the P1 insight; the real agent will map
  // individual exercises to P2/P3 insights. Stamping happens only here.
  // ──────────────────────────────────────────────────────────────────────────
  const stamp = (exs: ExerciseTemplate[]): ExerciseTemplate[] => {
    const scored = exs.map((ex) => applyScheme(ex, scheme))
    return p1InsightId ? scored.map((ex) => ({ ...ex, insight_id: p1InsightId })) : scored
  }

  const sessionExercises = (i: number): ExerciseTemplate[] => {
    const base = stamp(routineExercises[i])
    if (phaseName === 'Power') {
      const expr = { ...POWER_EXPRESSIONS[i % POWER_EXPRESSIONS.length] }
      if (p1InsightId) expr.insight_id = p1InsightId
      return [expr, ...base]   // express power fresh, before fatigue
    }
    return base
  }

  const routines = [
    { name: 'Session A', session_type: 'strength', exercises: sessionExercises(0), intent: `${scheme.intentVerb} — ${p1Category}. ${scheme.rpeLabel}.` },
    { name: 'Session B', session_type: 'strength', exercises: sessionExercises(1), intent: `${p1Category} variation. ${scheme.rpeLabel}.` },
    { name: 'Session C', session_type: 'strength', exercises: sessionExercises(2), intent: `Integration under fatigue. ${scheme.rpeLabel}.` },
  ]

  const goalByPhase: Record<PhaseName, string> = {
    Stability: `Address ${p1Category} weakness. Establish movement quality before loading.`,
    Strength:  `${p1Category} pattern owns load now — build the strength base.`,
    Power:     `Convert ${p1Category} strength into speed and expression.`,
    Sport:     `Integrate ${p1Category} into sport-specific, mixed-quality work.`,
  }

  const advancementByPhase: Record<PhaseName, string[]> = {
    Stability: [
      `Movement screen score ≥ 2 on ${p1Category} pattern`,
      'Zero pain signals in 3 consecutive sessions',
      'Strength baseline retest within 5% of initial',
    ],
    Strength: [
      'Top working sets progressing week over week',
      'RPE holding ≤ 8 at the prescribed load',
      'Zero pain signals in 3 consecutive sessions',
    ],
    Power: [
      'Velocity maintained across all working sets',
      'Landing mechanics clean on jumps/throws',
      'Zero pain signals in 3 consecutive sessions',
    ],
    Sport: [
      'Mixed qualities holding within a session',
      'Conditioning tolerated without breakdown',
      'Zero pain signals in 3 consecutive sessions',
    ],
  }

  return {
    goal: goalByPhase[phaseName],
    retest_date: retestDate,
    phase: {
      name: phaseName,
      week_start: startDateStr,
      week_end: weekEnd,
      non_negotiables: NON_NEGOTIABLES_BY_CATEGORY[p1Category] ?? NON_NEGOTIABLES_BY_CATEGORY['Lower Chain'],
      advancement_criteria: advancementByPhase[phaseName],
    },
    routines,
  }
}

/**
 * The initial Stability block. Thin wrapper over generatePhase so the LLM swap
 * is a body-only change later. Accepts the full ranked insight list so each
 * exercise is stamped with its insight_id (Shift 5 — the "why" surface).
 */
export function generateInitialProgram(
  insights: InsightRow[],
  startDateStr: string,
): GeneratedProgram {
  const p1Insight = insights[0] ?? null
  const p1Category = p1Insight?.category ?? 'Lower Chain'
  return generatePhase('Stability', p1Category, startDateStr, { p1InsightId: p1Insight?.id ?? null })
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

// Training age (years) at/above which the first session is allowed to feel like
// real training — mirrors the safety ceiling in safety.ts. Below this we keep the
// light pattern-quality build; moving load on an unwatched novice is the one
// thing we won't do.
const FIRST_SESSION_WORKING_AGE = 2

/**
 * Make the FIRST session read as training, not an assessment (the "half workout,
 * half diagnostic" ask). For an athlete with real history we promote the lead
 * loadable movement to genuine working sets — the workout half — while the
 * supporting work and the planted read stay as they are — the diagnostic half.
 * Novices are left on the light build. Bounded to 'moderate', so it never escapes
 * the safety ceiling the validator already enforces. Mutates the plan in place.
 */
function strengthenFirstSession(
  plan: GeneratedProgram,
  trainingAge: number,
  p1Category: string | null,
): void {
  if (trainingAge < FIRST_SESSION_WORKING_AGE) return
  const first = plan.routines[0]
  if (!first || !first.exercises.length) return

  // The lead loadable strength movement: first counted-rep, non-bodyweight lift.
  // Holds, carries, and mobility (bodyweight / time / distance) are left alone —
  // they're movement quality, not the working set.
  const idx = first.exercises.findIndex(
    (ex) => isCountedReps(ex.reps) && !!ex.load && ex.load !== 'bodyweight',
  )
  if (idx < 0) return

  const ex = first.exercises[idx]
  first.exercises[idx] = {
    ...ex,
    sets: 4,
    reps: /each side/i.test(ex.reps) ? '6-8 each side' : '6-8',
    load: 'moderate',
  }
  first.intent = p1Category
    ? `Your first working session — ${p1Category}. One primary lift at honest effort; the rest builds the pattern and reads the limiter.`
    : `Your first working session. One primary lift at honest effort; the rest builds the pattern and reads the limiter.`
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

  // Make it feel like a workout for experienced lifters (the "workout half").
  strengthenFirstSession(plan, profile.trainingAge, p1?.category ?? null)

  // One info-gain "test me" item — the "diagnostic half" (non-fatal).
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

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULING (§4.1) — derived, no schema. A Mon–Sun plan of sessions_per_week
// training days (routines assigned A,B,C,A…), the rest are rest. Pure function so
// it's testable and the same plan drives Today, the week strip, and Program.
// ════════════════════════════════════════════════════════════════════════════

export interface ScheduleDay {
  date: Date
  offset: number            // 0=Mon … 6=Sun
  logged: boolean
  isToday: boolean
}

export interface WeekSchedule {
  days: ScheduleDay[]
  todayRoutine: RoutineRow | null  // routine to train today, or null (rest / already trained / week done)
  planned: number
  done: number
  weekComplete: boolean
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * This week's plan (§4.1). The plan is `sessionsPerWeek` sessions across the
 * Mon–Sun week, routines assigned in order (A, B, C, A…). Today's routine is the
 * NEXT routine not yet done this week — unless a workout is already logged today
 * (no double-log) or the week's sessions are all done (→ null = rest). Count-based
 * (not weekday-pinned) so the athlete can train whenever they show up and the
 * first-ever session is always Session A.
 */
export function computeWeekSchedule(
  routines: RoutineRow[],
  weekWorkouts: Array<{ routine_id: string; performed_at: string }>,
  sessionsPerWeek: number,
  now: Date = new Date(),
): WeekSchedule {
  const ordered = [...routines].sort((a, b) => a.name.localeCompare(b.name))
  const planned = Math.max(1, sessionsPerWeek || 3)
  const monday = startOfWeekMonday(now)
  const todayOffset = (now.getDay() + 6) % 7

  const inThisWeek = weekWorkouts.filter((w) => {
    const d = new Date(w.performed_at)
    return d >= monday && d.getTime() < monday.getTime() + 7 * 24 * 60 * 60 * 1000
  })

  // Count distinct calendar days trained this week (no-double-log makes this the
  // session count); the next session is the done-th routine in order.
  const trainedDayKeys = new Set(inThisWeek.map((w) => isoDate(new Date(w.performed_at))))
  const done = trainedDayKeys.size
  const loggedToday = inThisWeek.some((w) => sameCalendarDay(new Date(w.performed_at), now))
  const weekComplete = done >= planned

  let todayRoutine: RoutineRow | null = null
  if (!loggedToday && !weekComplete && ordered.length) {
    todayRoutine = ordered[done % ordered.length]
  }

  const days: ScheduleDay[] = Array.from({ length: 7 }, (_, off) => {
    const date = new Date(monday)
    date.setDate(monday.getDate() + off)
    return {
      date,
      offset: off,
      logged: inThisWeek.some((w) => sameCalendarDay(new Date(w.performed_at), date)),
      isToday: off === todayOffset,
    }
  })

  return { days, todayRoutine, planned, done, weekComplete }
}

// ════════════════════════════════════════════════════════════════════════════
// APPLY THE PRESCRIPTION (§4.4) — last week's top working set + the week's
// directive, shown per exercise in the Workout screen. Deterministic v1
// prescribes a delta on the athlete's ACTUAL logged load, not the template.
// ════════════════════════════════════════════════════════════════════════════

export interface IntelligenceRule {
  name: string
  reasoning: string   // shown out loud — the felt difference vs a static program
}

export interface SessionPrescription {
  directive: WeeklyDirective | null
  loadDeltaPct: number
  rpeTarget: number | null
  rationale: string | null
  hints: Record<number, string>   // exercise index → one-line hint ('' = none)
  held: Record<number, boolean>   // exercise index → load cap held (rule fired)
  rule: IntelligenceRule | null   // standing rule in effect this session, or null
}

// Round a computed load to the nearest 5 units — a real, rackable number.
function roundLoad(w: number): number {
  return Math.max(0, Math.round(w / 5) * 5)
}

// Per-exercise RPE autoregulation. The weekly review sets a TARGET RPE; this
// turns how far THIS lift's last top set landed from that target into a per-lift
// load nudge — ~3% per RPE point (≈ one RIR ≈ ~3% of load near the top end),
// clamped. This is what makes "logged RPE 4 on an RPE-8 lift" recommend a heavier
// weight for THAT lift specifically, while a lift that hit RPE 9 backs off — even
// in the same week. Falls back to the program-wide weekly delta when this lift
// has no logged RPE. A DELOAD week is a hard recovery directive and is never
// overridden upward. maxUp caps progression by phase (Stability banks load).
function autoregulateDelta(
  lastRpe: number | null | undefined,
  rpeTarget: number | null,
  weeklyDelta: number,
  directive: WeeklyDirective | null,
  maxUp: number,
): number {
  if (directive === 'DELOAD') return weeklyDelta
  if (lastRpe != null) {
    const target = rpeTarget ?? 7
    const adj = Math.round((target - lastRpe) * 3)
    return Math.max(-10, Math.min(maxUp, adj))
  }
  return Math.max(-10, Math.min(maxUp, weeklyDelta))
}

function buildHint(top: SetLog | null, unit: string, directive: WeeklyDirective | null, delta: number, rpe: number | null): string {
  const rpeStr = rpe != null ? `RPE ${rpe}` : null
  if (top && top.weight != null) {
    const last = `${top.weight}${unit} last`
    if (delta !== 0) {
      // Concrete recommended weight, not just a percentage — the actionable number.
      const target = roundLoad(top.weight * (1 + delta / 100))
      const pct = `${delta > 0 ? '+' : ''}${delta}%`
      return `${last} → ${target}${unit} (${pct})${rpeStr ? `, aim ${rpeStr}` : ''}`
    }
    if (directive) return `${last} → repeat${rpeStr ? `, ${rpeStr}` : ''}`
    return last
  }
  if (top && top.reps != null) return `${top.reps} reps last${rpeStr ? `, aim ${rpeStr}` : ''}`
  if (top && top.duration != null) return `${top.duration}s last`
  // No prior set for this exercise — surface the directive intent only.
  if (directive === 'DELOAD') return `Ease in${rpeStr ? `, ${rpeStr}` : ''}`
  if (directive === 'PROGRESS') return `Find a working weight${rpeStr ? `, aim ${rpeStr}` : ''}`
  return ''
}

/**
 * Per-exercise prescription for a session: the active week's directive applied
 * to each exercise's last logged top set (index-aligned to THIS routine).
 *
 * Intelligence Rule — "Never load over instability": while the P1 weak link is
 * unresolved, the load cap is HELD on the lifts that address it, and the reason
 * is stated out loud. A static program can't say "not yet, and here's why."
 */
export async function gatherSessionPrescription(
  athleteId: string,
  routineId: string,
  exercises: ExerciseTemplate[],
  unit: string,
): Promise<SessionPrescription> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()

  // Phase caps how far a single easy lift may jump in one step: a Stability phase
  // "banks" load (the program's own rule — don't chase RPE up while stabilizing),
  // later phases let progression run.
  let phaseName: string | null = null
  if (prog?.id) {
    const { data: phaseRow } = await supabase
      .from('phase').select('name').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
    phaseName = (phaseRow as { name: string } | null)?.name ?? null
  }
  const maxUp = phaseName === 'Stability' ? 5 : 15

  let directive: WeeklyDirective | null = null
  let loadDeltaPct = 0
  let rpeTarget: number | null = null
  let rationale: string | null = null
  if (prog?.id) {
    const { data: review } = await supabase
      .from('weekly_review').select('next_week_prescription')
      .eq('program_id', prog.id).order('week_ending', { ascending: false }).limit(1).maybeSingle()
    const presc = (review?.next_week_prescription as WeeklyPrescription | null) ?? null
    if (presc) {
      directive = presc.directive
      loadDeltaPct = presc.load_delta_pct
      rpeTarget = presc.rpe_target
      rationale = presc.rationale
    }
  }

  // The P1 weak link — top-priority active insight. Drives the load-cap rule.
  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const p1 = ((insightRows ?? []) as InsightRow[])
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')[0] ?? null
  const p1Unresolved = !!p1
  const rule: IntelligenceRule | null = p1Unresolved
    ? {
        name: 'Never load over instability',
        reasoning:
          `Your ${p1!.category} is still the P1 limiter (${Math.round(p1!.confidence * 100)}% confident, ${p1!.status}). ` +
          `Load stays capped on the work that addresses it until the pattern clears — earn the load, don't force it.`,
      }
    : null

  const { data: lastWorkout } = await supabase
    .from('workout').select('actual_weights, performed_at')
    .eq('routine_id', routineId).order('performed_at', { ascending: false }).limit(1).maybeSingle()
  const lastWeights = (lastWorkout?.actual_weights as Record<string, SetLog[]> | null) ?? null

  const hints: Record<number, string> = {}
  const held: Record<number, boolean> = {}
  exercises.forEach((ex, i) => {
    const top = lastWeights ? topWorkingSet(lastWeights[String(i)]) : null
    // Held when the rule is in effect AND this lift addresses the P1 insight.
    const isHeld = p1Unresolved && !!ex.insight_id && ex.insight_id === p1!.id
    held[i] = isHeld
    if (isHeld && directive === 'PROGRESS') {
      // Suppress the +5%: state the hold and why, grounded in the last load.
      hints[i] = top && top.weight != null
        ? `Hold ${top.weight}${unit} — cap stays until ${p1!.category} clears`
        : `Hold steady — ${p1!.category} not cleared yet`
    } else {
      // Per-LIFT autoregulation against THIS exercise's own target RPE (falling
      // back to the week's target): each lift's last RPE vs its own target sets
      // its load step — capped by phase — instead of one program-wide delta.
      const exTarget = ex.target_rpe ?? rpeTarget
      const exDelta = autoregulateDelta(top?.rpe, exTarget, loadDeltaPct, directive, maxUp)
      hints[i] = buildHint(top, unit, directive, exDelta, exTarget)
    }
  })

  return { directive, loadDeltaPct, rpeTarget, rationale, hints, held, rule }
}

// ════════════════════════════════════════════════════════════════════════════
// THE LIVING LOOP — P1 resolution from session evidence (the differentiator)
//
// Stages 5–6 of the Diagnostic Loop made real on ONE weak link: a session's
// felt signal on the P1-linked work is read as evidence FOR or AGAINST the
// limiter. Strong, pain-free work DISCONFIRMS the limiter (a static program
// can't do this — improvement there would just mean "do more"). Confidence
// falls; at the floor the weak link RESOLVES, which lifts its load cap. The
// move is disposed deterministically here so it holds even with no LLM key;
// the agent path (runSessionDebriefAgent) layers nuance on top when available.
// ════════════════════════════════════════════════════════════════════════════

const P1_RESOLVE_THRESHOLD = 0.30   // limiter confidence at/below this → resolved
const P1_DISCONFIRM_STEP = 0.15     // bounded step per strong, pain-free session

export interface SessionAdaptation {
  note: string
  insightId: string
  category: string
  resolved: boolean
  previousConfidence: number
  newConfidence: number
}

/**
 * Read one logged session as evidence on the P1 weak link and adapt it. Returns
 * the grounded coach note (also persisted as a coach_message) when the session
 * moved the limiter, or null when there's nothing worth surfacing. Idempotent
 * per workout. Screens call this; they never compute the disposition themselves.
 */
export async function recordSessionAdaptation(athleteId: string, workoutId: string): Promise<SessionAdaptation | null> {
  const { data: workout } = await supabase
    .from('workout').select('routine_id, performed_at').eq('id', workoutId).maybeSingle()
  if (!workout) return null

  const { data: routine } = await supabase
    .from('routine').select('exercises').eq('id', workout.routine_id).maybeSingle()
  const exercises = (routine?.exercises as ExerciseTemplate[] | null) ?? []

  // P1 weak link — top-priority active insight.
  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const p1 = ((insightRows ?? []) as InsightRow[])
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')[0] ?? null
  if (!p1) return null

  // The lifts that address P1 (stamped at program build).
  const p1Names = new Set(exercises.filter((ex) => ex.insight_id === p1.id).map((ex) => ex.name))
  if (p1Names.size === 0) return null

  // Idempotency — one adaptation note per workout for this insight.
  const { data: existing } = await supabase
    .from('coach_message').select('id')
    .eq('athlete_id', athleteId).eq('kind', 'note').eq('ref_id', p1.id)
    .gte('created_at', workout.performed_at).limit(1)
  if (existing && existing.length) return null

  // Defer if another path (the LLM debrief) already moved P1 from this session —
  // its evidence entries carry workout_id. Prevents a double move per session.
  if (Array.isArray(p1.evidence) && p1.evidence.some((e) => (e as { workout_id?: string } | null)?.workout_id === workoutId)) {
    return null
  }

  // This session's felt signal on the P1-linked work (severity: ≤1 strong, ≥4 pain).
  const { data: obs } = await supabase
    .from('session_observation').select('signal, severity, category').eq('workout_id', workoutId)
  const felt = ((obs ?? []) as Array<{ signal: string; severity: number; category: string }>)
    .filter((o) => o.category === 'Felt')
  let strong = 0
  let pain = 0
  let exemplar: string | null = null
  for (const o of felt) {
    const name = o.signal.split('—')[0].trim()
    if (!p1Names.has(name)) continue
    if (o.severity >= 4) pain++
    else if (o.severity <= 1) { strong++; if (!exemplar) exemplar = name }
  }

  // The rule: strong, pain-free P1 work disconfirms the limiter. Anything else
  // (pain, or no strong signal) → no surfaced moment; the limiter stands.
  if (strong < 1 || pain > 0) return null

  const previousConfidence = p1.confidence
  const newConfidence = clampConfidence(previousConfidence - P1_DISCONFIRM_STEP)
  const resolved = newConfidence <= P1_RESOLVE_THRESHOLD

  const evidence = [
    ...(Array.isArray(p1.evidence) ? p1.evidence : []),
    {
      workout_id: workoutId,
      kind: 'p1_progress',
      direction: 'disconfirming',
      strong_sets: strong,
      logged_at: new Date().toISOString(),
    },
  ]
  const update: Record<string, unknown> = { confidence: newConfidence, evidence }
  if (resolved) {
    update.status = 'resolved'
    update.resolved_at = new Date().toISOString()
  }
  await supabase.from('insight').update(update).eq('id', p1.id)

  const prevPct = Math.round(previousConfidence * 100)
  const newPct = Math.round(newConfidence * 100)
  const where = exemplar ?? 'your P1 work'
  const sets = `${strong} strong set${strong === 1 ? '' : 's'}`
  const note = resolved
    ? `${p1.category} is clearing. ${sets} on ${where} with no pain dropped the limiter to ${newPct}% — I'm calling it resolved. The load cap on that pattern lifts now.`
    : `${p1.category} is resolving. ${sets} on ${where}, no pain — limiter confidence ${prevPct}%→${newPct}% because of what you just did. Keep this up and we clear it.`

  await insertCoachMessage(athleteId, { kind: 'note', body: note, ref_id: p1.id })
  return { note, insightId: p1.id, category: p1.category, resolved, previousConfidence, newConfidence }
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE ADVANCEMENT ORCHESTRATION (§5.2) — the side effects checkPhaseAdvancement
// stays out of (so its signature matches the LLM swap). Advances or extends.
// ════════════════════════════════════════════════════════════════════════════

const PHASE_SEQUENCE: PhaseName[] = ['Stability', 'Strength', 'Power', 'Sport']

async function insertCoachMessage(
  athleteId: string,
  msg: { kind: CoachMessageInsert['kind']; body: string; ref_id?: string | null; role?: CoachMessageInsert['role'] },
): Promise<void> {
  await supabase.from('coach_message').insert({
    athlete_id: athleteId,
    role: msg.role ?? 'coach',
    kind: msg.kind,
    body: msg.body,
    ref_id: msg.ref_id ?? null,
  })
}

async function insertPhaseAndRoutines(programId: string, plan: GeneratedProgram): Promise<string | null> {
  const { data: newPhase } = await supabase.from('phase').insert({
    program_id: programId,
    name: plan.phase.name,
    week_start: plan.phase.week_start,
    week_end: plan.phase.week_end,
    non_negotiables: plan.phase.non_negotiables,
    advancement_criteria: plan.phase.advancement_criteria,
    status: 'active',
  }).select().single()
  if (!newPhase) return null
  const phaseId = (newPhase as PhaseRow).id
  const routineInserts = plan.routines.map((r) => ({
    program_id: programId,
    phase_id: phaseId,
    name: r.name,
    session_type: r.session_type,
    exercises: r.exercises,
    intent: r.intent,
  }))
  await supabase.from('routine').insert(routineInserts)
  return phaseId
}

/**
 * Drive the phase cadence. When the gate clears, complete the current phase and
 * generate the next in sequence (+ routines, profile, coach_message). When the
 * duration elapsed but adherence/safety failed, extend a week and HOLD. Returns
 * true iff a phase advanced.
 */
export async function runPhaseAdvancement(athleteId: string): Promise<boolean> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return false

  const { data: phaseRow } = await supabase
    .from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
  if (!phaseRow) return false
  const phase = phaseRow as PhaseRow

  // Only act once the scheduled phase end has passed.
  if (isoDate(new Date()) < phase.week_end) return false

  const advance = await checkPhaseAdvancement(athleteId, phase.id)

  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const active = ((insightRows ?? []) as InsightRow[]).filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const p1 = active[0] ?? null
  const category = p1?.category ?? 'Lower Chain'

  if (!advance) {
    // Duration elapsed, gate failed → extend a week (week_end moves out, so this
    // won't re-fire until the new end passes). HOLD with a note.
    const newEnd = addDays(isoDate(new Date()), 7)
    await supabase.from('phase').update({ week_end: newEnd }).eq('id', phase.id)
    await insertCoachMessage(athleteId, {
      kind: 'phase_change',
      body: `Holding ${phase.name} another week — adherence or recovery wasn't there yet. Same plan, one more honest pass.`,
      ref_id: phase.id,
    })
    return false
  }

  const nextName = PHASE_SEQUENCE[PHASE_SEQUENCE.indexOf(phase.name) + 1] ?? null
  await supabase.from('phase').update({ status: 'completed' }).eq('id', phase.id)

  if (!nextName) {
    await insertCoachMessage(athleteId, {
      kind: 'phase_change',
      body: `You've cleared the full arc — Sport phase complete. A retest will re-scope what's next.`,
      ref_id: phase.id,
    })
    return true
  }

  const today = isoDate(new Date())
  const plan = generatePhase(nextName, category, today, { p1InsightId: p1?.id ?? null })
  const newPhaseId = await insertPhaseAndRoutines(prog.id, plan)
  await supabase.from('athlete_profile')
    .update({ current_phase: nextName, last_updated: new Date().toISOString() })
    .eq('athlete_id', athleteId)
  await insertCoachMessage(athleteId, {
    kind: 'phase_change',
    body: `Phase up: ${phase.name} → ${nextName}. ${plan.goal}`,
    ref_id: newPhaseId ?? phase.id,
  })
  return true
}

// ════════════════════════════════════════════════════════════════════════════
// RETEST / RE-DIAGNOSTIC (§6) — the program cadence. New diagnostic (v+1, delta
// vs baseline), insight resolution, new insights, re-scope, coach_message.
// ════════════════════════════════════════════════════════════════════════════

export function isRetestDue(retestDate: string | null): boolean {
  if (!retestDate) return false
  return isoDate(new Date()) >= retestDate
}

function patternKeyOf(ins: InsightRow): string | null {
  if (Array.isArray(ins.evidence)) {
    for (const e of ins.evidence) {
      const p = (e as { pattern?: string } | null)?.pattern
      if (p && MOVEMENT_PATTERNS.some((m) => m.key === p)) return p
    }
  }
  return null
}

function labelOfPattern(key: string): string {
  return MOVEMENT_PATTERNS.find((m) => m.key === key)?.label ?? key
}

export interface RetestSummary {
  version: number
  resolvedCount: number
  improved: Array<{ pattern: string; from: number; to: number }>
}

// Re-scope the program after a retest: clean → advance the phase; otherwise a
// fresh Stability block on the new P1 weakness. New retest_date either way.
async function rescopeAfterRetest(athleteId: string): Promise<void> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return

  const { data: phaseRow } = await supabase
    .from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
  const currentName = (phaseRow as PhaseRow | null)?.name ?? 'Stability'

  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const active = ((insightRows ?? []) as InsightRow[]).filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const p1 = active[0] ?? null

  const today = isoDate(new Date())
  let nextName: PhaseName = 'Stability'
  const category = p1?.category ?? 'Lower Chain'
  if (!p1) {
    // Moves clean — advance the arc instead of re-running Stability.
    nextName = PHASE_SEQUENCE[PHASE_SEQUENCE.indexOf(currentName) + 1] ?? 'Sport'
  }

  if (phaseRow) await supabase.from('phase').update({ status: 'completed' }).eq('id', (phaseRow as PhaseRow).id)

  const plan = generatePhase(nextName, category, today, { p1InsightId: p1?.id ?? null })
  await insertPhaseAndRoutines(prog.id, plan)

  const newRetest = addDays(today, 28)
  await supabase.from('program').update({ retest_date: newRetest }).eq('id', prog.id)
  await supabase.from('athlete_profile')
    .update({ current_phase: nextName, retest_date: newRetest, last_updated: new Date().toISOString() })
    .eq('athlete_id', athleteId)
}

/**
 * Run a retest. Writes the new diagnostic, resolves cleared weak links, mints
 * any new ones, re-scopes the program, and records a coach_message. All loop
 * logic lives here; the screen only collects the rescreen results.
 */
export async function runRetest(athleteId: string, newResults: DiagnosticResults): Promise<RetestSummary> {
  const { data: priorDiags } = await supabase
    .from('diagnostic').select('id, version, raw_results').eq('athlete_id', athleteId).order('version', { ascending: true })
  const diags = (priorDiags ?? []) as Array<{ id: string; version: number; raw_results: DiagnosticResults | null }>
  const baseline = diags[0] ?? null
  const newVersion = diags.reduce((m, d) => Math.max(m, d.version), 0) + 1

  // Delta vs baseline (per movement pattern).
  const baseMove = baseline?.raw_results?.movement ?? {}
  const delta: Record<string, number> = {}
  const improved: Array<{ pattern: string; from: number; to: number }> = []
  for (const p of MOVEMENT_PATTERNS) {
    const from = baseMove[p.key]
    const to = newResults.movement[p.key]
    if (from != null && to != null) {
      delta[p.key] = to - from
      if (to > from) improved.push({ pattern: p.key, from, to })
    }
  }

  const { data: newDiag } = await supabase.from('diagnostic').insert({
    athlete_id: athleteId,
    raw_results: newResults,
    delta_from_prior: delta,
    version: newVersion,
    test_battery: { mode: 'retest' },
  }).select().single()
  const newDiagId = (newDiag as { id: string } | null)?.id ?? null

  // Resolve insights whose pattern improved to ≥ 2.
  const { data: insightRows } = await supabase.from('insight').select('*').eq('athlete_id', athleteId)
  const insights = (insightRows ?? []) as InsightRow[]
  let resolvedCount = 0
  const nowIso = new Date().toISOString()
  for (const ins of insights) {
    if (ins.status === 'resolved' || ins.status === 'disproved') continue
    const key = patternKeyOf(ins)
    if (key && (newResults.movement[key] ?? 0) >= 2) {
      await supabase.from('insight').update({ status: 'resolved', resolved_at: nowIso }).eq('id', ins.id)
      resolvedCount++
    }
  }

  // Mint new insights from the retest for categories not already tracked.
  if (newDiagId) {
    const generated = generateInsightsFromDiagnostic(athleteId, newDiagId, newResults)
    const stillActive = new Set(
      insights.filter((i) => i.status !== 'resolved' && i.status !== 'disproved' && !(patternKeyOf(i) && (newResults.movement[patternKeyOf(i)!] ?? 0) >= 2)).map((i) => i.category),
    )
    const toInsert = generated.filter((g) => !stillActive.has(g.category))
    if (toInsert.length) await supabase.from('insight').insert(toInsert)
  }

  await rescopeAfterRetest(athleteId)

  const deltaSummary = improved.length
    ? improved.map((i) => `${labelOfPattern(i.pattern)} ${i.from}→${i.to}`).join(', ')
    : 'no pattern gains yet'
  await insertCoachMessage(athleteId, {
    kind: 'retest',
    body: `Retest v${newVersion}: ${deltaSummary}. ${resolvedCount > 0 ? `Cleared ${resolvedCount} weak link${resolvedCount === 1 ? '' : 's'}.` : 'Holding the line — block re-scoped.'}`,
    ref_id: newDiagId,
  })

  return { version: newVersion, resolvedCount, improved }
}

// ════════════════════════════════════════════════════════════════════════════
// LAZY TRIGGERS (§4.2, §5, §9) — the single entry point screens call on open.
// No cron; everything fires on app open and is idempotent.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run the weekly + phase cadences for the athlete's active program. Safe to call
 * on every TodayScreen mount: weekly review is idempotent per week, phase
 * advancement only acts past a phase end. Errors are swallowed (best-effort).
 * Returns true iff something actually changed (so callers refresh only then —
 * an unconditional refresh would remount the screen and loop).
 */
export async function runLoopTriggers(athleteId: string): Promise<boolean> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return false
  let changed = false
  try { changed = (await runWeeklyReviewAgent(athleteId, prog.id)) > 0 || changed } catch (e) { console.error('[loop] weekly review failed', e) }
  try { changed = (await runPhaseAdvancement(athleteId)) || changed } catch (e) { console.error('[loop] phase advancement failed', e) }
  return changed
}
