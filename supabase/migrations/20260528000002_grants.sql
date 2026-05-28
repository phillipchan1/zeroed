-- =============================================================================
-- Zeroed — role grants
-- RLS policies control row visibility, but the authenticated role still needs
-- table-level privileges. anon gets nothing — every endpoint requires auth.
-- =============================================================================

-- Function
GRANT EXECUTE ON FUNCTION get_current_athlete_id() TO authenticated;

-- Tables
GRANT SELECT, INSERT, UPDATE           ON public.athlete             TO authenticated;
GRANT SELECT, INSERT                   ON public.diagnostic          TO authenticated;
GRANT SELECT, INSERT, UPDATE           ON public.insight             TO authenticated;
GRANT SELECT, INSERT, UPDATE           ON public.insight_draft       TO authenticated;
GRANT SELECT, INSERT, UPDATE           ON public.athlete_profile     TO authenticated;
GRANT SELECT, INSERT, UPDATE           ON public.program             TO authenticated;
GRANT SELECT, INSERT, UPDATE           ON public.phase               TO authenticated;
GRANT SELECT, INSERT, UPDATE           ON public.routine             TO authenticated;
GRANT SELECT, INSERT                   ON public.workout             TO authenticated;  -- append-only
GRANT SELECT, INSERT                   ON public.session_observation TO authenticated;  -- append-only
GRANT SELECT, INSERT, UPDATE           ON public.weekly_review       TO authenticated;
