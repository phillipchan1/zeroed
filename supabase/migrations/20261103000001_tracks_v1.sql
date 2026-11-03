-- tracks_v1: named tracks inside one program, structured goals, workout notes,
-- progression / autoreg rules, and block metadata.
--
-- Additive and idempotent. Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';
--   -- then drop the new tables / columns; ignore the new exercise JSON keys.
-- Does NOT write athlete.training_max_overrides. Deadlift TM stays as stored.
--
-- Runtime flag: athlete.flags.tracks_v1 = true. Enable per athlete with
-- scripts/enable-tracks-flag.mjs (email from ZEROED_TRACKS_FLAG_EMAIL).
-- Nothing in the unflagged UI reads these tables.

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

ALTER TABLE public.track ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS track_select ON public.track;
CREATE POLICY track_select ON public.track
  FOR SELECT USING (
    program_id IN (SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id())
  );
DROP POLICY IF EXISTS track_insert ON public.track;
CREATE POLICY track_insert ON public.track
  FOR INSERT WITH CHECK (
    program_id IN (SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id())
  );
DROP POLICY IF EXISTS track_update ON public.track;
CREATE POLICY track_update ON public.track
  FOR UPDATE USING (
    program_id IN (SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id())
  );

GRANT SELECT, INSERT, UPDATE ON public.track TO authenticated;

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

ALTER TABLE public.progression_rule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS progression_rule_select ON public.progression_rule;
CREATE POLICY progression_rule_select ON public.progression_rule
  FOR SELECT USING (
    program_id IN (SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id())
  );
DROP POLICY IF EXISTS progression_rule_insert ON public.progression_rule;
CREATE POLICY progression_rule_insert ON public.progression_rule
  FOR INSERT WITH CHECK (
    program_id IN (SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id())
  );
DROP POLICY IF EXISTS progression_rule_update ON public.progression_rule;
CREATE POLICY progression_rule_update ON public.progression_rule
  FOR UPDATE USING (
    program_id IN (SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id())
  );

GRANT SELECT, INSERT, UPDATE ON public.progression_rule TO authenticated;

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

ALTER TABLE public.autoreg_rule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autoreg_rule_select ON public.autoreg_rule;
CREATE POLICY autoreg_rule_select ON public.autoreg_rule
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS autoreg_rule_insert ON public.autoreg_rule;
CREATE POLICY autoreg_rule_insert ON public.autoreg_rule
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS autoreg_rule_update ON public.autoreg_rule;
CREATE POLICY autoreg_rule_update ON public.autoreg_rule
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE ON public.autoreg_rule TO authenticated;

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

ALTER TABLE public.athlete_goal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS athlete_goal_select ON public.athlete_goal;
CREATE POLICY athlete_goal_select ON public.athlete_goal
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS athlete_goal_insert ON public.athlete_goal;
CREATE POLICY athlete_goal_insert ON public.athlete_goal
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS athlete_goal_update ON public.athlete_goal;
CREATE POLICY athlete_goal_update ON public.athlete_goal
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE ON public.athlete_goal TO authenticated;

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

ALTER TABLE public.goal_measurement ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goal_measurement_select ON public.goal_measurement;
CREATE POLICY goal_measurement_select ON public.goal_measurement
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS goal_measurement_insert ON public.goal_measurement;
CREATE POLICY goal_measurement_insert ON public.goal_measurement
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS goal_measurement_update ON public.goal_measurement;
CREATE POLICY goal_measurement_update ON public.goal_measurement
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE ON public.goal_measurement TO authenticated;

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

ALTER TABLE public.workout_note ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workout_note_select ON public.workout_note;
CREATE POLICY workout_note_select ON public.workout_note
  FOR SELECT USING (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS workout_note_insert ON public.workout_note;
CREATE POLICY workout_note_insert ON public.workout_note
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());
DROP POLICY IF EXISTS workout_note_update ON public.workout_note;
CREATE POLICY workout_note_update ON public.workout_note
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

GRANT SELECT, INSERT, UPDATE ON public.workout_note TO authenticated;

-- =============================================================================
-- General track backfill. No INSERT trigger: data-only restore cannot
-- disable triggers on Neon, and a trigger-created General collides with
-- the dumped row (23505 on track(program_id, name)). New programs get
-- General from app/seed inserts; missing track_id still resolves at read.
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

-- Flag is not hardcoded here. Enable per athlete with:
--   ZEROED_TRACKS_FLAG_EMAIL=you@example.com node scripts/enable-tracks-flag.mjs --confirm
-- Isolation seed is a@ / b@ and must not pick up personal rows.
