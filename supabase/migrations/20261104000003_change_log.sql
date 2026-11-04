-- change_log (G2, tracks_v1): one accountable record of every coach and
-- athlete write — who, what (before → after), why, which rules, and what the
-- athlete approved — plus the previews those writes must point at.
--
-- Additive and idempotent. Nothing writes or reads these tables unless
-- athlete.flags.tracks_v1 is true. program_revision and session_override_log
-- are still written exactly as before; change_log sits alongside them, and no
-- historic row is copied or rewritten. Revert (any order):
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete, instant
--   DROP TABLE public.change_log, public.change_preview;      -- optional
--   DROP FUNCTION public.change_log_append_only();            -- optional
--
-- change_log      append-only. The one permitted UPDATE sets reverted_by,
--                 once, on the row an undo reverts (enforced by the trigger
--                 below). An undo is its own row with revert_of = the original;
--                 the unique index makes a second undo of the same row fail.
--                 approval_ref is msg:<id> (coach, from the chat), tap:<id>
--                 (the athlete's own tap, minted by the Worker) or
--                 standing:logging (results, notes, measurements only).
-- change_preview  what a preview showed, for writes that are not week-only
--                 overrides (those keep session_override_preview). An apply
--                 needs one under 24 h old whose diff still matches.

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
