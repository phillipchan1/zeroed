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
  PhaseStatus,
  ExerciseTemplate,
  SetLog,
  RoutineRow,
  PhaseRow,
  WeeklyDirective,
  WeeklyPrescription,
  WeeklyReviewAdjustments,
  WeeklyReviewRow,
  CoachMessageInsert,
  SessionObservationInsert,
} from '../types/database'
import { MOVEMENT_PATTERNS } from '../types/database'
import { supabase } from '../lib/supabaseClient'
import { orderByPlannedDay } from '../lib/weekOrder'
import {
  callProbe, callSessionReview, callSessionDebrief, callProgramDesign, callPhaseDesign, callInfoGain, callTarget,
  callCoachChat, callWeeklyDebrief,
  type ProgramDesignResult, type PhaseDesignResult, type InsightCategory,
  type CoachContext, type CoachChatTurn, type CoachAction, type RetestFindings,
} from './agentClient'
import { FELT_CHIPS, isClearanceTest, type FeltLabel, type ClearanceTest } from '../types/database'
import { unitContext, type UnitContext } from '../lib/units'
import {
  estimate1RM, estimateIsReliable, displayPRs, foldBest, NO_BEST,
  type LiftBest, type PrKind,
} from './prs'
import {
  buildBaseline, namedLifts, strengthDeltas, strengthStalls,
  type BaselineLift, type StrengthDelta,
} from './strengthBaseline'
import { readBalance, type BalanceRead } from './balance'
import { isSetLogged, tallySession, sumVolume, NO_VOLUME, type VolumeTally } from './volume'
import { validateProvisionalProgram } from './safety'
import {
  OBSTACLE_CATEGORY_HINTS, buildReadSkeleton, READ_FLOORS,
  type ReadAxis, type ArenaType,
} from './demandTables'
// The deterministic prescription rules live in their own pure module so they can
// be exercised without a database — see prescription.check.ts.
import {
  SEVERITY_STRONG, SEVERITY_PAIN, strongTopSet,
  rpeContract, PHASE_RPE, tallyWeek, decidePrescription,
  recommendedLoad, autoregulateDelta, maxUpFor,
  projectExerciseLoad, allowsAutoProgress,
  P1_RESOLVE_THRESHOLD, P1_DISCONFIRM_STEP, advanceStatus,
  addressesLimiter, capIsActive, isLiftHeld,
  CLEARANCE_TOP_SETS, CLEARANCE_SESSIONS,
  clearanceTestOf, pickClearanceLift, describeClearanceTest, newClearanceTest, judgeClearanceSession,
  type WeeklyTally, type WeekWorkout, type WeekObservation, type LiftAttempt,
} from './prescription'
import { planPagerFutureWeeks, weekWindowInZone } from './weekDates'
// Per-lift loads for the main lifts — working max, training max, push / hold /
// drop, modifiers, the all-time-best ceiling and the reason line — are decided
// in liftModel.ts. This file only reads the rows it needs.
import {
  canonicalLiftId, modelFromSources, dayOfModifiers, exerciseCall, readModelLog, localDay,
  fmtLoad, addDays as addDaysIso, mondayOf, readTmOverride, convertTmOverride, tmOverrideEntry,
  type DayOf, type LiftModelSources, type MainLiftId, type ModelWorkout, type Recommendation,
} from './liftModel'
export {
  canonicalLiftId, backoffLoad, liftIncrement, type DayOf, type MainLiftId,
} from './liftModel'
export {
  ATHLETE_TIME_ZONE, weekWindowInZone, upcomingWeekWindow, isSundayInZone,
  logTimestampForWeek, isoInWeek, isoDateInZone, planPagerFutureWeeks, addDaysISO,
} from './weekDates'
export {
  sessionStateForWeek, weekLoggedDays, weekAdherence, workoutsInWeek,
  activeBlockRetestDate, type WeekSessionState, type WeekWorkoutLike,
} from './weekStatus'

// Logged sets are index-keyed against the session's exercise list as it was AT
// LOG TIME. Every read of actual_weights goes through here so an edit to the
// live routine can never reattribute work the athlete already did.
import { readLoggedExercises, resolveLoggedExercises, type LoggedWorkoutLike } from './loggedSets'

// The week-diff primitives live in weekDiff.ts so the phase designer and the
// conversational program editor describe a change in exactly the same terms.
export {
  type ExerciseChange, type SessionDiff,
  normalizeExerciseName, describePrescription, diffSession, tallyChanges,
} from './weekDiff'

// The conversational program editor (screens/loop/ProgramEditScreen) — surgical,
// multi-turn edits to the live week. Re-exported so screens keep importing the
// engine and never the agent client.
export * from './programEdit'

