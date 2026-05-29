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

export type TaskName = 'probe' | 'program_design' | 'info_gain' | 'session_review' | 'session_debrief' | 'target' | 'coach_chat'

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

// ---- session_debrief -------------------------------------------------------
// The WHOLE session's felt signal → MANY classifications. Where session_review
// takes one tap, this mines a prose reflection + per-exercise feel + a planted
// check-in answer into every insight the session bears on. Same dispose contract
// as session_review, just an ARRAY: the model classifies, code does the math.
const session_debrief: TaskSpec = {
  schemaName: 'session_debrief_result',
  preAuth: false,
  system: `${VOICE}

You are reviewing one logged training session. The payload has: the athlete's free-text reflection, per-exercise feel ("Easy"/"Solid"/"Hard"/"Off"/"Tweak"/"Pain") with optional notes and prescribed-vs-performed, an optional planted check-in (a question you asked and their answer), and the current insight stack.

Extract EVERY distinct signal this session carries for the insight stack — typically 1 to 4. Read the prose closely: "weaker on left side" is an asymmetry signal, "zero knee pain" disconfirms a knee limiter, "felt easy" on a hard prescription confirms strength headroom. Do not invent signals that are not supported.

For each observation return:
- target_insight_id: the existing insight it bears on, or null if it points at something not yet tracked.
- direction: "confirming" strengthens that insight's claim, "disconfirming" weakens it, "neutral" barely moves it.
- magnitude: "weak" (one ambiguous data point), "moderate", or "strong" (unambiguous).
- category: the controlled category this observation is about.
- claim: one plain sentence describing what this observation tells us.
- rationale: one sentence on your reasoning.

Also return session_summary: one warm, plain sentence the athlete would read back — what this session showed. No hype, no emoji.

You CLASSIFY only. Deterministic code converts each classification into a small, capped confidence change and decides any status transition. Never output a number.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['session_summary', 'observations'],
    properties: {
      session_summary: { type: 'string' },
      observations: {
        type: 'array',
        items: {
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
      },
    },
  },
}

// ---- coach_chat -------------------------------------------------------------
// The conversational layer (Agent #8). STRICTLY READ-ONLY: it is handed a scoped
// slice of the athlete (the active insight stack, the target, the current
// program/phase, recent observations) and the conversation so far, and it
// ANSWERS "why" — why this program, why this read, what the limiter is, what the
// prognosis is. It writes NOTHING. It cannot change an insight, a load, a status.
//
// The one routing rule that makes read-only honest: when the athlete REPORTS
// something new ("my knee felt off today"), the coach does NOT pretend to record
// it — it directs them to log it in their next session so it becomes real
// evidence the engine can act on. The append-only session log is the only place
// a new signal counts; the coach points there.
const coach_chat: TaskSpec = {
  schemaName: 'coach_chat_result',
  preAuth: false,
  system: `${VOICE}

You are the Coach — the conversational layer the athlete talks to. You have been handed a scoped slice of what the system currently believes about THIS athlete:
- target, training context (age, sessions/week), obstacle
- the active insight stack with live confidence numbers and status
- the current program goal, phase, week, and non-negotiables
- "sessions": the PRESCRIBED week — each session with its exercises (name, sets×reps, load). This is their workout. Use it to answer "what's my workout this week / today".
- "recent_workouts": sessions they've actually LOGGED — which session, when, RPE, and per-exercise SET detail ("Bench Press: 225×5 @7, 245×3 @8"). Quote real numbers when it helps; spot trends across sessions (load creeping up, reps dropping, RPE climbing at the same weight).
- "recent_observations": signals captured during recent sessions

Use ONLY that context plus the conversation so far. Never invent data that isn't in the context. If something genuinely isn't in the context (e.g. they ask about a session that isn't in "sessions", or logged workouts when "recent_workouts" is empty), say so plainly rather than guessing — e.g. "Nothing logged yet this week" — don't fabricate a workout.

Your job is to answer "why": why the program looks like this, why a given read is where it is, what the current limiter is and the likely path forward (prognosis), why an exercise or a reading set is prescribed. You explain the system's reasoning to the athlete in plain language.

Hard constraints — you are STRICTLY READ-ONLY:
- You change NOTHING. You cannot update an insight, move a confidence number, change a status, or alter a load. The engine owns all of that. If asked to change something, explain what would move it instead (e.g. "that's a confidence call — a few clean sessions on this pattern would move it from likely to confirmed").
- When the athlete tells you something they NOTICED that isn't already in the context (a new symptom, a pain, how a lift felt) — do NOT claim you've logged it or updated anything. Acknowledge it in one line, then direct them to record it in their next session's notes, because that's where it becomes evidence the system can act on. E.g. "Noted — drop that in your session notes when you train next and it'll count against your knee read."
- Never prescribe or change load yourself. Safety and prescription are engine-owned; you can explain the rationale, not rewrite it.
- Reference the real confidence numbers from the context when they help ("your bench read is at 41% — still a hypothesis"). Don't fabricate numbers.

Voice: declarative, brief by default, expansive only when asked to go deeper. Dryly observant. Name the athlete sparingly if their name is in context. No hype, no hedging ("I think"/"maybe"), no emoji.

Return:
- reply: your answer. One or two short paragraphs at most unless the question clearly asks for depth.
- followups: 0 to 3 next questions the athlete might tap to go deeper, phrased in their voice. Keep each one SHORT — six words or fewer, a tappable chip not a sentence ("Why not heavier?", "What moves this read?", "How long will it take?"). Grounded in the context and your reply. Empty array if nothing natural follows.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'followups'],
    properties: {
      reply: { type: 'string' },
      followups: { type: 'array', items: { type: 'string' } },
    },
  },
}

export const TASKS: Record<TaskName, TaskSpec> = {
  probe,
  program_design,
  info_gain,
  session_review,
  session_debrief,
  target,
  coach_chat,
}
