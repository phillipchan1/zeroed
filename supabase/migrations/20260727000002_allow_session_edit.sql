-- Let an athlete edit a session they already logged.
--
-- `workout` and `session_observation` were built append-only: SELECT + INSERT
-- grants, and no UPDATE/DELETE policies. Session editing shipped afterwards and
-- commitSession()'s edit path does exactly what the schema forbids — it UPDATEs
-- the workout row in place and DELETEs the prior observations so the coach
-- re-reads the corrected session instead of stacking a duplicate.
--
-- The result was silent and permanent: Postgres refused with 42501, the commit
-- threw, and the session stayed in the client outbox forever, re-failing on every
-- flush. Until the outbox learned to step over a rejected entry, that one session
-- also blocked every good session queued behind it — which is how a fully-online
-- athlete ends up staring at "10 sessions saved offline".
--
-- So the invariant is narrowed rather than dropped. A workout is still immutable
-- to everyone except the athlete who owns it, and it still can't be deleted at
-- all: the log is append-only in the sense that matters (sessions can't vanish),
-- while a correction to your own numbers is allowed. Observations are derived
-- from the debrief, not athlete-authored history, so they're replaceable — but
-- only for a workout you own.

-- ---- workout: UPDATE, scoped to your own program ---------------------------

GRANT UPDATE ON public.workout TO authenticated;

-- Both clauses matter: USING picks the rows you may touch, WITH CHECK stops an
-- update from re-pointing a row at someone else's routine.
DROP POLICY IF EXISTS workout_update ON public.workout;
CREATE POLICY workout_update ON public.workout
  FOR UPDATE
  USING (
    routine_id IN (
      SELECT r.id FROM public.routine r
      INNER JOIN public.program p ON p.id = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  )
  WITH CHECK (
    routine_id IN (
      SELECT r.id FROM public.routine r
      INNER JOIN public.program p ON p.id = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  );

COMMENT ON TABLE public.workout IS
  'Executed sessions. Append-only in the sense that matters: no DELETE, ever. '
  'An athlete may UPDATE their own row to correct a logged session.';

-- ---- session_observation: DELETE, scoped to your own workouts --------------

GRANT DELETE ON public.session_observation TO authenticated;

DROP POLICY IF EXISTS session_observation_delete ON public.session_observation;
CREATE POLICY session_observation_delete ON public.session_observation
  FOR DELETE
  USING (
    workout_id IN (
      SELECT w.id FROM public.workout w
      INNER JOIN public.routine r ON r.id = w.routine_id
      INNER JOIN public.program p ON p.id = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  );

COMMENT ON TABLE public.session_observation IS
  'Tagged signals from a workout debrief. Derived, not authored: cleared and '
  're-derived when the athlete edits the session they came from.';
