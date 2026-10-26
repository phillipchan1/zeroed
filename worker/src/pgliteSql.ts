/**
 * Same tagged-template Sql as production, over PGlite.
 * Not imported by the Worker runtime (excluded from worker/tsconfig).
 */
import { PGlite } from '@electric-sql/pglite'
import { makeClientSql, type Sql } from './db.ts'

export function makePgliteSql(db: PGlite): Sql {
  return makeClientSql((text, params) => db.query(text, params ?? []))
}
