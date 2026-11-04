# Changelog

## Unreleased

### Methodology as config (G3), preview validators (G5), proposal created_by (G10 follow-up), tracks_v1

Behind `athlete.flags.tracks_v1`; with it off `/api/session-rx`, previews, proposals and the MCP tool list are byte-for-byte as before, and no new column or table is read or written.

- **One global, versioned ruleset.** `worker/src/methodology/v1.ts` holds U1–U15, the under-18 rules and the 24 h preview expiry as data, version `v1`. Where the engine already had the number (TM 90%, +2.5%/+5% pushes, deload 65% TM @ RPE ≤ 6, 24 h, 30% small-edit cap) the default equals it; the lift model now takes these as optional params and is identical without them. U4 records `e1rm_source: rpe_chart` (what the engine does) rather than Epley.
- **Per-athlete overrides.** New append-only `methodology_override` (athlete, optional track, path, JSONB value, who, approval, preview, change_log row; superseded once). Effective params = global → athlete → track → under-18 clamp. Paths are a closed, typed, range-checked schema. Under-18 rules only tighten; for a minor nothing loosens; the universal pain cap stays ≤ 3/10; the raised cap (≤ 5/10 if settled next morning) is a per-region opt-in that needs a date of birth showing 18+ and is refused on a red-flagged region; a red flag can be set by a coach and cleared only by the athlete; red flags block loading.
- **MCP (flag on).** `get_methodology`, `preview_methodology_override`, `apply_methodology_override` (confirm + preview < 24 h with unchanged diff + the athlete's approval, logged in change_log with `rule_refs`). `preview_session_override` takes `rule_refs` and `rewrite`; `preview_program_edits` takes `rewrite`.
- **Every prescription records its methodology.** Flag on, `/api/session-rx` adds `methodology_version` (`v1`, or `v1+<hash>` with overrides or the under-18 rules) to the response and each prescription, runs the lift model on the resolved params, caps RPE at 8 under 18, and skips exercises that load a red-flagged region. With defaults the numbers and version strings are unchanged. `change_log.methodology_version` is filled on every row.
- **Preview validators.** Program-edit, week-only override and proposal previews return `warnings: [{ rule, message, target }]` for U8 session order, U9 interference (HIIT count, HIIT the day before heavy legs) and U10 supersets (two heavy compounds, press + triceps, anything + plyo, grip + deadlift, top sets ≥ RPE 9, main-lift rest). Only new violations are reported; unknown exercises never warn. U13 (> 30% of the week's exercises changed without `rewrite=true`; one exercise is always surgical) and red flags fail the preview.
- **created_by on proposals.** New proposals record `mcp:<token id>` / `app_coach`; approvals of them name that coach. Revoking a coach now also marks its pending proposals stale (`voided_at`) and voids their unconsumed approvals, logged on the `revoke_coach` row. Older rows (NULL) are left alone.

**Deploy:** hand-apply `worker/schema/methodology.sql` on Neon (`supabase/migrations/20261104000005_methodology.sql` on Supabase) after `approval.sql` and BEFORE deploying this Worker for anyone with `tracks_v1` on. Rollback is in the SQL header: drop the flag per athlete (instant), or redeploy the previous Worker; the table and columns can be dropped afterwards.

### Approval capture (G10, tracks_v1)

Behind `athlete.flags.tracks_v1`; with it off no `approval` row is written, the MCP tool list and schemas are exactly as before, Accept applies as before, and `/api/approvals` answers 404.

- **The athlete's yes is a row.** New append-only `approval` (id, athlete, created_at, `preview_id`, `preview_kind` program_edits | session_override | revert | proposal | change | app_editor, `diff_hash` = SHA-256 of the diff the athlete saw, `channel` tap | chat, `message_id`, the coach that asked, `consumed_at` + `consumed_by_change_id`, `voided_at`). A trigger allows only consuming it once or voiding it once; DELETE only with the athlete's account. `change_log` gains `approval_id`, so every row's `approval_ref` links to its approval.
- **Only the athlete creates one.** `POST /api/approvals { action: 'approve', preview_id }` (a tap) or `{ ..., message_id }` (a chat yes: the message must be the athlete's, written by them, not the coach, and newer than the preview). Coaches (MCP or `app_coach`) cannot create approvals; the generic data route can't write the table. `approval_ref` is now `tap:<approval id>` or `msg:<approval id>`.
- **Every apply resolves it.** G2 write tools, `apply_program_edits` (edits or `proposal_id`), proposal Accept, `apply_session_override` (apply and clear), undo and the in-app editor all check: same athlete, same preview, `diff_hash` equals the diff recomputed now, under 24 h, not consumed, not voided, its coach still has access. The write consumes it in the same transaction (in the same SQL statement for overrides) and names the `change_log` row. Single use. `standing:logging` still covers logging only. Free-form `msg:<id>` refs are refused.
- **Accept is approve + apply.** The proposal card's button reads Approve; the tap records an approval of exactly that proposal and the apply spends it. Undo and the athlete's own override apply mint their tap server-side the same way.
- **MCP.** `list_approvals(preview_id)` shows an outside coach the athlete's approvals of a preview it made, so it can apply with that ref. Preview footers and tool descriptions say so.
- **Revocation.** Revoking a coach voids its open previews and every unconsumed approval of them at once, and the `revoke_coach` change_log row names both.

**Deploy:** hand-apply `worker/schema/approval.sql` on Neon (`supabase/migrations/20261104000004_approval.sql` on Supabase) after `change-log.sql` and BEFORE deploying this Worker for anyone with `tracks_v1` on. Rollback is in the SQL header: drop the flag per athlete (instant), or redeploy the previous Worker; the table and column can be dropped afterwards.

### change_log, get_change_log, Changes feed and one-tap undo (G2, tracks_v1)

Behind `athlete.flags.tracks_v1`; with it off no `change_log` row is written, the MCP tool list and schemas are exactly as before, writes need no approval, `/api/change-log` answers 404 and Program has no Changes feed.

- **One accountable record.** New append-only `change_log` (spec section 6: actor, tool, target, before → after diff, rationale, `rule_refs`, `approval_ref`, `preview_id`, `expires_on`, `reverted_by`, `revert_of`). A trigger refuses every UPDATE except setting `reverted_by` once, and every DELETE except the athlete's own account deletion. `program_revision` and `session_override_log` are still written exactly as before; nothing historic is copied.
- **Every covered write logs one row, in the same transaction or statement:** `apply_program_edits`, proposal Accept (app or MCP), every track / rule / goal / target / block write, `set_training_max` over MCP, week-only override apply and clear (a move is one change), the in-app editor's `program_revision`, voided previews, and coach revocation. `rule_refs` come from `U1`–`U15` named in the rationale or passed as `rule_refs`.
- **Approval everywhere, not just overrides.** Logging (`log_goal_measurement`, `add_workout_note`) is `standing:logging`. Every other confirmed MCP write needs `approval_ref = msg:<id>` and the `preview_id` its preview returned (kept in `change_preview`, under 24 h old, diff — including the target's current state — unchanged); a proposal stands in for the preview and must be under 24 h old. `app_coach` can never approve. Flag-on write tools advertise `approval_ref`, `preview_id` and `rule_refs`.
- **Revocation.** Revoking a coach in the app voids its open previews (both kinds) at once and logs it, in the revoke's transaction.
- **MCP.** `get_change_log(since, target?, actor?, limit?, before?)`: athlete-scoped, newest first, paginated. `preview_revert_change(change_id)`: what an undo would restore, or why it can't; it writes nothing and marks the change as suggested in the athlete's feed. There is no coach-side apply.
- **Undo (athlete only).** `POST /api/change-log { action: 'revert', id }` or `POST /api/change-log/:id/revert`. Restores the target only if it still looks exactly as the change left it (otherwise "changed since"), writes a new row with `revert_of`, sets `reverted_by` on the original, and refuses a second undo. Supported: program edits and proposals applied this week (not ones that queued next week's block or added a session), track updates, progression rules (ended, not deleted), goal definition updates, the athlete target, block details, week-only overrides (voided, kept), and training maxes (only that lift, back to its prior value). Creating a track, goal or autoreg rule, logging, and clears are refused with the reason; nothing is ever deleted.
- **App.** Program → Changes: who (You / Claude or the coach's name / Coach / System), what, why with rule refs, when, an Undo with a confirm, and Undone state. Pull to refresh reloads it.

**Deploy:** hand-apply `worker/schema/change-log.sql` on Neon (`supabase/migrations/20261104000003_change_log.sql` on Supabase) BEFORE turning `tracks_v1` on for anyone, then deploy the Worker. Rollback is in the SQL header: drop the flag per athlete (instant; writes go back to today's path); the tables can be dropped afterwards.

### Week-only session overrides (G1, tracks_v1)

Behind `athlete.flags.tracks_v1`; with it off, `/api/session-rx`, the MCP tool list and the app are unchanged.

- **One date, not the template.** A `session_override` row changes ONE dated session: add, swap, drop or adjust an exercise, or move an exercise or the whole session to another day (a move is a `move_out` row on the source date and a `move_in` row on the target, sharing `pair_id`). Program, phase and routine rows are never written.
- **Engine applies it on that date only.** `POST /api/session-rx` with `date: YYYY-MM-DD` reads that date's active overrides into the session's exercise list before the engine prescribes it, and returns `prescription.override` (the day's list, a mark per changed index, drops and moves, labeled "This week only"). No `date`, no flag, or no override → the old response, byte for byte. An override never applies after `expires_on` (default: the Sunday ending the date's ISO week; at most date + 7). Expired and cleared rows stay for audit.
- **Propose-only writes.** New MCP tools (listed only with the flag): `preview_session_override`, `apply_session_override`, `list_session_overrides`, `preview_clear_session_override`. Preview stores a preview and writes no override. Apply needs `confirm=true`, a preview under 24 h old whose diff (including the resulting session that day) still matches, and `approval_ref`: an MCP coach passes `msg:<id>`, the athlete's own tap is `tap:<id>` minted by the Worker, and standing approval never covers it. `app_coach` can never supply `approval_ref`; it parks a `coach_proposal` (`kind = 'session_override'`) and the athlete's Accept applies it. A coach can't apply a preview parked for the athlete. Previews made by a revoked or expired coach token are void, and the void is logged.
- **Audit.** Every apply and clear writes `session_override_log`, shaped like the spec's `change_log` (actor, tool, target, diff, rationale, approval_ref, preview_id, expires_on) so G2 can lift it across.
- **App.** Train shows a "This week only" badge on an overridden session and, in its sheet, the day's list with a badge on each changed exercise; Program's session list shows the same badge. Proposal cards for overrides say "This week only."

**Deploy:** the Worker (`npm run cf:deploy`) and `worker/schema/session-override.sql` hand-applied on Neon (`supabase/migrations/20261104000002_session_override.sql` on Supabase). Until the tables exist, session-rx ignores overrides and the tools report them unavailable. Rollback is in the SQL header: drop the flag per athlete; the tables can be dropped afterwards.

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
