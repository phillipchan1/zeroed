-- log_session_v1 (spec section 13): log a sport or conditioning session — a
-- game of basketball, a run, a class — with its duration, session RPE and pain,
-- in the app ("Add session") and over MCP (log_session / update_session /
-- delete_session). Each log is one workout row of kind 'sport_conditioning':
-- two games on the same day are two rows.
--
-- Additive and nullable only. No existing row is touched, nothing is dropped,
-- no CHECK on an existing column changes, and nothing reads or writes these
-- columns unless athlete.flags.log_session_v1 is true (except that readers
-- skip a row whose voided_at is set, and only a deleted log ever sets it).
--
--   workout.kind            'sport_conditioning' on a sport / conditioning log;
--                           null on every other workout, as before.
--   workout.activity        what it was ("Basketball"), free text. U7 and
--                           section 4 rule 3 read this, not the routine name
--                           (an off-plan log's routine is "Outside the plan").
--   workout.notes           the athlete's own note on it.
--   workout.pain            the pain entries as last logged ([{region, score,
--                           red_flags}]), for History. Health data. The U7 input
--                           is the pain_report rows, not this.
--   workout.logged_date     the athlete's calendar date of the session.
--   workout.change_id       the change_log row of the latest log / edit.
--   workout.pain_change_id  the change_log row whose pain_report rows are the
--                           log's current pain. Older ones are superseded.
--   workout.voided_at       set when the athlete (or a coach, standing:logging)
--   workout.void_change_id  deletes the log. The row is kept — the workout
--                           table is never DELETEd from — and every reader
--                           skips it, so a planned card it closed re-opens.
--   pain_report.workout_id  the log a pain report came from; null for a
--                           check-in. A report whose log is voided, or that a
--                           later edit superseded, no longer counts for U7.
--
-- Session RPE goes in the existing workout.session_rpe (arc_load_v1) and the
-- duration in workout.duration_mins: never workout.rpe (the set-RPE mean), and
-- never a session_rpe table row, so two same-day logs can't collide on
-- session_rpe (athlete_id, date, session_id).
--
-- Rollback:
--   UPDATE public.athlete SET flags = flags - 'log_session_v1';   -- instant
-- The columns can stay; with the flag off nothing writes them. To drop them
-- later (after the flag is off for everyone):
--   ALTER TABLE public.pain_report DROP COLUMN IF EXISTS workout_id;
--   ALTER TABLE public.workout DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS activity,
--     DROP COLUMN IF EXISTS notes, DROP COLUMN IF EXISTS pain, DROP COLUMN IF EXISTS logged_date,
--     DROP COLUMN IF EXISTS change_id, DROP COLUMN IF EXISTS pain_change_id,
--     DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS void_change_id;

ALTER TABLE public.workout
  ADD COLUMN IF NOT EXISTS kind TEXT
    CHECK (kind IS NULL OR kind = 'sport_conditioning'),
  ADD COLUMN IF NOT EXISTS activity TEXT
    CHECK (activity IS NULL OR length(activity) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS notes TEXT
    CHECK (notes IS NULL OR length(notes) <= 2000),
  ADD COLUMN IF NOT EXISTS pain JSONB,
  ADD COLUMN IF NOT EXISTS logged_date DATE,
  ADD COLUMN IF NOT EXISTS change_id UUID,
  ADD COLUMN IF NOT EXISTS pain_change_id UUID,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_change_id UUID;

CREATE INDEX IF NOT EXISTS workout_sport_log_idx
  ON public.workout (athlete_id, logged_date)
  WHERE kind = 'sport_conditioning';

COMMENT ON COLUMN public.workout.kind IS
  'sport_conditioning = a sport / conditioning log (log_session_v1); null = any other workout.';
COMMENT ON COLUMN public.workout.voided_at IS
  'A deleted sport log: kept, skipped by every reader. Never set on any other workout.';

-- pain_report exists once readiness (20261104000006) is applied; this
-- migration runs after it.
ALTER TABLE public.pain_report
  ADD COLUMN IF NOT EXISTS workout_id UUID;

COMMENT ON COLUMN public.pain_report.workout_id IS
  'The sport log (workout) this pain came from; null for a check-in.';
