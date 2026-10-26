-- =============================================================================
-- MCP TOKENS — revocable bearer tokens for Claude (web/mobile) remote MCP.
-- Raw token is never stored: sha256 hex + last four only. Edge function looks
-- up by hash with the service role; the athlete manages own rows via RLS.
-- =============================================================================

-- Version and body are exactly what production recorded (it was applied by
-- hand on 2026-08-27, with the DROP POLICY guards); renamed to match so
-- `supabase db push` sees one history.

CREATE TABLE IF NOT EXISTS public.mcp_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   uuid NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  last_four    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS mcp_token_athlete_idx ON public.mcp_token (athlete_id);
CREATE INDEX IF NOT EXISTS mcp_token_hash_live_idx ON public.mcp_token (token_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.mcp_token ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcp_token_select ON public.mcp_token;
DROP POLICY IF EXISTS mcp_token_insert ON public.mcp_token;
DROP POLICY IF EXISTS mcp_token_update ON public.mcp_token;
DROP POLICY IF EXISTS mcp_token_delete ON public.mcp_token;

CREATE POLICY mcp_token_select ON public.mcp_token
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY mcp_token_insert ON public.mcp_token
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY mcp_token_update ON public.mcp_token
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

CREATE POLICY mcp_token_delete ON public.mcp_token
  FOR DELETE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_token TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_token TO service_role;;
