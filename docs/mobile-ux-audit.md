# Mobile-first UX audit

A full pass over every screen, tab and sheet in the app, from the perspective of
the only device it's actually used on: a phone, often held at arm's length, in a
gym, one-handed, sometimes with no signal.

Three problems ran through the whole app. Everything below is downstream of them.

1. **The type scale bottomed out at 9.5px.** Body copy was 14px, secondary copy
   12px, and the mono labels that carried most of the app's meaning — statuses,
   prescriptions, tags, nav labels — were 9.5–11px.
2. **Every screen said everything at once.** Detail, explanation and rationale
   were rendered inline, permanently, next to the thing they described. Program
   was seven stacked prose sections. Train stacked three attention cards above
   the sessions. The movement screen printed two paragraphs per pattern before
   you could score one.
3. **The instrument voice leaked into places it didn't belong.** Telemetry
   strips like `INSIGHTS 6 · 2 LIKELY · 1 P1` and `0 CONFIRMED · 2 LIKELY · 3
   HYP` sat at the top of screens as if they were a summary. They are internal
   model state, not something anyone acts on.

---

## The system

### Type

A mobile-first scale, tokenised so a screen can't quietly reintroduce 10px text.

| Token | Size | Use |
|---|---|---|
| `--fs-micro` | 12px | mono labels, chips, badges — the smallest legal size |
| `--fs-xs` | 13px | secondary metadata |
| `--fs-sm` | 15px | supporting copy |
| `--fs-base` | 16px | body — the default |
| `--fs-lg` | 18px | card titles |
| `--fs-xl` | 22px | section / exercise titles |
| `--fs-2xl` | 28px | screen titles |
| `--fs-3xl` | 36px | hero numbers |

Body went 14px → 16px, line-height 1.5 → 1.55. `Inter 700` is now loaded — the
scale sets titles and numbers at 700 and the browser was synthesising it.

### Touch

`--tap: 48px` and `--tap-lg: 54px`. Buttons, inputs, score pickers, RPE keys and
the set-complete checkbox all sit on that floor. Specific changes:

- Set-row inputs: 44px → 52px, font 16px → 18px.
- RPE keys: 42px → 50px. Felt chips: 28px → 40px.
- Slider thumb: 18px → 30px, with margin making the touch band ~44px.
- Back buttons: were a 28px sliver, now a real 44px `.icon-btn`.
- Bottom nav: 60px → 68px, icons 20px → 24px, labels 10px → 12px, active tab in
  signal yellow rather than a 1px top border.

### Sub-screens

Detail moved out of pages and into a single `Sheet` primitive: capped at 88dvh,
scrolls internally, has a grab handle, a 40px close target, and an optional
sticky action footer. The old sheet grew unbounded — a long body could push its
own CTA off-screen.

### New primitives

`Sheet`, `PageHeader`, `Stat`/`StatGrid`, `Meter`, `Ring`, `Chip`, `Row`,
`Disclosure`, `Banner`. Each exists to replace a sentence with something
scannable. Screens now compose these instead of hand-rolling inline styles.

---

## Screen by screen

### Train (`/app/today`)

The busiest screen and the worst offender: a telemetry strip, an offline note, a
recap card, a read line, a retest card, an instruction paragraph, a week pager,
three session cards each with an intent paragraph plus two buttons, a close-week
block, and a day strip stranded in a desktop-only rail.

- **One attention slot.** Retest / recap / offline-pending are ranked and at most
  one shows, as a `Banner`. Previously all three could stack.
- **The week became a picture.** A progress ring (`1 of 3`) plus a seven-day
  strip replaces the `2/4 done` string, and the day strip is no longer
  desktop-only.
- **One button per screen.** Only the next-up session carries a Start. The others
  are tappable cards. Each card is now name + status chip + one metadata line.
- **Session detail moved to a sheet** — intent, the full exercise list, day
  pinning, and the secondary actions ("Review / edit", "Log again").
- Cut: "Do whichever fits — gym, gear, time. Tap a logged one to edit.",
  the per-card intent paragraph, the `INSIGHTS 6 · 2 LIKELY · 1 P1` strip, and
  the first-visit paragraph (now two short lines).
- **The read** is a card with the claim and a confidence meter, instead of
  `THE READ · LOWER CHAIN · 72% CONFIDENT ›` in 11px mono.

### Workout (`/app/workout/:id`)

The screen that matters most, used with a bar in your hands.

