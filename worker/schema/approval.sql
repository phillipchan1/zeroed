-- approval on Neon (G10, tracks_v1): the athlete's yes to one preview,
-- captured server-side. Hand-apply, like change-log.sql and
-- session-override.sql: no RLS, no GRANT (the Worker scopes every query by
-- athlete). Mirrors supabase/migrations/20261104000004_approval.sql.
--
-- Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, a re-created trigger on the new table only, and one
-- nullable column on change_log (ADD COLUMN IF NOT EXISTS). Does not touch
-- program, phase, routine, program_revision, session_override*, change_log
-- rows or athlete.training_max_overrides.
--
-- Apply this AFTER change-log.sql and BEFORE deploying the G10 Worker for any
-- athlete with tracks_v1 on: with the flag on, every non-logging write must
-- resolve its approval_ref to a row here, and refuses if the table is missing.
-- With the flag off nothing reads or writes it.
--
-- Append-only is enforced by approval_append_only: an approval may be
-- consumed (consumed_at + consumed_by_change_id) or voided (voided_at), once,
-- and nothing else on the row may move. DELETE only happens when the athlete
-- row is deleted.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off nothing is written here, list_approvals is not
--      listed, /api/approvals answers 404, and Accept / undo / override apply
--      go back to exactly the pre-G10 path.
--   2. Code rollback: redeploy the previous Worker. The table and the
--      change_log.approval_id column are ignored by it.
--   3. Optional, once nobody needs the rows:
--      DROP TABLE public.approval;
--      DROP FUNCTION public.approval_append_only();
--      ALTER TABLE public.change_log DROP COLUMN approval_id;
--   Step 3 is safe with the code still deployed as long as step 1 came first.

CREATE TABLE IF NOT EXISTS public.approval (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id            UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  preview_id            TEXT NOT NULL,
  preview_kind          TEXT NOT NULL
                        CHECK (preview_kind IN ('program_edits', 'session_override', 'revert', 'proposal', 'change', 'app_editor')),
  diff_hash             TEXT NOT NULL,
  channel               TEXT NOT NULL CHECK (channel IN ('tap', 'chat')),
  message_id            UUID,
  requested_by_type     TEXT NOT NULL CHECK (requested_by_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  requested_by_id       TEXT NOT NULL,
  consumed_at           TIMESTAMPTZ,
  consumed_by_change_id UUID,
  voided_at             TIMESTAMPTZ,
  CONSTRAINT approval_chat_message CHECK ((channel = 'chat') = (message_id IS NOT NULL)),
  CONSTRAINT approval_consumed_pair CHECK ((consumed_at IS NULL) = (consumed_by_change_id IS NULL)),
  CONSTRAINT approval_one_end CHECK (consumed_at IS NULL OR voided_at IS NULL)
);
CREATE INDEX IF NOT EXISTS approval_athlete_idx
  ON public.approval (athlete_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_preview_idx
  ON public.approval (athlete_id, preview_id);
CREATE INDEX IF NOT EXISTS approval_requested_by_open_idx
  ON public.approval (athlete_id, requested_by_type, requested_by_id)
  WHERE consumed_at IS NULL AND voided_at IS NULL;

CREATE OR REPLACE FUNCTION public.approval_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'approval is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.consumed_at IS NULL AND OLD.voided_at IS NULL THEN
    IF NEW.consumed_at IS NOT NULL AND NEW.voided_at IS NULL
       AND (to_jsonb(NEW) - 'consumed_at' - 'consumed_by_change_id') = (to_jsonb(OLD) - 'consumed_at' - 'consumed_by_change_id') THEN
      RETURN NEW;
    END IF;
    IF NEW.voided_at IS NOT NULL AND NEW.consumed_at IS NULL
       AND (to_jsonb(NEW) - 'voided_at') = (to_jsonb(OLD) - 'voided_at') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'approval is append-only: it may be consumed or voided, once';
END
$fn$;

DROP TRIGGER IF EXISTS approval_append_only ON public.approval;
CREATE TRIGGER approval_append_only
  BEFORE UPDATE OR DELETE ON public.approval
  FOR EACH ROW EXECUTE FUNCTION public.approval_append_only();

-- Which approval row a change_log row's approval_ref resolves to.
ALTER TABLE public.change_log ADD COLUMN IF NOT EXISTS approval_id UUID;
