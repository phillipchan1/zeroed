// =============================================================================
// agentClient — the ONLY way client code reaches the model.
//
// Every function here invokes the `agent` Supabase Edge Function, which holds
// the OpenAI key server-side and returns schema-validated structured output.
// Screens NEVER import this directly to make decisions — they go through
// src/engine/index.ts, which layers the deterministic guardrails (safety clamp,
// bounded confidence math) on top and falls back when a call fails.
//
// Result contract: every caller returns a discriminated union. ok:false means
// the model failed / timed out / was rate-limited — the caller MUST fall back to
// the deterministic engine. The app always functions and always stays safe.
// =============================================================================

import { supabase } from '../lib/supabaseClient'

export type AgentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'model_failed' | 'rate_limited' | 'unauthorized' | 'network'; reason?: string }

// ---- structured-output types (mirror supabase/functions/agent/schemas.ts) ----

export type InsightCategory =
  | 'Lower Chain'
  | 'Upper Chain'
  | 'Posterior Chain'
  | 'Core'
  | 'Recovery'
  | 'Strength'

export type MovementPatternKey =
  | 'deep_squat'
  | 'hurdle_step'
  | 'inline_lunge'
  | 'shoulder_mobility'
  | 'aslr'
  | 'trunk_stability'
  | 'rotary_stability'

export interface ProbeHypothesis {
  claim: string
  category: InsightCategory
  confidence: number // 0..1, the model's honest uncertainty
  rationale: string
}

// One agent-drafted claim sentence for a code-chosen read axis. The engine
// decides WHICH axes exist (and their categories/confidence); the agent only
// writes language. Optional on the wire: the currently-deployed probe returns
// just {followup_question, hypothesis}; until it's redeployed with the extended
// schema, axis_claims is absent and the engine uses table-derived claims for the
// non-P1 axes (P1 still gets the agent's hypothesis.claim). Fully graceful.
export interface ProbeAxisClaim {
  axis_id: string
  claim: string
}

export interface ProbeResult {
  followup_question: string | null
  hypothesis: ProbeHypothesis
  axis_claims?: ProbeAxisClaim[]
}

export interface ProgramExercise {
  name: string
  sets: number
  reps: string
  load: 'bodyweight' | 'light' | 'moderate'
  cue: string
}

export interface ProgramDesignResult {
  goal: string
  non_negotiables: string[]
  sessions: Array<{ name: string; intent: string; exercises: ProgramExercise[] }>
}

// Like a ProgramExercise but a screened athlete may carry real load up to "heavy".
export interface PhaseExercise {
  name: string
  sets: number
  reps: string
  load: 'bodyweight' | 'light' | 'moderate' | 'heavy'
  cue: string
}

export interface PhaseDesignResult {
  goal: string
  non_negotiables: string[]
  sessions: Array<{ name: string; intent: string; exercises: PhaseExercise[] }>
}

export interface InfoGainResult {
  pattern_key: MovementPatternKey
  rationale: string
}

export interface SessionReviewResult {
  target_insight_id: string | null
  direction: 'confirming' | 'disconfirming' | 'neutral'
  magnitude: 'weak' | 'moderate' | 'strong'
  category: InsightCategory
  claim: string
  rationale: string
}

// One classification inside a debrief — same shape as a single review, repeated.
export interface DebriefObservation {
  target_insight_id: string | null
  direction: 'confirming' | 'disconfirming' | 'neutral'
  magnitude: 'weak' | 'moderate' | 'strong'
  category: InsightCategory
  claim: string
  rationale: string
}

export interface SessionDebriefResult {
  session_summary: string
  observations: DebriefObservation[]
}

export interface TargetResult {
  target_question: string
  suggested_target: string | null
}

