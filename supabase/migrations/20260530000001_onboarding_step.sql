-- =============================================================================
-- ONBOARDING STATE MACHINE
-- The new six-act "First Read" onboarding is driven by a single column on the
-- athlete row. App.tsx routes on this value. `obstacle` stores the Screen 02
-- free-text answer ("what's getting in your way?") which the acknowledgment
-- screen and downstream warm characterization reference verbatim.
-- =============================================================================

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS onboarding_step TEXT NOT NULL DEFAULT 'hook'
    CHECK (onboarding_step IN (
      'hook',                    -- pre-Screen 03; no auth yet
      'orientation',             -- Screens 04-06
      'screening',               -- Screens 07-16
      'computing',               -- Screen 17 (transient, ~25s)
      'zeroed_in',               -- Screen 18 — pre-CTA
      'first_session_pending',   -- Screens 19-20
      'first_session_complete',  -- Screen 21 — pre-CTA
      'complete'                 -- in the daily loop
    ));

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS obstacle TEXT;  -- the Screen 02 answer

-- -----------------------------------------------------------------------------
-- DebugReset must drop the athlete back to Screen 01 (Hook) cleanly. Extend the
-- existing teardown to also reset the onboarding state machine and clear the
-- obstacle, WITHOUT deleting the athlete or their auth user.
-- -----------------------------------------------------------------------------
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

  -- Diagnostics and profile
  DELETE FROM public.diagnostic      WHERE athlete_id = aid;
  DELETE FROM public.athlete_profile WHERE athlete_id = aid;

  -- Onboarding state machine — back to Screen 01 (Hook), obstacle cleared.
  UPDATE public.athlete
     SET onboarding_step = 'hook',
         obstacle        = NULL
   WHERE id = aid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_athlete_orientation() TO authenticated;
