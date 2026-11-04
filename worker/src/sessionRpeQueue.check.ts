// Session RPE offline queue and the after-midnight grace (Round 2 item 4),
// against a real schema, on a pinned server clock. Flag off: /api/session-rpe
// answers 404 to a queued tap too and nothing is written. Flag on: a queued
// tap (client_id + tapped_at) lands once; a retry of it is "Already logged"
// with no second change_log row; a queued tap older than the row's latest is
// acknowledged, not applied; last night's session can be rated until 04:00
// athlete-local, not after; a queued tap is judged at its own time, trusted
// only between now − 48 h and now + 5 min, so it can't backdate a rating
// beyond its window. Before session-rpe-queue.sql the tap time is ignored.
// Athletes A and B never see or dedupe against each other's taps.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/sessionRpeQueue.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { type OverrideActor } from './sessionOverride.ts'
import { addDays } from './readiness/rules.ts'
import { athleteSessionRpeAction, logSessionRpe, ratableDates, sessionRpeQueueCols } from './sessionRpe.ts'
import { makeStore } from './store.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const B_DAY = '88888888-8888-8888-8888-888888888888'
const C1 = 'c1c1c1c1-0000-4000-8000-000000000001'
const C2 = 'c1c1c1c1-0000-4000-8000-000000000002'
const C3 = 'c1c1c1c1-0000-4000-8000-000000000003'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const athleteA: OverrideActor = { type: 'athlete', id: A }
const athleteB: OverrideActor = { type: 'athlete', id: B }

// UTC athletes, so the clock below reads as written.
await harness.query(`UPDATE athlete SET time_zone = 'UTC' WHERE id IN ($1, $2)`, [A, B])
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await harness.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params))[0].n)
const at = (iso: string) => new Date(iso)
const tap = (body: Record<string, unknown>, now: Date, store = storeA, actor = athleteA) => logSessionRpe(store, actor, body, now)
const ratingOn = async (date: string, athleteId = A, session = A_DAY) =>
  (await harness.query<{ rating: number; client_id: string | null }>(
    `SELECT rating::int AS rating, client_id::text AS client_id FROM session_rpe WHERE athlete_id = $1 AND date = $2::date AND session_id = $3`,
    [athleteId, date, session]))[0] ?? null
const taps = () => count('change_log', `tool = 'log_session_rpe'`)

const D = '2026-03-10'

// ---- pure: the window ------------------------------------------------------------------------
ok(ratableDates(at(`${D}T12:00:00Z`), 'UTC').join() === D, 'window: midday rates today only')
ok(ratableDates(at(`${addDays(D, 1)}T03:59:59Z`), 'UTC').join() === `${addDays(D, 1)},${D}`, 'window: 03:59 still rates last night')
ok(ratableDates(at(`${addDays(D, 1)}T04:00:00Z`), 'UTC').join() === addDays(D, 1), 'window: from 04:00 only today')
ok(ratableDates(at(`${addDays(D, 1)}T10:30:00Z`), 'America/Los_Angeles').join() === `${addDays(D, 1)},${D}`, 'window: athlete-local — 10:30Z is 03:30 (PDT) in Los Angeles, last night still open')
ok(ratableDates(at(`${addDays(D, 1)}T00:30:00Z`), 'America/Los_Angeles').join() === `${D}`, 'window: 00:30Z is the evening before in Los Angeles')

// ---- flag OFF: unchanged ----------------------------------------------------------------------
const queued = { session_id: A_DAY, rating: 6, duration_min: 45, date: D, client_id: C1, tapped_at: `${D}T18:00:00Z` }
const [offOut, offStatus] = await athleteSessionRpeAction(storeA, { action: 'log', ...queued }, at(`${D}T18:05:00Z`))
ok(offStatus === 404 && (offOut as { error?: string }).error === 'not found', 'flag off: a queued tap gets 404, as before (the app drops it)')
ok(!(await tap(queued, at(`${D}T18:05:00Z`))).ok, 'flag off: refused')
ok(await count('session_rpe') === 0 && await count('change_log') === 0, 'flag off: nothing written')

