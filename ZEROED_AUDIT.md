# Zeroed — full product audit

One pass over the whole app: what it is today, how it measures against the 2026
field, what's broken, what I fixed, and what I deliberately left.

Date of pass: 2026-09-01. Baseline commit: `ef8fb4d`.

---

## Phase 0 — What Zeroed actually is

### The category

**Zeroed is AI-generated programming with a coach-delivery voice.** Not
self-directed logging. The athlete never picks an exercise: a diagnostic probe
produces a *read* (a ranked stack of hypotheses about what is limiting them), the
read produces a *program* (a four-block arc, Stability → Strength → Power →
Sport), and every session logged is evidence that moves the read, which moves the
program. The loop, not the log, is the product.

The nearest neighbours are **Fitbod** and **Caliber** — AI builds the training,
you execute it. The framing is TrainHeroic-shaped (a coach pushing a structured
block to an athlete, with an intent per session and non-negotiables per phase),
but there is no coach on the other end and no multi-athlete surface, so
TrainHeroic's team features are out of scope while its *athlete-side* features
(auto-scaling to tested maxes, PR detection, volume per session/week/block, rest
timers, cues attached to movements) are squarely in it.

What Zeroed has that none of them do: an explicit, falsifiable belief about the
athlete, with a confidence number, that training evidence can *disconfirm*. A
limiter caps load, states out loud that it's capping load, and — since the
clearance-test work — names the exact sessions that would lift the cap. Fitbod
shifts volume silently. Zeroed argues.

### Stack

Vite + React 18 + React Router 7, TypeScript, Supabase (Postgres + auth + one
Edge Function), Capacitor config committed but no iOS project. Ships as an
installable PWA. ~23k lines of app TypeScript, of which a 4.4k-line `engine/`
module holds essentially all the domain logic. No test runner; correctness is
carried by seven standalone `*.check.ts` files run under
`node --experimental-strip-types` (now `npm run check`).

### The data model

| Table | Holds |
|---|---|
| `athlete` | identity, arena/limiter answers, sessions/week, training age, training preferences, onboarding step |
| `diagnostic` | versioned movement + strength screen results |
| `insight` | **the read** — claim, category, priority P1–P4, confidence 0–1, status (hypothesis → likely → confirmed / resolved / disproved), evidence JSONB (which also carries the clearance test) |
| `program` / `phase` / `routine` | the plan. A routine is a named session with `ExerciseTemplate[]` |
| `workout` | a logged session. `actual_weights` is index-keyed JSONB, with `exercises_snapshot` freezing what those indices meant |
| `workout_draft` | an in-progress session, mirrored from localStorage |
| `session_observation` | append-only raw signal (felt chips, notes, pushes, reflections) |
| `weekly_review` | the weekly tally + next week's directive |
| `coach_message` | the coach's event memory + chat |
| `program_revision` | append-only reprogramming history (the journey) |

Weights are stored as bare numbers. **That was the single biggest defect in the
app** — see P0-1.

### Current-state inventory

**Live** — built, reachable, working:

| Surface | Route | State |
|---|---|---|
| Splash → Arena → Limiter → Probe → Auth sheet | pre-auth, no URL | Live |
| Orientation (name / target / training context) → Calibrate beat | post-auth, no URL | Live |
| Post-session revelation | `/onboarding/revelation` | Live |
| **Train** — week ring, 7-day strip, session cards, week pager (real past / projected future / phase edge), close-week, stuck-upload sheet | `/app/today` | Live |
| **Workout** — set grid per tracking type, RPE tap scale, check-to-complete autofill, rest timer, felt chips, per-exercise details sheet, mid-session coach chat, clearance sheet, debrief | `/app/workout/:id` (+`?w=` to edit) | Live |
| **Program** — phase instrument, next week, sessions, advancement criteria, non-negotiables, road ahead, recent weeks | `/app/program` | Live |
| **Change my program** — chat → structured diff → confirm → apply, with revision history | `/app/program/edit` | Live |
| **Journey** — block arc + reprogramming timeline | `/app/program/journey` | Live |
| **Coach** — read stack + read-only chat with proposed-action confirm | `/app/coach` | Live |
| **History** — sessions by week, per-lift progression sheet with sparkline | `/app/history` | Live |
| **Recap** — directive, week tally, reads that moved, sessions | `/app/recap[/:id]` | Live |
| **You** — target, sessions/week, training age, units, links, MCP token | `/app/profile` | Live |
| **Retest** — movement rescreen + strength baselines → re-scope | `/app/retest` | Live |
| Offline outbox, service worker, verified-connectivity probe | app-wide | Live, and unusually good |
| MCP server (local + remote token) | `mcp/` | Live |

