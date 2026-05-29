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

export interface ProbeResult {
  followup_question: string | null
  hypothesis: ProbeHypothesis
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

/** The Probe — pre-auth. obstacle (+ optional follow-up answer) → Q + hypothesis. */
export function callProbe(payload: {
  obstacle: string
  followup_answer?: string
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
