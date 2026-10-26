/**
 * One owned data-plane for the SPA.
 * Client PostgREST calls become a single POST /api/data. The Worker resolves
 * the Better Auth session → athlete, injects the same ownership predicates
 * the store/edits paths use, and runs one parameterized SQL. Keep this file
 * small: Free-plan CPU is 10ms/request.
 */
import { sessionUser } from './auth.ts'
import { beginAuthCors, json } from './cors.ts'
import { getSql, type Sql } from './db.ts'
import type { Env } from './env.ts'

export type FilterOp = 'eq' | 'neq' | 'in' | 'gte' | 'gt' | 'lte' | 'lt' | 'ilike' | 'not_in'

export interface DataFilter {
  column: string
  op: FilterOp
  value: unknown
}

export interface DataQuery {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc'
  columns?: string
  filters?: DataFilter[]
  order?: { column: string; ascending?: boolean }
  limit?: number
  single?: 'maybe' | 'one'
  head?: boolean
  count?: 'exact'
  values?: Record<string, unknown> | Record<string, unknown>[]
  onConflict?: string
  returning?: boolean | string
  fn?: string
}

export interface DataResult {
  data: unknown
  error: { message: string; code?: string } | null
  count: number | null
  status: number
}

export interface DataContext {
  userId: string
  athleteId: string | null
}

const IDENT = /^[a-z_][a-z0-9_]*$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ATHLETE_COL = new Set([
  'athlete_profile',
  'diagnostic',
  'insight',
  'insight_draft',
  'program',
  'coach_message',
  'mcp_token',
  'workout_draft',
])

const VIA_PROGRAM = new Set([
  'phase',
  'routine',
  'weekly_review',
  'program_revision',
])

const TABLES = new Set([
  'athlete',
  ...ATHLETE_COL,
  ...VIA_PROGRAM,
  'workout',
  'session_observation',
])

const COLUMNS: Record<string, Set<string>> = {
  athlete: new Set([
    'id', 'auth_user_id', 'name', 'sport', 'goals', 'obstacle', 'training_age',
    'sessions_per_week', 'training_preferences', 'arena_type', 'arena_raw',
    'limiter_choice', 'onboarding_step', 'created_at',
  ]),
  athlete_profile: new Set(['id', 'athlete_id', 'last_updated', 'current_phase', 'retest_date']),
  diagnostic: new Set([
    'id', 'athlete_id', 'assessed_at', 'test_battery', 'raw_results',
    'delta_from_prior', 'version',
  ]),
  insight: new Set([
    'id', 'athlete_id', 'source_id', 'claim', 'category', 'priority', 'confidence',
    'status', 'evidence', 'source', 'program_impact', 'generated_at', 'resolved_at',
  ]),
  insight_draft: new Set([
    'id', 'athlete_id', 'source_id', 'claim', 'category', 'priority', 'confidence',
    'status', 'evidence', 'source', 'program_impact', 'generated_at', 'resolved_at',
    'reviewed',
  ]),
  program: new Set(['id', 'athlete_id', 'goal', 'start_date', 'retest_date', 'status']),
  phase: new Set([
    'id', 'program_id', 'name', 'week_start', 'week_end', 'non_negotiables',
    'advancement_criteria', 'status',
  ]),
  routine: new Set([
    'id', 'program_id', 'phase_id', 'name', 'session_type', 'exercises', 'intent',
    'intended_dow',
  ]),
  workout: new Set([
    'id', 'routine_id', 'performed_at', 'actual_weights', 'actual_reps', 'rpe',
    'duration_mins', 'exercises_snapshot',
  ]),
  session_observation: new Set([
    'id', 'workout_id', 'category', 'signal', 'severity', 'logged_at',
  ]),
  weekly_review: new Set([
    'id', 'program_id', 'week_ending', 'coach_notes', 'adjustments',
    'next_week_prescription',
  ]),
  program_revision: new Set([
    'id', 'program_id', 'phase_id', 'created_at', 'trigger', 'effective_on',
    'requests', 'snapshot', 'diff', 'summary',
  ]),
  coach_message: new Set([
    'id', 'athlete_id', 'role', 'kind', 'body', 'ref_id', 'created_at',
  ]),
  mcp_token: new Set([
    'id', 'athlete_id', 'name', 'token_hash', 'last_four', 'created_at',
    'last_used_at', 'revoked_at',
  ]),
  workout_draft: new Set([
    'id', 'athlete_id', 'routine_id', 'set_logs', 'feedback', 'elapsed_seconds',
    'started_at', 'updated_at',
  ]),
}

