-- =============================================================================
-- WORKOUT_DRAFT — an in-progress session, autosaved as it's logged.
--
-- The `workout` table is APPEND-ONLY and statusless: a row there *means* "session
-- completed" (the week strip, the scheduler in useAppState, and the weekly review
-- all read it that way). So an in-progress session cannot live there without
-- being mistaken for a finished one. This table is the staging area: the
-- WorkoutScreen autosaves into it on every change, and on "Complete workout" the
-- draft is promoted to a real `workout` row and the draft is deleted.
--
-- One draft per (athlete, routine) — starting the same session resumes it. Drafts
-- are recoverable only within their own week (started_at >= this Monday); the
-- client filters and opportunistically deletes stale ones, mirroring the Mon–Sun
-- cadence the rest of the loop runs on.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.workout_draft (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  routine_id      UUID        NOT NULL REFERENCES public.routine(id) ON DELETE CASCADE,
  set_logs        JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { "0": [{set,weight,reps,...}], ... }
  feedback        JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { "0": {name,felt,note}, ... }
  elapsed_seconds INTEGER     NOT NULL DEFAULT 0,            -- accumulated training time (stop/continue)
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (athlete_id, routine_id)
);

CREATE INDEX IF NOT EXISTS workout_draft_athlete_idx
  ON public.workout_draft(athlete_id, updated_at DESC);

ALTER TABLE public.workout_draft ENABLE ROW LEVEL SECURITY;

CREATE POLICY workout_draft_select ON public.workout_draft
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY workout_draft_insert ON public.workout_draft
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY workout_draft_update ON public.workout_draft
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

-- Unlike workout, a draft IS deletable — it's cleared on completion and on
-- weekly expiry.
CREATE POLICY workout_draft_delete ON public.workout_draft
  FOR DELETE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workout_draft TO authenticated;
