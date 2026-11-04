-- coach_proposal on Neon: a coach change parked for the athlete to accept.
-- Hand-apply, like tracks-v1.sql: no RLS, no authenticated GRANT (the Worker
-- scopes every query by athlete). Mirrors
-- supabase/migrations/20261104000001_coach_proposal.sql. Revert: DROP TABLE.

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
