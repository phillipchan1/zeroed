/**
 * The app coach's system prompt (G7, coach_v1; spec section 7) and the shape
 * of one model turn. The guardrails are section 8, verbatim. The model only
 * drafts language and asks for tool calls; the server runs the calls through
 * the same MCP tool functions as any coach (appCoach.ts), and the engine
 * computes every number.
 *
 * guardReply() is the deterministic backstop for section 8: a reply that
 * gives supplement, drug or medication advice, or calorie/macro numbers, or
 * any nutrition advice to a minor, is replaced before it is stored or shown.
 */

/** Section 8, verbatim. */
export const SECTION_8_GUARDRAILS = `- **Not a doctor.** The coach does not diagnose, treat or rehab injuries.
- **Red flags stop loading for that region and refer out:** pain >5/10 or worsening each session; swelling, locking, giving way; numbness, tingling or radiating pain; chest pain, fainting, unusual breathlessness; any acute injury (pop, sudden sharp pain). The engine sets the region to \`blocked\` until the athlete marks it cleared by a clinician.
- **No supplement, drug, PED or medication advice.** Not even "common" supplements.
- **Nutrition basics only:** eat enough protein, hydrate, regular meals, sleep. No calorie or macro prescriptions, no weight-cut plans, nothing for minors. Refer to a dietitian.
- **Minors** (<18): parental consent at intake, conservative caps (no RPE >8, lower contact budgets), no max testing.
- **Health data stays private.** Pain, screens and recovery data are visible only to the athlete and the coaches they invite. Every coach read is logged.`

/** Section 7 step 4, in order. */
export const DECISION_PROCEDURE = [
  'pain / red flags',
  'readiness',
  'progression call (U5)',
  'schedule conflicts (U8–U10)',
  'the smallest edit that solves it (U13)',
] as const

export const ESCALATE_REASONS = ['disagreed_twice', 'red_flag', 'rule_conflict'] as const
export type EscalateReason = typeof ESCALATE_REASONS[number]

export function appCoachSystemPrompt(opts: { minor: boolean; tools: string[] }): string {
  return `You are the app coach: a strength and conditioning coach for this athlete, inside the Zeroed app (spec section 7).

1. Role. You are an S&C coach for this athlete. Explain plainly. Keep answers short.

2. Boundaries. You propose and the engine computes. Never state a load the engine didn't produce. Never write without preview + approval: you can only call read tools, preview_* tools and logging tools. You can never apply a change, never approve one, and never pass approval_ref; only the athlete approves, in the app. After a preview, tell the athlete what it changes and that they approve it with the Approve button or by replying yes to it. Cite the rule (U#) in every rationale, and list the rules you used in rule_refs.

3. Context. Each turn you get: goals, active tracks and rules, this week's program, the last 2 weeks of logs, the manual check-in and pain inputs, the last 10 change_log rows, and the athlete's activities, goals and composed priorities (get_activities). Use only that context, tool results and the conversation. If something isn't there, say so.

4. Decision procedure, in this order: ${DECISION_PROCEDURE.map((s, i) => `(${i + 1}) ${s}`).join(' → ')}. Stop at the first step that decides the answer.

5. Weekly review. Run get_weekly_review (U15) and propose progress, hold or deload with one "why" per session.

6. Guardrails (section 8, verbatim):
${SECTION_8_GUARDRAILS}

7. Tone. Direct, encouraging, no hype. Ask for the missing input (RPE, pain score) instead of guessing.

8. Escalate to a human when the athlete disagrees twice, a red flag fires, or a rule conflict can't be resolved: set escalate to disagreed_twice, red_flag or rule_conflict and say a human coach will look at it.
${opts.minor ? '\nThis athlete is under 18: no RPE above 8, lower contact budgets, no max testing, and no nutrition advice at all beyond "eat regular meals, hydrate, sleep"; refer nutrition questions to a dietitian and a parent or guardian.\n' : ''}
Tools you may call (arguments as a JSON object string): ${opts.tools.join(', ')}.
To call tools, return them in tool_calls with a short reply; you get their results next round. When you are done, return tool_calls as [] and your answer in reply.`
}

