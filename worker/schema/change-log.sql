-- change_log on Neon (G2, tracks_v1): the append-only audit of every coach and
-- athlete write, and the stored previews non-override writes apply from.
-- Hand-apply, like session-override.sql and coach-proposal.sql: no RLS, no
-- GRANT (the Worker scopes every query by athlete). Mirrors
-- supabase/migrations/20261104000003_change_log.sql.
--
-- Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION and a re-created trigger on the new table only. Does not
-- touch program, phase, routine, program_revision, session_override_log rows
-- or athlete.training_max_overrides. No historic row is copied.
--
-- Apply this BEFORE turning tracks_v1 on for anyone: with the flag on, covered
-- writes log here in the same transaction, and refuse if the table is missing.
--
-- Append-only is enforced by change_log_append_only: the only UPDATE allowed
-- fills reverted_by once; DELETE only happens when the athlete row is deleted.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off nothing is written here, get_change_log /
--      preview_revert_change are not listed, /api/change-log answers 404, and
--      the Changes feed is hidden. Writes go back to exactly today's path.
--   2. Optional, once nobody needs the audit rows:
--      DROP TABLE public.change_log, public.change_preview;
--      DROP FUNCTION public.change_log_append_only();
--   Step 2 is safe with the code still deployed as long as step 1 came first.

CREATE TABLE IF NOT EXISTS public.change_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  diff         JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale    TEXT,
  rule_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_ref TEXT,
  preview_id   TEXT,
  expires_on   DATE,
  reverted_by  UUID,
  revert_of    UUID,
  CONSTRAINT change_log_not_own_revert CHECK (revert_of IS DISTINCT FROM id AND reverted_by IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS change_log_athlete_idx
  ON public.change_log (athlete_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS change_log_revert_of_uidx
  ON public.change_log (revert_of) WHERE revert_of IS NOT NULL;

-- Append-only. UPDATE may only fill reverted_by on a row that has none, and
-- nothing else on the row may move. DELETE is refused unless the athlete row
-- itself is gone (ON DELETE CASCADE when an account is deleted).
CREATE OR REPLACE FUNCTION public.change_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'change_log is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.reverted_by IS NULL AND NEW.reverted_by IS NOT NULL
     AND (to_jsonb(NEW) - 'reverted_by') = (to_jsonb(OLD) - 'reverted_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change_log is append-only: only reverted_by may be set, once';
END
$fn$;

DROP TRIGGER IF EXISTS change_log_append_only ON public.change_log;
CREATE TRIGGER change_log_append_only
  BEFORE UPDATE OR DELETE ON public.change_log
  FOR EACH ROW EXECUTE FUNCTION public.change_log_append_only();

CREATE TABLE IF NOT EXISTS public.change_preview (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  preview_id  TEXT NOT NULL UNIQUE,
  tool        TEXT NOT NULL,
  target_id   TEXT,
  diff        JSONB NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id    TEXT NOT NULL,
  rationale   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at     TIMESTAMPTZ,
  voided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS change_preview_athlete_idx
  ON public.change_preview (athlete_id, created_at DESC);
