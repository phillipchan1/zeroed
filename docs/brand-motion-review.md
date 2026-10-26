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

## Screen findings (not yet addressed)

Ordered by how much they'd improve the feel per hour spent.

### Workout, the screen that matters most
- **Prescription is stated twice.** The chip `225 LBS · +5 FROM LAST WEEK` and the
  column header row `LB 225 lbs / REPS 5` say the same thing. Keep the chip;
  make the header just column labels.
- **The `RPE` placeholder looks filled.** It renders bright and bold while
  `lb`/`reps` placeholders are dim, so an empty RPE reads as entered.
- **The title truncates** (`Lower A — Squat…`) because `WHY` and `COACH` pills
  take half the header. Icon-only buttons would give the name its width back.
- **`Complete workout` goes full signal-yellow after 1 of 13 sets.** It competes
  with the next set for the eye. Keep it quiet (outline) until the last
  exercise is reached.
- **The rest pill floats over content** (covers `Add set` and the felt chips).
  Dock it in the footer above Complete, where it can't cover a tap target.

### Today
- No gap between *The read* and the *Done with the week?* banner.
- The week ring is the best "instrument" element in the app. When the last
  planned session lands, it should close with a lock-on: **Week zeroed**.

### Coach
- The empty state is a void under three suggestion chips. Put the reticle (large,
  with its state label) at the top as the coach's presence. That one element is
  already a live picture of what the coach knows.
- Suggestion chips are 42px, under the 44px floor (`check-layout` notes).

### History
- Lift pills are tappable but look like tags, and the subtitle (*"Tap a session
  to review it, or a lift…"*) is instruction copy compensating for that. Give
  them an affordance (a chevron or a 3-point sparkline) and drop the sentence.

### Program
- Three yellow signals on one screen. Make the phase name the only one; the week
  dots can be text-coloured and the *Change the program* card can use the
  standard border.

### Type rule (proposed)
- **Mono** = numbers, units, and labels (eyebrows, chips, column heads).
- **Inter** = anything read as words, metadata lines included
  (`2 exercises · last Oct 14` becomes Inter with mono only on `2` and `Oct 14`).
- Big "instrument readouts" (phase name, recap verdict) get one named class,
  `.readout`, instead of the inline `fontFamily: var(--font-mono)` styles they
  use today.

## Next fun, ranked

1. **Native haptics on iOS.** `navigator.vibrate` is ignored on iOS, including in
   the Capacitor shell. Add `@capacitor/haptics` and swap the body of `tick()`:
   light impact on a set, success notification on finish, heavy on a PR. This is
   the single biggest "dialed-in tool" upgrade, and it needs a TestFlight build.
2. **Week zeroed.** The ring-closing moment above.
3. **Rest timer lock.** A countdown ring around the pill; at zero, the brackets
   lock on and it pulses once (pairs with the existing beep/buzz).
4. **Coach presence.** The reticle as the coach's avatar (above).
5. **Session card → workout shared transition** via the View Transitions API
   (Safari 18+), so starting a session feels like zooming into it.
6. **One sound setting.** Rename *Rest timer sound* to *Sounds* and add an
   optional soft click on set-complete.
