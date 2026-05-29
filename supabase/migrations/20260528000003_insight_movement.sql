-- =============================================================================
-- INSIGHT MOVEMENT — track when an insight changes status / was last touched
-- Additive only. Powers the "insights moving" metric (Shift 6) and the
-- "Your zero this week" panel (Shift 4).
--   • updated_at  — bumped on every UPDATE (always)
--   • prev_status — the status an insight transitioned FROM (set only when
--                   status actually changes), so the UI can render "Hyp → Likely"
-- =============================================================================

ALTER TABLE public.insight
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS prev_status TEXT;

-- Trigger: stamp updated_at on every update; record prev_status on transitions.
CREATE OR REPLACE FUNCTION public.insight_track_movement()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.prev_status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS insight_track_movement_trg ON public.insight;

CREATE TRIGGER insight_track_movement_trg
  BEFORE UPDATE ON public.insight
  FOR EACH ROW
  EXECUTE FUNCTION public.insight_track_movement();

CREATE INDEX IF NOT EXISTS insight_updated_at_idx ON public.insight(updated_at);
