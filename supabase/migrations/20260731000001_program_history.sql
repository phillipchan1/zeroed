-- =============================================================================
-- PROGRAM HISTORY — the journey, and the record that makes it readable.
--
-- Two holes this closes, both of which cost the athlete their own past.
--
-- 1. REPROGRAMMING IS DESTRUCTIVE. A phase boundary inserts fresh routine rows
--    against a new phase_id, so a completed block keeps its prescription. But
--    the conversational editor (applyProgramDraft) UPDATEs routine rows in
--    place — so "what did my program look like before I reprogrammed in July?"
--    has no answer, and the coach_message left behind carries counts ("3 added ·
--    1 dropped") rather than what actually changed. program_revision makes every
--    reprogramming event an append-only record: what it was before, what moved,
--    what the athlete asked for in their own words, and when it took effect.
--
-- 2. LOGGED HISTORY IS RELABELED BY EDITS. workout.actual_weights is keyed by
--    the exercise's INDEX in routine.exercises ({"0": [...], "1": [...]}), and
--    every read resolves names by indexing back into the routine's CURRENT list.
--    That binding is only stable while the routine is. The editor splices —
--    inserting at anchor+1, removing with splice(ei,1) — so adding one movement
--    to the middle of a session shifts every index after it and silently
--    reattributes sets the athlete already logged: last week's squats become
--    tomorrow's calf raises, retroactively, with no warning. exercises_snapshot
--    freezes the prescription onto the workout at log time, so the log is
--    self-describing and an edit can never rewrite what was already done.
--
-- Together they are the same idea applied twice: the past is a record, not a
-- projection of current state.
-- =============================================================================

-- ---- workout.exercises_snapshot --------------------------------------------
-- The prescription AS IT WAS when this session was logged. Reads resolve
-- actual_weights against this and fall back to routine.exercises only when it's
-- absent (a session logged by a client older than this migration).

ALTER TABLE public.workout ADD COLUMN IF NOT EXISTS exercises_snapshot JSONB;

COMMENT ON COLUMN public.workout.exercises_snapshot IS
  'The routine''s exercises at the moment this session was logged. actual_weights '
  'is index-keyed against THIS array, not the routine''s live one, so editing a '
  'program never relabels sets that were already logged.';

-- Backfill. Every existing workout predates program editing having a snapshot,
-- so the routine's current list is the best available answer — and it is the
-- correct one for any routine not edited since. Idempotent: only fills NULLs.
UPDATE public.workout w
SET exercises_snapshot = r.exercises
FROM public.routine r
WHERE r.id = w.routine_id
  AND w.exercises_snapshot IS NULL;

-- ---- program_revision -------------------------------------------------------
-- One row per reprogramming event. Append-only in the strongest sense: SELECT
-- and INSERT only, no UPDATE or DELETE policy at all. A revision is a historical
-- fact — if it were editable it would not be history.

CREATE TABLE IF NOT EXISTS public.program_revision (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    UUID        NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  -- The phase this revision acted on. SET NULL rather than CASCADE: losing the
  -- phase must not erase the record that the athlete changed something.
  phase_id      UUID        REFERENCES public.phase(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- What caused it. 'editor' is the athlete steering by hand; the rest are the
  -- loop reprogramming on its own cadence.
  trigger       TEXT        NOT NULL DEFAULT 'editor'
                  CHECK (trigger IN ('editor','phase_boundary','retest','deload')),
  -- The date the change actually takes effect. Equal to created_at::date for an
  -- immediate apply; next Monday for one deferred to the week boundary.
  effective_on  DATE        NOT NULL,
  -- The athlete's own words, newest first: ["more basketball explosiveness"].
  -- Their language, not a summary of it — this is what makes the timeline read
  -- like their journey rather than the system's changelog.
  requests      JSONB       NOT NULL DEFAULT '[]',
  -- The full week BEFORE the change: [{name, intent, session_type, intended_dow,
  -- exercises:[...]}]. The restore point, and what a diff is computed against.
  snapshot      JSONB       NOT NULL DEFAULT '[]',
  -- What moved, already computed: {added, removed, changed, new_sessions,
  -- sessions:[{name, changes:[{kind, name, before, after}]}]}. Stored rather
  -- than derived so the timeline renders without replaying every snapshot.
  diff          JSONB       NOT NULL DEFAULT '{}',
  -- One human line for the timeline row.
  summary       TEXT
);

CREATE INDEX IF NOT EXISTS program_revision_program_id_idx
  ON public.program_revision(program_id, created_at DESC);

ALTER TABLE public.program_revision ENABLE ROW LEVEL SECURITY;

CREATE POLICY program_revision_select ON public.program_revision
  FOR SELECT USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY program_revision_insert ON public.program_revision
  FOR INSERT WITH CHECK (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

-- No UPDATE, no DELETE — deliberately. See the table comment.
GRANT SELECT, INSERT ON public.program_revision TO authenticated;

COMMENT ON TABLE public.program_revision IS
  'Append-only log of every reprogramming event: the week before it, what moved, '
  'what the athlete asked for, and when it took effect. Never updated or deleted — '
  'it is the athlete''s training journey, and the memory reprogramming reads back.';
