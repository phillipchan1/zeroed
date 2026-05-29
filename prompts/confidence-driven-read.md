# Build Prompt — The Confidence-Driven Read

> Paste this into a fresh Claude Code session at the repo root. It is self-contained.
> Full design rationale lives in Notion: **"2. The Confidence-Driven Read"**
> (`36fe2f0e77608194941ddd2d401ac30d`). Read it if anything here is ambiguous.

---

## What you're building

Zeroed's onboarding currently presents a wall of 7 self-scored movement patterns as
the price of entry, and every "insight" is hardcoded. We are replacing that with a
flow where **confidence is the currency**: the system delivers an early, intelligent
insight and a safe first workout *before* any screen, then runs the diagnosis
*underneath* the training — screening only what the athlete's stated obstacle makes
relevant, paced by how uncertain it still is.

**The one rule that governs everything: the agent proposes, deterministic code disposes.**
The LLM handles open-ended language/judgment. Deterministic code owns all rules, math,
structure, and **all safety**. The LLM is never the last line of defense on anything
that matters. The existing deterministic engine in `src/engine/index.ts` is NOT thrown
away — it becomes the **fallback floor** when a model call fails.

## The target flow

```
1. OBSTACLE        "What's getting in your way?" → free text          (exists: HookQuestionScreen)
2. PROBE (agent)   1 adaptive follow-up Q + early HYPOTHESIS insight  ← NEW agentic surface
   ↓ AUTH          "Drop your email — I'll save your read."           (exists: AuthSheet — move seam here)
3. ORIENT          name / sport / training age / sessions             (exists: OrientationAct)
4. FIRST WORKOUT   safe, low-load week handed over immediately        ← NO screen required
   ↓
5. ADAPTIVE READ   each session screens the 1 highest-info-gain       ← diagnosis underneath
   (the loop)      pattern + observations → confidence ticks up
6. CONFIRMED READ  fires on a CONFIDENCE THRESHOLD, not a calendar    (reuse ZeroedInScreen hero)
```

First insight at step 2 (~30s in). First workout at step 4 (no screening prerequisite).
Everything rigorous happens underneath the training, paced by remaining uncertainty.

## What already exists (do not rebuild — rewire)

- Six-act screens in `src/screens/onboarding/` orchestrated by `OnboardingRouter.tsx`.
- `athlete.onboarding_step` state machine — migration `supabase/migrations/20260530000001_onboarding_step.sql`.
  ⚠️ Confirm this migration is APPLIED to the linked Supabase project before runtime testing.
- `src/engine/index.ts` — deterministic insight/program generators (KEEP as fallback) + four
  `// TODO (Prompt 3)` agent stubs that are currently no-ops:
  `runDiagnosticAnalysisAgent`, `runSessionReviewAgent`, `runWeeklyReviewAgent`, `checkPhaseAdvancement`.
- `ZeroedInScreen`, `ComputeScreen`, `PostSessionRevelationScreen`, `WorkoutScreen`, `TodayScreen`.

## Agent vs. hardcode — the split (respect this exactly)

**Agent (server-side model call, structured output):**
- The Probe — obstacle text → single best follow-up Q + falsifiable hypothesis.
- Program / workout design — hypothesis + profile → a specific session.
- Information-gain selection — "next most useful pattern to screen for THIS goal + uncertainty."
- Session review — free-text observation → confirming / disconfirming classification.
- Warm voice / characterization — structured state → human language.

**Hardcode (deterministic, never an LLM):**
- Safety clamps — load caps by training age, never-load-over-P1-instability, pain ⇒ stop/regress.
  The agent's proposed session passes through a deterministic validator that clamps or rejects.
- Confidence math — agent CLASSIFIES; code applies a BOUNDED delta. confidence ∈ [0,1], capped step.
- State machine, read-cadence scheduler `f(remaining uncertainty)`, exercise library, output schemas.

**Layering:** agent (proposes) → guardrail (validates/clamps) → deterministic engine (executes,
persists, and catches failures by falling back to the existing rule-based generators).

## Guardrails (non-negotiable)

