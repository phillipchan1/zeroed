-- Example athlete-tracks seed. Copy to local/seed-athlete-tracks.sql
-- (gitignored) and edit. The runner passes :'athlete_email'.
-- Do not commit personal emails, loads, or health notes.

-- UPDATE public.athlete a
-- SET flags = COALESCE(a.flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb
-- FROM auth.users u
-- WHERE a.auth_user_id = u.id
--   AND lower(u.email) = lower(:'athlete_email');

SELECT 1;