const JSONB = new Set([
  'diagnostic.test_battery', 'diagnostic.raw_results', 'diagnostic.delta_from_prior',
  'insight.evidence', 'insight_draft.evidence',
  'phase.non_negotiables', 'phase.advancement_criteria',
  'routine.exercises',
  'workout.actual_weights', 'workout.actual_reps', 'workout.exercises_snapshot',
  'weekly_review.adjustments', 'weekly_review.next_week_prescription',
  'program_revision.requests', 'program_revision.snapshot', 'program_revision.diff',
  'workout_draft.set_logs', 'workout_draft.feedback',
])

/** child.rel → parent table + fk on the child */
const REL: Record<string, Record<string, { table: string; from: string }>> = {
  workout: { routine: { table: 'routine', from: 'routine_id' } },
  session_observation: { workout: { table: 'workout', from: 'workout_id' } },
  routine: {
    program: { table: 'program', from: 'program_id' },
    phase: { table: 'phase', from: 'phase_id' },
  },
  phase: { program: { table: 'program', from: 'program_id' } },
  program: { athlete: { table: 'athlete', from: 'athlete_id' } },
  weekly_review: { program: { table: 'program', from: 'program_id' } },
}

const FK_TO_TABLE: Record<string, string> = {
  program_id: 'program',
  routine_id: 'routine',
  workout_id: 'workout',
  phase_id: 'phase',
  athlete_id: 'athlete',
}

export type SelectItem =
  | { kind: 'star' }
  | { kind: 'col'; name: string }
  | { kind: 'embed'; alias: string; rel: string; fkHint: boolean; inner: boolean; items: SelectItem[] }

export function parseSelectList(raw: string | undefined): SelectItem[] {
  const text = (raw ?? '*').trim() || '*'
  return splitTop(text).map(parseItem)
}

function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parseItem(raw: string): SelectItem {
  const text = raw.trim()
  if (text === '*') return { kind: 'star' }
  const embed = /^(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)(?:!(?:inner|left))?\((.*)\)$/.exec(text)
  if (embed) {
    return {
      kind: 'embed',
      alias: embed[1] || embed[2],
      rel: embed[2],
      fkHint: Boolean(embed[1]),
      inner: text.includes('!inner'),
      items: parseSelectList(embed[3]),
    }
  }
  if (IDENT.test(text)) return { kind: 'col', name: text }
  throw new Error(`unsupported select item: ${text}`)
}

/**
 * Ownership predicates. The mutation script deletes each owner interpolation
 * in the returned strings and expects access.check to fail.
 */
export function ownerPredicate(table: string): string {
  switch (table) {
    case 'athlete':
      return 'id = ${athleteId}'
    case 'athlete_profile':
    case 'diagnostic':
    case 'insight':
    case 'insight_draft':
    case 'program':
    case 'coach_message':
    case 'mcp_token':
    case 'workout_draft':
      return 'athlete_id = ${athleteId}'
    case 'phase':
    case 'routine':
    case 'weekly_review':
    case 'program_revision':
      return 'program_id IN (SELECT id FROM program WHERE athlete_id = ${athleteId})'
    case 'workout':
      return 'routine_id IN (SELECT r.id FROM routine r JOIN program p ON p.id = r.program_id WHERE p.athlete_id = ${athleteId})'
    case 'session_observation':
      return 'workout_id IN (SELECT w.id FROM workout w JOIN routine r ON r.id = w.routine_id JOIN program p ON p.id = r.program_id WHERE p.athlete_id = ${athleteId})'
    default:
      throw new Error(`unknown table: ${table}`)
  }
}

