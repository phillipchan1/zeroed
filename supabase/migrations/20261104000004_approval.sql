-- approval (G10, tracks_v1): the athlete's yes, captured server-side.
--
-- Phases G1/G2 required an approval_ref on every non-logging write but only
-- checked its format. Each approval is now a row the athlete's own session
-- created (an in-app tap, or a chat message they wrote), bound to one preview
-- and a hash of the diff they saw. approval_ref values are tap:<approval.id>
-- or msg:<approval.id>; an apply must resolve one: same athlete, same
-- preview, same diff hash, under 24 h, not consumed, not voided. It is
-- consumed by the write it approved (consumed_by_change_id = the change_log
-- row), once.
--
-- Additive and idempotent. Nothing reads or writes this table unless
-- athlete.flags.tracks_v1 is true. change_log gains a nullable approval_id;
-- no existing row is touched. Revert (any order):
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete, instant
--   DROP TABLE public.approval;                                -- optional
--   DROP FUNCTION public.approval_append_only();               -- optional
--   ALTER TABLE public.change_log DROP COLUMN approval_id;     -- optional
--
-- approval  append-only. The only UPDATEs allowed: consume it once (sets
--           consumed_at + consumed_by_change_id together, only if not
--           voided) or void it once (sets voided_at, only if not consumed).
--           DELETE only happens when the athlete row is deleted.

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
