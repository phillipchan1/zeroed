/**
 * One-time system job (spec section 11b, tracks_v1): re-evaluate, under
 * methodology v1.2, the persistent region blocks stored under v1.1.
 *
 *   v1.1 made every U7 block persistent (no loading until the athlete marks it
 *   cleared by a clinician). v1.2 (section 11a) keeps a block persistent only
 *   on a red flag, a rating > 5 twice within 14 days, or a rating rising
 *   across 3 sessions; any other block covers that day and the next session,
 *   then lapses. Section 11b: re-evaluate the stored ones once, as a logged
 *   `system` change. A block v1.2 wouldn't make persistent drops to temporary.
 *
 * Which blocks: per athlete with tracks_v1 on, each region whose latest
 * region_status row is an open block ('blocked', not cleared) written by a
 * check-in under v1 / v1.1, or with no version on record. Blocks stamped
 * v1.2, and re-blocks the athlete made by undoing a clinician clear, are not
 * touched. Athletes without tracks_v1 are not read at all.
 *
 * The decision (pure, decide()):
 *   minor or unknown age   kept (v1.1 behaviour stands under 18, section 11b)
 *   no report to judge     kept (the report that set it is gone or voided)
 *   v1.2 keeps it          kept: the report that set it, or any report of that
 *                          region since, is a red flag, > 5 twice within 14
 *                          days, or rising across 3 sessions (evaluateReport,
 *                          the same call check-ins make)
 *   otherwise              lifted: a new region_status row ('ok') supersedes
 *                          the block (nothing is deleted or edited) and one
 *                          change_log row records it — actor system, the job
 *                          name, methodology v1.2, before and after. If the
 *                          v1.2 temporary window (that day and the next logged
 *                          session, at most 14 days) is still open, readiness
 *                          derives the temporary block from the report as it
 *                          does for any v1.2 block; if it has passed, the
 *                          region is simply unblocked.
 * The athlete can undo a lift (reverts.ts, apply_block_reeval): the block is
 * persistent again. Redoing it is refused, like redoing a clinician clear.
 *
 * Idempotent: each athlete it looks at gets one apply_block_reeval_run row (the
 * marker, with the counts); an athlete with one is skipped from then on.
 *
 * Split for the operator runner (scripts/reeval-v11-blocks.mjs):
 *   planReeval      read-only: a few SELECTs, then decide()
 *   applyReeval     every write in ONE transaction (one Neon HTTP batch).
 *                   Each write re-checks, in SQL, that the block is still the
 *                   open latest row, the age inputs and pain reports haven't
 *                   moved since the plan, the flag is still on and no marker
 *                   exists; anything that moved is left as it is (kept).
 *   formatSummary   counts by region and totals only: never ratings, notes,
 *                   dates, athlete ids or any other health detail.
 * Queries go through an injectable Executor; neonHttpExecutor is the
 * production one (Neon's HTTP SQL endpoint, the only way to reach prod).
 */
import { mcpStamp } from '../../src/engine/mcpStamp.ts'
import { ageStatusFrom, type AgeStatus } from './ageStatus.ts'
import { pgArrayLiteral } from './db.ts'
import { METHODOLOGY_V1_2, type MethodologyParams } from './methodology/v1.ts'
import { addDays, daysBetween, evaluateReport, isPainRegion, isRedFlag, type PainEntry } from './readiness/rules.ts'
import { calendarZone } from './store.ts'

export const JOB = 'reeval_v11_blocks'
export const JOB_ACTOR = `job:${JOB}`
/** change_log type of one lifted block. */
export const LIFT_TOOL = 'apply_block_reeval'
/** change_log type of the per-athlete marker. */
export const RUN_TOOL = 'apply_block_reeval_run'
export const JOB_VERSION = METHODOLOGY_V1_2.version

// ---- executor -----------------------------------------------------------------------------

export type Row = Record<string, unknown>

export interface SqlQuery {
  query: string
  params: unknown[]
  /** What the statement writes, for counting results. Not sent. */
  kind?: 'lock' | 'lift' | 'status' | 'marker'
}