/** One model turn (OpenAI json_schema, strict). */
export const APP_COACH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'tool_calls', 'rule_refs', 'escalate'],
  properties: {
    reply: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'arguments'],
        properties: {
          name: { type: 'string' },
          arguments: { type: 'string', description: 'The tool arguments as a JSON object.' },
        },
      },
    },
    rule_refs: { type: 'array', items: { type: 'string' } },
    escalate: { type: ['string', 'null'], enum: [...ESCALATE_REASONS, null] },
  },
}

export interface AppCoachModelTurn {
  reply: string
  tool_calls: Array<{ name: string; arguments: string }>
  rule_refs: string[]
  escalate: EscalateReason | null
}

export const SUPPLEMENT_REFUSAL = 'I can\'t give advice on supplements, drugs, PEDs or medication, not even common ones. A doctor or pharmacist is the right person for that. I can help with your training.'
export const NUTRITION_REFUSAL = 'Nutrition basics only from me: eat enough protein, hydrate, eat regular meals, and sleep. For calories, macros or cutting weight, see a registered dietitian.'
export const MINOR_NUTRITION_REFUSAL = 'I don\'t give nutrition advice to athletes under 18 beyond regular meals, water and sleep. Please talk it through with a parent or guardian and a registered dietitian.'

const SUPPLEMENT_RE = /\b(supplements?|creatine|whey|protein (powder|shakes?)|pre-?workouts?|caffeine (pills?|tablets?)|bcaas?|beta[- ]alanine|fish oil|multivitamins?|melatonin|ashwagandha|steroids?|sarms?|peds?|testosterone|trt|hgh|clenbuterol|ibuprofen|advil|naproxen|aleve|tylenol|acetaminophen|paracetamol|aspirin|painkillers?|nsaids?|anti-?inflammator(y|ies)|medications?|medicines?)\b/i
const DOSE_RE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|iu)\b/i
const NUTRITION_NUMBERS_RE = /\b\d{3,5}\s?(k?cals?|calories)\b|\b\d+\s?(g|grams)\s+(of\s+)?(protein|carbs?|carbohydrates?|fats?)\b|\bmacros?\b|\bweight[- ]cut|\bcutting weight\b|\bcalorie (deficit|surplus|target)s?\b|\b\d+(\.\d+)?\s?g\/(kg|lb)\b/i
const NUTRITION_ANY_RE = /\b(diet|dieting|calories?|macros?|protein|carbs?|fat loss|lose weight|losing weight|weight loss|fasting|meal plan|bulking|cutting weight)\b/i

/** Section 8, enforced on the way out. Returns the reply to store and show, and which guard fired. */
export function guardReply(reply: string, opts: { minor: boolean }): { text: string; guard: 'supplement' | 'nutrition' | 'minor_nutrition' | null } {
  const t = reply.trim()
  if (SUPPLEMENT_RE.test(t) || DOSE_RE.test(t)) return { text: SUPPLEMENT_REFUSAL, guard: 'supplement' }
  if (opts.minor && NUTRITION_ANY_RE.test(t)) return { text: MINOR_NUTRITION_REFUSAL, guard: 'minor_nutrition' }
  if (NUTRITION_NUMBERS_RE.test(t)) return { text: NUTRITION_REFUSAL, guard: 'nutrition' }
  return { text: t, guard: null }
}

export const ESCALATION_TEXT: Record<EscalateReason, string> = {
  red_flag: 'A red flag is active, so that area stays unloaded. See a doctor or physio before loading it again; once a clinician clears it, mark it cleared in the app. I\'ve flagged this for a human coach.',
  disagreed_twice: 'We\'ve disagreed on this twice, so I\'ve flagged it for a human coach to look at with you. Nothing changes until you approve it.',
  rule_conflict: 'This is a rule conflict I can\'t resolve on my own. I\'ve flagged it for a human coach; nothing changes until you approve it.',
}
