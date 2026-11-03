-- tracks_v1: named tracks inside one program, structured goals, workout notes,
-- progression / autoreg rules, and block metadata.
--
-- Additive and idempotent. Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';
--   -- then drop the new tables / columns; ignore the new exercise JSON keys.
-- Does NOT write athlete.training_max_overrides. Deadlift TM stays as stored.
--
-- Runtime flag: athlete.flags.tracks_v1 = true (Phil only, below).
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
-- General track on every non-external program (insert + backfill)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ensure_general_track()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'external' THEN
    INSERT INTO public.track (program_id, name, color, icon, sort_order, purpose)
    SELECT NEW.id, 'General', '#9A9A9A', 'circle', 0, 'Default track for unassigned work'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.track t WHERE t.program_id = NEW.id AND t.name = 'General'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS program_ensure_general_track ON public.program;
CREATE TRIGGER program_ensure_general_track
  AFTER INSERT ON public.program
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_general_track();

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
      AND (overrides -> lift ->> 'value') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (overrides -> lift ->> 'value')::numeric
    ELSE NULL
  END;
$$;

-- =============================================================================
-- Phil: flag on, five tracks, goals, rules, block dates.
-- Only matches auth email phillipchan1@gmail.com. Isolation seed is a@ / b@.
-- =============================================================================
UPDATE public.athlete a
SET flags = COALESCE(a.flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb
FROM auth.users u
WHERE a.auth_user_id = u.id
  AND lower(u.email) = 'phillipchan1@gmail.com';

INSERT INTO public.track (program_id, name, color, icon, sort_order, purpose, methodology_text, deload_policy, retest_policy)
SELECT p.id, v.name, v.color, v.icon, v.sort_order, v.purpose, v.methodology_text,
       v.deload_policy::jsonb, v.retest_policy::jsonb
FROM public.program p
JOIN public.athlete a ON a.id = p.athlete_id
JOIN auth.users u ON u.id = a.auth_user_id
CROSS JOIN (VALUES
  ('Lifting',      '#5A8FB8', 'dumbbell', 1, 'Main lifts — Wendler TM, RTS, Westside speed, minimum dose',
    'Wendler 5/3/1 TM, RTS autoregulation, Westside dynamic effort, Bickel 2011 minimum dose',
    '{"volume_cut_pct": 45}', '{"window": "2026-12-07/2026-12-11"}'),
  ('Conditioning', '#D4A848', 'zap',      2, 'Engine, sprints, plyos',
    'Jamieson (8 Weeks Out), ALTIS acceleration, HWPO/Mayhem finishers, NSCA plyo contacts',
    '{"easy_sessions": 1}', '{"window": "2026-12-07/2026-12-11"}'),
  ('Basketball',   '#5FB87A', 'circle',   3, 'Sport as conditioning; post-game ratings',
    'Vermeil hierarchy; game as conditioning',
    '{"inherit": true}', '{"window": "2026-12-07/2026-12-11"}'),
  ('Hypertrophy',  '#C4A882', 'layers',   4, 'Accessories — double progression, shoulder work',
    'Double progression; Cressey shoulder work',
    '{"inherit": true}', '{"window": "2026-12-07/2026-12-11"}'),
  ('Mobility',     '#8A9AA8', 'move',     5, 'Knees, screens, prehab',
    'Knees Over Toes; Cressey screens; measurement-based',
    '{"inherit": true}', '{"window": "2026-12-07/2026-12-11"}')
) AS v(name, color, icon, sort_order, purpose, methodology_text, deload_policy, retest_policy)
WHERE lower(u.email) = 'phillipchan1@gmail.com'
  AND p.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM public.track t WHERE t.program_id = p.id AND t.name = v.name
  );

