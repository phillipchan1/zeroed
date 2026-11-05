# Changelog

## Unreleased

### Passive progress: every set is evidence, tests are confirmations (tracks_v1)

Plan and reasoning: [`docs/passive-progress-plan.md`](docs/passive-progress-plan.md). Behind `athlete.flags.tracks_v1`, like the rest of goals. No schema change.

- **Strength estimates off the RPE chart.** `e1rm` goals read the RTS reps × RPE chart (`liftModel.e1rmFromSet`) instead of Epley. Sets under RPE 7, over 10 reps, or with a missed rep say nothing and aren't read; a set with no RPE is a floor. Every usable session writes (no more hold-or-beat for rolling kinds), so working sets at RPE 8 keep a goal current without a test day. A low-readiness day (check-in 4 or under) that lands under the goal doesn't move it.
- **Evidence tiers.** Each session reading is tested (a single @9+, a jump, a measured hold), strong (two heavy sets of 1–3 @8+ within 2%), estimate, or inferred. The tier rides in the measurement's note (`Bench Press — 285×3 @8 · estimate`), readable and parsed back (`engine/evidence.ts`).
- **Capacity, not latest.** A rolling goal's current is a recency- (half-life 21 days) and tier-weighted read of the last 6 weeks, with a range that widens for weaker evidence and for every week without any (`engine/capacity.ts`). Goal pages show Tested / Estimated / Inferred / Stale and the range; measurements show the set behind each one.
- **Tests only with a reason.** Needs a test now says why: no evidence yet, no usable sets in 4 weeks (stale), or a manual measurement whose cadence lapsed. Cadence no longer applies to goals sessions feed. New status **To confirm**: an estimate is at the target; Zeroed needs a tested or strong reading. `goalRead` is the one read the app and the Worker share.
- **New goal kinds.** `relative_e1rm` (÷ session bodyweight; pull-ups and dips add it), `reps_to_failure` (8 @8 is 10), `output` (mean cal / m / W per round), `fade` (last round ÷ first), `success_rate` (makes ÷ attempts, 10+). Sets carry optional `output`, `output_unit`, `avg_hr`, `attempts`, `makes`; interval blocks get an output row per round, and a set row grows a makes/attempts or output line when a goal on that exercise reads it.
- **Lift families and weak links.** Code-owned ratio priors between related lifts (`engine/liftFamilies.ts`: DB bench ≈ 0.40 of bench per hand, front squat ≈ 0.83 of back squat, …). An e1rm goal whose lift isn't in a session moves from a related one as an inferred reading. After 6 paired weeks the athlete's own ratio (shrunk toward the prior) replaces it. `engine/weakLinks.ts` flags pairs that drifted off the athlete's own ratio (or off the prior before there's history) and L/R goals more than 10% apart, with what it usually means. Goals shows the biggest one.
- **Cross-domain signals.** `engine/signals.ts` reads interference (conditioning load up 30%+ while the main lifts go flat), fatigue (low-readiness days running under), transfer (squat up, jump flat) and engine (fade improving or worsening), as hypotheses. Nothing changes a status or a load from them.
- **Claude.** `get_goals` / `get_goal_history` / `get_goal_brief` return `capacity`, `test_reason` and the new `confirm` display; the brief adds `weak_links`, `signals` and latest `lifts`, and says to put confirming sets and mobility checks inside existing sessions as proposals. `log_goal_measurement` recomputes current from all measurements. The finish screen's goal beat reads What today told us, tagged Estimate / Inferred / Confirm it / Zeroed.

**Deploy:** the frontend ships with the build; the Worker needs a deploy for the MCP changes. Nothing to migrate.

### Goals at the center (tracks_v1)

Everything here is behind `athlete.flags.tracks_v1`; flag-off athletes see no change.

