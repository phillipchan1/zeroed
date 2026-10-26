# Zeroed

## Claude MCP (chat against your log)

**Remote (web / phone):** Profile → **Claude connector** → Create token → paste as a
Claude **custom connector** (Bearer auth, skip OAuth). Details: `mcp/README.md`.

**Local (this machine):** Claude Desktop Local-dev / Cursor / Claude Code:

```bash
npm run mcp:install    # once
cp mcp/.env.example mcp/.env
```

Put your Supabase URL plus either athlete login (`ZEROED_EMAIL` / `ZEROED_PASSWORD`
+ anon key) or a service-role key + `ZEROED_ATHLETE_EMAIL` in `mcp/.env`. Then
point Claude at `mcp/src/index.ts` — copy `mcp/claude_desktop_config.example.json`
or `mcp/cursor-mcp.example.json` and replace the placeholder path.

`npm run mcp:check` exercises the editor and formatters without a database.
Full setup: `mcp/README.md`.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

```bash
cp .env.local.example .env.local
```

Open `.env.local` and paste your values from the [Supabase dashboard](https://app.supabase.com) → Project Settings → API:

```
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

> **Security:** The `VITE_` prefix causes Vite to bundle values into the browser build — intentional for the public URL and anon key. `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are **not** in `.env.local.example` and must never carry the `VITE_` prefix. Store them exclusively as Supabase Edge Function secrets via `supabase secrets set`.

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Once keys are in `.env.local` the page will show "✓ connected".

### 4. Other scripts

```bash
npm run type-check   # TypeScript type check (no emit)
npm run build        # Production build → dist/
npm run preview      # Serve the dist/ build locally
```

## Cloudflare (draft — do not cut over)

Workers Static Assets + a Hono Worker for `/api/agent`, `/api/mcp`, and
Better Auth (`/api/auth`). Live Vercel + Supabase stay up until cutover.
Runbook: [`docs/cloudflare-cutover.md`](docs/cloudflare-cutover.md).

```bash
cp .dev.vars.example .dev.vars   # server secrets for wrangler
npm run build
npx wrangler dev                 # SPA + /api on :8787
```

`VITE_API_BASE_URL` empty = today's Supabase path. Set it to `/api` (same-origin
Worker) or `https://<project>.supabase.co/functions/v1` to roll back.

## Deploy to Vercel

