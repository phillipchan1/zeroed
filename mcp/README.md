# Zeroed MCP

Claude can talk to your live Zeroed log two ways:

| Path | Where it works | Transport |
| --- | --- | --- |
| **Remote** (recommended for phone / web) | Claude web, Claude iOS/Android, Claude Desktop custom connector | Public HTTPS → Supabase Edge |
| **Local** | Claude Desktop (Local dev), Cursor, Claude Code on this machine | stdio process |

Same tools either way. The model proposes. The existing engine (`src/engine/programDraft.ts`) disposes: clamps, diffs, and writes. Claude never dumps a whole new week.

## What Claude can do

| Tool | Purpose |
| --- | --- |
| `get_training_brief` | Start here. Profile, open insights, live week, last sessions. |
| `get_athlete` / `get_insights` | Profile and weak-link map. |
| `get_current_program` | The week you will actually train. |
| `list_workouts` / `get_workout` | Full history, filterable by date or lift. |
| `search_lifts` | One movement's top sets + RPE-chart e1RM trend. Main lifts match by identity ("squat" never pulls a Cossack). |
| `get_lift_model` | Squat / bench / deadlift / OHP (or `all`): working max, training max, 4/8-week trend, all-time best, last qualifying sets, and this week's prescription with its reason line. Pass today's sleep / readiness / knee pain to apply the modifiers. |
| `set_training_max` | Hand-set one lift's TM (or clear it with `null`). Stored with the date and the model's own TM, so `get_lift_model` flags it once it goes stale (4+ weeks old, the model moved 5%+, or reps missed since). The app sets the same value under You → Training maxes. Previews unless `confirm=true`. |
| `get_program_journey` / `get_coach_notes` | Blocks, revisions, weekly reviews. |
| `preview_program_edits` | In-memory surgical edits + deterministic diff. Writes nothing. |
| `apply_program_edits` | Write the preview. Requires `confirm=true`. |

Program writes follow the app:

- Existing sessions are updated in place so logged workouts keep their routine ids.
- New sessions are inserted. Sessions are never deleted (drop work by removing exercises).
- `timing=next_week` leaves this week alone and queues Monday — refused if a block is already pending.

---

## Remote (Claude web / mobile)

**Today (flag off):** Edge function `supabase/functions/mcp`. Auth is an opaque `mcp_token` bearer minted in the app — **not** a Supabase JWT.

**At cutover (`VITE_API_BASE_URL=/api` or the Worker origin + `/api`):** the same tools live on the Hono Worker at `/api/mcp` (Profile already uses `mcpUrl()`). The edge function is retired then; existing hashed tokens keep working because the Neon copy of `mcp_token` is the same rows. Do not leave a connector pointed at `functions/v1/mcp` after cutover — it would keep reading the old Supabase store.

### Wire it once

1. Open Zeroed → **You** (Profile) → **Claude connector** → Create a named token.
2. **Copy URL + token** (shown once).
3. In Claude: **Customize → Connectors → Add custom connector**.
4. Name it `Zeroed`, paste the URL (it already includes `apikey=`).
5. Auth: `Authorization: Bearer <token>`. **Skip any OAuth / login card.**
6. Enable the connector in a chat and ask: *What's on my training week?*

URL shape:

```
https://<project>.supabase.co/functions/v1/mcp?apikey=<anon_key>
```

Deploy / redeploy the function:

```bash
npx supabase functions deploy mcp --no-verify-jwt --project-ref pzxkcngdmkjjwbimncdx
```

Revoke a leaked token from the same Profile screen.

---

## Local (this machine)

```bash
cd mcp
npm install
cp .env.example .env
```

**Bridge mode (use this since the Oct 27 cutover).** Production is the
Cloudflare Worker on Neon; Supabase is the frozen rollback copy. Set these two
and the local server forwards every tool to production, with the same tools and
answers as the remote connector, and no database credentials on this machine:

```
ZEROED_MCP_URL=https://zeroed.madeforgreatnesslabs.com/functions/v1/mcp
ZEROED_MCP_TOKEN=<from the app: Profile → Claude connector → Create token>
```

With `ZEROED_MCP_URL` set and no token, the server refuses to start rather than
quietly serving the rollback copy. Comment out `ZEROED_MCP_URL` to fall back to
the Supabase modes below.

Otherwise, fill `mcp/.env` with one of the two Supabase auth modes.

**Athlete login (preferred).** Same RLS as the app — Claude can only see your rows.

```
ZEROED_SUPABASE_URL=https://xxxx.supabase.co
ZEROED_SUPABASE_ANON_KEY=eyJ...
ZEROED_EMAIL=you@example.com
ZEROED_PASSWORD=your-app-password
```

**Service role (this machine only).** Needed only if you do not want to store a password. Name the athlete; the key bypasses RLS.

```
ZEROED_SUPABASE_URL=https://xxxx.supabase.co
ZEROED_SUPABASE_SERVICE_ROLE_KEY=eyJ...
ZEROED_ATHLETE_EMAIL=you@example.com
```

Never commit either file. `mcp/.env` is gitignored.

Sanity check (does not need Claude):

```bash
npm --prefix mcp run check
```

The lift model straight off your live log (same text `get_lift_model` returns):

```bash
npm run lift-model            # all four main lifts
npm run lift-model -- ohp     # one
```

The server itself stays quiet until a client connects over stdin:

```bash
npm --prefix mcp start
```

### Claude Desktop (Local dev)

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add the `zeroed` block from `claude_desktop_config.example.json`. Use **absolute** paths.

1. Restart Claude Desktop.
2. Ask: *What's on my training week, and how has my squat moved?*
3. To change the program: *Add box jumps after the squat on Lower A — preview first.* Then confirm before anything is written.

### Cursor / Claude Code

Copy `cursor-mcp.example.json` into `~/.cursor/mcp.json` (Cursor) or `.mcp.json` at the repo root (Claude Code). Same absolute-path rule. Reload MCP servers after editing.

## Safety

- `apply_program_edits` without `confirm=true` is a no-op.
- Preview and apply re-read the live week, so a stale preview cannot silently overwrite a later in-app edit with the old snapshot.
- Remote tokens are hashed at rest; revoke anytime from Profile.
- Local service-role writes are still scoped to the resolved athlete id. Prefer athlete login for local, and Profile tokens for remote.
