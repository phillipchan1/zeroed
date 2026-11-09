-- Additive, nullable starter-pack columns for agent-led onboarding (#31).
-- onboarding_step CHECK is untouched. Columns are ignored when null or when
-- onboarding_agent_v1 is off.
--
-- Fresh Neon installs get these from worker/schema/app.sql. Apply this file
-- by hand on an existing Neon that already ran an older app.sql snapshot.
-- Isolation tests replay the same ALTER from
-- supabase/migrations/20261027000002_starter_pack.sql onto throwaway Postgres.

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

CREATE OR REPLACE FUNCTION public.reset_athlete_orientation()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  aid UUID;
  uid TEXT;
BEGIN
  uid := NULLIF(current_setting('app.current_auth_user_id', true), '');
  IF uid IS NOT NULL THEN
    SELECT id INTO aid FROM public.athlete WHERE auth_user_id::text = uid LIMIT 1;
  END IF;
  IF aid IS NULL THEN
    RAISE EXCEPTION 'No athlete for the current user';
  END IF;

  DELETE FROM public.session_observation so
   USING public.workout w, public.routine r, public.program p
   WHERE so.workout_id = w.id
     AND w.routine_id  = r.id
     AND r.program_id  = p.id
     AND p.athlete_id  = aid;

  DELETE FROM public.workout w
   USING public.routine r, public.program p
   WHERE w.routine_id = r.id
     AND r.program_id = p.id
     AND p.athlete_id = aid;

  DELETE FROM public.program WHERE athlete_id = aid;
  DELETE FROM public.insight       WHERE athlete_id = aid;
  DELETE FROM public.insight_draft WHERE athlete_id = aid;
  DELETE FROM public.diagnostic      WHERE athlete_id = aid;
  DELETE FROM public.athlete_profile WHERE athlete_id = aid;

  UPDATE public.athlete
     SET onboarding_step         = 'hook',
         obstacle                = NULL,
         arena_type              = NULL,
         arena_raw               = NULL,
         limiter_choice          = NULL,
         starter_pack            = NULL,
         starter_pack_settings   = NULL,
         onboarding_answers      = NULL
   WHERE id = aid;
END;
$$;
