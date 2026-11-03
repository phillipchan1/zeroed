# Changelog

## Unreleased

### tracks_v1 — multi-track programs, structured goals, MCP

Named tracks inside one program, progression / autoregulation rules, structured goals with measurement history, and workout notes. Behind `athlete.flags.tracks_v1` (on for Phil by default). Deadlift TM is not rewritten. General tracks are backfilled and created in app/seed code — not by an INSERT trigger, so data-only restore stays valid.

New MCP tools: `list_tracks`, `get_track`, `create_track`, `update_track`, `assign_exercise_to_track`, `get_track_progression`, `set_track_progression_rule`, `list_autoreg_rules`, `upsert_autoreg_rule`, `get_goals`, `upsert_goal`, `log_goal_measurement`, `get_goal_history`, `add_workout_note`, `update_athlete_target`, `update_program_meta`.

`preview_program_edits` accepts `week_start` and exercise `track` / `superset_group` / `rest_s` / `contacts`. `add_note` on program edits is still a coach-inbox message; real session notes use `add_workout_note`.
