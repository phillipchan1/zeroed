# Passive progress: every set is evidence, tests are confirmations

Status: built on branch `passive-progress` (phases 1–5). Written 2026-11-05. See **As built** at the end for where the build differs from the plan.

## The problem

Goals turned the program into something you can watch move. But the Goals
screen still asks for tests: a goal shows **Needs a test** when it has no
real measurement, or when its cadence lapses. A coach whose job is saving the
athlete's time doesn't work that way. They read the log. Every working set says
something about capacity. A test is what you run when the log can't answer, or
when a number is about to be declared done.

Three things in the code cause most of the "Needs a test" noise today:

1. **Goals estimate strength with Epley, not RPE.** `sessionValue('e1rm')` in
   `src/engine/goalSources.ts` calls `estimate1RM` (`src/engine/prs.ts:36`):
   `w × (1 + r/30)`. That reads 225×5 @6 the same as 225×5 @10. Meanwhile
   `src/engine/liftModel.ts` already does this properly (RTS reps×RPE chart,
   sets below RPE 7 count for nothing, recency weighting with a ~3-week
   half-life, capped by what has actually been lifted). It only covers the four
   main lifts, and it drives loads, not goals. **The app has two answers to
   "how strong is he."**
2. **Hold-or-beat.** `deriveGoalMeasurements` writes a value only when the
   session matches or beats `current`. That's there so deloads can't drag the
   trend down, but it also means submaximal training never counts. If a test set
   `current`, ordinary RPE 7–8 work stays below it forever, the cadence lapses,
   and the goal flips to Needs a test.
3. **Anything that isn't a barbell is a manual test.** Mobility, sided goals,
   skills and most conditioning have no passive source. Conditioning logs
   capture duration and rounds, not output.

## Principle

> Estimate continuously from training. Show how sure the estimate is. Ask for
> a test only when the answer would change a decision, and put the test inside a
> session you were doing anyway.

## What already exists to build on

| Piece | Where | Reuse |
|---|---|---|
| RPE chart e1RM, recency-weighted working max | `engine/liftModel.ts` (+ Deno copy in `supabase/functions/_shared/engine/`) | The strength estimator. Generalize past the four main lifts. |
| Ratio-based weak-chain read (squat, hinge, push, pull vs squat) | `engine/balance.ts` | The weakness detector. Becomes a graph of exercises, not four slots. |
| "Your log already tested these" | `engine/strengthBaseline.ts` | Same idea for the retest. Merges into the capacity read. |
| Goal ↔ exercise binding (`source_metric`) | `engine/goalSources.ts` | Stays the binding. Add new source kinds. |
| Forecast and status | `engine/goals.ts` | Stays. Reads estimates with confidence. |
| Interval parsing | `engine/intervals.ts` | Where conditioning output gets logged per round. |
| Session check-in: sleep, readiness, knee pain, bodyweight, session RPE | `workout` table (`worker/schema/app.sql`) | Context for cross-domain reads (load, recovery, relative strength). |
| One "reading" (test-me) item per session | `ExerciseTemplate.reading` | How embedded tests get scheduled. |
| Coach proposals | `coach_proposal`, `/api/proposals` | How Claude suggests a test or a fix for a weak link. |
| Track engines (`measurement`, `contacts`, `time_interval`) | `engine/tracks.ts` | Each engine type maps to an estimator family. |

## 1. One capacity model, five domains

A **capacity** is the app's current belief about one quality: a value, a
range, and how it was earned. Goals read capacities and don't compute their own
numbers. Each domain gets the estimator a coach would actually use.

### Strength (max force)
- **Estimator:** the RTS chart e1RM from `liftModel`, for every `weight_reps`
  lift, not just the four main ones. Accessories use the same math with their
  own exercise identity.
- **Usable sets:** 1–6 reps count in full, 7–10 reps count with a wider range,
  over 12 reps don't count. RPE 8+ is full weight, 7–7.5 tapers, below 7 counts
  for nothing (same as `liftModel`). A set with no RPE is a floor (read at 10),
  as it is now.
- **Writes every session**, smoothed. Hold-or-beat goes away for estimated
  sources, because the smoothing and the RPE weighting already keep deload
  weeks from pulling the number down.

### Strength-endurance and bodyweight
- **Reps to failure = reps + (10 − RPE).** 8 pull-ups @8 is about 10 max. A
  pull-up goal moves without a max-reps test.