1. Every agent call uses **structured output** validated against a schema; retry on mismatch.
2. A **deterministic safety validator** sits between any agent-proposed prescription and execution.
   This is the most rigorous point in the system. No prescription reaches the DB unvalidated.
3. **Bounded confidence updates** — agent classifies, code applies a capped step.
4. **Graceful fallback** — model call fails/times out/returns garbage → drop to the existing
   deterministic engine. The app must always function and always be safe.
5. **Security** — all model calls run in a **Supabase Edge Function**. NEVER call the model from a
   screen component; the key would leak to the browser. Model: GPT-5.5-nano (key is provided by the user).
6. Pre-auth, only the Probe may call the model, **rate-limited per device/IP**. All expensive
   generation is post-auth.

## Confidence model

- Add a live confidence number per insight/limiter (the schema's `insight.confidence` already exists).
- Read cadence = `f(remaining uncertainty on goal-relevant limiters)`: frequent early, decaying as
  confidence saturates → program asymptotes diagnostic-heavy → training-heavy.
- Two read triggers: (a) scheduled by remaining uncertainty, (b) event-driven by a *surprising*
  observation that re-injects uncertainty.
- The Confirmed Read fires when confidence on the priority limiter crosses a threshold — **whenever
  that is**, not on a calendar. Floor it: guarantee a (still-sharpening-flagged) read by ~Session 5.

## Suggested build order (checkpoint after each — get sign-off before moving on)

**Phase A — Edge Function + agent contract (the foundation).**
- Stand up a Supabase Edge Function that wraps GPT-5.5-nano with strict JSON-schema output + retry.
- Define the structured-output schemas for: Probe (followup_question + hypothesis insight),
  program design, info-gain selection, session-review classification.
- Wire `runDiagnosticAnalysisAgent` / `runSessionReviewAgent` in `src/engine/index.ts` to call it,
  with the existing deterministic functions as the catch/fallback. No UI yet.
- ✅ Checkpoint: agent calls return validated structured output; fallback proven by forcing a failure.

**Phase B — The Probe + auth seam (first insight, ~30s in).**
- New Probe screen between obstacle and orientation: adaptive Q, then early hypothesis insight.
- Move the auth sheet to fire AFTER the insight, BEFORE the first workout.
- Add the new `onboarding_step` values this flow needs (extend the migration; keep DebugReset working).
- ✅ Checkpoint: cold start → obstacle → adaptive Q → hypothesis insight → auth, verified in browser.

**Phase C — First workout handoff (the reward, no screen required).**
- Provisional-week generator: mobility/activation/bodyweight ONLY, hypothesis-driven, safety-clamped.
- Hand the week over right after orientation; athlete reaches a real workout without any screen.
- ✅ Checkpoint: new user gets a safe, relevant first session with zero movement-screen input.

**Phase D — Diagnosis underneath (the loop).**
- Each session embeds ONE info-gain-selected "Test me" pattern check.
- Observations write back to insight confidence (real `runSessionReviewAgent` + bounded delta math).
- Today telemetry strip shows the read building (e.g. `READ · 72% CONFIDENT · 1 LIMITER CONFIRMED`).
- Implement the `f(uncertainty)` read-cadence scheduler + the surprise re-injection trigger.
- ✅ Checkpoint: confidence visibly moves from real session data across 2–3 logged sessions.

**Phase E — The Confirmed Read (earned Zeroed In).**
- Fire the ZeroedInScreen hero on the confidence threshold, not a calendar. Apply the Session-5 floor.
- Retire the legacy wall-of-7 `funnel/DiagnosticIntake` as the entry gate.
- ✅ Checkpoint: Confirmed Read fires on threshold; messy-athlete path still gets the floored read.

## Verification & housekeeping

- Type-check + build clean after every phase. Verify each UI checkpoint in the browser (preview tools).
- Confirm migration `20260530000001` (and any new step values you add) are applied before runtime tests.
- Success metric to keep in view: **completed Session 1 + returned for Session 2, and watched the
  confidence number move** — not "completed onboarding."
- Do not add emojis not already in the Design Language. Re-read all voice copy against the doctrine.