await flag(A, true)
ok(await sessionRpeQueueCols(storeA), 'schema: the queue columns are on')

// ---- queued tap syncs once ----------------------------------------------------------------------
const first = await tap(queued, at(`${D}T18:05:00Z`))
ok(first.ok && first.text === 'Logged.' && first.rating?.rating === 6, 'queue: the queued tap lands')
ok((await ratingOn(D))?.client_id === C1 && await taps() === 1, 'queue: one row, one change_log row, carrying its client_id')
const retry = await tap(queued, at(`${D}T18:06:00Z`))
ok(retry.ok && retry.text === 'Already logged.' && retry.rating?.rating === 6 && await taps() === 1, 'retry: the same tap again is "Already logged", no second write')
const viaRoute = (await athleteSessionRpeAction(storeA, { action: 'log', ...queued }, at(`${addDays(D, 1)}T09:00:00Z`)))[0] as { ok: boolean; text: string }
ok(viaRoute.ok && viaRoute.text === 'Already logged.' && await taps() === 1, 'retry: next morning through the route, still deduped')
const reused = await tap({ ...queued, rating: 2 }, at(`${D}T18:07:00Z`))
ok(reused.ok && reused.text === 'Already logged.' && (await ratingOn(D))?.rating === 6 && await taps() === 1, 'retry: a client_id already applied never changes the rating')
ok(await count('session_rpe', 'athlete_id = $1', [A]) === 1, 'one per session per day still holds')

// ---- ordering: a stale queued tap never lands over a newer one ---------------------------------
const newer = await tap({ session_id: A_DAY, rating: 7, date: D, client_id: C2, tapped_at: `${D}T19:00:00Z` }, at(`${D}T19:00:30Z`))
ok(newer.ok && newer.text === 'Updated.' && (await ratingOn(D))?.rating === 7, 'update semantics unchanged: a later tap updates the row')
const stale = await tap({ session_id: A_DAY, rating: 3, date: D, client_id: C3, tapped_at: `${D}T18:30:00Z` }, at(`${D}T20:00:00Z`))
ok(stale.ok && stale.text === 'A newer rating is already logged.' && (await ratingOn(D))?.rating === 7, 'ordering: an older queued tap is acknowledged, not applied')
ok(await taps() === 2, 'ordering: and writes nothing')
const online = await tap({ session_id: A_DAY, rating: 8, date: D }, at(`${D}T21:00:00Z`))
ok(online.ok && online.text === 'Updated.' && (await ratingOn(D))?.client_id === null, 'an untimed tap (no client_id) still updates, at the server\'s time')

// ---- after midnight: last night's session ---------------------------------------------------------
const D2 = addDays(D, 3)
const late = await tap({ session_id: A_DAY, rating: 5, date: D2 }, at(`${addDays(D2, 1)}T03:30:00Z`))
ok(late.ok && late.text === 'Logged.' && (await ratingOn(D2))?.rating === 5, 'grace: last night\'s session rated at 03:30')
const lateEdit = await tap({ session_id: A_DAY, rating: 6, date: D2 }, at(`${addDays(D2, 1)}T03:59:00Z`))
ok(lateEdit.ok && lateEdit.text === 'Updated.', 'grace: and changed at 03:59')
const tooLate = await tap({ session_id: A_DAY, rating: 4, date: D2 }, at(`${addDays(D2, 1)}T04:00:00Z`))
ok(!tooLate.ok && /04:00/.test(tooLate.text) && (await ratingOn(D2))?.rating === 6, 'grace: refused from 04:00, the rating unchanged')
ok(!(await tap({ session_id: A_DAY, rating: 4, date: addDays(D2, -1) }, at(`${addDays(D2, 1)}T02:00:00Z`))).ok, 'grace: two nights back is refused')
ok(!(await tap({ session_id: A_DAY, rating: 4, date: addDays(D2, 2) }, at(`${addDays(D2, 1)}T02:00:00Z`))).ok, 'grace: a future day is refused')
await harness.query(`UPDATE athlete SET time_zone = 'America/Los_Angeles' WHERE id = $1`, [A])
const D3 = addDays(D, 5)
ok((await tap({ session_id: A_DAY, rating: 5, date: D3 }, at(`${addDays(D3, 1)}T10:30:00Z`))).ok, 'grace, athlete-local: 10:30Z is 03:30 in Los Angeles, last night\'s session is open')
ok(!(await tap({ session_id: A_DAY, rating: 5, date: D3 }, at(`${addDays(D3, 1)}T12:30:00Z`))).ok, 'grace, athlete-local: 12:30Z is 05:30 there, closed')
await harness.query(`UPDATE athlete SET time_zone = 'UTC' WHERE id = $1`, [A])

