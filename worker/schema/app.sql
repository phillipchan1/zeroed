-- Neon-compatible Zeroed app schema (tables, constraints, indexes).
-- Derived from supabase/migrations with Supabase roles, RLS, auth.uid()
-- policies, and GRANTs stripped. Access is enforced in the Worker.
--
-- Restore order (the migrate script does this itself):
--   1. Apply this file, then worker/schema/better-auth.sql
--   2. Load auth user mappings (same UUIDs) into auth.users + Better Auth "user"
--   3. Data-only restore of public.* via scripts/migrate-supabase-to-neon.mjs
-- Do not pg_restore a full Supabase dump on top of this file — it would
-- recreate RLS / GRANT artifacts. Use --data-only.

CREATE SCHEMA IF NOT EXISTS auth;

-- Stub so public.athlete.auth_user_id can keep its FK. Not Supabase Auth.
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY,
  email TEXT,
  raw_user_meta_data JSONB,
  email_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- ATHLETE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.athlete (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT,
  sport             TEXT,
  goals             TEXT,
  training_age      INTEGER,
  sessions_per_week INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  onboarding_step   TEXT        NOT NULL DEFAULT 'hook',
  obstacle          TEXT,
  arena_type        TEXT,
  arena_raw         TEXT,
  limiter_choice    TEXT,
  training_preferences TEXT,
  training_max_overrides JSONB,
  -- arc_load_v1 (migration 20261028000001).
  flags             JSONB,
  time_zone         TEXT,
  CONSTRAINT athlete_auth_user_unique UNIQUE (auth_user_id),
  CONSTRAINT athlete_onboarding_step_check CHECK (onboarding_step IN (
    'hook',
    'orientation',
    'first_session_pending',
    'first_session_complete',
    'complete'
  )),
  CONSTRAINT athlete_arena_type_check CHECK (
    arena_type IS NULL OR arena_type IN (
      'sport', 'number', 'body', 'durability', 'event', 'all_around'
    )
  )
);

COMMENT ON COLUMN public.athlete.training_max_overrides IS
  'Hand-set training maxes by lift id: {"bench": {"value": 275, "set_at": "<iso>", "model_tm": 268.4}} (older writes are a bare number), storage weight unit. Absent lifts use 90% of the working max.';

COMMENT ON COLUMN public.athlete.flags IS
  'Per-athlete runtime feature flags, e.g. {"arc_load_v1": true}. Set by hand.';

COMMENT ON COLUMN public.athlete.time_zone IS
  'The athlete''s training calendar (IANA zone). Null = America/Los_Angeles.';

COMMENT ON COLUMN public.athlete.training_preferences IS
  'Athlete-stated standing training preferences, newest first. Fed to phase design as the emphasis so steering survives a phase change.';

