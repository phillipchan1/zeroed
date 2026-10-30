-- Mirrors supabase/migrations/20261030000001_workout_client_key.sql.
-- app.sql already has these columns; hand-apply this on a live Neon that
-- was created before they landed. Idempotent.

ALTER TABLE public.workout
  ADD COLUMN IF NOT EXISTS athlete_id UUID REFERENCES public.athlete(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS client_key TEXT;

ALTER TABLE public.workout
  DROP CONSTRAINT IF EXISTS workout_client_key_needs_athlete;

ALTER TABLE public.workout
  ADD CONSTRAINT workout_client_key_needs_athlete
  CHECK (client_key IS NULL OR athlete_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS workout_athlete_client_key_uidx
  ON public.workout (athlete_id, client_key)
  WHERE client_key IS NOT NULL;
