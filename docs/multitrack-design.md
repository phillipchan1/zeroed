# Multi-track programs, structured goals, and MCP

Section 10 design note for the coach spec (Zeroed tracks / goals / MCP).
This is the model we are shipping. Product calls that the spec left open
are listed at the end and repeated in the PR under **Decisions made**.

## What exists today

A Zeroed program is still one weekly template: `program` → `phase` →
`routine` (session) → `exercises` JSONB. Working max / training max live
on `athlete.training_max_overrides` for bench, OHP, squat, deadlift.
The athlete target is free text on `athlete.goals`. There is no
`workout_note` table.

`preview_program_edits` / `apply_program_edits` already accept
`add_note`. That edit does **not** write a workout note. Preview
collects the strings in memory. Apply concatenates them onto a single
`coach_message` row (`kind = 'phase_change'`, `ref_id` = the live
phase) after the reshape summary. The Coach-screen path
(`applyCoachActions`) inserts `coach_message` with `kind = 'note'`.
Neither path attaches text to a logged session.

## Model we are shipping

Keep the live week as JSONB on `routine`. Adding a relational
`exercise` table would rewrite logging, snapshots, the editor, and
the lift model. New fields land on the existing exercise object:

- `track_id`, `superset_group` (`A1` / `A2` / …), `rest_s`, `contacts`

New tables (all keyed by `id`, additive, reversible by dropping them
and ignoring the new JSON keys):

| Table | Owner key | Purpose |
|---|---|---|
| `track` | `program_id` | Named quality inside one program |
| `progression_rule` | `program_id` + `track_id` | Engine + params; optional exercise name |
| `autoreg_rule` | `athlete_id` | `if signal op value then action` |
| `athlete_goal` | `athlete_id` | Structured goal (not `athlete.goals`) |
| `goal_measurement` | `athlete_id` + `goal_id` | Dated values, `client_key` unique |
| `workout_note` | `athlete_id` | Notes on a workout or a session template |

`progression_rule.program_id` and `goal_measurement.athlete_id` are
denormalized so the Worker data plane can reuse existing owner
predicates (`via program` / `athlete_id =`) without new interpolation
strings.

Program block metadata is additive columns on `program` — `name`,
`block_phase`, `end_date`, `deload_week_start`, `retest_start`,
`retest_end`. The existing `phase` table (Stability / Strength /
Power / Sport, one active week-block) is unchanged. The spec's
"settable phase" is the free-text `block_phase`, not a new value in
the `phase.name` check.

`athlete.goals` stays. The free-text value is copied into a goal
note for Phil. `update_athlete_target` still writes the legacy field.

## Tracks

Every non-`external` program gets a `General` track via backfill
plus app/seed inserts. There is no INSERT trigger: data-only restore
cannot disable triggers on Neon, and a trigger-created General
collides with the dumped row. Missing `track_id` on an exercise
resolves to General at read time. Nothing in the unflagged UI changes.

Phil (auth email `phillipchan1@gmail.com`) also gets the five named
tracks from the spec, with exercises classified by name / session
name. Classification is additive (`track_id` only). Loads, sets,
reps, and `training_max_overrides` are not touched. Deadlift TM
stays whatever is already stored (410).

A session may mix tracks. Friday is the fixture: Lifting +
Conditioning/Power + Hypertrophy in one routine, grouped in the UI.

## Progression engines

Engines propose. They never write the live week. The coach (human or
agent) calls `get_track_progression`, then `preview_program_edits` /
`apply_program_edits` with `confirm=true`.

| Type | Next-week rule (Phil fixtures) |
|---|---|
| `tm_wave` | Bench TM wave; bump TM +5 next cycle if top set ≤ RPE 8 |
| `rpe_autoreg` | OHP +5 only if every set ≤ target RPE; else hold |
| `double_progression` | DB bench +5 only if every set hit the top of the range |
| `maintenance` | Squat / DL: a rep PR at RPE ≤ 8 is "held"; no maxing |
| `time_interval` | Alactic 8× → 10× rounds; lifts untouched |
| `contacts` | Cap 40–80; broad jump distance feeds the goal |
| `measurement` | Hip IR / knee-to-wall / wall test |
| `manual` | Basketball — coach sets values |

## Autoregulation

Rules are rows, not code. Signals: `pain_knee_L`, `pain_knee_R`,
`sleep_hours`, `set_rpe`, `all_sets_rpe_max`, `warmup_quality`,
`bar_speed_drop`. Actions: `drop_exercise`, `swap_exercise`,
`reduce_load_lb`, `reduce_load_pct`, `cap_depth`, `hold`, `deload`.

