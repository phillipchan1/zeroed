-- change_tombstone on Neon (Round 2 item 3: every change type revertible,
-- tracks_v1). Hand-apply, like change-log.sql and session-rpe.sql: no RLS, no
-- GRANT (the Worker scopes every query by athlete). Mirrors
-- supabase/migrations/20261104000010_change_tombstone.sql.
--
-- Additive and idempotent: one CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION and a re-created trigger on the new table only. Does not
-- touch program, phase, routine, program_revision, change_log, checkin,
-- pain_report, region_status, session_rpe, goal_measurement, workout_note,
-- track, athlete_goal or autoreg_rule rows, and never
-- athlete.training_max_overrides. Nothing is deleted, by this file or by any
-- revert.
--
-- change_tombstone  one row per row a revert hid instead of deleting it:
--   void    a logging write undone (a check-in, its pain reports, a session
--           RPE tap, a goal measurement, a workout note). The rows stay in
--           their append-only tables; readers skip a voided one. Region blocks
--           a check-in set are NOT voided (region_status is untouched): a
--           revert never unblocks a region.
--   retire  a row a change created, undone (a track, a goal, an autoreg
--           rule). Kept, hidden from readers and from /api/data selects.
--   Redoing the revert (reverting the revert) lifts the tombstone, once:
--   lifted_at / lifted_by are the only columns that ever change.
--   session_rpe rows are mutable (a second tap updates them), so a void names
--   the tap it voids (row_change_id); a new tap revives the row.
--
-- Apply this AFTER change-log.sql, readiness.sql, session-rpe.sql and
-- coach-roles.sql, and BEFORE deploying this Worker for anyone with tracks_v1
-- on. Until it exists, reverts that need it answer "not set up" (nothing is
-- written) and readers hide nothing; every other revert works as before.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off nothing here is read or written: /api/change-log
--      answers 404, preview_revert_change is not listed, and readers ignore
--      tombstones, so every voided or retired row reads exactly as it did
--      before its revert. /api/session-rx, the MCP tool list and every tool
--      behave as before.
--   2. Code rollback: redeploy the previous Worker. It never names this table;
--      voided and retired rows read as live again, and the previous feed shows
--      the revert rows it already understood.
--   3. Optional, once nobody needs the rows:
--      DROP TABLE public.change_tombstone;
--      DROP FUNCTION public.change_tombstone_append_only();
--   Step 3 is safe with the code still deployed as long as step 1 came first.
--   Reverts that restored values in place (program edits, tracks, goals,
--   rules, overrides, coach access) are ordinary logged writes and stay; undo
--   them from the Changes feed before step 1 if they should not.

CREATE TABLE IF NOT EXISTS public.change_tombstone (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  row_table      TEXT NOT NULL CHECK (row_table IN (
                   'checkin', 'pain_report', 'session_rpe', 'goal_measurement', 'workout_note',
                   'track', 'athlete_goal', 'autoreg_rule')),
  row_id         UUID NOT NULL,
  -- session_rpe only: the tap (change_log id) this voids. A newer tap revives the row.
  row_change_id  UUID,
  kind           TEXT NOT NULL CHECK (kind IN ('void', 'retire')),
  -- The change_log row (a revert_change) that wrote it, and the row it undid.
  change_id      UUID NOT NULL,
  voids_change_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_at      TIMESTAMPTZ,
  -- The change_log row (a redo) that lifted it.
  lifted_by      UUID,
  CONSTRAINT change_tombstone_lifted_pair CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);
CREATE INDEX IF NOT EXISTS change_tombstone_athlete_idx
  ON public.change_tombstone (athlete_id, row_table)
  WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS change_tombstone_change_idx
  ON public.change_tombstone (athlete_id, change_id);
CREATE UNIQUE INDEX IF NOT EXISTS change_tombstone_live_uidx
  ON public.change_tombstone (athlete_id, row_table, row_id)
  WHERE lifted_at IS NULL;

-- Append-only: a tombstone may be lifted, once; DELETE only goes with the athlete.
CREATE OR REPLACE FUNCTION public.change_tombstone_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'change_tombstone is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL
     AND (to_jsonb(NEW) - 'lifted_at' - 'lifted_by') = (to_jsonb(OLD) - 'lifted_at' - 'lifted_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change_tombstone is append-only: it may be lifted, once';
END
$fn$;

DROP TRIGGER IF EXISTS change_tombstone_append_only ON public.change_tombstone;
CREATE TRIGGER change_tombstone_append_only
  BEFORE UPDATE OR DELETE ON public.change_tombstone
  FOR EACH ROW EXECUTE FUNCTION public.change_tombstone_append_only();
