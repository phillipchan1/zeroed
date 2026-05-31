-- Convergence onboarding — Move 1 (the Arena). Capture the athlete's heading:
-- WHICH wide cloud they're converging toward. Additive + nullable; the
-- onboarding_step CHECK is untouched (Arena/Limiter/Read are pre-auth ephemeral
-- HookAct sub-states, not DB steps — they hydrate onto the row at bootstrap via
-- the same ProbeStash carry the probe hypothesis already uses).

-- arena_type: the archetype enum (Convergence §3 Move 1). Nullable; CHECK passes
-- on NULL but is explicit for clarity. Mirror of ArenaType in
-- src/types/database.ts / src/engine/demandTables.ts.
ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS arena_type TEXT;

-- arena_raw: the athlete's own words (free text, or the specific behind a tap —
-- "basketball", "285 bench"). Feeds matchSport / matchLift downstream.
ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS arena_raw TEXT;

-- Fresh nullable CHECK for arena_type (idempotent: drop by name first).
ALTER TABLE public.athlete DROP CONSTRAINT IF EXISTS athlete_arena_type_check;
ALTER TABLE public.athlete
  ADD CONSTRAINT athlete_arena_type_check
  CHECK (arena_type IS NULL OR arena_type IN (
    'sport', 'number', 'body', 'durability', 'event', 'all_around'
  ));

-- -----------------------------------------------------------------------------
-- DebugReset must wipe the Arena too. Re-declare the EXACT no-arg signature the
-- app calls (supabase.rpc('reset_athlete_orientation')), preserving every
-- cascade delete from 20260530000001 and only ADDING arena_type/arena_raw to the
-- final UPDATE. (CREATE OR REPLACE requires the identical signature; a parameter
-- here would create an orphan overload the app never calls — see DebugReset.tsx.)
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

  -- Onboarding state machine — back to the first step (Hook), obstacle + Arena
  -- cleared so DebugReset round-trips to a clean pre-read state.
  UPDATE public.athlete
     SET onboarding_step = 'hook',
         obstacle        = NULL,
         arena_type      = NULL,
         arena_raw       = NULL
   WHERE id = aid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_athlete_orientation() TO authenticated;