- **Added load:** a weighted pull-up converts to e1RM against bodyweight +
  load. The check-in already logs bodyweight. This gives relative strength
  (e1RM ÷ BW), the number most field-sport goals actually care about.
- Holds and carries: longest hold at an RPE, same RIR idea in seconds (lower
  confidence; flag as estimate).

### Power and elastic (jumps, sprints, throws)
- These are max intent every rep, so training *is* the test. **Best of the
  top two reps per session** feeds the goal directly. No RPE math.
- Fatigue matters more than load. Ignore sessions where readiness ≤ 4, or where
  jumps came after heavy lower work, unless the program put them first.
- Contacts (`contacts` engine) give dose. Distance gives output.

### Conditioning (engine)
This is the domain with the biggest data gap. Today a round logs duration and
nothing about output.
- **Add output per round:** meters, calories or watts (whatever the erg
  shows), and optional average HR. Additive JSONB fields on `SetLog`, same
  pattern as `duration` and `distance`.
- **Capacities derived from intervals:**
  - **Output at RPE:** mean output across rounds at a given session RPE. If 
    output goes up at the same RPE, the engine is improving. This is the
    conditioning equivalent of e1RM.
  - **Repeat-effort fade:** last round ÷ first round. Little fade means good
    aerobic support for repeated sprints, which matters for basketball.
  - **Aerobic pace:** pace or watts in zone-2 work (RPE ≤ 6, or HR under a cap
    once HR exists).
- **Later:** pull HR and runs from HealthKit (the iOS app is Capacitor).
  Don't build this before the manual fields prove useful.

### Mobility and skills
Some things have no honest substitute.
- **Mobility (Hip IR, knee-to-wall, wall test):** keep these as measurements,
  but make each one a 20-second item in a warm-up the program already contains,
  scheduled through `reading`. This turns a chore into one tap.
- **Skills (handstand, double-unders, free throws, etc.):** log **attempts /
  makes** or **best unbroken**. Success rate over a rolling window is the
  capacity. That's passive as long as the skill is practiced.
- **Sport (basketball post-game ratings):** context, not a goal metric. Feed it
  to cross-domain reads (section 4), never to a goal number.

## 2. Confidence: tested, estimated, stale

Every capacity carries an **evidence tier**, and the UI shows it instead of
the yes/no Needs a test.

| Tier | Earned by | Shown as |
|---|---|---|
| **Tested** | A max-intent effort: single at RPE 9+, a jump or sprint, a measurement, a scheduled test | the number |
| **Estimated** | Usable sets from the last ~3 weeks | the number ± range (range from rep count, RPE level and how many sets agree) |
| **Inferred** | Only a related lift (section 3), e.g. DB press feeding a bench goal | the number ± a wider range, "from DB Bench" |
| **Stale** | No usable evidence for N weeks (default 4; per domain) | last number, grayed out, "last seen Oct 6" |

The range widens with time since the last evidence. The forecast cone on the
goal page already exists; it takes its width from the range.

**Zeroed needs proof.** An estimate past the target moves the goal to
**Confirm**. Zeroed requires a Tested value, or a strong estimate (≥2 sets of
1–3 reps at RPE 8+ that agree within 2%) past the target.

## 3. Relationships: the lift family graph

A coach knows a DB press, an incline and a bench are related, and how much.
That knowledge does two things here.

### a. Fill gaps
When the bound lift isn't in this block (bench goal, DB-only block), related
lifts keep the estimate alive at the Inferred tier rather than letting it go
stale.

### b. Find weak links
When the athlete's ratio between two related lifts drifts from what's
expected, that's information. This is what you meant by "your DB press not
correlating with bench."

**Code-owned priors** (same doctrine as `demandTables.ts`: the agent reads
the table, never invents it). Round numbers, labeled as population heuristics:

| Pair | Expected ratio (e1RM) | Off low usually means | Off high usually means |
|---|---|---|---|
| DB Bench (one hand) : Bench | ~0.38–0.42 | shoulder stability, unilateral control, ROM | bench technique / bar path, lockout |
| Incline : Bench | ~0.80 | upper chest / front delt | — |
| OHP : Bench | ~0.62 | overhead mobility, delts, triceps | — |
| Row : Bench | ~0.70–1.0 | upper back lagging (shoulder-health flag) | — |
| Front Squat : Back Squat | ~0.82–0.85 | quads, upper back, upright torso | back squat technique / hips |
| Deadlift : Squat | ~1.2 | posterior chain | quad-dominant squat strength |
| RDL : Deadlift | ~0.70 | hamstrings | — |
| Bulgarian split squat (one side) : Back Squat | ~0.45–0.50 | single-leg stability, hip | — |
| L : R on any unilateral | 1.0 | asymmetry > 10% is a flag | |
| Broad jump : relative squat | athlete's own trend | strong but slow: train speed and power, not more strength | |

**Per-athlete learning.** After roughly 6 paired weeks, replace the prior
with the athlete's own ratio (shrink toward the prior while data is thin).
From then on, a weak link means **moved off your own baseline**, which is a
stronger signal than being off the population number. Your DB press ratio
dropping 8% over a block while bench rises says something real. Your DB press
simply being lower than some average might just be your build.

**Where it lives.** Generalize `balance.ts` from four slots vs squat to pairs
in the graph. Keep its stated limits (leverages, limb length) in the output.

## 4. Across domains

Strength, engine and skill interact. The question a coach asks is whether
one quality moved because of another.

- **Interference:** conditioning load (session RPE × minutes, already in the
  check-in) going up in the same weeks that strength estimates flatten or
  drop. Flag it with both series side by side.
- **Recovery:** sleep and readiness against e1RM residuals (actual vs
  predicted). Low readiness + under-prediction is fatigue, not lost strength.
  Don't let it move the goal.
- **Transfer:** squat up but jump flat means strength isn't converting to
  power. Fade improving with no zone-2 work means the intervals are doing it.
- **Sport:** basketball ratings vs fade and jump trend.