export function bindOwner(table: string, athleteId: string, start = 1): { text: string; params: unknown[] } {
  const raw = ownerPredicate(table)
  const text = raw.replace(/\$\{athleteId\}/g, `$${start}`)
  return { text, params: [athleteId] }
}

export async function runSql<T extends object>(sql: Sql, text: string, params: unknown[]): Promise<T[]> {
  const unsafe = (sql as unknown as { unsafe: (q: string, p?: unknown[]) => Promise<T[]> }).unsafe
  if (typeof unsafe !== 'function') throw new Error('sql.unsafe is required')
  return unsafe.call(sql, text, params)
}

export async function resolveAthleteId(sql: Sql, userId: string): Promise<string | null> {
  const rows = await runSql<{ id: string }>(sql, 'SELECT id FROM athlete WHERE auth_user_id = $1 LIMIT 1', [userId])
  return rows[0]?.id ?? null
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`bad identifier: ${name}`)
  return name
}

function tableOk(name: string): string {
  const t = ident(name)
  if (!TABLES.has(t)) throw new Error(`unknown table: ${t}`)
  return t
}

function colOk(table: string, name: string): string {
  const col = ident(name)
  const allowed = COLUMNS[table]
  if (allowed && !allowed.has(col)) throw new Error(`unknown column ${table}.${col}`)
  return col
}

function qualifyCol(table: string, column: string, joins: Map<string, string>): string {
  if (column.includes('.')) {
    const parts = column.split('.')
    const field = ident(parts[parts.length - 1])
    const alias = ident(parts[parts.length - 2])
    if (!joins.has(alias) && alias !== table) {
      throw new Error(`unknown filter path: ${column}`)
    }
    return `${alias}.${field}`
  }
  return `${table}.${colOk(table, column)}`
}

function addJoin(joins: Map<string, string>, fromAlias: string, relName: string, fkHint: boolean): string {
  if (fkHint) {
    const parent = FK_TO_TABLE[relName]
    if (!parent) throw new Error(`unknown fk ${relName}`)
    const alias = parent
    if (!joins.has(alias)) {
      joins.set(alias, `JOIN ${parent} ON ${parent}.id = ${fromAlias}.${ident(relName)}`)
    }
    return alias
  }
  const spec = REL[fromAlias]?.[relName]
  if (!spec) throw new Error(`unknown relation ${fromAlias}.${relName}`)
  if (!joins.has(spec.table)) {
    joins.set(spec.table, `JOIN ${spec.table} ON ${spec.table}.id = ${fromAlias}.${spec.from}`)
  }
  return spec.table
}

function walkEmbeds(table: string, items: SelectItem[], joins: Map<string, string>): void {
  for (const item of items) {
    if (item.kind !== 'embed') continue
    const next = addJoin(joins, table, item.rel, item.fkHint)
    walkEmbeds(next, item.items, joins)
  }
}

function walkFilterPath(table: string, path: string, joins: Map<string, string>): void {
  if (!path.includes('.')) return
  const parts = path.split('.')
  let current = table
  for (let i = 0; i < parts.length - 1; i++) {
    const rel = ident(parts[i])
    if (rel === table && i === 0) continue
    if (REL[current]?.[rel]) current = addJoin(joins, current, rel, false)
    else if (FK_TO_TABLE[rel]) current = addJoin(joins, current, rel, true)
    else if (joins.has(rel) || rel === current) current = rel
    else throw new Error(`unknown filter path: ${path}`)
  }
}

