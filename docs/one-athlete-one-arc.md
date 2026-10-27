# One athlete, one arc

A buildable plan for taking Zeroed from a strength coach to one S&C coach
across every modality. Written 27 Oct 2026 against `origin/master` @ `024a41d`
(your local `master` is 6 commits behind it).

**Labels used throughout**

| Label | Means |
|---|---|
| **[code]** | Checked in this repo today, with the file |
| **[scan]** | From your Oct 2026 desk scan; I haven't re-verified it |
| **[evidence]** | A published source I'm confident exists. Check the exact finding before it goes into product copy |
| **[convention]** | Common coaching practice with weak or no direct evidence. Fine as a default; never state it as a claim |
| **[assumption]** | My bet. The test that would break it is named |
| **[unknown]** | I don't know. The cheapest way to find out is given |
| **[estimate]** | My effort guess for one developer who knows this codebase |

---

## 0. What the code says (read this first)

Six things in the repo change the plan.

1. **`workout.rpe` is not session-RPE.** It is the mean of the session's set
   RPEs (`src/screens/loop/WorkoutScreen.tsx:2270`). An interval block also
   stamps its one RPE onto every round (`:2154`). Foster's session-RPE is one
   0–10 (CR-10) rating of the whole session, taken about 30 minutes after it.
   Set RPE measures how close one set came to failure (reps in reserve). So
   "sRPE load is computable today" holds only as a proxy whose bias is
   **[unknown]**. Fix: one tap at the end of every session, stored as
   `session_rpe`. Log both during dogfood to see how far apart they are.
2. **You're mid-cutover.** Supabase and Vercel are live. Cloudflare Worker +
   Neon + Better Auth is staged (`docs/cloudflare-cutover.md`). Every new
   column today has to land in three places: `supabase/migrations/`,
   `worker/schema/app.sql` and the `/api/data` column registry (commit
   `6d9df7a` did exactly this for the lift model). So the MVP touches the
   schema once, additively, and keeps everything else in JSONB.
3. **A flag pattern exists.** It lives in `src/lib/flags.ts`, with build-time
   `VITE_*` env (`onboarding_agent_v1`, `rpe_half_steps`). Build-time is fine
   on web but slow on iOS: rolling back means a new build through review. §7
   adds a runtime kill switch.
4. **Every session needs a routine, and the blocks are fixed.**
   `workout.routine_id NOT NULL … ON DELETE RESTRICT`
   (`worker/schema/app.sql:217`), and
   `phase.name CHECK IN ('Stability','Strength','Power','Sport')` (`:181`).
   §2.5 works with both instead of migrating them now.
5. **Week boundaries are Pacific time.** `localDay()` defaults to
   `America/Los_Angeles` (`src/engine/liftModel.ts:221`). Several callers don't
   pass a zone: `src/engine/index.ts:2481, 2531, 2677` and
   `mcp/src/store.ts:382`. For a UK athlete, Monday 00:00–08:00 still counts as
   last week. Spacing rules like "≥ 3 h apart" or "24 h before a match" need the
   athlete's real zone. Fix this before any scheduling rule ships.
6. **`apply_program_edits` takes the edits again**, not a preview id
   (`worker/src/tools.ts:166`). So the model can apply something different from
   what it previewed. §6 has a cheap fix.

Also true, and useful:

- The in-app agent runs on OpenAI (`gpt-5.4-nano`, with heavy tasks on
  `gpt-5.4`) through the `agent` function. That isn't a ChatGPT dependency, but
  OpenAI is a third-party AI processor. See §9 for Apple's disclosure rule.
- A closed vocabulary already exists:
  `TRACKING_TYPES = weight_reps | bodyweight_reps | time | distance`
  (`src/types/database.ts`). The primitives below extend it; they don't replace it.
- `src/engine/safety.ts` uses a regex to strip sprints, plyos and box jumps from
  provisional sessions. Every run and sport primitive must go through the same
  validator, with its own ceiling.
- The lift model covers four main lifts (`MainLiftId`). Accessories use
  double progression.
- `src/engine/starterPacks.ts` already says a pack is "parameters, not a
  content library". That is exactly the shape §5.5 needs.
- `routine.session_type` is free text with no CHECK, so widening it costs
  nothing.
- MCP tool definitions live in at least two places:
  `worker/src/tools.ts` and `supabase/functions/_shared/zeroedTools.ts`, plus
  the local server in `mcp/src/server.ts`.
- #31 is the issue; it shipped as PR #33.

---

## 1. Modality primitive taxonomy

### 1.1 The refinement: efforts and structures are different things

Your seven primitives mix two kinds of thing. "Timed work / intervals" isn't
the same kind of thing as "load × reps". A Tabata is a **timeline** wrapped
around an **effort** (bike sprints). So is an EMOM of power cleans, a swim set
on a send-off, and a CrossFit AMRAP. If intervals is a primitive, every metcon
becomes a special case.

So use two layers:

- **Efforts**: what one bout is, how it's dosed and how it's scored. These are
  `lift`, `work`, `distance`, `hold`, `skill`, `flow` and `external`.
- **Structures**: how bouts are arranged in time. These are `straight`,
  `intervals`, `clock`, `amrap`, `for_time` and `continuous`.

A session is a list of blocks, and each block is one structure × one or more
efforts. `engine/intervals.ts` already *is* the `intervals` and `clock`
structures, and the set grid is `straight`.

Changes from your draft:

- **Timed work / intervals** splits into `work` (an effort, like 20 s on a
  bike) and `intervals` / `clock` (structures).
- **Distance / pace** stays an effort, but its target can be a pace, a time or
  an RPE. That way a run works without GPS.
- **Mobility / breath** stays one effort (`flow`) with a `mode`. Its job in the
  arc is recovery and positions, not overload.
- **Skill / technique** stays, but its ladders are code. The agent never
  invents a level, just as it can't invent a `TRACKING_TYPE`.
- **External sport sessions** stays, and it's the one that makes "any sport"
  possible. You can't model every sport, but you can model minutes × effort × a
  few exposure tags.

### 1.2 Types

```ts
// EFFORTS: what one bout is. Each stores through an existing tracking_type.
type Effort =
  | { kind: 'lift';     movement: string; reps: number | [number, number]; load: LoadTarget }   // weight_reps | bodyweight_reps
  | { kind: 'work';     movement: string; secs: number; intensity: Intensity }                  // time
  | { kind: 'distance'; movement: string; meters: number; target: PaceTarget }                  // distance
  | { kind: 'hold';     movement: string; secs: number; load?: LoadTarget; leverage?: number }  // time
  | { kind: 'skill';    movement: string; ladder: SkillLadderId; level: number; attempts: number; bar: 'clean' | 'any' }
  | { kind: 'flow';     movement: string; mode: 'mobility' | 'breath'; secs?: number; breaths?: number; pattern?: BreathPatternId }
  | { kind: 'external'; activity: string; minutes: number; tags: ExposureTags }

// STRUCTURES: how bouts are laid out in time.
type Structure =
  | { kind: 'straight';   sets: number; restSecs: number }
  | { kind: 'intervals';  plan: IntervalPlan }                  // exists: work/rest/rounds/sets/setRest/rows
  | { kind: 'clock';      everySecs: number; rounds: number }   // EMOM, E2MOM, swim and run send-offs
  | { kind: 'amrap';      capSecs: number }                     // score = rounds + reps
  | { kind: 'for_time';   capSecs: number }                     // score = time
  | { kind: 'continuous'; segments: Array<{ secs?: number; meters?: number; target: PaceTarget }> }

interface Block { structure: Structure; efforts: Effort[]; note?: string }

type LoadTarget =
  | { by: 'rpe'; rpe: number }                               // RIR-anchored; the engine turns it into kg
  | { by: 'tm_pct'; pct: number }                            // engine-owned
  | { by: 'bodyweight'; added?: number }
  | { by: 'label'; label: 'light' | 'moderate' | 'heavy' }   // today's ExerciseTemplate.load

type Intensity =
  | { by: 'cr10'; target: number }                           // effort 0–10
  | { by: 'watts' | 'cals_per_min'; target: number }
  | { by: 'zone'; zone: 1 | 2 | 3 | 4 | 5 }                  // talk-test anchored until there's HR

type PaceTarget =
  | { by: 'pace'; secPerKm: number; tolSecs: number }
  | { by: 'time'; secs: number }
  | { by: 'cr10'; target: number }
  | { by: 'zone'; zone: 1 | 2 | 3 | 4 | 5 }

interface ExposureTags {
  impact?: 'none' | 'low' | 'high'   // running, jumping, landing
  sprint?: 'none' | 'some' | 'lots'
  contact?: boolean                  // tackling, grappling
  overhead?: boolean                 // throwing, swimming, climbing
  grip?: boolean                     // BJJ, climbing
}
```

