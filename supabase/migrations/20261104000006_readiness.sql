-- readiness (G4 + G8 + coach-read logging, tracks_v1): the athlete's manual
-- daily check-in (sleep, stress, soreness), pain by region with section 8 red
-- flags, each region's U7 status (ok / capped / blocked until the athlete
-- marks it cleared by a clinician), an append-only log of every coach read,
-- and the per-coach health-data toggle (mcp_token.share_health, default on).
--
-- Additive and idempotent. Nothing reads or writes any of it unless
-- athlete.flags.tracks_v1 is true. No existing row is touched; program,
-- routine, program_revision rows and athlete.training_max_overrides are not
-- read or written here. Revert (any order):
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete, instant
--   DROP TABLE public.checkin, public.pain_report, public.region_status, public.coach_read_log;  -- optional
--   DROP FUNCTION public.readiness_append_only();             -- optional
--   ALTER TABLE public.mcp_token DROP COLUMN share_health;    -- optional

-- One row per check-in submission. The latest row for a date is that day's
-- check-in. Every field is optional; a submission names at least one.
CREATE TABLE IF NOT EXISTS public.checkin (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  sleep_hours  NUMERIC(4,2) CHECK (sleep_hours IS NULL OR (sleep_hours >= 0 AND sleep_hours <= 24)),
  stress       SMALLINT CHECK (stress IS NULL OR stress BETWEEN 1 AND 5),
  soreness     SMALLINT CHECK (soreness IS NULL OR soreness BETWEEN 1 AND 5),
  -- The change_log row (standing:logging) this submission wrote.
  change_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checkin_athlete_date_idx ON public.checkin (athlete_id, date, created_at);

-- Pain by region, 0–10, with any section 8 red flags. The latest row for a
-- (date, region) is that day's score.
CREATE TABLE IF NOT EXISTS public.pain_report (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  region       TEXT NOT NULL CHECK (region ~ '^[a-z_]+$'),
  score        SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
  red_flags    TEXT[] NOT NULL DEFAULT '{}'::text[]
               CHECK (red_flags <@ ARRAY['swelling', 'locking', 'giving_way', 'numbness_tingling', 'radiating',
                                         'chest_pain', 'fainting', 'breathlessness', 'acute_injury', 'worsening']::text[]),
  checkin_id   UUID,
  change_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pain_report_athlete_date_idx ON public.pain_report (athlete_id, date, region, created_at);

-- A region's U7 status, one row each time it changes. The latest row is the
-- current status. A 'blocked' row stays in force until the athlete marks it
-- cleared by a clinician (cleared_at + cleared_by, set once, athlete only).
CREATE TABLE IF NOT EXISTS public.region_status (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  region           TEXT NOT NULL CHECK (region ~ '^[a-z_]+$'),
  status           TEXT NOT NULL CHECK (status IN ('ok', 'capped', 'blocked')),
  reason           TEXT,
  rule_refs        JSONB NOT NULL DEFAULT '["U7"]'::jsonb,
  pain_report_id   UUID,
  change_id        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at       TIMESTAMPTZ,
  -- athlete:<id>. Never a coach.
  cleared_by       TEXT,
  clear_change_id  UUID,
  CONSTRAINT region_status_cleared_pair CHECK ((cleared_at IS NULL) = (cleared_by IS NULL)),
  CONSTRAINT region_status_cleared_blocked CHECK (cleared_at IS NULL OR status = 'blocked'),
  CONSTRAINT region_status_cleared_by_athlete CHECK (cleared_by IS NULL OR cleared_by LIKE 'athlete:%')
);
CREATE INDEX IF NOT EXISTS region_status_athlete_idx ON public.region_status (athlete_id, region, created_at);

-- Every coach read of this athlete's data: an MCP read tool call or an
-- app_coach read. The athlete's own reads are not logged.
CREATE TABLE IF NOT EXISTS public.coach_read_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('mcp', 'app_coach')),
  actor_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  scope        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coach_read_log_athlete_idx ON public.coach_read_log (athlete_id, created_at);

-- Append-only: rows go only with their athlete (ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION public.readiness_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'region_status' AND OLD.status = 'blocked' AND OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL
     AND (to_jsonb(NEW) - 'cleared_at' - 'cleared_by' - 'clear_change_id') = (to_jsonb(OLD) - 'cleared_at' - 'cleared_by' - 'clear_change_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS checkin_append_only ON public.checkin;
CREATE TRIGGER checkin_append_only
  BEFORE UPDATE OR DELETE ON public.checkin
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();
DROP TRIGGER IF EXISTS pain_report_append_only ON public.pain_report;
CREATE TRIGGER pain_report_append_only
  BEFORE UPDATE OR DELETE ON public.pain_report
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();
DROP TRIGGER IF EXISTS region_status_append_only ON public.region_status;
CREATE TRIGGER region_status_append_only
  BEFORE UPDATE OR DELETE ON public.region_status
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();
DROP TRIGGER IF EXISTS coach_read_log_append_only ON public.coach_read_log;
CREATE TRIGGER coach_read_log_append_only
  BEFORE UPDATE OR DELETE ON public.coach_read_log
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();

-- D3: does this coach see pain and check-in data. On by default for every
-- coach the athlete invites; only the athlete turns it off (logged). Not
-- writable through /api/data.
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS share_health BOOLEAN NOT NULL DEFAULT true;