**Honesty rule:** n-of-1 correlations over a few weeks are weak. These come
out as hypotheses for Claude to raise in a proposal ("your bench stalled the
3 weeks you added 2 extra conditioning days; want to try X?"), never as status
changes or automatic edits.

## 5. Test policy: when the app asks

Replace the cadence-only trigger with a reason, and say the reason.

| Ask for a test when | Why | How it's delivered |
|---|---|---|
| Estimate is past target | Confirm before Zeroed | A top single @8–9 on the next heavy day |
| Evidence is Stale | No usable sets for N weeks | The lift's next session gets one usable set; if it isn't programmed, Claude proposes adding it |
| The estimate disagrees with reality (missed reps at a load the estimate said was RPE 8) | The model is wrong; recalibrate | Next session, a rated top set |
| The goal has no stand-in (mobility, some skills) | Only a measurement answers it | One `reading` item in an existing warm-up, at the cadence |
| RPE calibration check (every block) | Self-rated RPE drifts | One AMRAP at a known load on week 3 |

**Budget:** at most one test item per session (the existing `reading` rule),
and never a dedicated test day unless the athlete asks for one.

## 6. What changes

### Data
- `goal_measurement.source`: add `estimate` (alongside `workout_log`,
  `manual`, `agent`). Add `tier`, `range_lo`, `range_hi`, `evidence` (JSON:
  which sets, which related lift).
- `SetLog` (JSONB, additive): `output` + `output_unit` (m / cal / W),
  `avg_hr`, `attempts` / `makes`.
- `goalSources.ts` source kinds: add `reps_to_failure`, `relative_e1rm`,
  `output_at_rpe`, `fade`, `success_rate`.
- New code-owned table: `engine/liftFamilies.ts` (pairs, priors, what an
  off-ratio usually means). Per-athlete learned ratios are derived on read, not
  stored, until reads get slow.

### Engine (pure, with `.check.ts` like the rest)
- `engine/capacity.ts`: one entry point, `capacityFor(exercise | goal, log)`
  → `{ value, lo, hi, tier, evidence, lastEvidence }`. Strength uses
  `liftModel`'s chart (lifted out so accessories can use it), the rest per
  section 1.
- `engine/weakLinks.ts`: pair ratios vs prior and vs own baseline, asymmetry,
  strength-to-power. Supersedes `balance.ts` (keep its tests passing).
- `engine/goals.ts`: status reads capacity tier; adds `confirm`; Needs a test
  comes from section 5 reasons, not cadence alone.
- Remember the Deno copy of `liftModel.ts` has to stay identical.

### App
- **Goal page:** value ± range, tier chip, "from 3 sets, latest 285×3 @8, Nov
  2", and the reason when it asks for a test.
- **Goals tab:** a **Weak links** card (one at a time, the biggest), e.g.
  "DB press has slipped from 41% to 37% of your bench since October."
- **Finish screen:** "What today told us" (which estimates moved and by how
  much), replacing hold-or-beat's goal-moved beat.
- **Conditioning logging:** output field per round, shown only for
  `time_interval` exercises on an erg or run.

### Claude / MCP
- `get_goal_brief`: each goal's capacity, tier, range and test reason, plus
  current weak links and cross-domain flags.
- Proposals: "add a top single Thursday to confirm bench", "add DB press back to
  the push day; your ratio is drifting", "cut Friday intervals for two weeks; the
  squat has stalled since they started". All go through `coach_proposal`, as
  now.

## 7. Phases

Each phase ships on its own PR behind a flag and is useful by itself.

1. **Strength estimates.** `capacity.ts` for `weight_reps` (lift the RTS chart
   out of `liftModel`), goals read it, hold-or-beat removed for estimates,
   tiers and ranges on the goal page, Confirm status, test policy for
   strength. *This alone removes most of the Needs a test noise.*
2. **Lift families and weak links.** `liftFamilies.ts`, `weakLinks.ts`, the
   Inferred tier, per-athlete ratios, the Weak links card, weak links in
   `get_goal_brief`.
3. **Bodyweight, power, skills, mobility.** Reps-to-failure, relative e1RM,
   best-of jumps and sprints, attempts/makes, mobility as warm-up readings.
4. **Conditioning output.** Output and HR fields, output-at-RPE, fade, aerobic
   pace, goal sources for them.
5. **Cross-domain reads.** Interference, recovery residuals, transfer, sport.
   Claude proposals only.
6. *(Later)* HealthKit HR and runs.

## Risks

- **RPE drift.** Most athletes rate low early on. Mitigate with the block
  AMRAP check and by comparing predicted vs completed reps (`missed_reps`
  already logs the miss).
- **Population ratios.** Labeled as priors, replaced by the athlete's own, with
  limits stated next to every read (as `balance.ts` already does).
- **Variations aren't the lift.** Paused and tempo squats estimate a different
  max. `liftModel` already separates them; the family table gives them their
  own ratio rather than pooling them.
- **High-rep estimates overshoot.** Capped by rep range and shown as a wider
  range.
- **Too many numbers.** One weak link at a time, one test per session, and a
  tier chip instead of statistics.

## Open questions

1. Which ergs and devices do you actually use (Assault bike, rower, SkiErg,
   Apple Watch for HR)? This decides phase 4's fields.
2. Which skills are goals now or soon (basketball shooting, handstand, etc.)?
3. Should Zeroed require a Tested value, or is a strong estimate (2+
   agreeing heavy triples) enough for you?
4. Per-athlete ratios after ~6 paired weeks: OK, or wait for a full block?

## As built

Phases 1–5 shipped together. Where the build differs from the plan above:

- **No schema change.** The tier rides in `goal_measurement.note`
  (`Bench Press — 285×3 @8 · estimate`), parsed back by `parseEvidenceTier`;
  the source stays `workout_log`. Range and capacity are computed on read, not
  stored. Nothing to migrate; old notes read as estimates on e1rm goals and as
  tested marks elsewhere.
- **No new flag.** Everything rides `tracks_v1`, like goals.
- **Open questions, defaults chosen:** output is generic (cal / m / W, any erg)
  with optional `avg_hr`; skills use attempts / makes on any exercise a
  `success_rate` goal binds; Zeroed accepts a tested **or** strong reading;
  own ratios after 6 paired weeks, shrunk toward the prior with weight 3.
- **Kind names:** `output` (not `output_at_rpe`); the RPE rides in the
  reading's detail.
- **Inferred readings** use the athlete's learned ratio at commit when one
  exists (fetched only when a goal's lift is missing from the session); the
  finish screen previews with the prior.
- **Calibration check** (block AMRAP) and the "estimate disagrees with
  reality" test reason are not built; missed reps already recalibrate loads in
  `liftModel`.
- **Mobility as warm-up readings** is guidance to Claude (`get_goal_brief.next`)
  rather than automatic program edits, so it lands as a proposal.
- **Sport ratings** and **HealthKit** (phase 6) are not built.