Results:

```ts
type EffortResult =
  | { kind: 'lift';     weight: number | null; reps: number; rpe: number | null; missedReps?: number }  // = SetLog today
  | { kind: 'work';     secs: number; output?: number; rpe: number | null }
  | { kind: 'distance'; meters: number; secs: number; rpe: number | null }
  | { kind: 'hold';     secs: number; rpe: number | null; formBroke?: boolean }
  | { kind: 'skill';    attempts: number; clean: number }
  | { kind: 'flow';     done: boolean; ease?: 'easier' | 'same' | 'harder' }
  | { kind: 'external'; minutes: number; tags: ExposureTags }

interface SessionResult {
  minutes: number
  sessionRpe: number                 // CR-10: the one tap, for every modality
  blocks: Array<{ score?: { rounds?: number; reps?: number; secs?: number }; efforts: EffortResult[] }>
}
```

### 1.3 Each effort: parameters, result, progression, load

Progression rules belong to the engine. The agent picks intents; it never
picks the next number.

| Effort | Parameters | Logged result | Progression rule | Rolls into load as |
|---|---|---|---|---|
| **lift** | movement, reps, load target (RPE, %TM, bodyweight) | weight, reps, RPE, missed reps | Main lifts: the existing working max → TM → weekly push / hold / drop **[code]**. Accessories: double progression inside the rep range, then a load step **[convention]** | Session sRPE-min. Tissue: hard sets (RPE ≥ 7) by pattern feed spine / lower / upper |
| **work** | movement, seconds, intensity | seconds done, erg output, RPE | A density ladder, one variable at a time: rounds → work seconds → shorter rest → intensity. Step up when every round is done at or under the target RPE with no Tweak or Pain. Hold after a miss. Step down after two holds **[convention]** | Session sRPE-min. Tissue from the movement: run-based work adds lower impact; a bike adds none |
| **distance** | movement, metres, a pace / time / RPE target | metres, seconds, RPE | Keep a best-effort table per distance; estimate equivalents with Riegel's formula **[evidence: Riegel 1981]**. Grow the long effort by at most one step a week; progress quality sessions by pace at the same RPE **[convention]**. The "10% rule" has weak support: an RCT in novice runners found no injury difference **[evidence: Buist et al. 2008, verify]** | Session sRPE-min. Lower impact = run km. Swim, row and bike add 0 impact |
| **hold** | movement, target seconds, load or leverage | seconds held, RPE, whether form broke | Add time up to a cap (60 s, matching `MAX_TIME_HOLD` in `safety.ts`), then step leverage or load and reset the time **[convention]** | Session sRPE-min. Tissue by pattern: spine for loaded carries, upper for hangs |
| **skill** | ladder id, level, attempts, quality bar | attempts, clean reps | Level up after ≥ 80% clean across 2 sessions. Level down after Pain or Tweak **[convention; the 80% is a guess]**. Ladders are code, a closed set | Session sRPE-min (usually low). Tissue tags come from the ladder (double-unders add impact) |
| **flow** | mobility or breath, seconds or breaths, pattern | done, ease vs last time | No overload. Progress means showing up, plus the ease trend. Breath patterns come from a fixed list | Logged, but counts as recovery: its sRPE-min share is capped and it has no tissue cost |
| **external** | activity, minutes, exposure tags | minutes, session RPE, tags | Not Zeroed's to progress; the sport's coach owns it. Zeroed budgets around it | Session sRPE-min. Tags feed tissue: sprint / impact → lower; contact / grip / overhead → upper; contact → spine |

One caveat on load. Session-RPE is measured per session, not per effort
**[evidence: Foster et al. 2001; for resistance sessions, Day et al. 2004 and
Sweet et al. 2004]**. Splitting a session's sRPE-min across its efforts is an
assumption, so don't do it in the MVP. Tissue budgets can be per effort,
because they come from dose rather than from a rating.

### 1.4 Real sessions, composed

**5×5 back squat**

```ts
{ structure: { kind: 'straight', sets: 5, restSecs: 180 },
  efforts: [{ kind: 'lift', movement: 'Back Squat', reps: 5, load: { by: 'rpe', rpe: 7.5 } }] }
// The engine turns RPE 7.5 × 5 into kg from the working max (loadForReps). Today: reps "5", sets 5.
```

**Tabata on a bike**

```ts
{ structure: { kind: 'intervals', plan: { work: 20, rest: 10, rounds: 8, sets: 1, setRest: 0, rows: 'set' } },
  efforts: [{ kind: 'work', movement: 'Assault Bike', secs: 20, intensity: { by: 'cr10', target: 9 } }] }
// Today: name "Assault Bike", reps "Tabata", sets 1. parseIntervalReps already returns this plan.
```

**A CrossFit-style metcon** (a generic AMRAP, not a named benchmark)

```ts
{ structure: { kind: 'amrap', capSecs: 720 },
  efforts: [
    { kind: 'lift',     movement: 'Wall Ball',        reps: 10, load: { by: 'label', label: 'moderate' } },
    { kind: 'lift',     movement: 'Kettlebell Swing', reps: 10, load: { by: 'label', label: 'moderate' } },
    { kind: 'distance', movement: 'Run',              meters: 200, target: { by: 'cr10', target: 7 } },
  ] }
// Score: rounds + reps. Progression: the same block 3–6 weeks later, more rounds at the same session RPE or lower.
// Tissue: lower impact (the runs add up to 2–3 km), spine (the swings).
```

**A swim set**

```ts
[
  { structure: { kind: 'continuous', segments: [{ meters: 400, target: { by: 'zone', zone: 1 } }] },
    efforts: [{ kind: 'distance', movement: 'Swim (free)', meters: 400, target: { by: 'zone', zone: 1 } }] },
  { structure: { kind: 'clock', everySecs: 105, rounds: 10 },          // 10 × 100 m on 1:45
    efforts: [{ kind: 'distance', movement: 'Swim (free)', meters: 100, target: { by: 'time', secs: 90 } }] },
  { structure: { kind: 'continuous', segments: [{ meters: 200, target: { by: 'zone', zone: 1 } }] },
    efforts: [{ kind: 'distance', movement: 'Swim (easy, any stroke)', meters: 200, target: { by: 'zone', zone: 1 } }] },
]
// Zeroed doses the set and reads its load. It doesn't coach the stroke (§3.2).
```

**A football practice**

```ts
{ structure: { kind: 'continuous', segments: [{ secs: 5400, target: { by: 'cr10', target: 6 } }] },
  efforts: [{ kind: 'external', activity: 'Football practice', minutes: 90,
              tags: { impact: 'high', sprint: 'lots', contact: true } }] }
// The slot is fixed: true. The result is minutes + session RPE. The arc moves around it; the engine never moves it.
```

### 1.5 Where this lives today, without a migration

Add one optional field to `ExerciseTemplate`: `block?: Block`, next to the
`reps` string.

- The `reps` string stays canonical for anything the interval parser reads. Old
  clients, the program editor and the coach all keep working.
- `block` is the structured form, filled in by the engine when it can (the
  parser already produces `IntervalPlan`). Readers that don't know about
  `block` ignore it.
- Results stay in `SetLog`; `duration` and `distance` already exist. AMRAP and
  for-time scores need one optional `score` on the block. That's a later
  phase, not the MVP.

---

## 2. Unified arc spec

### 2.1 Data model

This maps onto today's tables: **program = arc, phase = block (chapter),
routine = session slot, workout = session result.**

