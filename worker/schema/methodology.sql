-- methodology on Neon (G3 + G5 + G10 follow-up, tracks_v1). Hand-apply, like
-- approval.sql and change-log.sql: no RLS, no GRANT (the Worker scopes every
-- query by athlete). Mirrors supabase/migrations/20261104000005_methodology.sql.
--
-- Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, a re-created trigger on the new table only, and nullable
-- columns via ADD COLUMN IF NOT EXISTS on change_log (methodology_version),
-- coach_proposal (created_by, voided_at) and athlete (birth_date). Does not
-- touch program, phase, routine, program_revision, session_override*,
-- existing change_log / coach_proposal rows or athlete.training_max_overrides.
--
-- Apply this AFTER approval.sql and BEFORE deploying the G3 Worker for any
-- athlete with tracks_v1 on: with the flag on, every change_log insert names
-- methodology_version and every new proposal names created_by, and those
-- writes refuse if the columns are missing. With the flag off nothing here is
-- read or written: /api/session-rx, previews, proposals and the MCP tool list
-- are exactly as before.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off: no methodology_version on /api/session-rx, no
--      get_methodology / preview_ / apply_methodology_override tools, no
--      preview warnings, no created_by on proposals, overrides ignored.
--   2. Code rollback: redeploy the previous Worker. The new table and columns
--      are ignored by it (it never names them).
--   3. Optional, once nobody needs the rows:
--      DROP TABLE public.methodology_override;
--      DROP FUNCTION public.methodology_override_append_only();
--      ALTER TABLE public.change_log DROP COLUMN methodology_version;
--      ALTER TABLE public.coach_proposal DROP COLUMN created_by, DROP COLUMN voided_at;
--      ALTER TABLE public.athlete DROP COLUMN birth_date;
--   Step 3 is safe with the code still deployed as long as step 1 came first.

CREATE TABLE IF NOT EXISTS public.methodology_override (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  -- NULL: the whole athlete. Set: that track only (paths with scope 'any').
  track_id            UUID REFERENCES public.track(id) ON DELETE CASCADE,
  -- The global version it was set against, e.g. 'v1'.
  methodology_version TEXT NOT NULL,
  path                TEXT NOT NULL,
  value               JSONB NOT NULL,
  rationale           TEXT,
  rule_refs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id            TEXT NOT NULL,
  approval_ref        TEXT NOT NULL,
  approval_id         UUID,
  preview_id          TEXT NOT NULL,
  change_id           UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at       TIMESTAMPTZ,
  superseded_by       UUID,
  CONSTRAINT methodology_override_path CHECK (path ~ '^(U([1-9]|1[0-5])|minors)(\.[a-z0-9_]+)+$')
);
CREATE INDEX IF NOT EXISTS methodology_override_athlete_idx
  ON public.methodology_override (athlete_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS methodology_override_active_uidx
  ON public.methodology_override (athlete_id, COALESCE(track_id::text, ''), path)
  WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION public.methodology_override_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'methodology_override is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_at' - 'superseded_by') = (to_jsonb(OLD) - 'superseded_at' - 'superseded_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'methodology_override is append-only: it may be superseded, once';
END
$fn$;

DROP TRIGGER IF EXISTS methodology_override_append_only ON public.methodology_override;
CREATE TRIGGER methodology_override_append_only
  BEFORE UPDATE OR DELETE ON public.methodology_override
  FOR EACH ROW EXECUTE FUNCTION public.methodology_override_append_only();

-- The methodology version every change_log row ran on ('v1', or 'v1+<hash>'
-- with the athlete's overrides in force). NULL on rows written before G3.
ALTER TABLE public.change_log ADD COLUMN IF NOT EXISTS methodology_version TEXT;

-- Who parked a proposal: mcp:<token id>, app_coach, or athlete:<id>. NULL on
-- rows parked before G3 (left alone by revocation). voided_at: its coach was
-- revoked while it was pending (status goes 'stale' at the same time).
ALTER TABLE public.coach_proposal ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.coach_proposal ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- Under-18 rules (D6) apply when this says the athlete is under 18. NULL:
-- age unknown — adult rules, and no raised pain cap (D2) until it is known.
-- Not writable through /api/data.
ALTER TABLE public.athlete ADD COLUMN IF NOT EXISTS birth_date DATE;