// The scoped slice of the athlete the Coach is allowed to see. NOT the whole
// profile — a curated read (the doctrine's "scoped read on demand"). Assembled
// by the engine (gatherCoachContext) and passed in; the agent reads only this.
export interface CoachContext {
  name: string | null
  target: string | null
  obstacle: string | null
  training_age: number | null
  sessions_per_week: number | null
  program: { goal: string | null; phase: string | null; week: string | null; non_negotiables: string[] } | null
  // The prescribed week — the actual sessions and their exercises.
  sessions: Array<{ name: string; intent: string | null; exercises: string[] }>
  insights: Array<{ id: string; priority: string; category: string; claim: string; confidence: number; status: string }>
  recent_observations: Array<{ signal: string; category: string; severity: number; logged_at: string }>
  // What the athlete has actually logged recently — including per-set detail
  // ("Bench Press: 225×5 @7, 245×3 @8") so the coach can talk specific numbers.
  recent_workouts: Array<{ session: string; performed_at: string; rpe: number | null; sets: string[] }>
}

export interface CoachChatTurn {
  role: 'athlete' | 'coach'
  content: string
}

// A change the coach PROPOSES. Never auto-applied — surfaced in CoachScreen for
// the athlete to confirm, then disposed by RLS-scoped client writes. Unused
// fields are null (the model fills every field; only the relevant ones are set).
export interface CoachAction {
  type: 'update_insight' | 'update_exercise' | 'add_note'
  rationale: string
  insight_id: string | null
  routine_name: string | null
  exercise_name: string | null
  set_confidence: number | null
  set_status: 'hypothesis' | 'likely' | 'confirmed' | 'resolved' | 'disproved' | null
  set_priority: 'P1' | 'P2' | 'P3' | 'P4' | null
  set_claim: string | null
  set_load: string | null
  set_sets: number | null
  set_reps: string | null
  set_cue: string | null
  set_target_rpe: number | null
  note: string | null
}

export interface CoachChatResult {
  reply: string
  followups: string[]
  actions: CoachAction[]
}

// The end-of-week coach note. The engine has already crunched the week and
// chosen the directive; this is only the warm language that wraps it.
export interface WeeklyDebriefResult {
  message: string
  headline: string
}

// ---- device id (pre-auth probe rate limiting) -------------------------------

const DEVICE_KEY = 'zeroed_device_id'

function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return 'no-storage'
  }
}

// ---- core invoke ------------------------------------------------------------

async function invokeAgent<T>(
  task: string,
  payload: unknown,
  opts?: { deviceId?: string },
): Promise<AgentResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke('agent', {
      body: { task, payload, device_id: opts?.deviceId },
    })

    if (error) {
      // Non-2xx (rate limit / auth / server). Try to read the structured reason.
      let parsed: { error?: string } | null = null
      try {
        // FunctionsHttpError exposes the Response on .context
        const ctx = (error as unknown as { context?: Response }).context
        if (ctx && typeof ctx.json === 'function') parsed = await ctx.json()
      } catch {
        /* ignore */
      }
      if (parsed?.error === 'rate_limited') return { ok: false, error: 'rate_limited' }
      if (parsed?.error === 'unauthorized') return { ok: false, error: 'unauthorized' }
      return { ok: false, error: 'network', reason: error.message }
    }

    if (!data || data.ok !== true) {
      return { ok: false, error: 'model_failed', reason: data?.reason ?? data?.error }
    }

    return { ok: true, data: data.data as T }
  } catch (e) {
    return { ok: false, error: 'network', reason: String(e) }
  }
}

// ---- typed task callers -----------------------------------------------------

/**
 * The Probe — pre-auth. obstacle (+ optional follow-up answer) → Q + hypothesis.
 *
 * Convergence read context is OPTIONAL and additive: arena + limiter + the
 * code-built axis skeleton let the (redeployed) probe draft warmer, arena-aware
 * language and fill axis_claims. The currently-deployed function ignores the
 * extra fields and returns the base shape — the engine handles both.
 */
export function callProbe(payload: {
  obstacle: string
  followup_answer?: string
  arena?: { type: string; raw: string | null } | null
  limiter?: { choice: string | null; label: string; category: string } | null
  axes?: Array<{ axis_id: string; label: string; category: string }>
}): Promise<AgentResult<ProbeResult>> {
  return invokeAgent<ProbeResult>('probe', payload, { deviceId: getDeviceId() })
}

/** Program/workout design — post-auth. profile + hypothesis → a safe session. */
export function callProgramDesign(payload: {
  profile: Record<string, unknown>
  hypothesis: ProbeHypothesis | null
  insights?: Array<{ category: string; confidence: number; status: string; claim: string }>
}): Promise<AgentResult<ProgramDesignResult>> {
  return invokeAgent<ProgramDesignResult>('program_design', payload)
}