```ts
type Modality = 'strength' | 'conditioning' | 'run' | 'swim' | 'bike' | 'row' | 'sport' | 'mobility' | 'skill'
type Role = 'lead' | 'support' | 'fixed'           // fixed = someone else programs it (team, class, club)
type Chapter = PhaseName                           // 'Stability' | 'Strength' | 'Power' | 'Sport', unchanged

interface AthleteArcProfile {                      // new: athlete.arc_profile JSONB
  modalities: Array<{ modality: Modality; role: Role; experience: 'new' | 'some' | 'experienced'; daysPerWeek?: number }>
  fixed: FixedSession[]                            // the BJJ, the team practice, Saturday's parkrun
  availability: Array<{ dow: 0 | 1 | 2 | 3 | 4 | 5 | 6; slots: Array<'am' | 'pm'> }>
  equipment: Array<'full_gym' | 'home_db' | 'hotel' | 'none'>
  timeZone: string                                 // fixes §0.5
  event?: { name: string; date: string; modality: Modality }
}

interface FixedSession {
  activity: string
  modality: Modality
  dow: number
  slot: 'am' | 'pm'
  minutes: number
  tags: ExposureTags
  season?: { from: string; to: string }
}

interface Arc {                                    // = program row (+ arc_profile on the athlete)
  id: string
  goal: { arena: ArenaType; text: string }
  lead: Modality
  chapters: ArcBlock[]                             // = phase rows
  status: ProgramStatus
}

interface ArcBlock {                               // = phase row
  chapter: Chapter
  weekStart: string
  weekEnd: string
  emphasis: Partial<Record<Modality, 'build' | 'maintain' | 'reduce'>>
  advancement: unknown                             // phase.advancement_criteria JSONB, exists
}

interface Week {                                   // derived; weekly_review stores the verdict
  start: string                                    // athlete's local Monday
  directive: WeeklyDirective                       // PROGRESS | HOLD | HOLD (missed) | DELOAD | RECOVERY, exists
  load: WeekLoad                                   // §2.3
  slots: SessionSlot[]
}

interface SessionSlot {                            // = routine row
  routineId: string
  modality: Modality                               // routine.session_type, widened
  dow: number | null                               // intended_dow, exists (soft pin)
  slot?: 'am' | 'pm'                               // new; needed for the 3 h rule
  fixed: boolean
  blocks: Block[]                                  // ExerciseTemplate[] today
  intent: string
}

// Performance models: one reader per modality, all the same shape, so the arc view and MCP treat them alike.
interface PerformanceReading<T> {
  modality: Modality
  movement: string
  value: T
  asOf: string
  confidence: 'tested' | 'estimated' | 'stale'
  reason: string                                   // the one line that shows its math
}

type StrengthModel  = PerformanceReading<{ workingMax: number; trainingMax: number; call: 'push' | 'hold' | 'drop' }>  // exists: liftModel.ts
type IntervalModel  = PerformanceReading<{ ladderStep: number; plan: IntervalPlan }>
type EnduranceModel = PerformanceReading<{ bests: Array<{ meters: number; secs: number; on: string }>; easyPaceSecPerKm?: number }>
type HoldModel      = PerformanceReading<{ bestSecs: number; leverage: number }>
type SkillModel     = PerformanceReading<{ ladder: SkillLadderId; level: number }>
```

### 2.2 One arc, read per modality

Keep the four chapter names. They're in a DB constraint, the existing UI and
the onboarding copy. Instead, let each modality read its own meaning into
them. That's what makes the arc legible: one strip, four chapters, and every
lane says what this chapter means for it.

| Chapter | Strength | Conditioning / HIIT | Run / row / swim | Sport (fixed) | Mobility / breath |
|---|---|---|---|---|---|
| **Stability** | Positions, tissue tolerance, moderate RPE | Aerobic base, long easy intervals | Easy volume, frequency first | Off-season or pre-season | High: the positions the lifts need |
| **Strength** | Heavier, lower reps, working max climbs | Threshold-ish intervals (3–5 min) | Tempo and threshold work | Pre-season | Maintain |
| **Power** | Fast, heavy-light, jumps; protected from interference | Short, hard, long rest (repeat sprint) | VO2-type intervals, strides | Late pre-season, early in-season | Maintain |
| **Sport** | Hold strength on low volume, keep intensity | Match the sport's demand | Race-specific, then taper | In-season: the sport leads and everything else serves it | Weighted to recovery |

**[convention]** This is block periodization applied per lane (Issurin 2010 is
a good review of the idea; verify). Nothing says this order is best for every
athlete. It's legible and defensible, which is the point.

Rule: a modality with `role: 'fixed'` never changes chapter because of a
Zeroed decision. Its season moves the other lanes.

### 2.3 Load: one currency, three budgets

**The currency.** Session load (AU) = session RPE (CR-10, the one tap) ×
minutes **[evidence: Foster et al. 2001]**. The week's load is the sum. Show
this week against the athlete's own 4-week average as **lighter / usual /
heavier**, with the number beside it. Never show it as risk
**[evidence: Impellizzeri et al. 2020 on ACWR; your scan]**. Foster's
"monotony" (daily mean ÷ SD) could become a later "every day looks the same"
nudge **[evidence: Foster 1998, verify]**.

Until the tap exists, the proxy is `workout.rpe × duration_mins`. Label it a
proxy in the UI: "estimated from your set RPEs".

**Tissue budgets** **[assumption: the buckets and weights are tunable
heuristics, not validated measures]**. Each budget has its own unit and is only
ever compared with the athlete's own 4-week history.

| Budget | Counts | Unit |
|---|---|---|
| **Lower impact** | run km; jump / landing contacts ÷ 100; sprint metres ÷ 100; external minutes × impact factor (high 1.0, low 0.3) per 60 min | impact units |
| **Spine** | hard sets (RPE ≥ 7) of squat, hinge, carry and overhead patterns; contact-sport minutes ÷ 30 | hard sets |
| **Upper** | hard sets of push, pull and hang; swim km; grappling and overhead-sport minutes ÷ 30 | hard sets |

The weekly allowance is the 4-week average × a directive factor: PROGRESS
1.10, HOLD 1.0, HOLD (missed) 0.9, DELOAD 0.6, RECOVERY 0.5. These are
**[convention]** placeholders to tune on your own data.

Going over budget doesn't block anything. It makes the scheduler move or swap
something and say why, for example: "Your lower-impact load is heavier than
usual: Saturday's match plus Tuesday's run. Thursday's hill sprints become
bike sprints."

**Cold start.** With no 4-week history, use the starter pack's default budget
and show "Learning your normal (week 1 of 4)".

### 2.4 Interference-aware scheduling

**Hard rules.** These are never broken silently. If one can't be met, the
proposal says so.

| # | Rule | Why |
|---|---|---|
| H1 | Fixed sessions are placed first. The engine never moves them | Sport is a constraint, not a variable |
| H2 | No hard lower-body conditioning (run intervals, sprints, high-impact HIIT) in the 3 h before a Power or heavy lower session. In the same session, lift first | Concurrent training blunts explosive strength mostly within a session, and ≥ 3 h apart removes it **[scan: Schumann 2022; check that moderator before quoting]**. Lifting first favours lower-body strength **[evidence: Murlasits et al. 2018, verify]** |
| H3 | No heavy lower session or high-impact work in the 24 h before a match or race. The day after a match is mobility, upper body or off | **[convention]** |
| H4 | At most 2 days in a row with session load above the athlete's usual | Hard days hard, easy days easy **[convention]** |
| H5 | Pain on a body region removes the efforts that load it until it clears | **[code]** The Pain chip already vetoes a push |

**Soft rules.** These are scored, not enforced.

| # | Rule | Why |
|---|---|---|
| S1 | When conditioning is support, prefer bike / row / ski to running in the Strength and Power chapters | Running interferes more than cycling **[evidence: Wilson et al. 2012]** |
| S2 | Keep tissue budgets within their allowance | §2.3 |
| S3 | Keep the athlete's soft day-pins (`intended_dow`) | **[code]** Pins are soft today |
| S4 | Put the lead modality's key session on the freshest day | **[convention]** |
| S5 | Taper over the last 7–14 days before an event: cut volume, keep intensity | **[evidence: Bosquet et al. 2007, verify the numbers]** |

**Algorithm.** Deterministic, and small enough for one developer.

1. Lay out 7 days × {am, pm}. Place the fixed sessions (H1).
2. Place the lead modality's key sessions on the best-scoring slots, then the
   support sessions, then flow / mobility fillers.
3. For each candidate placement, count violations. A hard violation makes the
   slot ineligible; a soft one adds a penalty.
4. Place greedily, then run one round of pairwise swaps.
5. Return `{ week, moves: Array<{ session, from, to, rule, reason }>, unmet: HardRule[] }`.
   Every `reason` is an engine template string, never model text.

This belongs in the pure engine next to `engine/weekDates.ts`, with a
`.check.ts` like every other engine module, so it works offline and is tested
under node.

### 2.5 Migrating from "every session needs a routine"

**Phase 1: no change to the foreign key.**

- Give each program one **sentinel routine**: name `Outside the plan`,
  `session_type 'external'`, `exercises []`. Ad-hoc and external sessions log
  against it, with `exercises_snapshot` holding what was actually done.
- Every planned-week reader filters `session_type = 'external'` out of the
  plan, but keeps it in the load. This is the risky part. Grep every reader of
  `routine` that counts sessions ("4 of 4 done", the week ring, week status,
  the MCP brief) and filter it.
- Make one additive migration, in both schemas plus the `/api/data` registry:
  - `workout.session_rpe NUMERIC(3,1) NULL`
  - `workout.source TEXT NULL` (`'plan' | 'adhoc' | 'external' | 'import'`)
  - `athlete.arc_profile JSONB NULL`
  - `athlete.flags JSONB NULL`

  All of these are nullable and old code doesn't read them. Rolling back means
  you stop reading them.
