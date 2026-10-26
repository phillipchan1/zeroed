-- Minimal public schema for access-isolation checks (PGlite).
-- Two athletes are seeded; queries run through worker store/edits.

CREATE TABLE athlete (
  id UUID PRIMARY KEY,
  auth_user_id UUID NOT NULL UNIQUE,
  name TEXT,
  sport TEXT,
  goals TEXT,
  obstacle TEXT,
  training_age INTEGER,
  sessions_per_week INTEGER,
  training_preferences TEXT,
  arena_type TEXT,
  arena_raw TEXT,
  limiter_choice TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE athlete_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL UNIQUE REFERENCES athlete(id) ON DELETE CASCADE,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_phase TEXT,
  retest_date DATE
);

CREATE TABLE program (
  id UUID PRIMARY KEY,
  athlete_id UUID NOT NULL REFERENCES athlete(id) ON DELETE CASCADE,
  goal TEXT,
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  retest_date DATE,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE phase (
  id UUID PRIMARY KEY,
  program_id UUID NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  non_negotiables JSONB,
  advancement_criteria JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE routine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  phase_id UUID REFERENCES phase(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  session_type TEXT,
  exercises JSONB NOT NULL DEFAULT '[]',
  intent TEXT,
  intended_dow SMALLINT
);

CREATE TABLE workout (
  id UUID PRIMARY KEY,
  routine_id UUID NOT NULL REFERENCES routine(id) ON DELETE RESTRICT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actual_weights JSONB,
  actual_reps JSONB,
  rpe INTEGER,
  duration_mins INTEGER,
  exercises_snapshot JSONB
);

CREATE TABLE session_observation (
  id UUID PRIMARY KEY,
  workout_id UUID NOT NULL REFERENCES workout(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  signal TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE insight (
  id UUID PRIMARY KEY,
  athlete_id UUID NOT NULL REFERENCES athlete(id) ON DELETE CASCADE,
  source_id UUID,
  claim TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'hypothesis',
  evidence JSONB,
  source TEXT,
  program_impact TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE weekly_review (
  id UUID PRIMARY KEY,
  program_id UUID NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  week_ending DATE NOT NULL,
  coach_notes TEXT,
  adjustments JSONB,
  next_week_prescription JSONB
);

CREATE TABLE program_revision (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  phase_id UUID REFERENCES phase(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger TEXT NOT NULL DEFAULT 'editor',
  effective_on DATE NOT NULL,
  requests JSONB NOT NULL DEFAULT '[]',
  snapshot JSONB NOT NULL DEFAULT '[]',
  diff JSONB NOT NULL DEFAULT '{}',
  summary TEXT
);

CREATE TABLE coach_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athlete(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL,
  ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mcp_token (
  id UUID PRIMARY KEY,
  athlete_id UUID NOT NULL REFERENCES athlete(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_four TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

-- Athlete A
INSERT INTO athlete (id, auth_user_id, name, sport, goals, obstacle, training_age, sessions_per_week, training_preferences)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'Athlete A', 'running', 'A only goal', 'A obstacle', 4, 3, 'A prefers hills'
);
INSERT INTO athlete_profile (athlete_id, current_phase, retest_date)
VALUES ('11111111-1111-1111-1111-111111111111', 'Strength', '2026-12-01');
INSERT INTO program (id, athlete_id, goal, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'A program', 'active');
INSERT INTO phase (id, program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status)
VALUES (
  '55555555-5555-5555-5555-555555555555',
  '33333333-3333-3333-3333-333333333333',
  'Strength', '2026-10-20', '2026-11-16',
  '["A non-negotiable"]'::jsonb, '["A advances"]'::jsonb, 'active'
);
INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
VALUES (
  '77777777-7777-7777-7777-777777777777',
  '33333333-3333-3333-3333-333333333333',
  '55555555-5555-5555-5555-555555555555',
  'A day', 'strength',
  '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy","cue":"A squat"}]'::jsonb,
  'A intent', 0
);
INSERT INTO workout (id, routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
VALUES (
  '99999999-9999-9999-9999-999999999999',
  '77777777-7777-7777-7777-777777777777',
  '2026-10-21T12:00:00Z', 8, 45,
  '{"0":[{"set":1,"weight":225,"reps":5,"rpe":8,"done":true}]}'::jsonb,
  '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy","cue":"A squat"}]'::jsonb
);
INSERT INTO session_observation (id, workout_id, category, signal, severity)
VALUES (
  'aaaa1111-0000-4000-8000-000000000001',
  '99999999-9999-9999-9999-999999999999',
  'Lower Chain', 'A felt good', 2
);
INSERT INTO insight (id, athlete_id, claim, category, priority, confidence, status, program_impact)
VALUES (
  'aaaa2222-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'A only', 'Lower Chain', 'P1', 0.8, 'likely', 'A impact'
);
INSERT INTO weekly_review (id, program_id, week_ending, coach_notes)
VALUES (
  'aaaa3333-0000-4000-8000-000000000001',
  '33333333-3333-3333-3333-333333333333',
  '2026-10-26', 'A weekly note'
);
INSERT INTO program_revision (id, program_id, phase_id, trigger, effective_on, requests, summary)
VALUES (
  'aaaa4444-0000-4000-8000-000000000001',
  '33333333-3333-3333-3333-333333333333',
  '55555555-5555-5555-5555-555555555555',
  'editor', '2026-10-20', '["A request"]'::jsonb, 'A revision'
);
INSERT INTO coach_message (id, athlete_id, role, kind, body)
VALUES (
  'aaaa5555-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'coach', 'note', 'private A'
);
INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four)
VALUES (
  'aaaa6666-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'claude-a', 'hash-a', 'aaa1'
);

-- Athlete B
INSERT INTO athlete (id, auth_user_id, name, sport, goals, obstacle, training_age, sessions_per_week, training_preferences)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'Athlete B', 'rowing', 'B only goal', 'B obstacle', 6, 4, 'B prefers ergs'
);
INSERT INTO athlete_profile (athlete_id, current_phase, retest_date)
VALUES ('22222222-2222-2222-2222-222222222222', 'Power', '2026-12-15');
INSERT INTO program (id, athlete_id, goal, status)
VALUES ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'B program', 'active');
INSERT INTO phase (id, program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status)
VALUES (
  '66666666-6666-6666-6666-666666666666',
  '44444444-4444-4444-4444-444444444444',
  'Power', '2026-10-20', '2026-11-16',
  '["B non-negotiable"]'::jsonb, '["B advances"]'::jsonb, 'active'
);
INSERT INTO routine (id, program_id, phase_id, name, session_type, exercises, intent, intended_dow)
VALUES (
  '88888888-8888-8888-8888-888888888888',
  '44444444-4444-4444-4444-444444444444',
  '66666666-6666-6666-6666-666666666666',
  'B day', 'strength',
  '[{"name":"Deadlift","sets":3,"reps":"3","load":"heavy","cue":"B pull"}]'::jsonb,
  'B intent', 1
);
INSERT INTO workout (id, routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot)
VALUES (
  'bbbb9999-9999-4999-8999-999999999999',
  '88888888-8888-8888-8888-888888888888',
  '2026-10-22T12:00:00Z', 9, 50,
  '{"0":[{"set":1,"weight":315,"reps":3,"rpe":9,"done":true}]}'::jsonb,
  '[{"name":"Deadlift","sets":3,"reps":"3","load":"heavy","cue":"B pull"}]'::jsonb
);
INSERT INTO session_observation (id, workout_id, category, signal, severity)
VALUES (
  'bbbb1111-0000-4000-8000-000000000001',
  'bbbb9999-9999-4999-8999-999999999999',
  'Lower Chain', 'B felt good', 3
);
INSERT INTO insight (id, athlete_id, claim, category, priority, confidence, status, program_impact)
VALUES (
  'bbbb2222-0000-4000-8000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  'B only', 'Lower Chain', 'P1', 0.9, 'confirmed', 'B impact'
);
INSERT INTO weekly_review (id, program_id, week_ending, coach_notes)
VALUES (
  'bbbb3333-0000-4000-8000-000000000001',
  '44444444-4444-4444-4444-444444444444',
  '2026-10-26', 'B weekly note'
);
INSERT INTO program_revision (id, program_id, phase_id, trigger, effective_on, requests, summary)
VALUES (
  'bbbb4444-0000-4000-8000-000000000001',
  '44444444-4444-4444-4444-444444444444',
  '66666666-6666-6666-6666-666666666666',
  'editor', '2026-10-20', '["B request"]'::jsonb, 'B revision'
);
INSERT INTO coach_message (id, athlete_id, role, kind, body)
VALUES (
  'bbbb5555-0000-4000-8000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  'coach', 'note', 'private B'
);
INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four)
VALUES (
  'bbbb6666-0000-4000-8000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  'claude-b', 'hash-b', 'bbb1'
);
