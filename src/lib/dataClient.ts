/**
 * PostgREST-shaped client that posts to Worker /api/data when the API base
 * is the Cloudflare Worker. The live supabase-js client stays on the empty
 * VITE_API_BASE_URL path.
 */
import { dataUrl } from './api'

export interface DataFilter {
  column: string
  op: 'eq' | 'neq' | 'in' | 'gte' | 'gt' | 'lte' | 'lt' | 'ilike' | 'not_in'
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

export interface QueryResult<T = unknown> {
  data: T
  error: { message: string; code?: string } | null
  count: number | null
}

type SelectOpts = { count?: 'exact'; head?: boolean }

class QueryBuilder implements PromiseLike<QueryResult> {
  private spec: DataQuery

  constructor(table: string) {
    this.spec = { table, op: 'select', filters: [] }
  }

  select(columns = '*', opts?: SelectOpts): this {
    if (this.spec.op === 'insert' || this.spec.op === 'update' || this.spec.op === 'upsert' || this.spec.op === 'delete') {
      this.spec.returning = columns || '*'
    } else {
      this.spec.op = 'select'
      this.spec.columns = columns
    }
    if (opts?.count) this.spec.count = opts.count
    if (opts?.head) this.spec.head = true
    return this
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.spec.op = 'insert'
    this.spec.values = values
    return this
  }

  update(values: Record<string, unknown>): this {
    this.spec.op = 'update'
    this.spec.values = values
    return this
  }

  upsert(values: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }): this {
    this.spec.op = 'upsert'
    this.spec.values = values
    if (opts?.onConflict) this.spec.onConflict = opts.onConflict
    return this
  }

  delete(): this {
    this.spec.op = 'delete'
    return this
  }

  eq(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'eq', value }]
    return this
  }

  neq(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'neq', value }]
    return this
  }

  in(column: string, value: unknown[]): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'in', value }]
    return this
  }

  gte(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'gte', value }]
    return this
  }

  gt(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'gt', value }]
    return this
  }

  lte(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'lte', value }]
    return this
  }

  lt(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'lt', value }]
    return this
  }

  ilike(column: string, value: unknown): this {
    this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'ilike', value }]
    return this
  }

  not(column: string, op: string, value: unknown): this {
    if (op === 'in') {
      const list = typeof value === 'string'
        ? value.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim()).filter(Boolean)
        : Array.isArray(value) ? value : [value]
      this.spec.filters = [...(this.spec.filters ?? []), { column, op: 'not_in', value: list }]
      return this
    }
    throw new Error(`unsupported not operator: ${op}`)
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.spec.order = { column, ascending: opts?.ascending !== false }
    return this
  }

  limit(n: number): this {
    this.spec.limit = n
    return this
  }

  maybeSingle<T = unknown>(): Promise<QueryResult<T | null>> {
    this.spec.single = 'maybe'
    return this.execute<T | null>()
  }

  single<T = unknown>(): Promise<QueryResult<T>> {
    this.spec.single = 'one'
    return this.execute<T>()
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private execute<T = unknown>(): Promise<QueryResult<T>> {
    return postData<T>(this.spec)
  }
}

async function postData<T = unknown>(spec: DataQuery): Promise<QueryResult<T>> {
  const url = dataUrl()
  if (!url) {
    return { data: null as T, error: { message: 'VITE_API_BASE_URL is not set' }, count: null }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const { getAccessToken } = await import('./authClient')
    const token = await getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* cookies still carry the session */
  }
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(spec),
  })
  let parsed: QueryResult<T> | null = null
  try {
    parsed = await res.json() as QueryResult<T>
  } catch {
    return { data: null as T, error: { message: `data ${res.status}` }, count: null }
  }
  if (parsed && typeof parsed === 'object') {
    return {
      data: (parsed.data ?? null) as T,
      error: parsed.error ?? (res.ok ? null : { message: `data ${res.status}` }),
      count: parsed.count ?? null,
    }
  }
  return { data: null as T, error: { message: `data ${res.status}` }, count: null }
}

class RpcBuilder implements PromiseLike<QueryResult> {
  constructor(private fn: string) {}

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return postData({ table: 'athlete', op: 'rpc', fn: this.fn }).then(onfulfilled, onrejected)
  }
}

export function createDataFacade() {
  return {
    from(table: string) {
      return new QueryBuilder(table)
    },
    rpc(fn: string) {
      return new RpcBuilder(fn)
    },
  }
}
