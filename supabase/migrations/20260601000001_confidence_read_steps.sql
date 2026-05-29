-- =============================================================================
-- CONFIDENCE-DRIVEN READ — onboarding step machine, trimmed
-- The new flow gates the SESSION, not the read: there is no movement-screen
-- gate. The 7-pattern screen (screening), its compute beat (computing), and the
-- pre-CTA zeroed_in screen are retired. The provisional first session is built
-- from the probe hypothesis in an ephemeral "calibrating" beat during the
-- orientation → first_session_pending transition (no DB step for it).
--
-- Surviving steps:
--   hook → orientation → first_session_pending → first_session_complete → complete
--
-- This migration is ADDITIVE-SAFE: it drops whatever CHECK currently constrains
-- onboarding_step (regardless of its generated name), migrates any live rows off
-- the retired steps to the nearest surviving step, then re-adds the tightened
-- CHECK. reset_athlete_orientation() already resets to 'hook' and is unchanged.
-- =============================================================================

-- 1. Drop any existing CHECK constraint that references onboarding_step,
--    whatever its (possibly auto-generated) name is.
DO $$
DECLARE
  cons text;
BEGIN
  FOR cons IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.athlete'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%onboarding_step%'
  LOOP
    EXECUTE format('ALTER TABLE public.athlete DROP CONSTRAINT %I', cons);
  END LOOP;
END $$;

-- 2. Migrate live rows OFF the retired steps BEFORE re-adding the CHECK.
--    screening      → orientation            (nothing built yet; re-run orientation → build)
--    computing      → first_session_pending  (program was about to/just built; land at the gate)
--    zeroed_in      → first_session_pending  (pre-CTA → the session gate)
UPDATE public.athlete SET onboarding_step = 'orientation'
 WHERE onboarding_step = 'screening';
UPDATE public.athlete SET onboarding_step = 'first_session_pending'
 WHERE onboarding_step IN ('computing', 'zeroed_in');

-- 3. Re-add the tightened CHECK with the surviving step set.
ALTER TABLE public.athlete
  ADD CONSTRAINT athlete_onboarding_step_check
  CHECK (onboarding_step IN (
    'hook',                    -- pre-auth: splash → obstacle → probe → reveal (ephemeral sub-states)
    'orientation',             -- post-auth: trimmed calibrate fields (+ ephemeral build beat)
    'first_session_pending',   -- session handed over, not yet logged
    'first_session_complete',  -- session logged; post-session revelation
    'complete'                 -- in the daily loop
  ));
