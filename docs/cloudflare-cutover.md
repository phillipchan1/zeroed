# Zeroed Cloudflare cutover + rollback

Draft-only. This document is the rehearsal runbook. Do **not** deploy, change
DNS, or touch prod data until Phil signs off. Live Zeroed stays on Vercel +
Supabase until that night.

## What moves

| Piece | Today | After cutover | Rollback |
|---|---|---|---|
| Static SPA | Vercel (Vite) | Workers Static Assets | DNS / Vercel project still live |
| `agent` | Supabase Edge Function | Hono Worker `/api/agent` | Point `VITE_API_BASE_URL` back at `https://<project>.supabase.co/functions/v1` |
| `mcp` | Supabase Edge Function `functions/v1/mcp` | Hono Worker `/api/mcp` (and `/mcp`). **Edge MCP is retired at cutover** — tokens keep working because `#17` copies `mcp_token` and the Worker hashes the same way. | Last Vercel build (empty `VITE_API_BASE_URL`) or set the API base back at `https://<project>.supabase.co/functions/v1`. The edge function stays in the repo; it is not the cutover target. |
| Auth | Supabase email OTP | Better Auth email OTP (no passwords) on `/api/auth` | Same API-URL flip; existing Vercel build still uses Supabase auth |
| Database | Supabase Postgres + RLS | Neon Postgres via Hyperdrive; access checks in the Worker | Leave Neon in place; app no longer writes it |
| Client row I/O | `supabase.from()` → PostgREST + RLS | `POST /api/data` on the Worker (Neon, per-athlete owner filters) | Empty `VITE_API_BASE_URL` keeps PostgREST |

`VITE_API_BASE_URL` empty = today's Vercel build: Supabase auth, functions, and
PostgREST. Once it is set to the Worker, **every** client read and write goes
through `/api/*` on Neon — including the ~90 `supabase.from()` call sites
(engine, program history, screens). Those calls would otherwise run anonymous:
Supabase RLS would hide Phil's rows and reject writes, while the agent/MCP
already write Neon, and the two would drift. After the Worker hosts the SPA,
set `VITE_API_BASE_URL=/api` so agent / MCP / auth / data hit the Worker.
Profile already uses `mcpUrl()` (`${base}/mcp` → `/api/mcp`). While the flag
is off, Claude connectors keep using `functions/v1/mcp`. At cutover they must
be re-pointed at the Worker URL — the edge function is retired then and would
keep reading the old Supabase store if left in front. A relative `/api` is
fine for the PWA on the Worker origin. **iOS / Capacitor must use an
absolute** `https://<worker>/api` — a relative `/api` resolves against
`capacitor://localhost` and never reaches the Worker.

## Secrets and bindings

Set these on the Worker (`wrangler secret put` / dashboard). None of them belong
in the Vite bundle.

| Name | Kind | Notes |
|---|---|---|
| `HYPERDRIVE` | binding | Hyperdrive config id in `wrangler.jsonc`. Connection string is injected. |
| `DATABASE_URL` | secret (optional locally) | Direct Neon URL when Hyperdrive is not configured (`wrangler dev` / `.dev.vars`). |
| `BETTER_AUTH_SECRET` | secret | 32+ random bytes. Rotating it signs everyone out. |
| `BETTER_AUTH_URL` | **prod var / secret** | Public origin of the Worker, e.g. `https://zeroed.<account>.workers.dev`. Required unless the runtime is local — unset throws (JSON 500 + CORS on `/api/auth`, no non-Secure cookies). |
| `ENVIRONMENT` | local `.dev.vars` only | Set to `local` for `wrangler dev` so an unset `BETTER_AUTH_URL` may fall back to `http://localhost:8787`. Must **not** be `local` in prod. A `DATABASE_URL` / Hyperdrive connection is treated as local only when its **hostname** is exactly `localhost`, `127.0.0.1`, or `[::1]` — never a substring of the user, db name, or query. |
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
| `VITE_SUPABASE_URL` | Keep for the empty-API-base (Vercel) path only. |
| `VITE_SUPABASE_ANON_KEY` | Keep for the empty-API-base (Vercel) path only. |
| `VITE_API_BASE_URL` | Empty = today's path. Worker: `/api` (same origin) or `https://<worker>/api`. **iOS: `https://<worker>/api` (absolute).** Rollback: `https://<project>.supabase.co/functions/v1`. iOS TestFlight reads this from a **repo variable** (not a secret) — see [iOS TestFlight at cutover](#ios-testflight-at-cutover). |

Replace the placeholder Hyperdrive `id` in `wrangler.jsonc` before a real deploy.

## iOS TestFlight at cutover

`.github/workflows/ios-release.yml` reads `VITE_API_BASE_URL` from a GitHub
**Actions variable** (Settings → Secrets and variables → Actions → Variables).
It does **not** bake `VITE_SUPABASE_*` unless that variable is empty.

