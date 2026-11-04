-- session_rpe on Neon (G9, tracks_v1). Hand-apply, like readiness.sql: no RLS,
-- no GRANT (the Worker scopes every query by athlete). Mirrors
-- supabase/migrations/20261104000007_session_rpe.sql.
--
-- Additive and idempotent: one CREATE TABLE / INDEX IF NOT EXISTS. Does not
-- touch workout (neither workout.rpe, the set-RPE mean, nor arc_load_v1's
-- workout.session_rpe), program, routine, program_revision, change_log rows
-- or athlete.training_max_overrides.
--
-- session_rpe   one CR-10 rating (0–10) of a whole session, per athlete, date
--               and session (routine). A second tap the same day updates the
--               row instead of adding one; only the athlete writes it, only
--               for their own today. Every tap writes one change_log row
--               (standing:logging, before → after).
--
-- Apply this AFTER readiness.sql and BEFORE deploying the G9 Worker for any
-- athlete with tracks_v1 on: until it exists the rating tap answers "not set
-- up" (nothing written), get_session_rpe says so, and the weekly review's
-- session_load section is empty. With the flag off nothing here is read or
-- written: /api/session-rx, the MCP tool list and every tool behave exactly
-- as before, and /api/session-rpe answers 404.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off: no rating tap after a session (unless arc_load_v1
--      shows its own, which writes workout.session_rpe as before), the Workout
--      screen starts the template session (no date sent to /api/session-rx),
--      no get_session_rpe tool, no session_load in the weekly review, and
--      /api/session-rpe answers 404.
--   2. Code rollback: redeploy the previous Worker. The table is ignored by it
--      (it never names it).
--   3. Optional, once nobody needs the rows: DROP TABLE public.session_rpe;
--   Step 3 is safe with the code still deployed as long as step 1 came first.

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
