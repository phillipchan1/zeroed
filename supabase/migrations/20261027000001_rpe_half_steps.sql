-- Logged RPE is 1–10 in 0.5 steps (1, 1.5, …, 10).
--
-- workout.rpe was INTEGER CHECK (1–10): a session average could not store 7.5.
-- Set-level rpe lives in actual_weights JSONB and had no CHECK at all.
-- This migration is additive: existing integer rows (1–10) remain valid, and
-- the new CHECKs accept the same values plus the half-steps between them.
-- Safe on Postgres 17 (Neon) and on PGlite when isolation tests replay
-- supabase/migrations from scratch.

ALTER TABLE public.workout
  ALTER COLUMN rpe TYPE NUMERIC(3, 1)
  USING rpe::numeric;

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
      AND t.relname = 'workout'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ~* '\mrpe\M'
      AND pg_get_constraintdef(c.oid) !~* 'readiness'
      AND pg_get_constraintdef(c.oid) !~* 'actual_weights'
  LOOP
    EXECUTE format('ALTER TABLE public.workout DROP CONSTRAINT %I', rec.conname);
  END LOOP;
END
$$;

ALTER TABLE public.workout DROP CONSTRAINT IF EXISTS workout_rpe_check;

ALTER TABLE public.workout
  ADD CONSTRAINT workout_rpe_check
  CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10 AND rpe * 2 = trunc(rpe * 2)));

COMMENT ON COLUMN public.workout.rpe IS
  'Session-average logged RPE: 1–10 in 0.5 steps. Null when no set recorded one.';

-- Set-level RPE in actual_weights: same scale. Null / missing rpe is fine.
-- jsonb_typeof('null'::jsonb) is 'null'; a missing key is skipped.

CREATE OR REPLACE FUNCTION public.logged_rpe_ok(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    value IS NULL
    OR jsonb_typeof(value) = 'null'
    OR (
      jsonb_typeof(value) = 'number'
      AND (value::text)::numeric >= 1
      AND (value::text)::numeric <= 10
      AND (value::text)::numeric * 2 = trunc((value::text)::numeric * 2)
    );
$$;

CREATE OR REPLACE FUNCTION public.actual_weights_rpe_ok(weights jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT weights IS NULL
    OR jsonb_typeof(weights) IS DISTINCT FROM 'object'
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_each(weights) AS ex(k, sets)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(sets) = 'array' THEN sets ELSE '[]'::jsonb END
      ) AS s(set)
      WHERE (s.set ? 'rpe')
        AND s.set->'rpe' IS NOT NULL
        AND jsonb_typeof(s.set->'rpe') <> 'null'
        AND NOT public.logged_rpe_ok(s.set->'rpe')
    );
$$;

ALTER TABLE public.workout DROP CONSTRAINT IF EXISTS workout_actual_weights_rpe_check;

ALTER TABLE public.workout
  ADD CONSTRAINT workout_actual_weights_rpe_check
  CHECK (public.actual_weights_rpe_ok(actual_weights));