- **Header rebuilt.** Four mono telemetry fields in a 28px strip became a title,
  one metadata line (`12:34 · 6/18 sets · RPE 8`), and a progress bar.
- **Exercise names 15px → 22px.** Inputs 52px tall at 18px.
- **Three info buttons became one.** The (i) insight button, the READING chip and
  the How-to tag each opened their own sheet; they're all "tell me about this
  lift", so they're one **Details** sheet, sectioned: how-to, watch-for, your
  cue, why it's in your program, what we're reading.
- **The note field folds away.** Seven exercises meant seven always-open
  textareas — most of the page height, for a field almost nobody fills in
  mid-session. Now `+ Add a note`.
- Completed sets dim so the eye lands on the next empty row.
- The RPE column header showed `—`; an empty column now shows nothing.
- Footer dropped the duplicated set count (it's in the header).
- Brief and debrief copy roughly halved, both now proper sheets.

### Program (`/app/program`)

Seven stacked sections, each with its own explanatory paragraph — about six
phone screens.

- The phase instrument (arc, week dots, retest countdown) stays open at the top.
- Everything else is a `Disclosure` row that states its own size: *Next week*
  (with the directive as a chip), *Sessions (3)*, *What graduates you to Power
  (2)*, *Non-negotiables (3)*, *The road ahead (2)*, *Recent weeks (3)*.
- Cut the section preambles ("Coach-designed around the lifts you actually log —
  same names, so your loading carries forward.", "What graduates you to Power.
  Awaiting evidence.", "What's after Strength. The shape is set; the exact
  sessions build when you graduate in.").
- "Rebuild from my lifts" was 11px yellow mono text that rewrites your program;
  it's now a real button inside the Sessions section.

Result: one screen instead of six.

### Coach (`/app/coach`)

- Dropped the `0 CONFIRMED · 2 LIKELY · 3 HYP` strip above the conversation.
- Chat bubbles 14px → 16px; suggestion chips 12px → 15px with real padding.
- Ask button is now filled signal yellow at 48px, with a genuine disabled state.
- Opener and the read-only disclaimer cut to one line each.
- Proposed-change Apply/Dismiss were unstyled native buttons; now real buttons.

### You (`/app/profile`)

Was a near-empty tab: a name, a sign-out button, one editable target — and
sessions/week and training age shown as an unexplained mono string,
**not editable**, despite both driving the program's shape.

- Now a settings list: the target as a large tappable card, then editable rows
  for sessions/week, training age and weight units, then rows into History,
  the latest recap, and Retest.
- Each edit opens a focused sheet rather than expanding the page.
- **Made offline-first.** It was the only loop screen reading straight off the
  network with no cache and no error path — a failed request left it on
  skeletons indefinitely, which is exactly what happens in a gym basement.
- Renamed to **You** and moved to the last nav slot.

### History (`/app/history`)

Chips instead of mono status strings, taller sparkline (48px → 80px), lift
highlights as real 36px tap targets, and the per-lift sheet leads with a stat
grid. Dropped the phase chip repeating on every row.

### Recap (`/app/recap/:id`)

Already the strongest screen. The directive is bigger, the stats use the shared
`StatGrid`, and the header uses the standard `PageHeader`.

### Onboarding funnel

- **Splash**: two mono paragraphs at 11–12px → one 18px line.
- **Arena / Limiter**: option cards were mono 14px titles with 12px descriptions;
  now 18px titles, 13px descriptions, 88px/72px minimum heights. Headlines use
  the shared `screen-title`.
- **Probe reveal**: axis rows go from a 10px mono label + 12px claim to a proper
  section header, 16px claim, and a 6px confidence meter (was 3px).
- **Target / Identity / Training context**: consistent eyebrow + hero headline;
  slider values at 28px.
- **Auth sheet**: rebuilt on `Sheet`; the OTP field is 60px tall at 22px with
  wide tracking.
- **Compute / Calibrate**: log lines 14px → 16px.
- **Post-session revelation**: the two-line uppercase mono telemetry block
  (`DURATION 42 MIN · 18 SETS · CONFIDENCE 0.41 → 0.58`) became a three-tile stat
  grid.

### Movement screen (Retest, `/app/retest`)

Was the densest page in the app: a telemetry strip, an intro paragraph, a
four-line scoring rubric, then per pattern a "why it matters" paragraph, a "HOW"
setup line, a test button, a hint, and a score picker — seven times over.

- Per pattern: a card with the name, the category, a score chip when scored, a
  **Test me** button, and a `?` that opens a sheet with why-it-matters, how to
  test it, what clean looks like, and the 0–3 scale.
- The rubric and both paragraphs left the page entirely.
- Progress is a ring, not `SCREENING 3/7 · WEAK LINKS 1 · STARTED 2m ago`.
- Strength baselines became a compact labelled list.

---

## The composer (follow-up pass)

The chat surfaces — Coach and Change my program — were still unpleasant to
actually type into on a phone. Three separate causes, one shared fix: both
screens had hand-rolled the same textarea, so both had the same faults.

- **Return couldn't break a line on mobile.** Enter sent, and Shift+Enter added
  the newline — a key combination a touch keyboard does not have. A second
  paragraph was unreachable on the only device this app runs on. The composer
  now asks *what kind of keyboard is this* (`(hover: hover) and (pointer: fine)`)
  and behaves accordingly: hardware keyboard keeps Enter-sends / Shift+Enter,
  touch gets return-is-a-newline with the arrow button as the only way to send.
  The field also declares `enterKeyHint`, so iOS draws the right return key, and
  Enter mid-IME-composition is left to the IME.
- **It felt too small for real text.** The font can't shrink — anything under
  16px makes iOS zoom the page on focus — so the room came from everywhere else:
  padding trimmed to `11px 15px`, the cap raised 140px → 176px (about seven
  lines before it scrolls), the pill radius dropped to 20px (a pill only looks
  right one line tall), and the `ASK` / `SEND` label replaced by a round arrow,
  which handed ~90px of phone width back to the draft. The Coach placeholder was
  also too long to fit on one line, which made an empty field look overflowed.
- **The waiting animation read as "still loading", not "reply coming".** It was
  the same shimmer bar the app uses for skeletons. It's now three pulsing dots
  in a coach bubble (`TypingDots`) — the one waiting signal everyone already
  reads correctly — with a resting opacity so reduced-motion leaves them visible.

Both screens now render `ChatComposer` and `TypingDots` from the UI kit, so the
next chat surface inherits all of this instead of re-deriving it.

---

## Bugs found and fixed along the way

- **Strength baselines were hard-coded to kg** while the app defaults to `lb`, so
  a lifter typing `225` was recorded as 225 kg. Now uses `getWeightUnit()`.
- **Profile had no error path** — a failed fetch left it on skeletons forever.
- **Disabled primary buttons** rendered as signal yellow at 40% opacity, a muddy
  olive that still read as a live button. Disabled now has no fill.
- **The dev reset pill** sat on top of the Train tab in the bottom nav.
- **Sheets didn't lock the page behind them**, so flicking past a sheet's end
  dragged the page on iOS. Locking `body` alone isn't enough here — `#root` is
  the scroll container on mobile, so both are locked.
- **The debrief sheet's × meant "commit without a debrief."** The session is
  already finished by the time it opens, so a dismiss gesture silently submitted
  it. The × is gone; Log it and Skip are the only exits. The close-week sheet
  likewise drops its × once the crunch is in flight.
- **The rest pill overlapped the Complete button** once the workout footer grew,
  and the last exercise's chips could sit under the footer. Both now clear it.
- **A completed set looked unfilled.** Dimming the whole row made autofilled
  numbers read like placeholders; only the row's chrome recedes now.
- **The RPE column header was bottom-aligned out of step** with the other column
  labels once its em-dash was removed.
- **Profile's optimistic overlay could mask a value changed elsewhere** — it's
  cleared the moment fresh server data arrives, and correctly persists offline.

## Known dead code (not touched)

`ZeroedInScreen`, `AuthScreen`, `ReframeScreen` and `HookQuestionScreen` are no
longer reachable from any route, and `InsightMovementRow` / `Divider` have no
consumers. That predates this work.

This pass orphaned three more exports: `TelemetryStrip` and `LatencyTick` (the
strips they rendered were removed from Train and Coach) and
`ExerciseInsightSheet` (folded into the workout's single Details sheet). All
left in place — deleting exported components is a separate call.

## Verifying visually

`scripts/preview-loop.mjs` seeds localStorage with a realistic athlete, blocks
the network so the cached view renders, and screenshots every loop screen at
iPhone dimensions. `scripts/preview-funnel.mjs` does the signed-out funnel.
Both need Playwright installed ad-hoc (`npm i -D playwright`) — it is not a
project dependency.

```bash
npm run dev -- --port 5199
node scripts/preview-loop.mjs
```
