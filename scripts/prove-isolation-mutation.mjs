#!/usr/bin/env node
/**
 * Mutation proof for access isolation.
 * Deletes each per-athlete filter in store.ts / edits.ts on its own and
 * asserts access.check fails. Also keeps the original M1 (loadWorkout) and
 * M2 (all filters → TRUE) cases.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const storePath = 'worker/src/store.ts'
const editsPath = 'worker/src/edits.ts'
const originalStore = readFileSync(storePath, 'utf8')
const originalEdits = readFileSync(editsPath, 'utf8')

const ATHLETE_FILTER = /(?:p\.)?athlete_id = \$\{store\.athleteId\}/g
const STORE_ID_FILTER = /WHERE id = \$\{store\.athleteId\}/g

function restore() {
  writeFileSync(storePath, originalStore)
  writeFileSync(editsPath, originalEdits)
}

function runCheck() {
  return spawnSync(process.execPath, ['--experimental-strip-types', 'worker/src/access.check.ts'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function collectFilters() {
  const items = []
  for (const match of originalStore.matchAll(ATHLETE_FILTER)) {
    items.push({
      file: 'store',
      path: storePath,
      source: originalStore,
      index: match.index ?? 0,
      text: match[0],
      line: lineOf(originalStore, match.index ?? 0),
    })
  }
  for (const match of originalStore.matchAll(STORE_ID_FILTER)) {
    items.push({
      file: 'store',
      path: storePath,
      source: originalStore,
      index: match.index ?? 0,
      text: match[0],
      line: lineOf(originalStore, match.index ?? 0),
    })
  }
  for (const match of originalEdits.matchAll(ATHLETE_FILTER)) {
    items.push({
      file: 'edits',
      path: editsPath,
      source: originalEdits,
      index: match.index ?? 0,
      text: match[0],
      line: lineOf(originalEdits, match.index ?? 0),
    })
  }
  items.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index)
  return items
}

function neutralize(source, index, text) {
  const before = source.slice(0, index)
  const after = source.slice(index + text.length)
  if (text.startsWith('WHERE ')) return `${before}WHERE TRUE${after}`
  return `${before}TRUE${after}`
}

function expectFail(label, mutate) {
  try {
    mutate()
    const res = runCheck()
    const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
    console.log(`\n=== ${label} ===`)
    console.log(out)
    if (res.status === 0) {
      throw new Error(`${label}: isolation check still passed — mutation was not detected`)
    }
    const failed = / (\d+) failed/.exec(out)
    console.log(`${label}: failed as expected (exit ${res.status}, ${failed?.[1] ?? '?'} checks failed)`)
  } finally {
    restore()
  }
}

const filters = collectFilters()
if (filters.length !== 16) {
  console.error('expected 16 per-athlete filters, found:')
  for (const f of filters) console.error(`  ${f.file}.ts:${f.line} ${f.text}`)
  throw new Error(`expected 16 filters, found ${filters.length}`)
}

expectFail('M1 delete loadWorkout athlete_id filter', () => {
  const next = originalStore.replace(
    /WHERE w\.id = \$\{workoutId\}\n\s+AND p\.athlete_id = \$\{store\.athleteId\}/,
    'WHERE w.id = ${workoutId}',
  )
  if (next === originalStore) throw new Error('M1: could not find loadWorkout athlete_id filter')
  writeFileSync(storePath, next)
})

expectFail('M2 set athlete_id filters to TRUE', () => {
  const repl = (source) => source
    .replace(/p\.athlete_id = \$\{store\.athleteId\}/g, 'TRUE')
    .replace(/athlete_id = \$\{store\.athleteId\}/g, 'TRUE')
  writeFileSync(storePath, repl(originalStore))
  writeFileSync(editsPath, repl(originalEdits))
})

for (const filter of filters) {
  const label = `${filter.file}.ts:${filter.line} delete \`${filter.text}\``
  expectFail(label, () => {
    writeFileSync(filter.path, neutralize(filter.source, filter.index, filter.text))
  })
}

console.log(`\nmutation proof: ok (M1, M2, and ${filters.length} single-filter mutations failed as expected)`)
