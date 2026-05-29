// =============================================================================
// AGENT CONTRACT — structured-output schemas + system prompts per task
//
// The split that governs everything: the agent PROPOSES (open-ended language &
// judgment), deterministic code DISPOSES (rules, math, safety). So these schemas
// only ever ask the model to CLASSIFY or DRAFT LANGUAGE — never to decide a
// confidence delta, a load, or whether something is safe. That math lives in
// src/engine/index.ts on the client side.
//
// Every schema is `strict: true` json_schema: additionalProperties:false and all
// properties required (use ["string","null"] unions for optional fields). This
// makes the OpenAI response provably shaped; we still re-validate at runtime.
// =============================================================================

// Insight categories — the controlled vocabulary the engine maps to programs.
export const CATEGORIES = [
  'Lower Chain',
  'Upper Chain',
  'Posterior Chain',
  'Core',
  'Recovery',
  'Strength',
] as const

// Movement-screen pattern keys — must mirror MOVEMENT_PATTERNS in
// src/types/database.ts. info_gain may only choose from these.
export const MOVEMENT_PATTERN_KEYS = [
  'deep_squat',
  'hurdle_step',
  'inline_lunge',
  'shoulder_mobility',
  'aslr',
  'trunk_stability',
  'rotary_stability',
] as const

export type TaskName = 'probe' | 'program_design' | 'info_gain' | 'session_review' | 'target'

export interface TaskSpec {
  // OpenAI json_schema name (must be [a-zA-Z0-9_], <=64 chars)
  schemaName: string
  system: string
  schema: Record<string, unknown>
  // Tasks allowed before authentication. Only the Probe is public.
  preAuth: boolean
}

const VOICE =
  'Voice: a cold instrument with a warm operator. Precise, never hype, never ' +
  'emoji. You speak to a serious athlete as a peer. Claims are falsifiable and ' +
  'plain. You never promise certainty you do not have.'

// ---- probe -----------------------------------------------------------------
// obstacle text (+ optional follow-up answer) → one adaptive follow-up question
// and an early, falsifiable hypothesis about the limiter. confidence is the
// model's HONEST read of how sure it is given one or two lines of text — it will
// be low, and that is correct.
const probe: TaskSpec = {
  schemaName: 'probe_result',
  preAuth: true,
  system: `${VOICE}

You are the Probe — the athlete's first contact. Input is their free-text answer to "what's getting in your way?" and, on a second pass, their answer to your follow-up.

Return:
- followup_question: the SINGLE most information-bearing follow-up you could ask to sharpen the read. If the input already includes a follow-up answer (the payload has followup_answer), return null — do not keep interrogating.
- hypothesis: an early, falsifiable read of the most likely limiter. category MUST be one of the controlled categories. confidence ∈ [0,1] is your honest uncertainty from this little text — expect 0.2–0.45 pre-answer, a little higher after the follow-up. claim is one plain sentence an athlete would recognise. rationale is one sentence on why you suspect it.

You propose; deterministic code disposes. Never state certainty. Never prescribe load.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['followup_question', 'hypothesis'],
    properties: {
      followup_question: { type: ['string', 'null'] },
      hypothesis: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'category', 'confidence', 'rationale'],
        properties: {
          claim: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

// ---- program_design --------------------------------------------------------
// profile + working hypothesis → a specific session/week. The model proposes
// exercises; a DETERMINISTIC safety validator (client side, Phase C) clamps load
// and rejects anything unsafe before it ever reaches the DB. Keep it low-load.
const program_design: TaskSpec = {
  schemaName: 'program_design_result',
  preAuth: false,
  system: `${VOICE}

You design a single safe, relevant training session (or short week) from the athlete's profile and the current working hypothesis about their limiter.

Hard rules:
- This is an EARLY, low-confidence session. Prefer mobility, activation, and bodyweight or light patterns. Do NOT prescribe heavy or maximal load.
- Every exercise must plausibly serve the hypothesised limiter or be a safe general pattern.
- sets is an integer; reps is a short string ("8", "8-10", "30s"); load is one of "bodyweight", "light", "moderate"; cue is one short coaching sentence.

A deterministic safety validator will clamp or reject your output — design honestly, but know that code is the last line of defence, not you.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'sessions', 'non_negotiables'],
    properties: {
      goal: { type: 'string' },
      non_negotiables: { type: 'array', items: { type: 'string' } },
      sessions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'intent', 'exercises'],
          properties: {
            name: { type: 'string' },
            intent: { type: 'string' },
            exercises: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'sets', 'reps', 'load', 'cue'],
                properties: {
                  name: { type: 'string' },
                  sets: { type: 'integer', minimum: 1, maximum: 6 },
                  reps: { type: 'string' },
                  load: { type: 'string', enum: ['bodyweight', 'light', 'moderate'] },
                  cue: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
}