function embedJson(alias: string, items: SelectItem[]): string {
  const fields: string[] = []
  for (const item of items) {
    if (item.kind === 'star') {
      throw new Error('embedded * is not supported')
    }
    if (item.kind === 'col') {
      fields.push(`'${item.name}', ${alias}.${ident(item.name)}`)
    } else {
      const childAlias = item.fkHint ? (FK_TO_TABLE[item.rel] ?? item.alias) : (REL[alias]?.[item.rel]?.table ?? item.alias)
      fields.push(`'${item.alias}', ${embedJson(childAlias, item.items)}`)
    }
  }
  return `json_build_object(${fields.join(', ')})`
}

function selectSql(table: string, items: SelectItem[], joins: Map<string, string>): string {
  const hasJoin = joins.size > 0
  const hasStar = items.some((i) => i.kind === 'star')
  const cols: string[] = []
  if (hasStar) {
    cols.push(`${table}.*`)
  }
  for (const item of items) {
    if (item.kind === 'star') continue
    if (item.kind === 'col') {
      cols.push(`${table}.${colOk(table, item.name)}`)
    } else {
      const child = item.fkHint
        ? (FK_TO_TABLE[item.rel] ?? item.alias)
        : (REL[table]?.[item.rel]?.table ?? item.alias)
      cols.push(`${embedJson(child, item.items)} AS ${ident(item.alias)}`)
    }
  }
  if (cols.length === 0) {
    return hasJoin ? `${table}.*` : '*'
  }
  return cols.join(', ')
}

function bindValue(table: string, col: string, value: unknown, idx: number): { expr: string; param: unknown } {
  if (value !== null && (JSONB.has(`${table}.${col}`) || typeof value === 'object')) {
    return { expr: `$${idx}::jsonb`, param: JSON.stringify(value) }
  }
  return { expr: `$${idx}`, param: value }
}

function bindFilter(
  table: string,
  filter: DataFilter,
  joins: Map<string, string>,
  start: number,
): { text: string; params: unknown[] } {
  const col = qualifyCol(table, filter.column, joins)
  const op = filter.op
  if (op === 'in' || op === 'not_in') {
    const list = Array.isArray(filter.value) ? filter.value : parseInTuple(filter.value)
    const idx = start
    const cast = list.length && list.every((v) => typeof v === 'string' && UUID_RE.test(v))
      ? '::uuid[]'
      : '::text[]'
    return {
      text: `${col} ${op === 'not_in' ? 'NOT IN' : 'IN'} (SELECT unnest($${idx}${cast}))`,
      params: [list],
    }
  }
  const idx = start
  const map: Record<Exclude<FilterOp, 'in' | 'not_in'>, string> = {
    eq: '=',
    neq: '<>',
    gte: '>=',
    gt: '>',
    lte: '<=',
    lt: '<',
    ilike: 'ILIKE',
  }
  return { text: `${col} ${map[op]} $${idx}`, params: [filter.value] }
}

function parseInTuple(value: unknown): unknown[] {
  if (typeof value !== 'string') return value == null ? [] : [value]
  const inner = value.replace(/^\(/, '').replace(/\)$/, '')
  if (!inner) return []
  return inner.split(',').map((s) => s.trim())
}

function whereClause(
  table: string,
  athleteId: string | null,
  userId: string,
  filters: DataFilter[],
  joins: Map<string, string>,
  start: number,
): { text: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  let n = start
  if (athleteId) {
    const owner = bindOwner(table, athleteId, n)
    parts.push(owner.text)
    params.push(...owner.params)
    n += owner.params.length
  } else if (table === 'athlete') {
    parts.push(`auth_user_id = $${n}`)
    params.push(userId)
    n++
  }
  for (const filter of filters) {
    walkFilterPath(table, filter.column, joins)
    const bound = bindFilter(table, filter, joins, n)
    parts.push(bound.text)
    params.push(...bound.params)
    n += bound.params.length
  }
  return { text: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

function fromSql(table: string, joins: Map<string, string>): string {
  if (joins.size === 0) return table
  return `${table} ${[...joins.values()].join(' ')}`
}

function returningSql(table: string, returning: boolean | string | undefined): string {
  if (returning === false || returning == null) return ''
  if (returning === true || returning === '*') return 'RETURNING *'
  const cols = String(returning).split(',').map((c) => c.trim()).filter(Boolean)
  if (cols.length === 0) return 'RETURNING *'
  return `RETURNING ${cols.map((c) => colOk(table, c)).join(', ')}`
}

function shapeResult(
  rows: object[],
  query: DataQuery,
  count: number | null,
): DataResult {
  if (query.head) return { data: null, error: null, count, status: 200 }
  if (query.single === 'one') {
    if (rows.length === 0) {
      return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count, status: 406 }
    }
    if (rows.length > 1) {
      return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count, status: 406 }
    }
    return { data: rows[0], error: null, count, status: 200 }
  }
  if (query.single === 'maybe') {
    if (rows.length > 1) {
      return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count, status: 406 }
    }
    return { data: rows[0] ?? null, error: null, count, status: 200 }
  }
  return { data: rows, error: null, count, status: 200 }
}

