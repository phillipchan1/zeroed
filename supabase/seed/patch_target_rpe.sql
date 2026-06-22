-- =============================================================================
-- Safe patch: add per-exercise target_rpe to the routine TEMPLATES only.
--
-- Use this instead of re-running phil_health_import.sql when you have already
-- logged real workouts — the full seed wipes workouts, this does NOT. It only
-- updates routine.exercises JSONB in place, preserving exercise ORDER (so the
-- indices in any logged workout.actual_weights stay aligned). Idempotent.
--
-- Run: Supabase Dashboard → SQL Editor → paste → Run.
-- =============================================================================

DO $$
DECLARE
  v_email   TEXT := 'phillipchan1@gmail.com';
  v_athlete UUID;
  r         RECORD;
  v_new     JSONB;
BEGIN
  SELECT a.id INTO v_athlete
  FROM public.athlete a
  JOIN auth.users u ON u.id = a.auth_user_id
  WHERE u.email = v_email;
  IF v_athlete IS NULL THEN
    RAISE EXCEPTION 'No athlete for %', v_email;
  END IF;

  FOR r IN
    SELECT rt.id, rt.exercises
    FROM public.routine rt
    JOIN public.program p ON p.id = rt.program_id
    WHERE p.athlete_id = v_athlete
  LOOP
    SELECT jsonb_agg(
             CASE
               WHEN t.ex->>'name' IN (
                 'Face pull','Bottom-up KB press','Copenhagen plank',
                 'Squat (no belt)','Bulgarian split squat','Bench press',
                 'DB bench (unilateral)','Landmine press',
                 'Deadlift (conventional, no belt)','Strict OHP'
               ) THEN t.ex || '{"target_rpe":7}'::jsonb
               WHEN t.ex->>'name' = 'Chest-supported DB row'
                 THEN t.ex || '{"target_rpe":8}'::jsonb
               WHEN t.ex->>'name' IN (
                 'Push-up plus','Band pull-apart','Terminal knee extension',
                 'Lateral band walk','Step-up','Glute bridge'
               ) THEN t.ex || '{"target_rpe":6}'::jsonb
               ELSE t.ex
             END
             ORDER BY t.ord
           )
    INTO v_new
    FROM jsonb_array_elements(r.exercises) WITH ORDINALITY AS t(ex, ord);

    UPDATE public.routine SET exercises = v_new WHERE id = r.id;
  END LOOP;

  RAISE NOTICE 'Patched target_rpe on routine templates for athlete % (no workouts touched).', v_athlete;
END $$;
