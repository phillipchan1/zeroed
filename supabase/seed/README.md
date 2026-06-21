# Seed data

One-off scripts to pre-populate a deployed database. These are **not**
migrations and are not run automatically — run them by hand when you want them.

## `phil_health_import.sql`

Imports Phil's real 12-week block + diagnosis from the Notion "Phil's Health"
workspace directly into the app, so it can be used immediately **without** going
through the AI orientation flow (which would otherwise generate its own
competing program and read).

**Run it:** Supabase Dashboard → SQL Editor → paste the file → Run. It runs as
the service role there, so RLS does not block the inserts. The target account
(`phillipchan1@gmail.com`, editable at the top of the file) must have signed
into the deployed app at least once so an `auth.users` row exists.

It is idempotent — re-running clears that athlete's prior program / insights /
diagnostics / profile / coach messages and re-inserts. It never deletes the
athlete or the auth user. Re-run only before you've started logging real
workouts (or knowingly, to reset).

### What it seeds

| Area | Detail |
|------|--------|
| Athlete | Phil, Basketball, 5 sessions/week, `onboarding_step = complete` (drops straight into the daily loop, skipping orientation) |
| Diagnosis | 6 `insight` rows (P1–P4) from the Weak Link Map + Athlete Profile |
| Program | Program 1; Phase 1 (Stability) active, Phase 2 (Integration → schema `Strength`) pending |
| Routines | The 5 Phase-1 day templates (Mon Prehab → Fri Full Body), loads at Week 6 numbers |
| History | Baseline diagnostic (May 17) + two coach notes mirroring the Notion Coach Notes |

### Notes / mapping decisions

- **Phase names** are a closed set in the schema (`Stability/Strength/Power/Sport`).
  Notion's "Phase 2 — Integration" maps to `Strength`.
- **Insight confidence/status** start conservative (P1 `likely` @ 0.80) so the
  app's confidence math can confirm them as you log sessions, rather than
  asserting `confirmed` up front.
- **No past workouts are backfilled.** You start logging from the current week;
  the weekly assessment and load prescriptions build from there. Backfilling the
  Notion Workout Log (Weeks 1–5 actuals) would be a separate pass.