Fired rules render on the workout screen ("Knee 6/10: no squats
today"). Evaluation is deterministic and runs from the session
check-in (already on `workout`) plus in-progress draft values.

Phil's seeded rules:

- knee > 5/10 → drop squats, lunges, jumps
- knee > 3/10 → drop jumps / plyos
- knee 4–5/10 on a squat day → 265 or cut depth
- bad sleep → −10 lb, hold RPE
- shaky OHP warm-up → 85% of planned load

## Goals

`athlete_goal` + `goal_measurement`. Status is computed:

- `hit` — current meets the target (higher / lower / pass)
- `behind` — due date is near or past and trend is flat or away
- `on_track` — otherwise, including "pending" baselines

L/R sides are two goals that share a name stem (`Hip IR L`,
`Hip IR R`) so the UI can pair them. History is the measurement
list. Logging a matching set (broad jump distance, bench e1RM)
appends a `workout_log` measurement when the flag is on; retries
use `client_key`.

## Feature flag

`tracks_v1` on `athlete.flags`. Only literal `true` counts, same as
`arc_load_v1`.

No build-time ceiling. We cannot set `VITE_*` in `.github/workflows`
(out of scope), and Phil needs to see the UI the day this merges.
The new screens ship in the build; they render only when the
athlete row says so. Migration turns the flag on for Phil.
Rollback: `UPDATE athlete SET flags = flags - 'tracks_v1'`.

DEV builds still accept `?flag=tracks_v1`.

MCP tools are always available to the coaching agent. The flag only
gates the app chrome.

## RPE

Unset target RPE stays unset and displays as `—`. New exercises do
not default to 1. The lift model's phase-target fallback still
applies to *load suggestions* when a lift has no target of its own
(otherwise we regress #35 / the existing prescription path). We do
not rewrite live `target_rpe = 1` rows — we cannot prove they were
never coach-set.

Half-steps remain behind the existing RPE flag.

## Preview any week

`preview_program_edits` gains optional `week_start`. If that Monday
matches a queued block, the preview applies to that draft. Otherwise
it applies to the live template and labels the header with the
requested week. There is no per-week snapshot store beyond
`timing=next_week`.

## MCP conventions

Every new write takes `confirm` (default false), optional
`client_key`, and `rationale`. Without confirm: `{ diff, warnings,
preview_id }`. With confirm: the saved object. `preview_id` is a
sha256 of the canonical payload; apply still takes the full
arguments (same as today's `apply_program_edits`). Dates are
`YYYY-MM-DD`. Timestamps are UTC ISO plus `local` / `local_date`
in the athlete's zone (else America/Los_Angeles).

Names fuzzy-match the way `session_name` does today; ids win.

## Migration

Additive, idempotent, reversible (drop the new tables / columns /
JSON keys; `flags - 'tracks_v1'`). Safe against Phil's live row:

- Does not `UPDATE` `training_max_overrides`
- Does not change sets / reps / load
- Sets program dates only where the new columns are null
- Copies `athlete.goals` into a note; does not delete the column
- Deadlift TM in any new rule params is a *read* of the current
  override (410)

Do not run this against prod from this agent. The SQL is written so
Phil (or the usual migrate path) can apply it.

## UI (flag on)

- Today + workout: exercises grouped by track color, A1/A2 pairs,
  fired rules inline, one-line "why" + next-week rule
- Program: week × track coverage grid, per-track progress
- Goals: bars (baseline → current → target), sparkline, L/R pair,
  due-date chip, status color
- Measurement sheet: L/R, offline-safe `client_key` (reuses #45)
- Slow-connection state from #46 is unchanged — we do not add a
  second workout cache

When the flag is off, every existing screen is byte-identical in
behavior. General-track rows exist but are not shown.

## Tests

Fixtures are Phil's week: OHP 4×4 @115 all ≤ RPE 7 → propose 120;
one set at 7.5 → hold. DB bench 4×8 @100 → 105; 8/8/7/7 → 100.
Alactic 8 → 10 rounds, lifts untouched. Broad jump 97" updates the
goal. Hip IR 30/34 both below 35. Knee 6/10 drops squats; 4/10
shows 265 or cut depth.

## Decisions made

1. Exercises stay JSONB; no new `exercise` table.
2. `athlete_goal` not `goal`, to avoid colliding with `athlete.goals`.
3. `program.block_phase` is free text; `phase.name` enum is untouched.
4. Owner keys denormalized (`progression_rule.program_id`,
   `goal_measurement.athlete_id`) so isolation-mutation keeps working.
5. Flag is athlete-row only — no `VITE_TRACKS_V1` ceiling.
6. Phil's five tracks and goals are seeded in the migration so the
   app is populated the day the flag is on. Assignment is `track_id`
   only.
7. Live `target_rpe = 1` rows are not rewritten.
8. Preview `week_start` uses the queued block when it matches,
   otherwise the live template with a labeled header.
9. Goals L/R are two rows, paired in the UI by name stem + side.
10. Local MCP (`mcp/`) and Worker MCP advertise the same tool names.
11. One PR, not a data/UI split — Phil wants this on master.
12. `add_workout_note` is the write path for real workout notes;
    `add_note` on program edits stays a coach-inbox message so we
    do not change the meaning of existing transcripts.
13. Goals is a first-class screen at `/app/goals`. When the flag is
    on, it is a fifth nav item (between Program and Coach) and a
    Profile row. When the flag is off, nav stays four items.
14. Local MCP (`mcp/`) advertises the same tool names; the hosted
    Worker implements the writes. Local handlers return a parity
    notice so `mcp:check` stays green without a second SQL port.
15. Measurement `client_key` is `gm:{goalId}:{date}:{side}` on the
    app path; MCP callers pass their own. Unique on
    `(athlete_id, client_key)`.
16. Column names follow the migration: `goal_measurement.measured_on`,
    `workout_note.body` / `session_id`.
17. Preview payloads include `utc` / `local` / `local_date` via
    `writePreview`, so every new write preview matches the stamp
    contract without each tool repeating it.
18. `/app/goals` and `/app/program/track/:trackId` redirect to Program
    when the flag is off, so a bookmarked URL cannot leak the new
    screens to an unflagged athlete.
19. No `AFTER INSERT` trigger that writes `track` rows. Restore is
    data-only and cannot `--disable-triggers` on Neon; a trigger-created
    General collided with the dump (`23505`). General is backfilled for
    existing programs, seeded in fixtures, and created beside new
    active programs in app code.
