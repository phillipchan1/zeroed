# Seed data

One-off scripts to pre-populate a deployed database. These are **not**
migrations and are not run automatically.

Personal athlete data does not live in this repo. Prod is already loaded.
For a new environment:

1. Enable `tracks_v1` for one auth email:

```bash
ZEROED_TRACKS_FLAG_EMAIL=you@example.com \
ZEROED_SEED_DATABASE_URL=postgres://... \
node scripts/enable-tracks-flag.mjs --confirm
```

2. If that environment also needs named tracks / goals / rules, copy
   `scripts/seed-athlete-tracks.example.sql` to `local/seed-athlete-tracks.sql`
   (gitignored), edit it, then:

```bash
ZEROED_SEED_ATHLETE_EMAIL=you@example.com \
ZEROED_SEED_SQL=local/seed-athlete-tracks.sql \
ZEROED_SEED_DATABASE_URL=postgres://... \
node scripts/seed-athlete-tracks.mjs --confirm
```

Both runners refuse without `--confirm` and refuse the CI throwaway URL.
