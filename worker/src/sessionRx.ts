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
import { athleteToday, overrideContextFor, tracksV1On, type OverrideContext } from './sessionOverride.ts'
import { blockedRegions, engineParams, resolveMethodology, type Resolved } from './methodology.ts'
import { classify } from './methodology/classify.ts'
import { readinessContextFor, type ReadinessContext } from './readiness.ts'
import { applyReadiness } from './readiness/rules.ts'

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

/** What readiness changes for a date, as a version input. Only present when it changes something. */
function readinessKey(r: ReadinessContext | null): unknown {
  if (!r) return null
  return {
    date: r.date,
    flags: r.flags.map((f) => f.kind),
    regions: r.regions.map((x) => [x.region, x.status, x.score]),
    blocked: r.blocked,
  }
}

async function programVersionOf(
  live: Awaited<ReturnType<typeof loadLiveProgram>>,
  liftSrc: LiftModelSources,
  methodology: Resolved | null,
  readiness: ReadinessContext | null = null,
): Promise<string> {
  return rxVersionHash({
    // An override changes every number, so the app refetches. Absent with the
    // defaults: the same version as before G3.
    ...(methodology && methodology.version !== methodology.base_version ? { methodology: methodology.version } : {}),
    // G4: a check-in or a block changes today's numbers. Absent without one.
    ...(readiness ? { readiness: readinessKey(readiness) } : {}),
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
    methodology?: Resolved | null
    /** G4, tracks_v1: null unless the date has a check-in, a pain report or an open block. */
    readiness?: ReadinessContext | null
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
  const computed = computeSessionPrescription({
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
  const readiness = opts.readiness ?? null
  // v1.2: a temporary block (that day and the next session) is skipped by
  // applyReadiness with its own reason, not as a clinician-clearance block.
  const temporary = readiness ? readiness.temporary.map((t) => t.region) : []
  const limited = opts.methodology
    ? applyMethodologyLimits(computed, exercises, opts.methodology, readiness ? readiness.blocked.filter((r) => !temporary.includes(r)) : blockedRegions(opts.methodology))
    : computed
  const adjusted = opts.methodology && readiness
    ? applyReadiness(limited, exercises, {
      date: readiness.date, flags: readiness.flags, regions: readiness.regions, blocked: readiness.blocked, temporary,
      params: opts.methodology.params, unit: opts.u.unit,
    })
    : null
  const rx = adjusted ? { ...adjusted.rx, readiness: readiness!.view, adjustments: adjusted.adjustments } : limited
  const version = rxVersionHash({
    exercises: exercises.map(exerciseStamp),
    rules: displaySrc.progressionRules ?? [],
    overrides: displaySrc.overrides ?? null,
    last: last.performedAt,
    review: opts.review,
    dayOf: opts.dayOf ?? null,
    program: opts.programVersion,
    ...(override ? { override } : {}),
    // Only once an override or the under-18 rules change the numbers; the
    // defaults reproduce today's math, so today's version string stays.
    ...(opts.methodology && opts.methodology.version !== opts.methodology.base_version ? { methodology: opts.methodology.version } : {}),
    ...(readiness ? { readiness: readinessKey(readiness) } : {}),
  })
  const stamped = opts.methodology ? { ...rx, methodology_version: opts.methodology.version } : rx
  return { prescription: override ? { ...stamped, version, override } : { ...stamped, version }, version }
}

/**
 * tracks_v1: what the methodology forbids outright, applied after the math.
 * A red-flagged region (U7) is not loaded: those exercises are skipped with
 * the reason (G4: open region_status blocks too). Under 18 no RPE above the cap (D6); main lifts already ran at
 * it (engineParams.maxRpe), this caps the rest. Nothing changes otherwise.
 */
function applyMethodologyLimits(rx: SessionPrescription, exercises: ExerciseTemplate[], m: Resolved, blocked: string[]): SessionPrescription {
  const maxRpe = m.minor ? m.minors.max_rpe : null
  if (!blocked.length && maxRpe == null) return rx
  const out: SessionPrescription = {
    ...rx,
    targets: { ...rx.targets },
    hints: { ...rx.hints },
    skip: { ...(rx.skip ?? {}) },
    reasons: { ...(rx.reasons ?? {}) },
    exercises: rx.exercises?.map((e) => ({ ...e })),
  }
  exercises.forEach((ex, i) => {
    const region = blocked.length ? classify(ex).regions.find((r) => blocked.includes(r)) : undefined
    const row = out.exercises?.[i]
    if (region) {
      const why = `Red flag: ${region.replace('_', ' ')} is blocked until a clinician clears it — no loading there (U7)`
      out.targets[i] = null
      out.hints[i] = 'Skip today — red flag'
      out.skip![i] = true
      out.reasons![i] = [why, ...(out.reasons![i] ?? [])]
      if (row) Object.assign(row, { load: null, skip: true, call: 'SKIP', reason: why, reasons: out.reasons![i] })
      return
    }
    if (maxRpe != null && row && row.rpe != null && row.rpe > maxRpe) {
      const why = `RPE ${row.rpe} → ${maxRpe}: no RPE above ${maxRpe} under 18`
      row.rpe = maxRpe
      row.reasons = [...row.reasons, why]
      out.reasons![i] = [...(out.reasons![i] ?? []), why]
    }
  })
  return out
}

/**
 * The prescription payload for an athlete already resolved from the session.
 * Separate from the handler so checks can drive it without an auth cookie.
 */
export async function sessionRxForAthlete(sql: Sql, athleteId: string, body: SessionRxBody): Promise<[unknown, number]> {
  const store = makeStore(sql, athleteId, asUnit(body.unit, 'lb'))
  const u = unitContext(asUnit(body.unit, 'lb'), asUnit(body.storage_unit, asUnit(body.unit, 'lb')))
  const [loaded, live, insights, flagOn] = await Promise.all([
    loadLiftModelSources(store),
    loadLiveProgram(store),
    loadInsights(store),
    tracksV1On(store),
  ])
  // G3, tracks_v1 only: the methodology this prescription runs on. With the
  // flag off it is null and everything below is exactly the pre-G3 path.
  const methodology = flagOn ? await resolveMethodology(store) : null
  const liftSrc = methodology ? { ...loaded, params: engineParams(methodology) } : loaded
  // G4, tracks_v1 only: the day's check-in, pain and blocks. Null when there
  // is nothing for this date, so the prescription is exactly the G3 one.
  const readinessCtx = methodology
    ? await readinessContextFor(store, typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : await athleteToday(store), methodology)
    : null
  const readiness = readinessCtx?.active ? readinessCtx : null
  const stamp = methodology ? { methodology_version: methodology.version, ...(readiness ? { readiness: readiness.view } : {}) } : {}
  const p1 = insights[0] ? asInsight(insights[0]) : null
  const review = await latestReview(store, live?.programId ?? null)
  const programVersion = await programVersionOf(live, loaded, methodology, readiness)
  const dayOf = body.day_of ?? null

  if (body.version_only) {
    return [{ program_version: programVersion, version: programVersion, ...stamp }, 200]
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
      dayOf, u, liftSrc, live, p1, review, programVersion, overrides, methodology, readiness,
    })
    return [{
      prescription: one.prescription,
      version: one.version,
      program_version: programVersion,
      ...stamp,
    }, 200]
  }

  const prescriptions: Record<string, SessionPrescription> = {}
  const versions: Record<string, string> = {}
  for (const id of ids) {
    const one = await prescribeOne(store, {
      routineId: id,
      exercises: body.exercises_by_id?.[id],
      dayOf, u, liftSrc, live, p1, review, programVersion, overrides, methodology, readiness,
    })
    prescriptions[id] = one.prescription
    versions[id] = one.version
  }
  return [{ prescriptions, versions, program_version: programVersion, ...stamp }, 200]
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
