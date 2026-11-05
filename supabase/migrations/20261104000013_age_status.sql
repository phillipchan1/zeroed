-- Age status (spec section 11b, tracks_v1): an athlete with no birth date on
-- file gets the under-18 rules until intake records a birth date or the
-- athlete confirms "I'm 18 or older". This column holds that confirmation:
-- when the athlete tapped it (Intake or Profile; a logged athlete write in
-- change_log, tool confirm_adult). A birth date always wins over it. No coach,
-- app_coach included, can set it; /api/data can't read or write it.
--
-- Additive and idempotent: one nullable ADD COLUMN IF NOT EXISTS, no default,
-- so no existing row is rewritten and every athlete starts unconfirmed. No
-- other table is touched; birth_date, program, phase, routine,
-- program_revision, change_log rows and athlete.training_max_overrides are
-- not read or written here. The guardian confirmation for a minor's red-flag
-- clear and the downgrade voiding need no schema (change_log diff, existing
-- voided_at columns). Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';      -- per athlete, instant: unknown age back to adult rules, column ignored
--   ALTER TABLE public.athlete DROP COLUMN adult_confirmed_at;  -- optional; the Worker reads it as not confirmed when absent

ALTER TABLE public.athlete ADD COLUMN IF NOT EXISTS adult_confirmed_at TIMESTAMPTZ;