// The append-only record of every reprogramming event: the athlete's journey on
// one side, and the memory phase design reads back on the other.
export * from './programHistory'
import { gatherProgramHistory } from './programHistory'

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
      // Status tracks confidence in BOTH directions — rising evidence promotes,
      // and confidence falling to the resolve threshold retires the read.
      updatedStatus: advanceStatus(target.status, updatedConfidence),
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
  pushed?: boolean   // athlete deliberately went over the cap on this lift
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
      // Both directions — see advanceStatus. A session's worth of disconfirming
      // evidence must be able to finish a limiter off, not just erode it.
      const updatedStatus = advanceStatus(w.status, updatedConfidence)
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
function formatWorkoutSets(w: LoggedWorkoutLike): string[] {
  const lines: string[] = []
  for (const { name, exercise, sets } of readLoggedExercises(w)) {
    const cells = sets.map(formatSet).filter((c): c is string => c != null)
    // A stand-in says what it stood in for, so the coach doesn't read a missing
    // T-bar row as a skipped one.
    const swapped = exercise?.swapped_from ? ` (swapped in for ${exercise.swapped_from})` : ''
    if (cells.length) lines.push(`${name}${swapped}: ${cells.join(', ')}`)
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
  // workout.actual_weights, keyed by index into the session's exercise list, so
  // the snapshot has to come along or the coach reads back movement names that
  // drifted when the program was edited.
  let recent_workouts: CoachContext['recent_workouts'] = []
  const { data: workouts } = await supabase
    .from('workout')
    .select('performed_at, rpe, actual_weights, exercises_snapshot, routine!inner(name, exercises, program!inner(athlete_id))')
    .eq('routine.program.athlete_id', athleteId)
    .order('performed_at', { ascending: false })
    .limit(5)
  if (Array.isArray(workouts)) {
    recent_workouts = (workouts as unknown as LoggedWorkoutLike[]).map((w) => ({
      session: (w as { routine?: { name?: string } }).routine?.name ?? 'Session',
      performed_at: (w as unknown as { performed_at: string }).performed_at,
      rpe: (w as unknown as { rpe: number | null }).rpe ?? null,
      sets: formatWorkoutSets(w),
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
  opts?: { midWorkout?: boolean },
): Promise<CoachReply> {
  const res = await callCoachChat({ context, history, question, mid_workout: opts?.midWorkout })
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
  // A stale deployment is named outright: "can't reach" on a healthy connection
  // would read as the chat being broken, when the fix is a one-line redeploy.
  const p1 = context.insights[0] ?? null
  const cause =
    res.error === 'stale_function'
      ? 'The server is running an older coach — deploy the latest agent Edge Function (`supabase functions deploy agent`) to bring the chat back.'
      : res.error === 'rate_limited'
        ? `Rate-limited for a minute — try that again shortly.`
        : `Can't reach my full read right now.`
  const reply = p1
    ? `${cause} Short version: **${p1.category}** is the limiter — ${p1.claim} (${Math.round(p1.confidence * 100)}% sure).`
    : `${cause} Log a session and I'll have something concrete to work from.`
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

// Deterministic fallback note — always available, used offline and whenever the
// weekly_debrief model call fails. The warm model message wraps the SAME tally
// and directive; this is the floor, never wrong.
function weeklyCoachNotes(weekEnding: string, t: WeeklyTally, p: WeeklyPrescription): string {
  const rpeStr = t.avgRPE != null ? `avg RPE ${t.avgRPE}` : 'RPE not logged'
  // Hard / strong come from the old effort chips, which sessions no longer
  // offer — named when a week has them, silent otherwise, never "0 strong sets".
  const hardStr = t.hardCount ? ` · ${t.hardCount} hard set${t.hardCount === 1 ? '' : 's'}` : ''
  const strongStr = t.positiveCount ? ` · ${t.positiveCount} strong set${t.positiveCount === 1 ? '' : 's'}` : ''
  const tally = `Week to ${weekEnding}: ${t.done}/${t.planned} sessions · ${rpeStr} · ${t.painCount} pain flag${t.painCount === 1 ? '' : 's'}${hardStr}${strongStr}.`
  return `${tally} ${p.rationale}`
}

// The coach's end-of-week message. The engine has already crunched the tally and
// chosen the directive (decidePrescription) — the model only DRAFTS warm
// language around that fixed decision, and never on a fully-empty week (nothing
// to narrate). Any failure falls back to the deterministic note: the app always
// produces a message, online or off.
async function generateWeeklyCoachMessage(
  weekEnding: string,
  t: WeeklyTally,
  p: WeeklyPrescription,
  ctx: { name: string | null; target: string | null; injury: boolean; missed: boolean },
): Promise<string> {
  const fallback = weeklyCoachNotes(weekEnding, t, p)
  // Empty missed week — the templated reset reads cleaner than model filler. An
  // injury declaration is the exception: it still gets the warm, reassuring note
  // even with nothing logged.
  if (t.done === 0 && !ctx.injury) return fallback
  try {
    const res = await callWeeklyDebrief({
      name: ctx.name,
      target: ctx.target,
      week_ending: weekEnding,
      planned: t.planned,
      done: t.done,
      adherence: Math.round(t.adherence * 100),
      avg_rpe: t.avgRPE,
      pain_count: t.painCount,
      positive_count: t.positiveCount,
      flagged_categories: t.flagged_categories,
      directive: p.directive,
      load_delta_pct: p.load_delta_pct,
      rpe_target: p.rpe_target,
      rationale: p.rationale,
      injury: ctx.injury,
      missed: ctx.missed,
    })
    if (res.ok && res.data.message.trim()) return res.data.message.trim()
  } catch {
    /* fall through to the deterministic note */
  }
  return fallback
}

// Persist one week: crunch → decide → draft message → write the review row and
// its coach_message. The single place a weekly_review is minted, so the auto
// rollover and the manual close-out can never drift. Returns the new review id.
async function persistWeeklyReview(
  athleteId: string,
  programId: string,
  weekEnding: string,
  planned: number,
  workouts: WeekWorkout[],
  observations: WeekObservation[],
  ctx: { name: string | null; target: string | null; injury?: boolean; phaseName?: string | null },
): Promise<string | null> {
  const tally = tallyWeek(planned, workouts, observations, {
    start: addDays(weekEnding, -6),
    end: weekEnding,
  })
  const injury = ctx.injury === true
  const prescription = decidePrescription(tally, { injury, phaseName: ctx.phaseName })
  const adjustments: WeeklyReviewAdjustments = {
    avgRPE: tally.avgRPE,
    adherence: Math.round(tally.adherence * 100) / 100,
    painCount: tally.painCount,
    positiveCount: tally.positiveCount,
    flagged_categories: tally.flagged_categories,
  }
  const coach_notes = await generateWeeklyCoachMessage(weekEnding, tally, prescription, {
    name: ctx.name,
    target: ctx.target,
    injury,
    missed: !injury && tally.done === 0,
  })

  const { data: review } = await supabase
    .from('weekly_review')
    .insert({ program_id: programId, week_ending: weekEnding, coach_notes, adjustments, next_week_prescription: prescription })
    .select()
    .single()
  if (!review) return null
  const reviewId = (review as { id: string }).id
  await insertCoachMessage(athleteId, { kind: 'weekly_review', body: coach_notes, ref_id: reviewId })
  return reviewId
}

// The athlete's name + what they're chasing — passed to the coach-message model
// so the weekly note is specific, not generic. Also carries the ACTIVE PHASE
// NAME, because the directive tree cannot judge "was this week too hard?"
// without knowing how hard the block was supposed to be. Falls back gracefully
// when unset (rpeContract() then uses the legacy 6.5/8.5 thresholds).
async function fetchReviewContext(
  athleteId: string,
  programId: string,
): Promise<{ name: string | null; target: string | null; phaseName: string | null }> {
  const [{ data: ath }, { data: phaseRow }] = await Promise.all([
    supabase.from('athlete').select('name, goals, obstacle').eq('id', athleteId).maybeSingle(),
    supabase.from('phase').select('name').eq('program_id', programId).eq('status', 'active').maybeSingle(),
  ])
  const a = ath as { name: string | null; goals: string | null; obstacle: string | null } | null
  return {
    name: a?.name ?? null,
    target: (a?.goals || a?.obstacle) ?? null,
    phaseName: (phaseRow as { name: string } | null)?.name ?? null,
  }
}

// At most this many completed weeks are back-filled in a single rollover run, so
// an athlete returning after a long absence gets a bounded set of recent reset
// notes rather than dozens of empty rows.
const MAX_WEEKLY_BACKFILL = 16

/**
 * WeeklyReviewAgent (deterministic, §4.2–4.3). Synthesizes every COMPLETED
 * Mon–Sun week from the athlete's first logged session up to last week into a
 * weekly_review row + a coach_message — INCLUDING weeks with no logged work,
 * which become a no-penalty reset so a missed week is acknowledged, never
 * silently dropped. Idempotent: one review per (program_id, week_ending).
 */
export async function runWeeklyReviewAgent(athleteId: string, programId: string): Promise<number> {
  const [{ data: ath }, { data: existingReviews }, { data: workoutRows }, { data: obsRows }, reviewCtx] = await Promise.all([
    supabase.from('athlete').select('sessions_per_week').eq('id', athleteId).maybeSingle(),
    supabase.from('weekly_review').select('week_ending').eq('program_id', programId),
    supabase.from('workout').select('performed_at, rpe, actual_weights, routine!inner(program_id)').eq('routine.program_id', programId),
    supabase.from('session_observation').select('severity, signal, logged_at, workout!inner(routine!inner(program_id))').eq('workout.routine.program_id', programId),
    fetchReviewContext(athleteId, programId),
  ])

  const planned = (ath?.sessions_per_week as number | null) ?? 3
  const reviewed = new Set((existingReviews ?? []).map((r) => r.week_ending as string))
  const workouts = (workoutRows ?? []) as unknown as WeekWorkout[]
  const observations = (obsRows ?? []) as unknown as WeekObservation[]
  if (workouts.length === 0) return 0 // no activity yet — nothing to review or back-fill

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

  // Walk every completed week from the first activity to last week — filling the
  // gaps (weeks with no logged work) so a skipped week is reviewed, not dropped.
  const firstMonday = [...weeks.values()].reduce((min, wk) => (wk.monday < min ? wk.monday : min), thisMonday)
  const allMondays: Date[] = []
  for (let m = new Date(firstMonday); m.getTime() < thisMonday.getTime(); m.setDate(m.getDate() + 7)) {
    allMondays.push(new Date(m))
  }

  // Oldest-first, but cap the back-fill to the most recent N completed weeks.
  const pending = allMondays
    .map((monday) => ({ monday, key: weekEndingISO(monday) }))
    .filter(({ key }) => !reviewed.has(key))
    .slice(-MAX_WEEKLY_BACKFILL)

  let created = 0
  for (const { monday, key } of pending) {
    const wk = weeks.get(key) ?? { monday, workouts: [], observations: [] }
    const id = await persistWeeklyReview(athleteId, programId, key, planned, wk.workouts, wk.observations, reviewCtx)
    if (id) created++
  }
  return created
}

export interface CloseWeekResult {
  reviewId: string
  alreadyClosed: boolean
}

/**
 * Manual "I'm done with the week" — close out the CURRENT, still-in-progress week
 * on demand instead of waiting for the Sunday→Monday rollover. Crunches this
 * week's logged work, decides next week's directive, and writes the review +
 * coach message now. Two extra behaviours over the auto rollover:
 *   • it reviews THIS week (the auto agent only ever touches completed weeks);
 *   • opts.injury forces a RECOVERY back-off — the athlete-declared "I'm hurt /
 *     taking time off" path the engine never infers on its own.
 * First it runs the normal rollover so any earlier missed weeks are filled too.
 * Idempotent: re-closing a week that already has a review returns the existing
 * one (alreadyClosed: true) rather than minting a duplicate.
 */
export async function closeOutCurrentWeek(
  athleteId: string,
  opts: { injury?: boolean } = {},
): Promise<CloseWeekResult | null> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return null
  const programId = prog.id as string

  // Fill any earlier completed/missed weeks first, so the manual close never
  // jumps ahead of an un-reviewed gap.
  try { await runWeeklyReviewAgent(athleteId, programId) } catch (e) { console.error('[close-week] rollover failed', e) }

  const thisMonday = startOfWeekMonday(new Date())
  const weekEnding = weekEndingISO(thisMonday)

  // Already closed this week? Return it — re-closing must never duplicate.
  const { data: existing } = await supabase
    .from('weekly_review').select('id').eq('program_id', programId).eq('week_ending', weekEnding).maybeSingle()
  if (existing) return { reviewId: (existing as { id: string }).id, alreadyClosed: true }

  const [{ data: ath }, { data: workoutRows }, { data: obsRows }, reviewCtx] = await Promise.all([
    supabase.from('athlete').select('sessions_per_week').eq('id', athleteId).maybeSingle(),
    supabase.from('workout').select('performed_at, rpe, actual_weights, routine!inner(program_id)').eq('routine.program_id', programId).gte('performed_at', thisMonday.toISOString()),
    supabase.from('session_observation').select('severity, signal, logged_at, workout!inner(routine!inner(program_id))').eq('workout.routine.program_id', programId).gte('logged_at', thisMonday.toISOString()),
    fetchReviewContext(athleteId, programId),
  ])
  const planned = (ath?.sessions_per_week as number | null) ?? 3
  const workouts = (workoutRows ?? []) as unknown as WeekWorkout[]
  const observations = (obsRows ?? []) as unknown as WeekObservation[]

  const reviewId = await persistWeeklyReview(
    athleteId, programId, weekEnding, planned, workouts, observations,
    { ...reviewCtx, injury: opts.injury === true },
  )
  return reviewId ? { reviewId, alreadyClosed: false } : null
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

  // 3. Safety — no PAIN observation in the last 3 logged sessions. Pain only:
  // a "Hard" chip is the block working, not a reason to stall the athlete at a
  // phase boundary they have otherwise earned.
  const lastThree = (phaseWorkouts ?? []).slice(0, 3) as Array<{ performed_at: string }>
  if (lastThree.length) {
    const since = lastThree[lastThree.length - 1].performed_at
    const { data: recentObs } = await supabase
      .from('session_observation')
      .select('severity, workout!inner(routine!inner(phase_id))')
      .eq('workout.routine.phase_id', phaseId)
      .gte('logged_at', since)
    if ((recentObs ?? []).some((o) => (o as { severity: number }).severity >= SEVERITY_PAIN)) return false
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

// NOTE: rpeLabel is prose for the athlete; PHASE_RPE (above) is the same
// contract as numbers for the engine. They describe ONE intent — if you change
// a band here, change it there. Keeping them apart is what let the app ask for
// RPE 7–8 while quietly scoring anything above 6.5 as a failure.
const PHASE_SCHEMES: Record<PhaseName, PhaseScheme> = {
  Stability: { sets: 3, reps: '8-12', rpeLabel: 'RPE 5–6 · control the pattern', intentVerb: 'Pattern quality', loadFloor: 'keep' },
  Strength:  { sets: 4, reps: '4-6',  rpeLabel: 'RPE 7–8 · moderate–heavy',       intentVerb: 'Build strength', loadFloor: 'moderate' },
  Power:     { sets: 4, reps: '2-3',  rpeLabel: 'RPE 7 · move it fast',           intentVerb: 'Express power',  loadFloor: 'moderate' },
  Sport:     { sets: 3, reps: '3-5',  rpeLabel: 'RPE 6–8 · sport-specific',       intentVerb: 'Integrate for sport', loadFloor: 'keep' },
}

// Keep holds/carries/mobility on their native prescription; only re-rep true
// counted-rep lifts. Detects seconds, metres, breaths, and "each direction".
function isCountedReps(reps: string): boolean {
  return /^\d/.test(reps) && !/s\b|sec|m\b|min|breath|direction|hold/i.test(reps)
}

function applyScheme(ex: ExerciseTemplate, scheme: PhaseScheme, phaseName: PhaseName): ExerciseTemplate {
  const next: ExerciseTemplate = { ...ex }
  if (isCountedReps(ex.reps)) {
    next.sets = scheme.sets
    next.reps = /each side/i.test(ex.reps) ? `${scheme.reps} each side` : scheme.reps
    // Carry the block's RPE target onto the lift itself. Without this the
    // per-lift autoregulator falls back to the week-wide number and every block
    // silently autoregulates toward the same effort, whatever it claims to be.
    // Holds/carries/mobility are left alone — RPE means nothing on a plank.
    if (ex.target_rpe == null) next.target_rpe = PHASE_RPE[phaseName].target
  }
  if (scheme.loadFloor === 'moderate' && ex.load && ex.load !== 'bodyweight' && ex.load === 'light') {
    next.load = 'moderate'
  }
  return next
}

// One jump/throw added to each Power session — the velocity intent the table
// calls for. Cycled so the three sessions aren't identical.
const POWER_EXPRESSIONS: ExerciseTemplate[] = [
  { name: 'Box Jump', sets: 4, reps: '3', load: 'bodyweight', cue: 'Land soft — reset every rep, max height' },
  { name: 'Med Ball Slam', sets: 4, reps: '3', load: 'moderate', cue: 'Full overhead — drive through the floor' },
  { name: 'Broad Jump', sets: 4, reps: '3', load: 'bodyweight', cue: 'Stick the landing — quality over distance' },
]

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
  // Exercises are attributed to the P1 insight ONLY where they actually train
  // that chain. This stamp is not decoration: it is what the load cap and the
  // "why is this lift here" sheet both read. Stamping the whole session meant a
  // shoulder read capped the athlete's squat and told them the squat was there
  // to fix their shoulder — both wrong, from one lazy attribution.
  // ──────────────────────────────────────────────────────────────────────────
  const stampOne = (ex: ExerciseTemplate): ExerciseTemplate => {
    const scored = applyScheme(ex, scheme, phaseName)
    return p1InsightId && addressesLimiter(scored.name, p1Category) === true
      ? { ...scored, insight_id: p1InsightId }
      : scored
  }

  const sessionExercises = (i: number): ExerciseTemplate[] => {
    const base = routineExercises[i].map(stampOne)
    if (phaseName === 'Power') {
      const expr = stampOne({ ...POWER_EXPRESSIONS[i % POWER_EXPRESSIONS.length] })
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
 * Mon–Sun week. Routines run in the same order as the Train list: a pinned day,
 * else the day the name leads with, else the name — so "Fri…" does not open the
 * week ahead of Monday. Today's routine is the NEXT routine in that order not
 * yet done this week — unless a workout is already logged today (no double-log)
 * or the week's sessions are all done (→ null = rest). Count-based, so the
 * athlete can train whenever they show up.
 */
export function computeWeekSchedule(
  routines: RoutineRow[],
  weekWorkouts: Array<{ routine_id: string; performed_at: string }>,
  sessionsPerWeek: number,
  now: Date = new Date(),
): WeekSchedule {
  const ordered = orderByPlannedDay(routines, (r) => r.intended_dow ?? null)
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
  // exercise index → the concrete recommended working load (athlete's unit) —
  // the number the hint narrates, on its own so previews can show "50lb" instead
  // of "moderate". Null when the lift has no weighted history to recommend from.
  // Absent on cached copies written before this field existed — read with `?.`.
  targets: Record<number, number | null>
  // What a HELD lift would have been prescribed with no limiter in the way — the
  // number "Push it" aims at. Null on lifts that aren't held (their target is
  // already the honest one). Absent on caches written before this field existed.
  pushTargets?: Record<number, number | null>
  rule: IntelligenceRule | null   // standing rule in effect this session, or null
  /**
   * The active block, so the session can prescribe REST the way it prescribes
   * load — a Strength main lift needs three minutes, a band pull-apart does not.
   * Absent on cached copies written before this field existed — read with `?.`.
   */
  phaseName?: string | null
  // The open exit condition on the limiter — what would actually clear the cap,
  // and how far along it is. Null when no cap is in effect. Absent on cached
  // copies written before this field existed — read with `?.`.
  clearance?: ClearanceView | null
  /**
   * The exercise each index was prescribed FOR. A swap mid-session changes what
   * slot 3 is; the hint written for the T-bar row is not a hint for the dumbbell
   * row that replaced it, and the screen checks this before showing one. Absent
   * on caches written before this field existed — read with `?.`.
   */
  exerciseNames?: string[]
  /**
   * The lift model's reason line and its why-lines, per exercise index — the
   * "245 = 65% of TM 377 (from 365x1 @8, Oct 6)" a main lift's number carries.
   * Accessories carry their call and any day-of modifier. Absent on caches
   * written before this field existed — read with `?.`.
   */
  reasons?: Record<number, string[]>
  /** A movement today's check-in says to skip (a jump on a sore knee). */
  skip?: Record<number, boolean>
}

/** The clearance test, flattened for display. */
export interface ClearanceView {
  lift: string
  requirement: string       // "2 top sets at RPE 8+ on Bench Press, pain-free, across 2 sessions."
  sessionsPassed: number
  sessionsNeeded: number
  minRpe: number
  /** Index into this routine's exercises, or -1 when the lift isn't in it today. */
  exerciseIndex: number
}

function buildHint(top: SetLog | null, u: UnitContext, directive: WeeklyDirective | null, delta: number, rpe: number | null, target: number | null): string {
  const rpeStr = rpe != null ? `RPE ${rpe}` : null
  if (top && top.weight != null) {
    const last = `${u.fmt(top.weight)}${u.unit} last`
    if (delta !== 0 && target != null) {
      // Concrete recommended weight, not just a percentage — the actionable number.
      const pct = `${delta > 0 ? '+' : ''}${delta}%`
      return `${last} → ${target}${u.unit} (${pct})${rpeStr ? `, aim ${rpeStr}` : ''}`
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
 * Everything the lift model reads for one athlete: the whole log across every
 * program (the all-time best has to see all of it), recent pain chips, and any
 * hand-set training maxes. Weights come back in the athlete's DISPLAY unit, so
 * the model rounds to plates they actually have.
 *
 * Each read degrades on its own. A database missing the check-in or TM columns
 * (the migration ships by hand, behind the web deploy) still yields the log.
 */
export async function gatherLiftSources(athleteId: string, u: UnitContext): Promise<LiftModelSources | null> {
  const { data: progs } = await supabase.from('program').select('id').eq('athlete_id', athleteId)
  const ids = ((progs ?? []) as Array<{ id: string }>).map((p) => p.id)
  if (!ids.length) return null
  const base = 'id, performed_at, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)'
  const withCheckin = `${base}, knee_pain_l, knee_pain_r, sleep_hours, readiness, bodyweight`
  // Keyset pages on performed_at rather than .range(): the Worker's /api/data
  // facade speaks filters and limits, not offsets. A page boundary inside one
  // timestamp re-reads that timestamp; ids dedupe it.
  const PAGE = 1000
  const page = (cols: string, after: string | null) => {
    let q = supabase.from('workout').select(cols).in('routine.program_id', ids)
    if (after) q = q.gte('performed_at', after)
    return q.order('performed_at', { ascending: true }).limit(PAGE)
  }
  const byId = new Map<string, ModelWorkout>()
  let cols = withCheckin
  let after: string | null = null
  for (let n = 0; n < 10; n++) {
    let res = await page(cols, after)
    if (res.error && cols === withCheckin) { cols = base; res = await page(cols, after) }
    if (res.error) throw res.error
    const rows = (res.data ?? []) as unknown as ModelWorkout[]
    const before = byId.size
    for (const w of rows) byId.set(w.id ?? `${w.performed_at}:${byId.size}`, w)
    if (rows.length < PAGE || byId.size === before) break
    after = rows[rows.length - 1].performed_at
  }
  const workouts = [...byId.values()]
  const weekStart = mondayOf(localDay(new Date().toISOString()))
  const recentIds = workouts
    .filter((w) => localDay(w.performed_at) >= addDaysIso(weekStart, -14))
    .map((w) => w.id).filter((id): id is string => !!id)
  const [{ data: ath }, { data: obs }] = await Promise.all([
    supabase.from('athlete').select('training_max_overrides').eq('id', athleteId).maybeSingle(),
    recentIds.length
      ? supabase.from('session_observation').select('signal, severity, logged_at').in('workout_id', recentIds).gte('severity', 4)
      : Promise.resolve({ data: [] }),
  ])
  const stored = ((ath as { training_max_overrides?: Record<string, unknown> | null } | null)?.training_max_overrides) ?? null
  const overrides = stored
    ? Object.fromEntries(Object.entries(stored).flatMap(([k, v]) => {
      const o = readTmOverride(v)
      return o ? [[k, convertTmOverride(o, u.show)]] : []
    }))
    : null
  return {
    workouts,
    observations: (obs ?? []) as Array<{ signal: string; severity: number; logged_at: string }>,
    overrides,
    unit: u.unit,
    convert: (w) => u.show(w),
  }
}

/**
 * What the Training maxes card reads: the whole lift log plus the live week, so
 * a preview shows the number the athlete will actually be handed — the
 * program's reps, the block's RPE, the week's RECOVERY if there is one.
 */
export async function gatherTrainingMaxSources(athleteId: string, u: UnitContext): Promise<LiftModelSources | null> {
  const liftSrc = await gatherLiftSources(athleteId, u)
  if (!liftSrc) return null
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return liftSrc
  const [{ data: phase }, { data: review }] = await Promise.all([
    supabase.from('phase').select('id, name').eq('program_id', prog.id).eq('status', 'active').maybeSingle(),
    supabase.from('weekly_review').select('week_ending, next_week_prescription')
      .eq('program_id', prog.id).order('week_ending', { ascending: false }).limit(1).maybeSingle(),
  ])
  type RoutineRow = { name: string; intent: string | null; exercises: ExerciseTemplate[] | null; intended_dow: number | null }
  const cols = 'name, intent, exercises, intended_dow'
  const phaseRow = phase as { id: string; name: string } | null
  let routines = phaseRow
    ? ((await supabase.from('routine').select(cols).eq('phase_id', phaseRow.id)).data ?? []) as RoutineRow[]
    : []
  if (!routines.length) routines = ((await supabase.from('routine').select(cols).eq('program_id', prog.id)).data ?? []) as RoutineRow[]
  const rv = review as { week_ending: string; next_week_prescription: { directive?: string } | null } | null
  const weekStart = mondayOf(localDay(new Date().toISOString()))
  return {
    ...liftSrc,
    sessions: routines
      .sort((a, b) => (a.intended_dow ?? 7) - (b.intended_dow ?? 7) || a.name.localeCompare(b.name))
      .map((r) => ({ name: r.name, intent: r.intent, exercises: r.exercises ?? [] })),
    phaseName: phaseRow?.name ?? null,
    directive: rv && rv.week_ending === addDaysIso(weekStart, -1) ? rv.next_week_prescription?.directive ?? null : null,
  }
}

/**
 * Write (or clear, with null) one lift's hand-set TM from the app. `value` is in
 * the display unit; the entry lands in the storage unit, stamped now, with the
 * model's own TM beside it so a later read can tell when it has gone stale.
 */
export async function saveTrainingMaxOverride(
  athleteId: string, lift: MainLiftId, value: number | null, src: LiftModelSources, u: UnitContext,
): Promise<void> {
  const { data, error } = await supabase.from('athlete').select('training_max_overrides').eq('id', athleteId).maybeSingle()
  if (error) throw error
  const next: Record<string, unknown> = {
    ...(((data as { training_max_overrides?: Record<string, unknown> | null } | null)?.training_max_overrides) ?? {}),
  }
  const entry = tmOverrideEntry(lift, value, src)
  if (entry) next[lift] = convertTmOverride(entry, u.store)
  else delete next[lift]
  const { error: upErr } = await supabase.from('athlete').update({ training_max_overrides: next }).eq('id', athleteId)
  if (upErr) throw upErr
}

const CALL_LABEL: Record<Recommendation['call'], string> = {
  push: 'Push', hold: 'Hold', drop: 'Drop', repeat: 'Repeat', miss: 'Missed',
  deload: 'Deload', program_pct: 'Program', establish: 'Re-establish',
}

/** The chip on a main lift: the call and the number, e.g. "Push · 340lb × 5 @8". */
function liftHint(rec: Recommendation, unit: string): string {
  if (rec.skip) return 'Skip today'
  const capped = rec.capped ? ' · capped' : ''
  return `${CALL_LABEL[rec.call]} · ${fmtLoad(rec.load)}${unit} × ${rec.reps} @${fmtLoad(rec.targetRpe)}${capped}`
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
  u: UnitContext,
  // Today's check-in. Sleep, readiness and the knees move today's loads.
  opts: { dayOf?: DayOf | null } = {},
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
  const maxUp = maxUpFor(phaseName)

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
  //
  // The cap is gated on CONFIDENCE, not merely on the row still existing. It used
  // to fire for any insight that wasn't explicitly resolved, which meant a read
  // the system had already argued itself out of — 12% confident, still technically
  // "a hypothesis" — capped load exactly as hard as one it was sure about. A
  // belief that weak has no business holding a barbell down.
  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const p1 = ((insightRows ?? []) as InsightRow[])
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')[0] ?? null
  const capActive = capIsActive(p1)
  const rule: IntelligenceRule | null = capActive
    ? {
        name: 'Never load over instability',
        reasoning:
          `Your ${p1!.category} is still the P1 limiter (${Math.round(p1!.confidence * 100)}% confident, ${p1!.status}). ` +
          `Load stays capped on the work that addresses it until the pattern clears — earn the load, don't force it.`,
      }
    : null

  const [{ data: lastWorkout }, { data: routineMeta }] = await Promise.all([
    supabase
      .from('workout').select('actual_weights, performed_at, exercises_snapshot')
      .eq('routine_id', routineId).order('performed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('routine').select('name, intent').eq('id', routineId).maybeSingle(),
  ])
  const routineName = (routineMeta as { name?: string } | null)?.name ?? null
  const routineIntent = (routineMeta as { intent?: string | null } | null)?.intent ?? null
  const lastWeights = (lastWorkout?.actual_weights as Record<string, SetLog[]> | null) ?? null
  // What each of those indices actually WAS. Last session's slot 3 is this
  // session's slot 3 only if the same movement was done in it — a dumbbell row
  // swapped in for the T-bar is not where the T-bar's next load comes from (and
  // a T-bar's numbers are no base for today's stand-in either).
  const lastSnapshot = (lastWorkout?.exercises_snapshot as ExerciseTemplate[] | null) ?? null
  const sameSlot = (i: number, name: string) =>
    !lastSnapshot?.length || lastSnapshot[i]?.name === name
  // Cross-phase fallback base: a just-(re)designed routine has no own history, but
  // its lifts (same names) do elsewhere in the program — read off that.
  const byName = prog?.id ? await gatherExerciseBases(prog.id) : new Map<string, SetLog>()

  const hints: Record<number, string> = {}
  const held: Record<number, boolean> = {}
  const targets: Record<number, number | null> = {}
  const pushTargets: Record<number, number | null> = {}
  const reasons: Record<number, string[]> = {}
  const skip: Record<number, boolean> = {}
  // The block's own RPE target is the floor for per-lift autoregulation. Without
  // it a Strength lift with no stamped target autoregulates against the weekly
  // number (7) and gets marked down for the RPE 8 the block asked for.
  const phaseTarget = rpeContract(phaseName).target
  const dayOf = opts.dayOf ?? null

  // The whole log, read once. Best-effort: without it every lift falls back to
  // the per-session path below, exactly as before the lift model existed.
  const liftSrc = await gatherLiftSources(athleteId, u).catch(() => null)
  const today = localDay(new Date().toISOString())
  const loggedSets = liftSrc ? readModelLog(liftSrc.workouts, { convert: liftSrc.convert }).sets : []

  exercises.forEach((ex, i) => {
    // The four main lifts: the lift model decides, from the whole log.
    const lift = canonicalLiftId(ex.name)
    if (lift && liftSrc) {
      const isHeld = isLiftHeld(ex, p1, capActive)
      const src = {
        ...liftSrc, phaseName, directive, dayOf,
        sessions: [{ name: routineName ?? undefined, intent: routineIntent, exercises: [ex] }],
      }
      const model = modelFromSources(lift, { ...src, noPush: isHeld ? `${p1!.category} cap holds until it clears` : null })
      const rec = model.recommendation
      if (rec) {
        held[i] = isHeld
        targets[i] = rec.skip ? null : rec.load
        skip[i] = rec.skip
        pushTargets[i] = isHeld ? modelFromSources(lift, src).recommendation?.load ?? null : null
        hints[i] = liftHint(rec, u.unit)
        const stale = model.trainingMax?.override?.stale ?? []
        reasons[i] = [
          rec.reason, ...rec.why, ...rec.conditional,
          ...(stale.length ? [`Hand-set TM may be out of date (${stale.join('; ')}) — check it in You → Training maxes`] : []),
        ]
        return
      }
    }
    const top = (lastWeights && sameSlot(i, ex.name) ? topWorkingSet(lastWeights[String(i)]) : null)
      ?? byName.get(ex.name) ?? null
    // Per-LIFT autoregulation against THIS exercise's own target RPE (falling
    // back to the block's target, then the week's): each lift's last RPE vs its
    // own target sets its load step — capped by phase — instead of one
    // program-wide delta.
    const exTarget = ex.target_rpe ?? phaseTarget ?? rpeTarget
    const prescribed = projectExerciseLoad({
      exercise: ex,
      lastWeight: top?.weight ?? null,
      lastRpe: top?.rpe,
      lastReps: top?.reps,
      weeklyDelta: loadDeltaPct,
      directive,
      sessionIntent: routineIntent,
      sessionName: routineName,
      u,
    })
    const canProgress = allowsAutoProgress({
      exercise: ex, sessionIntent: routineIntent, sessionName: routineName, directive,
    })
    // Per-lift push / hold / drop off this movement's own last two weeks when it
    // has RPE to read (+2.5% upper, +5% lower). With none there is nothing
    // per-lift to read, and the old autoregulation stands.
    const call = top?.rpe != null && directive !== 'DELOAD' && directive !== 'RECOVERY'
      ? exerciseCall(loggedSets, ex.name, today, exTarget ?? 8)
      : null
    const exDelta = prescribed.source === 'explicit' || !canProgress
      ? 0
      : call
        ? call.deltaPct
        : autoregulateDelta(top?.rpe, exTarget, loadDeltaPct, directive, maxUp)
    if (call && canProgress && prescribed.source !== 'explicit') reasons[i] = [call.why]
    let uncapped = prescribed.source === 'explicit'
      ? prescribed.weight
      : canProgress
        ? recommendedLoad(top, exDelta, u)
        : prescribed.weight
    // Today's check-in reaches accessories too: a sore knee takes 10% off lunges
    // and skips the jumps; a short night takes 5% off everything.
    for (const m of dayOfModifiers(ex.name, dayOf)) {
      reasons[i] = [...(reasons[i] ?? []), m.note]
      if (m.skip) { skip[i] = true; uncapped = null; continue }
      if (uncapped != null) uncapped = u.prescribe(u.store(uncapped) * m.factor)
    }

    // Held when the cap is live AND this lift genuinely trains the limiter's
    // chain. `addressesLimiter` returning null means the library has no opinion
    // about the movement, in which case we trust the stamp the program already
    // carries rather than inventing an answer in either direction.
    const isHeld = isLiftHeld(ex, p1, capActive)
    held[i] = isHeld
    // What the lift would have been asked to do with no limiter in the way. This
    // is what "Push it" aims at — an override with a real number beats one that
    // just shrugs and leaves the athlete to guess.
    pushTargets[i] = isHeld ? uncapped : null

    if (skip[i]) {
      targets[i] = null
      hints[i] = 'Skip today'
    } else if (isHeld && (exDelta > 0 || directive === 'PROGRESS')) {
      // Suppress the push: state the hold and why, grounded in the last load.
      // The recommendation under a held cap is the last load itself.
      targets[i] = top?.weight != null ? u.show(top.weight) : null
      hints[i] = top && top.weight != null
        ? `Hold ${u.fmt(top.weight)}${u.unit} — cap stays until ${p1!.category} clears`
        : `Hold steady — ${p1!.category} not cleared yet`
    } else {
      targets[i] = uncapped
      hints[i] = buildHint(top, u, directive, exDelta, exTarget, targets[i])
    }
  })

  // The way out of the cap. Shown whenever a cap is live, even on a day the
  // tested lift isn't programmed — knowing the exit condition is the point, and
  // a wall you can't see the door in is the thing we're fixing.
  let clearance: ClearanceView | null = null
  if (capActive && p1) {
    const open = clearanceTestOf(p1)
    const lift = open?.lift ?? pickClearanceLift(exercises, p1.category, (n) => byName.has(n))
    if (lift) {
      const test = open ?? {
        kind: 'clearance_test' as const,
        lift,
        criterion: { top_sets: CLEARANCE_TOP_SETS, min_rpe: phaseTarget, sessions: CLEARANCE_SESSIONS, pain_free: true as const },
        opened_at: '', sessions_passed: 0, status: 'open' as const,
      }
      clearance = {
        lift,
        requirement: describeClearanceTest(test),
        sessionsPassed: test.sessions_passed,
        sessionsNeeded: test.criterion.sessions,
        minRpe: test.criterion.min_rpe,
        exerciseIndex: exercises.findIndex((ex) => ex.name === lift),
      }
    }
  }

  return {
    directive, loadDeltaPct, rpeTarget, rationale, hints, held, targets, pushTargets, rule, clearance, phaseName,
    exerciseNames: exercises.map((ex) => ex.name),
    reasons, skip,
  }
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
    .from('workout').select('routine_id, performed_at, exercises_snapshot, actual_weights').eq('id', workoutId).maybeSingle()
  if (!workout) return null

  const { data: routine } = await supabase
    .from('routine').select('exercises, phase_id').eq('id', workout.routine_id).maybeSingle()
  // As performed: a stand-in carries its slot's insight_id, so a felt "Solid" on
  // the dumbbell press that replaced the bench is evidence about the same read.
  const exercises = resolveLoggedExercises({
    actual_weights: null,
    exercises_snapshot: workout.exercises_snapshot as ExerciseTemplate[] | null,
    routine: { exercises: (routine?.exercises as ExerciseTemplate[] | null) ?? [] },
  })

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

  // Defer only if the LLM debrief already moved P1 DOWNWARD from this session —
  // that's the same move we're about to make, and doing it twice would double-count
  // one session's evidence. A confirming or neutral debrief entry is not a reason
  // to skip: the old check deferred on ANY entry carrying this workout_id, which
  // meant that whenever the debrief mentioned the limiter at all, the one path
  // that can actually retire a limiter quietly stood down. Between that and
  // advanceStatus refusing to move backwards, nothing could clear a read at all.
  const debriefAlreadyLowered = Array.isArray(p1.evidence) && p1.evidence.some((e) => {
    const entry = e as { workout_id?: string; direction?: string } | null
    return entry?.workout_id === workoutId && entry?.direction === 'disconfirming'
  })
  if (debriefAlreadyLowered) return null

  // This session's evidence on the P1-linked work. "Strong" is read off the
  // sets: a top set at or under the lift's target RPE with nothing missed (see
  // strongTopSet). Pain is still the athlete's Tweak / Pain flag — RPE can't
  // say a set hurt. Sessions logged with the old Easy / Solid chips still count.
  const { data: obs } = await supabase
    .from('session_observation').select('signal, severity, category').eq('workout_id', workoutId)
  const felt = ((obs ?? []) as Array<{ signal: string; severity: number; category: string }>)
    .filter((o) => o.category === 'Felt')
  let phaseName: string | null = null
  const phaseId = (routine as { phase_id?: string | null } | null)?.phase_id ?? null
  if (phaseId) {
    const { data: ph } = await supabase.from('phase').select('name').eq('id', phaseId).maybeSingle()
    phaseName = (ph as { name?: string } | null)?.name ?? null
  }
  const units = unitContext()
  const strongLifts = new Set<string>()
  let pain = 0
  let exemplar: string | null = null
  const logged = readLoggedExercises({
    actual_weights: (workout.actual_weights as Record<string, SetLog[]> | null) ?? null,
    exercises_snapshot: workout.exercises_snapshot as ExerciseTemplate[] | null,
    routine: { exercises: (routine?.exercises as ExerciseTemplate[] | null) ?? [] },
  })
  for (const { name, exercise, sets } of logged) {
    if (!p1Names.has(name)) continue
    const top = strongTopSet(sets, exercise?.target_rpe ?? rpeContract(phaseName).target)
    if (!top) continue
    strongLifts.add(name)
    if (!exemplar) exemplar = `${name} (${units.fmt(top.weight!)}${units.unit}×${top.reps} @${top.rpe})`
  }
  for (const o of felt) {
    const name = o.signal.split('—')[0].trim()
    if (!p1Names.has(name)) continue
    if (o.severity >= SEVERITY_PAIN) pain++
    else if (o.severity <= SEVERITY_STRONG && !strongLifts.has(name)) { strongLifts.add(name); if (!exemplar) exemplar = name }
  }
  const strong = strongLifts.size

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
  const sets = `${strong} top set${strong === 1 ? '' : 's'} on target`
  const note = resolved
    ? `${p1.category} is clearing. ${sets} on ${where} with no pain dropped the limiter to ${newPct}% — I'm calling it resolved. The load cap on that pattern lifts now.`
    : `${p1.category} is resolving. ${sets} on ${where}, no pain — limiter confidence ${prevPct}%→${newPct}% because of what you just did. Keep this up and we clear it.`

  await insertCoachMessage(athleteId, { kind: 'note', body: note, ref_id: p1.id })
  return { note, insightId: p1.id, category: p1.category, resolved, previousConfidence, newConfidence }
}

// ════════════════════════════════════════════════════════════════════════════
// THE CLEARANCE TEST — the door in the wall.
//
// "Load stays capped until the pattern clears" is only fair if the athlete can
// find out what clearing it takes. This states the exit condition as a concrete,
// dated, falsifiable claim on ONE named lift, tracks it session by session, and
// either retires the limiter or reconfirms it out loud.
//
// Doctrine: code owns the criteria and the arithmetic. The agent is not asked
// what would clear a limiter; it is at most asked to phrase the answer.
// ════════════════════════════════════════════════════════════════════════════

export interface ClearanceOutcome {
  test: ClearanceTest
  note: string
  /** This session counted toward clearing. */
  passed: boolean
  /** The limiter is now resolved and the cap is off. */
  cleared: boolean
  /** Pain on the tested lift — the limiter was argued FOR, not against. */
  reconfirmed: boolean
}

/**
 * Read a logged session against the athlete's open clearance test — opening one
 * first if the limiter has none. Returns the outcome when the session was
 * relevant to the test, else null. Idempotent per workout (the test's own log is
 * the guard). Called from commitSession alongside recordSessionAdaptation.
 */
export async function evaluateClearanceTest(athleteId: string, workoutId: string): Promise<ClearanceOutcome | null> {
  const { data: workout } = await supabase
    .from('workout').select('routine_id, actual_weights, exercises_snapshot').eq('id', workoutId).maybeSingle()
  if (!workout) return null

  const { data: routine } = await supabase
    .from('routine').select('exercises, phase_id').eq('id', workout.routine_id).maybeSingle()
  // The session as performed: a bench press swapped out for dumbbells that day
  // didn't happen, and its slot's sets are not bench-press proof.
  const exercises = resolveLoggedExercises({
    actual_weights: workout.actual_weights as Record<string, SetLog[]> | null,
    exercises_snapshot: workout.exercises_snapshot as ExerciseTemplate[] | null,
    routine: { exercises: (routine?.exercises as ExerciseTemplate[] | null) ?? [] },
  })
  if (!exercises.length) return null

  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const p1 = ((insightRows ?? []) as InsightRow[])
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')[0] ?? null
  // A limiter the system has already talked itself out of doesn't need a test —
  // the cap is already off (see gatherSessionPrescription).
  if (!p1 || p1.confidence < P1_RESOLVE_THRESHOLD) return null

  // The block's RPE target defines "a real top set" for this test.
  let phaseName: string | null = null
  if (routine?.phase_id) {
    const { data: ph } = await supabase.from('phase').select('name').eq('id', routine.phase_id).maybeSingle()
    phaseName = (ph as { name: string } | null)?.name ?? null
  }
  const minRpe = rpeContract(phaseName).target

  const evidence = Array.isArray(p1.evidence) ? [...p1.evidence] : []
  let test = clearanceTestOf(p1)
  let testIdx = test ? evidence.findIndex((e) => isClearanceTest(e) && e.status === 'open') : -1

  if (!test) {
    const lift = pickClearanceLift(exercises, p1.category, () => true)
    if (!lift) return null
    test = newClearanceTest(lift, minRpe, new Date().toISOString())
    evidence.push(test)
    testIdx = evidence.length - 1
  }

  // Already counted this session? The test's own log is the idempotency guard,
  // so a replayed outbox commit can't double-credit a session.
  if ((test.log ?? []).some((l) => l.workout_id === workoutId)) return null

  const { data: obs } = await supabase
    .from('session_observation').select('signal, severity, category').eq('workout_id', workoutId)
  const observations = ((obs ?? []) as Array<{ signal: string; severity: number; category: string }>)
  const nameOf = (signal: string) => signal.split('—')[0].trim()

  // Which lift carried the proof this session. The named test lift is the
  // default, but a lift the athlete deliberately PUSHED counts too, as long as
  // it trains the limiter's chain: an athlete who says "I'm ready, let me test
  // it" and is then proved right has produced exactly the evidence the test was
  // asking for, and refusing to count it would make the override theatre.
  const pushedOnChain = observations
    .filter((o) => o.category === 'Probe')
    .map((o) => nameOf(o.signal))
    .filter((n) => addressesLimiter(n, p1.category) === true)

  const candidates = [test.lift, ...pushedOnChain.filter((n) => n !== test!.lift)]
  const attempts: LiftAttempt[] = candidates
    .map((name) => {
      const idx = exercises.findIndex((ex) => ex.name === name)
      if (idx < 0) return null
      const sets = ((workout.actual_weights as Record<string, SetLog[]> | null) ?? {})[String(idx)] ?? []
      return {
        name,
        qualifying: sets.filter((s) => s.done && s.rpe != null && s.rpe >= test!.criterion.min_rpe).length,
        pain: observations.some((o) => o.category === 'Felt' && o.severity >= SEVERITY_PAIN && nameOf(o.signal) === name),
      }
    })
    .filter((c): c is LiftAttempt => c !== null)

  const { relevant, passed, painOnLift, provedOn, qualifying } = judgeClearanceSession(test, attempts)
  if (!relevant) return null   // the session simply didn't test anything

  const now = new Date().toISOString()

  const updated: ClearanceTest = {
    ...test,
    sessions_passed: passed ? test.sessions_passed + 1 : 0,
    log: [...(test.log ?? []), { workout_id: workoutId, passed, at: now }],
    status: painOnLift ? 'reconfirmed' : test.sessions_passed + 1 >= test.criterion.sessions ? 'passed' : 'open',
  }
  evidence[testIdx] = updated

  const cleared = updated.status === 'passed'
  const previousConfidence = p1.confidence
  const newConfidence = clampConfidence(
    painOnLift ? previousConfidence + P1_DISCONFIRM_STEP : previousConfidence - P1_DISCONFIRM_STEP,
  )

  // A reconfirmed test re-opens as a fresh one, so the athlete always has a
  // stated way out rather than a limiter that just got harder for no visible
  // reason. Appended BEFORE the payload is built — the closed record stays in
  // place at its own index and the new test sits after it.
  if (painOnLift) evidence.push(newClearanceTest(updated.lift, minRpe, now))

  const update: Record<string, unknown> = { confidence: newConfidence, evidence }
  if (cleared) {
    update.status = 'resolved'
    update.resolved_at = now
  }

  await supabase.from('insight').update(update).eq('id', p1.id)

  // Name the lift that actually carried the session — which may be one the
  // athlete pushed rather than the one the test nominated.
  const note = painOnLift
    ? `${provedOn} flagged pain at test weight — that's the ${p1.category} limiter answering, so it stands (${Math.round(previousConfidence * 100)}%→${Math.round(newConfidence * 100)}%). The cap stays and the test resets. This is the system working, not you failing it.`
    : cleared
      ? `Clearance test passed. ${updated.criterion.sessions} sessions of ${updated.criterion.top_sets}+ top sets at RPE ${updated.criterion.min_rpe}+ on ${provedOn}, no pain — ${p1.category} is resolved and the load cap is off.`
      : `${provedOn} banked session ${updated.sessions_passed} of ${updated.criterion.sessions} toward clearing ${p1.category}. ${qualifying} qualifying set${qualifying === 1 ? '' : 's'} at RPE ${updated.criterion.min_rpe}+, pain-free. One more like that and the cap comes off.`

  await insertCoachMessage(athleteId, { kind: 'note', body: note, ref_id: p1.id })
  return { test: updated, note, passed, cleared, reconfirmed: painOnLift }
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

async function insertPhaseAndRoutines(
  programId: string, plan: GeneratedProgram, status: PhaseStatus = 'active',
): Promise<string | null> {
  const { data: newPhase } = await supabase.from('phase').insert({
    program_id: programId,
    name: plan.phase.name,
    week_start: plan.phase.week_start,
    week_end: plan.phase.week_end,
    non_negotiables: plan.phase.non_negotiables,
    advancement_criteria: plan.phase.advancement_criteria,
    status,
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
// ════════════════════════════════════════════════════════════════════════════
// PHASE DESIGN (agent proposes, code disposes) — a SCREENED, mid-program phase
// designed by the model around the athlete's REAL logged lifts, with the
// deterministic generatePhase template as the always-safe fallback. This is what
// makes a Strength block carry the athlete's actual barbell work (progressing
// from their logged top sets) instead of a generic category template.
// ════════════════════════════════════════════════════════════════════════════

// Most recent top working set per exercise NAME across the whole program (not
// just one routine). The cross-phase base for projections: a freshly (re)designed
// phase reuses the athlete's real lift names, so loads read off their actual
// history immediately instead of waiting to be logged again in-phase.
async function gatherExerciseBases(programId: string): Promise<Map<string, SetLog>> {
  const { data: ws } = await supabase
    .from('workout')
    .select('performed_at, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)')
    .eq('routine.program_id', programId)
    .order('performed_at', { ascending: false })
    .limit(60)
  const out = new Map<string, SetLog>()
  for (const w of (ws ?? []) as unknown as LoggedWorkoutLike[]) {
    for (const { name, sets } of readLoggedExercises(w)) {
      if (out.has(name)) continue   // newest wins (rows are desc)
      const top = topWorkingSet(sets)
      if (top) out.set(name, top)
    }
  }
  return out
}

// Newest logged top set per exercise across the program — the athlete's real
// lifts, fed to the design agent so a new phase reuses the same names (history
// carries forward) and the right working loads.
async function gatherRecentLifts(programId: string, u: UnitContext): Promise<Array<{ name: string; top_set: string; rpe: number | null }>> {
  const { data: ws } = await supabase
    .from('workout')
    .select('rpe, performed_at, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)')
    .eq('routine.program_id', programId)
    .order('performed_at', { ascending: false })
    .limit(40)
  const seen = new Map<string, { top_set: string; rpe: number | null }>()
  for (const w of (ws ?? []) as unknown as Array<LoggedWorkoutLike & { rpe: number | null }>) {
    for (const { name, exercise, sets } of readLoggedExercises(w)) {
      // A stand-in was the gym's call that day, not the program's — the next
      // block is designed around the movements that were planned.
      if (exercise?.swapped_from) continue
      if (seen.has(name)) continue   // newest wins
      const top = topWorkingSet(sets)
      if (!top) continue
      const detail = top.weight != null ? `${u.fmt(top.weight)}${u.unit}×${top.reps ?? '?'}`
        : top.duration != null ? `${top.duration}s`
        : top.distance != null ? `${top.distance}`
        : `${top.reps ?? '?'} reps`
      seen.set(name, { top_set: detail, rpe: top.rpe ?? w.rpe })
    }
  }
  return [...seen.entries()].map(([name, v]) => ({ name, top_set: v.top_set, rpe: v.rpe })).slice(0, 20)
}

// Dispose the agent's design onto the canonical GeneratedProgram shape with
// deterministic guardrails (clamp sets, cap sessions/exercises, stamp the P1
// insight, keep canonical advancement criteria). Returns null when the design
// carries no usable session — the caller decides what a floor is worth, because
// substituting the template is safe for a brand-new athlete and destructive for
// one mid-block.
function disposePhaseDesign(
  d: PhaseDesignResult, phaseName: PhaseName, category: string, startDateStr: string, p1InsightId: string | null,
): GeneratedProgram | null {
  const canonical = generatePhase(phaseName, category, startDateStr, { p1InsightId })
  // Caps match the program editor's (7 sessions, 12 exercises, 10 sets), not the
  // old conservative ones: an athlete who has built a six-day week with a jump
  // day should not have it truncated back to five sessions at a phase boundary.
  const routines = (d.sessions ?? []).slice(0, 7).map((s, i) => ({
    name: (s.name ?? '').trim() || `Session ${String.fromCharCode(65 + i)}`,
    session_type: 'strength',
    exercises: (s.exercises ?? []).slice(0, 12).map((ex) => {
      const t: ExerciseTemplate = {
        name: String(ex.name ?? '').trim(),
        sets: Math.max(1, Math.min(10, Math.round(Number(ex.sets)) || 3)),
        reps: String(ex.reps ?? '8'),
        load: ex.load,
        cue: ex.cue ? String(ex.cue) : undefined,
      }
      // The block's RPE target, and the limiter attribution — but only on the
      // lifts that actually train that chain. See generatePhase's stamp note.
      if (isCountedReps(t.reps)) t.target_rpe = PHASE_RPE[phaseName].target
      if (p1InsightId && addressesLimiter(t.name, category) === true) t.insight_id = p1InsightId
      return t
    }).filter((ex) => ex.name),
    intent: s.intent ? String(s.intent) : '',
  })).filter((r) => r.exercises.length)

  if (!routines.length) return null
  return {
    goal: (d.goal ?? '').trim() || canonical.goal,
    retest_date: canonical.retest_date,
    phase: {
      name: phaseName,
      week_start: startDateStr,
      week_end: canonical.phase.week_end,
      non_negotiables: d.non_negotiables?.length ? d.non_negotiables : canonical.phase.non_negotiables,
      advancement_criteria: canonical.phase.advancement_criteria,
    },
    routines,
  }
}

/**
 * A designed phase, and whether it is the athlete's or the template's.
 *
 * `fellBack` is the whole point. The deterministic template is a safe floor for
 * an athlete who has no training behind them — it is NOT a safe replacement for
 * a block someone is already mid-way through, because it knows nothing about
 * their lifts, their loads, or the steer they set in the program editor. A
 * caller that swaps blocks has to be able to tell the two apart, so it can
 * decline to install a floor over real training. `reason` carries the agent's
 * own failure string through for the coach message and the developer log.
 */
interface DesignedPhase {
  plan: GeneratedProgram
  fellBack: boolean
  reason: string | null
}

// Design a phase via the agent (screened athlete), falling back to the
// deterministic template on ANY failure — the app always produces a safe phase.
// Callers MUST check `fellBack` before overwriting an existing block; see the
// DesignedPhase doc.
async function designPhasePlan(
  athleteId: string, programId: string, phaseName: PhaseName, startDateStr: string,
  category: string, p1InsightId: string | null, u: UnitContext, emphasis?: string,
): Promise<DesignedPhase> {
  const template = (reason: string): DesignedPhase => ({
    plan: generatePhase(phaseName, category, startDateStr, { p1InsightId }),
    fellBack: true,
    reason,
  })
  try {
    const [{ data: ath }, { data: insightRows }] = await Promise.all([
      supabase.from('athlete').select('goals, obstacle, training_age, sessions_per_week, training_preferences').eq('id', athleteId).maybeSingle(),
      supabase.from('insight').select('priority, category, claim, confidence, status').eq('athlete_id', athleteId).order('priority'),
    ])
    // The newest top set per lift, AND the arc behind it. Without the arc the
    // designer cannot tell progress from a plateau, and every block is built for
    // an athlete who just arrived.
    const [recent_lifts, history, retest] = await Promise.all([
      gatherRecentLifts(programId, u),
      gatherProgramHistory(athleteId, programId, u).catch(() => null),
      // What the retest that triggered this block found. Best-effort: a design
      // that can't read it is the design we always shipped.
      gatherRetestFindings(athleteId).catch(() => null),
    ])
    const insights = ((insightRows ?? []) as Array<{ priority: string; category: string; claim: string; confidence: number; status: string }>)
      .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
    // An explicit steer for THIS design wins; otherwise the athlete's standing
    // preferences carry (set in the program editor). Without the fallback, every
    // phase boundary would silently revert them to the template's idea of a week.
    const trimmedEmphasis = emphasis?.trim() || ((ath?.training_preferences as string | null) ?? '').trim()
    const res = await callPhaseDesign({
      phase_name: phaseName,
      profile: {
        goal: (ath?.goals as string | null) ?? null,
        target: null,
        obstacle: (ath?.obstacle as string | null) ?? null,
        training_age: (ath?.training_age as number | null) ?? null,
        sessions_per_week: (ath?.sessions_per_week as number | null) ?? null,
      },
      insights,
      recent_lifts,
      ...(trimmedEmphasis ? { emphasis: trimmedEmphasis } : {}),
      ...(history ? { history } : {}),
      ...(retest ? { retest } : {}),
    })
    if (!res.ok) return template(res.reason ? `${res.error}: ${res.reason}` : res.error)
    // A call that succeeds can still carry no usable session (zero sessions, or
    // every exercise name blank), so "the agent answered" is not the same as
    // "we got a real block".
    const plan = disposePhaseDesign(res.data, phaseName, category, startDateStr, p1InsightId)
    if (!plan) return template('design_empty')
    return { plan, fellBack: false, reason: null }
  } catch (e) {
    return template(`threw: ${String(e)}`)
  }
}

/**
 * Leave a trace when the designer fell back and a block swap was declined.
 *
 * Deliberately NOT a program_revision row: that table is the athlete's journey,
 * it is append-only history of reprogramming that actually happened, and
 * gatherProgramHistory feeds it back to the designer as "changes the athlete
 * already made, with what they asked for". A failure to reprogram is neither of
 * those things, and filing it there would both misread on the timeline and
 * mislead the next design. The athlete-facing record is the coach_message the
 * caller writes; this is the developer-facing half, carrying the agent's own
 * reason string — which the client otherwise discards into the fallback, and
 * which is exactly what was missing when this bug was diagnosed.
 */
async function recordPhaseDesignFallback(
  programId: string, phaseId: string | null, nextName: PhaseName, reason: string | null,
): Promise<void> {
  console.error(
    '[loop] phase design fell back to the template — block swap declined',
    { programId, phaseId, nextName, reason },
  )
}

/**
 * Guard the "exactly one active phase" invariant the rest of the loop assumes.
 * The retest re-scope and phase advancement each read the current phase with
 * .maybeSingle(); if churn ever leaves two rows flagged active (e.g. an
 * interrupted boundary swap, or a retest submitted twice), those reads return
 * null and silently stop completing the old phase — and Today, which loads
 * routines per active phase, starts surfacing multiple phases' sessions at once
 * (the "8-10 sessions this week" bug). Collapse any extras here: the newest
 * block (latest week_start) stays active, the rest are marked completed.
 * Idempotent — a no-op whenever zero or one phase is active.
 */
async function reconcileActivePhases(athleteId: string): Promise<boolean> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return false
  const { data: activeRows } = await supabase
    .from('phase').select('id, week_start')
    .eq('program_id', prog.id).eq('status', 'active')
    .order('week_start', { ascending: false })
  const actives = (activeRows ?? []) as Array<{ id: string; week_start: string }>
  if (actives.length <= 1) return false
  // Keep the newest block, retire the stragglers.
  const stale = actives.slice(1).map((p) => p.id)
  await supabase.from('phase').update({ status: 'completed' }).in('id', stale)
  return true
}

/**
 * Activate a phase that was scheduled to begin later (a retest re-scope deferred
 * to the start of next week, so a mid-week retest never wipes the sessions
 * already logged this week). Fires once its `week_start` has landed: retires
 * whatever's active and promotes the queued block. Unconditional — a scheduled
 * block is a decision already made, so no advancement gate applies. Idempotent:
 * a no-op once no due pending phase remains.
 */
async function activateDueScheduledPhase(athleteId: string): Promise<boolean> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return false

  const today = isoDate(new Date())
  const { data: due } = await supabase
    .from('phase').select('id, name, week_start')
    .eq('program_id', prog.id).eq('status', 'pending').lte('week_start', today)
    .order('week_start').limit(1).maybeSingle()
  if (!due) return false
  const { id: dueId, name: dueName, week_start: dueStart } =
    due as { id: string; name: PhaseName; week_start: string }

  await supabase.from('phase').update({ status: 'completed' })
    .eq('program_id', prog.id).eq('status', 'active')
  await supabase.from('phase').update({ status: 'active' }).eq('id', dueId)
  await supabase.from('athlete_profile')
    .update({ current_phase: dueName, last_updated: new Date().toISOString() })
    .eq('athlete_id', athleteId)

  // Two things queue a block: a mid-week retest re-scoping the training, and the
  // athlete deferring their own edit to the boundary. Greeting a change someone
  // made by hand as though the system re-scoped them is a small lie that makes
  // the app feel like it isn't listening, so name the one that actually happened.
  // Matched on the block's OWN start date, not on today: activation fires the
  // next time the app opens, which for a Monday handover is often Tuesday.
  const { data: steer } = await supabase
    .from('program_revision').select('requests')
    .eq('program_id', prog.id).eq('trigger', 'editor').eq('effective_on', dueStart)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const asked = ((steer as { requests: string[] | null } | null)?.requests ?? [])[0]
  await insertCoachMessage(athleteId, {
    kind: 'phase_change',
    body: steer
      ? `The changes you made are live — your ${dueName} week starts today${asked ? `, with what you asked for: "${asked}"` : ''}.`
      : `New block is live — your re-scoped ${dueName} phase starts this week.`,
    ref_id: dueId,
  })
  return true
}

export async function runPhaseAdvancement(athleteId: string): Promise<boolean> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return false

  const { data: phaseRow } = await supabase
    .from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
  if (!phaseRow) return false
  const phase = phaseRow as PhaseRow

  // A scheduled block is queued (e.g. a mid-week retest deferred its new phase to
  // the week boundary). Let activateDueScheduledPhase own that transition — the
  // normal advancement gate must not fire a competing swap.
  const { count: pendingCount } = await supabase
    .from('phase').select('id', { count: 'exact', head: true })
    .eq('program_id', prog.id).eq('status', 'pending')
  if ((pendingCount ?? 0) > 0) return false

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

  if (!nextName) {
    await supabase.from('phase').update({ status: 'completed' }).eq('id', phase.id)
    await insertCoachMessage(athleteId, {
      kind: 'phase_change',
      body: `You've cleared the full arc — Sport phase complete. A retest will re-scope what's next.`,
      ref_id: phase.id,
    })
    return true
  }

  // Blocks are Monday-anchored everywhere else in the loop, so anchor here too.
  // Stamping `today` started a block mid-week, which split the athlete's week
  // across two phases and hid the sessions they had already logged. Worse, the
  // mid-week week_end that follows from it makes the NEXT advancement fire
  // mid-week too, so one such start keeps re-infecting every block after it.
  //
  // And preserve an in-progress week exactly the way the retest re-scope does
  // (see rescopeAfterRetest): if anything is already logged this week, the new
  // block is QUEUED for next Monday and the current one runs out the week.
  // Advancement fires on the first app open past week_end, which for a Sunday
  // end is usually Monday — but for someone who opens the app on Wednesday it
  // is Wednesday, and their half-finished week must not be swapped out from
  // under them.
  const weekMonday = startOfWeekMonday(new Date())
  const { count: loggedThisWeek } = await supabase
    .from('workout').select('id, routine!inner(program_id)', { count: 'exact', head: true })
    .eq('routine.program_id', prog.id)
    .gte('performed_at', weekMonday.toISOString())
  const defer = (loggedThisWeek ?? 0) > 0
  const startsOn = defer ? addDays(isoDate(weekMonday), 7) : isoDate(weekMonday)

  // Design BEFORE retiring the current block. The template is a safe floor for
  // an athlete with nothing behind them, but installing it over a block someone
  // is training is destructive: it knows none of their lifts, none of their
  // loads, and none of the steer they set in the program editor. So when the
  // designer falls back, HOLD — the block they have beats a block we couldn't
  // build. (2026-08-11: this ran the other way round and replaced a real
  // 5-session week with a 3-session "Session A/B/C" template.)
  const designed = await designPhasePlan(athleteId, prog.id, nextName, startsOn, category, p1?.id ?? null, unitContext())

  if (designed.fellBack) {
    const heldUntil = weekEndingISO(startOfWeekMonday(new Date(`${addDays(isoDate(weekMonday), 7)}T12:00:00`)))
    await supabase.from('phase').update({ week_end: heldUntil }).eq('id', phase.id)
    await insertCoachMessage(athleteId, {
      kind: 'phase_change',
      body: `You've earned the step up to ${nextName}, but I couldn't build the new block just now — so I'm holding ${phase.name} rather than dropping you onto a generic week. Your sessions are unchanged. I'll try again on the next open.`,
      ref_id: phase.id,
    })
    await recordPhaseDesignFallback(prog.id, phase.id, nextName, designed.reason)
    return false
  }

  const plan = designed.plan

  // Only one pending phase can exist at a time and we returned early above if
  // one did, so a fresh insert is always right here — no pending block of the
  // next stage can be sitting there waiting to be adopted.
  if (defer) {
    // Current block runs out the week; the new one activates at the boundary via
    // activateDueScheduledPhase. Nothing logged this week gets orphaned, and
    // current_phase stays put until the swap actually happens.
    await supabase.from('phase')
      .update({ week_end: weekEndingISO(weekMonday) })
      .eq('id', phase.id)
    const queuedId = await insertPhaseAndRoutines(prog.id, plan, 'pending')
    await insertCoachMessage(athleteId, {
      kind: 'phase_change',
      body: `You've cleared ${phase.name} — your ${nextName} block is built and starts Monday. This week stays as it is.`,
      ref_id: queuedId ?? phase.id,
    })
    return true
  }

  await supabase.from('phase')
    .update({ status: 'completed', week_end: addDays(startsOn, -1) })
    .eq('id', phase.id)
  const newPhaseId = await insertPhaseAndRoutines(prog.id, plan, 'active')

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

export function isRetestDue(retestDate: string | null, now: Date = new Date()): boolean {
  if (!retestDate) return false
  return isoDate(now) >= retestDate
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
  /**
   * Lifts that went up since the last retest. The retest's whole job is to say
   * what changed, and until now it could only ever talk about movement scores —
   * it collected strength numbers at every version and never once compared them.
   */
  stronger: StrengthDelta[]
  // The re-scoped block was queued for next Monday (the current week already had
  // logged sessions) rather than swapped in immediately. Lets the summary explain
  // why this week is unchanged.
  deferred: boolean
}

// Re-scope the program after a retest: clean → advance the phase; otherwise a
// fresh Stability block on the new P1 weakness. New retest_date either way.
//
// Timing matters. A retest is due on a fixed 28-day cadence, so it usually lands
// MID-WEEK — and the athlete has often already logged sessions this week. Swapping
// the phase (and its routines) in immediately orphaned those sessions from the new
// routine rows, so Today reset to 0/N done and the week read as wiped. So: when
// the current week already holds logged sessions, the new block is QUEUED as a
// pending phase starting next Monday and the current phase runs out the week
// (activateDueScheduledPhase promotes it at the boundary). A clean week has
// nothing to preserve, so the new block takes over immediately as before.
async function rescopeAfterRetest(
  athleteId: string,
): Promise<{ deferred: boolean; startsOn: string; held?: boolean }> {
  const today = isoDate(new Date())
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return { deferred: false, startsOn: today }

  const { data: phaseRow } = await supabase
    .from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
  const currentName = (phaseRow as PhaseRow | null)?.name ?? 'Stability'

  const { data: insightRows } = await supabase
    .from('insight').select('*').eq('athlete_id', athleteId).order('priority')
  const active = ((insightRows ?? []) as InsightRow[]).filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const p1 = active[0] ?? null

  let nextName: PhaseName = 'Stability'
  const category = p1?.category ?? 'Lower Chain'
  if (!p1) {
    // Moves clean — advance the arc instead of re-running Stability.
    nextName = PHASE_SEQUENCE[PHASE_SEQUENCE.indexOf(currentName) + 1] ?? 'Sport'
  }

  // Preserve the in-progress week: defer the swap to next Monday iff a session was
  // already logged this week (the exact condition that would make the retest look
  // like it wiped the week).
  const weekMonday = startOfWeekMonday(new Date())
  const { count: loggedThisWeek } = await supabase
    .from('workout').select('id, routine!inner(program_id)', { count: 'exact', head: true })
    .eq('routine.program_id', prog.id)
    .gte('performed_at', weekMonday.toISOString())
  const deferred = (loggedThisWeek ?? 0) > 0
  const startsOn = deferred ? addDays(isoDate(weekMonday), 7) : today

  const designed = await designPhasePlan(athleteId, prog.id, nextName, startsOn, category, p1?.id ?? null, unitContext())

  // Same rule as the phase boundary: never retire a real block for a template
  // one. The retest itself still stands — the caller has already written the new
  // diagnostic and moved the insights — this only declines to swap the training.
  // The retest date is pushed a week rather than the usual 28 days so the
  // re-scope is retried soon instead of waiting out a full cycle.
  if (designed.fellBack) {
    await recordPhaseDesignFallback(prog.id, (phaseRow as PhaseRow | null)?.id ?? null, nextName, designed.reason)
    const retryOn = addDays(today, 7)
    await supabase.from('program').update({ retest_date: retryOn }).eq('id', prog.id)
    await supabase.from('athlete_profile')
      .update({ retest_date: retryOn, last_updated: new Date().toISOString() })
      .eq('athlete_id', athleteId)
    return { deferred: false, startsOn: today, held: true }
  }
  const plan = designed.plan

  if (deferred) {
    // Keep the current phase active through the end of this week; queue the new
    // block as pending. It activates at the boundary, so nothing logged this week
    // is orphaned.
    if (phaseRow) {
      await supabase.from('phase')
        .update({ week_end: weekEndingISO(weekMonday) })
        .eq('id', (phaseRow as PhaseRow).id)
    }
    await insertPhaseAndRoutines(prog.id, plan, 'pending')
  } else {
    if (phaseRow) await supabase.from('phase').update({ status: 'completed' }).eq('id', (phaseRow as PhaseRow).id)
    await insertPhaseAndRoutines(prog.id, plan, 'active')
    await supabase.from('athlete_profile')
      .update({ current_phase: nextName, last_updated: new Date().toISOString() })
      .eq('athlete_id', athleteId)
  }

  const newRetest = addDays(today, 28)
  await supabase.from('program').update({ retest_date: newRetest }).eq('id', prog.id)
  await supabase.from('athlete_profile')
    .update({ retest_date: newRetest, last_updated: new Date().toISOString() })
    .eq('athlete_id', athleteId)

  return { deferred, startsOn }
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
  // Strength moves against the PREVIOUS retest, not the first-ever baseline:
  // "since we last looked" is the question a retest answers. Movement scores
  // compare to baseline because a 0-3 score has a fixed ceiling; a lift doesn't.
  const prior = diags.length ? diags[diags.length - 1] : null
  const stronger = strengthDeltas(prior?.raw_results?.strength, newResults.strength)
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

  const rescope = await rescopeAfterRetest(athleteId)

  const deltaSummary = improved.length
    ? improved.map((i) => `${labelOfPattern(i.pattern)} ${i.from}→${i.to}`).join(', ')
    : 'no pattern gains yet'
  const strengthSummary = stronger.length
    ? ` ${stronger.map((s) => `${s.name} ${s.from}→${s.to} (+${s.pct}%)`).join(', ')}.`
    : ''
  const clearedNote = resolvedCount > 0
    ? `Cleared ${resolvedCount} weak link${resolvedCount === 1 ? '' : 's'}.`
    : 'Holding the line.'
  const scopeNote = rescope.deferred
    ? ' Re-scoped — new block starts Monday, this week stays as-is.'
    : ' Block re-scoped.'
  await insertCoachMessage(athleteId, {
    kind: 'retest',
    body: `Retest v${newVersion}: ${deltaSummary}.${strengthSummary} ${clearedNote}${scopeNote}`,
    ref_id: newDiagId,
  })

  return { version: newVersion, resolvedCount, improved, stronger, deferred: rescope.deferred }
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
  // Enforce the "exactly one active phase" invariant first, so every downstream
  // trigger's .maybeSingle() read resolves the real current phase (and Today
  // scopes the week to a single block, not several phases' routines at once).
  try { changed = (await reconcileActivePhases(athleteId)) || changed } catch (e) { console.error('[loop] active-phase reconcile failed', e) }
  // Promote a scheduled block (deferred retest re-scope) next, so downstream
  // triggers see the phase that's actually current this week.
  try { changed = (await activateDueScheduledPhase(athleteId)) || changed } catch (e) { console.error('[loop] scheduled phase activation failed', e) }
  try { changed = (await runWeeklyReviewAgent(athleteId, prog.id)) > 0 || changed } catch (e) { console.error('[loop] weekly review failed', e) }
  try { changed = (await runPhaseAdvancement(athleteId)) || changed } catch (e) { console.error('[loop] phase advancement failed', e) }
  return changed
}

// ---- Session commit (online completion + deferred offline sync) ------------
// The single server-side write path for a finished session: promote the draft to
// a real `workout` row, then (if a debrief was given) run the agent, persist the
// observations, move the insights, and record the adaptation. Both the live
// "Complete workout" flow and the offline outbox replay funnel through this, so
// the two can never drift. Throws on the first write failure (e.g. offline) so
// the caller can keep the session queued and retry.

export interface PendingDebrief {
  reflection: string
  readingAnswer: string
  exercises: DebriefExerciseInput[]
  reading: { name: string; readingWhy: string } | null
}

// Everything needed to commit a session, captured at completion so it can be
// replayed verbatim from the outbox later. Plain/serializable — it round-trips
// through localStorage.
export interface PendingSession {
  id: string
  athleteId: string
  routineId: string
  actualWeights: Record<string, SetLog[]>
  actualReps: Record<string, number[]>
  rpe: number | null
  durationMins: number
  setsDone: number
  athleteName: string | null
  // The onboarding step to write on commit: submit→first_session_complete,
  // skip→complete (first session only), else null.
  onboardingTransition: 'first_session_complete' | 'complete' | null
  debrief: PendingDebrief | null   // null when the athlete skipped the debrief
  // Editing an already-logged session: update this row instead of inserting, and
  // clear its prior observations before re-running the coach.
  editWorkoutId: string | null
  // The day the session happened (ISO). Lets a forgotten session be backdated;
  // null means "now" on insert / leave unchanged on edit.
  performedAt: string | null
  queuedAt: string
  /**
   * The routine's exercises AS THEY WERE when this session was logged, captured
   * client-side and carried through the outbox. actualWeights is index-keyed
   * against it, so without this a program edit made while the session sits
   * offline would silently relabel it on commit.
   */
  exercisesSnapshot: ExerciseTemplate[] | null
  /**
   * The session check-in, when the athlete gave one. Absent on entries queued
   * before it existed — those leave the row's check-in columns alone.
   */
  checkin?: SessionCheckinInput | null
}

/** What the athlete said about themselves at the start of a session. All optional. */
export interface SessionCheckinInput {
  sleepHours: number | null
  readiness: number | null
  kneePainL: number | null
  kneePainR: number | null
  bodyweight: number | null   // storage weight unit
}

export const EMPTY_CHECKIN: SessionCheckinInput = {
  sleepHours: null, readiness: null, kneePainL: null, kneePainR: null, bodyweight: null,
}

export function hasCheckin(c: SessionCheckinInput | null | undefined): boolean {
  return !!c && Object.values(c).some((v) => v != null)
}

/** The check-in as the lift model's day-of modifiers read it. */
export function checkinDayOf(c: SessionCheckinInput | null | undefined): DayOf | null {
  return hasCheckin(c) ? { sleepHours: c!.sleepHours, readiness: c!.readiness, kneePainL: c!.kneePainL, kneePainR: c!.kneePainR } : null
}

function checkinColumns(c: SessionCheckinInput | null | undefined): Record<string, number | null> | null {
  if (c == null) return null
  return {
    knee_pain_l: c.kneePainL, knee_pain_r: c.kneePainR,
    sleep_hours: c.sleepHours, readiness: c.readiness, bodyweight: c.bodyweight,
  }
}

// The check-in columns arrive with migration 20261026000001, and the database
// ships by hand, behind the web deploy. A backend without them rejects the write
// as an unknown column — so the session commits without its check-in rather than
// sitting in the outbox forever over four optional numbers.
function isMissingColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  // PostgREST says PGRST204 / 42703; the Worker's /api/data says "unknown column".
  return err.code === 'PGRST204' || err.code === '42703'
    || /column .*(does not exist|could not find)|could not find the .* column|unknown column/i.test(err.message ?? '')
}

export interface CommitResult {
  workoutId: string
  summary: string | null
  movedCount: number
  best: {
    movedInsightId: string | null
    category: string
    previousConfidence: number | null
    newConfidence: number | null
    isNew: boolean
  } | null
  setsDone: number
  durationMins: number
  athleteName: string | null
  firstSession: boolean   // drives the post-session revelation when committed live
}

export async function commitSession(p: PendingSession): Promise<CommitResult> {
  // 1. Promote to a real workout row — or update the one being edited. Editing
  //    rewrites the numbers (and clears the old observations) so re-running the
  //    coach reads the corrected session, not a duplicate of the original.
  let workoutId: string
  if (p.editWorkoutId) {
    const patch: Record<string, unknown> = {
      actual_weights: p.actualWeights,
      actual_reps:    p.actualReps,
      rpe:            p.rpe,
      duration_mins:  p.durationMins,
    }
    // Re-stamp the snapshot on an edit: the athlete re-entered these numbers
    // against the prescription they were just shown, which is what the indices
    // now mean. Absent (an older queued entry), leave the stored one alone.
    if (p.exercisesSnapshot?.length) patch.exercises_snapshot = p.exercisesSnapshot
    if (p.performedAt) patch.performed_at = p.performedAt
    const checkin = checkinColumns(p.checkin)
    let { data: updated, error: updErr } = await supabase
      .from('workout').update(checkin ? { ...patch, ...checkin } : patch).eq('id', p.editWorkoutId).select().single()
    if (checkin && isMissingColumn(updErr)) {
      ({ data: updated, error: updErr } = await supabase
        .from('workout').update(patch).eq('id', p.editWorkoutId).select().single())
    }
    if (updErr || !updated) throw updErr ?? new Error('workout update failed')
    workoutId = (updated as { id: string }).id
    // Clear prior observations so the re-run doesn't stack duplicates.
    await supabase.from('session_observation').delete().eq('workout_id', workoutId)
  } else {
    const insert: Record<string, unknown> = {
      routine_id:     p.routineId,
      actual_weights: p.actualWeights,
      actual_reps:    p.actualReps,
      rpe:            p.rpe,
      duration_mins:  p.durationMins,
    }
    // Freeze what these set indices mean. Without it the log is only readable
    // through the routine's CURRENT shape, and the next program edit rewrites
    // the athlete's history as a side effect.
    if (p.exercisesSnapshot?.length) insert.exercises_snapshot = p.exercisesSnapshot
    if (p.performedAt) insert.performed_at = p.performedAt
    const checkin = hasCheckin(p.checkin) ? checkinColumns(p.checkin) : null
    let { data: workout, error } = await supabase
      .from('workout').insert(checkin ? { ...insert, ...checkin } : insert).select().single()
    if (checkin && isMissingColumn(error)) {
      ({ data: workout, error } = await supabase.from('workout').insert(insert).select().single())
    }
    if (error || !workout) throw error ?? new Error('workout insert failed')
    workoutId = (workout as { id: string }).id
  }

  // The workout row now exists. Everything below is best-effort and must NOT
  // throw — if it did, the outbox would requeue a session that's already logged
  // and double-insert on the next flush. So the agent/observations/insights run
  // inside a guard; a failure still leaves the session correctly logged.
  const firstSession = p.onboardingTransition === 'first_session_complete'
  const loggedOnly: CommitResult = {
    workoutId, summary: null, movedCount: 0, best: null,
    setsDone: p.setsDone, durationMins: p.durationMins, athleteName: p.athleteName, firstSession,
  }
  try {
    // 2. Onboarding state transition, if any.
    if (p.onboardingTransition) {
      await supabase.from('athlete').update({ onboarding_step: p.onboardingTransition }).eq('id', p.athleteId)
    }

    // Skipped debrief → the workout is the whole record.
    if (!p.debrief) return loggedOnly

    const { reflection, readingAnswer, exercises, reading } = p.debrief

  // 3. Load existing insights so the engine can decide update vs create.
  const { data: existingInsights } = await supabase
    .from('insight')
    .select('*')
    .eq('athlete_id', p.athleteId)
    .neq('status', 'resolved')
    .neq('status', 'disproved')

  // 4. Agent classifies the whole session → many bounded actions (or fallback).
  const debrief = await runSessionDebriefAgent(
    p.athleteId,
    workoutId,
    {
      reflection,
      readiness: null,
      exercises,
      reading: reading ? { name: reading.name, question: reading.readingWhy, answer: readingAnswer } : null,
    },
    (existingInsights as InsightRow[]) ?? [],
  )

  // 5. Persist the raw signal as append-only observation rows. Severity 1–5.
  const obsRows: SessionObservationInsert[] = []
  for (const ex of exercises) {
    const note = ex.note?.trim()
    // A push is worth recording even with no chip and no note: the athlete
    // declaring "I'm testing this cap" is itself the signal.
    if (!ex.felt && !note && !ex.pushed) continue
    const sev = ex.felt ? FELT_CHIPS.find((c) => c.label === ex.felt)?.severity ?? 2 : 2
    const signal = ex.felt
      ? `${ex.name} — ${ex.felt}${note ? ` — ${note}` : ''}`
      : note
        ? `${ex.name} — ${note}`
        : `${ex.name} — pushed past the cap`
    if (ex.felt || note) obsRows.push({ workout_id: workoutId, category: 'Felt', signal, severity: sev })
    // The push itself, as its own row. Category is free text on this table, so
    // this needs no migration; keeping it separate from 'Felt' means the weekly
    // tally and the pain counters are untouched by it.
    if (ex.pushed) {
      obsRows.push({
        workout_id: workoutId,
        category: 'Probe',
        signal: `${ex.name} — pushed past the cap deliberately${ex.felt ? `, felt ${ex.felt}` : ''}`,
        severity: sev,
      })
    }
  }
  if (reflection) obsRows.push({ workout_id: workoutId, category: 'Reflection', signal: reflection, severity: 1 })
  if (readingAnswer && reading) {
    obsRows.push({ workout_id: workoutId, category: 'Reading', signal: `${reading.name} — ${readingAnswer}`, severity: 2 })
  }
  if (obsRows.length) await supabase.from('session_observation').insert(obsRows)

  // 6. Execute each insight action; pick the most-moved for the reveal.
  interface Move {
    movedInsightId: string | null
    category: string
    previousConfidence: number | null
    newConfidence: number | null
    isNew: boolean
    delta: number
  }
  const moves: Move[] = []
  for (const action of debrief.actions) {
    if (action.action === 'update' && action.existingInsightId) {
      const updatePayload: Record<string, unknown> = {
        confidence: action.updatedConfidence,
        evidence:   action.updatedEvidence,
      }
      if (action.updatedStatus) {
        updatePayload.status = action.updatedStatus
        // A read that just retired needs its resolved_at, same as one retired by
        // the session-adaptation path — otherwise "when did this clear?" has no
        // answer and the history reads as if it were never a limiter at all.
        if (action.updatedStatus === 'resolved') updatePayload.resolved_at = new Date().toISOString()
      }
      await supabase.from('insight').update(updatePayload).eq('id', action.existingInsightId)

      const prior = ((existingInsights as InsightRow[]) ?? []).find((i) => i.id === action.existingInsightId)
      moves.push({
        movedInsightId: action.existingInsightId,
        category: action.insightCategory,
        previousConfidence: prior?.confidence ?? null,
        newConfidence: action.updatedConfidence,
        isNew: false,
        delta: (action.updatedConfidence ?? 0) - (prior?.confidence ?? 0),
      })
    } else if (action.action === 'create' && action.newInsight) {
      const { data: created } = await supabase.from('insight').insert(action.newInsight).select().single()
      if (created) {
        moves.push({
          movedInsightId: (created as InsightRow).id,
          category: action.insightCategory,
          previousConfidence: null,
          newConfidence: (created as InsightRow).confidence,
          isNew: true,
          delta: 0.0001,
        })
      }
    }
  }
  const best = moves.length ? moves.reduce((a, b) => (b.delta > a.delta ? b : a)) : null

  // 7. The living loop: read this session as evidence on the P1 weak link.
  //    Best-effort — a committed session must never hang on this. Skipped on an
  //    edit so a correction doesn't append a duplicate adaptation note.
  //
  //    The clearance test runs FIRST and, when it has something to say, it speaks
  //    instead of the generic adaptation note: both read the same session against
  //    the same limiter, and the athlete should hear the specific answer ("one
  //    more session like that and the cap comes off") rather than two overlapping
  //    ones. The test is also the only one of the two that can be argued FOR the
  //    limiter, which is what makes it a test rather than a countdown.
  if (!p.editWorkoutId) {
    let clearanceSpoke = false
    try {
      clearanceSpoke = (await evaluateClearanceTest(p.athleteId, workoutId)) !== null
    } catch (e) {
      console.error('[loop] clearance test failed', e)
    }
    if (!clearanceSpoke) {
      try {
        await recordSessionAdaptation(p.athleteId, workoutId)
      } catch (e) {
        console.error('[loop] session adaptation failed', e)
      }
    }
  }

  return {
    workoutId,
    summary: debrief.summary,
    movedCount: debrief.actions.length,
    best: best
      ? {
          movedInsightId: best.movedInsightId,
          category: best.category,
          previousConfidence: best.previousConfidence,
          newConfidence: best.newConfidence,
          isNew: best.isNew,
        }
      : null,
    setsDone: p.setsDone,
    durationMins: p.durationMins,
    athleteName: p.athleteName,
    firstSession,
  }
  } catch (e) {
    // The workout is saved; the read just didn't move this time. Never rethrow —
    // returning cleanly lets the outbox dequeue (no duplicate on retry).
    console.error('[commit] post-write step failed; workout is logged', e)
    return loggedOnly
  }
}

// ---- Weekly recap (the end-of-week review surface) -------------------------
// The weekly_review row already holds the directive + tally (runWeeklyReviewAgent
// writes it at rollover). This assembles the full recap around it: the sessions
// actually logged that week and the reads that moved — everything the athlete
// wants to see when the week closes.

// The set predicate lives in volume.ts now — one definition, shared with the
// logger, so "12 sets" means the same thing on every screen that says it.
const isSetDone = isSetLogged

export interface RecapSessionHighlight { name: string; set: SetLog }
export interface RecapSession {
  workoutId: string
  routineName: string
  performedAt: string
  setsDone: number
  rpe: number | null
  /**
   * Load moved this session (Σ weight × reps), in STORAGE units. OPTIONAL
   * because a device holds cached views written by earlier builds: a required
   * field here is a white screen on the first launch after an update, for
   * exactly the athletes with the most history. Read with `?.`.
   */
  volume?: VolumeTally
  highlights: RecapSessionHighlight[]   // top set of the first few exercises
}
export interface RecapMovement {
  id: string
  category: string
  claim: string
  status: InsightStatus
  prevStatus: InsightStatus | null
  confidence: number
}
export interface WeeklyRecap {
  review: WeeklyReviewRow
  weekStart: string   // ISO date (Monday)
  weekEnd: string     // ISO date (Sunday) — review.week_ending
  planned: number     // sessions/week target, for the done/planned stat
  totalSets: number
  /** The week's load moved. Absent on caches written before this field existed. */
  totalVolume?: VolumeTally
  sessions: RecapSession[]
  movements: RecapMovement[]
}

/**
 * Assemble the recap for a given review (or the most recent one). Pulls the
 * sessions logged in that Mon–Sun window (with each routine's top sets) and the
 * insights that moved that week, alongside the stored review/directive.
 */
export async function gatherWeeklyRecap(athleteId: string, reviewId?: string): Promise<WeeklyRecap | null> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return null

  let reviewRow: WeeklyReviewRow | null = null
  if (reviewId) {
    const { data } = await supabase.from('weekly_review').select('*').eq('id', reviewId).maybeSingle()
    reviewRow = (data as WeeklyReviewRow | null) ?? null
  } else {
    const { data } = await supabase
      .from('weekly_review').select('*')
      .eq('program_id', prog.id)
      .order('week_ending', { ascending: false })
      .limit(1).maybeSingle()
    reviewRow = (data as WeeklyReviewRow | null) ?? null
  }
  if (!reviewRow) return null

  // The week window: Monday 00:00 → Sunday 23:59 around week_ending.
  const sunday = new Date(`${reviewRow.week_ending}T23:59:59`)
  const monday = startOfWeekMonday(sunday)
  const mondayStart = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate())

  const [{ data: ws }, { data: ins }, { data: ath }] = await Promise.all([
    supabase
      .from('workout')
      .select('id, performed_at, rpe, actual_weights, exercises_snapshot, routine!inner(name, exercises, program_id)')
      .eq('routine.program_id', prog.id)
      .gte('performed_at', mondayStart.toISOString())
      .lte('performed_at', sunday.toISOString())
      .order('performed_at', { ascending: true }),
    supabase
      .from('insight').select('*')
      .eq('athlete_id', athleteId)
      .gte('updated_at', mondayStart.toISOString())
      .lte('updated_at', sunday.toISOString()),
    supabase.from('athlete').select('sessions_per_week').eq('id', athleteId).maybeSingle(),
  ])
  const planned = ((ath as { sessions_per_week: number | null } | null)?.sessions_per_week) ?? 3

  const sessions: RecapSession[] = ((ws ?? []) as unknown as Array<LoggedWorkoutLike & {
    id: string; performed_at: string; rpe: number | null
    routine: { name: string; exercises: ExerciseTemplate[] }
  }>).map((w) => {
    const volume = tallySession(w.actual_weights)
    const highlights: RecapSessionHighlight[] = []
    for (const { name, sets } of readLoggedExercises(w)) {
      const top = topWorkingSet(sets)
      if (top) highlights.push({ name, set: top })
      if (highlights.length >= 3) break
    }
    return {
      workoutId: w.id,
      routineName: w.routine.name,
      performedAt: w.performed_at,
      setsDone: volume.loggedSets,
      rpe: w.rpe,
      volume,
      highlights,
    }
  })

  const movements: RecapMovement[] = ((ins ?? []) as InsightRow[])
    .map((i) => ({
      id: i.id,
      category: i.category,
      claim: i.claim,
      status: i.status,
      prevStatus: i.prev_status,
      confidence: i.confidence,
    }))
    // Surface the meaningful ones first: a status transition, then by confidence.
    .sort((a, b) => Number(!!b.prevStatus) - Number(!!a.prevStatus) || b.confidence - a.confidence)

  const totalSets = sessions.reduce((a, s) => a + s.setsDone, 0)
  const totalVolume = sumVolume(sessions.map((s) => s.volume ?? NO_VOLUME))

  return {
    review: reviewRow,
    weekStart: isoDate(mondayStart),
    weekEnd: reviewRow.week_ending,
    planned,
    totalSets,
    totalVolume,
    sessions,
    movements,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE TRAINING LOG — every session you've logged, newest first, bucketed by the
// Mon–Sun week it fell in. Pure read over `workout`, folding in the outbox so a
// session finished seconds ago (not yet committed) never looks lost. The backward
// half of the program timeline; the forward half is the program map.
// ════════════════════════════════════════════════════════════════════════════

export interface LogSession {
  workoutId: string                    // committed id, or `pending:<id>` for an uncommitted one
  routineId: string
  routineName: string
  phaseName: string | null
  performedAt: string
  setsDone: number
  rpe: number | null
  /** Load moved this session, in STORAGE units. Absent on older caches. */
  volume?: VolumeTally
  pending: boolean                     // finished offline, not yet synced
  highlights: RecapSessionHighlight[]  // top set of the first few exercises
}
export interface LogWeek {
  weekStart: string   // ISO Monday
  weekEnding: string  // ISO Sunday
  totalSets: number
  /** Absent on caches written before this field existed. */
  totalVolume?: VolumeTally
  sessions: LogSession[]  // newest first within the week
}
export interface TrainingLog {
  weeks: LogWeek[]    // newest week first
}

function topHighlights(w: LoggedWorkoutLike): RecapSessionHighlight[] {
  const out: RecapSessionHighlight[] = []
  for (const { name, sets } of readLoggedExercises(w)) {
    const top = topWorkingSet(sets)
    if (top) out.push({ name, set: top })
    if (out.length >= 3) break
  }
  return out
}

// ---- One logged session, as performed --------------------------------------
// What a finished session ACTUALLY was: the set logs, keyed by exercise index so
// they line up with the routine's template, plus the session-level numbers. This
// is what any "what did I do" surface reads — a preview of a done session must
// show what was logged, not what was prescribed.

export interface SessionActuals {
  workoutId: string | null   // null while the session is still only in the outbox
  performedAt: string
  durationMins: number | null
  rpe: number | null
  setLogs: Record<number, SetLog[]>
  /**
   * The prescription this session was logged against. setLogs is indexed into
   * THIS, not the routine's live list — "what you logged" has to show the
   * movements you actually did, even if the program has been reshaped since.
   * Null for sessions logged before snapshots shipped; render the routine then.
   */
  exercisesSnapshot: ExerciseTemplate[] | null
  /** The session's check-in. Absent on caches written before it existed. */
  checkin?: SessionCheckinInput | null
}

/** Count the sets in an actuals grid that carry real signal. */
export function countLoggedSets(setLogs: Record<number, SetLog[]>): number {
  return Object.values(setLogs).flat().filter(isSetDone).length
}

/** The as-performed view of a queued (not yet committed) session. No network. */
export function actualsFromPending(p: PendingSession | null): SessionActuals | null {
  if (!p) return null
  const setLogs: Record<number, SetLog[]> = {}
  Object.entries(p.actualWeights ?? {}).forEach(([k, v]) => { setLogs[Number(k)] = v })
  return {
    workoutId: null,
    performedAt: p.performedAt ?? p.queuedAt,
    durationMins: p.durationMins,
    rpe: p.rpe,
    setLogs,
    exercisesSnapshot: p.exercisesSnapshot ?? null,
    checkin: p.checkin ?? null,
  }
}

/**
 * A logged session's check-in, read on its own so a database still missing the
 * columns costs the check-in and nothing else.
 */
export async function gatherSessionCheckin(workoutId: string): Promise<SessionCheckinInput | null> {
  const { data, error } = await supabase
    .from('workout').select('knee_pain_l, knee_pain_r, sleep_hours, readiness, bodyweight')
    .eq('id', workoutId).maybeSingle()
  if (error || !data) return null
  const r = data as Record<string, number | string | null>
  const n = (v: number | string | null) => (v == null || v === '' ? null : Number(v))
  const c: SessionCheckinInput = {
    kneePainL: n(r.knee_pain_l), kneePainR: n(r.knee_pain_r),
    sleepHours: n(r.sleep_hours), readiness: n(r.readiness), bodyweight: n(r.bodyweight),
  }
  return hasCheckin(c) ? c : null
}

/** The as-performed view of a committed session. */
export async function gatherSessionActuals(workoutId: string): Promise<SessionActuals | null> {
  const { data } = await supabase
    .from('workout')
    .select('id, performed_at, duration_mins, rpe, actual_weights, exercises_snapshot')
    .eq('id', workoutId)
    .maybeSingle()
  if (!data) return null
  const w = data as {
    id: string; performed_at: string; duration_mins: number | null
    rpe: number | null; actual_weights: Record<string, SetLog[]> | null
    exercises_snapshot: ExerciseTemplate[] | null
  }
  const setLogs: Record<number, SetLog[]> = {}
  Object.entries(w.actual_weights ?? {}).forEach(([k, v]) => { setLogs[Number(k)] = v })
  return {
    workoutId: w.id,
    performedAt: w.performed_at,
    durationMins: w.duration_mins,
    rpe: w.rpe,
    setLogs,
    exercisesSnapshot: Array.isArray(w.exercises_snapshot) && w.exercises_snapshot.length
      ? w.exercises_snapshot
      : null,
  }
}

/**
 * The full training history for the active program, newest first, grouped by
 * week. `pending` is the raw outbox (pass pendingSessionsRaw()); those sessions
 * are prepended unless a committed session already covers the same routine + day.
 */
export async function gatherTrainingLog(
  athleteId: string,
  pending: PendingSession[] = [],
  limit = 150,
): Promise<TrainingLog> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return { weeks: [] }

  const { data: ws } = await supabase
    .from('workout')
    .select('id, routine_id, performed_at, rpe, actual_weights, exercises_snapshot, routine!inner(name, exercises, program_id)')
    .eq('routine.program_id', prog.id)
    .order('performed_at', { ascending: false })
    .limit(limit)

  type Row = LoggedWorkoutLike & {
    id: string; routine_id: string; performed_at: string; rpe: number | null
    routine: { name: string; exercises: ExerciseTemplate[] }
  }
  const committed: LogSession[] = ((ws ?? []) as unknown as Row[]).map((w) => {
    const volume = tallySession(w.actual_weights)
    return {
      workoutId: w.id,
      routineId: w.routine_id,
      routineName: w.routine?.name ?? 'Session',
      phaseName: null,  // reserved for the program timeline (Phase 3); not needed for the week-grouped log
      performedAt: w.performed_at,
      setsDone: volume.loggedSets,
      rpe: w.rpe,
      volume,
      pending: false,
      highlights: topHighlights(w),
    }
  })

  // Fold in finished-but-uncommitted sessions. Resolve their routine names in one
  // query; skip any whose routine + calendar day a committed session already owns.
  const committedDayKeys = new Set(committed.map((s) => `${s.routineId}|${isoDate(new Date(s.performedAt))}`))
  // Dedupe on the day the session HAPPENED. Keying on queuedAt filed a backdated
  // session under the day it was typed in, so it both escaped the dedupe against
  // its own committed row and landed in the wrong week of the log.
  const freshPending = pending.filter(
    (p) => !committedDayKeys.has(`${p.routineId}|${isoDate(new Date(p.performedAt ?? p.queuedAt))}`),
  )
  let pendingSessions: LogSession[] = []
  if (freshPending.length) {
    const { data: routineRows } = await supabase
      .from('routine')
      .select('id, name, exercises')
      .in('id', [...new Set(freshPending.map((p) => p.routineId))])
    const byId = new Map(
      ((routineRows ?? []) as unknown as Array<{ id: string; name: string; exercises: ExerciseTemplate[] }>)
        .map((r) => [r.id, r]),
    )
    pendingSessions = freshPending.map((p) => {
      const r = byId.get(p.routineId)
      const volume = tallySession(p.actualWeights)
      return {
        workoutId: `pending:${p.id}`,
        routineId: p.routineId,
        routineName: r?.name ?? 'Session',
        phaseName: null,
        // A backdated session belongs on the day it HAPPENED, not the moment it
        // was queued — the same day the week strip already counts it on.
        performedAt: p.performedAt ?? p.queuedAt,
        setsDone: volume.loggedSets,
        rpe: p.rpe,
        volume,
        pending: true,
        // A queued session carries the prescription it was logged against, so a
        // program edit while it sits in the outbox can't relabel it either.
        highlights: topHighlights({
          actual_weights: p.actualWeights,
          exercises_snapshot: p.exercisesSnapshot ?? null,
          routine: { exercises: r?.exercises ?? [] },
        }),
      }
    })
  }

  const all = [...pendingSessions, ...committed].sort((a, b) => b.performedAt.localeCompare(a.performedAt))

  // Bucket by week-ending Sunday.
  const weeks = new Map<string, LogWeek>()
  for (const s of all) {
    const monday = startOfWeekMonday(new Date(s.performedAt))
    const weekEnding = weekEndingISO(monday)
    let wk = weeks.get(weekEnding)
    if (!wk) {
      wk = { weekStart: isoDate(monday), weekEnding, totalSets: 0, totalVolume: { load: 0, loadedSets: 0, loggedSets: 0, reps: 0 }, sessions: [] }
      weeks.set(weekEnding, wk)
    }
    wk.sessions.push(s)
    wk.totalSets += s.setsDone
    wk.totalVolume = sumVolume([wk.totalVolume ?? NO_VOLUME, s.volume ?? NO_VOLUME])
  }

  return { weeks: [...weeks.values()].sort((a, b) => b.weekEnding.localeCompare(a.weekEnding)) }
}

// ---- Per-exercise progression (the lift trend) -----------------------------

export interface ExercisePoint {
  performedAt: string
  topWeight: number | null   // display unit
  topReps: number | null
  e1rm: number | null        // display unit; Epley, exact at one rep
  rpe: number | null
  /** Which records this session broke, if any. Absent on older caches. */
  prs?: PrKind[]
  /** False above ~12 reps, where an e1RM stops being a strength number. */
  e1rmReliable?: boolean
}
export interface ExerciseHistory {
  name: string
  points: ExercisePoint[]   // oldest → newest
  bestWeight: number | null // display unit
  bestE1rm: number | null   // display unit
  /** How many sessions on this lift set a record. Absent on older caches. */
  prCount?: number
}

/**
 * Every logged top set for one exercise (matched by name across all routines in
 * the active program), oldest → newest, with an e1RM trend and — the point of
 * the rewrite — a PR marker on each session that actually beat something.
 *
 * The running best is folded forward as the sessions are walked, so a marker
 * means "this was a record ON THE DAY", not "this ties the all-time best". The
 * numbers come back in the athlete's DISPLAY unit; the comparison happens in
 * storage units, before any rounding, so a conversion can never invent or erase
 * a record.
 */
export async function gatherExerciseHistory(
  athleteId: string, exerciseName: string, u: UnitContext,
): Promise<ExerciseHistory> {
  const empty: ExerciseHistory = { name: exerciseName, points: [], bestWeight: null, bestE1rm: null, prCount: 0 }
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return empty

  const { data: ws } = await supabase
    .from('workout')
    .select('performed_at, rpe, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)')
    .eq('routine.program_id', prog.id)
    .order('performed_at', { ascending: true })

  type Row = LoggedWorkoutLike & { performed_at: string; rpe: number | null }
  const points: ExercisePoint[] = []
  let running: LiftBest = NO_BEST
  for (const w of (ws ?? []) as unknown as Row[]) {
    for (const { name, sets } of readLoggedExercises(w)) {
      if (name !== exerciseName) continue
      const top = topWorkingSet(sets)
      if (!top) continue
      const prs = displayPRs(top, running)
      running = foldBest(running, top)
      const e1rm = top.weight != null && top.reps != null ? estimate1RM(top.weight, top.reps) : null
      points.push({
        performedAt: w.performed_at,
        topWeight: top.weight != null ? u.show(top.weight) : null,
        topReps: top.reps ?? null,
        e1rm: e1rm != null ? u.show(e1rm) : null,
        rpe: top.rpe ?? w.rpe,
        prs,
        e1rmReliable: estimateIsReliable(top.reps),
      })
      break // one entry (the top set) per session
    }
  }

  return {
    name: exerciseName,
    points,
    bestWeight: running.weight != null ? u.show(running.weight) : null,
    bestE1rm: running.e1rm != null ? u.show(running.e1rm) : null,
    prCount: points.filter((p) => (p.prs?.length ?? 0) > 0).length,
  }
}

/**
 * The athlete's standing record on every lift in the program, keyed by name —
 * what a live set has to beat. One scan, shared by the workout screen (the PR
 * chip) and anything else that needs "have they ever done better than this".
 * Weights are in STORAGE units, like every other stored number.
 */
export async function gatherExerciseBests(programId: string): Promise<Record<string, LiftBest>> {
  const { data: ws } = await supabase
    .from('workout')
    .select('performed_at, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)')
    .eq('routine.program_id', programId)
    .order('performed_at', { ascending: true })
    .limit(400)
  const out: Record<string, LiftBest> = {}
  for (const w of (ws ?? []) as unknown as LoggedWorkoutLike[]) {
    for (const { name, sets } of readLoggedExercises(w)) {
      let best = out[name] ?? NO_BEST
      for (const s of sets) best = foldBest(best, s)
      out[name] = best
    }
  }
  return out
}

/**
 * The most recent session's sets on every lift in the program, keyed by name —
 * the "last time" for a movement that isn't in this routine's own history. A
 * swap is exactly that case: the dumbbell row you did at the other gym last
 * month is the number to beat today, wherever in the program it was logged.
 * Weights are in STORAGE units.
 */
export async function gatherLastSetsByName(programId: string): Promise<Record<string, SetLog[]>> {
  const { data: ws } = await supabase
    .from('workout')
    .select('performed_at, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)')
    .eq('routine.program_id', programId)
    .order('performed_at', { ascending: false })
    .limit(120)
  const out: Record<string, SetLog[]> = {}
  for (const w of (ws ?? []) as unknown as LoggedWorkoutLike[]) {
    for (const { name, sets } of readLoggedExercises(w)) {
      if (out[name]) continue   // newest wins (rows are desc)
      if (sets.some(isSetLogged)) out[name] = sets
    }
  }
  return out
}

/**
 * The athlete's strength balance — which chain is behind, read off their own log.
 *
 * Built on the same baseline the retest reads, so the two can never disagree
 * about what the athlete lifts.
 */
export async function gatherBalance(athleteId: string): Promise<BalanceRead> {
  const lifts = await gatherStrengthBaseline(athleteId)
  return readBalance(
    lifts
      .filter((l) => l.e1rm != null && l.e1rm > 0)
      .map((l) => ({ slot: l.slot, lift: l.name, e1rm: l.e1rm! })),
  )
}

// ---- Block volume (the chart on Program) -----------------------------------

export interface BlockVolumeWeek {
  weekStart: string      // ISO Monday
  weekEnding: string     // ISO Sunday
  load: number           // Σ weight × reps, STORAGE units
  sessions: number
  directive: WeeklyDirective | null   // the call that produced the NEXT week
  isCurrent: boolean
}
export interface BlockVolume {
  phaseName: string | null
  weeks: BlockVolumeWeek[]   // oldest → newest
  best: number               // the tallest bar, so the chart can scale
}

/**
 * Load moved per week across the current block, with the directive that was
 * standing over each week.
 *
 * This is the app explaining itself: the volume line and the PROGRESS / HOLD /
 * DELOAD calls are the same story told twice, and until the volume existed there
 * was no way to see whether the calls were working. Weeks with no logged work
 * are kept as zero rather than skipped — a gap in a block is information, and
 * dropping it would draw a continuous climb over a fortnight off.
 */
export async function gatherBlockVolume(athleteId: string): Promise<BlockVolume | null> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return null

  const [{ data: phaseRow }, { data: reviewRows }, log] = await Promise.all([
    supabase.from('phase').select('name, week_start, week_end')
      .eq('program_id', prog.id).eq('status', 'active').maybeSingle(),
    supabase.from('weekly_review').select('week_ending, next_week_prescription')
      .eq('program_id', prog.id).order('week_ending', { ascending: true }),
    gatherTrainingLog(athleteId, [], 200),
  ])
  const phase = phaseRow as { name: string; week_start: string; week_end: string } | null
  if (!phase) return null

  const directiveByWeek = new Map<string, WeeklyDirective>()
  for (const r of (reviewRows ?? []) as Array<{ week_ending: string; next_week_prescription: WeeklyPrescription | null }>) {
    if (r.next_week_prescription?.directive) directiveByWeek.set(r.week_ending, r.next_week_prescription.directive)
  }
  const loggedByWeek = new Map(log.weeks.map((w) => [w.weekEnding, w]))

  // Walk the block's Mondays rather than the weeks that happen to have logs, so
  // a skipped week draws as a zero instead of vanishing from the axis.
  const thisMonday = startOfWeekMonday(new Date())
  const weeks: BlockVolumeWeek[] = []
  let cursor = startOfWeekMonday(new Date(`${phase.week_start}T12:00:00`))
  const end = new Date(`${phase.week_end}T23:59:59`)
  for (let guard = 0; guard < 26 && cursor <= end; guard++) {
    const weekEnding = weekEndingISO(cursor)
    const wk = loggedByWeek.get(weekEnding)
    weeks.push({
      weekStart: isoDate(cursor),
      weekEnding,
      load: wk?.totalVolume?.load ?? 0,
      sessions: wk?.sessions.length ?? 0,
      directive: directiveByWeek.get(weekEnding) ?? null,
      isCurrent: isoDate(cursor) === isoDate(thisMonday),
    })
    // Never past today: a block runs four weeks and three of them may not have
    // happened yet. An empty bar for a week in the future is a lie about a week
    // that hasn't been trained.
    if (cursor >= thisMonday) break
    const next = new Date(cursor)
    next.setDate(next.getDate() + 7)
    cursor = next
  }

  return {
    phaseName: phase.name,
    weeks,
    best: weeks.reduce((m, w) => Math.max(m, w.load), 0),
  }
}

/**
 * What the most recent retest found, for the block it is about to design.
 *
 * A re-scope is triggered BY a retest and knew nothing about it: the designer
 * saw the athlete's logged lifts, which it always sees, but not that a movement
 * pattern had just cleared or that a lift measured 28 days apart came back flat.
 * Those two are the findings most likely to change what the next block should
 * be, and they were being computed and thrown away.
 *
 * Null when there is nothing to say — a single diagnostic, or no active program.
 */
export async function gatherRetestFindings(athleteId: string): Promise<RetestFindings | null> {
  const { data: diagRows } = await supabase
    .from('diagnostic').select('version, raw_results')
    .eq('athlete_id', athleteId)
    .order('version', { ascending: false })
    .limit(2)
  const diags = (diagRows ?? []) as Array<{ version: number; raw_results: DiagnosticResults | null }>
  if (diags.length < 2) return null
  const [current, prior] = diags
  if (!current.raw_results) return null

  const movement_gains: string[] = []
  const baseMove = prior.raw_results?.movement ?? {}
  for (const p of MOVEMENT_PATTERNS) {
    const from = baseMove[p.key]
    const to = current.raw_results.movement?.[p.key]
    if (from != null && to != null && to > from) movement_gains.push(`${p.label} ${from}→${to}`)
  }

  // Weak links this retest retired. resolved_at is stamped by runRetest, so the
  // window is "since the previous diagnostic" — near enough, and it never
  // reports a read that cleared for some other reason months ago.
  const { data: resolvedRows } = await supabase
    .from('insight').select('category, claim, resolved_at')
    .eq('athlete_id', athleteId).eq('status', 'resolved')
    .order('resolved_at', { ascending: false }).limit(5)
  const cleared = ((resolvedRows ?? []) as Array<{ category: string; claim: string }>)
    .map((i) => i.category)

  const stronger = strengthDeltas(prior.raw_results?.strength, current.raw_results.strength)
    .map((d) => `${d.name} ${d.from}→${d.to} (+${d.pct}%)`)
  const stalled = strengthStalls(prior.raw_results?.strength, current.raw_results.strength)

  if (!movement_gains.length && !cleared.length && !stronger.length && !stalled.length) return null
  return { version: current.version, movement_gains, cleared, stronger, stalled }
}

/**
 * The athlete's strength baseline, READ OFF THEIR LOG rather than asked for.
 *
 * The retest's strength half used to be a fixed battery of four estimated 1RMs
 * on four generic patterns — cumbersome (an estimated max on a lift you train
 * for fives means going and testing something), ambiguous ("Press" is not a
 * lift), and inert (only two of the five fields were ever read, and no strength
 * number was ever compared across versions, so the retest could not tell you
 * your squat had gone up).
 *
 * Every top set the athlete has logged is already a test. This returns the lifts
 * they actually train, with the best estimate their own log supports, and what
 * the last retest recorded for the same lift — so the step becomes "confirm or
 * correct" instead of "go and do four more exercises".
 *
 * Empty when there's no loaded history to read (a brand-new athlete), which is
 * the caller's signal to fall back to asking.
 */
export async function gatherStrengthBaseline(athleteId: string): Promise<BaselineLift[]> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return []

  const [{ data: routineRows }, bests, { data: priorDiag }] = await Promise.all([
    supabase.from('routine').select('exercises').eq('program_id', prog.id),
    gatherExerciseBests(prog.id),
    supabase
      .from('diagnostic').select('raw_results')
      .eq('athlete_id', athleteId).order('version', { ascending: false })
      .limit(1).maybeSingle(),
  ])

  // Program order, so the lifts the block is actually built on come first.
  const names: string[] = []
  for (const r of (routineRows ?? []) as Array<{ exercises: ExerciseTemplate[] | null }>) {
    for (const ex of r.exercises ?? []) names.push(ex.name)
  }

  const previous = namedLifts(
    ((priorDiag as { raw_results: DiagnosticResults | null } | null)?.raw_results?.strength) ?? undefined,
  )
  return buildBaseline(names, bests, previous)
}

// ════════════════════════════════════════════════════════════════════════════
// THE PROGRAM MAP — the forward half of the timeline. The phase arc with what
// graduates you, the current phase's sessions, the next-week PROJECTION (the
// standing prescription read forward — provisional until the week closes), and
// the road ahead (future phases as concept cards, since their routine rows don't
// exist until advancement generates them — fidelity decays with distance).
// ════════════════════════════════════════════════════════════════════════════

export interface MapPhase {
  name: PhaseName
  state: 'done' | 'current' | 'upcoming'
  goal: string | null
  gate: string[]   // advancement_criteria — what graduates you out of it
}
export interface ProjectedSession {
  routineId: string
  routineName: string
  intent: string | null
  lines: Array<{ name: string; hint: string; held: boolean }>  // per-exercise projected load
}
export interface NextWeekProjection {
  directive: WeeklyDirective | null
  loadDeltaPct: number
  rpeTarget: number | null
  rationale: string | null
  provisional: boolean   // true until the week is closed (check-in or Sunday rollover)
  sessions: ProjectedSession[]
}
export interface ProgramMap {
  phases: MapPhase[]
  currentPhaseName: PhaseName
  nextWeek: NextWeekProjection | null   // null until there's a standing prescription to read forward
}

/**
 * The forward program map. Real data for the active phase; the prescription read
 * forward for next week (provisional); and canonical concept previews for the
 * phases after this one (generatePhase is pure — no rows are written).
 */
export async function gatherProgramMap(athleteId: string, u: UnitContext): Promise<ProgramMap | null> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return null

  const [{ data: activePhase }, { data: insightRows }, { data: review }] = await Promise.all([
    supabase.from('phase').select('id, name, advancement_criteria, status').eq('program_id', prog.id).eq('status', 'active').maybeSingle(),
    supabase.from('insight').select('id, category, status, priority').eq('athlete_id', athleteId).order('priority'),
    supabase.from('weekly_review').select('next_week_prescription, week_ending').eq('program_id', prog.id).order('week_ending', { ascending: false }).limit(1).maybeSingle(),
  ])

  const currentName = ((activePhase as { name: PhaseName } | null)?.name ?? 'Stability') as PhaseName
  const currentIdx = Math.max(0, PHASE_SEQUENCE.indexOf(currentName))
  const p1Category = ((insightRows ?? []) as Array<{ category: string; status: string }>)
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')[0]?.category ?? 'Lower Chain'

  // The arc: completed phases done, the active one current, the rest previewed
  // from the canonical blueprint (generatePhase is pure — no writes).
  const today = isoDate(new Date())
  const phases: MapPhase[] = PHASE_SEQUENCE.map((name, i) => {
    if (i < currentIdx) return { name, state: 'done', goal: null, gate: [] }
    if (i === currentIdx) {
      return {
        name,
        state: 'current',
        goal: null,
        gate: ((activePhase as { advancement_criteria: string[] | null } | null)?.advancement_criteria) ?? [],
      }
    }
    const plan = generatePhase(name, p1Category, today)
    return { name, state: 'upcoming', goal: plan.goal, gate: plan.phase.advancement_criteria }
  })

  // Next-week projection — the standing prescription read forward over the active
  // phase's sessions. Provisional until THIS week is closed (the check-in or the
  // Sunday backstop cuts a review for the current week_ending → finalized).
  const currentWeekEnding = weekEndingISO(startOfWeekMonday(new Date()))
  const weekClosed = (review?.week_ending as string | undefined) === currentWeekEnding
  let nextWeek: NextWeekProjection | null = null
  const presc = (review?.next_week_prescription as WeeklyPrescription | null) ?? null
  const { data: routineRows } = activePhase
    ? await supabase.from('routine').select('id, name, exercises, intent').eq('phase_id', (activePhase as { id: string }).id).order('name')
    : { data: null }
  const routines = (routineRows ?? []) as unknown as Array<{ id: string; name: string; exercises: ExerciseTemplate[]; intent: string | null }>

  if (routines.length) {
    const sessions: ProjectedSession[] = []
    for (const r of routines) {
      const rx = await gatherSessionPrescription(athleteId, r.id, r.exercises, u)
      const lines = r.exercises
        .map((ex, i) => ({ name: ex.name, hint: rx.hints[i] ?? '', held: !!rx.held[i] }))
        .filter((l) => l.hint)
        .slice(0, 4)
      sessions.push({ routineId: r.id, routineName: r.name, intent: r.intent, lines })
    }
    nextWeek = {
      directive: presc?.directive ?? null,
      loadDeltaPct: presc?.load_delta_pct ?? 0,
      rpeTarget: presc?.rpe_target ?? null,
      rationale: presc?.rationale ?? null,
      provisional: !weekClosed,
      sessions,
    }
  }

  return { phases, currentPhaseName: currentName, nextWeek }
}

// ════════════════════════════════════════════════════════════════════════════
// THE WEEK PAGER — arrow ← / → through the program a week at a time. Past weeks
// are real (what you logged); the current week is rendered live by the Train
// screen; future weeks are PROJECTED — same phase sessions with loads compounded
// forward at the phase's natural rate. Honest by construction: forward loads only
// appear where there's a logged base, and projection stops at the phase edge.
// ════════════════════════════════════════════════════════════════════════════

export interface PagerExLine { name: string; detail: string }
export interface PagerSessionView {
  routineId: string
  routineName: string
  intent: string | null
  tag: string | null              // past: "Fri · 5 sets · RPE 7"; future: null
  lines: PagerExLine[]
}
export interface PagerWeekView {
  weekStart: string
  weekEnd: string
  phaseName: string | null
  sessions: PagerSessionView[]
  /** Coach call for this projected week (week+1 after close, or dry-run when the current week is logged out). */
  directive?: WeeklyDirective | null
  rationale?: string | null
  provisional?: boolean
}
export interface WeekPagerData {
  past: PagerWeekView[]    // chronological (oldest first); excludes the current week
  future: PagerWeekView[]  // week+1, week+2, … to the phase edge
  boundary: { phaseName: PhaseName; goal: string | null; gate: string[] } | null
  /** Routines to actually train in week+1 (active or queued). Startable, not a projection-only view. */
  upcoming: {
    weekStart: string
    weekEnd: string
    phaseName: string | null
    fromQueued: boolean
    routines: Array<{
      id: string
      name: string
      exercises: ExerciseTemplate[]
      intent: string | null
      intended_dow: number | null
      session_type: string | null
    }>
  } | null
}

// How fast load is assumed to climb per week WITHIN a phase, for the forward
// projection ("if you keep earning load at this phase's rate"). Stability banks
// load (flat); Sport holds; Strength/Power climb. The engine still re-decides
// each real week — this is a labelled projection, not a commitment.
const PHASE_WEEKLY_STEP_PCT: Record<PhaseName, number> = {
  Stability: 0, Strength: 3, Power: 2, Sport: 0,
}

export async function gatherWeekPager(athleteId: string, u: UnitContext): Promise<WeekPagerData | null> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return null

  const thisWin = weekWindowInZone(new Date())
  const thisMondayISO = thisWin.weekStart
  const thisWeekEnding = thisWin.weekEnd

  // ---- PAST: real logged weeks (reuse the training log), minus the current week.
  const log = await gatherTrainingLog(athleteId, [], 200)
  const past: PagerWeekView[] = log.weeks
    .filter((wk) => wk.weekEnding < thisWeekEnding)
    .map((wk) => ({
      weekStart: wk.weekStart,
      weekEnd: wk.weekEnding,
      phaseName: null,
      sessions: wk.sessions.map((s) => ({
        routineId: s.routineId,
        routineName: s.routineName,
        intent: null,
        tag: `${new Date(s.performedAt).toLocaleDateString(undefined, { weekday: 'short' })} · ${s.setsDone} set${s.setsDone === 1 ? '' : 's'}${s.rpe != null ? ` · RPE ${s.rpe}` : ''}`,
        lines: s.highlights.map((h) => ({ name: h.name, detail: fmtSetDetail(h.set, u) })),
      })),
    }))
    .sort((a, b) => a.weekEnd.localeCompare(b.weekEnd))   // oldest first

  // ---- FUTURE: project remaining weeks. Week+1 is always present so Sunday
  // can open the upcoming week; a queued block supplies that week's sessions.
  const [{ data: activePhase }, { data: queuedPhase }] = await Promise.all([
    supabase.from('phase').select('id, name, week_end, advancement_criteria').eq('program_id', prog.id).eq('status', 'active').maybeSingle(),
    supabase.from('phase').select('id, name, week_start, week_end').eq('program_id', prog.id).eq('status', 'pending').order('week_start').limit(1).maybeSingle(),
  ])
  const future: PagerWeekView[] = []
  let boundary: WeekPagerData['boundary'] = null
  let upcoming: WeekPagerData['upcoming'] = null

  type PagerRoutine = {
    id: string; name: string; exercises: ExerciseTemplate[]
    intent: string | null; intended_dow: number | null; session_type: string | null
  }
  const loadRoutines = async (phaseId: string): Promise<PagerRoutine[]> => {
    const { data } = await supabase
      .from('routine').select('id, name, exercises, intent, intended_dow, session_type')
      .eq('phase_id', phaseId).order('name')
    return (data ?? []) as unknown as PagerRoutine[]
  }

  if (activePhase) {
    const phaseName = (activePhase as { name: PhaseName }).name
    const stepPct = PHASE_WEEKLY_STEP_PCT[phaseName] ?? 0
    const [{ data: athRow }, { data: latestReview }, activeRoutines, queuedRoutines] = await Promise.all([
      supabase.from('athlete').select('sessions_per_week').eq('id', athleteId).maybeSingle(),
      supabase.from('weekly_review').select('week_ending, next_week_prescription')
        .eq('program_id', prog.id).order('week_ending', { ascending: false }).limit(1).maybeSingle(),
      loadRoutines((activePhase as { id: string }).id),
      queuedPhase ? loadRoutines((queuedPhase as { id: string }).id) : Promise.resolve([] as PagerRoutine[]),
    ])
    const plannedPerWeek = (athRow?.sessions_per_week as number | null) ?? 3
    const weekClosed = (latestReview?.week_ending as string | undefined) === thisWeekEnding
    const closedPresc = weekClosed
      ? ((latestReview?.next_week_prescription as WeeklyPrescription | null) ?? null)
      : null

    let previewPresc: WeeklyPrescription | null = closedPresc
    if (!previewPresc) {
      const [{ data: cwWorkouts }, { data: cwObs }] = await Promise.all([
        supabase.from('workout').select('performed_at, rpe, actual_weights, routine!inner(program_id)')
          .eq('routine.program_id', prog.id).gte('performed_at', `${thisMondayISO}T00:00:00`),
        supabase.from('session_observation').select('severity, signal, logged_at, workout!inner(routine!inner(program_id))')
          .eq('workout.routine.program_id', prog.id).gte('logged_at', `${thisMondayISO}T00:00:00`),
      ])
      const cw = (cwWorkouts ?? []) as unknown as WeekWorkout[]
      const tally = tallyWeek(
        plannedPerWeek, cw, (cwObs ?? []) as unknown as WeekObservation[],
        { start: thisMondayISO, end: thisWeekEnding },
      )
      if (tally.done >= plannedPerWeek) {
        previewPresc = decidePrescription(tally, { phaseName })
      }
    }

    const byName = await gatherExerciseBases(prog.id)
    const lastByRoutine = new Map<string, Map<string, SetLog | null>>()
    const seedBases = async (routines: PagerRoutine[]) => {
      for (const r of routines) {
        if (lastByRoutine.has(r.id)) continue
        const { data: lastW } = await supabase
          .from('workout').select('actual_weights, exercises_snapshot, rpe')
          .eq('routine_id', r.id).order('performed_at', { ascending: false }).limit(1).maybeSingle()
        const lastByName = new Map(
          readLoggedExercises({
            actual_weights: (lastW?.actual_weights as Record<string, SetLog[]> | null) ?? null,
            exercises_snapshot: (lastW?.exercises_snapshot as ExerciseTemplate[] | null) ?? null,
            routine: { exercises: r.exercises },
          }).map(({ name, sets }) => [name, topWorkingSet(sets)]),
        )
        lastByRoutine.set(r.id, lastByName)
      }
    }
    await seedBases(activeRoutines)
    await seedBases(queuedRoutines)

    const plans = planPagerFutureWeeks({
      thisMonday: thisMondayISO,
      activeWeekEnd: (activePhase.week_end as string | null) ?? null,
      queued: queuedPhase
        ? {
            weekStart: (queuedPhase as { week_start: string }).week_start,
            weekEnd: (queuedPhase as { week_end: string | null }).week_end,
          }
        : null,
    })

    const projectSessions = (routines: PagerRoutine[], coachPresc: WeeklyPrescription | null, k: number): PagerSessionView[] => {
      const ordered = orderByPlannedDay(routines, (r) => r.intended_dow)
      return ordered.map((r) => {
        const last = lastByRoutine.get(r.id) ?? new Map()
        return {
          routineId: r.id,
          routineName: r.name,
          intent: r.intent,
          tag: null,
          lines: r.exercises.map((ex) => {
            const top = last.get(ex.name) ?? byName.get(ex.name) ?? null
            const projected = projectExerciseLoad({
              exercise: ex,
              lastWeight: top?.weight ?? null,
              lastRpe: top?.rpe,
              lastReps: top?.reps,
              weeklyDelta: coachPresc?.load_delta_pct ?? (stepPct * k),
              directive: coachPresc?.directive ?? (stepPct > 0 ? 'PROGRESS' : 'HOLD'),
              sessionIntent: r.intent,
              sessionName: r.name,
              u,
            })
            let detail: string
            if (projected.weight != null) {
              detail = `${u.fmt(projected.weight)}${u.unit}×${ex.reps}`
            } else {
              detail = `${ex.sets}×${ex.reps}${ex.load ? ` · ${ex.load}` : ''}`
            }
            return { name: ex.name, detail }
          }),
        }
      })
    }

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]
      const fromQueued = plan.source === 'queued'
      const routines = fromQueued ? queuedRoutines : activeRoutines
      const name = fromQueued ? (queuedPhase as { name: string }).name : phaseName
      const coachPresc = i === 0 ? previewPresc : null
      future.push({
        weekStart: plan.weekStart,
        weekEnd: plan.weekEnd,
        phaseName: name,
        sessions: projectSessions(routines, coachPresc, i + 1),
        ...(i === 0 && previewPresc ? {
          directive: previewPresc.directive,
          rationale: previewPresc.rationale,
          provisional: !weekClosed,
        } : {}),
      })
    }

    const first = plans[0]
    if (first) {
      const fromQueued = first.source === 'queued'
      const routines = fromQueued ? queuedRoutines : activeRoutines
      upcoming = {
        weekStart: first.weekStart,
        weekEnd: first.weekEnd,
        phaseName: fromQueued ? (queuedPhase as { name: string }).name : phaseName,
        fromQueued,
        routines: orderByPlannedDay(routines, (r) => r.intended_dow),
      }
    }

    const nextName = PHASE_SEQUENCE[PHASE_SEQUENCE.indexOf(phaseName) + 1] ?? null
    if (nextName && !queuedPhase) {
      const plan = generatePhase(nextName, 'Lower Chain', isoDate(new Date()))
      boundary = { phaseName: nextName, goal: plan.goal, gate: plan.phase.advancement_criteria }
    }
  }

  return { past, future, boundary, upcoming }
}

// Compact one-set detail for the pager (e.g. "275lb×5", "30s", "5m").
function fmtSetDetail(s: SetLog, u: UnitContext): string {
  if (s.weight != null) return `${u.fmt(s.weight)}${u.unit}×${s.reps ?? '?'}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}`
  return `${s.reps ?? '?'} reps`
}