- Widen `routine.session_type` from `strength | power | conditioning |
  mobility` to add `run | swim | sport | external | skill`. It has no CHECK
  constraint, so this costs nothing.

**Phase 2: after the Neon cutover settles, when there's one schema to migrate.**

- Make `workout.routine_id` nullable and add `workout.program_id NOT NULL`
  (backfilled from the routine). A session then belongs to the arc even when it
  doesn't belong to a slot.
- Add `routine.slot TEXT NULL` (`'am' | 'pm'`).
- Retire the sentinel by backfilling its workouts to `routine_id NULL, source 'external'`.

Rollback for phase 2: keep the sentinel rows for 30 days. The backfill reverses
with `UPDATE workout SET routine_id = <sentinel> WHERE routine_id IS NULL`.

---

## 3. The S&C agent

### 3.1 Shared principles: the agent names them, the engine enforces them

| Principle | How it applies across modalities | Owned by |
|---|---|---|
| Progressive overload | One variable at a time: load (lift), density (work), volume then pace (distance), time then leverage (hold), level (skill) | Engine progression rules (§1.3) |
| Specificity | The Sport chapter pulls each lane towards what the goal demands | `demandTables.ts` **[code]** + arc emphasis |
| Block periodization | Four chapters, each read per lane (§2.2) | The arc |
| Energy systems | Intervals classed by work length and work:rest (≤ 10 s mostly alactic; 20 s–2 min glycolytic; ≥ 3 min aerobic) so the chapter gets the right block | Engine classification **[convention: the boundaries are fuzzy]** |
| Movement patterns | Every effort maps to a pattern, which feeds the tissue budgets and balance | Exercise library, `balance.ts` **[code]** |
| RPE / RIR | Lifts use RIR-anchored set RPE **[evidence: Helms et al. 2016]**. Everything else uses CR-10 effort. Every session gets one CR-10 tap | Engine |
| Concurrent training | §2.4's hard and soft rules | Scheduler |
| Readiness | The sleep / readiness / pain check-in changes the day. It already exists for lifts; extend it to "swap the run for a bike today" | `liftModel.ts` modifiers **[code]** |

The agent's job is to listen, ask the one question that matters, pick intents
("protect Thursday's power day", "add BJJ as fixed") and explain the engine's
output in the athlete's words. It never writes a number. The tools take
intents and return engine numbers with their reasons (§6).

### 3.2 Scope: coach, support or refer

```ts
type Scope = 'coach' | 'support' | 'refer'
// coach:   Zeroed programs and progresses it.
// support: Zeroed doses and budgets it, but doesn't coach the skill.
// refer:   Zeroed stops and points to a person.
```

| Request | Scope | What the agent says or does |
|---|---|---|
| Lifting, conditioning, run volume and intensity, mobility | coach | Programs it |
| Swim technique, stroke drills | support | "I'll dose your sets and fit them around your lifting. Stroke technique needs someone watching you: a swim coach or a masters group." |
| Olympic-lift technique (no video) | support | Progresses only variations the athlete has already learned with a coach (pulls, lifts from blocks). Otherwise refers. Zeroed doesn't do video analysis |
| Sport skill, tactics, what happens at team practice | support | Treats it as fixed and budgets around it |
| High-skill gymnastics (muscle-up, handstand walk) | support | Strength prerequisites only. Skill ladders come later |
| Pain that persists, swelling, numbness, night pain, "a pop" | refer | Stops the affected lane and shows a physio / doctor card |
| Chest pain, fainting, unusual breathlessness, palpitations | refer | Stop training and see a doctor now; emergency services if it's severe |
| Pregnancy, postpartum return, pelvic floor symptoms | refer first, then coach | Clearance first, then a conservative plan gated by symptoms (§5.3) |
| Nutrition prescriptions, weight cuts, disordered-eating signals | refer | No calorie targets. Points to a dietitian |
| Under 18 | refer or out of scope | Age gate at onboarding **[assumption: you need to decide the policy]** |

Scope is a deterministic table that the engine stamps on every tool response.
It isn't a model judgement. The model may escalate to `refer`; it can never
de-escalate.

### 3.3 Retraining and reprogramming

Each event is a pure function,
`reprogram(event, arc, history) → { arcDiff, weekDiff, reasons, refer? }`.
The numbers are **[convention]** starting points, to tune.

| Event | What the engine does | What the athlete sees |
|---|---|---|
| Missed 1 week | `HOLD (missed)` **[code]**: run the same week again | "Same week again. Nothing's lost." |
| Missed 2–3 weeks | A re-entry week. Lifts start from the decayed working max (the lift model already discounts by recency, with a 21-day half-life **[code]**). Intervals drop 1–2 ladder steps. The long run goes to about 70% of the last one. Then the chapter resumes | Before / after week. The arc slides by the missed weeks; if the event date is fixed, a chapter shortens and the message says which |
| Missed 4+ weeks | Back to Stability for 1–2 weeks, then resume the chapter you were in | The arc strip converges again |
| Illness | Systemic signs (fever, chest symptoms, aches) mean no training. On return: easy sessions only, no intervals or max efforts until 2 normal days. Chest pain, palpitations or fainting on return → refer | Day-level swaps; "Check in with me tomorrow" |
| Travel | Switch the equipment profile: same patterns and intensity, different movements (`swapped_from` exists **[code]**). No testing in the first 48 h after a big time-zone change | A swap list; the arc doesn't change |
| New goal | Fork the arc: keep the performance models, rebuild chapters towards the new arena, mark the old program `completed` | The old arc ghosts, the new one converges, and what carries over is named |
| New sport season | The sport becomes `fixed` with season dates. In-season, strength holds at about 1–2 sessions a week with intensity kept **[evidence: Bickel et al. 2011 on the dose needed to keep gains, verify]**. The Power chapter lines up with pre-season | A season band appears on the arc |
| Injury flag (Tweak / Pain) | Tweak: hold that effort's load and keep everything else. Pain: remove the efforts that load that region (H5) and offer pain-free alternatives. Two Pain flags on one region within 14 days, or any red flag → refer | A region tag on the arc and what would clear it (clearance tests exist **[code]**) |

---

## 4. Parametric UI component system

### 4.1 One contract for every instrument

```ts
type InstrumentState = 'idle' | 'armed' | 'live' | 'paused' | 'locked' | 'over'
// idle:   nothing yet.
// armed:  brackets open, the ready beat.
// live:   following the clock or your input.
// locked: converged on the answer (the result).
// over:   past the target (an overtime hold, a week over budget).

interface Band { lo: number; hi: number; label?: string }

interface InstrumentProps<V> {
  value: V
  target?: Band                  // always the engine's number…
  reason?: string                // …with its reason a tap away
  state: InstrumentState
  emphasis: 'signal' | 'quiet'   // exactly one 'signal' per screen (dev-only assert)
  density: 'glance' | 'full'     // glance: readable at 3 m, numbers plus one shape
  unit: Unit
  label: string                  // what VoiceOver says first
}
```

Every primitive also renders a numbers-only fallback from the same props. That
one fallback serves reduced motion, VoiceOver, a Live Activity and, later, the
Watch.

### 4.2 Six primitives

**1. Ring: closed-loop time.** Built from today's interval ring.

| Param | |
|---|---|
| `segments` | `Array<{ kind: 'ready' \| 'work' \| 'rest' \| 'break' \| 'inhale' \| 'hold' \| 'exhale'; secs: number }>` |
| `at` | wall-clock seconds into the block (the timer is already wall-clock **[code]**) |
| `count` | rounds or reps |
| `mode` | `'sweep' \| 'fill' \| 'breathe'` |

How the same ring becomes:

- **Tabata:** 8 short, heavy work arcs and 8 hairline rest arcs. One segment
  is lit, in sweep mode.
- **EMOM:** one segment per minute, so the ring *is* the minute. The rep
  target sits in the centre. When you tap "done", the rest of the minute fades
  to rest.
- **Plank:** one segment that fills towards the target. Past the target it
  turns `over`: a thin outer ring counting up.
- **Breath drill:** in `breathe` mode the radius follows inhale / hold /
  exhale, with the count in the centre.
- **Swim send-off:** the ring is 1:45. A tick marks where you touched the
  wall, and the arc after the tick is your rest.

**2. LoadBar: where you are against a band.**

| Param | |
|---|---|
| `scale` | kg, reps, AU, impact units |
| `band` | the engine's target |
| `value` | where you are |
| `ghost` | last time |
| `ticks` | e1RM, TM |

How the same bar becomes:

- **A squat set:** the band is the engine's target ± one plate step, the ghost
  is last session's top set, and a tick marks the TM.
