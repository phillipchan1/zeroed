# Changelog

## Unreleased

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
