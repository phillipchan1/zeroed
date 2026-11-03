-- Synthetic workers.dev preview data. Not a real athlete and not production.
-- Apply after worker/schema/app.sql and worker/schema/better-auth.sql.
-- Idempotent: clears only this preview athlete, then reinserts.

-- Preview ids are fixed so the seed is rerunnable.
-- user/auth:  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
-- athlete:    11111111-1111-4111-8111-111111111111

DELETE FROM public.session_observation
 WHERE workout_id IN (
   SELECT w.id
     FROM public.workout w
     JOIN public.routine r ON r.id = w.routine_id
     JOIN public.program p ON p.id = r.program_id
    WHERE p.athlete_id = '11111111-1111-4111-8111-111111111111'
 );

DELETE FROM public.workout
 WHERE routine_id IN (
   SELECT r.id
     FROM public.routine r
     JOIN public.program p ON p.id = r.program_id
    WHERE p.athlete_id = '11111111-1111-4111-8111-111111111111'
 );

DELETE FROM public.athlete WHERE id = '11111111-1111-4111-8111-111111111111';

INSERT INTO auth.users (id, email, created_at, updated_at)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'preview.athlete@zeroed.invalid',
  '2026-01-15T12:00:00Z',
  '2026-01-15T12:00:00Z'
)
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Preview Athlete',
  'preview.athlete@zeroed.invalid',
  FALSE,
  '2026-01-15T12:00:00Z',
  '2026-01-15T12:00:00Z'
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  name = EXCLUDED.name;

INSERT INTO public.athlete (
  id, auth_user_id, name, sport, goals, obstacle, training_age,
  sessions_per_week, training_preferences, onboarding_step, arena_type, arena_raw
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Preview Athlete',
  'running',
  'Stay consistent on a preview build',
  'No real training history',
  2,
  3,
  'Synthetic preview only',
  'complete',
  'sport',
  'preview 5k'
);

INSERT INTO public.athlete_profile (athlete_id, current_phase, retest_date)
VALUES ('11111111-1111-4111-8111-111111111111', 'Strength', '2026-12-01');

INSERT INTO public.program (id, athlete_id, goal, status, start_date)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'Preview block',
  'active',
  '2026-10-20'
);

INSERT INTO public.track (program_id, name, color, icon, sort_order, purpose)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  'General', '#9A9A9A', 'circle', 0, 'Default track for unassigned work'
);

INSERT INTO public.phase (
  id, program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  '33333333-3333-4333-8333-333333333333',
  'Strength',
  '2026-10-20',
  '2026-11-16',
  '["Preview non-negotiable"]'::jsonb,
  '["Preview advances"]'::jsonb,
  'active'
);

INSERT INTO public.routine (
  id, program_id, phase_id, name, session_type, exercises, intent, intended_dow
) VALUES (
  '77777777-7777-4777-8777-777777777777',
  '33333333-3333-4333-8333-333333333333',
  '55555555-5555-4555-8555-555555555555',
  'Preview day',
  'strength',
  '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy","cue":"Preview squat"}]'::jsonb,
  'Preview intent',
  0
);

INSERT INTO public.workout (
  id, routine_id, performed_at, rpe, duration_mins, actual_weights, exercises_snapshot
) VALUES (
  '99999999-9999-4999-8999-999999999999',
  '77777777-7777-4777-8777-777777777777',
  '2026-10-21T12:00:00Z',
  8,
  45,
  '{"0":[{"set":1,"weight":135,"reps":5,"rpe":8,"done":true}]}'::jsonb,
  '[{"name":"Back Squat","sets":3,"reps":"5","load":"heavy","cue":"Preview squat"}]'::jsonb
);

INSERT INTO public.session_observation (id, workout_id, category, signal, severity)
VALUES (
  'aaaa1111-0000-4000-8000-000000000001',
  '99999999-9999-4999-8999-999999999999',
  'Lower Chain',
  'Preview felt fine',
  2
);

INSERT INTO public.insight (
  id, athlete_id, claim, category, priority, confidence, status, program_impact
) VALUES (
  'aaaa2222-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'Preview-only claim',
  'Lower Chain',
  'P1',
  0.8,
  'likely',
  'Preview impact'
);

INSERT INTO public.weekly_review (id, program_id, week_ending, coach_notes)
VALUES (
  'aaaa3333-0000-4000-8000-000000000001',
  '33333333-3333-4333-8333-333333333333',
  '2026-10-26',
  'Preview weekly note'
);

INSERT INTO public.program_revision (
  id, program_id, phase_id, trigger, effective_on, requests, summary
) VALUES (
  'aaaa4444-0000-4000-8000-000000000001',
  '33333333-3333-4333-8333-333333333333',
  '55555555-5555-4555-8555-555555555555',
  'editor',
  '2026-10-20',
  '["Preview request"]'::jsonb,
  'Preview revision'
);

INSERT INTO public.coach_message (id, athlete_id, role, kind, body)
VALUES (
  'aaaa5555-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'coach',
  'note',
  'Synthetic preview note'
);

INSERT INTO public.mcp_token (id, athlete_id, name, token_hash, last_four)
VALUES (
  'aaaa6666-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'preview-mcp',
  'preview-hash-not-a-secret',
  'prev'
);