- **Status in the brand's colors.** Goals read Zeroed (confirmed), On course (text), Off course (signal), or Needs a test (pending), each with its own mark shape. Status comes from a forecast: least squares over the last three real measurement days (spanning at least a week), projected to the due date, so a stalled lift is off course weeks out instead of only inside 21 days. A goal tested on a cadence needs a test once the cadence lapses. MCP `get_goals` / `get_goal_history` return the same `display` and `forecast`.
- **Lanes by glyph.** Tracks draw their stored `icon` instead of a color that matched a status token.
- **Sets move goals.** `athlete_goal.source_metric` is a typed binding (`e1rm:`, `top_set:`, `reps:`, `distance:`, `time:`, `rounds:`, `test:`), inferred only when a goal's name matches an exercise exactly; `upsert_goal` validates the kind and that the goal's unit can be reached. Committing a session writes a `workout_log` measurement for each goal it held or beat (client_key `wl:{workout}:{goal}`), even when the outbox syncs before the flag loads; editing the session corrects or removes that measurement and recomputes current and best. Train lists the goals each session moves, the workout carries each exercise's goal and locks on a new best, and the finish screen adds Goals moved.
- **Goals is the home of the plan.** Four tabs (Train, Goals, Coach, You); Program is the block's detail under Goals. Goals opens on the athlete's sentence, the goal reticle, the goal that needs you, targets by lane, and the block as a road. Each goal has a page (`/app/goals/:goalId`) with a forecast chart, its lane, measurements, and coach moves. A new block copies named lanes forward and moves goals onto them.
- **Coach moves.** For athletes with the flag, confirmed MCP track, goal, and rule writes record a coach note pinned (`ref_id`) to what they touched, with the rationale.
- **Claude plans from goals.** New `get_goal_brief`. `preview_program_edits` with `propose=true` parks the preview as a proposal; the app shows it on Coach, on the goal it serves, and on the Goals card. Accept (`POST /api/proposals`) or `apply_program_edits(proposal_id)` claims the proposal, applies exactly the stored edits, refuses as stale if the program changed since, and releases it if nothing was written.

**Deploy:** the frontend ships with the build. Proposals need the Worker deployed (`npm run cf:deploy` or the deploy-cloudflare workflow) and `worker/schema/coach-proposal.sql` hand-applied on Neon (`supabase/migrations/20261104000001_coach_proposal.sql` on Supabase). Until both, the tools report proposals as unavailable and the app shows none; everything else works against the current Worker.

### Worker: written load and manual rules beat TM

- `get_lift_model` "This week" uses the session's written `load` (295 / 350). A `manual` progression rule never computes from TM. TM / chart math is the fallback only when no load is written and the rule is not manual. Deploy the Worker to pick this up on refresh — no iOS build required for the Coach / MCP path.

### Session preview: written load and planned order

- Track-grouped preview, active session, and logging defaults show a written `load` (295 / 350) instead of TM / lift-model math (335 / 400). Flag-off uses the same resolver.
- Track groups follow the first exercise of each track in session order. Interleaved tracks fall back to one list so Deadlift stays before Squat.

### tracks_v1 follow-up

- Goal status is recomputed on read. Higher is hit only at `current >= target` (and `<= target_range_hi` when that ceiling is set). Lower is hit only at `current <= target`. Pass is hit only on a pass. Postgres string numerics are coerced so Broad jump 95 / 100 cannot lexicographically compare as hit.
- `last_measured` is the latest real `goal_measurement.measured_on`, or null. Seed `client_key` `seed:*` rows and invented dates (2026-10-01) do not count. No data migration; stored `athlete_goal.status` is ignored on read.

- Named tracks / goals / rules seed is a local gitignored SQL file applied by `scripts/seed-athlete-tracks.mjs` (email from env). Migrations stay schema-only. The `tracks_v1` flag is enabled per athlete with `scripts/enable-tracks-flag.mjs`. Prod data is left in place.
- Personal emails, health notes, and the Phil seed files are out of the public tree.
- Every non-`external` program-create path inserts a General track (app, ComputeScreen, Worker `/api/data`, `create_track`).
- Unstamped `target_rpe = 1` is a Coach / preview proposal the athlete approves. Coach writes stamp `rpe_source`. Never rewritten silently.
- `worker/schema/tracks-v1.sql` matches Neon (`app.sql` style): no RLS / GRANT / `authenticated` / `get_current_athlete_id()`. Double-escaped `\\bohp\\b` and `tm_override_value` decimal regexes use a single backslash.

### tracks_v1 — multi-track programs, structured goals, MCP

Named tracks inside one program, progression / autoregulation rules, structured goals with measurement history, and workout notes. Behind `athlete.flags.tracks_v1`. Deadlift TM is not rewritten. General tracks are backfilled and created in app/seed code — not by an INSERT trigger, so data-only restore stays valid.

New MCP tools: `list_tracks`, `get_track`, `create_track`, `update_track`, `assign_exercise_to_track`, `get_track_progression`, `set_track_progression_rule`, `list_autoreg_rules`, `upsert_autoreg_rule`, `get_goals`, `upsert_goal`, `log_goal_measurement`, `get_goal_history`, `add_workout_note`, `update_athlete_target`, `update_program_meta`.

`preview_program_edits` accepts `week_start` and exercise `track` / `superset_group` / `rest_s` / `contacts`. `add_note` on program edits is still a coach-inbox message; real session notes use `add_workout_note`.