// ---- info_gain -------------------------------------------------------------
// goal/obstacle + current insight confidences + already-screened patterns →
// the ONE pattern whose screening would most reduce uncertainty for THIS goal.
const info_gain: TaskSpec = {
  schemaName: 'info_gain_result',
  preAuth: false,
  system: `${VOICE}

Choose the single movement-screen pattern whose result would most reduce uncertainty about THIS athlete's stated goal, given what is already known and what has already been screened.

- pattern_key MUST be one of the allowed keys and MUST NOT be one already screened (unless every relevant pattern is exhausted — then pick the most goal-relevant).
- Favour patterns tied to the goal-relevant limiter with the LOWEST current confidence (most to learn).
- rationale: one sentence on why this pattern, now.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern_key', 'rationale'],
    properties: {
      pattern_key: { type: 'string', enum: [...MOVEMENT_PATTERN_KEYS] },
      rationale: { type: 'string' },
    },
  },
}

// ---- session_review --------------------------------------------------------
// a single free-text observation → a CLASSIFICATION of what it implies for the
// insight stack. The model classifies direction + magnitude; the engine maps
// that to a BOUNDED confidence delta and a status transition. The model never
// returns a number.
const session_review: TaskSpec = {
  schemaName: 'session_review_result',
  preAuth: false,
  system: `${VOICE}

Classify what one session observation implies for the athlete's current insight stack.

- target_insight_id: the id of the existing insight this observation bears on, or null if it points at something not yet tracked.
- direction: "confirming" if it strengthens the targeted insight's claim, "disconfirming" if it weakens it, "neutral" if it barely moves the read.
- magnitude: how strong the signal is — "weak" (one ambiguous data point), "moderate", or "strong" (unambiguous).
- category: the controlled category this observation is about.
- claim: one plain sentence describing what this observation tells us.
- rationale: one sentence on your reasoning.

You CLASSIFY only. Deterministic code converts your classification into a small, capped confidence change — you never output a number or decide the new status.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['target_insight_id', 'direction', 'magnitude', 'category', 'claim', 'rationale'],
    properties: {
      target_insight_id: { type: ['string', 'null'] },
      direction: { type: 'string', enum: ['confirming', 'disconfirming', 'neutral'] },
      magnitude: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
      category: { type: 'string', enum: [...CATEGORIES] },
      claim: { type: 'string' },
      rationale: { type: 'string' },
    },
  },
}

// ---- target -----------------------------------------------------------------
// obstacle (+ the working hypothesis) → a tailored target QUESTION and a
// concrete suggested target the athlete confirms or edits. The system should
// look like it already inferred the answer — never a blank "what do you want?".
const target: TaskSpec = {
  schemaName: 'target_result',
  preAuth: false,
  system: `${VOICE}

The athlete told you what's in their way; you've formed an early read. Now infer what they're actually CHASING and ask them to confirm it.

Return:
- target_question: one tailored question that shows you were listening, referencing their own situation — e.g. "Your bench is stuck around 265 — what number are you chasing?" Never a generic "what's your goal?".
- suggested_target: the single most likely concrete target, short and plain — e.g. "285 lb bench", "first muscle-up", "sub-20 5k". Null ONLY if nothing is reasonably inferable.

Concrete and athlete-owned. A number if there's a number. No hedging.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['target_question', 'suggested_target'],
    properties: {
      target_question: { type: 'string' },
      suggested_target: { type: ['string', 'null'] },
    },
  },
}

export const TASKS: Record<TaskName, TaskSpec> = {
  probe,
  program_design,
  info_gain,
  session_review,
  target,
}
