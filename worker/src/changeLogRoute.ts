/**
 * /api/change-log — the athlete's Changes feed and one-tap undo (G2,
 * tracks_v1). The work is in changeLog.ts; this is auth and routing.
 */
import { beginAuthCors, json } from './cors.ts'
import { withSql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { listChanges, revertChange } from './changeLog.ts'
import { tracksV1On } from './sessionOverride.ts'
import { makeStore, type ConnectedStore } from './store.ts'

type Obj = Record<string, unknown>

/**
 * POST /api/change-log            { action: 'list', before?, limit? } → ChangePage
 *                                 { action: 'revert', id }            → RevertResult
 * POST /api/change-log/:id/revert                                     → RevertResult
 * The athlete's own session; same auth as /api/session-rx. 404 unless
 * tracks_v1 is on, so the route reads as absent with the flag off.
 */
export async function handleChangeLog(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)

  const pathId = /\/api\/change-log\/([^/]+)\/revert\/?$/.exec(new URL(req.url).pathname)?.[1] ?? null
  let body: Obj = {}
  try {
    body = await req.json() as Obj
  } catch {
    if (!pathId) return json({ error: 'invalid json' }, 400, cors)
  }
  if (pathId) body = { action: 'revert', id: decodeURIComponent(pathId) }

  try {
    return await withSql(env, async (sql) => {
      const user = await sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET)
      if (!user) return json({ error: 'unauthorized' }, 401, cors)
      const athleteId = await resolveAthleteId(sql, user.id)
      if (!athleteId) return json({ error: 'unauthorized' }, 401, cors)
      const [out, status] = await athleteChangeLogAction(makeStore(sql, athleteId, 'lb'), body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'change log request failed' }, 500, cors)
  }
}

/** The route's body, separated so checks can drive it without an auth cookie. */
export async function athleteChangeLogAction(store: ConnectedStore, body: Obj): Promise<[unknown, number]> {
  if (!(await tracksV1On(store))) return [{ error: 'not found' }, 404]
  switch (body.action) {
    case 'list': {
      const page = await listChanges(store, { before: body.before, limit: typeof body.limit === 'number' ? body.limit : 30 })
      return [page ?? { changes: null, next_before: null }, 200]
    }
    case 'revert': {
      const id = typeof body.id === 'string' ? body.id : ''
      return [await revertChange(store, { type: 'athlete', id: store.athleteId }, id), 200]
    }
    default:
      return [{ error: 'unknown action' }, 400]
  }
}
