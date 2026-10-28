# Onboarding and sign-in

Written 27 Oct 2026. What a person sees from first launch to session one, why,
and what's next.

## Why it changed

Three things were wrong, and the first two compound:

1. **No way back in.** Signed out, the app only offered the new-athlete funnel.
   A returning athlete had to answer the arena, limiter and probe questions to
   reach the email field. `funnel/AuthScreen.tsx` was the only plain sign-in,
   and nothing rendered it.
2. **iOS signed you out on every cold launch.** `getSessionUser` asked Better
   Auth for the session without the signed bearer. The iOS shell
   (`capacitor://localhost`) is cross-site to the Worker, so the `SameSite=Lax`
   cookie never rides along: the answer was "no session", and the app cleared
   the user. A launch with no signal did the same, because any failed
   `get-session` counted as signed out.
3. **Questions on both sides of sign-in.** Classic flow: arena → limiter →
   probe → *email* → target → name → training age → acknowledgment → build.
   Nine screens, with the sign-in wall in the middle.

## The flow now

```
Signed out
  Welcome ──┬── Get started ──► intake ──► plan ──► Save: email → code ──► build ──► Today
            └── I have an account ──► email → code ──► Today
                                                 └─ (no plan on that email) ──► intake, signed in
```

**Welcome** (`WelcomeScreen.tsx`). The wordmark still locks on, then two
buttons at thumb height: *Get started* and *I have an account*. No more "tap
anywhere".

**Sign-in** (`SignInScreen.tsx`), one screen for both doors:

- Email, then a 6-digit code. No password, and no link that opens in the wrong
  browser.
- The email is remembered on the device, so a returning athlete taps *Send code*
  and nothing else.
- The code field takes iOS one-time-code autofill (iOS 17+ offers the code from
  Mail above the keyboard) and a paste, including "123 456". It verifies on the
  sixth digit, with no button.
- *Resend* has a 30 s cooldown. *Use a different email* is always there, and
  errors say what to do next ("That code has expired. Tap Resend…").
- Either door works for either athlete. The athlete row decides what happens
  next: an existing plan goes to Today, mid-onboarding resumes, and an email
  with no plan goes to the intake signed in, saying which email it is in case
  it's the wrong one.

**Coach intake** (`CoachIntake.tsx` + `engine/intake.ts`, behind
`onboarding_agent_v1`). It's a short conversation; you never browse a catalogue:

| Turn | Asks | Notes |
|---|---|---|
| 1 | What do you train right now? | Multi-select across modalities, or "tell me in your own words" ("I lift, run on weekends and do BJJ" → Lifting, Running, Combat) |
| 2 | What matters most for the next three months? | Options lead with what they train: "Play basketball better", "Train for my running" |
| 3 | How long have you been lifting consistently? | Three buckets → training age 0 / 2 / 4. Skipped for "Nothing yet" |
| 4 | Only if the plan uses it | Sport: which, season, lift days, game days. Endurance: days a week. Total: recent lifts (optional) |
| — | Here's where I'd start | Coach read, the week as lanes, starting point, optional name, *Save my plan* |

Answered turns collapse into the thread above; tap one to change it.

The starter pack is **inferred** from the focus answer (sport → S&C for your
sport, endurance → Hybrid, and so on), shown as "Starting point", and
changeable there. Every number on the plan comes from `resolveStarterPack`;
the card length copy is quoted verbatim.

The plan shows one lane per thing they train. Strength is **Planned** (Zeroed
programs it). Sport, runs, rides, classes and mobility are marked **Coach
knows**. They're appended to the obstacle text as "Also trains: …", so the AI
designs session one with them in view. Nothing claims scheduling the engine
doesn't do yet; that's the arc work in `one-athlete-one-arc.md`.

**Where the AI sits.** The intake is deterministic: instant, offline, and
covered by `intake.check.ts`. The model's time goes to designing session one
after save (the existing calibrate beat) and to coaching from then on.

**Flag off** (today's default build): Welcome and the new sign-in replace the
splash and auth sheet, and the classic arena → limiter → probe flow follows
*Get started*, with a back button to Welcome.

## Session lifetime

- Every Better Auth request now carries the signed bearer. A cookie-less
  `get-session` with the bearer returns the user; without it, `null`. Both were
  checked against `wrangler dev`.
- Only a definite "no session" (empty body, 401 or 403) signs the device out.
  Offline or a 5xx keeps the athlete: checked by stopping the Worker and
  relaunching, which opened on Today.
- Sign-out revokes the server session while the bearer still names it, then
  clears it locally.

## Next, in order

1. **Flip `onboarding_agent_v1` on.** A deliberate product call; `flags.ts`
   says not to set it in env files or CI by accident. On iOS it needs a build.
2. **Longer sessions.** Better Auth's default is 7 days, refreshed on use. A
   10-day holiday signs you out. 90 days with a 1-day refresh is normal for a
   training app: `session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 }`
   in `worker/src/auth.ts`. It touches auth, so it goes through the cutover QA
   gate.
3. **Sign in with Apple.** One tap and Face ID: the lowest-friction sign-in
   on iOS. It needs a Services ID and key in the Apple Developer account, Better
   Auth's `socialProviders.apple`, and a native Capacitor plugin. Keep email
   code as the fallback, and the web.
4. **Passkeys** after that. Better Auth has a plugin; WKWebView needs the
   associated-domains entitlement.

## Testing it locally

`.claude/launch.json` → `zeroed-worker-otp-log` runs `wrangler dev --env dev`,
which has no `EMAIL` binding, so codes print as `[auth] dev OTP` in the log.
The default `zeroed-worker` config uses the top-level remote `EMAIL` binding and
**sends real email**, even locally. Add `?flag=onboarding_agent_v1` to the URL
for the coach intake.