- **A bodyweight set:** the band is the rep range.
- **The week's load:** the band is "usual" (your 4-week normal), the value is
  this week so far and the ghost is last week.
- **Tissue budgets:** three thin LoadBars stacked.

**3. PaceLine: a line settling into a band.**

| Param | |
|---|---|
| `series` | `Array<{ x: number; v: number }>` |
| `band` | the target |
| `xUnit` | `'time' \| 'distance' \| 'rep'` |
| `invert` | for pace, where lower is faster |

How the same line becomes:

- **A run** (later, with Watch or Health data): pace over time against the
  target band.
- **Erg intervals:** each rep's split is a dot, and the line converges on the
  band.
- **No sensors:** each rep's RPE is a dot against the target. It's the same
  component.

**4. HoldGauge: time in a position.**

| Param | |
|---|---|
| `target` | target seconds |
| `elapsed` | seconds held |
| `marks` | where form broke on earlier attempts |
| `orientation` | vertical for a phone on the floor, horizontal in hand |

It covers planks, dead hangs, wall sits and isometric pulls. A hold's story is
"beat your mark", while a ring's story is "the clock", which is why they stay
separate.

**5. Tally: counts with a score.**

| Param | |
|---|---|
| `structure` | `'amrap' \| 'for_time' \| 'skill' \| 'external'` |
| `rounds`, `reps` | AMRAP score |
| `attempts`, `clean` | skill score |

How the same tally becomes:

- **AMRAP:** a big round counter. Tap to add a round; long-press for partial reps.
- **Skill:** attempts and clean reps as two numbers, with the clean rate as a band.
- **Sport log:** minutes plus a session-RPE dial.

**6. ArcStrip: the arc itself.**

| Param | |
|---|---|
| `chapters` | the four chapters with their dates |
| `lanes` | `Modality[]` |
| `weeks` | `Array<{ load, directive, sessions }>` |
| `now` | the current week |
| `diff` | `{ before: Arc; after: Arc }`, optional |

How the same strip becomes:

- **Full:** the arc view.
- **Glance:** one line on Today ("Strength · week 3 of 4").
- **Diff:** the old arc as a ghost, the new one converging onto it (reprogramming).

### 4.3 Motion principles

These build on `docs/brand-motion-review.md`: motion only on real events,
≤ 500 ms in the working loop, never blocking input, and a readable end state.

1. **Converge on the answer.** Every instrument ends `locked`: brackets close
   on the result, the number settles (`TickingNumber`), one haptic tick. A
   logged set, a finished round, a held plank and an accepted reprogram all end
   the same way.
2. **Clocks don't ease.** Anything driven by wall-clock time moves linearly and
   continuously, because easing a clock makes it lie. Events (a phase change, a
   lock) use the brand ease.
3. **One signal.** Yellow marks the thing to act on now: the current work
   segment, the target band on a set, the moved session in a diff. Rest,
   history and ghosts use text tones.
4. **Work is mass, rest is line.** Work segments are filled and heavy; rest is a
   hairline. That reads in greyscale, in sunlight and for colour-blind athletes.
5. **The diff converges.** Reprogramming animates old → new: moved sessions
   slide to their new day and lock, and nothing else moves.
6. **Haptics follow the same grammar.** Lock → light tick. Phase change →
   medium. Last 3 s → three ticks. Done → success. Over budget → nothing,
   because it isn't an alarm.
7. **Numbers first.** With motion off, nothing is lost. Every state has a text
   and number equivalent.

### 4.4 The players

Every player shares a header (session, block, *Why*), its instrument, a next
line ("Next · rest 40 s"), the locked end state and the one-tap session RPE.

- **Interval / Tabata** **[exists]**. Ring (sweep) plus count. Add one thing:
  after the RPE locks, a progression line, "Next time: 9 rounds". That's the
  density ladder made visible, and it's the cheapest "arc moment" there is.
- **Run (v0, no GPS).** The interval timer with `continuous` segments, for
  example "10 min easy · 6 × 3 min hard / 2 min easy · 5 min easy". Targets are
  effort ("you can talk in short phrases"), not pace. Voice cues mark segment
  changes through the existing cue system. Afterwards: distance (typed now,
  from Health later) and session RPE. In v2, Watch or Health pace feeds a
  PaceLine.
- **Strength** **[exists]**. The set grid plus a LoadBar with the engine's band
  and a ghost, the rest timer docked, and the PR lock.
- **Sport.** It isn't a player during play. It's a 10-second log afterwards:
  the activity (remembered), minutes (prefilled from the fixed slot), a
  session-RPE dial and three tags. When it locks, the arc reacts on the spot:
  "Saturday's match was heavier than usual. Monday's squats stay; Tuesday's run
  becomes a bike." An optional warm-up timer can run before the match.
- **Mobility / breath.** Ring in `breathe` mode and HoldGauge, with voice cues.
  There's no score; finishing locks the ring. It counts as recovery on the arc.
- **The arc view.** ArcStrip full screen: chapters across the top, lanes down
  the side (Strength, Conditioning, Run, Sport, Mobility). Each week is a column
  of ticks sized by load. The current week sits under the reticle (the existing
  `ConvergenceReticle`, sized by real confidence **[code rule]**). Tap a week
  to see its sessions and their reasons. In **Sunday mode**, a "This week"
  sheet lists the moves with their reasons, with *Accept* and *Adjust*.

### 4.5 Accessibility and reduced motion

- **VoiceOver timers.** The ring is `role="timer"`, which isn't live by
  default. A separate polite live region announces phase starts only: "Work.
  Round 3 of 8. 20 seconds." The countdown stays in audio cues and haptics, not
  speech, to avoid two voices talking at once. When VoiceOver is running
  (checked natively with `UIAccessibility.isVoiceOverRunning` through the cues
  plugin), voice cues switch to tones only.
- **Controls** stay ≥ 44 pt, which is already enforced. Mapping VoiceOver's
  "magic tap" (two-finger double-tap) to pause / resume is
  **[assumption: test it in WKWebView]**.
- **Colour-blind safe.** Intensity is shown by position, label, mass (work
  filled, rest hairline) and luminance. No red / green pairs. Yellow against
  grey is a luminance contrast, not a hue contrast.
- **Reduced motion.** The existing global rule turns transitions off.
  Clock-driven fills keep updating, because they carry information, but without
  animation. `breathe` becomes "Inhale · 4" text with a count.
- **No flashing.** A phase change never flashes more than 3 times a second
  (WCAG 2.3.1).
- **Glance density** for reading across the room. Dynamic Type for words; the
  mono numerals scale with it.
- **Deaf and hard-of-hearing athletes.** Haptics plus a visible change of phase
  word carry every cue.

---

## 5. Agent-first conversations

These scripts are illustrative, not user quotes. **[engine: …]** marks the
deterministic output; every number the coach says comes from it. Every write is
a preview that the athlete confirms.

### 5.1 Onboarding (flags `onboarding_agent_v1` + `arc_view_v1`)

> **Coach:** What do you train at the moment? Tap all that apply, or just tell me.
> *[chips: Lifting · HIIT / intervals · Running · A sport · Classes · Mobility / yoga · Swimming · Cycling]*
>
> **Athlete:** Lifting and running. And five-a-side on Wednesdays.
>
> **Coach:** Which one matters most over the next three months?
>
> **Athlete:** Getting my 10k under 50 without losing strength.
>
> **Coach:** So running leads, lifting supports it, and five-a-side is fixed. Is it every Wednesday evening?
>
> **Athlete:** Yeah, about an hour.
>
> **Coach:** How many days can you train, counting the football?
>
> **Athlete:** Five.
>
> **Coach:** Two last things: your best recent 10k or 5k, and a recent heavy squat set if you know one.
>
> **Athlete:** 52:40 for 10k in September. Squat 100 kg for 5, felt hard.
>
> **[engine:** arena `event`; lead `run`; support `strength` 2 days; fixed: five-a-side, Wed pm, 60 min, impact high, sprint lots. Endurance model from 52:40. Strength: e1RM from 100 × 5 at RPE 8 ("hard" read as 8, confidence `estimated`). Arc: Stability 3 wk → Strength 4 → Power 3 → Sport 2 (taper). H3 moves heavy legs off Thursday.**]**
>
> **Coach:** Here's your arc: twelve weeks in four chapters. Running leads. Lifting keeps your squat where it is and makes you harder to break. Football stays where it is. I read "hard" as RPE 8; change it if that's wrong. One thing I moved: heavy legs are on Monday, not Thursday, so they're not the day after football. *[Preview: week 1]*
>
> **Athlete:** Looks good.
>
> **Coach:** Locked. Your first session is Monday: 30 minutes, squats, then a short easy run. *[apply]*

The "hard → RPE 8" mapping has to be shown and editable. Otherwise the first
working max is a guess presented as math.

