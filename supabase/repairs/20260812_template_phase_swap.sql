-- =============================================================================
-- ONE-OFF DATA REPAIR — 2026-08-12. NOT a migration: this is a single athlete's
-- data, it is not schema, and it must not replay on every `supabase db push`.
-- Run once, by hand, reviewed. Kept in the repo as the record of the incident.
--
--   supabase db query --linked "$(cat supabase/repairs/20260812_template_phase_swap.sql)"
--
-- WHAT HAPPENED
-- On Tue 2026-08-11 19:03 UTC runPhaseAdvancement retired the athlete's live
-- five-session Stability block (phase 9ff5c1df) and installed phase 556a405d
-- "Strength" containing three routines named Session A / Session B / Session C —
-- verbatim generatePhase() template output, entirely upper-body mobility, in a
-- block labelled Strength, for an athlete whose sessions_per_week is 5.
--
-- The advancement gate was correct (6 of 5 sessions, criteria met). The DESIGN
-- call failed, and designPhasePlan returned the deterministic template on any
-- failure with no way for the caller to distinguish it from a real block. The
-- athlete's sessions were never deleted — TRAIN lists routines of the ACTIVE
-- phase, so they simply stopped being visible.
--
-- The code half of this is commit 58da244 ("Never replace a real training block
-- with the fallback template"), which makes the boundary design before it
-- retires anything and hold the current block when the designer falls back.
-- This file repairs the data that the old behaviour already wrote.
--
-- WHY IT IS SHAPED THIS WAY
-- Step 2 COPIES the routines rather than moving them. Six workouts logged
-- 2026-08-03 → 08-08 point at those Stability routine rows; moving them would
-- drag last week's sessions into this block and misattribute them.
-- Step 3 then re-points ONLY the Mon 08-10 session, which genuinely belongs to
-- the re-anchored week, so the week reads 1 of 5 done rather than 0 of 5.
-- Safe because workout.exercises_snapshot already froze the prescription that
-- actual_weights is index-keyed against (migration 20260731000001).
-- Step 4 deletes the template routines LAST and only once five replacements
-- exist, so an interrupted run can never leave the active phase empty — the
-- orphan-active-phase failure mode that caused a separate incident in July.
-- =============================================================================

BEGIN;

-- 1. Re-anchor the block to the Monday/Sunday boundary it should always have
--    had. It was stamped with `today` (a Tuesday), which is what split the
--    athlete's week across two phases.
UPDATE phase SET week_start = '2026-08-10', week_end = '2026-09-06'
WHERE id = '556a405d-25d2-4aa6-9613-ce58aa632434';

-- 2. Copy the five real sessions into the block. See "why it is shaped this way".
--    NOT EXISTS keeps this idempotent: a second run copies nothing rather than
--    silently doubling the week to ten sessions.
INSERT INTO routine (program_id, phase_id, name, session_type, exercises, intent, intended_dow)
SELECT src.program_id, '556a405d-25d2-4aa6-9613-ce58aa632434',
       src.name, src.session_type, src.exercises, src.intent, src.intended_dow
FROM routine src
WHERE src.phase_id = '9ff5c1df-cdf0-4166-bfab-132fa4fa832d'
  AND NOT EXISTS (
    SELECT 1 FROM routine dst
    WHERE dst.phase_id = '556a405d-25d2-4aa6-9613-ce58aa632434'
      AND dst.name = src.name
  );

-- 3. Re-point only the Mon 2026-08-10 session onto its new copy, by name.
UPDATE workout w SET routine_id = (
  SELECT r.id FROM routine r
  WHERE r.phase_id = '556a405d-25d2-4aa6-9613-ce58aa632434'
    AND r.name = (SELECT r2.name FROM routine r2 WHERE r2.id = w.routine_id)
)
WHERE w.performed_at >= '2026-08-10' AND w.performed_at < '2026-08-11'
  AND w.routine_id IN (
    SELECT id FROM routine WHERE phase_id = '9ff5c1df-cdf0-4166-bfab-132fa4fa832d'
  );

-- 4. Drop the template sessions, guarded twice: nothing may reference them, and
--    the five replacements must already be in place.
DELETE FROM routine
WHERE phase_id = '556a405d-25d2-4aa6-9613-ce58aa632434'
  AND name IN ('Session A', 'Session B', 'Session C')
  AND NOT EXISTS (SELECT 1 FROM workout w WHERE w.routine_id = routine.id)
  AND (
    SELECT count(*) FROM routine r2
    WHERE r2.phase_id = '556a405d-25d2-4aa6-9613-ce58aa632434'
      AND r2.name NOT IN ('Session A', 'Session B', 'Session C')
  ) >= 5;

COMMIT;

-- ---- verification (run separately; expect 5 real names, Mon 08-10 marked) ----
-- select ph.week_start, ph.week_end, r.name, jsonb_array_length(r.exercises) ex,
--        (select count(*) from workout w where w.routine_id = r.id
--           and w.performed_at >= '2026-08-10') done_this_week
-- from phase ph join routine r on r.phase_id = ph.id
-- where ph.id = '556a405d-25d2-4aa6-9613-ce58aa632434' order by r.name;