| When | `VITE_API_BASE_URL` variable | What the IPA talks to |
|---|---|---|
| Before cutover (today) | unset / empty | Same Supabase path as the current Vercel build (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` secrets) |
| At cutover | Worker origin + `/api`, e.g. `https://zeroed.<account>.workers.dev/api` | Worker `/api/agent`, `/api/mcp`, `/api/auth`. `VITE_SUPABASE_*` are **not** baked |
| Rollback | clear the variable, or set `https://<project>.supabase.co/functions/v1` | Supabase functions again after the next TestFlight build |

The iOS app is a Capacitor WKWebView loading local files, so a same-origin
`/api` (what the Workers SPA uses) will not resolve. Always set the **absolute
Worker URL** on this variable.

After you set or clear it, merge to `master` (or **Run workflow**) so a new
Internal TestFlight build ships with the new API target.

## Free-tier risk (CPU ms)

This PR targets the **Workers Free** plan plus **Neon Free** via Hyperdrive.

- Free Workers: **10 ms CPU per request** (I/O wait is not counted). `/api/health`
  and static assets are fine. `/api/data` is one small owned SQL (session →
  athlete → one query) — do not split it into per-table routes. `/api/agent` does
  JSON-schema validation + one OpenAI Responses call; the wait on OpenAI is I/O,
  but parsing a large `program_edit` payload can blow 10 ms CPU. `/api/mcp` tool
  handlers that walk a long lift history are the other hot path.
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

## Known limits (Worker MCP)

- **Token expiry is not enforced in prod after #17.** `resolveMcpToken` only
  checks `expires_at` when that column exists. The live `mcp_token` table
  copied by #17 has no expiry column, so existing tokens stay valid until
  revoked. The isolation seed adds the column so checks can cover expiry.
- **Rate limit is per isolate.** The in-memory `hits` map in `mcp.ts` is not
  shared across Worker isolates or regions. A client can see a higher
  effective limit under load. This is an acknowledged bound, not a
  distributed limiter.
- Isolation and mutation proofs run against **real Postgres 17** in CI
  (`ZEROED_TEST_DATABASE_URL` on a service container — never `DATABASE_URL`).
  Locally they fall back to PGlite when that URL is unset.

## Pre-checks (T-24h)

1. Phil sign-off recorded. No deploy happens without it.
2. `npm run type-check && npm run lint && npm run check && npm run check:client-data-gate && npm run check:isolation-mutation`
   green on this branch. Isolation applies `supabase/migrations` onto
   real Postgres 17 in CI (`ZEROED_TEST_DATABASE_URL`; PGlite locally when
   that URL is unset), then seeds two athletes. The mutation script first
   asserts the unmutated check is green, then deletes each derived owner
   filter (`athlete_id =` and `id =`, including the phase-rollback owner
   clause and the `/api/data` predicates) on its own and expects at least
   one failure — CI fails if the URL is missing so those mutations are not
   PGlite-only. `worker/src/mcp.check.ts` (picked up by `npm run check`) is
   the MCP parity + token isolation + revoked 401 + load-a-full-program
   gate. `check:client-data-gate` lists every `supabase.from()` as going
   through the Worker facade when the API base is set. CI also runs
   `check:postgres` against a real Postgres service (Better Auth OTP +
   owner isolation + sequential per-request clients). The Worker opens one
   Postgres client per request and closes it with `waitUntil`.
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
   create those tables. Columns are snake_case (`email_verified`, `user_id`,
   `expires_at`). `createAuth` in `worker/src/auth.ts` maps Better Auth's
   camelCase fields onto those names — do not regenerate camelCase tables.
4. Point the Worker Hyperdrive config at the Neon connection string.
5. Set the Worker `BETTER_AUTH_URL` var/secret to the public Worker origin
   (never leave it as `http://localhost:8787`, and do not set
   `ENVIRONMENT=local` in prod). Rebuild the SPA with
   `VITE_API_BASE_URL=/api` for the PWA (or the workers.dev origin + `/api`)
   and an **absolute** `https://<worker>/api` for the iOS build, then
   `wrangler deploy`. Do **not** flip the production hostname until smoke
   passes on workers.dev.
6. Smoke:
   - `GET /` → 200, app shell.
   - `GET /app/today` → `index.html` (SPA fallback).
   - `GET /api/health` → `{ ok: true }`.
   - Request a sign-in code; verify the 6-digit OTP.
   - Load today's workout list and save (complete) one session — both must
     hit `POST /api/data`, not Supabase PostgREST.
   - `node scripts/smoke-wrangler-data.mjs` while `wrangler dev` is up
     (`ENVIRONMENT=local` + `DATABASE_URL` in `.dev.vars`; `SMOKE_BEARER`
     for load/save). iOS still needs an absolute `https://<worker>/api`.
   - One authenticated `POST /api/agent` (`probe` is pre-auth; use `coach_chat`
     or `target` with a session cookie / bearer).
   - `POST /api/mcp` with `Accept: text/event-stream` and a minted token —
     response `Content-Type: text/event-stream`. A revoked token is 401.
     `tools/list` matches the retired edge function. `get_current_program`
     returns that athlete's phase, routines, and exercises only.
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
3. Confirm `agent` on Supabase still serves. It was not removed. **MCP
   on the edge is retired at cutover** — do not keep sending Claude
   connectors at `functions/v1/mcp` after the Worker is in front. The
   function remains in the repo (and on Supabase) so a rollback API-URL
   flip still works; it is not the live path.
4. If any writes landed on Neon after unfreeze, they are **not** in Supabase.
   Replay from the Worker logs / a Neon dump of the affected tables. Zeroed
   traffic is low; the rehearsal should include a dummy write so this path is
   practiced.
5. Unfreeze. Target: old infra in front in minutes, not a schema rewrite.

## After soak

Keep Vercel + Supabase intact for 14–30 days. Only then decommission.