1. Push the repo to GitHub.
2. Import it at [vercel.com](https://vercel.com) — Vercel auto-detects Vite.
3. In Project → Settings → Environment Variables, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Redeploy. Vercel runs `vite build` and serves `dist/`.

## Supabase CLI

```bash
# Install
brew install supabase/tap/supabase

# Link to your project
supabase link --project-ref your-project-ref

# Apply committed migrations
supabase db push
```

Migrations live in `supabase/migrations/`. Create new ones with `supabase migration new <name>`.

### ⚠️ Backend changes do NOT ride the web deploy

Pushing to `master` redeploys the **frontend only** (Vercel). Anything under
`supabase/` ships separately, by hand:

```bash
npm run deploy:backend   # = supabase db push && supabase functions deploy agent
```

Run it whenever a pulled change touches `supabase/migrations/` or
`supabase/functions/`. The client is built to degrade rather than crash when
the backend lags, and the two degradations look like app bugs:

- **"Change the program" answers every message with a can't-reach/older-coach
  line** → the deployed `agent` function predates the `program_edit` task.
  Fix: `npm run deploy:agent`.
- **Edited sessions pile up as "N sessions couldn't sync" with
  `[42501] permission denied for table workout`** → the database is missing
  the `allow_session_edit` migration (editing a logged session UPDATEs a
  table that used to be append-only). Fix: `npm run deploy:db`, then tap
  **Try again** on the sync sheet — the queued sessions upload exactly as
  logged. Never discard them for this error; nothing is wrong with the
  sessions themselves.

### The `agent` Edge Function

Every model call in the app goes through one function, `supabase/functions/agent`.
Its task list (prompt + strict JSON schema per task) lives in `schemas.ts`, so
**adding or changing a task means redeploying** — a client calling a task the
deployed function doesn't know returns `unknown task` and the screen falls back
to its deterministic floor.

```bash
supabase functions deploy agent

# Secrets (never prefixed VITE_ — these must not reach the browser)
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set OPENAI_MODEL=gpt-5.4-nano          # optional, the default
supabase secrets set OPENAI_MODEL_HEAVY=gpt-5.4         # optional, see below
```

`OPENAI_MODEL_HEAVY` is used only by tasks flagged `heavy: true` in `schemas.ts`
— today that's `program_edit`, which has to read a whole training week and name
its sessions and lifts back exactly. When the secret is unset every task runs on
`OPENAI_MODEL`, so the app works either way.

## Install as a PWA (iOS / Add to Home Screen)

Zeroed ships as an installable Progressive Web App — no App Store needed.

1. Deploy the app (see **Deploy to Vercel** above) so it's served over HTTPS.
   The service worker only registers on a production build, not in `npm run dev`.
2. On your iPhone/iPad, open the deployed URL in **Safari** (PWA install on iOS
   only works from Safari).
3. Tap the **Share** button → **Add to Home Screen** → **Add**.
4. Launch "Zeroed" from your home screen — it opens full-screen (standalone),
   with offline support via the service worker.

### Offline-first

Zeroed is built to load and run on low/no connectivity:

- **Instant loading.** The service worker (`public/sw.js`) is *cache-first* for
  the app shell and built JS/CSS — the UI paints with zero network round-trips
  once installed. The Vite build (`vite.config.ts`) precaches the exact hashed
  assets it emits and stamps a version, so even a first cold launch works
  offline and a new deploy is picked up cleanly.
- **Offline data.** Reads go through a two-tier, subscription-backed
  stale-while-revalidate store (`src/lib/cache.ts`). L1 is a module-level `Map`
  that survives unmount, so tab-to-tab navigation is a synchronous lookup — no
  parse, no refetch, no spinner. L2 is `localStorage`, so a cold launch paints
  from the last sync too. Three rules keep the network off the critical path:
  a **freshness window** (a key fetched within 60s isn't refetched), **dedupe**
  (concurrent readers of a key share one in-flight request), and an **offline
  skip** (revalidation waits rather than burning a request that can only fail —
  gated on *verified* connectivity, never on `navigator.onLine`). Cache is
  namespaced by a schema version and cleared on sign-out.
- **Instant auth.** `src/hooks/useAuth.ts` hydrates the signed-in athlete
  synchronously from the session Supabase has already persisted, so a returning
  athlete never waits on a token refresh to see the app. `supabase.auth` still
  reconciles behind it and remains the authority.
- **Nothing is cold.** `src/lib/loopCache.ts` warms the tabs the athlete hasn't
  opened yet in the background after the first screen settles, so the *first*
  visit to each is instant too — and centralises invalidation, so a write that
  ripples (finishing a session, closing the week, a retest) marks every view due
  without any screen knowing about the others. Nothing is dropped, so nothing
  blanks: screens keep painting and refresh behind what they show.
- **Connectivity surface.** `src/components/OfflineBar.tsx` is a small status
  pill in the top corner — "offline" (so cached data isn't mistaken for live) and
  a tap-to-refresh prompt when a new build is waiting. Offline is normal here, so
  it reads as a badge rather than an alert.
- **Connectivity is proven, not assumed.** `src/lib/useOnline.ts` is the single
  source of truth, and it does **not** trust `navigator.onLine`: that flag reads
  `false` on a healthy iOS home-screen PWA (cold launch, or resume from the
  background) and WebKit may never fire the `online` event that would correct it.
  So online is the default and offline is a claim that has to be earned — a real
  request failing triggers a probe against the Supabase health endpoint, and only
  two consecutive failed probes flip the state. Any success flips it back
  immediately, and while offline it keeps re-probing on a timer and on every
  resume signal, so recovery never waits on a browser event.

> **Writes** are optimistic and durable, not blocking. A finished session is
> queued to the outbox (`src/lib/workoutOutbox.ts`) before any network call and
> the app navigates immediately; the commit — and the AI debrief, the one
> inherently online step — runs behind it and retries on the next launch, the
> next `online` event, a verified return to connectivity, or the app coming back
> to the foreground. Queued sessions are folded into the schedule and the week
> strip, so a session logged offline reads as done straight away. Editing your
> target is optimistic the same way. Only the AI surfaces (the coach chat, the weekly
> review, a retest re-scope) genuinely need a connection.
>
> **One bad entry can't hold the queue.** A flush classifies each failure before
> acting on it: *can't reach the server* ends the pass untouched (nothing behind
> it could succeed either), while *the server rejected this one* is recorded
> against that entry and the flush carries on. Rejections that never self-heal —
> permission, foreign key, duplicate, row gone — retire the entry immediately;
> murkier ones retire after five attempts. A retired session is kept and still
> counts on your week, but it stops claiming it's about to sync and stops
> standing in front of sessions that can. Upload state — in either direction —
> is one line at the bottom of the week card, never a banner: these sessions are
> already logged and already counted in the ring above it. The stuck line is
> tappable, opening the server's own reason and a retry / discard choice.

### PWA assets

- `public/manifest.webmanifest` — app name, theme, icons, standalone display.
- `public/sw.js` — service worker (cache-first shell, precache + runtime caching).
- `public/icons/` + `public/apple-touch-icon.png` — generated icons.

Regenerate the icons (e.g. after a brand change) with:

```bash
pip install Pillow
python3 scripts/gen-icons.py
```

## iOS (TestFlight)

Native iPhone shell is Capacitor (`ios/`, bundle ID **`app.zeroed.app`**). Internal
TestFlight upload runs on push to `master` and on **Run workflow** — same signing
secrets as Nuvo, same `xcodebuild` + `altool` path. The job skips green until
those secrets exist. Setup:
[`docs/ios-releases.md`](docs/ios-releases.md).

```bash
npm run build
npx cap sync ios          # or: npm run ios:sync
npx cap open ios          # local Mac only
```
