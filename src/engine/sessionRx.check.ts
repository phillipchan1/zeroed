// Server prescription is the displayed load. A client TM / written-load
// recompute that can disagree with the Worker must fail this file.
//
// Run: node --experimental-strip-types src/engine/sessionRx.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unitContext } from '../lib/units.ts'
import type { ExerciseTemplate } from '../types/database.ts'
import { resolveSessionTarget } from './prescription.ts'
import {
  computeSessionPrescription, displayedSessionLoad, rxVersionHash, exerciseStamp,
  type SessionPrescription,
} from './sessionRxCompute.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}
function eq<T>(actual: T, expected: T, msg: string) {
  checks++
  if (actual !== expected) fails.push(`${msg} — expected ${String(expected)}, got ${String(actual)}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const LB = unitContext('lb', 'lb')
const ex = (name: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate =>
  ({ name, sets: 3, reps: '3', ...over })

const emptyRx = (over: Partial<SessionRxInputSoft> = {}) => computeSessionPrescription({
  exercises: [ex('Deadlift', { load: '350lb' }), ex('Squat (no belt)', { load: '295lb' })],
  u: LB,
  phaseName: 'Strength',
  directive: 'PROGRESS',
  loadDeltaPct: 0,
  rpeTarget: 8,
  rationale: null,
  p1: null,
  lastWeights: null,
  lastSnapshot: null,
  routineName: 'Tue Lower Strength',
  routineIntent: 'heavy',
  byName: new Map(),
  liftSrc: {
    workouts: [],
    today: '2026-11-03',
    unit: 'lb',
    convert: (w) => w,
    overrides: { deadlift: { value: 410, set_at: '2026-10-01', model_tm: 400 } },
    sessions: [],
    phaseName: 'Strength',
  },
  dayOf: null,
  today: '2026-11-03',
  ...over,
})

type SessionRxInputSoft = Parameters<typeof computeSessionPrescription>[0]

const tue = emptyRx()
eq(displayedSessionLoad(tue, 0), 350, 'Deadlift displays the server written load, not TM 410')
eq(displayedSessionLoad(tue, 1), 295, 'Squat displays the server written load, not a TM chart')
eq(tue.targets[0], 350, 'server target is 350')
eq(tue.exercises?.[0]?.call, 'PROGRAM', 'written load is a PROGRAM call, not PUSH')
ok(tue.hints[0].includes('350'), 'hint narrates the written load')
ok(!tue.hints[0].toLowerCase().includes('400'), 'hint does not mention the TM-chart 400')

const displayMustMatch = (rx: SessionPrescription, i: number) => {
  const shown = displayedSessionLoad(rx, i)
  const recomputed = resolveSessionTarget({ load: '410lb' }, 400, LB)
  return { shown, recomputed, server: rx.targets[i] ?? null }
}
const clash = displayMustMatch(tue, 0)
eq(clash.shown, clash.server, 'displayed load equals the server target for the same session')
ok(clash.recomputed !== clash.shown, 'a client TM/written recompute CAN differ — and must not be what we show')

const v1 = rxVersionHash({ exercises: [exerciseStamp(ex('Deadlift', { load: '400lb' }))] })
const v2 = rxVersionHash({ exercises: [exerciseStamp(ex('Deadlift', { load: '350lb' }))] })
ok(v1 !== v2, 'etag/version bumps when an MCP write changes the programmed load')

const gatherSrc = readFileSync(join(here, 'index.ts'), 'utf8')
ok(!/modelFromSources\(/.test(gatherSrc), 'gatherSessionPrescription / index.ts must not call modelFromSources')
ok(gatherSrc.includes('fetchSessionPrescription'), 'gatherSessionPrescription fetches the Worker payload')

const clientSrc = readFileSync(join(here, 'sessionRx.ts'), 'utf8')
ok(!/modelFromSources\(/.test(clientSrc), 'client sessionRx fetch must not compute a lift model')
ok(clientSrc.includes('sessionRxUrl'), 'client posts to /api/session-rx')

const todaySrc = readFileSync(join(here, '../screens/loop/TodayScreen.tsx'), 'utf8')
ok(!todaySrc.includes('resolveSessionTarget'), 'Today must not recompute a target from the template')
ok(!todaySrc.includes('modelFromSources'), 'Today must not run lift-model math')
ok(todaySrc.includes('displayedSessionLoad'), 'Today shows displayedSessionLoad (server targets)')
ok(todaySrc.includes('freshMs: 0'), 'session open bypasses the 60s fresh window')
ok(todaySrc.includes('PullToRefresh'), 'Today has pull-to-refresh')

const workoutSrc = readFileSync(join(here, '../screens/loop/WorkoutScreen.tsx'), 'utf8')
ok(!workoutSrc.includes('resolveSessionTarget'), 'Workout must not recompute a target from the template')
ok(!workoutSrc.includes('modelFromSources'), 'Workout must not run lift-model math for display')
ok(!workoutSrc.includes('keepsLiftModel'), 'Workout must not keep a stale TM reason over a server rx')
ok(workoutSrc.includes('displayedSessionLoad'), 'Workout shows displayedSessionLoad (server targets)')

const programSrc = readFileSync(join(here, '../screens/loop/ProgramScreen.tsx'), 'utf8')
ok(programSrc.includes('PullToRefresh'), 'Program has pull-to-refresh')

const workerSrc = readFileSync(join(here, '../../worker/src/sessionRx.ts'), 'utf8')
ok(workerSrc.includes('computeSessionPrescription'), 'Worker computes the prescription')
ok(workerSrc.includes('athleteOwnsRoutine'), 'Worker re-checks routine ownership')
ok(workerSrc.includes('beginAuthCors'), 'Worker uses the same auth CORS as /api/data')

const routeSrc = readFileSync(join(here, '../../worker/src/index.ts'), 'utf8')
ok(routeSrc.includes("/api/session-rx"), 'Worker exposes POST /api/session-rx')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('session-rx display contract: ok')
