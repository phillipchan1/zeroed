// skill_blocks_v1 (spec §12) against a real schema. Flag off: the MCP tool
// list, the edit tools and /api/session-rx are exactly as before, and kind /
// window_s sent anyway are dropped. Flag on: the edit tools take kind and
// window_s, a coach can write a skill station without interval syntax, and
// the diff says so; the session-rx Worker output is unchanged. The flag is its
// own: tracks_v1 / coach_v1 don't turn it on and it doesn't turn them on.
// Athlete A's flag and writes never reach athlete B. Synthetic data.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/skillBlocks.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { coachV1On } from './activities.ts'
import { sessionRxForAthlete } from './sessionRx.ts'
import { tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool, ZEROED_TOOLS, zeroedToolsFor } from './tools.ts'
import { makeStore } from './store.ts'
import { skillBlocksV1On, skillEditsFor } from './skillBlocks.ts'
import { intervalPlanFor } from '../../src/engine/intervals.ts'
import { isSkillBlock } from '../../src/engine/skillBlock.ts'
import type { ExerciseTemplate } from '../../src/types/database.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const ROUTINE_A = '77777777-7777-7777-7777-777777777777'
const ROUTINE_B = '88888888-8888-8888-8888-888888888888'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
await harness.query(`UPDATE athlete SET adult_confirmed_at = NOW()`)
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }

const call = (name: string, args: Record<string, unknown>, athlete = A, actor: OverrideActor = coachA) =>
  executeZeroedTool(sql, athlete, name, args, {}, actor)
