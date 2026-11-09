-- Additive, nullable starter-pack columns for agent-led onboarding (#31).
-- onboarding_step CHECK is untouched. Columns are ignored when null or when
-- onboarding_agent_v1 is off.

ALTER TABLE public.athlete
  ADD COLUMN IF NOT EXISTS starter_pack TEXT
    CHECK (starter_pack IS NULL OR starter_pack IN (
      'sport_sc',
      'get_strong',
      'chase_total',
      'hybrid',
      'layoff',
      'thirty_three',
      'byo'
    )),
  ADD COLUMN IF NOT EXISTS starter_pack_settings JSONB,
  ADD COLUMN IF NOT EXISTS onboarding_answers JSONB;

COMMENT ON COLUMN public.athlete.starter_pack IS
  'Starter pack id (sport_sc, get_strong, …). Null until a pack is started. Ignored when onboarding_agent_v1 is off.';

COMMENT ON COLUMN public.athlete.starter_pack_settings IS
  'Pack settings jsonb, e.g. {sport, season, game_days}. Sport is a setting, not a library.';

COMMENT ON COLUMN public.athlete.onboarding_answers IS
  'Onboarding answers envelope {"v":1,...} (goal, days, minutes, equipment, lifts, pain, style). Separate from starter_pack_settings. Validated in engine code.';
