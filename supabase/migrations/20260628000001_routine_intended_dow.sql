-- Soft day-pinning — an optional, never-enforced "I mean to do this session on
-- this day" hint surfaced on the Train screen. Scheduling stays count-based
-- (computeWeekSchedule is untouched); this only labels the cards and lets the
-- athlete lay out a week. Nullable: null / absent = "any day".
--
-- 0 = Monday … 6 = Sunday. No new RLS needed — the existing routine_update
-- policy already lets an athlete update their own program's routines.

ALTER TABLE public.routine ADD COLUMN IF NOT EXISTS intended_dow SMALLINT
  CHECK (intended_dow IS NULL OR (intended_dow >= 0 AND intended_dow <= 6));

COMMENT ON COLUMN public.routine.intended_dow IS
  'Soft day-pin: 0=Mon..6=Sun, null=any. Suggestion only; scheduling stays count-based.';