export interface Executor {
  /** One read. */
  query(query: string, params?: unknown[]): Promise<Row[]>
  /** Every statement in one transaction: all of it commits, or none of it. Rows per statement. */
  transaction(queries: SqlQuery[]): Promise<Row[][]>
}

/** Neon takes text params: null stays null, objects go as JSON. */
function httpParam(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/**
 * Neon's HTTP SQL endpoint: POST https://<host>/sql with the connection string
 * in a header. A batch is one transaction (ReadCommitted). Errors carry the
 * HTTP status and SQLSTATE only: never the connection string, the query, its
 * params or the server's message (which can quote row values).
 */
export function neonHttpExecutor(connectionString: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Executor {
  let host: string
  try {
    host = new URL(connectionString).hostname
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string.')
  }
  if (!host) throw new Error('DATABASE_URL has no host.')
  const endpoint = `https://${host}/sql`
  const post = async (body: unknown, batch: boolean): Promise<Row> => {
    const headers: Record<string, string> = {
      'Neon-Connection-String': connectionString,
      'Content-Type': 'application/json',
    }
    if (batch) headers['Neon-Batch-Isolation-Level'] = 'ReadCommitted'
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch {
      throw new Error('The SQL endpoint could not be reached.')
    }
    const out = await res.json().catch(() => ({})) as Row
    if (!res.ok) {
      const code = typeof out.code === 'string' && /^[0-9A-Z]{5}$/.test(out.code) ? ` (SQLSTATE ${out.code})` : ''
      throw new Error(`The SQL endpoint answered HTTP ${res.status}${code}.`)
    }
    return out
  }
  const rowsOf = (r: unknown): Row[] => (Array.isArray((r as Row | null)?.rows) ? (r as { rows: Row[] }).rows : [])
  return {
    async query(query, params = []) {
      return rowsOf(await post({ query, params: params.map(httpParam) }, false))
    },
    async transaction(queries) {
      if (!queries.length) return []
      const out = await post({ queries: queries.map((q) => ({ query: q.query, params: q.params.map(httpParam) })) }, true)
      const results = Array.isArray(out.results) ? out.results : []
      if (results.length !== queries.length) throw new Error('The SQL endpoint answered the batch with the wrong number of results.')
      return results.map(rowsOf)
    },
  }
}

// ---- inputs -------------------------------------------------------------------------------

export interface BlockRow {
  id: string
  athlete_id: string
  region: string
  reason: string | null
  pain_report_id: string | null
  created_at: string
  /** The methodology version of the change_log row that wrote it; null when none is on record. */
  methodology_version: string | null
  /** The change_log type that wrote it; null when none is on record. */
  change_tool: string | null
}

export interface AthleteInput {
  id: string
  birth_date: string | null
  adult_confirmed_at: string | null
  time_zone: string | null
  /** An apply_block_reeval_run row exists: this athlete was re-evaluated already. */
  ran: boolean
}

export interface PainInput {
  id: string
  athlete_id: string
  region: string
  date: string
  score: number
  red_flags: string[]
  created_at: string
  voided: boolean
}

export interface ReevalInputs {
  /** False before readiness.sql / change-log.sql: nothing to do. */
  ready: boolean
  /** The database's clock at the read; apply refuses pain reports newer than this. */
  as_of: string
  blocks: BlockRow[]
  athletes: AthleteInput[]
  pain: PainInput[]
  /** Each athlete's logged workout times (ISO), recent ones. */
  workouts: Array<{ athlete_id: string; performed_at: string }>
}

const s = (v: unknown): string | null => (v == null ? null : String(v))
const truthy = (v: unknown) => v === true || v === 't' || v === 'true'

/** Read-only: every input decide() needs, for every athlete with tracks_v1 on and an open block. */
export async function loadInputs(exec: Executor): Promise<ReevalInputs> {
  const [state] = await exec.query(`
    SELECT (to_regclass('public.region_status') IS NOT NULL AND to_regclass('public.pain_report') IS NOT NULL
            AND to_regclass('public.change_log') IS NOT NULL)::text AS ready,
           (to_regclass('public.change_tombstone') IS NOT NULL)::text AS tombstones,
           to_json(NOW()) #>> '{}' AS as_of
  `)
  const asOf = String(state?.as_of ?? new Date().toISOString())
  if (!truthy(state?.ready)) return { ready: false, as_of: asOf, blocks: [], athletes: [], pain: [], workouts: [] }
  const blocks = (await exec.query(`
    WITH latest AS (
      SELECT DISTINCT ON (s.athlete_id, s.region) s.*
      FROM region_status s
      JOIN athlete a ON a.id = s.athlete_id AND (a.flags -> 'tracks_v1') = 'true'::jsonb
      ORDER BY s.athlete_id, s.region, s.created_at DESC, s.id DESC
    )
    SELECT l.id::text AS id, l.athlete_id::text AS athlete_id, l.region, l.reason, l.pain_report_id::text AS pain_report_id,
           to_json(l.created_at) #>> '{}' AS created_at,
           to_jsonb(c) ->> 'methodology_version' AS methodology_version, c.tool AS change_tool
    FROM latest l
    LEFT JOIN change_log c ON c.id = l.change_id AND c.athlete_id = l.athlete_id
    WHERE l.status = 'blocked' AND l.cleared_at IS NULL
    ORDER BY l.athlete_id, l.region
  `)).map((r): BlockRow => ({
    id: String(r.id),
    athlete_id: String(r.athlete_id),
    region: String(r.region),
    reason: s(r.reason),
    pain_report_id: s(r.pain_report_id),
    created_at: String(r.created_at),
    methodology_version: s(r.methodology_version),
    change_tool: s(r.change_tool),
  }))
  const ids = [...new Set(blocks.map((b) => b.athlete_id))].sort()
  if (!ids.length) return { ready: true, as_of: asOf, blocks, athletes: [], pain: [], workouts: [] }
  const idParam = pgArrayLiteral(ids)
  const athletes = (await exec.query(`
    SELECT a.id::text AS id, to_jsonb(a) ->> 'birth_date' AS birth_date, to_jsonb(a) ->> 'adult_confirmed_at' AS adult_confirmed_at,
           a.time_zone,
           EXISTS (SELECT 1 FROM change_log m WHERE m.athlete_id = a.id AND m.tool = 'apply_block_reeval_run')::text AS ran
    FROM athlete a
    WHERE a.id::text = ANY($1::text[])
    ORDER BY a.id
  `, [idParam])).map((r): AthleteInput => ({
    id: String(r.id),
    birth_date: s(r.birth_date),
    adult_confirmed_at: s(r.adult_confirmed_at),
    time_zone: s(r.time_zone),
    ran: truthy(r.ran),
  }))
  // A voided report (the athlete undid its check-in) is read but never judged.
  const voided = truthy(state?.tombstones)
    ? `EXISTS (SELECT 1 FROM change_tombstone x WHERE x.athlete_id = p.athlete_id AND x.row_table = 'pain_report'
                AND x.row_id = p.id AND x.lifted_at IS NULL)`
    : 'false'
  const pain = (await exec.query(`
    SELECT p.id::text AS id, p.athlete_id::text AS athlete_id, p.region, p.date::text AS date, p.score::text AS score,
           array_to_string(p.red_flags, ',') AS red_flags, to_json(p.created_at) #>> '{}' AS created_at,
           (${voided})::text AS voided
    FROM pain_report p
    WHERE p.athlete_id::text = ANY($1::text[])
    ORDER BY p.athlete_id, p.region, p.date, p.created_at, p.id
  `, [idParam])).map((r): PainInput => ({
    id: String(r.id),
    athlete_id: String(r.athlete_id),
    region: String(r.region),
    date: String(r.date).slice(0, 10),
    score: Number(r.score),
    red_flags: String(r.red_flags ?? '').split(',').filter(Boolean),
    created_at: String(r.created_at),
    voided: truthy(r.voided),
  }))
  // The temporary window is at most 14 days; a little more covers time zones.
  const workouts = (await exec.query(`
    SELECT p.athlete_id::text AS athlete_id, to_json(w.performed_at) #>> '{}' AS performed_at
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id::text = ANY($1::text[]) AND w.performed_at >= NOW() - INTERVAL '20 days'
    ORDER BY p.athlete_id, w.performed_at
  `, [idParam])).map((r) => ({ athlete_id: String(r.athlete_id), performed_at: String(r.performed_at) }))
  return { ready: true, as_of: asOf, blocks, athletes, pain, workouts }
}

// ---- the decision (pure) ------------------------------------------------------------------

export type KeptWhy = 'minor_or_unknown_age' | 'persistent_under_v12' | 'not_reevaluable'
export type PersistentWhy = 'red_flag' | 'over_twice' | 'rising'

export type Decision =
  | { kind: 'kept'; block: BlockRow; why: KeptWhy; criterion?: PersistentWhy; age: AgeStatus }
  | {
      kind: 'lifted'
      block: BlockRow
      /** The v1.2 temporary window is still open (readiness derives it), or it has passed. */
      after: 'temporary' | 'unblocked'
      /** The report v1.2 judged as setting a temporary block, the latest such. */
      report: { id: string; date: string } | null
      call: string | null
      age: AgeStatus
      change_id: string
      status_id: string
      birth_date: string | null
      adult_confirmed_at: string | null
    }

export interface ReevalPlan {
  job: typeof JOB
  methodology_version: string
  ready: boolean
  as_of: string
  decisions: Decision[]
  /** Athletes with an open block from before v1.2 that already have a marker. */
  already_ran: number
  /** Athletes to mark (each gets one marker row on apply). */
  athletes: Array<{ id: string; marker_id: string; candidates: number }>
}

/** v1, v1.1 (with or without an override fingerprint) or nothing on record: written before v1.2. */
export function beforeV12(version: string | null): boolean {
  return version == null || version === '' || /^v1(\.1)?(\+|$)/.test(version)
}

function persistentWhy(report: PainEntry, reason: string): PersistentWhy {
  if (report.red_flags.length) return 'red_flag'
  return /twice within/.test(reason) ? 'over_twice' : 'rising'
}

/** Latest report per date for one region, oldest first, as rules.ts reads them (voided ones out). */
function regionReports(pain: PainInput[], athleteId: string, region: string): Array<PainEntry & { id: string }> {
  const byDate = new Map<string, PainInput>()
  for (const p of pain) {
    if (p.athlete_id !== athleteId || p.region !== region || p.voided || !isPainRegion(p.region)) continue
    const cur = byDate.get(p.date)
    if (!cur || p.created_at > cur.created_at || (p.created_at === cur.created_at && p.id > cur.id)) byDate.set(p.date, p)
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ id: p.id, date: p.date, region: p.region as PainEntry['region'], score: p.score, red_flags: p.red_flags.filter(isRedFlag) }))
}

