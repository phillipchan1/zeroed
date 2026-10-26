#!/usr/bin/env node
/**
 * Mutation proof for access isolation.
 * Deleting the loadWorkout athlete_id filter (store.ts) or setting every
 * athlete_id filter in store/edits to TRUE must make access.check fail.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const storePath = 'worker/src/store.ts'
const editsPath = 'worker/src/edits.ts'
const originalStore = readFileSync(storePath, 'utf8')
const originalEdits = readFileSync(editsPath, 'utf8')

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
    console.log(`${label}: failed as expected (exit ${res.status})`)
  } finally {
    restore()
  }
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
  const storeNext = repl(originalStore)
  const editsNext = repl(originalEdits)
  if (storeNext === originalStore && editsNext === originalEdits) {
    throw new Error('M2: no athlete_id filters found')
  }
  writeFileSync(storePath, storeNext)
  writeFileSync(editsPath, editsNext)
})

console.log('\nmutation proof: ok (M1 and M2 failed as expected)')