// ---- queued taps judged at their own time, within bounds ----------------------------------------
const D4 = addDays(D, 8)
const synced = await tap({ session_id: A_DAY, rating: 6, date: D4, client_id: crypto.randomUUID(), tapped_at: `${D4}T23:30:00Z` }, at(`${addDays(D4, 1)}T15:00:00Z`))
ok(synced.ok && synced.text === 'Logged.', 'queued: tapped 23:30, synced the next afternoon → taken for the session\'s own date')
const D5 = addDays(D, 10)
ok((await tap({ session_id: A_DAY, rating: 6, date: D5, client_id: crypto.randomUUID(), tapped_at: `${addDays(D5, 1)}T03:00:00Z` }, at(`${addDays(D5, 1)}T12:00:00Z`))).ok,
  'queued: tapped at 03:00 inside the grace, synced at noon → taken')
const D6 = addDays(D, 12)
const outside = await tap({ session_id: A_DAY, rating: 6, date: D6, client_id: crypto.randomUUID(), tapped_at: `${addDays(D6, 1)}T05:00:00Z` }, at(`${addDays(D6, 1)}T06:00:00Z`))
ok(!outside.ok && (await ratingOn(D6)) === null, 'queued: tapped at 05:00 the next day is outside the window → refused')

// No backdating: the tap time is only believed between now − 48 h and now + 5 min.
const NOW = at(`${addDays(D, 20)}T12:00:00Z`)
const tooOld = await tap({ session_id: A_DAY, rating: 6, date: addDays(D, 18), client_id: crypto.randomUUID(), tapped_at: new Date(NOW.getTime() - 49 * 3600_000).toISOString() }, NOW)
ok(!tooOld.ok && /48 hours/.test(tooOld.text), 'backdating: a tap time 49 h old is refused')
const edge = await tap({ session_id: A_DAY, rating: 6, date: addDays(D, 18), client_id: crypto.randomUUID(), tapped_at: new Date(NOW.getTime() - 47 * 3600_000).toISOString() }, NOW)
ok(edge.ok, 'backdating: 47 h old, inside its own date\'s window (13:00 two days ago) → taken')
const pastWindow = await tap({ session_id: A_DAY, rating: 6, date: addDays(D, 17), client_id: crypto.randomUUID(), tapped_at: new Date(NOW.getTime() - 47 * 3600_000).toISOString() }, NOW)
ok(!pastWindow.ok && (await ratingOn(addDays(D, 17))) === null, 'backdating: a believable tap time can\'t rate a day whose window it is outside')
const future = await tap({ session_id: A_DAY, rating: 6, date: addDays(D, 20), client_id: crypto.randomUUID(), tapped_at: new Date(NOW.getTime() + 10 * 60_000).toISOString() }, NOW)
ok(!future.ok && /future/.test(future.text), 'backdating: a tap time 10 min ahead is refused')
const skew = await tap({ session_id: A_DAY, rating: 6, date: addDays(D, 20), client_id: crypto.randomUUID(), tapped_at: new Date(NOW.getTime() + 2 * 60_000).toISOString() }, NOW)
ok(skew.ok, 'clock skew: 2 min ahead is taken (as now)')
const skewNextDay = await tap({ session_id: A_DAY, rating: 6, date: addDays(D, 21), client_id: crypto.randomUUID(), tapped_at: `${addDays(D, 21)}T00:03:00Z` }, at(`${addDays(D, 20)}T23:59:00Z`))
ok(!skewNextDay.ok, 'clock skew: a fast clock can\'t rate tomorrow')
ok(!(await tap({ session_id: A_DAY, rating: 6, date: D, client_id: 'nope', tapped_at: `${D}T18:00:00Z` }, at(`${D}T18:05:00Z`))).ok, 'client_id must be a UUID')
ok(!(await tap({ session_id: A_DAY, rating: 6, date: D, client_id: crypto.randomUUID(), tapped_at: 'last night' }, at(`${D}T18:05:00Z`))).ok, 'tapped_at must be a timestamp')