export interface DecideOpts {
  now?: Date
  /** Ids for the rows apply writes (tests pin them). */
  newId?: () => string
}

/** Pure: what v1.2 makes of each stored block. No I/O. */
export function decide(inputs: ReevalInputs, opts: DecideOpts = {}): ReevalPlan {
  const now = opts.now ?? new Date()
  const newId = opts.newId ?? (() => crypto.randomUUID())
  const params: MethodologyParams['U7'] = METHODOLOGY_V1_2.params.U7
  const window = params.persistent_after!.within_days
  const athletes = new Map(inputs.athletes.map((a) => [a.id, a]))
  const decisions: Decision[] = []
  const marked: ReevalPlan['athletes'] = []
  const skipped = new Set<string>()
  for (const block of inputs.blocks) {
    // Only engine-made blocks from before v1.2. A re-block the athlete made (undoing a clear) stays theirs.
    if (!beforeV12(block.methodology_version)) continue
    if (block.change_tool != null && block.change_tool !== 'log_checkin') continue
    const athlete = athletes.get(block.athlete_id)
    if (!athlete) continue
    if (athlete.ran) {
      skipped.add(athlete.id)
      continue
    }
    const zone = calendarZone(athlete.time_zone)
    const today = mcpStamp(now, zone).local_date
    const age = ageStatusFrom({ birthDate: athlete.birth_date, adultConfirmed: athlete.adult_confirmed_at != null, today })
    let entry = marked.find((m) => m.id === athlete.id)
    if (!entry) {
      entry = { id: athlete.id, marker_id: newId(), candidates: 0 }
      marked.push(entry)
    }
    entry.candidates++
    // Under 18, or no age on file: v1.1 behaviour stands (section 11b). Never lifted.
    if (age !== 'adult') {
      decisions.push({ kind: 'kept', block, why: 'minor_or_unknown_age', age })
      continue
    }
    const trigger = inputs.pain.find((p) => p.id === block.pain_report_id && p.athlete_id === block.athlete_id && p.region === block.region)
    const reports = regionReports(inputs.pain, block.athlete_id, block.region)
    if (!trigger || trigger.voided || !isPainRegion(block.region) || !reports.length) {
      decisions.push({ kind: 'kept', block, why: 'not_reevaluable', age })
      continue
    }
    // The report that set it, and every report of the region since (the athlete
    // kept checking in while it was blocked), each judged as v1.2 would have.
    const since = reports.filter((r) => r.date >= trigger.date && r.date <= today)
    const calls = since.map((r) => ({ report: r, call: evaluateReport(reports, r, params, true) }))
    const keeps = calls.find((c) => c.call.status === 'blocked' && c.call.block !== 'temporary')
    if (keeps) {
      decisions.push({ kind: 'kept', block, why: 'persistent_under_v12', criterion: persistentWhy(keeps.report, keeps.call.reason), age })
      continue
    }
    const temporary = calls.filter((c) => c.call.status === 'blocked' && c.call.block === 'temporary').pop() ?? null
    const sessions = inputs.workouts
      .filter((w) => w.athlete_id === block.athlete_id)
      .map((w) => mcpStamp(new Date(w.performed_at), zone).local_date)
    // As readiness.ts reads it: that day, then until a session is logged on a later day, within 14 days.
    const open = temporary != null && daysBetween(temporary.report.date, today) <= window
      && (temporary.report.date === today || !sessions.some((d) => d > temporary.report.date && d <= addDays(today, -1)))
    decisions.push({
      kind: 'lifted',
      block,
      after: open ? 'temporary' : 'unblocked',
      report: temporary ? { id: temporary.report.id, date: temporary.report.date } : null,
      call: temporary?.call.reason ?? null,
      age,
      change_id: newId(),
      status_id: newId(),
      birth_date: athlete.birth_date,
      adult_confirmed_at: athlete.adult_confirmed_at,
    })
  }
  return {
    job: JOB,
    methodology_version: JOB_VERSION,
    ready: inputs.ready,
    as_of: inputs.as_of,
    decisions,
    already_ran: skipped.size,
    athletes: marked,
  }
}

