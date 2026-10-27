-- Additive, nullable starter-pack columns for agent-led onboarding (#31).
-- onboarding_step CHECK is untouched. Columns are ignored when null or when
-- onboarding_agent_v1 is off.

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS starter_pack TEXT
    CHECK (starter_pack IS NULL OR starter_pack IN (
      'sport_sc',
      'get_strong',
      'chase_total',
      'hybrid',
      'layoff',
      'thirty_three',
      'byo'
    )),
  ADD COLUMN IF NOT EXISTS starter_pack_settings JSONB,
  ADD COLUMN IF NOT EXISTS onboarding_answers JSONB;

COMMENT ON COLUMN public.athlete.starter_pack IS
  'Starter pack id (sport_sc, get_strong, …). Null until a pack is started. Ignored when onboarding_agent_v1 is off.';

COMMENT ON COLUMN public.athlete.starter_pack_settings IS
  'Pack settings jsonb, e.g. {sport, season, game_days}. Sport is a setting, not a library.';

COMMENT ON COLUMN public.athlete.onboarding_answers IS
  'Onboarding answers envelope {"v":1,...} (goal, days, minutes, equipment, lifts, pain, style). Separate from starter_pack_settings. Validated in engine code.';

-- Wipe the new columns with the rest of orientation state. onboarding_step
-- CHECK is unchanged. Isolation tests replay this onto throwaway Postgres.
CREATE OR REPLACE FUNCTION public.reset_athlete_orientation()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  aid UUID := get_current_athlete_id();
BEGIN
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

GRANT EXECUTE ON FUNCTION public.reset_athlete_orientation() TO authenticated;
