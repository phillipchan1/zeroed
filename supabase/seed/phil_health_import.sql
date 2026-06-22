-- =============================================================================
-- Phil's Health — one-time program import (Notion → Zeroed)
--
-- Pre-populates the database with Phil's real 12-week block, diagnosis, AND the
-- five weeks of training history he has already logged (May 19 – Jun 20), so
-- the app can be used immediately WITHOUT going through the AI orientation flow
-- (which would generate its own competing program + read).
--
-- Source of truth: Notion "Phil's Health" — Program 1 (Stability & Athletic
-- Foundation), Athlete Profile, Weak Link Map, and the Week 1–5 session logs.
--
-- WHAT IT DOES
--   • Upserts the athlete and drops them straight into the daily loop
--     (onboarding_step = 'complete') — orientation is skipped entirely.
--   • Seeds athlete_profile (current phase + retest date) and a baseline
--     diagnostic (May 17, 2026).
--   • Seeds the diagnosis as `insight` rows (P1–P4) from the Weak Link Map.
--   • Seeds Program 1 with two phases and the five Phase-1 day templates,
--     with load hints set to Phil's ACTUAL current working weights.
--   • Backfills Weeks 1–5: one `workout` per logged session (main lifts +
--     key accessories), the standout diagnostic signals as
--     `session_observation` rows, and the weekly coach notes.
--
-- WHERE THIS LEAVES HIM: end of Week 5 (deload), entering Week 6 (Jun 23–27,
-- retest week). The first session he logs in-app is his real Week 6, and the
-- load prescription starts from his last logged top set per lift.
--
-- IDEMPOTENT: re-running first clears this athlete's program / insights /
-- diagnostics / profile / coach messages / workouts, then re-inserts. The
-- athlete + auth user are never deleted.
--
-- HOW TO RUN
--   Supabase Dashboard → SQL Editor → paste this file → Run.
--   (It runs as the service role there, so RLS does not block the inserts.)
--   The athlete must have signed into the deployed app at least once so an
--   auth.users row exists for the email below; otherwise you'll get a clear
--   error telling you to sign in first. Edit v_email to target another account.
-- =============================================================================

DO $$
DECLARE
  v_email   TEXT := 'phillipchan1@gmail.com';
  v_uid     UUID;
  v_athlete UUID;
  v_program UUID;
  v_phase1  UUID;
  v_phase2  UUID;
  v_r_mon   UUID;   -- 1 · Accessory + Prehab
  v_r_tue   UUID;   -- 2 · Lower A
  v_r_wed   UUID;   -- 3 · Upper A
  v_r_thu   UUID;   -- 4 · Basketball
  v_r_fri   UUID;   -- 5 · Full Body + Conditioning
