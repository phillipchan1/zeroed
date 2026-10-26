/**
 * postgres.js-shaped tagged template over PGlite for isolation checks.
 * Not imported by the Worker runtime (excluded from worker/tsconfig).
 */
import { PGlite } from '@electric-sql/pglite'
import type { Sql } from './db.ts'

const JSON_MARK = Symbol('pg-json')
const ARRAY_MARK = Symbol('pg-array')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface JsonParam {
  [JSON_MARK]: true
  value: unknown
}

interface ArrayParam {
  [ARRAY_MARK]: true
  value: unknown[]
}

function isJsonParam(value: unknown): value is JsonParam {
  return typeof value === 'object' && value !== null && JSON_MARK in value
}

function isArrayParam(value: unknown): value is ArrayParam {
  return typeof value === 'object' && value !== null && ARRAY_MARK in value
}

function arrayCast(values: unknown[]): string {
  const uuidish = values.every((item) => typeof item === 'string' && UUID_RE.test(item))
  return uuidish ? '::uuid[]' : '::text[]'
}

export function makePgliteSql(db: PGlite): Sql {
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = ''
    const params: unknown[] = []
    for (let i = 0; i < strings.length; i++) {
      text += strings[i]
      if (i >= values.length) continue
      const value = values[i]
      if (isJsonParam(value)) {
        params.push(JSON.stringify(value.value))
        text += `$${params.length}::jsonb`
        continue
      }
      if (isArrayParam(value)) {
        params.push(value.value)
        const next = strings[i + 1] ?? ''
        // Honor an explicit `::uuid[]` (or other) cast in the next fragment.
        text += /^\s*::/.test(next) ? `$${params.length}` : `$${params.length}${arrayCast(value.value)}`
        continue
      }
      params.push(value)
      if (Array.isArray(value)) {
        text += `$${params.length}${arrayCast(value)}`
      } else {
        text += `$${params.length}`
      }
    }
    const result = await db.query(text, params)
    return result.rows
  }) as Sql

  Object.assign(query, {
    json(value: unknown) {
      return { [JSON_MARK]: true, value } satisfies JsonParam
    },
    array(value: unknown[]) {
      return { [ARRAY_MARK]: true, value } satisfies ArrayParam
    },
  })
  return query
}