/** Read-only: the inputs, then the decision. Writes nothing. */
export async function planReeval(exec: Executor, opts: DecideOpts = {}): Promise<ReevalPlan> {
  return decide(await loadInputs(exec), opts)
}

// ---- apply (one transaction) --------------------------------------------------------------

const RATIONALE = 'Re-checked once under methodology v1.2 (section 11b): this block meets none of v1.2\'s persistence criteria '
  + '(a red flag, over 5/10 twice within 14 days, a rating rising across 3 sessions), so it no longer needs a clinician clear. '
  + 'It drops to a temporary block: that day and the next session (U7).'
const RUN_RATIONALE = 'One-time re-check of the pain blocks stored under methodology v1.1, under v1.2 (section 11b). '
  + 'Blocks v1.2 keeps persistent stay until a clinician clears them; under 18 or with no age on file every block stays (U7).'

const regionWord = (r: string) => r.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** The batch applyReeval sends: lock, then per athlete each lift (log row, then status row), then the marker. */
export function applyStatements(plan: ReevalPlan): SqlQuery[] {
  if (!plan.ready || !plan.athletes.length) return []
  const out: SqlQuery[] = [{ kind: 'lock', query: `SELECT pg_advisory_xact_lock(hashtext('reeval_v11_blocks'))::text AS locked`, params: [] }]
  for (const a of plan.athletes) {
    const lifts = plan.decisions.filter((d): d is Extract<Decision, { kind: 'lifted' }> => d.kind === 'lifted' && d.block.athlete_id === a.id)
    for (const d of lifts) {
      const b = d.block
      const diff = {
        job: JOB,
        methodology_version: JOB_VERSION,
        region: b.region,
        status_id: b.id,
        new_status_id: d.status_id,
        pain_report_id: b.pain_report_id,
        before: { status: 'blocked', block: 'persistent', reason: b.reason, since: b.created_at, methodology_version: b.methodology_version },
        after: d.after === 'temporary'
          ? { status: 'ok', block: 'temporary', lapses: 'after the next session', since: d.report?.date ?? null, reason: d.call }
          : { status: 'ok', block: null },
      }
      // Guarded: still the open latest row, flag on, age inputs and pain reports as planned, no marker yet.
      out.push({
        kind: 'lift',
        query: `
          INSERT INTO change_log (id, athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
                                  approval_ref, preview_id, methodology_version)
          SELECT $1::uuid, $2::uuid, 'system', $3::text, 'apply_block_reeval', 'region', $4::text, $5::jsonb, $6::text, '["U7"]'::jsonb,
                 NULL, NULL, $7::text
          FROM athlete a
          WHERE a.id = $2::uuid AND (a.flags -> 'tracks_v1') = 'true'::jsonb
            AND (to_jsonb(a) ->> 'birth_date') IS NOT DISTINCT FROM $8::text
            AND (to_jsonb(a) ->> 'adult_confirmed_at') IS NOT DISTINCT FROM $9::text
            AND NOT EXISTS (SELECT 1 FROM change_log m WHERE m.athlete_id = $2::uuid AND m.tool = 'apply_block_reeval_run')
            AND NOT EXISTS (SELECT 1 FROM pain_report p WHERE p.athlete_id = $2::uuid AND p.region = $4::text AND p.created_at > $10::timestamptz)
            AND EXISTS (
              SELECT 1 FROM (
                SELECT s.id, s.status, s.cleared_at FROM region_status s
                WHERE s.athlete_id = $2::uuid AND s.region = $4::text
                ORDER BY s.created_at DESC, s.id DESC LIMIT 1
              ) cur
              WHERE cur.id = $11::uuid AND cur.status = 'blocked' AND cur.cleared_at IS NULL
            )
          RETURNING id::text AS id
        `,
        params: [d.change_id, a.id, JOB_ACTOR, b.region, JSON.stringify(diff), RATIONALE, JOB_VERSION, d.birth_date, d.adult_confirmed_at, plan.as_of, b.id],
      })
      out.push({
        kind: 'status',
        query: `
          INSERT INTO region_status (id, athlete_id, region, status, reason, rule_refs, pain_report_id, change_id)
          SELECT $1::uuid, $2::uuid, $3::text, 'ok', $4::text, '["U7"]'::jsonb, $5::uuid, $6::uuid
          WHERE EXISTS (SELECT 1 FROM change_log c WHERE c.id = $6::uuid AND c.athlete_id = $2::uuid)
          RETURNING id::text AS id
        `,
        params: [
          d.status_id, a.id, b.region,
          `${regionWord(b.region)}: re-checked under methodology v1.2, no clinician clear needed (U7).`,
          b.pain_report_id, d.change_id,
        ],
      })
    }
    // The marker, with what actually landed (a lift whose guard missed is counted as kept).
    out.push({
      kind: 'marker',
      query: `
        INSERT INTO change_log (id, athlete_id, actor_type, actor_id, tool, target_type, target_id, diff, rationale, rule_refs,
                                approval_ref, preview_id, methodology_version)
        SELECT $1::uuid, $2::uuid, 'system', $3::text, 'apply_block_reeval_run', 'region', NULL,
               jsonb_build_object('job', $4::text, 'methodology_version', $5::text,
                                  'lifted', l.n, 'kept', $6::int - l.n, 'lifted_changes', l.ids),
               $7::text, '["U7"]'::jsonb, NULL, NULL, $5::text
        FROM (
          SELECT count(*)::int AS n, COALESCE(jsonb_agg(c.id::text ORDER BY c.id), '[]'::jsonb) AS ids
          FROM change_log c WHERE c.athlete_id = $2::uuid AND c.id::text = ANY($8::text[])
        ) l
        WHERE EXISTS (SELECT 1 FROM athlete a WHERE a.id = $2::uuid AND (a.flags -> 'tracks_v1') = 'true'::jsonb)
          AND NOT EXISTS (SELECT 1 FROM change_log m WHERE m.athlete_id = $2::uuid AND m.tool = 'apply_block_reeval_run')
        RETURNING id::text AS id
      `,
      params: [a.marker_id, a.id, JOB_ACTOR, JOB, JOB_VERSION, a.candidates, RUN_RATIONALE, pgArrayLiteral(lifts.map((d) => d.change_id))],
    })
  }
  return out
}