function fail(message: string, status = 400, code?: string): DataResult {
  return { data: null, error: { message, code }, count: null, status }
}

function rowsOf(values: DataQuery['values']): Record<string, unknown>[] {
  if (!values) return []
  return Array.isArray(values) ? values : [values]
}

async function assertWritableRow(
  sql: Sql,
  table: string,
  row: Record<string, unknown>,
  ctx: DataContext,
): Promise<DataResult | null> {
  if (!ctx.athleteId) {
    if (table === 'athlete') return null
    return fail('not signed in as an athlete', 401)
  }
  const athleteId = ctx.athleteId
  if (ATHLETE_COL.has(table)) {
    row.athlete_id = athleteId
    if (table === 'workout_draft' && typeof row.routine_id === 'string') {
      const owner = bindOwner('routine', athleteId, 1)
      const ok = await runSql<{ id: string }>(
        sql,
        `SELECT id FROM routine WHERE ${owner.text} AND id = $2 LIMIT 1`,
        [...owner.params, row.routine_id],
      )
      if (!ok[0]) return fail('not found', 404)
    }
    return null
  }
  if (table === 'athlete') {
    row.auth_user_id = ctx.userId
    return null
  }
  if (VIA_PROGRAM.has(table)) {
    const programId = row.program_id
    if (typeof programId !== 'string') return fail('program_id required', 400)
    const owner = bindOwner('program', athleteId, 1)
    const ok = await runSql<{ id: string }>(
      sql,
      `SELECT id FROM program WHERE ${owner.text} AND id = $2 LIMIT 1`,
      [...owner.params, programId],
    )
    if (!ok[0]) return fail('not found', 404)
    return null
  }
  if (table === 'workout') {
    const routineId = row.routine_id
    if (typeof routineId !== 'string') return fail('routine_id required', 400)
    const owner = bindOwner('routine', athleteId, 1)
    const ok = await runSql<{ id: string }>(
      sql,
      `SELECT id FROM routine WHERE ${owner.text} AND id = $2 LIMIT 1`,
      [...owner.params, routineId],
    )
    if (!ok[0]) return fail('not found', 404)
    return null
  }
  if (table === 'session_observation') {
    const workoutId = row.workout_id
    if (typeof workoutId !== 'string') return fail('workout_id required', 400)
    const owner = bindOwner('workout', athleteId, 1)
    const ok = await runSql<{ id: string }>(
      sql,
      `SELECT id FROM workout WHERE ${owner.text} AND id = $2 LIMIT 1`,
      [...owner.params, workoutId],
    )
    if (!ok[0]) return fail('not found', 404)
    return null
  }
  return fail('unknown table', 400)
}

