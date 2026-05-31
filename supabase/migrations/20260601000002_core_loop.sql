-- =============================================================================
-- Core Loop Completion — coach_message (conversational + event memory)
--
-- The growing record the outer cadences write into: a weekly review, a phase
-- change, a retest delta, or a plain coach note. Mirrors the RLS pattern of the
-- other athlete-scoped tables (gated by get_current_athlete_id()).
--
-- NOTE: filename dated to follow the latest existing migration
-- (20260601000001_confidence_read_steps.sql); the spec's suggested
-- 20260530000001 name already belongs to the onboarding_step migration.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.coach_message (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('coach','athlete')),
  kind        TEXT        NOT NULL DEFAULT 'note'
                          CHECK (kind IN ('note','weekly_review','phase_change','retest','chat')),
  body        TEXT        NOT NULL,
  ref_id      UUID,        -- optional pointer to weekly_review / phase / diagnostic
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coach_message_athlete_idx
  ON public.coach_message(athlete_id, created_at DESC);

ALTER TABLE public.coach_message ENABLE ROW LEVEL SECURITY;

CREATE POLICY coach_message_select ON public.coach_message
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY coach_message_insert ON public.coach_message
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY coach_message_update ON public.coach_message
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

-- No DELETE — the coach record is append-mostly memory.

-- Table-level privileges (RLS still gates row visibility). Mirrors grants.sql.
GRANT SELECT, INSERT, UPDATE ON public.coach_message TO authenticated;