BEGIN
  -- ---- 0. Resolve the auth user --------------------------------------------
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'No auth user for %. Sign into the deployed app once first, then re-run.',
      v_email;
  END IF;

  -- ---- 1. Upsert athlete, land in the daily loop ----------------------------
  INSERT INTO public.athlete (
    auth_user_id, name, sport, goals, training_age, sessions_per_week,
    onboarding_step, obstacle, arena_type, arena_raw, limiter_choice
  ) VALUES (
    v_uid,
    'Phil',
    'Basketball',
    'Bench 265 → 285+, stable strict OHP 135 → 155+, restore hip internal '
      || 'rotation + lateral quickness for basketball, keep knees pain-free, '
      || 'maintain a 340 high-bar squat / 430 conventional deadlift. Train for '
      || 'performance and longevity, not aesthetics.',
    15,        -- experienced lifter (powerlifting peak ~6 yrs ago)
    5,         -- Mon–Fri
    'complete',
    'My bench is stuck at 265 while I squat 400 and deadlift 480 — and my '
      || 'overhead press / shoulder feels unstable and shaky.',
    'sport',
    'basketball',
    'pressing_stability'
  )
  ON CONFLICT (auth_user_id) DO UPDATE SET
    name              = EXCLUDED.name,
    sport             = EXCLUDED.sport,
    goals             = EXCLUDED.goals,
    training_age      = EXCLUDED.training_age,
    sessions_per_week = EXCLUDED.sessions_per_week,
    onboarding_step   = EXCLUDED.onboarding_step,
    obstacle          = EXCLUDED.obstacle,
    arena_type        = EXCLUDED.arena_type,
    arena_raw         = EXCLUDED.arena_raw,
    limiter_choice    = EXCLUDED.limiter_choice
  RETURNING id INTO v_athlete;

  -- ---- 2. Idempotency: clear prior seeded data for this athlete -------------
  -- Order respects FK RESTRICT (observations → workouts → program cascade).
  DELETE FROM public.session_observation so
   USING public.workout w, public.routine r, public.program p
   WHERE so.workout_id = w.id AND w.routine_id = r.id
     AND r.program_id = p.id AND p.athlete_id = v_athlete;
  DELETE FROM public.workout w
   USING public.routine r, public.program p
   WHERE w.routine_id = r.id AND r.program_id = p.id
     AND p.athlete_id = v_athlete;
  DELETE FROM public.program         WHERE athlete_id = v_athlete; -- cascades phase/routine/weekly_review
  DELETE FROM public.insight         WHERE athlete_id = v_athlete;
  DELETE FROM public.insight_draft   WHERE athlete_id = v_athlete;
  DELETE FROM public.diagnostic      WHERE athlete_id = v_athlete;
  DELETE FROM public.athlete_profile WHERE athlete_id = v_athlete;
  DELETE FROM public.coach_message   WHERE athlete_id = v_athlete;

  -- ---- 3. Athlete profile (signals "zeroed in" complete) -------------------
  INSERT INTO public.athlete_profile (athlete_id, current_phase, retest_date)
  VALUES (v_athlete, 'Stability', DATE '2026-06-28');

  -- ---- 4. Baseline diagnostic (May 17, 2026) -------------------------------
  INSERT INTO public.diagnostic (athlete_id, assessed_at, test_battery, raw_results)
  VALUES (
    v_athlete,
    TIMESTAMPTZ '2026-05-17 00:00:00+00',
    $json${"type":"baseline","source":"Notion: Phil's Health — Athlete Profile"}$json$::jsonb,
    $json${
      "movement": {
        "deep_squat": 2, "hurdle_step": 2, "inline_lunge": 2,
        "shoulder_mobility": 1, "aslr": 2, "trunk_stability": 2, "rotary_stability": 2
      },
      "strength": {
        "bench": 265, "close_grip_bench": 185,
        "squat_highbar": 340, "deadlift_conventional": 430, "strict_ohp": 135
      },
      "subjective": {
        "sleep": 6, "energy": 6, "stress": 5,
        "pain": "Bilateral knees ~3/10 (chronic, mechanical); elbow shake + shoulder instability on press"
      },
      "sport_profile": {
        "sport": "Basketball",
        "goals": "Bench 285, stable OHP 155, hip IR + lateral quickness, pain-free knees",
        "training_age": 15, "sessions_per_week": 5
      },
      "field_metrics": {
        "broad_jump_in": 76,
        "broad_jump_best_in": 79,
        "vertical_in": null,
        "gas_tank_bball": 3,
        "knee_pain": 3,
        "ohp_shaking": true,
        "note": "Baseline reference for the Jun 28 retest. Broad jump first measured May 30 (~6'4\", best ~6'7\") — not captured at the May 17 screen, recorded here as the anchor. Gas tank started low (\"conditioning sucks\") and rose to ~7 (full hour of half-court without gassing) by Week 2."
      }
    }$json$::jsonb
  );

  -- ---- 5. Diagnosis → insights (from the Weak Link Map) ---------------------
  INSERT INTO public.insight
    (athlete_id, claim, category, priority, confidence, status, evidence, source, program_impact)
  VALUES
    (v_athlete,
     'Scapular instability and serratus weakness are the primary limiter on the bench and OHP — force collapses at the midpoint, not off the chest.',
     'Upper Chain', 'P1', 0.80, 'likely',
     $json$["Bench 265 vs squat 400 / deadlift 480 — clear pressing outlier","Elbow shake and a sticking point at the midpoint, not off the chest","Strict OHP unstable at 135","Close-grip bench 185x5 strong but still unstable"]$json$::jsonb,
     'diagnostic',
     'Phase 1 loads the scap system (push-up plus, bottom-up KB press, face pulls, wall slides) before adding pressing load.'),

    (v_athlete,
     'Overhead mobility is restricted — the overhead wall test fails with compensation, driven by lat/pec tightness, limited thoracic extension, and poor scapular upward rotation.',
     'Upper Chain', 'P2', 0.65, 'likely',
     $json$["Overhead wall test: thumbs cannot reach the wall without compensation","Increasing friction approaching 180 degrees overhead","Same scap system that limits the press"]$json$::jsonb,
     'diagnostic',
     'Daily t-spine extension, lat + pec stretch, and wall slides; overhead reach drills.'),

    (v_athlete,
     'Limited hip internal rotation with duck feet routes force through the knees and restricts lateral basketball movement.',
     'Lower Chain', 'P2', 0.70, 'likely',
     $json$["Feet point outward habitually","Lateral cuts feel restricted on court","90/90 and horse squats provide relief","Years of heavy bilateral lifting / external-rotator dominance"]$json$::jsonb,
     'diagnostic',
     '90/90 hip IR holds, lateral band walks, and ambient 90/90 floor sitting.'),

    (v_athlete,
     'An ankle dorsiflexion deficit (discovered May 21) is a root cause of duck-feet compensation and limited squat depth.',
     'Lower Chain', 'P3', 0.60, 'likely',
     $json$["Knee-to-wall range limited","Cannot do an unassisted heels-down deep squat yet (assisted hold is current standard)","Contributes to force routing through the knees"]$json$::jsonb,
     'diagnostic',
     'Daily knee-to-wall ankle drill + ankle CARs / soleus work before hip IR work.'),

    (v_athlete,
     'Bench press asymmetry — the left arm rises before the right — points to a right-side stability deficit or a left-side compensation pattern.',
     'Upper Chain', 'P3', 0.50, 'hypothesis',
     $json$["Observed on bench diagnostic video","Left arm rises before the right","Left grip weaker than right on landmine + DB pressing"]$json$::jsonb,
     'diagnostic',
     'Unilateral pressing (DB bench, single-arm work); film the bench from the front to confirm.'),

    (v_athlete,
     'Accumulated load from years of heavy lifting plus aging tissue is reducing tolerance to longstanding compensation patterns (gradual bilateral knee ache).',
     'Recovery', 'P4', 0.45, 'hypothesis',
     $json$["Gradual knee pain over ~2 years without any load increase","Powerlifting peak ~6 years ago; now in maintenance/rebuild","No locking, swelling, or sharp pain"]$json$::jsonb,
     'diagnostic',
     'Honor deload weeks, daily mobility, and pain-gated squat/lunge rules.');

  -- ---- 6. Program ----------------------------------------------------------
  INSERT INTO public.program (athlete_id, goal, start_date, retest_date, status)
  VALUES (
    v_athlete,
    'Fix the shoulder/scapular system blocking the bench, build the hip mobility '
      || 'and aerobic base limiting basketball, and maintain the squat and '
      || 'deadlift — all in 5 days/week, Mon–Fri. Targets by August: bench '
      || '265 → 285+, strict OHP 135 → 155+ (stable).',
    DATE '2026-05-17', DATE '2026-06-28', 'active'
  )
  RETURNING id INTO v_program;

  -- ---- 7. Phases -----------------------------------------------------------
  -- Phase 1 = Stability Foundation (active). Phase 2 = "Integration" in Notion,
  -- mapped to the schema's 'Strength' phase name (allowed set is
  -- Stability/Strength/Power/Sport).
  INSERT INTO public.phase
    (program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status)
  VALUES (
    v_program, 'Stability', DATE '2026-05-17', DATE '2026-06-28',
    $json$[
      "Monday scap system: push-up plus, wall slides, face pulls, band pull-aparts, bottom-up KB press",
      "Monday knee+hip: terminal knee extension, 90/90 hip IR hold, lateral band walk, Copenhagen plank",
      "Daily 10-min mobility: t-spine extension, lat + pec stretch, wall slides, knee-to-wall ankle drill",
      "Ambient every day: deep squat hold + 90/90 floor sitting",
      "Pelvic floor: 3x10 holds, 2-3x/day"
    ]$json$::jsonb,
    $json$[
      "Gate Jun 28 — pass 4 of 6 to advance to Phase 2",
      "OHP shaking noticeably reduced at 105 vs Week 1 at 95",
      "Overhead wall test: thumbs closer to the wall than Week 1",
      "Bench asymmetry: arms rising at the same time or nearly so",
      "Bench 195 lbs feels RPE 7 or under",
      "Basketball gas tank up at least 1 point from Week 1",
      "BSS at 25 lbs/hand pain-free or below 3/10",
      "Ankle knee-to-wall improved (target 4\"+ each side); hip IR trending toward 35°+"
    ]$json$::jsonb,
    'active'
  )
  RETURNING id INTO v_phase1;

  INSERT INTO public.phase
    (program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status)
  VALUES (
    v_program, 'Strength', DATE '2026-06-29', DATE '2026-08-16',
    $json$[
      "Paused bench @ midpoint 3x5 — 2s hold at the sticking point",
      "Maintain the Phase 1 scap prehab",
      "Strict OHP loaded — earn load, no shake"
    ]$json$::jsonb,
    $json$[
      "Gate Aug 2 — bench 215 paused feels RPE 8 or under; OHP 120 no shake",
      "Broad jump +2 inches from Week 1 baseline",
      "Basketball gas tank up 2+ points from Week 1",
      "Asymmetry eliminated or nearly eliminated on video",
      "PR week (Aug 4-16): bench 285, OHP 155, confirm squat 340 / deadlift 430"
    ]$json$::jsonb,
    'pending'
  )
  RETURNING id INTO v_phase2;

  -- ---- 8. Phase-1 routines (the 5 day templates) ---------------------------
  -- Routines surface in alphabetical order by name and cycle across the week up
  -- to sessions_per_week. Numeric prefixes pin Mon→Fri order. Load hints are set
  -- to Phil's ACTUAL Week-4/5 working weights (where he is now), so the in-app
  -- prescription starts from real numbers.
  INSERT INTO public.routine (program_id, phase_id, name, session_type, intent, exercises) VALUES
  (v_program, v_phase1, '1 · Accessory + Prehab (Mon)', 'mobility',
   'Carries all the non-negotiables: scap system + knee/hip/ankle prehab + mobility. Keeps the rest of the week lean.',
   $json$[
     {"name":"Push-up plus","sets":3,"reps":"10","load":"bodyweight","tracking_type":"bodyweight_reps","cue":"Push the floor away at the top. Serratus, not pecs."},
     {"name":"Wall slides","sets":3,"reps":"10","load":"bodyweight","tracking_type":"bodyweight_reps","cue":"Work at 65-70deg only — stop where the shoulder stays pain-free and the back stays flat. Do NOT force 90deg. Left side is tighter."},
     {"name":"Face pull","sets":3,"reps":"15","load":"light cable/band","tracking_type":"weight_reps","cue":"Pull to nose, elbows high, external rotate at the end."},
     {"name":"Band pull-apart","sets":3,"reps":"15","load":"band","tracking_type":"bodyweight_reps","cue":"Controlled, chest height. Not a speed drill."},
     {"name":"Bottom-up KB press","sets":3,"reps":"5/side","load":"~30 lbs (or 20 lb x8)","tracking_type":"weight_reps","cue":"Phil's favorite — the shoulder fights instability here. Shaking = serratus firing = correct."},
     {"name":"Terminal knee extension","sets":3,"reps":"15/side","load":"band","tracking_type":"bodyweight_reps","cue":"VMO squeeze at the top. These make the knees feel better. Pain-free only."},
     {"name":"90/90 hip IR hold","sets":2,"reps":"60s/side","load":"bodyweight","tracking_type":"time","cue":"Lean into the front shin. Primary duck-feet fix."},
     {"name":"Lateral band walk","sets":3,"reps":"15/side","load":"band","tracking_type":"bodyweight_reps","cue":"Stay low, toes straight (harder = the point). Don't let the band pull the knees in."},
     {"name":"Copenhagen plank","sets":3,"reps":"20s/side","load":"bodyweight","tracking_type":"time","cue":"Top foot on bench, bottom leg free. Right side has been the weaker one."},
     {"name":"Thoracic extension (foam roller)","sets":1,"reps":"90s","load":"bodyweight","tracking_type":"time","cue":"Segment by segment up the spine."},
     {"name":"Knee-to-wall ankle drill","sets":3,"reps":"10/side","load":"bodyweight","tracking_type":"bodyweight_reps","cue":"Foot 3-4\" from wall, knee over pinky toe, heel flat. This is also the Jun 28 retest marker (4\"+)."}
   ]$json$::jsonb),

  (v_program, v_phase1, '2 · Lower A (Tue)', 'strength',
   'AM skills warm-up + lunch lift. Squat focus, no belt — full depth, controlled, not max effort.',
   $json$[
     {"name":"Defensive lateral slide (AM skills)","sets":4,"reps":"30s","load":"bodyweight","tracking_type":"time","cue":"Stay low, don't cross feet. Lateral quickness."},
     {"name":"First-step acceleration (AM skills)","sets":6,"reps":"1/dir","load":"bodyweight","tracking_type":"distance","cue":"Explode one step, stop. Hip loading."},
     {"name":"Squat (no belt)","sets":3,"reps":"5","load":"~275 lbs","tracking_type":"weight_reps","cue":"Coach moved this to LOW BAR through the Jun 28 retest (left-shoulder impingement on high bar). You've been testing high bar at 275 — go by shoulder feel. Full depth, controlled."},
     {"name":"Bulgarian split squat","sets":3,"reps":"8/side","load":"20 lbs/hand","tracking_type":"weight_reps","cue":"The shaking is the point — quad-stabilizer isolation. Keep it pain-free."},
     {"name":"Step-up","sets":3,"reps":"10/side","load":"~17.5 lbs/hand","tracking_type":"weight_reps","cue":"Most knee-provocative accessory (in-joint). Drive through the heel; lower the box if it climbs above 4/10."},
     {"name":"Glute bridge","sets":3,"reps":"12","load":"25 lb plate or band","tracking_type":"weight_reps","cue":"Hip extension power for jumping and sprinting."}
   ]$json$::jsonb),

  (v_program, v_phase1, '3 · Upper A (Wed)', 'strength',
   'Bench rebuild day. Paused bench + unilateral DB work to attack instability and asymmetry. Film from the front.',
   $json$[
     {"name":"Bench press","sets":3,"reps":"5","load":"~195 lbs","tracking_type":"weight_reps","cue":"1s pause at chest. Scap retracted + depressed throughout. Elbows still a touch shaky at 195 — watch the left arm; film from the front."},
     {"name":"DB bench (unilateral)","sets":3,"reps":"8/side","load":"~65 lbs/side","tracking_type":"weight_reps","cue":"Left and right should feel identical. Left grip has felt weaker — even it out."},
     {"name":"Chest-supported DB row","sets":3,"reps":"10","load":"~50 lbs/side","tracking_type":"weight_reps","cue":"Row to the hip. Upper back = bench stability."},
     {"name":"Landmine press","sets":3,"reps":"8/side","load":"35 lbs","tracking_type":"weight_reps","cue":"Arc motion. Left side has felt weaker — earn symmetry."}
   ]$json$::jsonb),

  (v_program, v_phase1, '4 · Basketball (Thu)', 'conditioning',
   'This IS conditioning, not recreation. Warm up the hips, then log the gas tank.',
   $json$[
     {"name":"90/90 hip IR (pre-game)","sets":1,"reps":"60s/side","load":"bodyweight","tracking_type":"time","cue":"Open the hips before going live."},
     {"name":"Leg swings (front/back + lateral)","sets":1,"reps":"10/dir","load":"bodyweight","tracking_type":"bodyweight_reps","cue":"Dynamic warm-up."},
     {"name":"Basketball (live play)","sets":1,"reps":"60min","load":"sport","tracking_type":"time","cue":"Log: gas tank at half (1-10), knee pain (1-10), stayed in front Y/N. Conditioning has been the breakthrough — keep playing."}
   ]$json$::jsonb),

  (v_program, v_phase1, '5 · Full Body + Conditioning (Fri)', 'strength',
   'Biggest session, freshest day. Maintain the deadlift, groove the OHP, power work, sprint finisher.',
   $json$[
     {"name":"Deadlift (conventional, no belt)","sets":2,"reps":"3","load":"~345 lbs","tracking_type":"weight_reps","cue":"Conventional, no belt. Strength is easy — grip is the limiter (no mixed grip). Consider straps or keep building grip."},
     {"name":"Strict OHP","sets":3,"reps":"5","load":"100 lbs","tracking_type":"weight_reps","cue":"On the edge of shaking at 100 — perfect build weight. Film it, look for the shake reducing."},
     {"name":"Chest-supported DB row","sets":3,"reps":"10","load":"~50 lbs/side","tracking_type":"weight_reps","cue":"Second row session = faster scap rebuild."},
     {"name":"Box jump","sets":3,"reps":"5","load":"max intent","tracking_type":"bodyweight_reps","cue":"Step down to land in Phase 1. Full reset between reps."},
     {"name":"Broad jump","sets":3,"reps":"3","load":"max intent","tracking_type":"distance","cue":"Measure best of 3 (last logged ~6'4\"+). Weekly explosiveness tracker."},
     {"name":"Sprint (court length)","sets":6,"reps":"1","load":"max intent","tracking_type":"distance","cue":"Walk back to recover. Log gas tank after rep 6."}
   ]$json$::jsonb);

  -- Capture routine ids for the history backfill.
  SELECT id INTO v_r_mon FROM public.routine WHERE program_id = v_program AND name LIKE '1 %';
  SELECT id INTO v_r_tue FROM public.routine WHERE program_id = v_program AND name LIKE '2 %';
  SELECT id INTO v_r_wed FROM public.routine WHERE program_id = v_program AND name LIKE '3 %';
  SELECT id INTO v_r_thu FROM public.routine WHERE program_id = v_program AND name LIKE '4 %';
  SELECT id INTO v_r_fri FROM public.routine WHERE program_id = v_program AND name LIKE '5 %';

  -- ---- 9. Backfill Weeks 1–5 (actuals from the Notion session logs) --------
  -- actual_weights is keyed by exercise INDEX within the routine above.
  -- Weights/reps are extracted from Phil's freeform logs; blank fields in Notion
  -- are left out. Note Phil routinely pushed past the prescribed load.

  -- WEEK 1 (May 19–23) -------------------------------------------------------
  INSERT INTO public.workout (routine_id, performed_at, actual_weights, rpe, duration_mins) VALUES
  (v_r_mon, TIMESTAMPTZ '2026-05-19 12:00:00+00',
   $json${"4":[{"set":1,"weight":16,"reps":10,"done":true},{"set":2,"weight":20,"reps":5,"done":true},{"set":3,"weight":20,"reps":5,"done":true}]}$json$::jsonb, NULL, 50),
  (v_r_tue, TIMESTAMPTZ '2026-05-20 12:00:00+00',
   $json${"2":[{"set":1,"weight":255,"reps":5,"rpe":6,"done":true},{"set":2,"weight":255,"reps":5,"rpe":6,"done":true},{"set":3,"weight":255,"reps":5,"rpe":6,"done":true}],"3":[{"set":1,"weight":null,"reps":8,"done":true},{"set":2,"weight":null,"reps":8,"done":true},{"set":3,"weight":null,"reps":8,"done":true}],"4":[{"set":1,"weight":15,"reps":10,"done":true},{"set":2,"weight":15,"reps":10,"done":true},{"set":3,"weight":15,"reps":10,"done":true}]}$json$::jsonb, 6, 45),
  (v_r_wed, TIMESTAMPTZ '2026-05-21 12:00:00+00',
   $json${"0":[{"set":1,"weight":185,"reps":5,"done":true},{"set":2,"weight":185,"reps":5,"done":true},{"set":3,"weight":185,"reps":5,"done":true}],"1":[{"set":1,"weight":52.5,"reps":8,"done":true},{"set":2,"weight":52.5,"reps":8,"done":true},{"set":3,"weight":52.5,"reps":8,"done":true}],"2":[{"set":1,"weight":40,"reps":10,"done":true},{"set":2,"weight":40,"reps":10,"done":true},{"set":3,"weight":40,"reps":10,"done":true}],"3":[{"set":1,"weight":25,"reps":8,"done":true}]}$json$::jsonb, NULL, 45),
  (v_r_thu, TIMESTAMPTZ '2026-05-22 18:00:00+00', '{}'::jsonb, NULL, 60),
  (v_r_fri, TIMESTAMPTZ '2026-05-23 12:00:00+00',
   $json${"0":[{"set":1,"weight":325,"reps":3,"rpe":6,"done":true},{"set":2,"weight":325,"reps":3,"rpe":6,"done":true}],"1":[{"set":1,"weight":95,"reps":5,"done":true},{"set":2,"weight":95,"reps":5,"done":true},{"set":3,"weight":95,"reps":5,"done":true}],"2":[{"set":1,"weight":50,"reps":8,"done":true}]}$json$::jsonb, 6, 50);

  -- WEEK 2 (May 26–30) -------------------------------------------------------
  INSERT INTO public.workout (routine_id, performed_at, actual_weights, rpe, duration_mins) VALUES
  (v_r_mon, TIMESTAMPTZ '2026-05-26 12:00:00+00',
   $json${"4":[{"set":1,"weight":25,"reps":5,"done":true},{"set":2,"weight":25,"reps":5,"done":true},{"set":3,"weight":25,"reps":5,"done":true}]}$json$::jsonb, NULL, 50),
  (v_r_tue, TIMESTAMPTZ '2026-05-27 12:00:00+00',
   $json${"2":[{"set":1,"weight":260,"reps":5,"rpe":6,"done":true},{"set":2,"weight":260,"reps":5,"rpe":6,"done":true},{"set":3,"weight":260,"reps":5,"rpe":6,"done":true}],"3":[{"set":1,"weight":null,"reps":8,"rpe":5,"done":true},{"set":2,"weight":null,"reps":8,"done":true},{"set":3,"weight":null,"reps":8,"done":true}],"4":[{"set":1,"weight":20,"reps":10,"done":true},{"set":2,"weight":20,"reps":10,"done":true},{"set":3,"weight":20,"reps":10,"done":true}]}$json$::jsonb, 6, 45),
  (v_r_wed, TIMESTAMPTZ '2026-05-28 12:00:00+00',
   $json${"0":[{"set":1,"weight":185,"reps":5,"done":true},{"set":2,"weight":185,"reps":5,"done":true},{"set":3,"weight":185,"reps":5,"done":true}],"1":[{"set":1,"weight":55,"reps":8,"done":true},{"set":2,"weight":55,"reps":8,"done":true},{"set":3,"weight":55,"reps":8,"done":true}],"2":[{"set":1,"weight":45,"reps":10,"done":true},{"set":2,"weight":45,"reps":10,"done":true},{"set":3,"weight":45,"reps":10,"done":true}],"3":[{"set":1,"weight":30,"reps":8,"done":true},{"set":2,"weight":30,"reps":8,"done":true},{"set":3,"weight":30,"reps":8,"done":true}]}$json$::jsonb, NULL, 45),
  (v_r_thu, TIMESTAMPTZ '2026-05-29 18:00:00+00', '{}'::jsonb, NULL, 60),
  (v_r_fri, TIMESTAMPTZ '2026-05-30 12:00:00+00',
   $json${"0":[{"set":1,"weight":330,"reps":3,"done":true},{"set":2,"weight":330,"reps":3,"done":true}],"1":[{"set":1,"weight":95,"reps":5,"done":true},{"set":2,"weight":95,"reps":5,"done":true},{"set":3,"weight":95,"reps":5,"rpe":7,"done":true}],"2":[{"set":1,"weight":50,"reps":10,"done":true}]}$json$::jsonb, NULL, 50);

  -- WEEK 3 (Jun 2–6) — squat moved toward low bar; ankle rolled on court ------
  INSERT INTO public.workout (routine_id, performed_at, actual_weights, rpe, duration_mins) VALUES
  (v_r_mon, TIMESTAMPTZ '2026-06-02 12:00:00+00',
   $json${"4":[{"set":1,"weight":30,"reps":5,"done":true},{"set":2,"weight":30,"reps":5,"done":true},{"set":3,"weight":30,"reps":5,"done":true}]}$json$::jsonb, NULL, 50),
  (v_r_tue, TIMESTAMPTZ '2026-06-03 12:00:00+00',
   $json${"2":[{"set":1,"weight":275,"reps":5,"done":true},{"set":2,"weight":275,"reps":5,"done":true},{"set":3,"weight":275,"reps":5,"done":true}],"3":[{"set":1,"weight":10,"reps":8,"done":true},{"set":2,"weight":10,"reps":8,"done":true},{"set":3,"weight":10,"reps":8,"done":true}],"4":[{"set":1,"weight":25,"reps":10,"done":true},{"set":2,"weight":25,"reps":10,"done":true},{"set":3,"weight":25,"reps":10,"done":true}],"5":[{"set":1,"weight":25,"reps":12,"done":true},{"set":2,"weight":25,"reps":12,"done":true},{"set":3,"weight":25,"reps":12,"done":true}]}$json$::jsonb, NULL, 45),
  (v_r_wed, TIMESTAMPTZ '2026-06-04 12:00:00+00',
   $json${"0":[{"set":1,"weight":185,"reps":5,"done":true},{"set":2,"weight":185,"reps":5,"done":true},{"set":3,"weight":185,"reps":5,"done":true}],"1":[{"set":1,"weight":60,"reps":8,"done":true},{"set":2,"weight":60,"reps":8,"done":true},{"set":3,"weight":60,"reps":8,"done":true}],"2":[{"set":1,"weight":50,"reps":10,"done":true},{"set":2,"weight":50,"reps":10,"done":true},{"set":3,"weight":50,"reps":10,"done":true}],"3":[{"set":1,"weight":30,"reps":8,"done":true},{"set":2,"weight":30,"reps":8,"done":true},{"set":3,"weight":30,"reps":8,"done":true}]}$json$::jsonb, NULL, 45),
  (v_r_fri, TIMESTAMPTZ '2026-06-06 12:00:00+00',
   $json${"0":[{"set":1,"weight":335,"reps":3,"done":true},{"set":2,"weight":335,"reps":3,"done":true}],"1":[{"set":1,"weight":100,"reps":5,"done":true},{"set":2,"weight":100,"reps":5,"done":true},{"set":3,"weight":100,"reps":5,"done":true}],"2":[{"set":1,"weight":50,"reps":10,"done":true}]}$json$::jsonb, NULL, 50);

  -- WEEK 4 (Jun 9–13) --------------------------------------------------------
  INSERT INTO public.workout (routine_id, performed_at, actual_weights, rpe, duration_mins) VALUES
  (v_r_mon, TIMESTAMPTZ '2026-06-09 12:00:00+00',
   $json${"4":[{"set":1,"weight":20,"reps":8,"done":true},{"set":2,"weight":20,"reps":8,"done":true},{"set":3,"weight":20,"reps":8,"done":true}]}$json$::jsonb, NULL, 50),
  (v_r_tue, TIMESTAMPTZ '2026-06-10 12:00:00+00',
   $json${"2":[{"set":1,"weight":275,"reps":5,"done":true},{"set":2,"weight":275,"reps":5,"done":true},{"set":3,"weight":275,"reps":5,"done":true}],"3":[{"set":1,"weight":20,"reps":8,"done":true},{"set":2,"weight":20,"reps":8,"done":true},{"set":3,"weight":20,"reps":8,"done":true}],"4":[{"set":1,"weight":17.5,"reps":10,"done":true},{"set":2,"weight":17.5,"reps":10,"done":true},{"set":3,"weight":17.5,"reps":10,"done":true}],"5":[{"set":1,"weight":null,"reps":12,"done":true},{"set":2,"weight":null,"reps":12,"done":true},{"set":3,"weight":null,"reps":12,"done":true}]}$json$::jsonb, NULL, 45),
  (v_r_wed, TIMESTAMPTZ '2026-06-11 12:00:00+00',
   $json${"0":[{"set":1,"weight":195,"reps":5,"done":true},{"set":2,"weight":195,"reps":5,"done":true},{"set":3,"weight":195,"reps":5,"done":true}],"1":[{"set":1,"weight":65,"reps":8,"done":true},{"set":2,"weight":65,"reps":8,"done":true},{"set":3,"weight":65,"reps":8,"done":true}],"2":[{"set":1,"weight":45,"reps":10,"done":true},{"set":2,"weight":45,"reps":10,"done":true},{"set":3,"weight":45,"reps":10,"done":true}],"3":[{"set":1,"weight":35,"reps":8,"done":true},{"set":2,"weight":35,"reps":8,"done":true},{"set":3,"weight":35,"reps":8,"done":true}]}$json$::jsonb, NULL, 45),
  (v_r_fri, TIMESTAMPTZ '2026-06-13 12:00:00+00',
   $json${"0":[{"set":1,"weight":345,"reps":3,"done":true},{"set":2,"weight":345,"reps":3,"done":true}],"1":[{"set":1,"weight":100,"reps":5,"done":true},{"set":2,"weight":100,"reps":5,"done":true},{"set":3,"weight":100,"reps":5,"done":true}]}$json$::jsonb, NULL, 50);

  -- WEEK 5 (Jun 16–20) — DELOAD (Phil ran it heavier than prescribed) --------
  INSERT INTO public.workout (routine_id, performed_at, actual_weights, rpe, duration_mins) VALUES
  (v_r_mon, TIMESTAMPTZ '2026-06-16 12:00:00+00', '{}'::jsonb, NULL, 45),
  (v_r_tue, TIMESTAMPTZ '2026-06-17 12:00:00+00',
   $json${"2":[{"set":1,"weight":275,"reps":3,"done":true},{"set":2,"weight":275,"reps":3,"done":true}]}$json$::jsonb, NULL, 40),
  (v_r_wed, TIMESTAMPTZ '2026-06-18 12:00:00+00',
   $json${"0":[{"set":1,"weight":185,"reps":3,"done":true},{"set":2,"weight":185,"reps":3,"done":true}]}$json$::jsonb, NULL, 40);

  -- ---- 10. Standout diagnostic signals → session_observation ---------------
  -- Attached to the workout they came from (located by routine + date), so no id
  -- juggling. These are the moments that move the read.
  INSERT INTO public.session_observation (workout_id, category, signal, severity)
  SELECT w.id, 'Upper Chain',
         'Wall slides: bilateral scapular / posterior-capsule tightness — cannot reach 90deg external rotation without clamping. Left worse than right. Confirms the P1 scap-instability read.',
         3
  FROM public.workout w WHERE w.routine_id = v_r_mon AND w.performed_at = TIMESTAMPTZ '2026-05-19 12:00:00+00';

  INSERT INTO public.session_observation (workout_id, category, signal, severity)
  SELECT w.id, 'Upper Chain',
         'Left-shoulder anterior impingement (front + deep) during high-bar squat — same scapular instability as the wall-slide and bench findings. Coach switched the squat to low bar through the Jun 28 retest.',
         3
  FROM public.workout w WHERE w.routine_id = v_r_tue AND w.performed_at = TIMESTAMPTZ '2026-06-03 12:00:00+00';

  INSERT INTO public.session_observation (workout_id, category, signal, severity)
  SELECT w.id, 'Upper Chain',
         'Left grip / left arm weaker than right on landmine + DB pressing — supports the bench-asymmetry hypothesis.',
         2
  FROM public.workout w WHERE w.routine_id = v_r_wed AND w.performed_at = TIMESTAMPTZ '2026-05-28 12:00:00+00';

  INSERT INTO public.session_observation (workout_id, category, signal, severity)
  SELECT w.id, 'Recovery',
         'Conditioning breakthrough: full hour of half-court without gassing — first time. HIIT finishers appear to be working.',
         1
  FROM public.workout w WHERE w.routine_id = v_r_thu AND w.performed_at = TIMESTAMPTZ '2026-05-29 18:00:00+00';

  INSERT INTO public.session_observation (workout_id, category, signal, severity)
  SELECT w.id, 'Lower Chain',
         'Step-ups are the most knee-provocative accessory (in-joint, ~3/10). Reduced to 17.5 lb/hand.',
         2
  FROM public.workout w WHERE w.routine_id = v_r_tue AND w.performed_at = TIMESTAMPTZ '2026-06-10 12:00:00+00';

  INSERT INTO public.session_observation (workout_id, category, signal, severity)
  SELECT w.id, 'Lower Chain',
         'Rolled ankle playing basketball the prior week; skipped box/broad jumps — ankle still tender. Watch the ankle-dorsiflexion / duck-feet chain.',
         3
  FROM public.workout w WHERE w.routine_id = v_r_fri AND w.performed_at = TIMESTAMPTZ '2026-06-06 12:00:00+00';

  -- ---- 11. Coach notes (mirror Notion "Coach Notes") -----------------------
  INSERT INTO public.coach_message (athlete_id, role, kind, body, created_at) VALUES
  (v_athlete, 'coach', 'note',
   'Program design complete. Phase 1 (Stability Foundation) begins. Diagnosis: '
     || 'scapular instability + serratus weakness is the primary bench/OHP '
     || 'limiter; hip IR + ankle mobility limit basketball. Fix the root before '
     || 'chasing load.',
   TIMESTAMPTZ '2026-05-17 00:00:00+00'),
  (v_athlete, 'coach', 'note',
   'Recalibrated squat and deadlift baselines to high-bar / conventional, no '
     || 'equipment (squat 1RM est. 340, deadlift est. 430). Bench and OHP '
     || 'unchanged. Equipment banned for all Phase 1 working sets.',
   TIMESTAMPTZ '2026-05-19 00:00:00+00'),
  (v_athlete, 'coach', 'weekly_review',
   'Week 1 grade A. All prescribed lifting completed. Wall-slide clamping, '
     || 'face-pull fatigue, and band pull-apart burn all converge — the '
     || 'posterior shoulder / serratus are genuinely undertrained; the program '
     || 'is finding exactly what it was designed to find. Knee 0-3/10. Energy '
     || 'high (Phase 1 is sub-maximal by design). Week 2: reduce wall slides to '
     || '65-70deg, load BSS + glute bridge, hold bench at 185 and video it.',
   TIMESTAMPTZ '2026-05-25 00:00:00+00'),
  (v_athlete, 'coach', 'weekly_review',
   'Week 2 — conditioning breakthrough. Full hour of half-court without '
     || 'gassing; HIIT finishers working. BSS and glute bridge finally loaded. '
     || 'Left grip/arm weaker than right on pressing — asymmetry noted. Hold '
     || 'bench + OHP; bump deadlift to 330.',
   TIMESTAMPTZ '2026-06-01 00:00:00+00'),
  (v_athlete, 'coach', 'weekly_review',
   'Week 3 protocol changes. (1) Squat → LOW BAR until the Jun 28 retest: left '
     || 'shoulder produced anterior impingement under high bar — same scapular '
     || 'instability as the wall slide and bench asymmetry. (2) Ankle '
     || 'dorsiflexion deficit confirmed as upstream of duck feet + knee cave — '
     || 'added knee-to-wall + soleus/gastroc work to Monday. KB press shaking = '
     || 'serratus firing = correct adaptation. Wall slides open first, then '
     || 'overhead, then high-bar comfort returns last.',
   TIMESTAMPTZ '2026-06-08 00:00:00+00');

  RAISE NOTICE 'Imported Phil''s Health: athlete=%, program=%, 5 weeks of history backfilled.',
    v_athlete, v_program;
END $$;
