# Changelog

## Unreleased

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
