-- =============================================================================
-- DEBUG — reset the current athlete's "orientation" (onboarding state)
-- Wipes all downstream data so the funnel restarts at the diagnostic intake,
-- WITHOUT deleting the athlete or their auth user. Scoped to the caller's own
-- athlete via get_current_athlete_id(), so it can only ever clear your own data.
--
-- The app tables are deliberately append-only under RLS (no DELETE policies),
-- so this runs SECURITY DEFINER to perform the teardown. Intended for dev/test;
-- the UI button that calls it is gated to dev builds.
--
-- workout / session_observation use ON DELETE RESTRICT, so they must be cleared
-- before their parents; program cascades to phase / routine / weekly_review.
-- =============================================================================

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

  -- Observations (RESTRICT → must precede workout)
  DELETE FROM public.session_observation so
   USING public.workout w, public.routine r, public.program p
   WHERE so.workout_id = w.id
     AND w.routine_id  = r.id
     AND r.program_id  = p.id
     AND p.athlete_id  = aid;

  -- Workouts (RESTRICT → must precede routine/program)
  DELETE FROM public.workout w
   USING public.routine r, public.program p
   WHERE w.routine_id = r.id
     AND r.program_id = p.id
     AND p.athlete_id = aid;

  -- Programs cascade to phase, routine, and weekly_review
  DELETE FROM public.program WHERE athlete_id = aid;

  -- Insights and drafts
  DELETE FROM public.insight       WHERE athlete_id = aid;
  DELETE FROM public.insight_draft WHERE athlete_id = aid;

  -- Diagnostics and profile — these two gate the funnel
  DELETE FROM public.diagnostic      WHERE athlete_id = aid;
  DELETE FROM public.athlete_profile WHERE athlete_id = aid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_athlete_orientation() TO authenticated;
