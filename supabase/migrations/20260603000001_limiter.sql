-- Convergence onboarding — Move 2 (the adaptive Limiter). Capture the forced
-- choice that wedges between the dominant competing hypotheses for the athlete's
-- arena. Additive + nullable; the onboarding_step CHECK is untouched (Limiter is
-- a pre-auth ephemeral HookAct sub-state, hydrated onto the row at bootstrap via
-- the same ProbeStash carry as arena + the probe hypothesis).

-- limiter_choice: the option KEY the athlete tapped (axis id, arena-conditioned:
-- e.g. 'durability' | 'off_bottom' | 'localize'). Deliberately NO CHECK — the
-- valid set differs per arena_type, so validity is owned in code
-- (demandTables.resolveLimiter), which always resolves to a safe default for an
-- unknown key rather than rejecting. The resolved limiter (label/category/tilt)
-- is recomputable from (arena_type, arena_raw, limiter_choice, obstacle), so only
-- the raw answer is persisted.
ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS limiter_choice TEXT;

-- -----------------------------------------------------------------------------
-- DebugReset must wipe the Limiter too. Re-declare the EXACT no-arg signature the
-- app calls (supabase.rpc('reset_athlete_orientation')), preserving every cascade
-- delete and only ADDING limiter_choice to the final UPDATE (alongside the
-- obstacle + arena columns cleared in 20260602000001).
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

  -- Onboarding state machine — back to the first step (Hook); obstacle, Arena,
  -- and Limiter all cleared so DebugReset round-trips to a clean pre-read state.
  UPDATE public.athlete
     SET onboarding_step = 'hook',
         obstacle        = NULL,
         arena_type      = NULL,
         arena_raw       = NULL,
         limiter_choice  = NULL
   WHERE id = aid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_athlete_orientation() TO authenticated;
