-- log_session_v1 columns on Neon (spec section 13). Hand-apply, like
-- session-rpe.sql: no RLS, no GRANT (the Worker scopes every query by
-- athlete). Mirrors supabase/migrations/20261113000001_log_session_v1.sql.
-- Fresh Neon installs get the same columns from worker/schema/app.sql.
--
-- Additive and idempotent: nullable ADD COLUMN IF NOT EXISTS only (no default,
-- so no existing row is rewritten), one partial index, comments. Does not
-- touch workout.rpe, workout.session_rpe's CHECK, session_rpe, program,
-- routine, change_log rows or athlete.training_max_overrides, and drops
-- nothing. Apply AFTER readiness.sql (pain_report must exist).
--
-- NOT applied anywhere by this change: it ships in the PR only.
--
-- What each column holds, and the rollback, are in the migration's header.
-- Rollback: UPDATE public.athlete SET flags = flags - 'log_session_v1';

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