**Partial:**

- **Exercise library** — ~100 movements with tracking types; coaching notes
  (how-to, watch-for) for 50 of them. No media at all.
- **Retest** — re-screens movement and strength, but the strength battery is a
  fixed set of lifts, not the athlete's actual main lifts.
- **Capacitor** — config committed, no iOS project generated.

**Declared but not built:**

- `Readiness { sleep, energy, soreness }` is a type, has CSS
  (`.readiness__*`), and is passed to the debrief agent as a hardcoded `null`.
  Nothing collects it. This is the hook the whole HRV/sleep story would hang on.
- `InsightDraftRow`, `SessionObservationRow.category` typing, and several
  `OBSERVATION_CATEGORIES` entries are unused.

**Dead code** (four screens unreachable from any route, pre-existing and
documented in `docs/mobile-ux-audit.md`): `ZeroedInScreen`, `AuthScreen`,
`ReframeScreen`, `HookQuestionScreen`; orphan exports `TelemetryStrip`,
`LatencyTick`, `ExerciseInsightSheet`, `InsightMovementRow`, `Divider`.

---

## Phase 1 — Competitive parity

Scored against Zeroed's actual positioning. I have not padded this with features
that don't belong in an AI-programmed app (no social feed scoring, no
coach-roster tooling).

| Feature | Zeroed | Best at it | Priority |
|---|---|---|---|
| AI-generated programming from history | **Have** — and further than anyone: phase arc, per-lift RPE autoregulation, limiter-gated loading | Fitbod | — |
| Explains *why* each lift is there | **Have** — best in class. Nobody else attributes a movement to a belief about you | — | — |
| Auto-detects overtraining, shifts volume | **Have** (deterministic: pain flags + avg RPE vs the block's own contract) | Fitbod | — |
| Fast one-handed logging | **Have** — 52px inputs, check-to-complete autofill, tap-scale RPE | Strong | — |
| Rest timer | **Partial** — fires on set complete, fixed 90s, no adjust, no alert | Strong / Hevy | P2 |
| Exercise library w/ cues | **Partial** — 100 movements, cues on 50 | JEFIT | P2 |
| Exercise video / animation | **Missing** | JEFIT, TrainHeroic | P2 |
| **Automatic PR detection** | **~~Missing~~ → Have** (this pass) | Hevy, Strong, TrainHeroic | **P0** |
| **Volume tracked per session / week / block** | **~~Missing~~ → Have** (session + week; block deferred) | JEFIT, TrainHeroic | **P1** |
| 1RM estimate / calculator | **Have** — Epley on the per-lift sheet (was wrong at 1 rep; fixed) | Hevy | — |
| Program auto-scales to tested maxes | **Have** — every prescription is off the athlete's own logged top set, not a template % | TrainHeroic | — |
| **lb/kg** | **~~Broken~~ → Have** (this pass) | everyone | **P0** |
| Body-measurement tracking | **Missing** | JEFIT | P3 — off-strategy. Zeroed reads *performance*, not composition |
| Strength score / percentile vs population | **Missing** | Stronger app | P2 — genuinely interesting here: Zeroed already has a per-chain model, so "your posterior chain is a 4/10 and that's your limiter" would be the read made concrete |
| Routine templates / browse-and-pick | **Missing** | Hevy | Won't do — the program is the product |
| Social feed | **Missing** | Hevy | Won't do |
| Apple Watch / HealthKit | **Missing** | Strong | P2, blocked on a native shell |
| Milestone gamification (cumulative lbs) | **Missing** | TrainHeroic | P3 — now cheap, since volume exists |
| **Reads wearable recovery (HRV/sleep) to adjust training** | **Missing** — but the socket is cut | *nobody does this well* | **P1 — the differentiator** |

### On the recovery gap

The brief is right that almost nobody closes this loop, and Zeroed is the app in
this list best placed to. The whole engine is already a "read → adjust" machine
with a documented seam: `Readiness { sleep, energy, soreness }` exists as a type
and is handed to the debrief agent as `null`. A pre-session readiness gate — three
taps, no wearable at all — would feed the same autoregulator the felt chips feed,
and the directive tree already knows how to back load off. HealthKit would then
be a *source swap*, not a new feature.

I did not build it in this pass, and the reason is not effort: readiness changes
the prescription, and a wrong readiness rule makes the app tell someone to
deload when they're fine. That deserves a designed rule (how many points of RPE
target does 4 hours of sleep buy?) and a decision from you about whether Zeroed
asks a question before every session. See "one more week".

