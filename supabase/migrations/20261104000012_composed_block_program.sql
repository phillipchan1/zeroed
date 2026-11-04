-- Composed blocks write the week's exercises (Round 2 item 6, coach_v1).
-- apply_composed_block now also queues the block's week as a new pending
-- phase (one routine per training day) from the block's start; the live
-- block keeps running until then and is never rewritten. This column records
-- which phase a block queued, so a re-compose before it starts replaces it
-- (skipped, kept) instead of refusing, and a revert can skip it again.
--
-- Additive and idempotent: one nullable ADD COLUMN IF NOT EXISTS, no default,
-- no foreign key (composed_block is append-only, so it never gains an ON
-- DELETE action), so no existing row is rewritten. No other table is
-- touched; program, phase, routine, program_revision rows and
-- athlete.training_max_overrides are not read or written here. Revert:
--   UPDATE public.athlete SET flags = flags - 'coach_v1';                -- per athlete, instant
--   ALTER TABLE public.composed_block DROP COLUMN phase_id;             -- optional

ALTER TABLE public.composed_block ADD COLUMN IF NOT EXISTS phase_id UUID;