/**
 * Phase design — post-auth, SCREENED athlete. Their real recent lifts + limiter
 * map + the target phase → one repeating week of real training, built around the
 * lifts they already log (so loading history carries forward). The engine
 * validates/clamps and falls back to the deterministic template on failure.
 */
export function callPhaseDesign(payload: {
  phase_name: string
  profile: { goal: string | null; target: string | null; obstacle: string | null; training_age: number | null; sessions_per_week: number | null }
  insights: Array<{ priority: string; category: string; claim: string; confidence: number; status: string }>
  recent_lifts: Array<{ name: string; top_set: string; rpe: number | null }>
  emphasis?: string   // optional athlete steer, e.g. "more explosive jumping + eccentric protective work"
}): Promise<AgentResult<PhaseDesignResult>> {
  return invokeAgent<PhaseDesignResult>('phase_design', payload)
}

/** Information-gain selection — post-auth. → the next pattern to screen. */
export function callInfoGain(payload: {
  goal: string
  insights: Array<{ category: string; confidence: number; status: string }>
  already_screened: string[]
}): Promise<AgentResult<InfoGainResult>> {
  return invokeAgent<InfoGainResult>('info_gain', payload)
}

/** Session review — post-auth. one observation → classification (no numbers). */
export function callSessionReview(payload: {
  observation: { label: string; signal: string; severity: number }
  insights: Array<{ id: string; category: string; claim: string; confidence: number; status: string }>
}): Promise<AgentResult<SessionReviewResult>> {
  return invokeAgent<SessionReviewResult>('session_review', payload)
}

/** Target — post-auth. obstacle + hypothesis → a tailored target Q + suggestion. */
export function callTarget(payload: {
  obstacle: string
  hypothesis: { claim: string; category: string } | null
}): Promise<AgentResult<TargetResult>> {
  return invokeAgent<TargetResult>('target', payload)
}

/**
 * Session debrief — post-auth. The whole session's felt signal (prose reflection
 * + per-exercise feel + prescribed-vs-performed + a planted check-in answer) →
 * MULTIPLE classifications. This is the throughput upgrade over a single
 * observation: one session yields many signals, like the coach's hand-written
 * notes. Each classification is disposed deterministically (bounded delta) in the
 * engine — the model never returns a number or a status.
 */
export function callSessionDebrief(payload: {
  reflection: string
  readiness: { sleep: number | null; energy: number | null; soreness: number | null } | null
  exercises: Array<{ name: string; felt: string | null; note: string; prescribed: string; performed: string }>
  reading: { name: string; question: string; answer: string } | null
  insights: Array<{ id: string; category: string; claim: string; confidence: number; status: string }>
}): Promise<AgentResult<SessionDebriefResult>> {
  return invokeAgent<SessionDebriefResult>('session_debrief', payload)
}

/**
 * Coach chat — post-auth, STRICTLY READ-ONLY. A scoped slice of the athlete +
 * the conversation so far → a warm, declarative answer + suggested follow-ups.
 * The agent writes nothing; it only narrates and routes (see schemas.ts).
 */
export function callCoachChat(payload: {
  context: CoachContext
  history: CoachChatTurn[]
  question: string
}): Promise<AgentResult<CoachChatResult>> {
  return invokeAgent<CoachChatResult>('coach_chat', payload)
}

/**
 * Weekly debrief — post-auth. The week's crunched numbers + the directive the
 * engine already chose → a warm, coach-voice end-of-week note. The model only
 * drafts language; it never changes the directive, the load delta, or a number.
 * On failure the engine falls back to a deterministic templated note.
 */
export function callWeeklyDebrief(payload: {
  name: string | null
  target: string | null
  week_ending: string
  planned: number
  done: number
  adherence: number
  avg_rpe: number | null
  pain_count: number
  positive_count: number
  flagged_categories: string[]
  directive: string
  load_delta_pct: number
  rpe_target: number
  rationale: string
  injury: boolean
  missed: boolean
}): Promise<AgentResult<WeeklyDebriefResult>> {
  return invokeAgent<WeeklyDebriefResult>('weekly_debrief', payload)
}
