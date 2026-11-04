-- session_override (G1): a week-only change to ONE dated session — add, swap,
-- drop or adjust an exercise, or move an exercise / the whole session to
-- another day — without touching the program template.
--
-- Additive and idempotent. Nothing reads these tables unless
-- athlete.flags.tracks_v1 is true, and /api/session-rx only consults them when
-- the request names a date. Revert (any order):
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete, instant
--   DROP TABLE public.session_override, public.session_override_preview,
--              public.session_override_log;                  -- optional
--   ALTER TABLE public.coach_proposal DROP COLUMN kind;       -- optional
-- Program, phase and routine rows are never written by this feature.
--
-- session_override     one row per (date, routine). ops is a JSONB array. A
--                      move is two rows sharing pair_id: move_out on the source
--                      date, move_in on the target. Applies only on `date`, and
--                      never after expires_on (default: the Sunday ending the
--                      date's ISO week; at most date + 7). Expired and cleared
--                      rows stay for audit.
-- session_override_preview  what preview_session_override showed. apply needs a
--                      preview under 24 h old whose diff still matches.
-- session_override_log append-only audit, shaped like spec section 6's change_log.

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

ALTER TABLE public.session_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_override_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_override_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_override_select ON public.session_override;
CREATE POLICY session_override_select ON public.session_override
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS session_override_preview_select ON public.session_override_preview;
CREATE POLICY session_override_preview_select ON public.session_override_preview
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS session_override_log_select ON public.session_override_log;
CREATE POLICY session_override_log_select ON public.session_override_log
  FOR SELECT USING (athlete_id = get_current_athlete_id());

-- Reads only for the client role. Every write goes through the Worker, which
-- checks preview, approval and ownership first.
GRANT SELECT ON public.session_override TO authenticated;
GRANT SELECT ON public.session_override_preview TO authenticated;
GRANT SELECT ON public.session_override_log TO authenticated;