---

## Phase 2–4 — Findings

Severity: **P0** ships-broken / loses data · **P1** wrong or missing something
core · **P2** friction · **P3** nice to have.

### P0

**P0-1 · Switching lb ↔ kg silently reinterpreted every weight ever logged.**
`setWeightUnit` flipped a localStorage string. Nothing converted anything. A
225 lb bench came back as "225 kg", and because the engine prescribes off the
athlete's own logged top set, the *recommendation* inherited it too — as did the
e1RM, the forward projection, the program-edit preview, and the coach's context.
A display preference was a data-integrity event. **Fixed.**

**P0-2 · Every load was rounded to the nearest 5, in every unit.**
`roundLoad` hardcoded a 5-unit increment. In kilos the smallest real step is
2.5, so a kg athlete's "+5%" landed on a jump of 11 lb when they meant 5.
**Fixed.**

### P1

**P1-3 · No PR detection anywhere.** The app could tell you what to lift and why,
and could argue itself out of a limiter off one hard set, but never that the set
you just did was the best you have ever done. `bestWeight`/`bestE1rm` existed as
two numbers at the top of a sheet you had to go looking for, with nothing marking
which session earned them. **Fixed** — live badge in the set row, markers on the
per-lift history.

**P1-4 · No volume anywhere.** Everything counted *sets*, and a set is a unit of
effort only if every set is the same size: 3×5 at 315 and 3×12 at 95 both read as
"3 sets", so the week that added a set while halving the bar read as the bigger
week. **Fixed** — session, week and recap.

**P1-5 · Two disagreeing definitions of "the week's plan".** Train measured the
week against `routines.length`; the scheduler, the weekly review and the
adherence gate measured it against `athlete.sessions_per_week`. Usually equal
(phase design is *asked* for one session per training day) — but the
deterministic fallback template always emits exactly 3 routines, and changing
sessions/week in **You** doesn't rebuild the block. So Train could say "Week
complete · 3 of 3" on the same day the recap said "Only 3/5 logged — holding
load". Both were reading their own definition correctly. **Fixed.**

**P1-6 · The logger and every read-back counted sets differently.** Committing a
session counted only *tapped checkboxes*; every read-back counted any set
carrying numbers. A session typed straight into the grid committed as "0 sets"
and then displayed correctly everywhere else. **Fixed** — one shared predicate.

**P1-7 · Epley overstated a true single by 3.3%.** `w(1 + r/30)` extrapolates
past its own input at r=1: a logged 225×1 printed an estimated 1RM of 233 —
higher than the bar the athlete had just held. **Fixed** (and an e1RM above ~12
reps is no longer printed as a strength number).

