-- Additive, nullable starter-pack columns for agent-led onboarding (#31).
-- onboarding_step CHECK is untouched. Columns are ignored when null or when
-- onboarding_agent_v1 is off.
--
-- Fresh Neon installs get these from worker/schema/app.sql. Apply this file
-- by hand only on an existing Neon that already ran an older app.sql snapshot
-- and is missing the columns. It is additive only (columns, CHECK, comments)
-- and safe to re-run. It deliberately does NOT replace
-- reset_athlete_orientation(): the Worker resets through data.ts
-- resetOrientation, which clears these columns when they exist.
-- Isolation tests replay the same ALTER from
-- supabase/migrations/20261109000001_starter_pack.sql onto throwaway Postgres.

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS starter_pack TEXT,
  ADD COLUMN IF NOT EXISTS starter_pack_settings JSONB,
  ADD COLUMN IF NOT EXISTS onboarding_answers JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'athlete'
      AND c.conname = 'athlete_starter_pack_check'
  ) THEN
    ALTER TABLE public.athlete
      ADD CONSTRAINT athlete_starter_pack_check CHECK (
        starter_pack IS NULL OR starter_pack IN (
          'sport_sc', 'get_strong', 'chase_total', 'hybrid', 'layoff', 'thirty_three', 'byo'
        )
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.athlete.starter_pack IS
  'Starter pack id. Null until a pack is started. Ignored when onboarding_agent_v1 is off.';

COMMENT ON COLUMN public.athlete.starter_pack_settings IS
  'Pack settings jsonb, e.g. {sport, season, game_days}. Sport is a setting, not a library.';

COMMENT ON COLUMN public.athlete.onboarding_answers IS
  'Onboarding answers envelope {"v":1,...} (goal, days, minutes, equipment, lifts, pain, style). Separate from starter_pack_settings.';
