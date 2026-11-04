// The app's session-RPE tap queue (tracks_v1, Round 2 item 4), against a fake
// server that dedupes on client_id the way the Worker does. A queued tap syncs
// once; a retry after a lost answer is idempotent; a definitive rejection drops
// it; "later" keeps it and stops the pass; a newer tap replaces one waiting;
// concurrent flushes send once. Flag off: the app only queues under tracksOn()
// and the sync is a no-op on an empty queue. Synthetic data only.
// Run: node --experimental-strip-types src/lib/sessionRpeQueue.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// A device's localStorage, before the module reads it.
const mem = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v) },
}
const { enqueueTap, flushTapQueue, queuedTapFor, queuedTaps, subscribeTapQueue, tapOutcome, TAP_KEEP_MS } = await import('./sessionRpeQueue.ts')
type QueuedTap = import('./sessionRpeQueue.ts').QueuedTap
type TapOutcome = import('./sessionRpeQueue.ts').TapOutcome

const S1 = 'aaaa0000-0000-4000-8000-000000000001'
const S2 = 'aaaa0000-0000-4000-8000-000000000002'
const D = '2026-03-10'

// ---- outcomes --------------------------------------------------------------------------------
ok(tapOutcome(null, null).kind === 'later', 'outcome: no answer (offline) → later')
ok(tapOutcome(503, null).kind === 'later' && tapOutcome(500, { error: 'x' }).kind === 'later', 'outcome: 5xx → later')
ok(tapOutcome(401, null).kind === 'later', 'outcome: signed out → later (it syncs after sign-in)')
ok(tapOutcome(200, { ok: true, text: 'Logged.' }).kind === 'accepted', 'outcome: logged → accepted')
ok(tapOutcome(200, { ok: true, text: 'Already logged.' }).kind === 'accepted', 'outcome: already logged → accepted')
ok(tapOutcome(200, { ok: true, text: 'A newer rating is already logged.' }).kind === 'accepted', 'outcome: superseded → accepted')
ok(tapOutcome(200, { ok: false, text: 'Refused: …' }).kind === 'rejected', 'outcome: refused → rejected for good')
ok(tapOutcome(200, { ok: false, text: 'not set up', retry: true }).kind === 'later', 'outcome: refused with retry (table not there yet) → later')
ok(tapOutcome(404, { error: 'not found' }).kind === 'rejected', 'outcome: 404 (flag off) → rejected')
ok(tapOutcome(400, { error: 'unknown action' }).kind === 'rejected', 'outcome: 400 → rejected')

// ---- a fake Worker: dedupes on client_id ---------------------------------------------------------
let online = false
let loseAnswer = false
let refuse = false
const applied: string[] = []
const sent: string[] = []
const server = async (tap: QueuedTap): Promise<TapOutcome> => {
  sent.push(tap.client_id)
  if (!online) throw new TypeError('Failed to fetch')
  if (refuse) return tapOutcome(200, { ok: false, text: 'Refused: outside the window.' })
  const already = applied.includes(tap.client_id)
  if (!already) applied.push(tap.client_id)
  if (loseAnswer) throw new TypeError('network connection was lost')
  return tapOutcome(200, { ok: true, text: already ? 'Already logged.' : 'Logged.' })
}
const reset = () => { sent.length = 0; applied.length = 0; online = false; loseAnswer = false; refuse = false; mem.clear() }

let notified = 0
const unsub = subscribeTapQueue(() => { notified++ })

// ---- offline → queued → syncs once ---------------------------------------------------------------
let n = 0
const id = () => `c0000000-0000-4000-8000-00000000000${++n}`
const t1 = enqueueTap({ session_id: S1, date: D, rating: 6, duration_min: 50 }, new Date(`${D}T18:00:00Z`), id)
ok(queuedTaps().length === 1 && t1.tapped_at === `${D}T18:00:00.000Z` && t1.client_id.length > 0, 'queue: the tap is durable before any network, with its time and id')
ok(notified > 0, 'queue: subscribers hear about it (the "will sync" note)')
ok(queuedTapFor(S1, D)?.rating === 6, 'queue: the edit screen can read the waiting rating')
await flushTapQueue(server, () => new Date(`${D}T18:01:00Z`))
ok(queuedTaps().length === 1 && queuedTaps()[0].attempts === 1 && applied.length === 0, 'offline: kept, one attempt counted, nothing applied')
online = true
await flushTapQueue(server, () => new Date(`${D}T19:00:00Z`))
ok(queuedTaps().length === 0 && applied.length === 1, 'reconnect: synced once and cleared')
await flushTapQueue(server, () => new Date(`${D}T19:01:00Z`))
ok(sent.length === 2 && applied.length === 1, 'reconnect: nothing left to send')

// ---- the answer is lost: the retry is idempotent ----------------------------------------------------
reset()
online = true
loseAnswer = true
enqueueTap({ session_id: S1, date: D, rating: 7, duration_min: null }, new Date(`${D}T18:00:00Z`), id)
await flushTapQueue(server, () => new Date(`${D}T18:00:10Z`))
ok(applied.length === 1 && queuedTaps().length === 1, 'lost answer: the server applied it, the device still holds it')
loseAnswer = false
await flushTapQueue(server, () => new Date(`${D}T18:05:00Z`))
ok(applied.length === 1 && sent.length === 2 && sent[0] === sent[1] && queuedTaps().length === 0, 'lost answer: the retry carries the same client_id, the server applies it once, the queue clears')

