-- Brings an existing Neon database up to tracks_v1. Idempotent hand-apply
-- for a live database that has not been rebuilt. Table definitions match
-- supabase/migrations/20261103000001_tracks_v1.sql and worker/schema/app.sql.
--
-- Neon has no get_current_athlete_id(), no `authenticated` role, and RLS
-- off on every table — same as worker/schema/app.sql. Do not add ENABLE
-- ROW LEVEL SECURITY, CREATE POLICY, or GRANT here. Access is enforced
-- in the Worker.
--
-- Additive and idempotent. Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';
--   -- then drop the new tables / columns; ignore the new exercise JSON keys.
-- Does NOT write athlete.training_max_overrides. Deadlift TM stays as stored.
-- Does NOT delete or reseed existing track / goal / rule rows.
--
-- Runtime flag: athlete.flags.tracks_v1 = true (Phil only, below).
-- Phil's named tracks / goals / rules live in scripts/seed-phil-tracks.sql
-- (already applied on prod). Isolation seed is a@ / b@ and must not pick
-- up personal rows.

-- =============================================================================
-- PROGRAM block metadata
-- =============================================================================
ALTER TABLE public.program
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS block_phase TEXT,
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS deload_week_start DATE,
  ADD COLUMN IF NOT EXISTS retest_start DATE,
  ADD COLUMN IF NOT EXISTS retest_end DATE;

COMMENT ON COLUMN public.program.name IS
  'Block title, e.g. "Nov–Dec 2026". Distinct from phase.name (Stability/Strength/Power/Sport).';
COMMENT ON COLUMN public.program.block_phase IS
  'Free-text phase label the coach sets. Does not change phase.name.';
COMMENT ON COLUMN public.program.deload_week_start IS
  'Monday of the deload week. Null = inherit nothing; coach sets it.';
COMMENT ON COLUMN public.program.retest_start IS
  'Retest window start. program.retest_date remains the legacy single date.';

-- =============================================================================
-- TRACK
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

-- =============================================================================
-- PROGRESSION_RULE
-- =============================================================================
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

-- =============================================================================
-- AUTOREG_RULE
-- =============================================================================
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

-- =============================================================================
-- ATHLETE_GOAL
-- =============================================================================
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

-- =============================================================================
-- GOAL_MEASUREMENT
-- =============================================================================
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

-- =============================================================================
-- WORKOUT_NOTE
-- =============================================================================
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

-- =============================================================================
-- General track backfill. No INSERT trigger — data-only restore cannot
-- disable triggers on Neon, and a trigger-created General collides with
-- the dumped row (23505 on track(program_id, name)).
-- =============================================================================
INSERT INTO public.track (program_id, name, color, icon, sort_order, purpose)
SELECT p.id, 'General', '#9A9A9A', 'circle', 0, 'Default track for unassigned work'
FROM public.program p
WHERE p.status IS DISTINCT FROM 'external'
  AND NOT EXISTS (
    SELECT 1 FROM public.track t WHERE t.program_id = p.id AND t.name = 'General'
  );

-- Stamp missing track_id onto existing exercises (General). Does not change
-- sets / reps / load. Idempotent: leaves an existing track_id alone.
UPDATE public.routine r
SET exercises = sub.next
FROM (
  SELECT r2.id,
    (
      SELECT COALESCE(jsonb_agg(
        CASE
          WHEN COALESCE(elem->>'track_id', '') <> '' THEN elem
          ELSE elem || jsonb_build_object('track_id', t.id::text)
        END
        ORDER BY ord
      ), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(r2.exercises, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
    ) AS next
  FROM public.routine r2
  JOIN public.track t ON t.program_id = r2.program_id AND t.name = 'General'
) sub
WHERE r.id = sub.id
  AND r.exercises IS DISTINCT FROM sub.next;

-- Read a TM override without writing it. Object form or bare number.
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
-- Flag only. Phil's named tracks / goals / rules live in
-- scripts/seed-phil-tracks.sql (already applied on prod). Isolation seed
-- is a@ / b@ and must not pick up personal rows.
-- =============================================================================
UPDATE public.athlete a
SET flags = COALESCE(a.flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb
FROM auth.users u
WHERE a.auth_user_id = u.id
  AND lower(u.email) = 'phillipchan1@gmail.com';
