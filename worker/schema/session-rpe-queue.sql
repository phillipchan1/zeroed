-- session_rpe queue columns on Neon (Round 2 item 4, tracks_v1): offline
-- session-RPE taps and rating last night's session after midnight. Hand-apply,
-- like session-rpe.sql: no RLS, no GRANT (the Worker scopes every query by
-- athlete). Mirrors supabase/migrations/20261104000011_session_rpe_queue.sql.
--
-- Additive and idempotent: two ADD COLUMN IF NOT EXISTS on session_rpe (both
-- nullable, no default, so no existing row is rewritten) and one partial
-- unique index. Does not touch workout (neither workout.rpe nor
-- workout.session_rpe), program, routine, program_revision, change_log rows
-- or athlete.training_max_overrides.
--
-- client_id   the app's id for the tap the row holds now, minted at the tap.
--             A retry of the same tap (the first send landed, its answer was
--             lost) is "already logged": no second change_log row.
-- tapped_at   when that tap happened. For a queued tap, the app's clock,
--             trusted only within bounds (not in the future, not older than
--             48 h, and inside the session date's window); otherwise the
--             server's. A queued tap older than the row's current one is
--             acknowledged and dropped, never applied over a newer rating.
--
-- The window (worker/src/sessionRpe.ts): a session dated D can be rated from
-- D 00:00 until D+1 04:00, athlete-local. Before this file only the window's
-- server-clock half works (a tap sent after midnight, before 04:00); queued
-- taps are taken as if sent now, and retries are not deduped.
--
-- Apply this AFTER session-rpe.sql (and change-tombstone.sql) and BEFORE
-- deploying this Worker for anyone with tracks_v1 on. With the flag off
-- nothing here is read or written: /api/session-rpe answers 404, the app
-- queues nothing, and /api/session-rx, the MCP tool list and every tool behave
-- exactly as before.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off the app shows no tap and sends nothing; a tap still
--      queued on a device is dropped on its next sync (the route answers 404).
--   2. Code rollback: redeploy the previous Worker. It never names these
--      columns; ratings keep working on the day only, and retries of a queued
--      tap the old Worker sees are refused or updated by value as before.
--   3. Optional, once nobody needs them:
--        DROP INDEX IF EXISTS public.session_rpe_athlete_client_uidx;
--        ALTER TABLE public.session_rpe DROP COLUMN IF EXISTS client_id, DROP COLUMN IF EXISTS tapped_at;
--   Step 3 is safe with the code still deployed as long as step 1 came first.

ALTER TABLE public.session_rpe ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE public.session_rpe ADD COLUMN IF NOT EXISTS tapped_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS session_rpe_athlete_client_uidx
  ON public.session_rpe (athlete_id, client_id) WHERE client_id IS NOT NULL;