**P1-8 · No way to abandon an in-progress session.** `clearDraft` only ever ran
on completion, Complete stays disabled until something is logged, and a draft
survives until the week rolls over. One stray tap left a session reading "In
progress" on the Train tab for days, and the only exit was to log a set you
didn't do and then delete the workout. **Fixed.**

**P1-9 · A required field on a cached view is a white screen on upgrade.**
Found by the preview harness while verifying the volume work: every screen paints
from a held snapshot on frame one, and the first launch after a deploy paints
from the *previous* build's shape. Shipping `totalVolume` as required threw
`Cannot read properties of undefined` and rendered nothing — for exactly the
athletes with the most history. **Fixed**, and this is now a standing rule worth
naming: *any field added to a cached view type must be optional.*

**P1-10 · No visible keyboard focus.** `:focus` styles existed on two input
classes and nowhere else, so tabbing through the app moved a highlight nobody
could see. **Fixed.**

### P2

**P2-11 · Rest timer is fixed at 90s.** No per-exercise value, no ±30s, no sound
or haptic. It is the one thing you interact with while *not* looking at the
phone, and it can't be adjusted. **Deferred** — see below.

**P2-12 · Readiness is declared and unbuilt.** Covered above.

**P2-13 · Set inputs had no accessible name** beyond a placeholder, so eighteen
fields in a session all announced as "lb" or "reps"; `Ring` and `Meter` were bare
divs, so the confidence meter — the whole point of the read card — announced as
nothing. **Fixed.**

**P2-14 · Negative weights and reps were accepted.** `<input type="number">`
with no floor; a typed `-45` went into the outbox, the volume total and the next
session's recommendation exactly as typed. **Fixed** (clamped at the source —
`min` on a number input is validation, not a restriction).

**P2-15 · A backdated queued session was filed on the day it was typed in.**
The week strip counted it on `performedAt`, History bucketed it on `queuedAt`, so
it appeared in the wrong week *and* escaped the dedupe against its own committed
row. **Fixed.**

**P2-16 · The type scale is fixed px, so OS/browser font scaling does nothing.**
Every size is a token (`--fs-*`), so this is a nine-line change to `rem` — but it
would reflow every screen in the app and there is no visual-regression baseline
to check it against. **Deferred**, with a note that it's cheap when someone can
look at the result.

**P2-17 · Duplicate exercise names within one routine collapse.**
`gatherExerciseBases`, `gatherExerciseHistory` and the week pager all key by
name and take the first match, so a session with two "Back Squat" entries (a
top set and a back-off) reads as one. Agent output rarely does this and the
program editor de-dupes, so it is latent rather than live. **Deferred.**

**P2-18 · Dead code.** Four unreachable screens and five orphan exports, all
pre-existing and already documented. **Deferred** — deleting exported components
is its own call, and none of it ships to the user (tree-shaken).

**P2-19 · No exercise media.** Cues are text-only, and only half the library has
them. **Deferred** — this is a content project, not a code one.

### Things I checked and found correct

Worth stating, because several are the failure modes this class of app usually
has:

- **Timezones / date boundaries.** `weekDates.ts` is the single source of Monday,
  every ISO date is built from local components (never `toISOString().slice(0,10)`),
  and date arithmetic anchors at local noon to survive DST. Phase advancement
  compares ISO date strings. Correct.
- **Offline and two-device conflict.** The outbox classifies each failure before
  acting on it (unreachable → stop the pass untouched; rejected → record and step
  over), retires permanent rejections by SQLSTATE, and handles the genuinely hard
  case: a session edited *while its own commit is in flight* bumps a revision and
  retargets rather than dropping the edit. Drafts merge across devices by
  recency. This is better than most production apps.
