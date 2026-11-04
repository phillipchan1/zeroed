-- session_rpe queue columns (Round 2 item 4, tracks_v1): offline session-RPE
-- taps and rating last night's session after midnight. The app queues a tap it
-- couldn't send and retries it; these two columns let the Worker dedupe the
-- retries and order a late tap against a newer one.
--
-- Additive and idempotent: two ADD COLUMN IF NOT EXISTS (both nullable, no
-- default, so no existing row is rewritten) and one partial unique index. No
-- other table is touched; workout.rpe, workout.session_rpe, program, routine,
-- program_revision rows and athlete.training_max_overrides are not read or
-- written here. Revert:
--   UPDATE public.athlete SET flags = flags - 'tracks_v1';   -- per athlete, instant
--   ALTER TABLE public.session_rpe DROP COLUMN client_id, DROP COLUMN tapped_at;   -- optional

-- client_id  the app's id for the tap the row holds now (a UUID minted at the
--            tap). A retry carrying the same id is "already logged".
-- tapped_at  when that tap happened: the app's clock for a queued tap (trusted
--            only within bounds, worker/src/sessionRpe.ts), else the server's.
--            A queued tap older than the row's is acknowledged, not applied.
ALTER TABLE public.session_rpe ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE public.session_rpe ADD COLUMN IF NOT EXISTS tapped_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS session_rpe_athlete_client_uidx
  ON public.session_rpe (athlete_id, client_id) WHERE client_id IS NOT NULL;
