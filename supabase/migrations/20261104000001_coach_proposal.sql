-- coach_proposal: a change the coach (Claude through MCP, or the in-app coach)
-- previewed and parked for the athlete to accept on their phone.
--
-- Additive and idempotent. Revert: DROP TABLE public.coach_proposal.
-- Nothing reads it unless athlete.flags.tracks_v1 is true; the MCP tools say
-- proposals are off when the table is missing.
--
-- The preview's edits are stored with a fingerprint of the program they were
-- previewed against. Accepting applies exactly those edits, and refuses if the
-- program changed since (status 'stale').

CREATE TABLE IF NOT EXISTS public.coach_proposal (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  preview_id          TEXT NOT NULL,
  title               TEXT NOT NULL,
  rationale           TEXT,
  goal_ids            JSONB NOT NULL DEFAULT '[]'::jsonb,
  edits               JSONB NOT NULL,
  timing              TEXT NOT NULL DEFAULT 'now' CHECK (timing IN ('now', 'next_week')),
  request             TEXT,
  diff                JSONB NOT NULL DEFAULT '{}'::jsonb,
  program_fingerprint TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'declined', 'stale')),
  source              TEXT NOT NULL DEFAULT 'mcp' CHECK (source IN ('mcp', 'app')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS coach_proposal_athlete_idx
  ON public.coach_proposal (athlete_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS coach_proposal_pending_preview_uidx
  ON public.coach_proposal (athlete_id, preview_id)
  WHERE status = 'pending';

ALTER TABLE public.coach_proposal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coach_proposal_select ON public.coach_proposal;
CREATE POLICY coach_proposal_select ON public.coach_proposal
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS coach_proposal_insert ON public.coach_proposal;
CREATE POLICY coach_proposal_insert ON public.coach_proposal
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS coach_proposal_update ON public.coach_proposal;
CREATE POLICY coach_proposal_update ON public.coach_proposal
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE ON public.coach_proposal TO authenticated;
