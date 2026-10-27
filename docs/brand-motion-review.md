# Brand & motion review

The mobile audit (`docs/mobile-ux-audit.md`) made the app readable and fast on a
phone. This pass asks the next question: does it still feel like **Zeroed**?
Mostly, it didn't. The bones were all there: an instrument voice, a signal
yellow, a reticle that literally zeroes in. But the daily loop had drifted
into a clean, competent, generic dark app.

## Diagnosis: where the brand went

1. **The brand organism left the phone.** The Convergence reticle — the
   wordmark made literal — rendered in exactly two places: one onboarding
   screen and the *desktop* sidebar. On the device the app is actually used on,
   it vanished after the first session. `MonitorReticle` even has a `bottom`
   variant nothing uses.
2. **Its signature move never played.** The reticle timed its collapse with
   `var(--ease)`, a token that was never defined. An undefined `var()` voids the
   whole `transition` declaration, so the cloud snapped to its final position
   instead of converging. *(Fixed.)*
3. **No moment was marked.** Logging a set swapped a border colour. A PR was a
   12px label. Finishing a session ended on a text form, and then (with a
   debrief) dropped you on the **settings** screen, a leftover from when
   Profile pulsed the insight the debrief moved. *(Fixed.)*
4. **The type system has three voices and no rule.** Inter for titles, mono
   caps for labels, and mono for strings that are prose: `2 exercises · last
   Oct 14`, `Logged Mon`, `Sat, Oct 24`, `hypothesis → likely`. The header
   comment says mono is for numbers and metrics. It has spread to dates and
   sentences, which is the "mix of typography" that reads as inconsistent.
5. **Signal yellow is diluted.** The rule is one signal per screen. Program has
   a yellow phase name, yellow week dots, *and* a yellow-bordered card. When
   everything is signal, nothing is.

## The motion system (shipped)

One idea, used everywhere: **things converge on the answer.** Brackets lock
on, letter-spacing tightens onto the wordmark, a check draws itself once the set
is locked.

Rules, so it stays dialed-in rather than gimmicky:

- **Only on real events.** A set logged, a PR typed, a session finished, a tab
  chosen. Nothing loops while you work. The reticle keeps its own hard rule:
  tightness is real confidence, never a timer.
- **Fast in the working loop, generous at finish lines.** ≤ 500ms anywhere a
  bar is in your hands; the one longer moment is after the session.
- **Never blocks input.** Everything is opacity/transform and fires after the
  state has already changed.
- **Readable end state.** The existing `prefers-reduced-motion` rule collapses
  every animation to nothing, and nothing is lost.

| Moment | What happens | Where |
|---|---|---|
| Splash | Wordmark converges from wide spacing inside lock-on brackets; status line and copy follow. Also fixes "INSTRUMENT READY" rendering inline beside the wordmark. | `SplashScreen.tsx` |
| Any button | Gives a millimetre on press (`scale(.975)`). | `.btn:active` |
| Tab change | Signal marker draws out from centre; icon kicks. | `.nav__item::before` |
| Set logged | Check draws, box snaps, ring goes out, light haptic tick (Android; no-op on iOS). Only on the completing tap, never on a resumed draft. | `SetRow`, `lib/haptics.ts` |
| PR | Signal sweep across the row; `PR` badge stamps in. Only when the row *becomes* a PR. | `SetRow` |
| Session finished | **Session zeroed**: check locks on, sets / load moved / minutes count up, PR lifts named. Self-dismisses in 4s; tap to skip. | `SessionZeroed.tsx` |
| Week ring, meters | Fill from empty on arrival. | `.ring__fill`, `.meter__fill` |
| Lists | Today's sessions and History weeks arrive staggered (40ms steps, capped at 200ms). | `.stagger` |
| Recap verdict | PROGRESS / HOLD / DELOAD stamps in. | `.verdict-stamp` |
| The read (Today) | The reticle replaces the generic meter, sized to the read's real confidence. The brand back on the phone. | `TodayScreen.tsx` |

New primitives: `LockOn` (corner brackets), `.converge`, `.stagger`,
`TickingNumber` `format` prop, `tick()`.

## Round two (shipped)

Everything the first pass left as findings, done.

### Workout
- **Today's target, everywhere.** The set header and the one-tap check used the
  program's raw load text, while Train's preview and the hint chip quoted the
  engine's target. So the preview could say 230 and the check could log last
  week's 225. Both now use the target (the uncapped number when *Push it* is on),
  and set 1 no longer carries last session's weight over it.
- **Placeholders preview the tap.** An empty field shows, dimmed and light, exactly
  what ✓ will log into it. An empty RPE now looks empty.
