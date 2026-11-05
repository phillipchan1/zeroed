-- OPS, not a migration: confirm ONE athlete as an adult at the round-3
-- cut-over (spec section 11b, tracks_v1). Run by an operator, by hand, once
-- worker/schema/age-status.sql is applied. Never part of a fresh build and
-- never run by CI.
--
-- Why: from round 3 an athlete with no birth date on file gets the under-18
-- rules until a birth date or an 18+ confirmation is on file. An athlete the
-- operator already knows to be an adult (with tracks_v1 on and no birth date)
-- would otherwise drop to the under-18 rules on deploy. This records the
-- confirmation for them, as the system, the way their own "I'm 18 or older"
-- tap in Profile would.
--
-- Usage: replace the literal placeholder __ATHLETE_ID__ (both places) with
-- the athlete's id, then run the whole file in one go (psql -f). The id is
-- never committed here. Left as-is, the placeholder fails the uuid cast and
-- nothing is written.
--
-- What it does, all in one transaction:
--   - Sets athlete.adult_confirmed_at = now(), only if it is still null AND
--     birth_date is null. A birth date always decides age; this never reads
--     a date into it or writes one.
--   - Only when that update changed the row: one change_log row, actor
--     system / operator, tool confirm_adult, the same diff shape as the
--     athlete's own tap (before null → after the timestamp, unknown → adult),
--     the summary "Adult status confirmed by operator at round-3 cut-over",
--     and the methodology version it ran on (v1.3, the global version; the
--     athlete's prescriptions keep stamping their own effective version).
--
-- Idempotent: run again, the update matches nothing (already confirmed, or a
-- birth date is on file) and no second change_log row is written.
-- It never touches birth_date, flags, training_max_overrides or any program,
-- phase, routine, program_revision or other change_log row.
--
-- Undo: the athlete can undo it in Changes (back to unknown age, the under-18
-- rules; logged). Operator rollback for the column itself is the
-- age-status.sql rollback (tracks_v1 off, or drop the column).

BEGIN;
SET LOCAL TIME ZONE 'UTC';

WITH confirmed AS (
  UPDATE public.athlete
  SET adult_confirmed_at = NOW()
  WHERE id = '__ATHLETE_ID__'::uuid
    AND adult_confirmed_at IS NULL
    AND birth_date IS NULL
  RETURNING id, adult_confirmed_at
)
INSERT INTO public.change_log (
  athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
  approval_ref, preview_id, methodology_version
)
SELECT
  c.id, 'system', 'operator', 'confirm_adult', 'athlete', c.id::text,
  jsonb_build_object(
    'field', 'adult_confirmed_at',
    'before', NULL,
    'after', to_jsonb(c.adult_confirmed_at) #>> '{}',
    'age_status', jsonb_build_object('before', 'unknown', 'after', 'adult'),
    'source', 'operator',
    'summary', 'Adult status confirmed by operator at round-3 cut-over'
  ),
  'Adult status confirmed by operator at round-3 cut-over (no birth date on file; section 11b).',
  '[]'::jsonb,
  NULL, NULL, 'v1.3'
FROM confirmed c;

-- What it left: adult_confirmed_at set, birth_date untouched.
SELECT id, birth_date, adult_confirmed_at FROM public.athlete WHERE id = '__ATHLETE_ID__'::uuid;

COMMIT;