async function resetOrientation(sql: Sql, athleteId: string): Promise<DataResult> {
  await runSql(sql, `DELETE FROM session_observation WHERE ${bindOwner('session_observation', athleteId).text}`, [athleteId])
  await runSql(sql, `DELETE FROM workout WHERE ${bindOwner('workout', athleteId).text}`, [athleteId])
  await runSql(sql, `DELETE FROM program WHERE ${bindOwner('program', athleteId).text}`, [athleteId])
  await runSql(sql, `DELETE FROM insight WHERE ${bindOwner('insight', athleteId).text}`, [athleteId])
  await runSql(sql, `DELETE FROM insight_draft WHERE ${bindOwner('insight_draft', athleteId).text}`, [athleteId])
  await runSql(sql, `DELETE FROM diagnostic WHERE ${bindOwner('diagnostic', athleteId).text}`, [athleteId])
  await runSql(sql, `DELETE FROM athlete_profile WHERE ${bindOwner('athlete_profile', athleteId).text}`, [athleteId])
  await runSql(
    sql,
    `UPDATE athlete SET onboarding_step = 'hook', obstacle = NULL, arena_type = NULL, arena_raw = NULL, limiter_choice = NULL WHERE ${bindOwner('athlete', athleteId).text}`,
    [athleteId],
  )
  return { data: null, error: null, count: null, status: 200 }
}

