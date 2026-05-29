-- =============================================================================
-- PROBE THROTTLE — pre-auth rate limiting for the agentic Probe
-- The Probe (obstacle text → follow-up Q + hypothesis) is the ONLY model call
-- allowed before auth. Guardrail #6: it must be rate-limited per device/IP so a
-- cold visitor cannot burn the OpenAI key. All post-auth generation is gated by
-- the user's JWT instead and does not touch this table.
--
-- The `agent` Edge Function calls check_probe_quota() with the service-role key
-- before every pre-auth probe. The function is SECURITY DEFINER and the table
-- has RLS enabled with no policies, so nothing but this function can read/write
-- it — not anon, not authenticated, not the browser.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.probe_throttle (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id  TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS probe_throttle_device_idx ON public.probe_throttle(device_id, created_at);
CREATE INDEX IF NOT EXISTS probe_throttle_ip_idx     ON public.probe_throttle(ip, created_at);

ALTER TABLE public.probe_throttle ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: only the SECURITY DEFINER function below may touch it.

-- -----------------------------------------------------------------------------
-- check_probe_quota — atomically counts recent probes for this device OR ip
-- within the window; if under the cap, records a new event and returns TRUE
-- (allowed); otherwise returns FALSE (throttled). Also opportunistically prunes
-- rows older than a day so the table stays small.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_probe_quota(
  p_device      TEXT,
  p_ip          TEXT,
  p_max         INT,
  p_window_secs INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recent_count INT;
  cutoff       TIMESTAMPTZ := NOW() - make_interval(secs => p_window_secs);
BEGIN
  -- Housekeeping: drop anything older than 24h (cheap, bounded).
  DELETE FROM public.probe_throttle WHERE created_at < NOW() - INTERVAL '24 hours';

  SELECT COUNT(*) INTO recent_count
    FROM public.probe_throttle
   WHERE created_at >= cutoff
     AND (
       (p_device IS NOT NULL AND device_id = p_device)
       OR (p_ip IS NOT NULL AND ip = p_ip)
     );

  IF recent_count >= p_max THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.probe_throttle (device_id, ip) VALUES (p_device, p_ip);
  RETURN TRUE;
END;
$$;

-- The Edge Function calls this with the service-role key, but grant to anon as
-- well so the contract is explicit and testable without service role if needed.
GRANT EXECUTE ON FUNCTION public.check_probe_quota(TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;
