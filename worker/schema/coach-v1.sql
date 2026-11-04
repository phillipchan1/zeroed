-- coach_v1 on Neon (G6 activity modules + composer, G7 intake + app coach).
-- Hand-apply, like session-rpe.sql: no RLS, no GRANT (the Worker scopes
-- every query by athlete). Mirrors supabase/migrations/20261104000008_coach_v1.sql.
--
-- Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, re-created triggers on the new tables only, and two
-- nullable columns via ADD COLUMN IF NOT EXISTS on athlete_goal (weight,
-- quality). Does not touch program, phase, routine, program_revision,
-- coach_message, change_log rows, existing athlete_goal values or
-- athlete.training_max_overrides.
--
-- activity         one row per sport/activity: module key, sessions/week,
--                  in- or off-season, days, active. Approved writes only
--                  (apply_activity_change, or an approved intake block).
-- coach_intake     the intake answers as submitted, append-only: stopped by
--                  a red flag, or previewed as a composed block.
-- composed_block   the approved block of record, with the methodology and
--                  module versions and the inputs it was composed from.
-- athlete_goal.weight / .quality   priority | maintenance, and the quality
--                  trained; written only by apply_composed_block.
--
-- The flag: athlete.flags.coach_v1 (JSONB true), and it only counts when
-- athlete.flags.tracks_v1 is true too. No migration or script sets it.
--
-- Apply this AFTER session-rpe.sql and BEFORE turning coach_v1 on for any
-- athlete: until it exists, the coach_v1 tools and /api/coach answer "not
-- set up" and write nothing. With coach_v1 off nothing here is read or
-- written: /api/session-rx, the MCP tool list and every tool behave exactly
-- as after G9, the Coach screen keeps its current chat, and /api/coach
-- answers 404.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'coach_v1' WHERE id = '…';
--      With the flag off: no intake, no server-side app coach (the Coach
--      screen's chat is the pre-G7 one), no get_activities /
--      preview_activity_change / apply_activity_change /
--      preview_composed_block / apply_composed_block tools, /api/coach
--      answers 404. Tracks, rules and program dates an approved block wrote
--      stay, like any approved write; each is in change_log.
--   2. Code rollback: redeploy the previous Worker. The new tables and
--      columns are ignored by it (it never names them).
--   3. Optional, once nobody needs the rows:
--      DROP TABLE public.activity, public.coach_intake, public.composed_block;
--      DROP FUNCTION public.coach_v1_append_only();
--      ALTER TABLE public.athlete_goal DROP COLUMN weight, DROP COLUMN quality;
--   Step 3 is safe with the code still deployed as long as step 1 came first.

-- One row per sport or activity the athlete does (spec section 4). module_key
-- names its code-owned module (worker/src/coach/modules.ts, versioned like the
-- methodology). Written only through preview_activity_change →
-- apply_activity_change (approval required) or an approved composed block
-- from intake; never deleted: removing one sets active = false. change_id is
-- the change_log row of the last write.
CREATE TABLE IF NOT EXISTS public.activity (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  module_key         TEXT NOT NULL CHECK (module_key IN ('court', 'endurance', 'field', 'strength', 'general')),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  sessions_per_week  SMALLINT NOT NULL CHECK (sessions_per_week BETWEEN 0 AND 14),
  season             TEXT NOT NULL DEFAULT 'in' CHECK (season IN ('in', 'off')),
  -- Days it is on, 0 = Mon … 6 = Sun.
  days               SMALLINT[] NOT NULL DEFAULT '{}' CHECK (days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  active             BOOLEAN NOT NULL DEFAULT true,
  change_id          UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_athlete_idx ON public.activity (athlete_id, active);

-- The intake answers as submitted (section 5), one row per submission,
-- append-only. outcome 'stopped': a red flag (or pain above the U7 stop line)
-- stopped it and nothing was composed; 'previewed': it produced the composed
-- block preview preview_id. minor + parental_consent record the under-18
-- consent step. change_id: the check-in (pain, recovery baseline) it logged.
CREATE TABLE IF NOT EXISTS public.coach_intake (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  answers           JSONB NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('stopped', 'previewed')),
  minor             BOOLEAN NOT NULL DEFAULT false,
  parental_consent  JSONB,
  preview_id        TEXT,
  change_id         UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coach_intake_athlete_idx ON public.coach_intake (athlete_id, created_at DESC);

-- The block of record (section 4 output): what the composer produced and the
-- athlete approved, with the methodology and module versions it ran on and
-- the key of the activities + goals it was composed from (re-compose when
-- that moves or the block ends). Written only by apply_composed_block, in the
-- same transaction as its change_log row. A newer block supersedes the old
-- one; nothing else about a row ever changes.
CREATE TABLE IF NOT EXISTS public.composed_block (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id           UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  program_id           UUID REFERENCES public.program(id) ON DELETE SET NULL,
  start_date           DATE NOT NULL,
  end_date             DATE NOT NULL,
  methodology_version  TEXT NOT NULL,
  modules_version      TEXT NOT NULL,
  compose_key          TEXT NOT NULL,
  block                JSONB NOT NULL,
  request              JSONB NOT NULL DEFAULT '{}'::jsonb,
  intake_id            UUID,
  preview_id           TEXT NOT NULL,
  approval_ref         TEXT NOT NULL,
  change_id            UUID NOT NULL,
  actor_type           TEXT NOT NULL,
  actor_id             TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at        TIMESTAMPTZ,
  superseded_by        UUID
);
CREATE INDEX IF NOT EXISTS composed_block_athlete_idx ON public.composed_block (athlete_id, created_at DESC);

-- Append-only, like readiness_append_only: coach_intake never changes;
-- composed_block only gains superseded_at / superseded_by, once. Deletes go
-- through only when the athlete row itself is being deleted (cascade).
CREATE OR REPLACE FUNCTION public.coach_v1_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'composed_block' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_at' - 'superseded_by') = (to_jsonb(OLD) - 'superseded_at' - 'superseded_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS coach_intake_append_only ON public.coach_intake;
CREATE TRIGGER coach_intake_append_only
  BEFORE UPDATE OR DELETE ON public.coach_intake
  FOR EACH ROW EXECUTE FUNCTION public.coach_v1_append_only();
DROP TRIGGER IF EXISTS composed_block_append_only ON public.composed_block;
CREATE TRIGGER composed_block_append_only
  BEFORE UPDATE OR DELETE ON public.composed_block
  FOR EACH ROW EXECUTE FUNCTION public.coach_v1_append_only();

-- A goal's weight for composing (section 4: priority | maintenance) and the
-- quality it trains. Nullable: null reads as maintenance, quality inferred.
-- Written only by apply_composed_block. Existing goal rows are not touched.
ALTER TABLE public.athlete_goal ADD COLUMN IF NOT EXISTS weight TEXT
  CHECK (weight IS NULL OR weight IN ('priority', 'maintenance'));
ALTER TABLE public.athlete_goal ADD COLUMN IF NOT EXISTS quality TEXT
  CHECK (quality IS NULL OR quality IN ('max_strength', 'power', 'aerobic', 'alactic', 'change_of_direction', 'tissue_capacity', 'mobility'));
