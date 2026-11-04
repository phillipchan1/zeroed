/**
 * POST /api/session-rx — the Worker is the only place a session prescription
 * is computed. Auth matches /api/data. Ownership is re-checked per routine.
 */
import type { ExerciseTemplate, InsightRow, SetLog, WeeklyDirective, WeeklyPrescription } from '../../src/types/database.ts'
import { unitContext, type WeightUnit } from '../../src/lib/units.ts'
import {
  computeSessionPrescription, exerciseStamp, rxVersionHash,
  type SessionPrescription,
} from '../../src/engine/sessionRxCompute.ts'
import { convertTmOverride, readTmOverride, type DayOf, type LiftModelSources } from '../../src/engine/liftModel.ts'
import { readLoggedExercises } from '../../src/engine/loggedSets.ts'
import { topWorkingSet } from '../../supabase/functions/_shared/zeroedFormat.ts'
import { beginAuthCors, json } from './cors.ts'
import { asJson, withSql, type Sql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { sessionFromRequest, resolveAthleteId } from './data.ts'
import { athleteOwnsRoutine } from './edits.ts'
import { loadInsights, loadLiftModelSources, loadLiveProgram, makeStore, type ConnectedStore } from './store.ts'
import { overrideContextFor, type OverrideContext } from './sessionOverride.ts'

export interface SessionRxBody {
  routine_id?: string
  routine_ids?: string[]
  exercises?: ExerciseTemplate[]
  exercises_by_id?: Record<string, ExerciseTemplate[]>
  day_of?: DayOf | null
  unit?: WeightUnit
  storage_unit?: WeightUnit
  version_only?: boolean
  /** YYYY-MM-DD the session is for. tracks_v1: applies that date's week-only overrides. */
  date?: string
}

function asUnit(v: unknown, fallback: WeightUnit): WeightUnit {
  return v === 'kg' || v === 'lb' ? v : fallback
}

function asInsight(row: { id: string; category: string; confidence: number; status: string; program_impact: string | null }): InsightRow {
  return row as InsightRow
}

function basesFromWorkouts(workouts: LiftModelSources['workouts']): Map<string, SetLog> {
  const out = new Map<string, SetLog>()
  for (const w of [...workouts].reverse()) {
    for (const { name, sets } of readLoggedExercises(w)) {
      if (out.has(name)) continue
      const top = topWorkingSet(sets)
      if (top) out.set(name, top)
    }
  }
  return out
}

async function lastWorkoutForRoutine(
  store: ConnectedStore,
  routineId: string,
): Promise<{ weights: Record<string, SetLog[]> | null; snapshot: ExerciseTemplate[] | null; performedAt: string | null }> {
  const [row] = await store.sql<{
    actual_weights: unknown
    exercises_snapshot: unknown
    performed_at: string | null
  }[]>`
    SELECT w.actual_weights, w.exercises_snapshot, to_json(w.performed_at) #>> '{}' AS performed_at
    FROM workout w
    WHERE w.routine_id = ${routineId}
    ORDER BY w.performed_at DESC
    LIMIT 1
  `
  return {
    weights: row ? asJson<Record<string, SetLog[]> | null>(row.actual_weights, null) : null,
    snapshot: row ? asJson<ExerciseTemplate[] | null>(row.exercises_snapshot, null) : null,
    performedAt: row?.performed_at ?? null,
  }
}

async function latestReview(store: ConnectedStore, programId: string | null): Promise<{
  directive: WeeklyDirective | null
  loadDeltaPct: number
  rpeTarget: number | null
  rationale: string | null
  weekEnding: string | null
}> {
  if (!programId) {
    return { directive: null, loadDeltaPct: 0, rpeTarget: null, rationale: null, weekEnding: null }
  }
  const [review] = await store.sql<{ week_ending: string; next_week_prescription: unknown }[]>`
    SELECT week_ending::text, next_week_prescription
    FROM weekly_review
    WHERE program_id = ${programId}
    ORDER BY week_ending DESC
    LIMIT 1
  `
  const presc = review ? asJson<WeeklyPrescription | null>(review.next_week_prescription, null) : null
  return {
    directive: presc?.directive ?? null,
    loadDeltaPct: presc?.load_delta_pct ?? 0,
    rpeTarget: presc?.rpe_target ?? null,
    rationale: presc?.rationale ?? null,
    weekEnding: review?.week_ending ?? null,
  }
}

function liftSrcForDisplay(src: LiftModelSources, u: ReturnType<typeof unitContext>): LiftModelSources {
  const stored = src.overrides ?? null
  const overrides = stored
    ? Object.fromEntries(Object.entries(stored).flatMap(([k, v]) => {
      const o = readTmOverride(v)
      return o ? [[k, convertTmOverride(o, u.show)]] : []
    }))
    : null
  return {
    ...src,
    overrides,
    unit: u.unit,
    convert: (w) => u.show(w),
  }
}

async function programVersionOf(live: Awaited<ReturnType<typeof loadLiveProgram>>, liftSrc: LiftModelSources): Promise<string> {
  return rxVersionHash({
    sessions: (live?.sessions ?? []).map((s) => ({
      id: s.routineId,
      name: s.name,
      exercises: s.exercises.map(exerciseStamp),
    })),
    rules: liftSrc.progressionRules ?? [],
    overrides: liftSrc.overrides ?? null,
    phase: live?.phaseName ?? null,
  })
}

async function prescribeOne(
  store: ConnectedStore,
  opts: {
    routineId: string
    exercises?: ExerciseTemplate[]
    dayOf: DayOf | null
    u: ReturnType<typeof unitContext>
    liftSrc: LiftModelSources
    live: Awaited<ReturnType<typeof loadLiveProgram>>
    p1: InsightRow | null
    review: Awaited<ReturnType<typeof latestReview>>
    programVersion: string
    overrides?: OverrideContext | null
  },
): Promise<{ prescription: SessionPrescription; version: string }> {
  const session = opts.live?.sessions.find((s) => s.routineId === opts.routineId)
    ?? opts.live?.scheduledSessions.find((s) => s.routineId === opts.routineId)
    ?? null
  let meta: { name: string; intent: string | null; exercises: unknown } | undefined
  if (!session) {
    const rows = await store.sql<{ name: string; intent: string | null; exercises: unknown }[]>`
      SELECT name, intent, exercises FROM routine WHERE id = ${opts.routineId} LIMIT 1
    `
    meta = rows[0]
  }
  const templateExercises = opts.exercises?.length
    ? opts.exercises
    : (session?.exercises ?? asJson<ExerciseTemplate[]>(meta?.exercises, []))
  // A week-only override for this date replaces the session's list before the
  // engine prescribes it, so an added or swapped lift gets the same math.
  const override = opts.overrides?.forRoutine(opts.routineId, templateExercises) ?? null
  const exercises = override ? override.exercises : templateExercises
  const last = await lastWorkoutForRoutine(store, opts.routineId)
  const displaySrc = liftSrcForDisplay(opts.liftSrc, opts.u)
  const rx = computeSessionPrescription({
    exercises,
    u: opts.u,
    phaseName: opts.live?.phaseName ?? displaySrc.phaseName ?? null,
    directive: opts.review.directive,
    loadDeltaPct: opts.review.loadDeltaPct,
    rpeTarget: opts.review.rpeTarget,
    rationale: opts.review.rationale,
    p1: opts.p1,
    lastWeights: last.weights,
    // Last weights are keyed by slot. With an override reshaping the list, an
    // old workout with no snapshot was logged against the template.
    lastSnapshot: last.snapshot ?? (override ? templateExercises : null),
    routineName: session?.name ?? meta?.name ?? null,
    routineIntent: session?.intent ?? meta?.intent ?? null,
    byName: basesFromWorkouts(displaySrc.workouts),
    liftSrc: displaySrc,
    dayOf: opts.dayOf,
    today: displaySrc.today ?? '',
  })
  const version = rxVersionHash({
    exercises: exercises.map(exerciseStamp),
    rules: displaySrc.progressionRules ?? [],
    overrides: displaySrc.overrides ?? null,
    last: last.performedAt,
    review: opts.review,
    dayOf: opts.dayOf ?? null,
    program: opts.programVersion,
    ...(override ? { override } : {}),
  })
  return { prescription: override ? { ...rx, version, override } : { ...rx, version }, version }
}

/**
 * The prescription payload for an athlete already resolved from the session.
 * Separate from the handler so checks can drive it without an auth cookie.
 */
export async function sessionRxForAthlete(sql: Sql, athleteId: string, body: SessionRxBody): Promise<[unknown, number]> {
  const store = makeStore(sql, athleteId, asUnit(body.unit, 'lb'))
  const u = unitContext(asUnit(body.unit, 'lb'), asUnit(body.storage_unit, asUnit(body.unit, 'lb')))
  const [liftSrc, live, insights] = await Promise.all([
    loadLiftModelSources(store),
    loadLiveProgram(store),
    loadInsights(store),
  ])
  const p1 = insights[0] ? asInsight(insights[0]) : null
  const review = await latestReview(store, live?.programId ?? null)
  const programVersion = await programVersionOf(live, liftSrc)
  const dayOf = body.day_of ?? null

  if (body.version_only) {
    return [{ program_version: programVersion, version: programVersion }, 200]
  }
  // Null unless a date was sent, tracks_v1 is on and that date has an override.
  // With it null, everything below is exactly the pre-override path.
  const overrides = await overrideContextFor(store, body.date)

  const ids = [
    ...(body.routine_id ? [body.routine_id] : []),
    ...(Array.isArray(body.routine_ids) ? body.routine_ids : []),
  ].filter((id, i, all) => typeof id === 'string' && id && all.indexOf(id) === i)

  if (!ids.length) return [{ error: 'routine_id required' }, 400]

  for (const id of ids) {
    if (!(await athleteOwnsRoutine(store, id))) {
      return [{ error: 'not found' }, 404]
    }
  }

  if (ids.length === 1 && !body.routine_ids) {
    const one = await prescribeOne(store, {
      routineId: ids[0],
      exercises: body.exercises,
      dayOf, u, liftSrc, live, p1, review, programVersion, overrides,
    })
    return [{
      prescription: one.prescription,
      version: one.version,
      program_version: programVersion,
    }, 200]
  }

  const prescriptions: Record<string, SessionPrescription> = {}
  const versions: Record<string, string> = {}
  for (const id of ids) {
    const one = await prescribeOne(store, {
      routineId: id,
      exercises: body.exercises_by_id?.[id],
      dayOf, u, liftSrc, live, p1, review, programVersion, overrides,
    })
    prescriptions[id] = one.prescription
    versions[id] = one.version
  }
  return [{ prescriptions, versions, program_version: programVersion }, 200]
}

export async function handleSessionRx(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)

  let body: SessionRxBody
  try {
    body = await req.json() as SessionRxBody
  } catch {
    return json({ error: 'invalid json' }, 400, cors)
  }

  try {
    return await withSql(env, async (sql) => {
      const user = await sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET)
      if (!user) return json({ error: 'unauthorized' }, 401, cors)
      const athleteId = await resolveAthleteId(sql, user.id)
      if (!athleteId) return json({ error: 'unauthorized' }, 401, cors)
      const [out, status] = await sessionRxForAthlete(sql, athleteId, body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'request failed' }, 500, cors)
  }
}