- **Connectivity.** `useOnline` refuses to trust `navigator.onLine` (which reads
  false on a healthy iOS home-screen PWA) and requires two failed probes to
  declare offline. Correct, and the reasoning is written down.
- **Log attribution across program edits.** `exercises_snapshot` freezes what a
  set's index means, so editing a routine can't relabel last month's squats as
  this month's calf raises. Correct, with checks.
- **0 reps / 0 weight.** Both are treated as deliberate entries rather than empty
  ones, and neither breaks the e1RM, the volume or the top-set selection.
- **PR ties.** Now explicitly *not* PRs — a tie leaves the record standing. An app
  that fires "PR!" on every repeat of a working weight teaches you to ignore the
  badge on the day it's actually earned.
- **Auth edge cases.** Magic link *and* OTP (the code path is what works in an
  installed PWA), sync hydration from the persisted session so a returning
  athlete never sees a splash, local-scope sign-out so it doesn't hang on bad
  signal, and a cache+draft wipe on `SIGNED_OUT`.
- **Deleting an in-progress workout** — was the gap; now closed.
- **Very long histories.** `gatherTrainingLog` caps at 150 sessions,
  `gatherExerciseBests` at 400, weekly back-fill at 16 weeks. Bounded.

### UX / IA observations (no code change)

- **Navigation depth is right.** Four tabs, ordered by real frequency, and detail
  consistently lives in sheets rather than inline. The mobile-UX pass in
  `docs/mobile-ux-audit.md` did this properly and I found nothing to undo.
- **Time-to-first-logged-set** is the strongest thing about the funnel: Splash →
  Arena → Limiter → Probe → auth → three orientation fields → a built session.
  No movement screen gate before the first workout. That is the right call and
  it's rare.
- **The one place the design is still fighting itself** is the workout header. It
  was deliberately cut back to a title, one metadata line and a progress bar; it
  wraps to two lines the moment a fourth field appears. I hit this adding live
  volume and moved the number to the debrief rather than re-crowding the strip.
  Anything else that wants to live up there has the same problem.
- **Contrast passes.** `#9A9A9A` on `#0A0A0A` is 7.0:1; on `#1A1A1A`, 6.3:1. The
  status colours all clear 4.5:1 on ground.

---

## Phase 5 — Fixed vs deferred

### Fixed, in five commits

| Commit | Area |
|---|---|
| `6328ce6` | Units: pinned storage unit, pure converters, `UnitContext` threaded through the engine, unit-aware plate increments. Plus `prs.ts` and `volume.ts` as pure modules, the Epley fix, one shared set predicate, backdated-session bucketing. **139 new checks.** |
| `fdf0a64` | PR badge in the set row, PR markers in history, volume in workout / history / recap / session sheet, the week-plan denominator unified |
| `240a79f` | Discard an in-progress session; `:focus-visible` ring; set-input accessible names; progressbar semantics on `Ring`/`Meter`; numeric floors |
| `819a090` | A first-ever set is a baseline, not a record; negatives clamped at the source rather than declared |
| `740e8d1` | New cached fields made optional (upgrade white-screen); live volume moved out of the sticky workout header |

Verification: `npx tsc --noEmit` clean, `npm run build` clean, `npm run check`
green across all seven check files (**487 assertions**, 139 of them new — the suite was 348), and the
`scripts/preview-loop.mjs` harness driven manually to confirm — on a real render
— that a set tying the record shows no badge while the set beating it does, that
the live volume adds up (225×5 + 235×5 = 2,300 lb), and that a stored 225 lb
reads as `225lb` under lb and `102.1kg` under kg where it would previously have
read `225kg`.

### Deferred, with reasoning

