-- Brings an existing Neon database up to arc_load_v1. Same SQL as
-- supabase/migrations/20261028000001_arc_load_v1.sql, and idempotent.
--
-- worker/schema/app.sql already includes all of it, so a fresh restore needs
-- nothing from here. Applied 2026-10-27 to Supabase (the rollback copy), Neon
-- production (branch `production`) and Neon `dev-migration-rehearsal`.

-- arc_load_v1: session RPE, sessions logged outside the plan, and the athlete's
-- own calendar zone. Everything here is additive and nullable; nothing reads it
-- until the flag is on for an athlete, so rolling the flag back needs no
-- schema change.
--
-- workout.session_rpe is Foster's session RPE: one 0–10 (CR-10) rating of the
-- whole session. It is NOT workout.rpe, which is the mean of the set RPEs.
-- Session load = session_rpe × duration_mins.
--
-- workout.source is 'external' for a session logged outside the plan (a BJJ
-- class, a run, a match). Null is a planned session, as every row before this.
--
-- Those external sessions need a routine (workout.routine_id is NOT NULL), and
-- a routine needs a program. They get one program per athlete with status
-- 'external' and one routine in it. Every reader of "the athlete's program"
-- filters on status = 'active', so this one never stands in for it, and every
-- per-week count (week ring, weekly review, recap) is scoped to the active
-- program, so an external session never fills a planned slot.
--
-- athlete.flags holds per-athlete runtime flags ({"arc_load_v1": true}); only
-- literal true counts (src/lib/flags.ts). Rollback:
--   UPDATE public.athlete SET flags = flags - 'arc_load_v1';
--
-- athlete.time_zone is the athlete's training calendar (IANA name), written by
-- the client from the device while the flag is on. Null means Los Angeles,
-- which is what every week boundary used before this.
--
-- No new RLS: the existing workout, program and athlete policies already scope
-- these columns to the athlete's own rows. That includes athlete.flags, so an
-- athlete could turn their own flag on through PostgREST. That's acceptable for
-- a rollout gate (the build ceiling VITE_ARC_LOAD_V1 still applies); the Worker
-- data plane strips flags from every client write.

ALTER TABLE public.workout
  ADD COLUMN IF NOT EXISTS session_rpe NUMERIC(3, 1)
    CHECK (session_rpe IS NULL OR (session_rpe >= 0 AND session_rpe <= 10)),
  ADD COLUMN IF NOT EXISTS source TEXT
    CHECK (source IS NULL OR source IN ('plan', 'external'));

COMMENT ON COLUMN public.workout.session_rpe IS
  'Session RPE (CR-10, 0–10) for the whole session. Not the mean of set RPEs (that is rpe).';
COMMENT ON COLUMN public.workout.source IS
  'external = logged outside the plan; null = a planned session.';

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS flags JSONB,
  ADD COLUMN IF NOT EXISTS time_zone TEXT;

COMMENT ON COLUMN public.athlete.flags IS
  'Per-athlete runtime feature flags, e.g. {"arc_load_v1": true}. Set by hand.';
COMMENT ON COLUMN public.athlete.time_zone IS
  'The athlete''s training calendar (IANA zone). Null = America/Los_Angeles.';

-- program.status gains 'external'. The inline CHECK is named
-- program_status_check on both Supabase and Neon, but drop any CHECK on status
-- by definition so a differently named one can't keep refusing the new value.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'program'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ~* '\mstatus\M'
  LOOP
    EXECUTE format('ALTER TABLE public.program DROP CONSTRAINT %I', rec.conname);
  END LOOP;
END
$$;

ALTER TABLE public.program
  ADD CONSTRAINT program_status_check
  CHECK (status IN ('draft', 'active', 'completed', 'paused', 'external'));

-- One external program per athlete, so two devices logging at once can't mint two.
CREATE UNIQUE INDEX IF NOT EXISTS program_one_external_per_athlete
  ON public.program(athlete_id) WHERE status = 'external';
