# Zeroed Cloudflare cutover + rollback

Final runbook (Oct 27, 2026). Phil's Oct 26 standing rule covers the
non-Drove migration (prod SQL, DB roles, CI merges, DNS, cutover). Still
required: **QA2 PASS on the cutover gate** (auth + prod data, including the
Cloudflare Email OTP sender in this doc), a verified fresh Supabase backup,
and the kept rollback below. Live Zeroed stays on Vercel + Supabase until
the cutover night. Supabase is never deleted and is not written outside a real rollback (see the RPE drift section); it is the rollback.

## Decisions (Oct 27)

| Item | Decision |
|---|---|
| Plan | **Workers Paid** (already on the account; the only approved spend). No new domain purchase. |
| Production host | `https://zeroed.madeforgreatnesslabs.com` (free subdomain of the `madeforgreatnesslabs.com` zone already in the account). Attached as a Worker custom domain **at cutover only**. |
| OTP sender | Cloudflare Email Service `send_email` binding `EMAIL`, from `Zeroed <login@zeroed.madeforgreatnesslabs.com>` (same pattern as Polarch's `login@polarch.day`). Resend is an optional fallback only. |
| MCP URL after cutover | `https://zeroed.madeforgreatnesslabs.com/functions/v1/mcp` (same path shape as today; `/api/mcp` and `/mcp` also work). Existing bearers keep working: `mcp_token` stores sha256 and is copied verbatim. Claude connector config gets the new URL; there is **no** Supabase forwarder. |
| Supabase | Untouched. Read-only access only (Management API `read_only: true`). |
| OpenAI | Worker secret `OPENAI_API_KEY` comes from the same source Polarch uses. |

## Dev environment (rehearsal, Oct 27)

| Resource | Value | Cleanup |
|---|---|---|
| Neon branch | `dev-migration-rehearsal` (endpoint `ep-sparkling-bird-…`, 0.25 CU) | Delete the branch in Neon |
| Hyperdrive | `zeroed-neon-dev` `88fa5b29e4f84762a135ca5f43c3b692` (caching off) | `wrangler hyperdrive delete` |
| Worker | `zeroed-dev` → `https://zeroed-dev.nq-morning-briefing.workers.dev` (`wrangler deploy --env dev`; `ENVIRONMENT=dev`, no `EMAIL` binding so OTPs go to `wrangler tail` only) | `wrangler delete --env dev` |
| Email sending subdomain | `zeroed.madeforgreatnesslabs.com` onboarded (MX ×3, DKIM, SPF, DMARC on the subdomain; apex records unchanged) | DELETE the sending subdomain in the zone's Email Sending, then remove those 6 records |

Rehearsal results (Oct 27): Supabase → Neon dev copy matched **16/16 tables
on row count and content md5**, 1 auth user mapped, 0 orphan athletes.
Smoke on `zeroed-dev` was **20/20**: health, SPA fallback, unauthenticated
`/api/data` 401, OTP send → code in dev log → sign-in with signed bearer,
signed-in user = migrated Supabase id, `/api/data` row counts equal Neon
(workout/routine/insight), `/api/agent` `target` ok (OpenAI key live),
agent unauthenticated 401, MCP `initialize` + `tools/list` (13 tools) +
`get_training_brief` at `/functions/v1/mcp?apikey=…` (query ignored) with
the copied bearer, wrong bearer 401, `/api/mcp` alias, sign-out.

**Copy method used (avoids needing direct Postgres from the operator box):**
one Supabase Management API call, `POST /v1/projects/{ref}/database/query`
with `"read_only": true` (runs as `supabase_read_only_user` in a read-only
transaction, `TimeZone=UTC`, `extra_float_digits=1`, `IntervalStyle=postgres`).
It returns the 16 tables as JSON, `auth.users` (id, email, created_at) for
athlete owners, per-table count + md5 (`md5(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id))`)
and a guard that fails if any `public` table is not covered — all from one
snapshot. Neon load runs in one transaction over the Neon serverless driver
(websockets on 443): TRUNCATE the 16 tables + Better Auth tables CASCADE,
insert `"user"` rows from the auth mapping, then per table
`INSERT … OVERRIDING SYSTEM VALUE SELECT … FROM json_populate_recordset(…)`
in FK order (generated columns excluded; `session_replication_role` is not
allowed for `neondb_owner`, so triggers fire — checksums still match).
Then compare count + md5 per table and check orphan athletes. The loader
refuses any target that is not the intended Neon endpoint and prints only
table names, counts, hashes and error codes — never row values. The
`scripts/migrate-supabase-to-neon.mjs` route (pg_dump snapshot, below) is
equivalent and is the one to use from CI once #27 lands.

## What moves

| Piece | Today | After cutover | Rollback |
|---|---|---|---|
| Static SPA | Vercel (Vite) | Workers Static Assets | DNS / Vercel project still live |
| `agent` | Supabase Edge Function | Hono Worker `/api/agent` | Point `VITE_API_BASE_URL` back at `https://<project>.supabase.co/functions/v1` |
| `mcp` | Supabase Edge Function `functions/v1/mcp` | Hono Worker `/functions/v1/mcp` (alias; also `/api/mcp` and `/mcp`) on `zeroed.madeforgreatnesslabs.com`. **Edge MCP is retired at cutover** — tokens keep working because `#17` copies `mcp_token` and the Worker hashes the same way. | Last Vercel build (empty `VITE_API_BASE_URL`) or set the API base back at `https://<project>.supabase.co/functions/v1`. The edge function stays in the repo; it is not the cutover target. |
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
Profile already uses `mcpUrl()` (`${base}/mcp` → `/api/mcp`). The Worker is
current: connectors use `https://zeroed.madeforgreatnesslabs.com/functions/v1/mcp`
(`/api/mcp` and `/mcp` are aliases on `zeroed.madeforgreatnesslabs.com`). The
Supabase MCP stays up only until ~Nov 20 for rollback. A relative `/api` is
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
| `BETTER_AUTH_URL` | **prod var / secret** | Public origin of the Worker: `https://zeroed.madeforgreatnesslabs.com` at cutover (dev: the zeroed-dev workers.dev origin). Required unless the runtime is local — unset throws (JSON 500 + CORS on `/api/auth`, no non-Secure cookies). |
| `ENVIRONMENT` | `local` in `.dev.vars`; `dev` on `env.dev`; **unset in prod** | Only `local`/`dev` allow logging OTPs instead of sending them; prod with no working sender fails closed (no code, no email in logs). Set to `local` for `wrangler dev` so an unset `BETTER_AUTH_URL` may fall back to `http://localhost:8787`. Must **not** be `local` in prod. A `DATABASE_URL` / Hyperdrive connection is treated as local only when its **hostname** is exactly `localhost`, `127.0.0.1`, or `[::1]` — never a substring of the user, db name, or query. |
| `OPENAI_API_KEY` | secret | Same key as today's `agent` function. |
| `OPENAI_MODEL` | var | Default `gpt-5.4-nano`. |
| `OPENAI_MODEL_HEAVY` | secret/var | Optional; `program_edit` only. |
| `EMAIL` | `send_email` binding | Cloudflare Email Service, `allowed_sender_addresses: ["login@zeroed.madeforgreatnesslabs.com"]`, `remote: true`. Prod only (`env.dev` sets `send_email: []`). |
| `CF_EMAIL_FROM` | var | `Zeroed <login@zeroed.madeforgreatnesslabs.com>`. |
| `ALLOWED_EMAILS` | var (optional) | Comma-separated allowlist. If set, OTP sends to other addresses are skipped silently (same 200 response). Guard against quota abuse. |
| `RESEND_API_KEY` + `RESEND_FROM` | secret + var (optional) | Fallback only if the `EMAIL` send throws. Both must be set. |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret (**not set today**) | Deploys run from the operator box with wrangler; the manual `workflow_dispatch` deploy needs this secret added first. |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Optional; wrangler uses it if the token can see more than one account. |

Client build-time (Vite / Vercel, unchanged until cutover):

| Name | Notes |
|---|---|
| `VITE_SUPABASE_URL` | Keep for the empty-API-base (Vercel) path only. |
| `VITE_SUPABASE_ANON_KEY` | Keep for the empty-API-base (Vercel) path only. |
| `VITE_API_BASE_URL` | Empty = today's path. Worker: `/api` (same origin) or `https://<worker>/api`. **iOS: `https://<worker>/api` (absolute).** Rollback: `https://<project>.supabase.co/functions/v1`. iOS TestFlight reads this from a **repo variable** (not a secret) — see [iOS TestFlight at cutover](#ios-testflight-at-cutover). |

Hyperdrive `id` in `wrangler.jsonc` is `feb7018e2ce14f3981fe2a43f3e2851b` (prod);
`env.dev` uses `88fa5b29e4f84762a135ca5f43c3b692` (Neon dev branch).
`wrangler.jsonc` sets `keep_vars: true` so dashboard vars survive deploys.

## iOS TestFlight at cutover

`.github/workflows/ios-release.yml` reads `VITE_API_BASE_URL` from a GitHub
**Actions variable** (Settings → Secrets and variables → Actions → Variables).
It does **not** bake `VITE_SUPABASE_*` unless that variable is empty.

| When | `VITE_API_BASE_URL` variable | What the IPA talks to |
|---|---|---|
| Before cutover (today) | unset / empty | Same Supabase path as the current Vercel build (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` secrets) |
| At cutover | Worker origin + `/api`, `https://zeroed.madeforgreatnesslabs.com/api` | Worker `/api/agent`, `/api/mcp`, `/api/auth`. `VITE_SUPABASE_*` are **not** baked |
| Rollback | clear the variable, or set `https://<project>.supabase.co/functions/v1` | Supabase functions again after the next TestFlight build |

The iOS app is a Capacitor WKWebView loading local files, so a same-origin
`/api` (what the Workers SPA uses) will not resolve. Always set the **absolute
Worker URL** on this variable.

After you set or clear it, merge to `master` (or **Run workflow**) so a new
Internal TestFlight build ships with the new API target.

## Plan and cost (Workers Paid)

The account is on **Workers Paid** — the only approved spend. Nothing in this
cutover may add cost; stop and report if it would.

- Workers Paid: 30 s CPU default, 10 MB bundle. The Free-plan 10 ms CPU and
  3 MB limits no longer apply. Hyperdrive is included.
- **Email Sending** (Cloudflare Email Service, pricing page of Jun 9, 2026):
  needs Workers Paid; **3,000 outbound messages / month included per
  account**, then $0.35 per 1,000. The allowance is shared with Polarch
  (`login@polarch.day`). Zeroed's volume (1 user, a few OTPs / week) is far
  under it. Hard bounces count. Set `ALLOWED_EMAILS` if abuse shows up.
- Domain: free subdomain on an existing zone. No registrar spend.
- Neon: existing project; dev branch at 0.25 CU on the free allowance.

## OTP email (Cloudflare Email Service)

`worker/src/mail.ts` (`sendOtpEmail`) picks, in order:

1. `EMAIL` binding → Cloudflare Email Service from `CF_EMAIL_FROM`.
2. On failure, Resend only if both `RESEND_API_KEY` and `RESEND_FROM` are set.
3. `ENVIRONMENT` `local`/`dev` with no sender → log `[auth] dev OTP (type): code` (no email address).
4. Otherwise throw (fail closed). Prod never logs a code or an address.

Errors log only `{ kind, status }`. `ALLOWED_EMAILS`, when set, skips other
recipients silently. `worker/src/mail.check.ts` (run by `npm run check`)
covers order, fallback, fail-closed, log-mode gating and the
`wrangler.jsonc` binding/sender config. **This touches auth: it is part
of the QA2 cutover gate.** Sending is "dark" until cutover: the binding is
only on the prod Worker, which is not deployed with it until cutover night.

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

1. QA2 PASS on the cutover gate recorded (Phil's Oct 26 standing rule covers the go). No prod deploy without it.
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
5. Apply `worker/schema/app.sql` then `worker/schema/better-auth.sql` on an
   empty Neon (or let the migrate script do it). Then
   `SUPABASE_READONLY_URL=… node scripts/migrate-supabase-to-neon.mjs --dry-run --skip-auth-users --auth-users-file=users.json`
   (source-only: Neon is not required and is not compared). `SUPABASE_READONLY_URL` must
   be a **direct** connection or the **session** pooler (port 5432). The
   transaction pooler (port 6543 / `mode=transaction`) cannot hold
   `REPEATABLE READ` or `pg_export_snapshot` — the script refuses it.
   Node `pg` source clients verify TLS with the committed Supabase
   `prod-ca-2021` root (`scripts/certs/supabase-prod-ca-2021.crt`) and
   `rejectUnauthorized: true`. Every `ssl*` query param (`sslmode`,
   `sslrootcert`, `sslcert`, `sslkey`, `sslcrl`, …) and `uselibpqcompat`
   is stripped from the source URL; any other unexpected query param is
   refused. Neon, if a Node client is used, keeps verify-full against the
   public CA store. `psql` / `pg_dump` against the source set
   `PGSSLMODE=verify-full` and `PGSSLROOTCERT` to that pinned CA (never
   in the URL). Worker `pg` clients verify the same way (`rejectUnauthorized:
   true`); Hyperdrive's bound local proxy stays plaintext.
   Failure logs never echo raw stdout/stderr: command name, exit code,
   SQLSTATE, and the first sanitized ERROR line only. `source-counts.json`
   is deleted in the workflow `always()` step.
   The dump and the source
   counts/hashes share one `REPEATABLE READ` **READ ONLY** transaction:
   `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`,
   `pg_export_snapshot()`, `pg_dump --snapshot=<id>`, then `COUNT(*)` plus
   a per-table content md5 (`md5(to_jsonb(t))` aggregated `ORDER BY t.id`)
   on the same snapshot. The snapshot session sets
   `statement_timeout=0` and `idle_in_transaction_session_timeout=0` so a
   long dump cannot kill the exporting transaction while it sits idle.
   Both checksum sessions pin `TimeZone=UTC`, `extra_float_digits=1`, and
   `IntervalStyle=postgres` (PGOPTIONS on `psql`, `SET` on the snapshot
   client) so a timestamptz / float / interval display difference cannot
   look like a content mismatch. Live writes on Supabase cannot make the dump and
   the checksums diverge, so a mismatch is a real restore problem, not
   snapshot skew. Dry-run writes the dump under `$RUNNER_TEMP` (discarded,
   never uploaded), attaches the auth mapping, runs `pg_restore --list`
   sanity, and writes per-table source counts and md5s to
   `source-counts.json` (including `workout`). It **exits 0** when those
   source-side steps succeed — an empty Neon is not a dry-run failure.
   The live restore is what compares source snapshot vs Neon and aborts
   on a count/hash mismatch. Logs print counts per table, not hashes,
   URLs, or query dumps. It also
   refuses if a `public` table is missing from the coverage list (Better
   Auth `user` / `session` / `account` / `verification` stay excluded on
   purpose). The migration role cannot read
   `auth.users` — provide a CSV/JSON of `(id, email, created_at)`. A live
   restore without that mapping exits 2. A live restore also requires
   `--confirm-drop=<target dbname>` and a `*.neon.tech` target. The script
   refuses when source and target normalize to the same host+port+dbname
   (user, password, and query are ignored; libpq `?host=` / `hostaddr=` /
   `dbname=` overrides are honored), when the target host looks like
   Supabase (`supabase.co` / `supabase.com` / `pooler.supabase`), is a
   socket path, or a host override that is not `*.neon.tech`, or when a
   pre-DROP probe cannot read either fingerprint (fail closed), finds a
   `storage` schema, any `pg_policies` row, a matching
   `current_database()` plus `inet_server_addr()` / port / start time /
   `system_identifier`, or a source session advisory lock visible in the
   target's `pg_locks`. The source is never written (no marker DDL/DML).
   Do not pass
   `--relax-target-rls` unless you intend to drop leftover RLS on Neon.
   Manual GitHub Action: `migrate-supabase-to-neon` (`workflow_dispatch` only,
   `dry_run` defaults to true). Secrets: `SUPABASE_READONLY_URL`,
   `NEON_DIRECT_URL`, `AUTH_USERS_MAPPING` (base64 CSV). Live dispatch
   also needs the `confirm_drop` input (Neon dbname). Recommended: pin
   the workflow to a GitHub Environment with required reviewers (repo
   settings — not created by this PR).
6. Worker deployed to `*.workers.dev` only (not the production hostname).
7. Rollback values written down: current Vercel URL, `VITE_SUPABASE_*`,
   Supabase functions base `https://<project>.supabase.co/functions/v1`.

## Cutover (rehearsal — Zeroed is not live-critical)

1. Write-freeze is optional here; run it anyway so the template is exercised.
2. `SUPABASE_READONLY_URL=… NEON_DIRECT_URL=… node scripts/migrate-supabase-to-neon.mjs --confirm-drop=neondb --skip-auth-users --auth-users-file=users.json`
   — abort on a row-count or content-hash mismatch (Neon is compared
   to the same source snapshot the dump used, not a later read), a
   mapping that is missing any
   source `athlete.auth_user_id` (ids, not counts), or an athlete
   whose `auth_user_id` has no Better Auth `"user"`. A live run
   without `--auth-users-file` exits 2. A live run without
   `--confirm-drop=<target dbname>` exits 2. A live run **drops and
   recreates** Neon `public` + `auth` first (reruns start empty),
   applies `worker/schema/app.sql` + `better-auth.sql`, then loads
   mappings + data-only restore **in one transaction** so a failure
   rolls back to empty tables. Table order is FK-safe (no
   `--disable-triggers`; Neon’s `neondb_owner` is not superuser).
   The source URL is **read-only**. RLS artifacts stay on Supabase.
   Pass `--relax-target-rls` only if a leftover RLS artifact needs
   dropping **on Neon** (the Worker already scopes every query; the table
   owner bypasses RLS unless `FORCE ROW LEVEL SECURITY`).
3. Apply `worker/schema/better-auth.sql` only if the script did not already
   create those tables. Columns are snake_case (`email_verified`, `user_id`,
   `expires_at`). `createAuth` in `worker/src/auth.ts` maps Better Auth's
   camelCase fields onto those names — do not regenerate camelCase tables.
   `#17` copies mapped auth users into `"user"`; it does **not** mint signed
   Better Auth session cookies. Those people must request a new OTP.
   `Authorization: Bearer` must be the signed `token.signature` from
   `set-auth-token` (or the session cookie), never the raw `session.token`
   column. `bearer({ requireSignature: true })` and `/api/data` both 401
   unsigned tokens. Rotating `BETTER_AUTH_SECRET` also forces re-sign-in.
   For the workers.dev preview only, `node scripts/seed-preview.mjs --preview`
   loads synthetic rows (no production data). Skip this on a real restore.
4. Point the Worker Hyperdrive config (`feb7018e…`) at the prod Neon
   connection string (prod Neon, never the dev branch).
5. Set the Worker `BETTER_AUTH_URL` var/secret to the public Worker origin
   (never leave it as `http://localhost:8787`, and do not set
   `ENVIRONMENT=local` in prod). Rebuild the SPA with
   `VITE_API_BASE_URL=/api` for the PWA (or the workers.dev origin + `/api`)
   and an **absolute** `https://<worker>/api` for the iOS build, then
   `wrangler deploy`. Do **not** flip the production hostname until smoke
   passes on workers.dev. Then attach the custom domain
   `zeroed.madeforgreatnesslabs.com` to the `zeroed` Worker (Workers →
   Settings → Domains & Routes, or `routes: [{ pattern, custom_domain: true }]`)
   and set `BETTER_AUTH_URL` to it.
6. Smoke:
   - `GET /` → 200, app shell.
   - `GET /app/today` → `index.html` (SPA fallback).
   - `GET /api/health` → `{ ok: true }`.
   - Request a sign-in code; verify the 6-digit OTP.
   - Load today's workout list and save (complete) one session — both must
     hit `POST /api/data`, not Supabase PostgREST.
   - `node scripts/smoke-wrangler-data.mjs` while `wrangler dev` is up
     (`ENVIRONMENT=local` + `DATABASE_URL` in `.dev.vars`; `SMOKE_BEARER`
     must be the signed `set-auth-token` value, not `session.token`).
     iOS still needs an absolute `https://<worker>/api` and the same
     signed bearer (cookies are httpOnly).
   - One authenticated `POST /api/agent` (`probe` is pre-auth; use `coach_chat`
     or `target` with a session cookie / signed bearer).
   - `POST /api/mcp` with `Accept: text/event-stream` and a minted token —
     response `Content-Type: text/event-stream`. A revoked token is 401.
     `tools/list` matches the retired edge function. `get_current_program`
     returns that athlete's phase, routines, and exercises only.
   - Real OTP email arrives from `login@zeroed.madeforgreatnesslabs.com`
     (prod has the `EMAIL` binding; no code appears in `wrangler tail`).
7. Hand Friday the new MCP URL
   `https://zeroed.madeforgreatnesslabs.com/functions/v1/mcp` for the Claude
   connector (same bearer). Set the iOS `VITE_API_BASE_URL` repo variable to
   `https://zeroed.madeforgreatnesslabs.com/api` and ship TestFlight.
8. Forced rollback rehearsal (below), then cutover again if this is still a drill.

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
   practiced. **Before copying anything back, run the
   [schema drift check](#rollback-schema-drift-rpe-neon-is-looser-than-supabase)
   below.** Neon can hold rows that Supabase's older constraints reject.
5. Point the Claude connector back at the Supabase `functions/v1/mcp` URL
   (the edge function and its data are untouched). Detach the
   `zeroed.madeforgreatnesslabs.com` custom domain if needed; the Email
   sending subdomain can stay (it costs nothing idle).
6. Unfreeze. Target: old infra in front in minutes, not a schema rewrite.

## Rollback schema drift: RPE (Neon is looser than Supabase)

A separate PR relaxes `workout.rpe` to **1–10 in 0.5 steps**. It adds a new
migration in `supabase/migrations/`, and that migration goes live **on Neon at
cutover only**. Supabase keeps the old, tighter rule until a rollback needs it.
After cutover, Neon can hold RPE values that Supabase rejects. A copy-back must
handle them **before** any rows go into Supabase.

**What Supabase enforces today** (read-only check on Oct 27, schema only):
`workout.rpe` is `integer` with
`workout_rpe_check CHECK ((rpe >= 1) AND (rpe <= 10))`. No trigger or function
references RPE. The latest applied migration is `20261026000001`. Per-set
`rpe` inside `workout.actual_weights` (JSONB) has no database constraint, so
it copies back as-is.

> Watch out: a half-step value such as `7.5` is the realistic failure, and it
> may **not** raise an error. If it travels as a numeric, Postgres's
> assignment cast into an `integer` column silently rounds it to `8`.
> Use the count query below to find these rows. Don't rely on the copy
> failing. If the loosening PR also changes the lower bound (for example,
> values under 6 that some build path rejected), the same query catches those
> rows as long as you paste in the exact Supabase constraint text (step 1).

### 1. Pre-rollback count (counts only, no row values)

On **Supabase**, read the live constraint so the check matches what Supabase
will actually enforce:

```sql
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'public.workout'::regclass AND contype = 'c' AND conname ILIKE '%rpe%';
SELECT data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'workout' AND column_name = 'rpe';
```

On **Neon** (prod, read-only), count the rows that Supabase's old rule
rejects. As of Oct 27 that rule is `integer` + `1..10`. If step 1's output
differs, swap in that `def`.

```sql
SELECT
  count(*) FILTER (WHERE rpe IS NOT NULL)                         AS with_rpe,
  count(*) FILTER (WHERE rpe <> trunc(rpe))                       AS half_steps,
  count(*) FILTER (WHERE rpe < 1 OR rpe > 10)                     AS out_of_range,
  count(*) FILTER (WHERE rpe < 6)                                 AS under_6,
  count(*) FILTER (WHERE rpe <> trunc(rpe) OR NOT (rpe >= 1 AND rpe <= 10))
                                                                  AS rejected_by_supabase
FROM public.workout;
```

Write the counts in the rollback log. If `rejected_by_supabase = 0` **and**
Supabase's column type still matches Neon's, copy back as normal. Otherwise,
use step 2.

### 2. Preferred: give Supabase the same loosening migration first

1. Take a fresh Supabase backup (dashboard backup or a `pg_dump` of
   `public.workout`) and verify that it restores before you change anything.
   This is the only planned Supabase schema write, and it happens only during
   a real rollback.
2. Apply **that exact migration file** from the RPE PR to Supabase:
   `supabase db push` against the linked Zeroed project, or run the file in
   one transaction in the SQL editor. Don't hand-write a variant. Neon and
   Supabase must end up with the same definition.
3. Confirm the two sides now match. Run on both and compare:
   `pg_get_constraintdef` for the RPE check(s) and `data_type` of
   `workout.rpe` (step 1 queries).
4. Re-run the step 1 count with Supabase's new constraint text pasted in. It
   must return `rejected_by_supabase = 0`.
5. Then copy the Neon rows back (step 4 of Rollback above), in one transaction.
6. The client that rollback puts in front must accept half steps too. The last
   Vercel production build may predate the RPE PR. If so, ship a build that
   includes the PR before the build is unfrozen, or users can't edit those
   workouts.

### 3. Fallback: clamp on the way out (only if step 2 can't be applied)

Use this only if the migration fails on Supabase or can't be applied in the
rollback window. **Never modify Neon.** Neon keeps the exact values, so a
later re-cutover loses nothing. Transform only in the copy-out query:

```sql
-- in the SELECT that exports public.workout from Neon
CASE WHEN rpe IS NULL THEN NULL
     ELSE LEAST(10, GREATEST(1, round(rpe)))::int END AS rpe
-- keep the CASE: GREATEST ignores NULLs, so a bare GREATEST(1, NULL) would write 1
```

- Rounding is to the nearest integer, half away from zero (`7.5 → 8`), and
  then clamped into 1..10.
- Record **only the ids** of the clamped rows (no values) in the rollback log:
  `SELECT id FROM public.workout WHERE rpe <> trunc(rpe) OR NOT (rpe >= 1 AND rpe <= 10);`.
  After step 2 lands later, re-copy those ids from Neon to restore the exact
  values.
- Re-run the step 1 count against the copied Supabase rows. It must report 0
  violations before you unfreeze.

## After soak

Keep Vercel + Supabase intact for 14–30 days. Only then decommission.
