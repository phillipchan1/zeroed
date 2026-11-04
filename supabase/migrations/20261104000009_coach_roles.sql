-- Coach roles (D3, spec section 11 item 2; tracks_v1): each coach token is
-- 'read' or 'propose'. A read coach sees and can call only the read tools
-- (get_*, list_*, search_*); every preview, apply and logging write is hidden
-- from tools/list and refused server-side, and the refusal is logged. A
-- propose coach is exactly as before: preview, then apply with the athlete's
-- approval. No role approves. Only the athlete changes a role (Profile →
-- Coach access, tracks_v1), and that change is logged in change_log.
--
-- Additive and idempotent: one column via ADD COLUMN IF NOT EXISTS, default
-- 'propose', so every existing token keeps exactly the powers it has today.
-- No existing row's other values are touched; program, phase, routine,
-- program_revision, change_log rows and athlete.training_max_overrides are
-- not read or written here. The red-flag clear (athlete only) needs no schema:
-- it supersedes the methodology_override row, which that table already allows.
-- Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete: role UI and route off
--   UPDATE public.mcp_token SET role = 'propose';            -- every coach back to today's powers
--   ALTER TABLE public.mcp_token DROP COLUMN role;            -- optional; the Worker reads it as 'propose' when absent

ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'propose';

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_token_role_check') THEN
    ALTER TABLE public.mcp_token ADD CONSTRAINT mcp_token_role_check CHECK (role IN ('read', 'propose'));
  END IF;
END
$c$;
