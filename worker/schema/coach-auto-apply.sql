-- Coach auto-apply for weekly program-edit proposals made through MCP.
-- Hand-apply on Neon, like coach-proposal.sql: no RLS, no GRANT (the Worker
-- scopes every query by athlete). Additive and idempotent.
--
-- athlete.coach_auto_apply  per-athlete toggle, default OFF. The athlete
--                           turns it on in Profile (/api/data). Nothing in
--                           this file or in the Worker turns it on for anyone.
-- coach_auto_apply_notice   in-app notice after an auto-applied program edit,
--                           holding the prior program version so Undo can
--                           restore it exactly.
--
-- Does not drop, rename, or change types. Does not touch program, phase,
-- routine, program_revision, change_log or existing coach_proposal rows.
--
-- Apply this AFTER coach-proposal.sql. Until the column exists the Worker
-- reads auto-apply as off (to_jsonb), so apply_program_edits is unchanged.
--
-- ROLLBACK
--   1. Instant, per athlete: UPDATE public.athlete SET coach_auto_apply = false WHERE id = '…';
--   2. Code rollback: the previous Worker never names these objects.
--   3. Optional, once nobody needs the rows:
--      DROP TABLE public.coach_auto_apply_notice;
--      ALTER TABLE public.athlete DROP COLUMN coach_auto_apply;

ALTER TABLE public.athlete ADD COLUMN IF NOT EXISTS coach_auto_apply BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.athlete.coach_auto_apply IS
  'When true, apply_program_edits may apply a pending program-edit proposal without approval_ref. Default false; only the athlete turns it on.';

CREATE TABLE IF NOT EXISTS public.coach_auto_apply_notice (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  proposal_id    UUID REFERENCES public.coach_proposal(id) ON DELETE SET NULL,
  change_id      UUID,
  diff_text      TEXT NOT NULL,
  prior_version  JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS coach_auto_apply_notice_athlete_idx
  ON public.coach_auto_apply_notice (athlete_id, created_at DESC);
