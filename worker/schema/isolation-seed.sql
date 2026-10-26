-- Seed two athletes after supabase/migrations have been applied to PGlite.
-- IDs are fixed so access.check.ts can name them.

INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@example.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@example.com');

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
INSERT INTO insight (id, athlete_id, claim, category, priority, confidence, status, program_impact)
VALUES (
  'aaaa2222-0000-4000-8000-000000000002',
  '11111111-1111-1111-1111-111111111111',
  'A resolved', 'Lower Chain', 'P3', 0.4, 'resolved', NULL
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
ALTER TABLE mcp_token ADD COLUMN IF NOT EXISTS expires_at timestamptz;

INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four)
VALUES (
  'aaaa6666-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'claude-a', 'hash-a', 'aaa1'
);
INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four, revoked_at)
VALUES (
  'aaaa7777-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'revoked-a', 'hash-revoked-a', 'rvaa', NOW()
);
INSERT INTO mcp_token (id, athlete_id, name, token_hash, last_four, expires_at)
VALUES (
  'aaaa8888-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'expired-a', 'hash-expired-a', 'exaa', NOW() - INTERVAL '1 hour'
);

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
