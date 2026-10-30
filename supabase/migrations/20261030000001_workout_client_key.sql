-- Idempotent workout commit: the client sends one stable key per finished
-- session (the outbox entry id). A retry or a replay after the committed-id
-- trail is lost must return the existing row, not insert a second copy.
--
-- Additive only. Existing rows keep client_key and athlete_id NULL; the unique
-- index is partial, so those rows stay valid and do not collide.

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

COMMENT ON COLUMN public.workout.client_key IS
  'Stable per-session key from the client (the outbox entry id). '
  'Null on rows logged before this column existed.';

COMMENT ON COLUMN public.workout.athlete_id IS
  'Denormalized owner, so a unique (athlete, client_key) can live on this table. '
  'Null on rows logged before this column existed; ownership still follows routine → program.';
