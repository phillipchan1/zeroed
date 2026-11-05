-- session_rpe (G9, tracks_v1): the one CR-10 tap after a session, stored apart
-- from set RPE (docs/one-athlete-one-arc.md §0.1). Logged by the athlete under
-- standing approval, editable the same day, read by coaches through MCP
-- get_session_rpe (logged as a coach read, behind the health-data toggle) and
-- summed into get_weekly_review as session load.
--
-- Additive and idempotent. Nothing reads or writes it unless
-- athlete.flags.tracks_v1 is true. No existing row is touched; workout.rpe,
-- workout.session_rpe (arc_load_v1), program, routine, program_revision rows
-- and athlete.training_max_overrides are not read or written here. Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete, instant
--   DROP TABLE public.session_rpe;                            -- optional

-- One row per (athlete, date, session): Foster's session RPE, one CR-10 rating
-- (0–10) of the whole session. NOT workout.rpe (the mean of the set RPEs) and
-- never merged into it. A second tap the same day updates the row; each tap
-- also writes one change_log row (standing:logging) with the before → after.
-- Session load (AU) = rating × duration_min, when the duration is known.
CREATE TABLE IF NOT EXISTS public.session_rpe (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  -- The athlete's calendar day the session was trained on.
  date          DATE NOT NULL,
  -- The session (routine) rated. The logged workout, when known.
  session_id    UUID NOT NULL REFERENCES public.routine(id) ON DELETE CASCADE,
  workout_id    UUID REFERENCES public.workout(id) ON DELETE SET NULL,
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 0 AND 10),
  duration_min  SMALLINT CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 600),
  -- The change_log row of the latest tap.
  change_id     UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT session_rpe_one_per_day UNIQUE (athlete_id, date, session_id)
);
CREATE INDEX IF NOT EXISTS session_rpe_athlete_date_idx ON public.session_rpe (athlete_id, date);
