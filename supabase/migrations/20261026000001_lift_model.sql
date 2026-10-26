-- The per-session check-in and hand-set training maxes behind the lift model
-- (src/engine/liftModel.ts).
--
-- The model reads four things about a session that the log never held: how the
-- knees felt (left and right, because they don't hurt together), how long the
-- athlete slept, how ready they felt, and what they weighed. Each one moves a
-- load — knee pain ≥ 4 takes 10% off squat/lunge/jump work, under 6 h of sleep or
-- readiness under 5 takes 5% off and caps RPE at 7 — so they live on the workout
-- row next to the sets they changed. All optional: a session logged without a
-- check-in is still a session.
--
-- Missed reps are per SET and ride in workout.actual_weights (JSONB, additive),
-- so they need no column here.
--
-- training_max_overrides is the athlete saying "my bench TM is 275" — a lift with
-- an entry stops using 90% of its working max. Keys are the model's lift ids:
-- squat, bench, deadlift, ohp. Values are in the storage weight unit.
--
-- No new RLS: the existing workout insert/update policies and athlete_update
-- already scope these columns to the athlete's own rows.

ALTER TABLE public.workout
  ADD COLUMN IF NOT EXISTS knee_pain_l SMALLINT
    CHECK (knee_pain_l IS NULL OR knee_pain_l BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS knee_pain_r SMALLINT
    CHECK (knee_pain_r IS NULL OR knee_pain_r BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS sleep_hours NUMERIC(3, 1)
    CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 24),
  ADD COLUMN IF NOT EXISTS readiness SMALLINT
    CHECK (readiness IS NULL OR readiness BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS bodyweight NUMERIC(6, 1)
    CHECK (bodyweight IS NULL OR bodyweight > 0);

COMMENT ON COLUMN public.workout.knee_pain_l IS 'Session check-in: left knee pain 0–10.';
COMMENT ON COLUMN public.workout.knee_pain_r IS 'Session check-in: right knee pain 0–10.';
COMMENT ON COLUMN public.workout.sleep_hours IS 'Session check-in: hours slept the night before.';
COMMENT ON COLUMN public.workout.readiness IS 'Session check-in: readiness 1–10.';
COMMENT ON COLUMN public.workout.bodyweight IS 'Session check-in: bodyweight, in the storage weight unit.';

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS training_max_overrides JSONB;

COMMENT ON COLUMN public.athlete.training_max_overrides IS
  'Hand-set training maxes by lift id ({"bench": 275, "ohp": 140}), storage weight unit. Absent lifts use 90% of the working max.';