export async function executeDataQuery(sql: Sql, ctx: DataContext, query: DataQuery): Promise<DataResult> {
  try {
    if (query.op === 'rpc') {
      if (query.fn !== 'reset_athlete_orientation') return fail(`unknown rpc: ${query.fn ?? ''}`, 400)
      if (!ctx.athleteId) return fail('No athlete for the current user', 400)
      return await resetOrientation(sql, ctx.athleteId)
    }

    const table = tableOk(query.table)
    if (!ctx.athleteId && !(table === 'athlete' && (query.op === 'select' || query.op === 'insert'))) {
      return fail('not signed in as an athlete', 401)
    }

    if (query.op === 'select') {
      const items = parseSelectList(query.columns)
      const joins = new Map<string, string>()
      walkEmbeds(table, items, joins)
      for (const filter of query.filters ?? []) walkFilterPath(table, filter.column, joins)
      const where = whereClause(table, ctx.athleteId, ctx.userId, query.filters ?? [], joins, 1)
      const from = fromSql(table, joins)
      let count: number | null = null
      if (query.count === 'exact') {
        const counted = await runSql<{ n: number }>(
          sql,
          `SELECT COUNT(*)::int AS n FROM ${from} ${where.text}`,
          where.params,
        )
        count = Number(counted[0]?.n ?? 0)
        if (query.head) return shapeResult([], query, count)
      }
      const select = selectSql(table, items, joins)
      let text = `SELECT ${select} FROM ${from} ${where.text}`
      const params = [...where.params]
      if (query.order) {
        const col = query.order.column.includes('.')
          ? qualifyCol(table, query.order.column, joins)
          : `${table}.${colOk(table, query.order.column)}`
        text += ` ORDER BY ${col} ${query.order.ascending === false ? 'DESC' : 'ASC'}`
      }
      if (query.limit != null) {
        const lim = Math.max(0, Math.min(Number(query.limit) || 0, 500))
        text += ` LIMIT ${lim}`
      }
      const rows = await runSql<object>(sql, text, params)
      return shapeResult(rows, query, count)
    }

    if (query.op === 'insert' || query.op === 'upsert') {
      const rawRows = rowsOf(query.values)
      if (rawRows.length === 0) return fail('insert requires values', 400)
      const prepared: Record<string, unknown>[] = []
      for (const raw of rawRows) {
        const row = { ...raw }
        const blocked = await assertWritableRow(sql, table, row, ctx)
        if (blocked) return blocked
        if (table === 'athlete') delete row.id
        if (table !== 'athlete') delete row.auth_user_id
        prepared.push(row)
      }
      const cols = [...new Set(prepared.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))]
      if (cols.length === 0) return fail('insert requires columns', 400)
      cols.forEach((c) => colOk(table, c))
      const params: unknown[] = []
      const valueSql = prepared.map((row) => {
        const bits = cols.map((col) => {
          const bound = bindValue(table, col, row[col] ?? null, params.length + 1)
          params.push(bound.param)
          return bound.expr
        })
        return `(${bits.join(', ')})`
      })
      let text = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valueSql.join(', ')}`
      if (query.op === 'upsert') {
        const conflict = (query.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean)
        if (conflict.length === 0) return fail('upsert requires onConflict', 400)
        const conflictCols = conflict.map((c) => colOk(table, c))
        const updates = cols.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = EXCLUDED.${c}`)
        text += ` ON CONFLICT (${conflictCols.join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`
      }
      text += ` ${returningSql(table, query.returning)}`
      const rows = await runSql<object>(sql, text, params)
      if (!query.returning) return { data: null, error: null, count: rows.length, status: 201 }
      return shapeResult(rows, query, rows.length)
    }

    if (query.op === 'update') {
      if (!ctx.athleteId) return fail('not signed in as an athlete', 401)
      const raw = rowsOf(query.values)[0]
      if (!raw) return fail('update requires values', 400)
      const row = { ...raw }
      delete row.id
      delete row.auth_user_id
      if (ATHLETE_COL.has(table)) row.athlete_id = ctx.athleteId
      if (table === 'athlete') delete row.athlete_id
      if (table === 'workout' && row.routine_id) {
        const blocked = await assertWritableRow(sql, table, { routine_id: row.routine_id }, ctx)
        if (blocked) return blocked
      }
      if (VIA_PROGRAM.has(table) && row.program_id) {
        const blocked = await assertWritableRow(sql, table, { program_id: row.program_id }, ctx)
        if (blocked) return blocked
      }
      const cols = Object.keys(row).filter((k) => row[k] !== undefined)
      if (cols.length === 0) return fail('update requires columns', 400)
      const params: unknown[] = []
      const sets = cols.map((col) => {
        colOk(table, col)
        const bound = bindValue(table, col, row[col] ?? null, params.length + 1)
        params.push(bound.param)
        return `${col} = ${bound.expr}`
      })
      const joins = new Map<string, string>()
      for (const filter of query.filters ?? []) walkFilterPath(table, filter.column, joins)
      const where = whereClause(table, ctx.athleteId, ctx.userId, query.filters ?? [], joins, params.length + 1)
      const text = `UPDATE ${table} SET ${sets.join(', ')} ${where.text} ${returningSql(table, query.returning)}`
      const rows = await runSql<object>(sql, text, [...params, ...where.params])
      if (!query.returning) return { data: null, error: null, count: rows.length, status: 200 }
      return shapeResult(rows, query, rows.length)
    }

    if (query.op === 'delete') {
      if (!ctx.athleteId) return fail('not signed in as an athlete', 401)
      const joins = new Map<string, string>()
      for (const filter of query.filters ?? []) walkFilterPath(table, filter.column, joins)
      if (joins.size > 0) return fail('delete with embeds is not supported', 400)
      const where = whereClause(table, ctx.athleteId, ctx.userId, query.filters ?? [], joins, 1)
      if (!where.text) return fail('refusing unfiltered delete', 400)
      const rows = await runSql<object>(sql, `DELETE FROM ${table} ${where.text} ${returningSql(table, query.returning)}`, where.params)
      if (!query.returning) return { data: null, error: null, count: rows.length, status: 200 }
      return shapeResult(rows, query, rows.length)
    }

    return fail('unknown op', 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail(message, 400)
  }
}

export async function handleData(req: Request, env: Env): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)

  const user = await sessionUser(env, req)
  if (!user) return json({ data: null, error: { message: 'unauthorized' }, count: null }, 401, cors)

  let body: DataQuery
  try {
    body = await req.json() as DataQuery
  } catch {
    return json({ data: null, error: { message: 'invalid json' }, count: null }, 400, cors)
  }

  try {
    const sql = getSql(env)
    const athleteId = await resolveAthleteId(sql, user.id)
    const result = await executeDataQuery(sql, { userId: user.id, athleteId }, body)
    return json(
      { data: result.data, error: result.error, count: result.count },
      result.status,
      cors,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json({ data: null, error: { message }, count: null }, 500, cors)
  }
}
