-- session_override on Neon (G1, tracks_v1): week-only per-date session
-- overrides, their previews, and an append-only audit log. Hand-apply, like
-- tracks-v1.sql and coach-proposal.sql: no RLS, no GRANT (the Worker scopes
-- every query by athlete). Mirrors
-- supabase/migrations/20261104000002_session_override.sql.
--
-- Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS and one
-- ADD COLUMN IF NOT EXISTS. Does not touch program, phase, routine rows or
-- athlete.training_max_overrides.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET flags = flags - 'tracks_v1' WHERE id = '…';
--      With the flag off /api/session-rx ignores overrides (byte-identical
--      output), the MCP override tools are not listed, and nothing is written.
--   2. Optional, once nobody needs the audit rows:
--      DROP TABLE public.session_override, public.session_override_preview,
--                 public.session_override_log;
--      ALTER TABLE public.coach_proposal DROP COLUMN kind;
--   The Worker treats missing tables as "overrides unavailable", so step 2 is
--   safe with the code still deployed.

CREATE TABLE IF NOT EXISTS public.session_override (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  date              DATE NOT NULL,
  routine_id        UUID NOT NULL REFERENCES public.routine(id) ON DELETE CASCADE,
  ops               JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_on        DATE NOT NULL,
  pair_id           UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id          TEXT NOT NULL,
  rationale         TEXT,
  approval_ref      TEXT NOT NULL,
  preview_id        TEXT NOT NULL,
  voided_at         TIMESTAMPTZ,
  void_approval_ref TEXT,
  void_preview_id   TEXT,
  CONSTRAINT session_override_expiry_window
    CHECK (expires_on >= date AND expires_on <= date + 7)
);
CREATE INDEX IF NOT EXISTS session_override_athlete_date_idx
  ON public.session_override (athlete_id, date, routine_id)
  WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS public.session_override_preview (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  preview_id  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('create', 'clear')),
  request     JSONB NOT NULL,
  diff        JSONB NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id    TEXT NOT NULL,
  rationale   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at     TIMESTAMPTZ,
  voided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS session_override_preview_athlete_idx
  ON public.session_override_preview (athlete_id, created_at DESC);

-- Append-only. Columns are spec section 6's change_log, so G2 can copy rows
-- across as they are.
CREATE TABLE IF NOT EXISTS public.session_override_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  target       JSONB NOT NULL DEFAULT '{}'::jsonb,
  diff         JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale    TEXT,
  rule_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_ref TEXT,
  preview_id   TEXT,
  expires_on   DATE,
  reverted_by  UUID
);
CREATE INDEX IF NOT EXISTS session_override_log_athlete_idx
  ON public.session_override_log (athlete_id, created_at DESC);

-- A coach proposal can now park a session override as well as program edits.
ALTER TABLE public.coach_proposal
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'program_edits'
    CHECK (kind IN ('program_edits', 'session_override'));
