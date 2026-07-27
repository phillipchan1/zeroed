# Zeroed

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

### PWA assets

- `public/manifest.webmanifest` — app name, theme, icons, standalone display.
- `public/sw.js` — service worker (cache-first shell, precache + runtime caching).
- `public/icons/` + `public/apple-touch-icon.png` — generated icons.

Regenerate the icons (e.g. after a brand change) with:

```bash
pip install Pillow
python3 scripts/gen-icons.py
```

## iOS (Capacitor)

The Capacitor config is committed (`capacitor.config.ts`). Add the iOS platform when ready:

```bash
npm run build
npx cap add ios
npx cap sync
npx cap open ios
```
