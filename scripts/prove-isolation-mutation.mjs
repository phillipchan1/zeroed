#!/usr/bin/env node
/**
 * Mutation proof for access isolation.
 * Asserts the unmutated tree is green, then deletes each owner filter in
 * store.ts / edits.ts / data.ts on its own and expects access.check to fail.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (process.env.CI && !String(process.env.ZEROED_TEST_DATABASE_URL ?? '').trim()) {
  throw new Error('CI must set ZEROED_TEST_DATABASE_URL so isolation mutations run on real Postgres (never DATABASE_URL)')
}

const storePath = 'worker/src/store.ts'
const editsPath = 'worker/src/edits.ts'
const dataPath = 'worker/src/data.ts'
const originalStore = readFileSync(storePath, 'utf8')
const originalEdits = readFileSync(editsPath, 'utf8')
const originalData = readFileSync(dataPath, 'utf8')

const ATHLETE_FILTER = /(?:p\.)?athlete_id = \$\{(?:store\.)?athleteId\}/g
// Owner `id =` filters only — not the `athlete_id =` substring.
const ID_FILTER = /(?<![A-Za-z_])id = \$\{(?:store\.)?athleteId\}/g

function restore() {
  writeFileSync(storePath, originalStore)
  writeFileSync(editsPath, originalEdits)
  writeFileSync(dataPath, originalData)
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

function collectFrom(file, path, source) {
  const items = []
  for (const re of [ATHLETE_FILTER, ID_FILTER]) {
    re.lastIndex = 0
    for (const match of source.matchAll(re)) {
      items.push({
        file,
        path,
        source,
        index: match.index ?? 0,
        text: match[0],
        line: lineOf(source, match.index ?? 0),
      })
    }
  }
  return items
}

function collectFilters() {
  const items = [
    ...collectFrom('store', storePath, originalStore),
    ...collectFrom('edits', editsPath, originalEdits),
    ...collectFrom('data', dataPath, originalData),
  ]
  items.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index)
  return items
}

function neutralize(source, index, text) {
  const before = source.slice(0, index)
  const after = source.slice(index + text.length)
  if (before.endsWith('WHERE ')) return `${before}TRUE${after}`
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

const baseline = runCheck()
const baselineOut = `${baseline.stdout || ''}\n${baseline.stderr || ''}`.trim()
console.log('=== baseline (unmutated) ===')
console.log(baselineOut)
if (baseline.status !== 0) {
  throw new Error('unmutated isolation check must be green before mutations run')
}
console.log('baseline: isolation check green')

const filters = collectFilters()
if (filters.length === 0) {
  throw new Error('no owner filters found in store.ts / edits.ts / data.ts')
}
console.log(`derived ${filters.length} owner filters:`)
for (const f of filters) console.log(`  ${f.file}.ts:${f.line} ${f.text}`)

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
    .replace(/p\.athlete_id = \$\{(?:store\.)?athleteId\}/g, 'TRUE')
    .replace(/athlete_id = \$\{(?:store\.)?athleteId\}/g, 'TRUE')
    .replace(/(?<![A-Za-z_])id = \$\{(?:store\.)?athleteId\}/g, 'TRUE')
  writeFileSync(storePath, repl(originalStore))
  writeFileSync(editsPath, repl(originalEdits))
  writeFileSync(dataPath, repl(originalData))
})

for (const filter of filters) {
  const label = `${filter.file}.ts:${filter.line} delete \`${filter.text}\``
  expectFail(label, () => {
    writeFileSync(filter.path, neutralize(filter.source, filter.index, filter.text))
  })
}

expectFail('data.ts drop join-alias owner predicates', () => {
  const next = originalData.replace(
    /for \(const alias of joins\.keys\(\)\) \{\n\s+parts\.push\(bindOwner\(alias, athleteId, ownerSlot, alias\)\.text\)\n\s+\}/,
    '',
  )
  if (next === originalData) throw new Error('could not find join-alias owner loop')
  writeFileSync(dataPath, next)
})

expectFail('data.ts drop DELETABLE gate', () => {
  const next = originalData.replace(
    /if \(!DELETABLE\.has\(table\)\) return fail\('not found', 404\)\n/,
    '',
  )
  if (next === originalData) throw new Error('could not find DELETABLE gate')
  writeFileSync(dataPath, next)
})

expectFail('data.ts drop upsert 0-row 404', () => {
  const next = originalData.replace(
    /if \(query\.op === 'upsert' && rows\.length === 0 && ctx\.athleteId\) return fail\('not found', 404\)\n/,
    '',
  )
  if (next === originalData) throw new Error('could not find upsert 0-row 404')
  writeFileSync(dataPath, next)
})

const structural = 3
console.log(`\nmutation proof: ok (${filters.length + structural}/${filters.length + structural})`)