- **Header:** *Why* and *Coach* are icon buttons, so the session name fits.
- **Complete** is a quiet outline until you reach the last lift.
- **Rest timer** docks in the footer above Complete instead of floating over the
  set list. When it runs out, **Rest's up · next set** locks on in its place.

### Feel
- **Haptics** (`@capacitor/haptics`): light per set, heavy on a PR, success at
  the finish, warning when rest is up. This is native in the iOS shell, falls back
  to vibrate on Android web, and does nothing on iOS Safari.
- **Sound effects** (Profile → *Sound effects*, **off by default**: every Web
  Audio play can duck your music): a click per set, a rising fifth on a PR, a
  three-note chord closing onto the octave at the finish. These are short sine
  tones, never longer than half a second. The rest beep keeps its own switch.
- **Starting a session** zooms into it (View Transitions; Chrome, Safari 18+).

### Moments
- **Week zeroed.** When the week is full, the brackets close on the ring. The
  finish screen says *Week zeroed* only for the session that filled it.
- **Coach presence.** While the thread is empty, the live reticle (with its state
  label) sits at the top of Coach. Suggestion chips meet the 44px floor.

### System
- **History** lift pills look like what they are, a door to the lift's line:
  the name in Inter, the set in mono, and a trend glyph. The instruction sentence
  is gone.
- **Program** has one yellow: the phase name. Week dots and the *Change the
  program* card went to text tones and the standard border.
- **Type rule, in code:** `.readout` for the big mono instrument words (phase,
  recap verdict) and `.meta` for metadata lines (Inter, tabular figures). Mono
  is for numbers, units, labels and readouts; Inter is for anything read as words.
- Today: spacing under *The read*.

## Intervals and adding to a session (shipped)

HIIT runs inside the session instead of in a separate timer app, and the + at
the foot of a workout adds a movement or an interval block instead of only a set.

- **The prescription is the setup.** The coach already writes blocks as rep specs
  (`8 × 20s on / 40s off`, `Tabata`, `EMOM 10 min`, `10 x 30/30` on a bike), so
  `engine/intervals.ts` reads them straight into a timeline. Nothing new is
  stored: a block built by hand is written back in the same shape, and one row of
  the set grid holds the work of a set (`rows: 'set'`) or of a round
  (`rows: 'round'`). An interval spec always logs as time.
- **One tap from Train.** A conditioning day (or one that is nothing but blocks)
  shows **Start intervals** instead of Start session. The tap unlocks audio
  (`lib/intervalCues.ts`; iOS only lets a gesture start a context) and lands on
  the timer's ready beat via `?go=intervals`.
- **Wall-clock, not a counter.** A locked phone or a backgrounded app comes back
  to the right second with the rounds it slept through banked. Rounds are written
  into the grid as they finish, so the draft holds them if the phone dies. The
  screen stays on while a block runs (`lib/wakeLock.ts`).
- **Adding to a session.** Picked movements arrive with a dose: your last sets of
  it, else a table default (`engine/addExercise.ts`). They ride in
  `feedback[i].extra` (persisted by the draft like a swap) and are filed in the
  snapshot with `added: true`. A programmed block re-dosed for the day is marked
  `adjusted`.

| Moment | What happens | Where |
|---|---|---|
| Phase change | Brackets re-lock on the dial, the phase word tightens onto itself, one wash of the phase colour (amber ready, yellow work, blue rest). | `IntervalTimer.tsx` |
| Last 3 seconds | Number pulses each second in the phase colour; the arc glows; a blip and a light tick. | `.ivl__num--count` |
| Sound | **Zero-beat**: two tones a few percent apart beat, then glide onto one note, which is how a radio is tuned onto a signal. The 3-2-1 climbs C6–D6–E6 toward the G6 the go locks onto. Rest is the lock released (a unison coming apart and falling). The last round locks a chord. Halfway is two light pings; done is the session chord zero-beating in. Designed once in `engine/cueSound.ts` and rendered sample by sample; the iPhone plays the bundled WAVs (`npm run cues:render`, held to the design by `cueSound.check.ts`) through the native `ZeroedCues` plugin, so cues sound in Silent Mode and duck music instead of stopping it. | `engine/cueSound.ts`, `plugins/zeroed-cues` |
| Block done | *Intervals zeroed*: the session-finish mark, rounds count up, optional RPE, **Finish session** when nothing else is left. | `IntervalTimer.tsx` |
| Movement added | Card rises into place and the brackets lock onto its title. | `.ex-arrive` |

## Still open
- Retire the remaining inline `fontFamily: var(--font-mono)` styles screen by
  screen in favour of `.readout` / `.meta` / `.num`.
- Shared-element morph from the session card title into the workout header
  (needs a per-card `view-transition-name`).
