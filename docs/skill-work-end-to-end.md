# Skill work, end to end — product/UX spec

Status: product design, ready for engineering. Not production code.
Scope: everything behind `skill_blocks_v1` (spec §12, zeroed#73 / PR #74, TestFlight 0.1.241 / 243). `coach_v1` stays off.
Source of the two breaks: Phil's real basketball skill session (finishing → "Play Strong inside the arc" → suicides). This is not a simulated walk.

---

## 0. The idea in one line

**Skill is decided per exercise, but read in the context of the session.** That context decides what Train calls the session, how Workout opens, and which stations get Done / Next. Intervals keep the clock. Lifts keep the set grid. Every screen asks one function the same question, so they can't disagree.

Today four separate places each make their own call:

| Place | Today's question | Why it goes wrong |
|---|---|---|
| `isSkillBlock` (`src/engine/skillBlock.ts`) | Does this one row match a keyword? | Looks at each row on its own. "Play Strong inside the arc" falls through. |
| `intervalLed` (`TodayScreen.tsx:310`) | Is there ≥1 interval block, and is the day typed `conditioning` or made of nothing but blocks? | Doesn't know about skill. One leftover `6 × 10s / 50s` on a conditioning-typed skill day is enough to show "Start intervals". |
| `?go=intervals` auto-start (`WorkoutScreen.tsx:2364`) | What's the first interval plan still left to run? | Starts the timer even when station 1 is a skill station. |
| `PerformedRow` (`TodayScreen.tsx:339`) | Is there an interval plan? Then count rounds of work. | Reads a station as "rounds · of work", or as a set grid if it was misclassified. |

The fix: one classifier that knows the session (§3), one session shape built from its output (§4), and every surface reads that shape.

---

## 1. End-to-end journey

The three sessions used all the way through:

- **Skill-led:** Finishing (6 makes) → Play Strong inside the arc (3 × 5) → Free throws (10 makes). No real conditioning.
- **Mixed (Phil's session):** Finishing (6 makes) → Play Strong inside the arc (3 × 5) → Suicides (6 × 25s / 35s).
- **Interval-led:** Bike Tabata (8 × 20s / 10s) → Row intervals (5 × 1:00 / 1:00). Typed `conditioning`.

### 1.1 Train card (`TodayScreen.tsx`, session card CTA ~L667)

The card gets one new line: a **shape strip**. It's a row of small glyphs, one per exercise, in order: ◆ station, ▮ lift, ◷ interval. It's the same three primitives the athlete will see in Workout, at a glance. The dose line uses each kind's own language.

| Session | Dose line | Primary button | Today (broken) |
|---|---|---|---|
| Skill-led | `3 stations · ~25 min` | **Start session →** | "Start intervals" if typed `conditioning` or if any row parsed as an interval |
| Mixed | `2 stations · 1 interval` | **Start session →** | **"Start intervals"** ← Phil's break #1 |
| Interval-led | `2 intervals · 14 min` | **Start intervals** (▶) | same (correct, keep) |
| Lift day + finisher | `5 exercises · 1 interval` | **Start session →** | same (correct, keep) |
| In progress, any | — | **Resume →** | same |

The mixed day starts like a session. The timer is two stations away, and the athlete gets there through the list (§1.6), not by being dropped into it.

### 1.2 The sheet from the card (`TodayScreen.tsx` ~L443)

The header chip stays. The exercise list uses the same three row treatments as Workout:

- Station row: name, then `6 makes · ~8 min` (`fmtSkillDose`), with a ◆ glyph. No sets × reps, no "BW".
- Lift row: `3×8 · moderate` as today.
- Interval row: `intervalTitle` + `6 × 25s / 35s` as today.

| Session | Primary | Secondary |
|---|---|---|
| Skill-led | **Start session →** | — |
| Mixed | **Start session →** | — (no "Start intervals" shortcut; see §4) |
| Interval-led | **Start intervals** (▶) | Open session |
| Done | Review / edit → | Log it again |

### 1.3 Arriving on Workout (`WorkoutScreen.tsx`)

- **Start session →** opens `/workout/:id` with no `go`. The first not-done exercise is active and locked on (`arrivedIdx`). In the skill-led and mixed sessions that's the Finishing station, with Done / Next as its primary.
- **`?go=intervals`** is only honored when the *first not-done exercise* is an interval and the session is interval-led (§4.3). In every other case it's dropped quietly (same `replace` as today) and the page opens like Start session. It never starts a timer on a skill station, and it never skips past an open station to reach a later interval.
- Rail rest copy (`WorkoutScreen.tsx:3198`, "Idle. Completing a set starts a clock sized to the lift.") changes by active kind:
  - Lift active: unchanged.
  - Station active: **"Rest is yours here. Tap the rest clock on the station when you want one."**
  - Interval active: **"The interval timer runs the rest."**

### 1.4 A correctly classified station: "Finishing — 6 makes"

The `SkillBlock` card, built out per §2:

- Head: target **6 makes** big. The tally `0 / 6` appears only once the athlete taps a make (§2.4).
- Guide line: `Suggested ~8 min · ~60s rest — a guide, not a clock.`
- Cue: `Off two feet, chin over the rim. Miss = one extra.`
- Primary: **Done / Next**. Secondary: elapsed ▶ and rest ◷.
- Done → "Station done", plus "Not done yet". The list advances to the next exercise with the same lock-on animation a set uses.

### 1.5 Named court station with plain reps: "Play Strong inside the arc — 3 × 5"

Today it fails every keyword, and `3 × 5` with no load renders as a **bodyweight set grid** (break #2).

After: the session's skill context (Finishing anchors it) makes it a station (§3, rule C). It renders as the **same station primitive**:

- Target **3 × 5** (`skillView`). Because the dose is a count with sets, it shows as **3 rounds of 5**, as three tappable round pips (§2.5). It's still not a grid: no weight column, no reps steppers, no "BW".
- **Done / Next** advances. Pips are optional bookkeeping. The athlete can tap Done / Next with zero pips filled.

What gets replaced: the set grid, the `bodyweight_reps` row copy (`fmtSet` → `5`, `5+…`), load chips, the "find a working weight" hint, and the auto rest clock "sized to the lift". `WorkoutScreen.tsx:2893` already suppresses chips for `skill`. The fix is that `skill` is now true for this row.

### 1.6 A real interval later: "Suicides — 6 × 25s / 35s"

After the athlete taps Done / Next on the last station, Suicides becomes active. It shows the existing `IntervalBlock` with its own **Start intervals** button (`IntervalBlock.tsx:71`). That label is correct here: it's one block, and the clock is the boss. Tap → ready beat → auto-advance, exactly as today. Nothing about interval behavior changes.

Station and interval never share a screen state. While the timer runs, stations above it read done or not-done and can't be tapped into the timer.

### 1.7 Adding mid-session (`WorkoutScreen.tsx` add-cta ~L3166)

Today it offers two buttons: **+ Exercise** and **⚡ Intervals**.

With the flag on, it offers three, in an order that depends on the session:

| Session | Buttons (left → right) |
|---|---|
| Skill-led / mixed | **◆ Station** · **+ Exercise** · **⚡ Intervals** |
| Lift day | **+ Exercise** · **⚡ Intervals** · ◆ Station |
| Interval-led | **⚡ Intervals** · **+ Exercise** · ◆ Station |

- **◆ Station** opens a small builder: name, target type (makes / per side / possessions / quality), count, optional window, optional cue. The new row saves `kind: 'skill'` explicitly, so it never relies on inference. It's marked `added` ("Added in the session").
- **⚡ Intervals** keeps today's builder and saves `kind: 'interval'`.
- **+ Exercise** keeps today's library picker. A library movement added to a skill session does **not** inherit skill (rule D below). Push-ups stay push-ups.
- **Swap** on a station offers other stations first. A swap keeps `kind` unless the athlete picks across kinds.
- **Details / ⋯** on any row gets one new control: **Run as station / Run as sets / Run on timer**, defaulting to the classifier's answer. This is the athlete's escape hatch for a miss (§3.2). It's stored on the session's feedback like `swap` / `adjusted` (`applyDose` pattern), so it doesn't silently rewrite the program.

### 1.8 Finishing the session / RPE

- **Finish session** stays where it is. If stations are left not-done, the confirm reads **"2 stations not done. Finish anyway?"** ("stations", not "sets"). Lifts left open keep "sets". Mixed counts are listed by kind: "1 station, 2 sets".
- Session RPE (CR-10, `arc_load_v1`) is asked once at the finish, exactly as today. For a session with no lifts, the prompt reads **"How hard was the session?"** It's health data, under the existing rules. There's no per-station RPE in v1.
- The interval close sheet (`closeIntervals`) keeps its block RPE. If its "Finish session" path fires while stations are still open, it goes through the same confirm.

### 1.9 Looking back on Train (`PerformedRow`, `TodayScreen.tsx` ~L326)

| Kind | Performed line | Today |
|---|---|---|
| Station, no tally | **✓ Station done** | "3/18 rounds · 0:30 of work" or `BW×5, BW×5` |
| Station, with tally | **✓ 6 made · 9 attempts** (or **6 made** if attempts weren't taken) | n/a |
| Station, per side | **✓ L 5 · R 5** | n/a |
| Station, rounds | **✓ 3 of 3 rounds** | `BW×5 …` |
| Station not done | **— Not done** (dim) | "0/… rounds" |
| Interval | `6/6 rounds · 2:30 of work` (unchanged) | same |
| Lift | `135×8, 135×8` (unchanged) | same |

The plan-vs-did comparison counts **stations done** for stations, not sets. `plannedSets` (`TodayScreen.tsx:435`) excludes stations, and a separate "Stations 3/3" tally sits next to it. A station is never counted toward volume (`tallySession`).

---

## 2. The station primitive, fully baked

One component, `SkillBlock`, takes one parameter: **`modality`**. The modality changes skin and words, never the behavior. Behavior is always: target → optional bookkeeping → Done / Next.

### 2.1 Modality skins (one parameter, distinctly Zeroed)

The base is the shared Zeroed card (the `ivl-block` family, mono numerals, the confirmed/pending tokens, the lock-on arrival). The modality picks four things: **glyph**, **tally noun**, **pip geometry**, and **completion motion**.

| Modality | Glyph | Tally noun | Pips | Done motion |
|---|---|---|---|---|
| `court` (basketball, finishing / shooting) | ◆ arc | make / attempt | dots along an arc | net-swish: pips collapse into the check |
| `throw` (pitching, QB, javelin) | ◎ target | throw / strike | concentric rings fill | ring pulse outward |
| `strike` (martial arts, boxing) | ▸▸ combo | round / clean rep | horizontal ticks | two-beat stamp |
| `gym` (gymnastics, holds, skills) | △ apex | stuck / attempt | vertical bars | settle: bars align and lock |
| `rtp` (return-to-play, rehab) | ✚ ladder | clean rep / side | L │ R columns | slow fill, no flourish |
| `general` (default) | ◆ | rep / attempt | dots | standard check |

Where modality comes from, in order: the exercise's `modality` if the writer set it → the session's track (`TrackRow.name` / `purpose`) → `AthleteRow.sport` → `general`. This is a display hint only. It never changes classification.

### 2.2 Target types

| Type | Written as | Head reads | Optional bookkeeping |
|---|---|---|---|
| **N makes** | `6 makes` | **6 makes** | make (+), attempt (+) |
| **N / side** | `5/side`, `5 each leg` | **5 / side** | L and R, each with its own check |
| **N possessions** | `8 possessions` | **8 possessions** | possession tick |
| **Rounds of N** | `3 × 5` (inherited station) | **3 rounds of 5** | round pips |
| **Quality / technique** | no count (`reps` empty or words) | the words, e.g. **Clean drop-steps** | none |

### 2.3 States

1. **Ready:** target, guide line, cue. Primary **Done / Next**. Secondaries: ▶ elapsed, ◷ rest.
2. **Mid-station:** shown once anything's tapped (a pip, a make, a clock). Shows tally and/or clocks. Primary is still **Done / Next**. The status line reads the tally ("4 of 6 made") or the rest ("Resting 1:12 — go when you are ready" past the suggestion).
3. **Target reached** (tally hits N): the primary gets the "ready" glow and the copy reads **"Target hit — Done / Next"**. **It does not advance on its own.** A miss can mean one more attempt.
4. **Done:** ✓ **Station done**, plus the tally summary if there is one. Secondary **Not done yet** (undo). The card collapses to one line in the list. Tapping it expands it again.
5. **Undo (Not done yet):** restores the mid-station state with the tally kept. The list does not jump back. The station is just open again.
6. **Skipped at finish:** reads **— Not done** on look-back.

### 2.4 Makes vs attempts: the deferred bet, decided

**Required:** nothing beyond Done / Next. A sweaty, one-tap station always completes.

**Optional, zero setup:**
- **Make tap.** The big numeral is itself the button (tap the "0 / 6"). Each tap = one make, and a long-press takes one off. It's a big target that works with a wet thumb.
- **Miss tap.** A small "miss" chip beside it. Attempts = makes + misses. Most athletes will only ever tap makes. That's fine: the log reads "6 made" with no attempts.
- If the athlete taps Done / Next with no tally, the log is complete-only (today's v1).
- With a tally, Done / Next logs `{ made, attempts? }` on the station's rows. A **Quick-fill** affordance appears under the target only after Done ("Log makes? 6 / __"), and it dismisses itself on the next scroll. It's never a modal.

Data shape: the existing `SetLog` rows already back a station (`skillDoneLogs`). `made` / `attempts` ride on those rows as optional numbers. No new table. This is the only field this spec names.

Health-data note: makes/attempts are performance data, not health data. Session RPE stays the only health datum taken here, under existing rules.

### 2.5 Per side

Two columns, **L** and **R**, each with a check (and an optional count for `5/side`). Checking L doesn't advance anything. Checking R doesn't advance anything. When both are checked, the primary reads **"Both sides — Done / Next"**, and it still waits for the tap. Done / Next with one side unchecked is allowed. The look-back reads "L 5 · R —".

### 2.6 Cue and quality notes

The cue sits under the target, always visible, never truncated on the active station. Quality rules ("skip if the knee talks", "miss = one extra") live on the cue, as written by the coach. Style: a quiet left rule in the modality's accent, so it reads as the coach talking. The cue is the only coach copy on the card. No "tips" carousel.

### 2.7 Clocks

- **Elapsed** ▶ / ❚❚ is a count-up the athlete started. It shows in the head numeral slot only while it runs (it never shares that slot with the tally: the tally wins, and elapsed moves to the status line).
- **Rest** ◷ is started by the athlete and counts up. Past `rest_s` it reads "go when you are ready". It ends nothing.
- Neither clock beeps, vibrates, or advances. Done / Next stops both. (That's shipped behavior; keep it.)

### 2.8 In one session, next to the other two primitives

Three primitives, one visual family:

| | Lift | Station | Interval |
|---|---|---|---|
| Glyph | ▮ | ◆ (modality) | ◷ |
| Body | set grid (weight × reps, RPE) | target + optional tally/pips | dose + timeline |
| Primary | ✓ per set | **Done / Next** | **Start intervals** |
| Who advances | the athlete, per set; rest auto-starts | the athlete, per station | the clock |
| Done reads | `135×8, 135×8` | ✓ Station done / 6 made | 6/6 rounds · 2:30 of work |

The kinds stay visually distinct: the station card has no grid lines and no columns. The interval card keeps its timeline bar. The lift keeps its rows. All three share the card radius, the type scale, the mono numerals, and the arrival lock-on.

---

## 3. Classification rules

### 3.1 The options compared

| Option | Gets "Play Strong" right? | Failure case |
|---|---|---|
| **A. Coach tag only** | Only if tagged | Every untagged drill is broken until the writer remembers. Old programs stay broken. |
| **B. More keywords** | Only if "arc"/"strong" is added | The next named drill ("Mikan series", "Euro into contact") misses. "Strong" false-positives "Strong-arm row". |
| **C. Session context** | **Yes**, if the session is anchored as skill | Can over-reach: push-ups or suicides in a skill session would become stations unless guarded. |
| **D. Library / track tags** | No (it's not in a library) | A sport-specific drill name is never in a library. Works well as a *guard* ("this is a known lift"), badly as a source of skill. |
| **E. Dose shape** | No (`3 × 5` looks like a lift) | Strong positive for makes / possessions / per-side. Says nothing about plain reps. |

### 3.2 Recommendation: A first, then C guarded by D and E

The tag is the truth when it's present. Context fills the gap when it's absent. The library and conditioning guards stop context from over-reaching. Dose shape is one anchor signal among several, never the only path. Plus three non-classifier pieces:

- **Writer contract:** the agent writing programs always sets `kind` on every exercise in a session that contains any station or any interval. Inference is the safety net for old and hand-written programs, not the plan.
- **Athlete escape hatch:** "Run as station / sets / timer" in Details (§1.7). Every miss is one tap from fixed, today.
- **No session mode:** context only *colors* untagged rows. Each row still ends up exactly one kind.

### 3.3 Decision rules (implementable)

Inputs: the exercise, its session (`RoutineRow`: `session_type`, `exercises`, track), and the flag.

```
classify(ex, session) -> 'skill' | 'interval' | 'sets'

0. Flag off                         → today's behavior exactly (intervalPlanFor(ex, false) ? 'interval' : 'sets').
1. Athlete override for this session (Details) → that.
2. ex.kind === 'interval'           → 'interval'.  (always)
3. ex.kind === 'skill'              → 'skill'.     (always)
4. Protocol named outright (HIIT / Tabata / EMOM / "intervals") in name or reps
                                    → 'interval'.
5. Strong skill signal on the row itself:
     quality target in reps or name (makes / possessions / per-side)   [E]
     OR skill name (finishing, shooting, layups, footwork, …)          [today's SKILL_NAME]
                                    → 'skill'.
6. Session is skill-anchored (§3.4) AND the row is NOT guarded (§3.5)  [C]
                                    → 'skill'.   (this includes a work/rest dose like 6 × 10s / 50s)
7. intervalPlanFor(ex) parses       → 'interval'.
8. Otherwise                        → 'sets'.
```

Rule 6 comes before rule 7 on purpose. That's how a leftover `6 × 10s / 50s` skill dose in a skill session becomes a station, not HIIT. The guards keep real conditioning in that same session on the timer.

### 3.4 Skill-anchored session

A session is skill-anchored if **any** of these is true:

- `session_type` is `skill` (a new value the writer uses; see open call 1), or contains `skill` / `technique` / `practice`.
- Its track is a skill track: the track carries a skill purpose (`TrackRow.purpose` / `name` matching skill / technique / on-court). A child track inherits through `parent_track_id`.
- **At least one exercise in it is skill by rules 3 or 5** (an explicit tag, or a strong row signal).

`session_type === 'conditioning'` alone does **not** make a session interval-led, and it doesn't undo skill anchoring. Phil's session can be typed `conditioning` and still be anchored by Finishing.

### 3.5 Guards: rows that never inherit skill from context

- **Known lift (D):** the name resolves to a library movement (push-up, squat, lunge, plank, pull-up, …), or the row carries a load (`ex.load` names a weight or %), or its tracking type is `weight_reps`.
- **Conditioning movement:** the name is a conditioning piece (sprint, suicide, shuttle, gasser, 17s, bike, row, ski, assault/air bike, rope, burpee, carry). This is a short, stable list of *conditioning* words, not a growing list of *drill* names. It's a much smaller and slower-moving set.
- **Tagged elsewhere:** any `kind` (already handled by rules 2–3).

### 3.6 Examples

| Exercise | Session | Rule | Result |
|---|---|---|---|
| Finishing — `6 makes` | basketball skill | 5 (quality target + name) | **Station** |
| **Play Strong inside the arc — `3 × 5`, no load** | basketball skill (anchored by Finishing) | 6 | **Station, Done / Next** |
| Play Strong inside the arc — `3 × 5` | lift day, nothing anchoring | 8 | Sets. Needs a tag or the override; a skill drill on a lift day without a tag is the one honest miss. |
| Mikan drill — `6 × 10s / 50s` (leftover syntax) | basketball skill | 6 (before 7) | **Station**, shows "6 × 10s / 50s" as the target. Window/rest copy only. |
| Suicides — `6 × 25s / 35s` | same basketball skill session | 6 guarded (conditioning word) → 7 | **Interval timer** |
| Bike Tabata — `8 × 20s / 10s` | any | 4 | **Interval timer** |
| Defensive slides — `6 × 20s / 40s`, `kind: 'interval'` | basketball skill | 2 | **Interval timer** (tag wins) |
| Push-ups — `3 × 15` | strength day | 8 | **Sets (bodyweight grid)**, unchanged |
| Push-ups — `3 × 15` | basketball skill | 6 guarded (library lift) → 8 | **Sets** |
| Plank — `3 × 45s` | basketball skill | 6 guarded (library) → 7 or 8 | Sets / time, as today |
| Single-leg hops — `5/side` | return-to-play | 5 (per side) | **Station, L/R** |
| Kata — no dose, cue only | martial arts | 6 (anchored by track) | **Station, quality target** |
| Anything | flag off | 0 | Exactly today |

---

## 4. Session-level CTA rules

### 4.1 Session shape

Classify every exercise (§3.3). Then:

- **Interval-led:** every exercise is `interval`. A session typed `conditioning` also counts as interval-led if every non-interval exercise is `sets` *and comes after* the first interval (e.g. a cool-down walk). It never counts if any exercise is a station.
- **Skill-led:** ≥1 station and no intervals.
- **Mixed:** ≥1 station and ≥1 interval, or any other mix.
- **Lift-led:** everything else (today's default).

This replaces `intervalLed` (`TodayScreen.tsx:310`). The key change: **any station in the session means it does not start on the timer.**

### 4.2 Labels

| Shape | Card + sheet primary | Sheet secondary |
|---|---|---|
| Interval-led | **Start intervals** (▶, primes cue audio) | Open session |
| Skill-led | **Start session →** | — |
| Mixed | **Start session →** | — |
| Lift-led | **Start session →** | — |
| In progress | **Resume →** / **Resume session →** | — |

No skill-specific CTA ("Start stations") is added: a session is a session. This keeps "Start intervals" meaning exactly one thing: the timer starts on the next screen.

### 4.3 What `?go=intervals` may do

Only this: **if the session shape is interval-led and the first not-done exercise is an interval, start that interval's timer on arrival.** Otherwise drop the param and open normally. In particular:

- It never starts a station (stations can't start a timer at all).
- It never skips past a not-done station or lift to reach a later interval.
- It's still dropped right after it's read (`replace`), as today.
- Flag off: today's behavior, unchanged.

---

## 5. Acceptance cases

Flag on unless stated otherwise.

1. **Phil's session** (Finishing `6 makes` → Play Strong inside the arc `3 × 5` → Suicides `6 × 25s / 35s`, typed `conditioning`): the Train card and the sheet show **Start session →**. The text "Start intervals" appears nowhere on the card or sheet.
2. Same session with Finishing written as `6 × 10s / 50s` and no `kind`: still **Start session →**, and Finishing renders as a station.
3. **Play Strong inside the arc** in that session renders the station card with **Done / Next**. No set grid, no weight column, no "BW", no load chips, no auto rest clock after a tap.
4. Tapping Done / Next on Play Strong marks it done and makes Suicides active. The interval timer does **not** start until the athlete taps Start intervals on the Suicides card.
5. On Suicides, the timer behaves exactly like today: ready beat, beeps, auto-advance between rounds, block RPE at close.
6. Opening that session at `/workout/:id?go=intervals` lands on Finishing with no timer running, and the `go` param is removed from the URL.
7. **Bike Tabata + Row intervals** typed `conditioning`: the card shows **Start intervals**. One tap opens Workout with the Tabata timer at the ready beat. It auto-advances as today.
8. A Tabata with `kind` unset inside a basketball skill session still runs on the timer (rule 4).
9. An exercise tagged `kind: 'interval'` named "Footwork ladder" runs on the timer.
10. **Push-ups 3 × 15 on a strength day** render the bodyweight set grid, identical to today (snapshot). Push-ups inside the basketball skill session also render the set grid.
11. Station states: target reached does not advance. Per-side L and R checked does not advance. Elapsed and rest clocks running past their suggestion do not advance. Only Done / Next advances.
12. A station completes with a single tap and no tally. Look-back reads **✓ Station done**.
13. With 6 make taps and 3 miss taps, then Done / Next, the look-back reads **✓ 6 made · 9 attempts**.
14. Not done yet restores the station with the tally kept and doesn't move the active exercise.
15. Add-cta in a skill or mixed session shows **◆ Station** first. A station added there saves `kind: 'skill'`. A library push-up added there renders as sets.
16. Details → Run as sets on a misclassified station turns it into the grid for this session only. The program is unchanged.
17. Finish with one station open: the confirm says "1 station not done". Session RPE is asked once, under existing rules.
18. Look-back on Train never shows "rounds · of work" for a station, and never shows a station's rows as `BW×n`.
19. Rail rest copy reads the station version while a station is active, and today's copy while a lift is active.
20. **Flag off:** `intervalLed`, `isIntervalBlock(ex, false)`, Train labels, `?go=intervals`, the add-cta (Exercise / Intervals), the set grid, and the performed lines all match pre-flag behavior. Existing `skillBlock.check.ts` / `intervals.check.ts` flag-off assertions keep passing.
21. `coach_v1` is still off for every athlete after this ships.

---

## 6. What not to do

- Don't add a whole-session "skill mode". Context colors untagged rows. It never turns a Tabata into a station or a push-up into a drill.
- Don't let any clock (elapsed, rest, window, target reached, both sides checked) advance a station.
- Don't change how real intervals start, beep, auto-advance, or log.
- Don't fix this by adding "Play Strong" or "arc" to `SKILL_NAME`.
- Don't make makes/attempts required, and don't open a modal to collect them.
- Don't write production app code or GitHub patches from this doc without the open calls below being made.
- Don't turn on `coach_v1`.

---

## 7. Open calls for Phil (each with a recommended default)

1. **Session type:** should the writer start emitting `session_type: 'skill'` for skill-led days? *Default: yes. It's the cheapest strong anchor and costs no migration (free text today).*
2. **Writer contract:** must the program-writing agent tag `kind` on every exercise in any session that holds a station or interval? *Default: yes, starting now. Inference stays as the net for existing programs.*
3. **Makes vs attempts:** should it ship in this pass, as the optional tap-the-numeral tally? *Default: yes, optional, makes-only by default with the miss chip available.*
4. **Conditioning guard list:** should the short conditioning-word list (sprint, suicide, shuttle, gasser, 17s, bike, row, ski, assault bike, rope, burpee, carry) be accepted as the guard? *Default: yes. Review it once per new sport, not per drill.*
5. **Athlete override:** should "Run as station / sets / timer" in Details ship with this, or wait? *Default: ship it. It turns every future miss into one tap instead of a TestFlight.*
6. **Modality skins:** should all six ship at once, or `court` + `general` first? *Default: `court`, `rtp`, and `general` first (Phil's real usage). `throw`, `strike`, and `gym` follow on the same primitive.*