async function setFlag(athleteId: string, k: string, on: boolean) {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || jsonb_build_object(${k}::text, true) WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - ${k}::text WHERE id = ${athleteId}`
}
const exercises = async (routineId: string) =>
  (await sql<{ exercises: ExerciseTemplate[] }[]>`SELECT exercises FROM routine WHERE id = ${routineId}`)[0]?.exercises ?? []
const rx = async (athlete: string, routine: string) =>
  JSON.stringify(await sessionRxForAthlete(sql, athlete, { routine_id: routine, unit: 'lb', storage_unit: 'lb' }))
const hasSkillProps = (tools: unknown) => /"window_s"|"kind":\{/.test(JSON.stringify(tools))

// A finishing station the way a coach writes it with the kind, and the same
// station in the interval syntax that yanked the athlete on court.
const station = {
  type: 'add_exercise', session_name: 'A day', exercise_name: 'Finishing — layups', sets: 1, reps: '6 makes',
  load: 'bodyweight', cue: 'Skip if the knee talks. Miss = one extra.', kind: 'skill', window_s: 480, rest_s: 45,
  rationale: 'synthetic skill station',
}
const stationBare = Object.fromEntries(Object.entries(station).filter(([k]) => k !== 'kind' && k !== 'window_s'))

// ---- the flag is its own ------------------------------------------------------------------------
ok(!(await skillBlocksV1On(storeA)) && !(await skillBlocksV1On(storeB)), 'default: skill_blocks_v1 off for everyone')
await setFlag(A, 'tracks_v1', true)
await setFlag(A, 'coach_v1', true)
ok(!(await skillBlocksV1On(storeA)), 'tracks_v1 + coach_v1 do not turn skill_blocks_v1 on')
await setFlag(A, 'tracks_v1', false)
await setFlag(A, 'coach_v1', false)

// ---- flag OFF: exactly as before ----------------------------------------------------------------
const rxA0 = await rx(A, ROUTINE_A)
const rxB0 = await rx(B, ROUTINE_B)
const listOff = await zeroedToolsFor(sql, A)
ok(JSON.stringify(listOff) === JSON.stringify(ZEROED_TOOLS), 'flag off: tool list is exactly ZEROED_TOOLS')
ok(!hasSkillProps(listOff), 'flag off: no kind / window_s anywhere in the tool schemas')

const prevOffKind = await call('preview_program_edits', { edits: [station] })
const prevOffBare = await call('preview_program_edits', { edits: [stationBare] })
ok(prevOffKind === prevOffBare, 'flag off: kind / window_s sent anyway preview exactly like the edit without them')
ok(!prevOffKind.includes('skill block'), 'flag off: the diff says nothing about a skill block')
ok(JSON.stringify(skillEditsFor([station], false)) === JSON.stringify([stationBare]), 'flag off: stripped at the door')
const nested = skillEditsFor([{ type: 'add_session', exercises: [{ name: 'x', kind: 'skill', window_s: 60 }] }], false)
ok(JSON.stringify(nested) === JSON.stringify([{ type: 'add_session', exercises: [{ name: 'x' }] }]), 'flag off: nested add_session exercises stripped too')

// tracks_v1 on, skill off: the tracks_v1 list, untouched.
await setFlag(A, 'tracks_v1', true)
const tracksList = await zeroedToolsFor(sql, A)
ok(!hasSkillProps(tracksList), 'tracks_v1 only: no kind / window_s in the schemas')
await setFlag(A, 'tracks_v1', false)

// ---- flag ON ------------------------------------------------------------------------------------
await setFlag(A, 'skill_blocks_v1', true)
ok(await skillBlocksV1On(storeA), 'flag on for A')
ok(!(await tracksV1On(storeA)) && !(await coachV1On(storeA)), 'skill_blocks_v1 does not turn tracks_v1 or coach_v1 on')
const listOn = await zeroedToolsFor(sql, A)
ok(listOn.length === listOff.length, 'flag on: same tools, same count')
ok(JSON.stringify(listOn.map((t) => t.name)) === JSON.stringify(listOff.map((t) => t.name)), 'flag on: same tool names in order')
const editTool = (n: string) => listOn.find((t) => t.name === n)?.inputSchema as { properties: { edits: { items: { properties: Record<string, unknown> & { exercises: { items: { properties: Record<string, unknown> } } } } } } }
for (const n of ['preview_program_edits', 'apply_program_edits']) {
  const item = editTool(n).properties.edits.items
  ok('kind' in item.properties && 'window_s' in item.properties, `flag on: ${n} edits take kind and window_s`)
  ok('kind' in item.properties.exercises.items.properties, `flag on: ${n} add_session exercises take kind`)
}
const others = listOn.filter((t) => t.name !== 'preview_program_edits' && t.name !== 'apply_program_edits')
ok(JSON.stringify(others) === JSON.stringify(listOff.filter((t) => t.name !== 'preview_program_edits' && t.name !== 'apply_program_edits')), 'flag on: every other tool unchanged')

const prevOn = await call('preview_program_edits', { edits: [station] })
ok(prevOn.includes('skill block'), 'flag on: the preview diff names the skill block')

const applied = await call('apply_program_edits', { confirm: true, edits: [station] })
ok(/Applied|Wrote/.test(applied), 'flag on: the coach writes the station (tracks_v1 off: the in-place path as before)')
const exA = await exercises(ROUTINE_A)
const written = exA.find((e) => e.name === 'Finishing — layups')
ok(written?.kind === 'skill' && written?.window_s === 480 && written?.rest_s === 45 && written?.reps === '6 makes', 'flag on: kind, window, rest and the quality target stored on the exercise')
ok(written != null && isSkillBlock(written) && intervalPlanFor(written, true) == null, 'the stored station never gets the interval timer with the flag on')
ok(exA[0].name === 'Back Squat' && exA[0].kind === undefined, 'the existing exercise is untouched')

// The Worker's prescription doesn't change shape for the flag; the app picks the UI.
const rxA1 = await rx(A, ROUTINE_A)
await setFlag(A, 'skill_blocks_v1', false)
const rxA1off = await rx(A, ROUTINE_A)
ok(rxA1 === rxA1off, 'session-rx: identical with the flag on and off')
ok(rxA0.length > 0, 'session-rx answered before any change')
await setFlag(A, 'skill_blocks_v1', true)

// tracks_v1 + skill on: the gated preview still lists the station and needs approval to write.
await setFlag(A, 'tracks_v1', true)
const gatedList = await zeroedToolsFor(sql, A)
const gatedPreview = gatedList.find((t) => t.name === 'preview_program_edits')!.inputSchema as { properties: Record<string, unknown> & { edits: { items: { properties: Record<string, unknown> } } } }
ok('rewrite' in gatedPreview.properties && 'kind' in gatedPreview.properties.edits.items.properties, 'tracks_v1 + skill: both extensions on the preview tool')
const gatedApply = await call('apply_program_edits', { confirm: true, edits: [{ ...station, exercise_name: 'Post entry finishing' }] })
ok(/approval|preview_id/i.test(gatedApply) && !(await exercises(ROUTINE_A)).some((e) => e.name === 'Post entry finishing'), 'tracks_v1 + skill: still propose-only — no write without preview + approval')
await setFlag(A, 'tracks_v1', false)

// ---- isolation ----------------------------------------------------------------------------------
ok(!(await skillBlocksV1On(storeB)), 'isolation: A\'s flag is not B\'s')
ok(JSON.stringify(await zeroedToolsFor(sql, B)) === JSON.stringify(ZEROED_TOOLS), 'isolation: B\'s coach sees the list as before')
const exB0 = JSON.stringify(await exercises(ROUTINE_B))
await call('apply_program_edits', { confirm: true, edits: [{ ...station, session_name: 'B day', exercise_name: 'Cross-athlete station' }] })
ok(JSON.stringify(await exercises(ROUTINE_B)) === exB0, 'isolation: A\'s coach cannot write a station into B\'s week')
// B's coach sends kind with B's flag off: dropped, B's write as before.
const bApply = await call('apply_program_edits', { confirm: true, edits: [{ ...station, session_name: 'B day', exercise_name: 'B station' }] }, B, coachB)
const bStation = (await exercises(ROUTINE_B)).find((e) => e.name === 'B station')
ok(/Applied|Wrote/.test(bApply) && bStation != null && bStation.kind === undefined && bStation.window_s === undefined, 'isolation: B\'s flag off strips kind on B\'s write, whatever A has on')
ok(!(await exercises(ROUTINE_A)).some((e) => e.name === 'B station'), 'isolation: B\'s write never lands in A\'s week')
ok(await rx(B, ROUTINE_B) !== '' && rxB0.length > 0, 'isolation: B\'s session-rx still answers')

await harness.close()

if (fails.length) {
  console.error(`${fails.length} of ${checks} checks failed:`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`${checks} checks, 0 failed`)
console.log(`skillBlocks (${harness.backend}): ok`)