### 5.2 "I've started BJJ twice a week"

> **Coach:** Nice. Which days, and roughly how long?
>
> **Athlete:** Tuesday and Thursday nights, 90 minutes.
>
> **Coach:** Mostly drilling, or lots of rolling?
>
> **Athlete:** The last 30 minutes is rolling.
>
> **[engine:** fixed sport Tue / Thu pm, 90 min, tags contact + grip. Upper and spine budgets rise. Conflicts: Thursday pull day before rolling (grip, upper); Tuesday intervals before rolling (H4); Friday deadlifts the morning after rolling (spine budget, S2).**]**
>
> **Coach:** BJJ goes on your arc as fixed, and two things move. Thursday's pull day moves to Saturday, so you're not rolling on a tired grip that night. Tuesday's intervals move to Monday, so you're not doing hard conditioning before rolling. Your lifting volume stays the same this week, and I'll see how the first two weeks feel before changing anything else. *[Preview: 2 moves, with reasons]*
>
> **Athlete:** Can I keep deadlifts on Friday morning?
>
> **Coach:** You can. It puts heavy deadlifts less than a day after 30 minutes of rolling, which loads your back twice in a short window. If you keep them there, I'll cap Friday's deadlifts at RPE 7. **[engine:** soft-rule conflict surfaced, capped alternative computed**]**
>
> **Athlete:** Fine, cap it.
>
> **Coach:** Done. After each class, tap how hard the whole thing was. That's how I'll learn what BJJ costs you. *[apply]*

### 5.3 "I'm postpartum and want to run"

Policy **[assumption; have a pelvic health physio review this copy before it
ships]**: the agent gives no medical advice. It asks about clearance and
symptoms, and the engine gates impact. Exact week counts stay out of the copy;
a professional sets the date.

> **Coach:** Congratulations. I can help you build back to running. A few questions first, and you can skip any of them.
>
> **Coach:** How long ago did you give birth?
>
> **Athlete:** Ten weeks.
>
> **Coach:** Since then, have you seen a doctor or a pelvic health physio, and did they clear you to exercise?
>
> **Athlete:** My GP said exercise is fine. I haven't seen a physio.
>
> **Coach:** Do you notice any of these when you cough, lift, jump or walk fast: leaking, heaviness or dragging, pain, or a bulge along your tummy?
>
> **Athlete:** A bit of leaking when I sneeze.
>
> **[engine:** refer trigger (a symptom is present). Impact budget: walking only. Strength: Stability chapter, low load, breathing and trunk positions. The run lane is locked behind a "cleared to run" check.**]**
>
> **Coach:** Thanks for telling me. That's common, and it's exactly what a pelvic health physio helps with. Running is high impact, so I'd like you to see one before we add it. *[See a professional]*
>
> **Coach:** Until then, here's what we can do: walks that build in time, and strength work that rebuilds from the inside out. When you've been cleared, tell me and I'll add a walk-run plan. *[Preview: Stability chapter, 3 days]*
>
> *(Weeks later)*
>
> **Athlete:** My physio cleared me to start running.
>
> **Coach:** Great. Walk-run it is: short runs inside a walk, building over the weeks. If leaking, heaviness or pain comes back, tell me and we'll step back. **[engine:** run lane added on a walk-run ladder; a symptom chip on every run session**]**

Background reading for the policy, not for copy: return-to-running guidance for
professionals (Goom, Donnelly & Brockwell, 2019) and ACOG Committee Opinion 804
(2020). **[evidence: verify both]** A caesarean birth adds a wound-healing
question; ask it.

### 5.4 "I missed two weeks"

> **Athlete:** I missed two weeks. Work blew up.
>
> **Coach:** That happens. Do you want to pick up where you were, or take a lighter week to get back in?
>
> **Athlete:** Whatever's smarter.
>
> **[engine:** 14 days missed. Working max decayed (reason per lift). Intervals −1 step. Long run at 70%. The Strength chapter shifts 2 weeks. The event date is fixed, so Power shortens from 3 weeks to 2.**]**
>
> **Coach:** One re-entry week, then back into Strength. Your squat target is 92.5 kg for 5 (it was 97.5): after two weeks off, I trust last month's numbers a bit less. Intervals drop one step. Your race date doesn't move, so Power gets a week shorter; Strength stays full, because it matters most for you right now. *[Preview: arc before / after, plus the week diff]*
>
> **Athlete:** Do it.
>
> *[apply]*

### 5.5 The starter packs as entry points into one arc

Each pack sets the same `AthleteArcProfile` and the same arc parameters.
Nothing else differs, which is what `starterPacks.ts` already says.