export interface ApplyResult {
  /** Blocks lifted (change_log rows written). */
  lifted: number
  /** Athletes marked as re-evaluated. */
  athletes: number
}

/** Every write of the plan in one transaction. Nothing to write: no transaction at all. */
export async function applyReeval(exec: Executor, plan: ReevalPlan): Promise<ApplyResult> {
  const statements = applyStatements(plan)
  if (!statements.length) return { lifted: 0, athletes: 0 }
  const results = await exec.transaction(statements)
  const landed = (kind: SqlQuery['kind']) => statements.reduce((n, q, i) => n + (q.kind === kind ? results[i]?.length ?? 0 : 0), 0)
  return { lifted: landed('lift'), athletes: landed('marker') }
}

// ---- output (aggregate only) --------------------------------------------------------------

export interface ReevalSummary {
  regions: Array<{ region: string; kept: number; lifted: number }>
  kept: number
  lifted: number
  lifted_temporary: number
  lifted_unblocked: number
  kept_minor_or_unknown_age: number
  kept_persistent: number
  kept_not_reevaluable: number
  athletes_already_ran: number
}

export function summarize(plan: ReevalPlan): ReevalSummary {
  const regions = new Map<string, { kept: number; lifted: number }>()
  for (const d of plan.decisions) {
    // Only names from the fixed region list ever reach the output.
    const region = isPainRegion(d.block.region) ? d.block.region : 'other'
    const r = regions.get(region) ?? { kept: 0, lifted: 0 }
    if (d.kind === 'kept') r.kept++
    else r.lifted++
    regions.set(region, r)
  }
  const kept = plan.decisions.filter((d) => d.kind === 'kept')
  const lifted = plan.decisions.filter((d) => d.kind === 'lifted')
  return {
    regions: [...regions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([region, c]) => ({ region, ...c })),
    kept: kept.length,
    lifted: lifted.length,
    lifted_temporary: lifted.filter((d) => d.kind === 'lifted' && d.after === 'temporary').length,
    lifted_unblocked: lifted.filter((d) => d.kind === 'lifted' && d.after === 'unblocked').length,
    kept_minor_or_unknown_age: kept.filter((d) => d.kind === 'kept' && d.why === 'minor_or_unknown_age').length,
    kept_persistent: kept.filter((d) => d.kind === 'kept' && d.why === 'persistent_under_v12').length,
    kept_not_reevaluable: kept.filter((d) => d.kind === 'kept' && d.why === 'not_reevaluable').length,
    athletes_already_ran: plan.already_ran,
  }
}