-- Reassign Phil's exercises by name. Only writes track_id.
UPDATE public.routine r
SET exercises = (
  SELECT COALESCE(jsonb_agg(
    elem || jsonb_build_object('track_id', COALESCE(picked.id, general.id)::text)
    ORDER BY ord
  ), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(r.exercises, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
  JOIN public.track general ON general.program_id = r.program_id AND general.name = 'General'
  LEFT JOIN public.track picked ON picked.program_id = r.program_id AND picked.name = CASE
    WHEN r.name ~* 'basketball' THEN 'Basketball'
    WHEN elem->>'name' ~* 'bench press|speed bench|paused bench|strict ohp|overhead press|\\bohp\\b|back squat|front squat|deadlift'
      AND elem->>'name' !~* 'split squat|db bench|dumbbell bench|goblet'
      THEN 'Lifting'
    WHEN elem->>'name' ~* 'assault bike|echo bike|bike|sprint|broad jump|vertical jump|box jump|depth jump|pogo|lateral bound|bound|tabata'
      THEN 'Conditioning'
    WHEN elem->>'name' ~* 'db bench|dumbbell|landmine|face pull|serratus|scap|row'
      THEN 'Hypertrophy'
    WHEN elem->>'name' ~* '90/90|hip ir|knee.to.wall|knee to wall|wall test|tib|nordic|split squat|cossack|patrick|band walk|prehab|atg'
      THEN 'Mobility'
    ELSE 'General'
  END
)
WHERE r.program_id IN (
  SELECT p.id FROM public.program p
  JOIN public.athlete a ON a.id = p.athlete_id
  JOIN auth.users u ON u.id = a.auth_user_id
  WHERE lower(u.email) = 'phillipchan1@gmail.com' AND p.status = 'active'
);

-- Block dates: only fill nulls. start_date is already NOT NULL — leave it.
UPDATE public.program p
SET
  name = COALESCE(p.name, 'Nov–Dec 2026'),
  block_phase = COALESCE(p.block_phase, 'Accumulation'),
  end_date = COALESCE(p.end_date, DATE '2026-12-11'),
  deload_week_start = COALESCE(p.deload_week_start, DATE '2026-11-30'),
  retest_start = COALESCE(p.retest_start, DATE '2026-12-07'),
  retest_end = COALESCE(p.retest_end, DATE '2026-12-11')
FROM public.athlete a
JOIN auth.users u ON u.id = a.auth_user_id
WHERE p.athlete_id = a.id
  AND p.status = 'active'
  AND lower(u.email) = 'phillipchan1@gmail.com';

-- Goals. Copy free-text athlete.goals onto Bench 1RM.note when empty.
INSERT INTO public.athlete_goal (
  athlete_id, track_id, name, metric, unit, side, direction,
  target, target_range_hi, baseline, current, best, due_date,
  test_protocol, cadence, status, note
)
SELECT a.id, t.id, g.name, g.metric, g.unit, g.side, g.direction,
       g.target, g.target_range_hi, g.baseline, g.current, g.best, g.due_date,
       g.test_protocol, g.cadence, 'on_track',
       CASE WHEN g.name = 'Bench 1RM' THEN a.goals ELSE g.note END
FROM public.athlete a
JOIN auth.users u ON u.id = a.auth_user_id
JOIN public.program p ON p.athlete_id = a.id AND p.status = 'active'
CROSS JOIN (VALUES
  ('Lifting',      'Bench 1RM', 'e1rm', 'lb', 'none', 'higher', 295, 300, 285, 285, 285, DATE '2026-12-11',
    'Paused or competition bench, Dec 7–11. Long-term 315.', 'block', NULL),
  ('Lifting',      'Strict OHP', 'load_x_reps', 'lb', 'none', 'higher', 155, NULL, 125, 125, 125, NULL,
    'Strict press. Last best 125×5 (Aug 26).', 'open', NULL),
  ('Lifting',      'Squat held', 'held_load', 'lb', 'none', 'higher', 375, NULL, NULL, NULL, NULL, DATE '2026-12-11',
    'Maintenance. A rep PR at RPE 8 counts as held. No maxing.', 'block', NULL),
  ('Lifting',      'Deadlift held', 'held_load', 'lb', 'none', 'higher', 410, NULL, 350, 350, 445, DATE '2026-12-11',
    'TM 410 (hand-set) / best 445. 3×3 @350. No maxing.', 'block', 'Deadlift TM is 410 and must stay 410.'),
  ('Mobility',     'Hip IR L', 'hip_ir', 'deg', 'L', 'higher', 35, NULL, NULL, NULL, NULL, NULL,
    'Seated or supine IR, each side.', 'monthly', NULL),
  ('Mobility',     'Hip IR R', 'hip_ir', 'deg', 'R', 'higher', 35, NULL, NULL, NULL, NULL, NULL,
    'Seated or supine IR, each side.', 'monthly', NULL),
  ('Mobility',     'Knee-to-wall L', 'knee_to_wall', 'in', 'L', 'higher', 4, NULL, NULL, NULL, NULL, NULL,
    NULL, 'monthly', NULL),
  ('Mobility',     'Knee-to-wall R', 'knee_to_wall', 'in', 'R', 'higher', 4, NULL, NULL, NULL, NULL, NULL,
    NULL, 'monthly', NULL),
  ('Mobility',     'Wall test', 'wall_test', 'pass', 'none', 'pass', NULL, NULL, NULL, NULL, NULL, NULL,
    'Pass / fail screen.', 'monthly', NULL),
  ('Conditioning', 'Broad jump', 'distance', 'in', 'none', 'higher', 100, NULL, 95, 95, 95, DATE '2026-12-11',
    NULL, 'block', NULL),
  ('Conditioning', 'Assault Bike 10-min calories', 'calories', 'cal', 'none', 'higher', NULL, NULL, NULL, NULL, NULL, DATE '2026-12-11',
    'Set at first test.', 'block', NULL),
  ('Conditioning', 'Repeat sprint drop-off', 'dropoff_pct', '%', 'none', 'lower', 5, NULL, NULL, NULL, NULL, DATE '2026-12-11',
    '6 × 20 m, drop-off %.', 'block', NULL),
  ('Basketball',   'Basketball gas tank', 'rating', '/10', 'none', 'higher', 8, NULL, NULL, NULL, NULL, NULL,
    'Post-game 1–10.', 'weekly', NULL)
) AS g(track, name, metric, unit, side, direction, target, target_range_hi, baseline, current, best, due_date, test_protocol, cadence, note)
LEFT JOIN public.track t ON t.program_id = p.id AND t.name = g.track
WHERE lower(u.email) = 'phillipchan1@gmail.com'
ON CONFLICT (athlete_id, name) DO NOTHING;

-- Progression rules. TM values are READ from overrides. Deadlift defaults to
-- 410 in the rule params only — the athlete row is not updated.
INSERT INTO public.progression_rule (program_id, track_id, exercise_name, engine_type, params)
SELECT p.id, t.id, v.exercise_name, v.engine_type,
  CASE v.engine_type
    WHEN 'tm_wave' THEN jsonb_build_object(
      'tm', COALESCE(public.tm_override_value(a.training_max_overrides, v.lift_id), v.default_tm),
      'increment', 5, 'target_rpe', 8
    )
    WHEN 'maintenance' THEN jsonb_build_object(
      'tm', COALESCE(public.tm_override_value(a.training_max_overrides, v.lift_id), v.default_tm),
      'held_rpe', 8, 'load', v.default_load
    )
    ELSE v.params::jsonb
  END
FROM public.program p
JOIN public.athlete a ON a.id = p.athlete_id
JOIN auth.users u ON u.id = a.auth_user_id
CROSS JOIN (VALUES
  ('Lifting', 'Bench Press', 'tm_wave', 'bench', 255, 225,
    '{}'),
  ('Lifting', 'Strict OHP', 'rpe_autoreg', 'ohp', 140, 115,
    '{"target_rpe": 7, "increment": 5, "load": 115}'),
  ('Lifting', 'Back Squat', 'maintenance', 'squat', 375, 295,
    '{}'),
  ('Lifting', 'Deadlift', 'maintenance', 'deadlift', 410, 350,
    '{}'),
  ('Hypertrophy', 'DB Bench', 'double_progression', NULL, NULL, 100,
    '{"rep_low": 6, "rep_high": 8, "increment": 5, "load": 100, "sets": 4}'),
  ('Conditioning', 'Assault Bike', 'time_interval', NULL, NULL, NULL,
    '{"rounds": 8, "next_rounds": 10, "work": "10s", "rest": "50s"}'),
  ('Conditioning', 'Broad Jump', 'contacts', NULL, NULL, NULL,
    '{"contacts_cap_low": 40, "contacts_cap_high": 80}')
) AS v(track, exercise_name, engine_type, lift_id, default_tm, default_load, params)
JOIN public.track t ON t.program_id = p.id AND t.name = v.track
WHERE lower(u.email) = 'phillipchan1@gmail.com'
  AND p.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM public.progression_rule pr
    WHERE pr.track_id = t.id AND pr.exercise_name = v.exercise_name
  );

INSERT INTO public.autoreg_rule (athlete_id, scope_type, signal, op, value, action, action_params, message)
SELECT a.id, v.scope_type, v.signal, v.op, v.value, v.action, v.action_params::jsonb, v.message
FROM public.athlete a
JOIN auth.users u ON u.id = a.auth_user_id
CROSS JOIN (VALUES
  ('program', 'pain_knee', '>', 5, 'drop_exercise', '{"kind": "squat_lunge_plyo"}',
    'Knee > 5/10: no squats, lunges, or jumps today'),
  ('program', 'pain_knee', '>', 3, 'drop_exercise', '{"kind": "plyo"}',
    'Knee > 3/10: drop jumps and plyos'),
  ('program', 'pain_knee', '>=', 4, 'cap_depth', '{"kind": "squat_lunge", "load_lb": 265}',
    'Knee 4–5/10: squat 265 or cut depth'),
  ('program', 'sleep_hours', '<', 6, 'reduce_load_lb', '{"lb": 10}',
    'Short sleep: −10 lb, hold RPE'),
  ('exercise', 'warmup_quality', '==', 0, 'reduce_load_pct', '{"pct": 15}',
    'Shaky OHP warm-up: work at 85%')
) AS v(scope_type, signal, op, value, action, action_params, message)
WHERE lower(u.email) = 'phillipchan1@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.autoreg_rule r
    WHERE r.athlete_id = a.id AND r.message = v.message
  );

-- Seed a baseline measurement for broad jump so the sparkline has a first point.
INSERT INTO public.goal_measurement (athlete_id, goal_id, measured_on, value, source, note, client_key)
SELECT a.id, g.id, DATE '2026-10-01', 95, 'manual', 'Baseline 95"', 'seed:broad-jump-95'
FROM public.athlete a
JOIN auth.users u ON u.id = a.auth_user_id
JOIN public.athlete_goal g ON g.athlete_id = a.id AND g.name = 'Broad jump'
WHERE lower(u.email) = 'phillipchan1@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.goal_measurement m
    WHERE m.athlete_id = a.id AND m.client_key = 'seed:broad-jump-95'
  );
