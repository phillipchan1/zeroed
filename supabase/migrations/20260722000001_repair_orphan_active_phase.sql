-- One-off data repair for the orphaned-duplicate-phase bug.
--
-- Phil's program accumulated a duplicate "Strength" phase left in status='active'
-- with ZERO routines (created by runPhaseAdvancement inserting a fresh phase
-- instead of activating the pending one). Because the active phase had no
-- routines, useAppState.fetchSnapshot fell into its legacy "no phase wiring"
-- fallback and loaded EVERY routine in the program (15, across all phases) onto
-- the weekly plan. It also broke week scheduling.
--
-- Fix: collapse to exactly one active phase — the most recent phase that actually
-- has routines (i.e. the latest real/rebuilt block) — and retire every other
-- phase (including the empty orphan). Scoped strictly to this athlete; a no-op on
-- any database that doesn't contain the row, so it is safe to keep in history.
DO $$
DECLARE
  v_athlete       uuid := 'e53d0ef9-3c51-4c4e-a9da-acb0e316a1f4';
  v_program       uuid;
  v_target_phase  uuid;
  v_phase_name    text;
  v_active_count  int;
  v_routine_count int;
BEGIN
  SELECT id INTO v_program
    FROM program
   WHERE athlete_id = v_athlete AND status = 'active'
   LIMIT 1;
  IF v_program IS NULL THEN
    RAISE NOTICE 'repair: no active program for athlete %, skipping', v_athlete;
    RETURN;
  END IF;

  -- Keep the block with routines and the latest start date (the current block).
  SELECT ph.id, ph.name
    INTO v_target_phase, v_phase_name
    FROM phase ph
   WHERE ph.program_id = v_program
     AND EXISTS (SELECT 1 FROM routine r WHERE r.phase_id = ph.id)
   ORDER BY ph.week_start DESC NULLS LAST, ph.id
   LIMIT 1;
  IF v_target_phase IS NULL THEN
    RAISE NOTICE 'repair: program % has no phase with routines, skipping', v_program;
    RETURN;
  END IF;

  -- Exactly one active phase: retire all others, then activate the target.
  UPDATE phase SET status = 'completed'
   WHERE program_id = v_program AND id <> v_target_phase AND status = 'active';
  UPDATE phase SET status = 'active'
   WHERE id = v_target_phase;

  -- Keep the profile's display phase in sync with the newly active block.
  UPDATE athlete_profile
     SET current_phase = v_phase_name, last_updated = now()
   WHERE athlete_id = v_athlete;

  SELECT count(*) INTO v_active_count  FROM phase   WHERE program_id = v_program AND status = 'active';
  SELECT count(*) INTO v_routine_count FROM routine WHERE phase_id = v_target_phase;
  RAISE NOTICE 'repair done: program=% active_phase=% (%) active_phase_count=% routines_in_active=%',
    v_program, v_target_phase, v_phase_name, v_active_count, v_routine_count;
END $$;
