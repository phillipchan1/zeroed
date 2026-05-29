-- =============================================================================
-- BACKFILL — stamp insight_id onto pre-existing routine exercises (Shift 5)
-- Programs built before generateInitialProgram() started stamping insight_id
-- have unattributed exercises, so the WorkoutScreen "why" info icon never
-- shows. This one-time backfill stamps every exercise with its program's P1
-- insight (highest priority, still active) — matching the deterministic engine
-- behaviour. Idempotent: only fills exercises that lack insight_id.
-- TODO Prompt 3: ProgramDesignAgent will write per-exercise attribution.
-- =============================================================================

UPDATE public.routine r
SET exercises = (
  SELECT jsonb_agg(
    CASE
      WHEN elem ? 'insight_id' THEN elem
      ELSE elem || jsonb_build_object('insight_id', p1.insight_id)
    END
  )
  FROM jsonb_array_elements(r.exercises) elem
)
FROM (
  SELECT
    pr.id AS program_id,
    (
      SELECT i.id
      FROM public.insight i
      WHERE i.athlete_id = pr.athlete_id
        AND i.status NOT IN ('resolved', 'disproved')
      ORDER BY i.priority ASC, i.generated_at ASC
      LIMIT 1
    ) AS insight_id
  FROM public.program pr
) p1
WHERE r.program_id = p1.program_id
  AND p1.insight_id IS NOT NULL;
