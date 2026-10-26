// Integrity check for the Zeroed MCP — no live database.
// Run: npm --prefix mcp run check

import { applyEditsToDraft, diffDraft, type ProgramDraft } from '../../src/engine/programDraft.ts'
import type { ProgramEdit } from '../../src/engine/agentClient.ts'
import { previewEdits, toProgramEdit, type EditInput } from './edits.ts'
import { formatDiff, formatDraft, formatLoggedWorkout, formatQueuedBlock, formatSet } from './format.ts'
import { createZeroedServer, SERVER_INSTRUCTIONS } from './server.ts'
import { e1rmFromSet, liftNameMatcher } from '../../src/engine/liftModel.ts'
import type { LiveProgram } from './store.ts'
import type { SetLog } from '../../src/types/database.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

function edit(e: Partial<ProgramEdit> & { type: ProgramEdit['type'] }): ProgramEdit {
  return {
    rationale: 'because',
    session_name: null, exercise_name: null, after_exercise: null,
    set_name: null, set_intent: null, set_session_type: null, set_intended_dow: null,
    sets: null, reps: null, load: null, cue: null, target_rpe: null,
    sessions_per_week: null, note: null, exercises: [],
    ...e,
  }
}

const live: LiveProgram = {
  programId: 'p1',
  goal: 'Get the squat honest again',
  phaseId: 'ph1',
  phaseName: 'Strength',
  weekStart: '2026-08-24',
  weekEnd: '2026-09-20',
  nonNegotiables: ['Brace before you squat'],
  advancementCriteria: ['Clearance squat @ 8 RPE without a hitch'],
  sessionsPerWeek: 3,
  standingPreferences: 'Keep jumps',
  sessions: [
    {
      routineId: 'r1',
      name: 'Lower A',
      intent: 'Squat + posterior',
      sessionType: 'strength',
      intendedDow: 0,
      exercises: [
        { name: 'Back Squat', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
        { name: 'Romanian Deadlift', sets: 3, reps: '8', load: 'moderate' },
      ],
    },
    {
      routineId: 'r2',
      name: 'Upper A',
      intent: 'Press',
      sessionType: 'strength',
      intendedDow: 2,
      exercises: [
        { name: 'Bench press', sets: 4, reps: '5', load: 'heavy', target_rpe: 8 },
        { name: 'Chin-up', sets: 3, reps: '6', load: 'bodyweight' },
      ],
    },
  ],
  scheduledPhase: null,
  scheduledSessions: [],
}

const base: ProgramDraft = {
  sessionsPerWeek: live.sessionsPerWeek,
  sessions: live.sessions.map((s) => ({
    routineId: s.routineId,
    name: s.name,
    intent: s.intent,
    sessionType: s.sessionType,
    intendedDow: s.intendedDow,
    exercises: s.exercises,
  })),
}

// ---- surgical edits stay additive ------------------------------------------
const added = applyEditsToDraft(base, [
  edit({ type: 'add_exercise', session_name: 'Lower A', exercise_name: 'Box Jump', sets: 4, reps: '3', load: 'bodyweight', after_exercise: 'Back Squat' }),
])
ok(added.outcomes.every((o) => o.applied), 'box jump should apply')
const jumpDiff = diffDraft(base, added.draft)
ok(jumpDiff.added === 1 && jumpDiff.removed === 0, `additive edit should be +1 / −0, got +${jumpDiff.added} / −${jumpDiff.removed}`)
ok(added.draft.sessions[0].exercises[1].name === 'Box Jump', 'anchor places the jump after the squat')

// ---- preview talks in the same terms ---------------------------------------
const inputs: EditInput[] = [
  { type: 'add_exercise', session_name: 'Lower A', exercise_name: 'Box Jump', sets: 4, reps: '3', load: 'bodyweight' },
  { type: 'update_exercise', session_name: 'Upper A', exercise_name: 'Bench', sets: 5 },
]
const preview = previewEdits(live, inputs)
ok(preview.applied === 2, `preview should apply both edits, applied=${preview.applied}`)
ok(preview.dirty, 'preview of real edits must be dirty')
ok(preview.text.includes('Box Jump'), 'preview names the added lift')
ok(preview.text.includes('4×5') || preview.text.includes('5×5'), 'preview shows the retuned bench')
ok(preview.text.includes('Writes nothing') || preview.text.includes('confirm=true'), 'preview reminds the caller to confirm')

// ---- confirm gate ----------------------------------------------------------
const refused = toProgramEdit({ type: 'add_note', note: 'keep the jumps' })
ok(refused.type === 'add_note' && refused.note === 'keep the jumps', 'toProgramEdit fills the note')
ok(refused.exercises.length === 0, 'notes do not invent exercises')

// ---- formatters ------------------------------------------------------------
ok(formatSet({ set: 1, weight: 315, reps: 5, rpe: 8, done: true }, 'lb') === '315lb×5 @8', 'loaded set format')
ok(formatDraft(base).includes('Lower A'), 'draft formatter lists sessions')
const queuedText = formatQueuedBlock(
  { name: 'Power', weekStart: '2026-11-02' },
  [{
    routineId: 'q1',
    name: 'Mon Power Lower',
    intent: 'Convert strength into speed',
    sessionType: 'power',
    intendedDow: 0,
    exercises: [{ name: 'Speed Bench', sets: 5, reps: '2', load: 'about 170 lb', target_rpe: 5 }],
  }],
)
ok(queuedText.includes('Queued: Power starts 2026-11-02'), 'queued header names the block')
ok(queuedText.includes('Speed Bench'), 'queued block lists its sessions, not just the start date')
ok(queuedText.includes('about 170 lb'), 'queued session keeps the prescribed load')
ok(formatDiff(jumpDiff).includes('Box Jump'), 'diff formatter names additions')
// search_lifts reads the RPE chart now, not Epley: the same 315×5 is a different max at @6 than @9.
ok(Math.round(e1rmFromSet(315, 5, 8)!) === 388, `315x5 @8 should be e1RM 388, got ${e1rmFromSet(315, 5, 8)}`)
ok(e1rmFromSet(315, 5, 6)! > e1rmFromSet(315, 5, 9)!, 'an easier five says more about the max')
// …and matches a main lift by identity: "squat" never pulls a Cossack, "press" never the bench.
ok(liftNameMatcher('squat')('Squat (no belt)') && !liftNameMatcher('squat')('Cossack Squat'), 'squat matches by identity')
ok(liftNameMatcher('press')('Strict OHP') && !liftNameMatcher('press')('Bench press'), 'press is the overhead press')
ok(liftNameMatcher('row')('Chest-supported DB row'), 'anything else still matches by substring')

const logged = formatLoggedWorkout({
  performed_at: '2026-08-24T17:00:00Z',
  rpe: 8,
  duration_mins: 54,
  actual_weights: {
    0: [{ set: 1, weight: 315, reps: 5, rpe: 8, done: true } as SetLog],
  },
  exercises_snapshot: [{ name: 'Back Squat', sets: 4, reps: '5', load: 'heavy' }],
  routine: { name: 'Lower A', exercises: [] },
}, 'lb')
ok(logged.includes('Back Squat'), 'logged workout uses the snapshot, not the live routine')
ok(logged.includes('315lb×5'), 'logged workout prints the top set')

// ---- server advertises the coaching surface --------------------------------
ok(SERVER_INSTRUCTIONS.includes('get_training_brief'), 'instructions tell Claude to start with the brief')
const server = createZeroedServer()
ok(Boolean(server), 'MCP server constructs without credentials')

// Protocol handshake: list tools the way Claude Desktop does, no database.
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'zeroed-mcp-check', version: '0.1.0' })
await server.connect(serverTransport)
await client.connect(clientTransport)
const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
for (const need of [
  'get_training_brief', 'get_athlete', 'get_insights', 'get_current_program',
  'list_workouts', 'get_workout', 'search_lifts', 'get_program_journey',
  'get_coach_notes', 'preview_program_edits', 'apply_program_edits',
]) {
  ok(names.includes(need), `protocol lists ${need}`)
}
const brief = tools.find((t) => t.name === 'get_training_brief')
ok(Boolean(brief?.description?.toLowerCase().includes('first')), 'brief tool tells the model to start there')
const apply = tools.find((t) => t.name === 'apply_program_edits')
ok(Boolean(apply?.inputSchema), 'apply tool advertises a schema')
const { prompts } = await client.listPrompts()
ok(prompts.some((p) => p.name === 'coach'), 'protocol lists the coach prompt')

// Confirm is checked before any database connection, so a refused write
// never needs credentials and never talks to Supabase.
const applyRefused = await client.callTool({
  name: 'apply_program_edits',
  arguments: { confirm: false, edits: [{ type: 'add_note', note: 'keep jumps' }] },
})
const applyRefusedText = JSON.stringify(applyRefused)
ok(applyRefusedText.includes('confirm=true'), 'apply without confirm is refused')
ok(!applyRefusedText.includes('ZEROED_SUPABASE_URL'), 'refusal must not require credentials')

// Without credentials the tool must fail clearly — never hang or throw out of band.
const call = await client.callTool({ name: 'get_training_brief', arguments: {} })
const callText = JSON.stringify(call)
ok(Boolean(call.isError), 'unconfigured brief is marked as a tool error')
ok(callText.includes('ZEROED_') || callText.includes('not signed') || callText.includes('Missing'), 'unconfigured brief names the missing setup')

await client.close()
await server.close()

if (fails.length) {
  console.error(`zeroed-mcp check failed (${fails.length}/${checks}):`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.error(`zeroed-mcp check passed (${checks} assertions)`)
