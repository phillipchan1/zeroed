-- Standing instructions from the athlete — what they have TOLD the coach they
-- want their training to include ("more basketball explosiveness", "a short HIIT
-- day", "my sessions are too short").
--
-- Without this, steering is a one-block affair: the conversational program
-- editor (src/engine/programEdit.ts) reshapes the ACTIVE phase, and then the
-- next phase is designed from scratch at the block boundary and quietly drops
-- everything the athlete asked for. Persisting the ask means the next phase is
-- designed with it as the emphasis — the preference outlives the block it was
-- made in.
--
-- Free text, appended most-recent-first and capped client-side. No new RLS: the
-- existing athlete_update policy already scopes this to the athlete's own row.

ALTER TABLE public.athlete ADD COLUMN IF NOT EXISTS training_preferences TEXT;

COMMENT ON COLUMN public.athlete.training_preferences IS
  'Athlete-stated standing training preferences, newest first. Fed to phase design as the emphasis so steering survives a phase change.';