// ---- isolation ----------------------------------------------------------------------------------
await flag(B, true)
const bWithA = await tap({ session_id: B_DAY, rating: 4, date: D, client_id: C1, tapped_at: `${D}T18:00:00Z` }, at(`${D}T18:05:00Z`), storeB, athleteB)
ok(bWithA.ok && bWithA.text === 'Logged.' && (await ratingOn(D, B, B_DAY))?.rating === 4, 'isolation: A\'s client_id dedupes nothing for B — B\'s own tap lands')
ok((await ratingOn(D))?.rating === 8 && await count('session_rpe', 'athlete_id = $1 AND client_id = $2', [A, C1]) === 0, 'isolation: A\'s row is untouched')
const bOnA = await tap({ session_id: A_DAY, rating: 1, date: D, client_id: C2, tapped_at: `${D}T18:00:00Z` }, at(`${D}T18:05:00Z`), storeB, athleteB)
ok(!bOnA.ok, 'isolation: B can\'t rate A\'s session, even with a queued tap')
ok(!(await tap({ session_id: A_DAY, rating: 1, date: D, client_id: C1 }, at(`${D}T18:05:00Z`), storeA, athleteB)).ok, 'isolation: B acting on A\'s store is refused')
const bList = (await athleteSessionRpeAction(storeB, { action: 'list', from: addDays(D, -1), to: addDays(D, 30) }, at(`${D}T18:05:00Z`)))[0] as { ratings: Array<{ session_id: string }> }
ok(bList.ratings.length === 1 && bList.ratings[0].session_id === B_DAY, 'isolation: B lists only B\'s rating')

// ---- before session-rpe-queue.sql: the tap time is ignored, the grace still works ----------------
const tapsBefore = await taps()
await harness.exec(`DROP INDEX IF EXISTS session_rpe_athlete_client_uidx; ALTER TABLE session_rpe DROP COLUMN client_id, DROP COLUMN tapped_at;`)
ok(!(await sessionRpeQueueCols(storeA)), 'old schema: detected')
const D7 = addDays(D, 25)
ok(!(await tap({ session_id: A_DAY, rating: 6, date: D7, client_id: crypto.randomUUID(), tapped_at: `${D7}T22:00:00Z` }, at(`${addDays(D7, 1)}T12:00:00Z`))).ok, 'old schema: a queued tap counts as sent now (no backdating without the columns)')
ok((await tap({ session_id: A_DAY, rating: 6, date: D7, client_id: crypto.randomUUID(), tapped_at: `${D7}T22:00:00Z` }, at(`${addDays(D7, 1)}T01:00:00Z`))).ok, 'old schema: inside the 04:00 grace it lands')
ok(await taps() === tapsBefore + 1, 'old schema: one write')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
