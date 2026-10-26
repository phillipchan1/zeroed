/**
 * postgres.js-shaped tagged template over PGlite for isolation checks.
 * Not imported by the Worker runtime (excluded from worker/tsconfig).
 */
import { PGlite } from '@electric-sql/pglite'
import type { Sql } from './db.ts'

const JSON_MARK = Symbol('pg-json')

interface JsonParam {
  [JSON_MARK]: true
  value: unknown
}

function isJsonParam(value: unknown): value is JsonParam {
  return typeof value === 'object' && value !== null && JSON_MARK in value
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
      params.push(value)
      if (Array.isArray(value)) {
        const uuidish = value.every((item) => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item))
        text += uuidish ? `$${params.length}::uuid[]` : `$${params.length}::text[]`
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
  })
  return query
}