| Pack (#31) | Arena | Lead | Support / fixed | Starting chapter | Default budgets and notes |
|---|---|---|---|---|---|
| S&C for your sport | sport | the sport (fixed) | strength 2–4 | Stability (off / pre-season) or Sport (in-season). `Season` is already on the pack | The next question asks for the sport's fixed slots; H3 is on |
| Get strong | number / body | strength | mobility | Stability | Conditioning as optional finishers |
| Powerlifting / chase a total | number | strength | mobility | Stability for 4 weeks, then Strength (the card's "heavy SBD after your first 4-week block") | Conditioning on the bike only (S1) |
| Hybrid / Hyrox | event / all-round | run or conditioning (it asks) | strength 3 | Stability | Lower-impact budget on; H2 on |
| Back from a layoff | durability | strength | mobility | Stability, with a re-entry ramp | Conservative budgets; refer triggers on |
| 30 minutes, 3 days | all-round | strength | conditioning finishers | Stability | 30-minute cap; intervals inside sessions |
| Bring your own plan | from the plan | from the plan | from the plan | inferred | Parsed into blocks, with the engine checking every number; sessions over 75 min flagged |

The pack copy stays as signed off. What changes is what comes after: every pack
ends on the same arc view, with lanes the athlete can add ("Add a run or a
sport").

---

## 6. Agent / MCP tool surface

The rules:

- Reads are cheap, and there can be many.
- Every write is `preview_*` → `apply_*`, with a `preview_id` and `confirm: true`.
- Inputs are intents. Outputs carry engine numbers, their reasons and the scope stamp.

**Fix this first.** Make `apply_program_edits` take a `preview_id`: a hash of
the edits plus the program's revision. It refuses if the program changed after
the preview. Keep accepting raw `edits` for one release so existing clients
don't break.

**New read tools**

| Tool | Returns |
|---|---|
| `get_arc` | Chapters and dates, lanes, current week, event, fixed sessions, and the reason for each chapter's length |
| `get_week_plan` | This week's slots across modalities, moves already made and why, and any hard rules that couldn't be met |
| `get_load` | Session loads (sRPE-min, with the proxy flagged), this week against the 4-week usual, and tissue budgets as lighter / usual / heavier. No risk language |
| `get_performance` | `(modality, movement?)` → PerformanceReading(s) with confidence and reason |
| `explain` | `(ref)` → the reason chain for any engine number: a target load, a move, a budget |
| `get_scope` | `(text)` → coach / support / refer, plus the referral line |

**New write tools** (preview → apply)

| Preview | Apply | Input (intents only) |
|---|---|---|
| `preview_session_log` | `apply_session_log` | `{ activity, minutes, session_rpe, tags, when }` for sport, external or off-plan sessions. Returns the load, the budget change and any proposed moves (which preview separately) |
| `preview_arc_change` | `apply_arc_change` | `{ add_modality \| remove_modality \| set_fixed \| set_event \| set_lead }` |
| `preview_reprogram` | `apply_reprogram` | `{ event: 'missed' \| 'illness' \| 'travel' \| 'new_goal' \| 'season' \| 'injury_flag' \| 'equipment', details }` → arc diff + week diff + any refer |
| `preview_program_edits` (extended) | `apply_program_edits` | Adds `block` (a structured effort / structure) as an alternative to `reps` text, and `modality` on `add_session` |

**The engine stays the only writer.** Apply calls the same functions the app
uses (the `programEdit.ts` path today). If the model passes a number ("set
squat to 140"), it's treated as a request, and the engine returns what it set
and why. Define the arc tools once in a shared module that `worker/src/tools.ts`,
the Supabase function tools and `mcp/src/server.ts` all import, so they can't
drift. Nothing here needs ChatGPT.

---

## 7. MVP vs later

### 7.1 The smallest test of the arc + UI bet (about 3 weeks)

The bet is that an athlete who trains more than one way chooses Zeroed again
next week **because of** the arc and the UI. So the MVP must let one athlete
run a whole mixed week in Zeroed and see it as one arc. Nothing else.

**MVP: "One week, one arc"**

| # | Piece | Reuses | **[estimate]** |
|---|---|---|---|
| 0 | Runtime flag layer + 6 behaviour events; time-zone fix (§0.5) | `flags.ts` | 2 d |
| 1 | Session-RPE tap (CR-10) at the finish; `workout.session_rpe` / `source` | `SessionZeroed` | 1–2 d |
| 2 | Log outside the plan: sport, run or class in ≤ 15 s (sentinel routine) | RPE dial, outbox | 2–3 d |
| 3 | Week load card: a LoadBar of sRPE-min against the 4-week usual, by lane | ring / meter CSS | 2 d |
| 4 | Arc view v0: ArcStrip with chapters, lanes and this week, read-only | phases, `ConvergenceReticle` | 3–4 d |
| 5 | Run player v0: the interval timer with continuous segments and effort targets | `IntervalTimer`, parser, cues | 2–3 d |
| 6 | One reprogram rule live, H3 (match / high impact vs heavy legs), with preview → confirm and the converging diff | `weekDiff.ts`, `programEdit.ts` | 3 d |
| 7 | MCP: `get_arc`, `get_load`, `preview_session_log` / `apply_session_log` | `tools.ts` | 1–2 d |

That's about 16–21 days. If it has to fit in 2 weeks, drop 6 and 7 (the diff
becomes v1.1) and keep 0–5.

**Explicitly not in the MVP:** GPS, HealthKit, Watch, Live Activities, swim,
skill ladders, AMRAP / for-time scoring, any tissue budget beyond lower impact,
imports, new chapter names, any ChatGPT surface.

### 7.2 Phases, flags and rollback

| Phase | Flag | Ships | Rollback |
|---|---|---|---|
| 0 | — | Flag layer, events, time-zone fix | Nothing user-facing to roll back |
| 1 | `arc_load_v1` | Session RPE, log outside the plan, load card | Flag off hides the UI. The nullable columns are ignored. The sentinel routine is filtered everywhere, so it's invisible either way |
| 2 | `arc_view_v1` | Arc view with lanes | Flag off shows the Program and Journey screens as today |
| 3 | `run_player_v1` | Run v0 | Flag off logs run sessions as normal time / distance rows |
| 4 | `arc_reprogram_v1` | Rule H3, previews, diff motion, MCP tools | Flag off: no proposals, and the MCP tools answer "not available on this account" |
| 5 (later) | `health_read_v1` | HealthKit read: runs and sport auto-logged as external, with dedupe | Flag off: manual logging |
| 6 | `live_activity_v1` | Live Activity for intervals and runs; native cue scheduling | Flag off: today's timer |
| 7 | `arc_budgets_v1` | Spine and upper budgets, the full scheduler | Flag off: lower impact only |
| 8 | per feature | Swim, skill ladders, holds, AMRAP, Hevy / Strong CSV import | Per feature |
| 9 | per feature | Watch app; GPS only if Health and Watch aren't enough | Per feature |

### 7.3 The lightest flag layer

Keep `flags.ts` pure and give it two more inputs.

```ts
interface FlagInputs {
  env: Record<string, string | undefined>   // build ceiling: VITE_<FLAG>=1 allows it at all
  remote: Record<string, 'on' | 'off'>      // kill switch, fetched at launch, cached via cache.ts
  athlete: Record<string, boolean>          // athlete.flags JSONB: per-person rollout (you, then 5 testers)
  dev: { DEV: boolean; search: string }     // ?flag= override, DEV builds only (exists)
}

export function flagOn(name: FlagName, i: FlagInputs): boolean {
  if (i.remote[name] === 'off') return false                 // rollback without an App Store build
  if (i.dev.DEV && devOverride(name, i.dev.search)) return true
  return i.env[`VITE_${name.toUpperCase()}`] === '1' && i.athlete[name] === true
}
```

- **The kill switch** is one JSON served by whichever backend the build talks
  to: a row in an existing table, or `GET /api/flags` on the Worker after the
  cutover. Offline, use the last cached value.
- **One rule for every phase:** data written with a flag on must be harmless
  with it off.

---

## 8. Outcome metrics and the cheapest tests

### 8.1 Behaviour metrics

**Primary (the bet): mixed-week retention.** Of athletes who log 2 or more
modalities in week 1, the share who log at least one non-lifting session in
Zeroed in week 2 and again in week 3.

| Supporting metric | What it tells you |
|---|---|
| **Coverage:** the share of their training they log in Zeroed, from a weekly one-question check ("Anything you did this week that isn't here?") | Whether the stitched stack is shrinking |
| **Sunday open:** arc or week view opened between Saturday and the first session of the week | Whether the planning moment is real |
| **Reprogram follow-through:** proposed moves accepted, *and* the moved session then done | Trust in the engine, not just clicks |
| **Return after a broken week:** after 5+ days without a session, a session logged within 7 days | "The morning after life broke the week" |
| **Block completion:** interval and run blocks finished once started, with RPE logged | Whether the player is good enough to use |
| **Time to log an external session** (median ≤ 15 s) | Whether the sport path is usable |
| **Guardrail:** Pain flags per 100 sessions, and refer cards shown | Whether safety is drifting |

At your scale these are counts and stories, not statistics: 5–20 people. Write
down the number and the person.

### 8.2 The riskiest assumptions and the cheapest tests

| Type | Assumption | Cheapest test | Pass / fail signal |
|---|---|---|---|
| Value | Athletes who mix modalities want one arc more than the best app for each | Code reviews of HYBRD and Pelaris and threads on r/HybridAthlete for "one plan" vs "a better single app"; 5 interviews about last Sunday's planning | At least 3 of 5 describe the stitching pain without prompting and show you their stack |
| Value | The players and the arc are a reason to come back | Your dogfood, plus 5 people on TestFlight with the flags on for 2 weeks | Mixed-week retention in at least 3 of 5 |
| Usability | People can log a BJJ class in ≤ 15 s and read the arc's diff | 5 hallway tests on the build. One task each: "log last night's class" and "what changed this week, and why?" | 4 of 5 succeed without help |
| Feasibility | One-tap session RPE gives a load signal that tracks how the week felt | Dogfood: log both the proxy and the tap for 2 weeks, and compare weekly ranks with your own "how hard was this week" | The tap and your feeling agree on the hardest week. How far the proxy is from the tap tells you whether the proxy is safe to show |
| Feasibility | Cues keep working on a locked phone in a pocket for a 30-minute run | A 1-day native spike: lock the phone and run the run player | Every cue on time. If not, build native scheduling (§9) before phase 3 |
| Viability | Enough people pay your price when Pelaris has a free tier | Show the price at the end of each of the 5 interviews ("This is $X a month. Would you switch, and what would you drop?"); later, a fake-door paywall on the arc view | **[unknown]** until asked. Record the price where people drop out |
| Viability | Inference cost per active athlete stays well under the price | Read OpenAI usage per athlete per week from the agent logs | **[unknown]**. Check it this week |

**A read-only count of who already logs intervals.** It's approximate: a text
match on rep specs plus anything time- or distance-tracked, so treat it as an
upper bound. Run it on a Neon branch or a read replica, not the live primary.

```sql
-- Athletes with an interval / conditioning block logged in the last 8 weeks, against all active athletes.
WITH logged AS (
  SELECT p.athlete_id, r.session_type, ex
  FROM public.workout w
  JOIN public.routine r ON r.id = w.routine_id
  JOIN public.program p ON p.id = r.program_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.exercises_snapshot, r.exercises)) AS ex
  WHERE w.performed_at > now() - interval '56 days'
)
SELECT
  count(DISTINCT athlete_id) AS active_athletes,
  count(DISTINCT athlete_id) FILTER (
    WHERE session_type = 'conditioning'
       OR ex->>'reps' ~* '(tabata|e[0-9]?mom|every [0-9]* ?min|[0-9]+ ?(s|sec|min)[a-z]* ?(on|/))'
       OR ex->>'tracking_type' IN ('time', 'distance')
  ) AS logging_intervals_or_conditioning
FROM logged;
```

Change the `SELECT` to `athlete_id` with `HAVING` to get the list of people to
invite to interviews.

---

## 9. Things you may not have thought about

### Injury and medical safety language

- **Words to use:** load, budget, "heavier than usual", "see a professional".
  **Never:** injury risk, prevent injury, safe to, diagnose, treat, rehab (as a
  claim). App Review scrutinises apps that could cause physical harm or make
  health claims (Guideline 1.4.1 **[verify the current text]**).
- **Escalation triggers** (stop and show a refer card; stamped by the engine):
  - chest pain or pressure; fainting or nearly fainting; unusual breathlessness; palpitations
  - pain worse at night or at rest; numbness or tingling
  - swelling, a "pop", or not being able to bear weight
  - pain ≥ 7/10, or Pain on the same region twice in 14 days
  - pregnancy or postpartum symptoms: leaking, heaviness, pain, bulging
  - disordered-eating language
  - under 18
- **Onboarding** gets a PAR-Q+-style yes / no set **[evidence: PAR-Q+ is the
  standard pre-participation questionnaire; check its terms of use before
  copying wording]**. A "yes" doesn't block anyone. It adds "see a professional
  first" and lowers the provisional ceiling, which `safety.ts` already has.
- **Don't build menstrual-cycle-based programming claims.** The evidence for
  phase-based changes is weak and individual
  **[evidence: McNulty et al. 2020, verify]**. If you add cycle logging later,
  use it to explain how a session felt, not to prescribe one.

### Wearables and HealthKit

- **Read: the highest value for the lowest cost.** Workouts from Health become
  `external` sessions with minutes, distance, HR and Apple's effort rating where
  it exists. Watch, and apps like Strava and Garmin Connect, can write to Health
  **[verify each]**. iOS 18 added a workout effort score
  **[verify the API]**. This is how runs arrive without you building GPS.
- **Write:** save Zeroed sessions as `HKWorkout`s (strength, HIIT, running and
  so on) so Apple's rings and Training Load count them.
- **Dedupe:** a Watch-recorded HIIT and a Zeroed-logged HIIT in the same hour
  must become one session (match on time overlap and type). Without this, load
  silently doubles.
- **Plumbing:** Capacitor needs a native HealthKit plugin, either a community
  one (quality **[unknown]**) or your own, like `ZeroedCues`.

### GPS

Skip it. Background location needs an App Review justification, battery work
and an accuracy story, and Watch, Strava and Garmin already do it better and
write to Health. Revisit only if interviews say "I'd drop Strava if Zeroed
tracked the run".

### Offline

The players already work offline (pure engine, wall clock, outbox). Keep the
load card, the scheduler and reprogram proposals in the pure engine too, so they
work offline; only the agent's explanation needs a network. External logs go
through the existing outbox.

### Timer audio, ducking and haptics

- Ducking under music and playing through Silent Mode already work **[code]**.
- **The gap is a locked phone**, such as a 30-minute run with the phone in a
  pocket. JS timers in the WebView suspend, so cues scheduled from JS can drift
  or stop.
- **The robust fix:** hand the whole timeline to the native plugin when the
  block starts, and let it schedule the cues natively. `buildTimeline` already
  computes the timeline. Avoid a silent-audio keep-alive, which is a review risk.
- Haptics don't carry well through a pocket. The Watch does that job better.

### Apple Watch and Live Activities

- **A Live Activity** for intervals and runs shows the phase and countdown on
  the lock screen and in the Dynamic Island. SwiftUI's `Text(timerInterval:)`
  counts down by itself with no updates. Phase changes do need an update from
  the app, which works while the audio session keeps it alive. Activities have
  a time limit (about 8 hours **[verify]**). It needs a widget extension target:
  native work, about a week **[estimate]**.
- **A Watch app** is a separate SwiftUI target and weeks of real work. Leave it
  for later. Reading from Health gets you most of the Watch's value for runs.

### Accessibility

Covered in §4.5. Add an accessibility pass to every phase's definition of done,
and test with VoiceOver on and with Reduce Motion on.

### Data portability

- **Import from Hevy and Strong**, which both export CSV **[verify the
  formats]**. Importing lifting history gives a working max on day one. That's
  the strongest onboarding win for lifters, and it's a parser, not an
  integration.
- **Strava's API.** Its 2024 terms restrict using Strava data in AI models and
  limit how the data is shown **[verify the current terms]**. That may rule out
  feeding Strava activities to the coach. Prefer Health.
- **Garmin.** The Connect developer programme requires approval **[verify]**.
  Health covers Garmin users whose Connect app syncs to it.
- **Export** everything as CSV / JSON (GDPR Article 20 portability for UK and EU
  users), plus the arc as a readable page.

### Pricing

- **Rivals, from your scan:** £3.99 (Hybrid Training Plan), €14.99 (TNK),
  $14.99–19.99 a month (HYBRD), and Pelaris with a free tier.
- **Hypothesis [assumption]:** free gets every player, logging and the arc view,
  because the UI is the acquisition. Paid gets the coach: reprogramming, the
  agent and the MCP connector. Somewhere around $9.99–12.99 a month with an
  annual plan. Test the price in the interviews before you ship a paywall.
- **MCP users bring their own model**, so they cost less to serve than the
  in-app agent. That might justify including MCP in the base paid tier rather
  than making it an upsell **[assumption]**.
- **Commission:** the App Store Small Business Program charges 15% under
  $1M a year. US apps can now link out to web checkout after the 2025 Epic
  ruling **[verify the current status]**.

### App Store

- **Category:** Health & Fitness as primary. Whether Sports is a better
  secondary is **[unknown]**; check what HYBRD and Pelaris use in their
  listings.
- **Trademarks in metadata:** don't put them in keywords (Guideline 2.3.7).
  HYROX and CrossFit are trademarks, so the "Hybrid / Hyrox" pack name and any
  store copy need a check **[verify]**. Whether "Tabata" is a trademark is
  **[unknown]**.
- **"No beta in copy"** matches Guideline 2.2: betas belong on TestFlight.
- **Third-party AI disclosure.** Apple's guidelines (5.1.2(i), updated in
  November 2025) require you to disclose, and get explicit permission, before
  sending personal data to a third-party AI **[verify]**. Your in-app agent sends
  training data to OpenAI. The MCP connector sends it to Claude at the user's
  request. HealthKit data has extra rules (5.1.3).

### Anything else I'd worry about

- **Time zones** (§0.5), before any spacing rule.
- **The "hard" → RPE mapping** in onboarding (§5.1).
- **Reasons drifting.** If the agent paraphrases the engine's reasons, it can
  change what they mean. Show engine reasons verbatim and let the agent add
  context around them.
- **The sentinel routine leaking** into counts. Every "sessions this week" count
  must exclude it.
- **Time of day.** `intended_dow` has no am / pm, and H2 needs it (`slot`).
- **A Sunday notification.** The planning moment wants one ("Your week's ready:
  one move for Saturday's match"). I didn't see any push infrastructure in the
  repo **[unknown]**.
- **Model cost.** The heavy model already reads a whole week, and adding lanes
  makes that context bigger. Measure tokens per reprogram.
- **Liability.** Terms of use saying Zeroed isn't medical advice, with in-app
  copy that matches them.
- **Scope creep in "any sport".** The external effort with tags is deliberately
  coarse. Don't add sport-specific content until a sport comes up in 3 or more
  interviews.

---

## 10. One page

**The bet.** Athletes who lift and also do something else (intervals, runs, a
sport, Hyrox, mobility) will choose Zeroed again next week over their stitched
2–4 apps, for three reasons. They can see every session as one arc. The
players feel tuned in. And when life breaks the week, the engine reprograms it
and shows its math.

**What's new against your scan.** "One plan across modalities" is taken. What
isn't is a legible arc with modality lanes, engine-checked edits from any agent,
and modality players that share one design language.

**The MVP: "One week, one arc"** (about 3 weeks, behind four flags, with a
runtime kill switch):

1. A one-tap session RPE, and "log outside the plan" (sport, run or class in ≤ 15 s).
2. A week load card: this week against your usual.
3. Arc view v0: four chapters, modality lanes, this week locked on.
4. Run player v0: the interval timer with long segments and effort targets, no GPS.
5. One reprogram rule (match or high impact vs heavy legs), with preview → confirm and the converging diff.
6. MCP `get_arc`, `get_load` and `preview_session_log` / `apply_session_log`.

Before any of that: the time-zone fix and the runtime kill switch.

**The three riskiest assumptions**

1. **Value:** athletes who mix modalities want one arc more than the best app for each one.
2. **Feasibility:** one tap of session RPE × minutes is a load signal good
   enough to reprogram from. Today's stored RPE is a mean of set RPEs, not
   session-RPE.
3. **Viability:** people will pay for the coach when the players are free and
   Pelaris is free.

**The first test to run this week.** Run the read-only SQL count in §8.2. It
takes an hour and answers two things at once: whether your target athlete
already exists in your base, and who to interview. Message everyone who logs
both lifts and intervals, and book 5 interviews about last Sunday's planning
and the stack they use. While you wait for replies, ship the session-RPE tap to
yourself only (athlete flag) and start the 2-week lift + HIIT + run dogfood,
logging both the proxy and the tap.

**What would make you narrow the plan.** If 3 of 5 interviewees say they'd keep
their running or sport app whatever Zeroed did, the arc is a nice view, not a
reason to switch. Then the plan narrows to "the best strength coach that knows
about the rest of your training". That's still the MVP above, minus the run
player.