-- =============================================================================
-- DIAGNOSTIC
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.diagnostic (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  assessed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  test_battery     JSONB,
  raw_results      JSONB,
  delta_from_prior JSONB,
  version          INTEGER     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS diagnostic_athlete_id_idx ON public.diagnostic(athlete_id);

-- =============================================================================
-- INSIGHT
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.insight (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID         NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  source_id      UUID,
  claim          TEXT         NOT NULL,
  category       TEXT         NOT NULL,
  priority       TEXT         NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  confidence     NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  status         TEXT         NOT NULL DEFAULT 'hypothesis'
                  CHECK (status IN ('hypothesis','likely','confirmed','resolved','disproved')),
  evidence       JSONB,
  source         TEXT,
  program_impact TEXT,
  generated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  prev_status    TEXT
);

CREATE INDEX IF NOT EXISTS insight_athlete_id_idx ON public.insight(athlete_id);
CREATE INDEX IF NOT EXISTS insight_priority_idx   ON public.insight(priority);
CREATE INDEX IF NOT EXISTS insight_status_idx     ON public.insight(status);
CREATE INDEX IF NOT EXISTS insight_updated_at_idx ON public.insight(updated_at);

CREATE OR REPLACE FUNCTION public.insight_track_movement()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.prev_status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS insight_track_movement_trg ON public.insight;

CREATE TRIGGER insight_track_movement_trg
  BEFORE UPDATE ON public.insight
  FOR EACH ROW
  EXECUTE FUNCTION public.insight_track_movement();

-- =============================================================================
-- INSIGHT_DRAFT
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.insight_draft (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID         NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  source_id      UUID,
  claim          TEXT         NOT NULL,
  category       TEXT         NOT NULL,
  priority       TEXT         NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  confidence     NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  status         TEXT         NOT NULL DEFAULT 'hypothesis'
                  CHECK (status IN ('hypothesis','likely','confirmed','resolved','disproved')),
  evidence       JSONB,
  source         TEXT,
  program_impact TEXT,
  generated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  reviewed       BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS insight_draft_athlete_id_idx ON public.insight_draft(athlete_id);
CREATE INDEX IF NOT EXISTS insight_draft_reviewed_idx   ON public.insight_draft(reviewed);

-- =============================================================================
-- ATHLETE_PROFILE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.athlete_profile (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_phase TEXT,
  retest_date   DATE,
  CONSTRAINT athlete_profile_unique UNIQUE (athlete_id)
);

-- =============================================================================
-- PROGRAM
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.program (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  goal        TEXT,
  start_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  retest_date DATE,
  status      TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('draft','active','completed','paused','external')),
  -- tracks_v1 block metadata (migration 20261103000001).
  name               TEXT,
  block_phase        TEXT,
  end_date           DATE,
  deload_week_start  DATE,
  retest_start       DATE,
  retest_end         DATE
);

CREATE INDEX IF NOT EXISTS program_athlete_id_idx ON public.program(athlete_id);

-- One 'external' program per athlete: it holds the sessions logged outside the
-- plan and the coach's one-offs (arc_load_v1), never the planned week.
CREATE UNIQUE INDEX IF NOT EXISTS program_one_external_per_athlete
  ON public.program(athlete_id) WHERE status = 'external';

-- =============================================================================
-- PHASE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.phase (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id           UUID NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL CHECK (name IN ('Stability','Strength','Power','Sport')),
  week_start           DATE NOT NULL,
  week_end             DATE NOT NULL,
  non_negotiables      JSONB,
  advancement_criteria JSONB,
  status               TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','completed','skipped'))
);

CREATE INDEX IF NOT EXISTS phase_program_id_idx ON public.phase(program_id);

-- =============================================================================
-- ROUTINE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.routine (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   UUID NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  phase_id     UUID REFERENCES public.phase(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  session_type TEXT,
  exercises    JSONB NOT NULL DEFAULT '[]',
  intent       TEXT,
  intended_dow SMALLINT CHECK (intended_dow IS NULL OR (intended_dow >= 0 AND intended_dow <= 6))
);

CREATE INDEX IF NOT EXISTS routine_program_id_idx ON public.routine(program_id);
CREATE INDEX IF NOT EXISTS routine_phase_id_idx   ON public.routine(phase_id);

COMMENT ON COLUMN public.routine.intended_dow IS
  'Soft day-pin: 0=Mon..6=Sun, null=any. Suggestion only; scheduling stays count-based.';

-- =============================================================================
-- WORKOUT
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.workout (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id         UUID        NOT NULL REFERENCES public.routine(id) ON DELETE RESTRICT,
  performed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actual_weights     JSONB,
  actual_reps        JSONB,
  rpe                INTEGER CHECK (rpe BETWEEN 1 AND 10),
  duration_mins      INTEGER,
  exercises_snapshot JSONB,
  -- The session check-in (migration 20261026000001), each optional.
  knee_pain_l        SMALLINT CHECK (knee_pain_l IS NULL OR knee_pain_l BETWEEN 0 AND 10),
  knee_pain_r        SMALLINT CHECK (knee_pain_r IS NULL OR knee_pain_r BETWEEN 0 AND 10),
  sleep_hours        NUMERIC(3, 1) CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 24),
  readiness          SMALLINT CHECK (readiness IS NULL OR readiness BETWEEN 1 AND 10),
  bodyweight         NUMERIC(6, 1) CHECK (bodyweight IS NULL OR bodyweight > 0),
  -- arc_load_v1 (migration 20261028000001): Foster session RPE for the whole
  -- session, and 'external' for a session logged outside the plan.
  session_rpe        NUMERIC(3, 1) CHECK (session_rpe IS NULL OR (session_rpe >= 0 AND session_rpe <= 10)),
  source             TEXT CHECK (source IS NULL OR source IN ('plan', 'external')),
  -- Idempotent commit (migration 20261030000001): the client's outbox entry id,
  -- unique per athlete so a retry returns the existing row. Null on older rows.
  athlete_id         UUID REFERENCES public.athlete(id) ON DELETE RESTRICT,
  client_key         TEXT,
  CONSTRAINT workout_client_key_needs_athlete
    CHECK (client_key IS NULL OR athlete_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workout_routine_id_idx   ON public.workout(routine_id);
CREATE INDEX IF NOT EXISTS workout_performed_at_idx ON public.workout(performed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workout_athlete_client_key_uidx
  ON public.workout (athlete_id, client_key)
  WHERE client_key IS NOT NULL;

COMMENT ON TABLE public.workout IS
  'Executed sessions. Append-only in the sense that matters: no DELETE, ever. '
  'An athlete may UPDATE their own row to correct a logged session.';

COMMENT ON COLUMN public.workout.exercises_snapshot IS
  'The routine''s exercises at the moment this session was logged. actual_weights '
  'is index-keyed against THIS array, not the routine''s live one, so editing a '
  'program never relabels sets that were already logged.';

-- NUMERIC half-step RPE is NOT in this snapshot. migrate-supabase-to-neon
-- applies this file to Neon; keep INTEGER CHECK 1–10 to match live Supabase.
-- Hand-apply worker/schema/rpe-half-steps.sql only when flipping RPE_HALF_STEPS.
--
-- arc_load_v1's columns ARE in this snapshot (session_rpe, source above;
-- athlete.flags / time_zone; program status 'external'): migration
-- 20261028000001 is live on Supabase, Neon production and the dev branch.
--
-- workout.athlete_id / client_key ARE in this snapshot (migration
-- 20261030000001). Hand-apply worker/schema/workout-client-key.sql on a
-- Neon created before they landed.

-- =============================================================================
-- SESSION_OBSERVATION
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.session_observation (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_id UUID        NOT NULL REFERENCES public.workout(id) ON DELETE RESTRICT,
  category   TEXT        NOT NULL,
  signal     TEXT        NOT NULL,
  severity   INTEGER     NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
  logged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_obs_workout_id_idx ON public.session_observation(workout_id);
CREATE INDEX IF NOT EXISTS session_obs_category_idx   ON public.session_observation(category);

COMMENT ON TABLE public.session_observation IS
  'Tagged signals from a workout debrief. Derived, not authored: cleared and '
  're-derived when the athlete edits the session they came from.';

-- =============================================================================
-- WEEKLY_REVIEW
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.weekly_review (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id             UUID NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  week_ending            DATE NOT NULL,
  coach_notes            TEXT,
  adjustments            JSONB,
  next_week_prescription JSONB
);

CREATE INDEX IF NOT EXISTS weekly_review_program_id_idx ON public.weekly_review(program_id);

-- =============================================================================
-- COACH_MESSAGE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.coach_message (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('coach','athlete')),
  kind       TEXT        NOT NULL DEFAULT 'note'
              CHECK (kind IN ('note','weekly_review','phase_change','retest','chat')),
  body       TEXT        NOT NULL,
  ref_id     UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coach_message_athlete_idx
  ON public.coach_message(athlete_id, created_at DESC);

-- =============================================================================
-- PROBE_THROTTLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.probe_throttle (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id  TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS probe_throttle_device_idx ON public.probe_throttle(device_id, created_at);
CREATE INDEX IF NOT EXISTS probe_throttle_ip_idx     ON public.probe_throttle(ip, created_at);

-- =============================================================================
-- WORKOUT_DRAFT
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.workout_draft (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  routine_id      UUID        NOT NULL REFERENCES public.routine(id) ON DELETE CASCADE,
  set_logs        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  feedback        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  elapsed_seconds INTEGER     NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (athlete_id, routine_id)
);

CREATE INDEX IF NOT EXISTS workout_draft_athlete_idx
  ON public.workout_draft(athlete_id, updated_at DESC);

-- =============================================================================
-- PROGRAM_REVISION
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.program_revision (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   UUID        NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  phase_id     UUID        REFERENCES public.phase(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger      TEXT        NOT NULL DEFAULT 'editor'
                CHECK (trigger IN ('editor','phase_boundary','retest','deload')),
  effective_on DATE        NOT NULL,
  requests     JSONB       NOT NULL DEFAULT '[]',
  snapshot     JSONB       NOT NULL DEFAULT '[]',
  diff         JSONB       NOT NULL DEFAULT '{}',
  summary      TEXT
);

CREATE INDEX IF NOT EXISTS program_revision_program_id_idx
  ON public.program_revision(program_id, created_at DESC);

COMMENT ON TABLE public.program_revision IS
  'Append-only log of every reprogramming event: the week before it, what moved, '
  'what the athlete asked for, and when it took effect.';

-- =============================================================================
-- TRACK / GOALS / NOTES (tracks_v1, migration 20261103000001)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.track (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id        UUID NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  color             TEXT,
  icon              TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  purpose           TEXT,
  methodology_text  TEXT,
  sources           JSONB NOT NULL DEFAULT '[]'::jsonb,
  parent_track_id   UUID REFERENCES public.track(id) ON DELETE SET NULL,
  deload_policy     JSONB,
  retest_policy     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (program_id, name)
);
CREATE INDEX IF NOT EXISTS track_program_id_idx ON public.track(program_id);

CREATE TABLE IF NOT EXISTS public.progression_rule (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id     UUID NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  track_id       UUID NOT NULL REFERENCES public.track(id) ON DELETE CASCADE,
  exercise_name  TEXT,
  engine_type    TEXT NOT NULL CHECK (engine_type IN (
    'tm_wave', 'rpe_autoreg', 'double_progression', 'maintenance',
    'time_interval', 'contacts', 'measurement', 'manual'
  )),
  params         JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_from    DATE,
  active_to      DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS progression_rule_track_id_idx ON public.progression_rule(track_id);
CREATE INDEX IF NOT EXISTS progression_rule_program_id_idx ON public.progression_rule(program_id);

CREATE TABLE IF NOT EXISTS public.autoreg_rule (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('program', 'track', 'exercise')),
  scope_id       UUID,
  scope_name     TEXT,
  signal         TEXT NOT NULL,
  op             TEXT NOT NULL CHECK (op IN ('>', '>=', '<', '<=', '==', '!=')),
  value          NUMERIC,
  action         TEXT NOT NULL,
  action_params  JSONB NOT NULL DEFAULT '{}'::jsonb,
  message        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS autoreg_rule_athlete_idx ON public.autoreg_rule(athlete_id);

CREATE TABLE IF NOT EXISTS public.athlete_goal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  track_id        UUID REFERENCES public.track(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  metric          TEXT NOT NULL,
  unit            TEXT,
  side            TEXT CHECK (side IS NULL OR side IN ('L', 'R', 'both', 'none')),
  direction       TEXT NOT NULL CHECK (direction IN ('higher', 'lower', 'pass')),
  target          NUMERIC,
  target_range_hi NUMERIC,
  baseline        NUMERIC,
  current         NUMERIC,
  best            NUMERIC,
  due_date        DATE,
  test_protocol   TEXT,
  cadence         TEXT,
  status          TEXT NOT NULL DEFAULT 'on_track'
                   CHECK (status IN ('on_track', 'behind', 'hit')),
  source_metric   TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (athlete_id, name)
);
CREATE INDEX IF NOT EXISTS athlete_goal_athlete_idx ON public.athlete_goal(athlete_id);

CREATE TABLE IF NOT EXISTS public.goal_measurement (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  goal_id      UUID NOT NULL REFERENCES public.athlete_goal(id) ON DELETE CASCADE,
  measured_on  DATE NOT NULL,
  value        NUMERIC NOT NULL,
  side         TEXT,
  source       TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('workout_log', 'manual', 'agent')),
  workout_id   UUID REFERENCES public.workout(id) ON DELETE SET NULL,
  note         TEXT,
  client_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS goal_measurement_goal_idx ON public.goal_measurement(goal_id, measured_on);
CREATE UNIQUE INDEX IF NOT EXISTS goal_measurement_client_key_uidx
  ON public.goal_measurement (athlete_id, client_key)
  WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.workout_note (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  workout_id   UUID REFERENCES public.workout(id) ON DELETE CASCADE,
  session_id   UUID REFERENCES public.routine(id) ON DELETE SET NULL,
  author       TEXT NOT NULL DEFAULT 'coach',
  body         TEXT NOT NULL,
  client_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workout_note_has_target CHECK (workout_id IS NOT NULL OR session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS workout_note_athlete_idx ON public.workout_note(athlete_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workout_note_client_key_uidx
  ON public.workout_note (athlete_id, client_key)
  WHERE client_key IS NOT NULL;

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

-- =============================================================================
-- SESSION_OVERRIDE (G1, tracks_v1, migration 20261104000002)
-- Week-only per-date session changes. The template is never written.
-- =============================================================================
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

CREATE OR REPLACE FUNCTION public.tm_override_value(overrides jsonb, lift text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(overrides -> lift) = 'number' THEN (overrides ->> lift)::numeric
    WHEN jsonb_typeof(overrides -> lift) = 'object'
      AND (overrides -> lift ->> 'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (overrides -> lift ->> 'value')::numeric
    ELSE NULL
  END;
$$;

-- =============================================================================
-- CHANGE LOG (G2, tracks_v1, migration 20261104000003): append-only audit of
-- every coach and athlete write, and the previews those writes apply from.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.change_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  diff         JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale    TEXT,
  rule_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_ref TEXT,
  preview_id   TEXT,
  expires_on   DATE,
  reverted_by  UUID,
  revert_of    UUID,
  CONSTRAINT change_log_not_own_revert CHECK (revert_of IS DISTINCT FROM id AND reverted_by IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS change_log_athlete_idx
  ON public.change_log (athlete_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS change_log_revert_of_uidx
  ON public.change_log (revert_of) WHERE revert_of IS NOT NULL;

-- Append-only. UPDATE may only fill reverted_by on a row that has none, and
-- nothing else on the row may move. DELETE is refused unless the athlete row
-- itself is gone (ON DELETE CASCADE when an account is deleted).
CREATE OR REPLACE FUNCTION public.change_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'change_log is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.reverted_by IS NULL AND NEW.reverted_by IS NOT NULL
     AND (to_jsonb(NEW) - 'reverted_by') = (to_jsonb(OLD) - 'reverted_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change_log is append-only: only reverted_by may be set, once';
END
$fn$;

DROP TRIGGER IF EXISTS change_log_append_only ON public.change_log;
CREATE TRIGGER change_log_append_only
  BEFORE UPDATE OR DELETE ON public.change_log
  FOR EACH ROW EXECUTE FUNCTION public.change_log_append_only();

CREATE TABLE IF NOT EXISTS public.change_preview (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  preview_id  TEXT NOT NULL UNIQUE,
  tool        TEXT NOT NULL,
  target_id   TEXT,
  diff        JSONB NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id    TEXT NOT NULL,
  rationale   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at     TIMESTAMPTZ,
  voided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS change_preview_athlete_idx
  ON public.change_preview (athlete_id, created_at DESC);

-- =============================================================================
-- MCP_TOKEN
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.mcp_token (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  last_four    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_token_athlete_idx ON public.mcp_token (athlete_id);
CREATE INDEX IF NOT EXISTS mcp_token_hash_live_idx ON public.mcp_token (token_hash) WHERE revoked_at IS NULL;

-- =============================================================================
-- DEBUG RESET — same no-arg signature DebugReset.tsx calls.
-- Neon has no auth.uid() / get_current_athlete_id(). Resolve the athlete from
-- app.current_auth_user_id (set by a Worker caller). The Worker never sets
-- request.jwt.claim.sub (that is a Supabase PostgREST GUC), so there is no
-- JWT fallback. DebugReset.tsx still talks to Supabase PostgREST until that
-- client is retired; do not re-add request.jwt.claim.sub unless a Neon
-- PostgREST layer is introduced during cutover — and remove it when that
-- layer goes away.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reset_athlete_orientation()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  aid UUID;
  uid TEXT;
BEGIN
  uid := NULLIF(current_setting('app.current_auth_user_id', true), '');
  IF uid IS NOT NULL THEN
    SELECT id INTO aid FROM public.athlete WHERE auth_user_id::text = uid LIMIT 1;
  END IF;
  IF aid IS NULL THEN
    RAISE EXCEPTION 'No athlete for the current user';
  END IF;

  DELETE FROM public.session_observation so
   USING public.workout w, public.routine r, public.program p
   WHERE so.workout_id = w.id
     AND w.routine_id  = r.id
     AND r.program_id  = p.id
     AND p.athlete_id  = aid;

  DELETE FROM public.workout w
   USING public.routine r, public.program p
   WHERE w.routine_id = r.id
     AND r.program_id = p.id
     AND p.athlete_id = aid;

  DELETE FROM public.workout_note WHERE athlete_id = aid;
  DELETE FROM public.goal_measurement WHERE athlete_id = aid;
  DELETE FROM public.athlete_goal WHERE athlete_id = aid;
  DELETE FROM public.autoreg_rule WHERE athlete_id = aid;

  DELETE FROM public.program WHERE athlete_id = aid;
  DELETE FROM public.insight       WHERE athlete_id = aid;
  DELETE FROM public.insight_draft WHERE athlete_id = aid;
  DELETE FROM public.diagnostic      WHERE athlete_id = aid;
  DELETE FROM public.athlete_profile WHERE athlete_id = aid;

  UPDATE public.athlete
     SET onboarding_step = 'hook',
         obstacle        = NULL,
         arena_type      = NULL,
         arena_raw       = NULL,
         limiter_choice  = NULL
   WHERE id = aid;
END;
$$;

-- =============================================================================
-- APPROVAL (G10, tracks_v1) — mirrors supabase/migrations/20261104000004_approval.sql
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.approval (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id            UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  preview_id            TEXT NOT NULL,
  preview_kind          TEXT NOT NULL
                        CHECK (preview_kind IN ('program_edits', 'session_override', 'revert', 'proposal', 'change', 'app_editor')),
  diff_hash             TEXT NOT NULL,
  channel               TEXT NOT NULL CHECK (channel IN ('tap', 'chat')),
  message_id            UUID,
  requested_by_type     TEXT NOT NULL CHECK (requested_by_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  requested_by_id       TEXT NOT NULL,
  consumed_at           TIMESTAMPTZ,
  consumed_by_change_id UUID,
  voided_at             TIMESTAMPTZ,
  CONSTRAINT approval_chat_message CHECK ((channel = 'chat') = (message_id IS NOT NULL)),
  CONSTRAINT approval_consumed_pair CHECK ((consumed_at IS NULL) = (consumed_by_change_id IS NULL)),
  CONSTRAINT approval_one_end CHECK (consumed_at IS NULL OR voided_at IS NULL)
);
CREATE INDEX IF NOT EXISTS approval_athlete_idx
  ON public.approval (athlete_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_preview_idx
  ON public.approval (athlete_id, preview_id);
CREATE INDEX IF NOT EXISTS approval_requested_by_open_idx
  ON public.approval (athlete_id, requested_by_type, requested_by_id)
  WHERE consumed_at IS NULL AND voided_at IS NULL;

CREATE OR REPLACE FUNCTION public.approval_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'approval is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.consumed_at IS NULL AND OLD.voided_at IS NULL THEN
    IF NEW.consumed_at IS NOT NULL AND NEW.voided_at IS NULL
       AND (to_jsonb(NEW) - 'consumed_at' - 'consumed_by_change_id') = (to_jsonb(OLD) - 'consumed_at' - 'consumed_by_change_id') THEN
      RETURN NEW;
    END IF;
    IF NEW.voided_at IS NOT NULL AND NEW.consumed_at IS NULL
       AND (to_jsonb(NEW) - 'voided_at') = (to_jsonb(OLD) - 'voided_at') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'approval is append-only: it may be consumed or voided, once';
END
$fn$;

DROP TRIGGER IF EXISTS approval_append_only ON public.approval;
CREATE TRIGGER approval_append_only
  BEFORE UPDATE OR DELETE ON public.approval
  FOR EACH ROW EXECUTE FUNCTION public.approval_append_only();

-- Which approval row a change_log row's approval_ref resolves to.
ALTER TABLE public.change_log ADD COLUMN IF NOT EXISTS approval_id UUID;

-- =============================================================================
-- METHODOLOGY (G3, tracks_v1) — mirrors supabase/migrations/20261104000005_methodology.sql
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.methodology_override (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  -- NULL: the whole athlete. Set: that track only (paths with scope 'any').
  track_id            UUID REFERENCES public.track(id) ON DELETE CASCADE,
  -- The global version it was set against, e.g. 'v1'.
  methodology_version TEXT NOT NULL,
  path                TEXT NOT NULL,
  value               JSONB NOT NULL,
  rationale           TEXT,
  rule_refs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('athlete', 'mcp', 'app_coach', 'system')),
  actor_id            TEXT NOT NULL,
  approval_ref        TEXT NOT NULL,
  approval_id         UUID,
  preview_id          TEXT NOT NULL,
  change_id           UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at       TIMESTAMPTZ,
  superseded_by       UUID,
  CONSTRAINT methodology_override_path CHECK (path ~ '^(U([1-9]|1[0-5])|minors)(\.[a-z0-9_]+)+$')
);
CREATE INDEX IF NOT EXISTS methodology_override_athlete_idx
  ON public.methodology_override (athlete_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS methodology_override_active_uidx
  ON public.methodology_override (athlete_id, COALESCE(track_id::text, ''), path)
  WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION public.methodology_override_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'methodology_override is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_at' - 'superseded_by') = (to_jsonb(OLD) - 'superseded_at' - 'superseded_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'methodology_override is append-only: it may be superseded, once';
END
$fn$;

DROP TRIGGER IF EXISTS methodology_override_append_only ON public.methodology_override;
CREATE TRIGGER methodology_override_append_only
  BEFORE UPDATE OR DELETE ON public.methodology_override
  FOR EACH ROW EXECUTE FUNCTION public.methodology_override_append_only();

-- The methodology version every change_log row ran on ('v1', or 'v1+<hash>'
-- with the athlete's overrides in force). NULL on rows written before G3.
ALTER TABLE public.change_log ADD COLUMN IF NOT EXISTS methodology_version TEXT;

-- Who parked a proposal: mcp:<token id>, app_coach, or athlete:<id>. NULL on
-- rows parked before G3 (left alone by revocation). voided_at: its coach was
-- revoked while it was pending (status goes 'stale' at the same time).
ALTER TABLE public.coach_proposal ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.coach_proposal ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- Under-18 rules (D6) apply when this says the athlete is under 18. NULL:
-- age unknown — adult rules, and no raised pain cap (D2) until it is known.
-- Not writable through /api/data.
ALTER TABLE public.athlete ADD COLUMN IF NOT EXISTS birth_date DATE;

-- =============================================================================
-- READINESS (G4 + G8, tracks_v1) — mirrors supabase/migrations/20261104000006_readiness.sql
-- =============================================================================
-- One row per check-in submission. The latest row for a date is that day's
-- check-in. Every field is optional; a submission names at least one.
CREATE TABLE IF NOT EXISTS public.checkin (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  sleep_hours  NUMERIC(4,2) CHECK (sleep_hours IS NULL OR (sleep_hours >= 0 AND sleep_hours <= 24)),
  stress       SMALLINT CHECK (stress IS NULL OR stress BETWEEN 1 AND 5),
  soreness     SMALLINT CHECK (soreness IS NULL OR soreness BETWEEN 1 AND 5),
  -- The change_log row (standing:logging) this submission wrote.
  change_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checkin_athlete_date_idx ON public.checkin (athlete_id, date, created_at);

-- Pain by region, 0–10, with any section 8 red flags. The latest row for a
-- (date, region) is that day's score.
CREATE TABLE IF NOT EXISTS public.pain_report (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  region       TEXT NOT NULL CHECK (region ~ '^[a-z_]+$'),
  score        SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
  red_flags    TEXT[] NOT NULL DEFAULT '{}'::text[]
               CHECK (red_flags <@ ARRAY['swelling', 'locking', 'giving_way', 'numbness_tingling', 'radiating',
                                         'chest_pain', 'fainting', 'breathlessness', 'acute_injury', 'worsening']::text[]),
  checkin_id   UUID,
  change_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pain_report_athlete_date_idx ON public.pain_report (athlete_id, date, region, created_at);

-- A region's U7 status, one row each time it changes. The latest row is the
-- current status. A 'blocked' row stays in force until the athlete marks it
-- cleared by a clinician (cleared_at + cleared_by, set once, athlete only).
CREATE TABLE IF NOT EXISTS public.region_status (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  region           TEXT NOT NULL CHECK (region ~ '^[a-z_]+$'),
  status           TEXT NOT NULL CHECK (status IN ('ok', 'capped', 'blocked')),
  reason           TEXT,
  rule_refs        JSONB NOT NULL DEFAULT '["U7"]'::jsonb,
  pain_report_id   UUID,
  change_id        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at       TIMESTAMPTZ,
  -- athlete:<id>. Never a coach.
  cleared_by       TEXT,
  clear_change_id  UUID,
  CONSTRAINT region_status_cleared_pair CHECK ((cleared_at IS NULL) = (cleared_by IS NULL)),
  CONSTRAINT region_status_cleared_blocked CHECK (cleared_at IS NULL OR status = 'blocked'),
  CONSTRAINT region_status_cleared_by_athlete CHECK (cleared_by IS NULL OR cleared_by LIKE 'athlete:%')
);
CREATE INDEX IF NOT EXISTS region_status_athlete_idx ON public.region_status (athlete_id, region, created_at);

-- Every coach read of this athlete's data: an MCP read tool call or an
-- app_coach read. The athlete's own reads are not logged.
CREATE TABLE IF NOT EXISTS public.coach_read_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('mcp', 'app_coach')),
  actor_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  scope        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coach_read_log_athlete_idx ON public.coach_read_log (athlete_id, created_at);

-- Append-only: rows go only with their athlete (ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION public.readiness_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'region_status' AND OLD.status = 'blocked' AND OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL
     AND (to_jsonb(NEW) - 'cleared_at' - 'cleared_by' - 'clear_change_id') = (to_jsonb(OLD) - 'cleared_at' - 'cleared_by' - 'clear_change_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS checkin_append_only ON public.checkin;
CREATE TRIGGER checkin_append_only
  BEFORE UPDATE OR DELETE ON public.checkin
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();
DROP TRIGGER IF EXISTS pain_report_append_only ON public.pain_report;
CREATE TRIGGER pain_report_append_only
  BEFORE UPDATE OR DELETE ON public.pain_report
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();
DROP TRIGGER IF EXISTS region_status_append_only ON public.region_status;
CREATE TRIGGER region_status_append_only
  BEFORE UPDATE OR DELETE ON public.region_status
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();
DROP TRIGGER IF EXISTS coach_read_log_append_only ON public.coach_read_log;
CREATE TRIGGER coach_read_log_append_only
  BEFORE UPDATE OR DELETE ON public.coach_read_log
  FOR EACH ROW EXECUTE FUNCTION public.readiness_append_only();

-- D3: does this coach see pain and check-in data. On by default for every
-- coach the athlete invites; only the athlete turns it off (logged). Not
-- writable through /api/data.
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS share_health BOOLEAN NOT NULL DEFAULT true;

-- =============================================================================
-- SESSION RPE (G9, tracks_v1) — mirrors supabase/migrations/20261104000007_session_rpe.sql
-- =============================================================================
-- One row per (athlete, date, session): Foster's session RPE, one CR-10 rating
-- (0–10) of the whole session. NOT workout.rpe (the mean of the set RPEs) and
-- never merged into it. A second tap the same day updates the row; each tap
-- also writes one change_log row (standing:logging) with the before → after.
-- Session load (AU) = rating × duration_min, when the duration is known.
CREATE TABLE IF NOT EXISTS public.session_rpe (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  -- The athlete's calendar day the session was trained on.
  date          DATE NOT NULL,
  -- The session (routine) rated. The logged workout, when known.
  session_id    UUID NOT NULL REFERENCES public.routine(id) ON DELETE CASCADE,
  workout_id    UUID REFERENCES public.workout(id) ON DELETE SET NULL,
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 0 AND 10),
  duration_min  SMALLINT CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 600),
  -- The change_log row of the latest tap.
  change_id     UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT session_rpe_one_per_day UNIQUE (athlete_id, date, session_id)
);
CREATE INDEX IF NOT EXISTS session_rpe_athlete_date_idx ON public.session_rpe (athlete_id, date);
-- Offline queue (migration 20261104000011_session_rpe_queue.sql): the app's id
-- for the tap the row holds (a retry with it is "already logged") and when that
-- tap happened (a queued tap older than the row's is acknowledged, not applied).
ALTER TABLE public.session_rpe ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE public.session_rpe ADD COLUMN IF NOT EXISTS tapped_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS session_rpe_athlete_client_uidx
  ON public.session_rpe (athlete_id, client_id) WHERE client_id IS NOT NULL;

-- =============================================================================
-- COACH V1 (G6 + G7, coach_v1) — mirrors supabase/migrations/20261104000008_coach_v1.sql
-- =============================================================================
-- One row per sport or activity the athlete does (spec section 4). module_key
-- names its code-owned module (worker/src/coach/modules.ts, versioned like the
-- methodology). Written only through preview_activity_change →
-- apply_activity_change (approval required) or an approved composed block
-- from intake; never deleted: removing one sets active = false. change_id is
-- the change_log row of the last write.
CREATE TABLE IF NOT EXISTS public.activity (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id         UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  module_key         TEXT NOT NULL CHECK (module_key IN ('court', 'endurance', 'field', 'strength', 'general')),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  sessions_per_week  SMALLINT NOT NULL CHECK (sessions_per_week BETWEEN 0 AND 14),
  season             TEXT NOT NULL DEFAULT 'in' CHECK (season IN ('in', 'off')),
  -- Days it is on, 0 = Mon … 6 = Sun.
  days               SMALLINT[] NOT NULL DEFAULT '{}' CHECK (days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  active             BOOLEAN NOT NULL DEFAULT true,
  change_id          UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_athlete_idx ON public.activity (athlete_id, active);

-- The intake answers as submitted (section 5), one row per submission,
-- append-only. outcome 'stopped': a red flag (or pain above the U7 stop line)
-- stopped it and nothing was composed; 'previewed': it produced the composed
-- block preview preview_id. minor + parental_consent record the under-18
-- consent step. change_id: the check-in (pain, recovery baseline) it logged.
CREATE TABLE IF NOT EXISTS public.coach_intake (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  answers           JSONB NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('stopped', 'previewed')),
  minor             BOOLEAN NOT NULL DEFAULT false,
  parental_consent  JSONB,
  preview_id        TEXT,
  change_id         UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coach_intake_athlete_idx ON public.coach_intake (athlete_id, created_at DESC);

-- The block of record (section 4 output): what the composer produced and the
-- athlete approved, with the methodology and module versions it ran on and
-- the key of the activities + goals it was composed from (re-compose when
-- that moves or the block ends). Written only by apply_composed_block, in the
-- same transaction as its change_log row. A newer block supersedes the old
-- one; nothing else about a row ever changes.
CREATE TABLE IF NOT EXISTS public.composed_block (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id           UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  program_id           UUID REFERENCES public.program(id) ON DELETE SET NULL,
  start_date           DATE NOT NULL,
  end_date             DATE NOT NULL,
  methodology_version  TEXT NOT NULL,
  modules_version      TEXT NOT NULL,
  compose_key          TEXT NOT NULL,
  block                JSONB NOT NULL,
  request              JSONB NOT NULL DEFAULT '{}'::jsonb,
  intake_id            UUID,
  preview_id           TEXT NOT NULL,
  approval_ref         TEXT NOT NULL,
  change_id            UUID NOT NULL,
  actor_type           TEXT NOT NULL,
  actor_id             TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at        TIMESTAMPTZ,
  superseded_by        UUID
);
CREATE INDEX IF NOT EXISTS composed_block_athlete_idx ON public.composed_block (athlete_id, created_at DESC);
-- The pending phase the block queued (its week's sessions, from its start).
-- Mirrors supabase/migrations/20261104000012_composed_block_program.sql. No
-- foreign key: composed_block is append-only, so it never gains an ON DELETE
-- action.
ALTER TABLE public.composed_block ADD COLUMN IF NOT EXISTS phase_id UUID;

-- Append-only, like readiness_append_only: coach_intake never changes;
-- composed_block only gains superseded_at / superseded_by, once. Deletes go
-- through only when the athlete row itself is being deleted (cascade).
CREATE OR REPLACE FUNCTION public.coach_v1_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'composed_block' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_at' - 'superseded_by') = (to_jsonb(OLD) - 'superseded_at' - 'superseded_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS coach_intake_append_only ON public.coach_intake;
CREATE TRIGGER coach_intake_append_only
  BEFORE UPDATE OR DELETE ON public.coach_intake
  FOR EACH ROW EXECUTE FUNCTION public.coach_v1_append_only();
DROP TRIGGER IF EXISTS composed_block_append_only ON public.composed_block;
CREATE TRIGGER composed_block_append_only
  BEFORE UPDATE OR DELETE ON public.composed_block
  FOR EACH ROW EXECUTE FUNCTION public.coach_v1_append_only();

-- A goal's weight for composing (section 4: priority | maintenance) and the
-- quality it trains. Nullable: null reads as maintenance, quality inferred.
-- Written only by apply_composed_block. Existing goal rows are not touched.
ALTER TABLE public.athlete_goal ADD COLUMN IF NOT EXISTS weight TEXT
  CHECK (weight IS NULL OR weight IN ('priority', 'maintenance'));
ALTER TABLE public.athlete_goal ADD COLUMN IF NOT EXISTS quality TEXT
  CHECK (quality IS NULL OR quality IN ('max_strength', 'power', 'aerobic', 'alactic', 'change_of_direction', 'tissue_capacity', 'mobility'));

-- =============================================================================
-- COACH ROLES (D3, tracks_v1) — mirrors supabase/migrations/20261104000009_coach_roles.sql
-- =============================================================================
-- Each coach token is 'read' (read tools only; every preview / apply / write
-- hidden and refused, refusals logged) or 'propose' (as before). Default
-- 'propose', so existing tokens keep today's powers. Only the athlete changes
-- it (logged). Not writable through /api/data.
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'propose';
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_token_role_check') THEN
    ALTER TABLE public.mcp_token ADD CONSTRAINT mcp_token_role_check CHECK (role IN ('read', 'propose'));
  END IF;
END
$c$;

-- =============================================================================
-- CHANGE TOMBSTONE (Round 2 item 3, tracks_v1) — mirrors supabase/migrations/20261104000010_change_tombstone.sql
-- =============================================================================
-- One row per row a revert hid instead of deleting it: 'void' for a logging
-- write undone (check-in, pain report, session RPE tap, goal measurement,
-- workout note), 'retire' for a row a change created (track, goal, autoreg
-- rule). Readers skip a live tombstone only with tracks_v1 on. Redoing the
-- revert lifts it, once. Region blocks are never voided. Not in /api/data.
CREATE TABLE IF NOT EXISTS public.change_tombstone (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  row_table      TEXT NOT NULL CHECK (row_table IN (
                   'checkin', 'pain_report', 'session_rpe', 'goal_measurement', 'workout_note',
                   'track', 'athlete_goal', 'autoreg_rule')),
  row_id         UUID NOT NULL,
  row_change_id  UUID,
  kind           TEXT NOT NULL CHECK (kind IN ('void', 'retire')),
  change_id      UUID NOT NULL,
  voids_change_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_at      TIMESTAMPTZ,
  lifted_by      UUID,
  CONSTRAINT change_tombstone_lifted_pair CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);
CREATE INDEX IF NOT EXISTS change_tombstone_athlete_idx
  ON public.change_tombstone (athlete_id, row_table)
  WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS change_tombstone_change_idx
  ON public.change_tombstone (athlete_id, change_id);
CREATE UNIQUE INDEX IF NOT EXISTS change_tombstone_live_uidx
  ON public.change_tombstone (athlete_id, row_table, row_id)
  WHERE lifted_at IS NULL;
CREATE OR REPLACE FUNCTION public.change_tombstone_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.athlete WHERE id = OLD.athlete_id) THEN
      RAISE EXCEPTION 'change_tombstone is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL
     AND (to_jsonb(NEW) - 'lifted_at' - 'lifted_by') = (to_jsonb(OLD) - 'lifted_at' - 'lifted_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change_tombstone is append-only: it may be lifted, once';
END
$fn$;
DROP TRIGGER IF EXISTS change_tombstone_append_only ON public.change_tombstone;
CREATE TRIGGER change_tombstone_append_only
  BEFORE UPDATE OR DELETE ON public.change_tombstone
  FOR EACH ROW EXECUTE FUNCTION public.change_tombstone_append_only();

-- =============================================================================
-- AGE STATUS (section 11b, tracks_v1) — mirrors supabase/migrations/20261104000013_age_status.sql
-- =============================================================================
-- The athlete's own "I'm 18 or older" (Intake or Profile), for an athlete
-- with no birth date. Without a birth date or this, the age is unknown and
-- the under-18 rules apply. A birth date always wins. Not in /api/data.
ALTER TABLE public.athlete ADD COLUMN IF NOT EXISTS adult_confirmed_at TIMESTAMPTZ;