/** What the runner prints: counts by region and totals. Nothing else from the plan. */
export function formatSummary(plan: ReevalPlan, mode: 'dry-run' | 'apply', applied?: ApplyResult): string {
  const s = summarize(plan)
  const lines = [`${JOB} (methodology ${JOB_VERSION}) — ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written; pass --apply to write)'}`]
  if (!plan.ready) {
    lines.push('readiness / change log tables are not on this database: nothing to do.')
    return lines.join('\n')
  }
  for (const r of s.regions) lines.push(`${r.region}: kept ${r.kept}, lifted ${r.lifted}`)
  if (!s.regions.length) lines.push('no blocks from before v1.2 to re-check.')
  lines.push(`total: kept ${s.kept}, lifted ${s.lifted} (temporary ${s.lifted_temporary}, unblocked ${s.lifted_unblocked})`)
  lines.push(`kept because: under 18 or no age on file ${s.kept_minor_or_unknown_age}, persistent under v1.2 ${s.kept_persistent}, not re-checkable ${s.kept_not_reevaluable}`)
  lines.push(`athletes already re-checked (skipped): ${s.athletes_already_ran}`)
  if (applied) lines.push(`written: ${applied.lifted} lifted, ${applied.athletes} athletes marked (one transaction)`)
  return lines.join('\n')
}