| Item | Why not in this pass |
|---|---|
| **Readiness / HRV gate** (P1) | Needs a designed rule, not just a UI. A readiness input that adjusts the prescription can tell someone to deload when they're fine; the mapping from sleep/soreness to RPE target is a product decision, and whether Zeroed asks a question before every session is yours to make. The socket is already cut. |
| **Rest timer configurability** (P2) | Small, but it's the one control used without looking at the screen, so it wants a designed interaction (±30s on the pill? per-exercise defaults from the phase?) rather than two buttons bolted on. |
| **rem type scale** (P2) | Nine-line change; reflows every screen. No visual-regression baseline exists, so shipping it blind in a pass that already touched the logging path is the wrong trade. |
| **Duplicate exercise names** (P2) | Latent, not live — agent output rarely repeats a movement and the editor de-dupes. The real fix is a stable per-exercise id in `ExerciseTemplate`, which is a schema change and a migration of every stored routine. |
| **Dead code removal** (P2) | Pre-existing, documented, tree-shaken. Deleting exported components is a separate call and would bloat this diff without changing anything a user sees. |
| **Exercise media** (P2) | Content, not code. |
| **Strength score** (P2) | Real product design — it needs population norms per lift per bodyweight per sex, and Zeroed doesn't collect bodyweight. |
| **Watch / HealthKit** (P2) | Blocked on generating the iOS project. |
| **Block-level volume** (P3) | Session and week are the ones that change behaviour; block-level wants a chart, and a chart wants a design pass. |

### One assumption I made without asking

The storage unit is **pinned to whatever the display unit was when the new code
first runs** — `lb` for everyone who never touched the toggle, `kg` for anyone
who did. That is the only interpretation under which existing data means what it
meant: before this change, displayed unit and stored unit were the same thing by
definition. It also means the fix is non-destructive — no stored number is
rewritten, ever.

---

## If I had one more week

In priority order.

1. **Build the readiness gate, and make it the wearable story.** Three taps
   before a session (sleep / energy / soreness, all optional, all skippable),
   feeding the same autoregulator the felt chips feed. Then the rule: readiness
   moves the *RPE target*, not the load directly — a bad night buys you a point
   of target RPE, which the existing per-lift autoregulator already turns into a
   load step. That keeps one decision path instead of two. Once that exists,
   HealthKit is a source swap, and Zeroed can honestly claim the thing nobody in
   this category does.

2. **Make the retest test the athlete's actual lifts.** Right now the strength
   half of the rescreen is a fixed battery. The whole app is built on "your
   program scales to your tested maxes" — so the retest should re-test the lifts
   your program is actually built on, and the delta should feed the phase-design
   agent directly. This is the highest-leverage week of work in the app because
   it closes the one loop that's still open at the top.

3. **A strength score, built on the model that's already there.** Not a vanity
   percentile — a per-chain rating (Lower / Posterior / Upper / Core) that makes
   the read concrete: "your posterior chain is the weak one, here's how far
   behind it is, here's it closing." Zeroed already reasons in exactly these
   categories, and the athlete currently has no way to see the gap as a size.
   Needs bodyweight collected, which is one field.

4. **Volume as a picture, per block.** The data exists now. One chart on Program:
   load moved per week across the block, with the directive that produced each
   week marked on it. That's the app explaining itself, which is what it's for.

5. **Visual-regression baselines, then the rem type scale.** `preview-loop.mjs`
   already screenshots every screen; committing those as baselines and diffing
   them in the check script would make the accessibility work above (and every
   future layout change) safe to ship without a person looking at eleven
   screenshots.

6. **The rest timer, properly.** Per-exercise defaults from the phase (a Strength
   block wants 3 minutes on a main lift and 60s on an accessory; it currently
   gives both 90s), ±30s on the pill, and a haptic when it ends.

---

## Appendix — running the checks

```bash
npm run type-check    # tsc --noEmit
npm run check         # all seven *.check.ts files (487 assertions)
npm run build         # production build

# visual, ad hoc (playwright is deliberately not a project dependency)
npm i -D playwright
npm run dev -- --port 5199
node scripts/preview-loop.mjs      # every loop screen at iPhone dimensions
node scripts/preview-funnel.mjs    # the signed-out funnel
```
