# Zeroed Cloudflare cutover + rollback

Draft-only. This document is the rehearsal runbook. Do **not** deploy, change
DNS, or touch prod data until Phil signs off. Live Zeroed stays on Vercel +
Supabase until that night.

## What moves

| Piece | Today | After cutover | Rollback |
|---|---|---|---|
| Static SPA | Vercel (Vite) | Workers Static Assets | DNS / Vercel project still live |
| `agent` / `mcp` | Supabase Edge Functions | Hono Worker `/api/agent`, `/api/mcp` | Point `VITE_API_BASE_URL` back at `https://<project>.supabase.co/functions/v1` |
| Auth | Supabase email OTP | Better Auth email OTP (no passwords) on `/api/auth` | Same API-URL flip; existing Vercel build still uses Supabase auth |
| Database | Supabase Postgres + RLS | Neon Postgres via Hyperdrive; access checks in the Worker | Leave Neon in place; app no longer writes it |

The SPA still talks to Supabase PostgREST for row reads/writes when
`VITE_API_BASE_URL` is unset (today's Vercel build). After the Worker hosts the
SPA, set `VITE_API_BASE_URL=/api` so agent / MCP / auth hit the Worker. A later
change can move client PostgREST calls onto Neon; it is **not** required to roll
the functions and auth first.

## Secrets and bindings

Set these on the Worker (`wrangler secret put` / dashboard). None of them belong
in the Vite bundle.

| Name | Kind | Notes |
|---|---|---|
| `HYPERDRIVE` | binding | Hyperdrive config id in `wrangler.jsonc`. Connection string is injected. |
| `DATABASE_URL` | secret (optional locally) | Direct Neon URL when Hyperdrive is not configured (`wrangler dev` / `.dev.vars`). |
| `BETTER_AUTH_SECRET` | secret | 32+ random bytes. Rotating it signs everyone out. |
| `BETTER_AUTH_URL` | var | Public origin of the Worker, e.g. `https://zeroed.<account>.workers.dev`. |
| `OPENAI_API_KEY` | secret | Same key as today's `agent` function. |
| `OPENAI_MODEL` | var | Default `gpt-5.4-nano`. |
| `OPENAI_MODEL_HEAVY` | secret/var | Optional; `program_edit` only. |
| `RESEND_API_KEY` | secret | OTP email. If unset, codes are logged (dev only). |
| `RESEND_FROM` | var | e.g. `Zeroed <noreply@yourdomain>`. |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Manual `workflow_dispatch` deploy only. |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Optional; wrangler uses it if the token can see more than one account. |

Client build-time (Vite / Vercel, unchanged until cutover):

| Name | Notes |
|---|---|
| `VITE_SUPABASE_URL` | Keep until PostgREST is retired. |
| `VITE_SUPABASE_ANON_KEY` | Keep until PostgREST is retired. |
| `VITE_API_BASE_URL` | Empty = today's path. Worker: `/api` (same origin) or `https://<worker>/api`. Rollback: `https://<project>.supabase.co/functions/v1`. |

Replace the placeholder Hyperdrive `id` in `wrangler.jsonc` before a real deploy.

## Free-tier risk (CPU ms)

This PR targets the **Workers Free** plan plus **Neon Free** via Hyperdrive.

- Free Workers: **10 ms CPU per request** (I/O wait is not counted). `/api/health`
  and static assets are fine. `/api/agent` does JSON-schema validation + one
  OpenAI Responses call; the wait on OpenAI is I/O, but parsing a large
  `program_edit` payload can blow 10 ms CPU. `/api/mcp` tool handlers that walk
  a long lift history are the other hot path.
- Free Workers bundle limit is **3 MB compressed** (Paid is 10 MB). Better Auth +
  `pg` + Hono + the ported MCP store is the size risk; check `wrangler deploy`
  output before relying on Free.
- Hyperdrive is documented as unlimited queries on **Workers Paid**. Confirm
  Hyperdrive is enabled on this account's Free plan before cutover; if it is not,
  the fallback is a direct Neon connection (`DATABASE_URL`) and the first query
  after Neon autosuspend is ~300–500 ms.
- Neon Free: 0.5 GB, autosuspend. Zeroed is small; still measure dump size
  before restore.
- If agent or MCP start 1102/1101 CPU-time errors, the honest fix is Workers
  Paid ($5/mo), not rewriting the port.

## Pre-checks (T-24h)

1. Phil sign-off recorded. No deploy happens without it.
2. `npm run type-check && npm run lint && npm run check && npm run check:isolation-mutation`
   green on this branch. Isolation checks run store/edits against PGlite
   seeded with two athletes. The mutation script must fail (and restore)
   when the `loadWorkout` `athlete_id` filter is deleted or every
   `athlete_id` filter is replaced with `TRUE`.
3. `npm run build && npx wrangler dev` serves `/` and `/api/health`.
   `POST /functions/v1/agent` reaches the Worker (not a 405 from assets).
   Missing `/assets/*` is 404 text/plain, not `index.html`.
4. Fresh Supabase backup. Neon project created, empty or schema-only.
5. `node scripts/migrate-supabase-to-neon.mjs --dry-run` with the dump URLs
   (read-only source is enough for dry-run). Do not pass `--relax-target-rls`
   unless you intend to drop RLS on the Neon target.
6. Worker deployed to `*.workers.dev` only (not the production hostname).
7. Rollback values written down: current Vercel URL, `VITE_SUPABASE_*`,
   Supabase functions base `https://<project>.supabase.co/functions/v1`.

## Cutover (rehearsal — Zeroed is not live-critical)

1. Write-freeze is optional here; run it anyway so the template is exercised.
2. `SUPABASE_DB_URL=… NEON_DB_URL=… node scripts/migrate-supabase-to-neon.mjs`
   — abort on a row-count mismatch. The source URL is **read-only**
   (`pg_dump` + `COPY … TO STDOUT`). RLS, `athlete_select`,
   `get_current_athlete_id()`, and `athlete_auth_user_id_fkey` are left
   intact on Supabase. The script stubs `auth.users` on Neon so the dumped
   FK can restore. Pass `--relax-target-rls` only if you want those
   Supabase RLS artifacts dropped **on Neon** (the Worker already scopes
   every query; the table owner bypasses RLS unless `FORCE ROW LEVEL
   SECURITY`).
3. Apply `worker/schema/better-auth.sql` only if the script did not already
   create those tables.
4. Point the Worker Hyperdrive config at the Neon connection string.
5. Rebuild the SPA with `VITE_API_BASE_URL=/api` (or the workers.dev origin +
   `/api`) and `wrangler deploy`. Do **not** flip the production hostname until
   smoke passes on workers.dev.
6. Smoke:
   - `GET /` → 200, app shell.
   - `GET /app/today` → `index.html` (SPA fallback).
   - `GET /api/health` → `{ ok: true }`.
   - Request a sign-in code; verify the 6-digit OTP.
   - One authenticated `POST /api/agent` (`probe` is pre-auth; use `coach_chat`
     or `target` with a session cookie / bearer).
   - `POST /api/mcp` with `Accept: text/event-stream` and a minted token —
     response `Content-Type: text/event-stream`.
7. Forced rollback rehearsal (below), then cutover again if this is still a drill.

## Rollback (target: back on Vercel + Supabase)

Rollback is an API-URL / DNS flip. Nothing is deleted.

1. Re-freeze writes on the Worker if it has been taking traffic (`/api/*`
   can return 503 behind a `MAINTENANCE` var if you add one later; today, stop
   sending clients to the Worker).
2. **Point `VITE_API_BASE_URL` back at Supabase**
   `https://<project>.supabase.co/functions/v1` and redeploy **or** — simpler —
   put DNS / the Vercel project back in front. The last Vercel production build
   still has an empty `VITE_API_BASE_URL` and talks to Supabase auth + functions
   exactly as today.
3. Confirm `agent` and `mcp` on Supabase still serve. They were not removed.
4. If any writes landed on Neon after unfreeze, they are **not** in Supabase.
   Replay from the Worker logs / a Neon dump of the affected tables. Zeroed
   traffic is low; the rehearsal should include a dummy write so this path is
   practiced.
5. Unfreeze. Target: old infra in front in minutes, not a schema rewrite.

## After soak

Keep Vercel + Supabase intact for 14–30 days. Only then decommission.
