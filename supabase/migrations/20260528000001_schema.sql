-- =============================================================================
-- Zeroed — full domain schema + Row Level Security
-- Every table has explicit RLS. Athletes can only access their own rows.
-- =============================================================================

-- =============================================================================
-- ATHLETE — identity, static goals, and profile metadata
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.athlete (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT,
  sport            TEXT,
  goals            TEXT,
  training_age     INTEGER,                     -- years of consistent training
  sessions_per_week INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT athlete_auth_user_unique UNIQUE (auth_user_id)
);

ALTER TABLE public.athlete ENABLE ROW LEVEL SECURITY;

CREATE POLICY athlete_select ON public.athlete
  FOR SELECT USING (auth_user_id = auth.uid());

CREATE POLICY athlete_insert ON public.athlete
  FOR INSERT WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY athlete_update ON public.athlete
  FOR UPDATE USING (auth_user_id = auth.uid());

-- No DELETE policy — athletes cannot delete themselves.

-- Helper: returns the athlete.id for the currently authenticated user.
-- Defined after public.athlete so LANGUAGE SQL validation passes.
-- SECURITY DEFINER avoids recursive RLS loops on tables that use this fn.
CREATE OR REPLACE FUNCTION get_current_athlete_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT id FROM public.athlete WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- =============================================================================
-- DIAGNOSTIC — a single assessment event (movement screen + strength + subjective)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.diagnostic (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  assessed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  test_battery     JSONB,           -- describes what was administered
  raw_results      JSONB,           -- { movement: {}, strength: {}, subjective: {} }
  delta_from_prior JSONB,           -- populated on reassessments
  version          INTEGER     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS diagnostic_athlete_id_idx ON public.diagnostic(athlete_id);

ALTER TABLE public.diagnostic ENABLE ROW LEVEL SECURITY;

CREATE POLICY diagnostic_select ON public.diagnostic
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY diagnostic_insert ON public.diagnostic
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

-- Diagnostics are immutable once written (no UPDATE / DELETE policies).

-- =============================================================================
-- INSIGHT — a confirmed weak-link finding surfaced to the athlete
-- LLM agents must promote from insight_draft; nothing writes here directly.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.insight (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  source_id      UUID,               -- nullable; points to diagnostic.id or workout.id etc.
  claim          TEXT        NOT NULL,
  category       TEXT        NOT NULL,  -- e.g. 'Lower Chain', 'Upper Chain', 'Core'
  priority       TEXT        NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  confidence     NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  status         TEXT        NOT NULL DEFAULT 'hypothesis'
                              CHECK (status IN ('hypothesis','likely','confirmed','resolved','disproved')),
  evidence       JSONB,               -- array of supporting observations
  source         TEXT,                -- 'diagnostic' | 'session_observation' | 'weekly_review'
  program_impact TEXT,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS insight_athlete_id_idx   ON public.insight(athlete_id);
CREATE INDEX IF NOT EXISTS insight_priority_idx     ON public.insight(priority);
CREATE INDEX IF NOT EXISTS insight_status_idx       ON public.insight(status);

ALTER TABLE public.insight ENABLE ROW LEVEL SECURITY;

CREATE POLICY insight_select ON public.insight
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY insight_insert ON public.insight
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY insight_update ON public.insight
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

-- No DELETE — insights are never deleted; they are resolved or disproved.

-- =============================================================================
-- INSIGHT_DRAFT — staging table; LLM agents write here first
-- The engine reviews and promotes to insight. (Used in Prompt 3.)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.insight_draft (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  source_id      UUID,
  claim          TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  priority       TEXT        NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  confidence     NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  status         TEXT        NOT NULL DEFAULT 'hypothesis'
                              CHECK (status IN ('hypothesis','likely','confirmed','resolved','disproved')),
  evidence       JSONB,
  source         TEXT,
  program_impact TEXT,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  reviewed       BOOLEAN     NOT NULL DEFAULT FALSE  -- set true once engine promotes or rejects
);

CREATE INDEX IF NOT EXISTS insight_draft_athlete_id_idx ON public.insight_draft(athlete_id);
CREATE INDEX IF NOT EXISTS insight_draft_reviewed_idx   ON public.insight_draft(reviewed);

ALTER TABLE public.insight_draft ENABLE ROW LEVEL SECURITY;

CREATE POLICY insight_draft_select ON public.insight_draft
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY insight_draft_insert ON public.insight_draft
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY insight_draft_update ON public.insight_draft
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

-- =============================================================================
-- ATHLETE_PROFILE — current training state; signals "Zeroed In" is complete
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.athlete_profile (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    UUID        NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_phase TEXT,       -- 'Stability' | 'Strength' | 'Power' | 'Sport'
  retest_date   DATE,
  CONSTRAINT athlete_profile_unique UNIQUE (athlete_id)
);

ALTER TABLE public.athlete_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY athlete_profile_select ON public.athlete_profile
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY athlete_profile_insert ON public.athlete_profile
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY athlete_profile_update ON public.athlete_profile
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

-- =============================================================================
-- PROGRAM — a training block with a goal and date range
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.program (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID  NOT NULL REFERENCES public.athlete(id) ON DELETE CASCADE,
  goal        TEXT,
  start_date  DATE  NOT NULL DEFAULT CURRENT_DATE,
  retest_date DATE,
  status      TEXT  NOT NULL DEFAULT 'active'
               CHECK (status IN ('draft','active','completed','paused'))
);

CREATE INDEX IF NOT EXISTS program_athlete_id_idx ON public.program(athlete_id);

ALTER TABLE public.program ENABLE ROW LEVEL SECURITY;

CREATE POLICY program_select ON public.program
  FOR SELECT USING (athlete_id = get_current_athlete_id());

CREATE POLICY program_insert ON public.program
  FOR INSERT WITH CHECK (athlete_id = get_current_athlete_id());

CREATE POLICY program_update ON public.program
  FOR UPDATE USING (athlete_id = get_current_athlete_id());

-- =============================================================================
-- PHASE — a block within a program (Stability → Strength → Power → Sport)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.phase (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id           UUID  NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  name                 TEXT  NOT NULL CHECK (name IN ('Stability','Strength','Power','Sport')),
  week_start           DATE  NOT NULL,
  week_end             DATE  NOT NULL,
  non_negotiables      JSONB,  -- array of strings: cues the athlete must never skip
  advancement_criteria JSONB,  -- array of strings: conditions to advance to next phase
  status               TEXT  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','completed','skipped'))
);

CREATE INDEX IF NOT EXISTS phase_program_id_idx ON public.phase(program_id);

ALTER TABLE public.phase ENABLE ROW LEVEL SECURITY;

CREATE POLICY phase_select ON public.phase
  FOR SELECT USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY phase_insert ON public.phase
  FOR INSERT WITH CHECK (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY phase_update ON public.phase
  FOR UPDATE USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

-- =============================================================================
-- ROUTINE — a named workout template belonging to a phase
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.routine (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   UUID  NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  phase_id     UUID  REFERENCES public.phase(id) ON DELETE SET NULL,
  name         TEXT  NOT NULL,
  session_type TEXT,            -- 'strength' | 'mobility' | 'conditioning'
  exercises    JSONB NOT NULL DEFAULT '[]',  -- [{name, sets, reps, load, cue}]
  intent       TEXT
);

CREATE INDEX IF NOT EXISTS routine_program_id_idx ON public.routine(program_id);
CREATE INDEX IF NOT EXISTS routine_phase_id_idx   ON public.routine(phase_id);

ALTER TABLE public.routine ENABLE ROW LEVEL SECURITY;

CREATE POLICY routine_select ON public.routine
  FOR SELECT USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY routine_insert ON public.routine
  FOR INSERT WITH CHECK (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY routine_update ON public.routine
  FOR UPDATE USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

-- =============================================================================
-- WORKOUT — an executed session (APPEND-ONLY event table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.workout (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id     UUID        NOT NULL REFERENCES public.routine(id) ON DELETE RESTRICT,
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actual_weights JSONB,   -- { "0": [{set,weight,reps,rpe}, ...], "1": [...] }
  actual_reps    JSONB,   -- kept separate for quick aggregate queries
  rpe            INTEGER  CHECK (rpe BETWEEN 1 AND 10),
  duration_mins  INTEGER
);

CREATE INDEX IF NOT EXISTS workout_routine_id_idx   ON public.workout(routine_id);
CREATE INDEX IF NOT EXISTS workout_performed_at_idx ON public.workout(performed_at DESC);

ALTER TABLE public.workout ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT and INSERT only. No UPDATE or DELETE policies.
CREATE POLICY workout_select ON public.workout
  FOR SELECT USING (
    routine_id IN (
      SELECT r.id FROM public.routine r
      INNER JOIN public.program p ON p.id = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY workout_insert ON public.workout
  FOR INSERT WITH CHECK (
    routine_id IN (
      SELECT r.id FROM public.routine r
      INNER JOIN public.program p ON p.id = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  );

-- =============================================================================
-- SESSION_OBSERVATION — a tagged signal from a single workout (APPEND-ONLY)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.session_observation (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_id UUID        NOT NULL REFERENCES public.workout(id) ON DELETE RESTRICT,
  category   TEXT        NOT NULL,   -- matches insight.category
  signal     TEXT        NOT NULL,
  severity   INTEGER     NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
  logged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_obs_workout_id_idx ON public.session_observation(workout_id);
CREATE INDEX IF NOT EXISTS session_obs_category_idx   ON public.session_observation(category);

ALTER TABLE public.session_observation ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT and INSERT only.
CREATE POLICY session_observation_select ON public.session_observation
  FOR SELECT USING (
    workout_id IN (
      SELECT w.id FROM public.workout w
      INNER JOIN public.routine r  ON r.id  = w.routine_id
      INNER JOIN public.program p  ON p.id  = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY session_observation_insert ON public.session_observation
  FOR INSERT WITH CHECK (
    workout_id IN (
      SELECT w.id FROM public.workout w
      INNER JOIN public.routine r  ON r.id  = w.routine_id
      INNER JOIN public.program p  ON p.id  = r.program_id
      WHERE p.athlete_id = get_current_athlete_id()
    )
  );

-- =============================================================================
-- WEEKLY_REVIEW — coach summary and next-week prescription
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.weekly_review (
  id                       UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id               UUID  NOT NULL REFERENCES public.program(id) ON DELETE CASCADE,
  week_ending              DATE  NOT NULL,
  coach_notes              TEXT,
  adjustments              JSONB,
  next_week_prescription   JSONB
);

CREATE INDEX IF NOT EXISTS weekly_review_program_id_idx ON public.weekly_review(program_id);

ALTER TABLE public.weekly_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY weekly_review_select ON public.weekly_review
  FOR SELECT USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY weekly_review_insert ON public.weekly_review
  FOR INSERT WITH CHECK (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );

CREATE POLICY weekly_review_update ON public.weekly_review
  FOR UPDATE USING (
    program_id IN (
      SELECT id FROM public.program WHERE athlete_id = get_current_athlete_id()
    )
  );