// ---- definitive rejection drops it --------------------------------------------------------------------
reset()
online = true
refuse = true
enqueueTap({ session_id: S1, date: D, rating: 4, duration_min: null }, new Date(`${D}T18:00:00Z`), id)
await flushTapQueue(server, () => new Date(`${D}T18:00:10Z`))
ok(queuedTaps().length === 0 && applied.length === 0, 'rejected: dropped, never retried')
await flushTapQueue(server, () => new Date(`${D}T18:10:00Z`))
ok(sent.length === 1, 'rejected: not sent again')

// ---- "later" stops the pass; rejected doesn't block the rest -----------------------------------------
reset()
enqueueTap({ session_id: S1, date: D, rating: 5, duration_min: null }, new Date(`${D}T18:00:00Z`), id)
enqueueTap({ session_id: S2, date: D, rating: 3, duration_min: null }, new Date(`${D}T18:01:00Z`), id)
await flushTapQueue(server, () => new Date(`${D}T18:02:00Z`))
ok(sent.length === 1 && queuedTaps().length === 2, 'offline: the pass stops at the first tap; the second isn\'t burned')
online = true
refuse = true
await flushTapQueue(server, () => new Date(`${D}T18:03:00Z`))
ok(sent.length === 3 && queuedTaps().length === 0, 'rejections step over: both answered, both gone')

// ---- a newer tap replaces one still waiting -------------------------------------------------------
reset()
enqueueTap({ session_id: S1, date: D, rating: 5, duration_min: 40 }, new Date(`${D}T18:00:00Z`), id)
enqueueTap({ session_id: S1, date: D, rating: 8, duration_min: 40 }, new Date(`${D}T18:02:00Z`), id)
enqueueTap({ session_id: S1, date: '2026-03-09', rating: 2, duration_min: null }, new Date(`${D}T01:00:00Z`), id)
ok(queuedTaps().length === 2 && queuedTapFor(S1, D)?.rating === 8, 'replace: one tap per session and date, the newest')

// ---- concurrent flushes send once ------------------------------------------------------------------
reset()
online = true
enqueueTap({ session_id: S1, date: D, rating: 6, duration_min: null }, new Date(`${D}T18:00:00Z`), id)
await Promise.all([flushTapQueue(server, () => new Date(`${D}T18:01:00Z`)), flushTapQueue(server, () => new Date(`${D}T18:01:00Z`))])
ok(sent.length === 1 && applied.length === 1 && queuedTaps().length === 0, 'concurrency: launch + reconnect at once send the tap once')

// A tap queued while a pass is running goes out in that same pass.
reset()
online = true
enqueueTap({ session_id: S1, date: D, rating: 6, duration_min: null }, new Date(`${D}T18:00:00Z`), id)
const slow = async (tap: QueuedTap): Promise<TapOutcome> => {
  if (sent.length === 0) enqueueTap({ session_id: S2, date: D, rating: 4, duration_min: null }, new Date(`${D}T18:00:30Z`), id)
  return server(tap)
}
await flushTapQueue(slow, () => new Date(`${D}T18:01:00Z`))
ok(sent.length === 2 && queuedTaps().length === 0, 'mid-pass: a tap queued during a sync is sent in it')

// ---- too old to be taken: dropped unsent -----------------------------------------------------------
reset()
online = true
enqueueTap({ session_id: S1, date: D, rating: 6, duration_min: null }, new Date(`${D}T18:00:00Z`), id)
await flushTapQueue(server, () => new Date(new Date(`${D}T18:00:00Z`).getTime() + TAP_KEEP_MS + 60_000))
ok(sent.length === 0 && queuedTaps().length === 0, 'stale: a tap past the Worker\'s 48 h bound is dropped unsent')

// ---- a corrupt store doesn't break anything ---------------------------------------------------------
mem.set('zeroed:session-rpe-queue', '{not json')
ok(queuedTaps().length === 0, 'corrupt storage reads as empty')
unsub()

// ---- wiring: flag off unchanged ------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const rpeSrc = readFileSync(join(here, 'sessionRpe.ts'), 'utf8')
const workoutSrc = readFileSync(join(here, '../screens/loop/WorkoutScreen.tsx'), 'utf8')
const todaySrc = readFileSync(join(here, '../screens/loop/TodayScreen.tsx'), 'utf8')
const appSrc = readFileSync(join(here, '../App.tsx'), 'utf8')
ok(/if \(!queuedTaps\(\)\.length\) return Promise\.resolve\(\)/.test(rpeSrc), 'flag off: the sync sends nothing on an empty queue')
ok(/if \(tracksOn\(\) && sessionRpe != null\) \{\s*void logSessionRpe\(/.test(workoutSrc), 'flag off: the finish queues a tap only under tracksOn()')
ok(/tracksOn\(\) && rpeQueued > 0/.test(todaySrc), 'flag off: no "will sync" note')
ok(/useSessionRpeSync\(\)/.test(appSrc), 'the sync is mounted at the app root')
ok(/client_id: tap\.client_id/.test(rpeSrc) && /tapped_at: tap\.tapped_at/.test(rpeSrc), 'each send carries the tap\'s client_id and tapped_at')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
