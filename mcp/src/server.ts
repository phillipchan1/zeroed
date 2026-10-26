import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { applyEdits, previewEdits, type EditInput } from './edits.ts'
import { formatDraft, formatLoggedWorkout, formatQueuedBlock, jsonBlock } from './format.ts'
import { liveToDraft } from './edits.ts'
import {
  connectStore,
  loadAthlete,
  loadInsights,
  loadJourney,
  loadLiftHistory,
  loadLiveProgram,
  loadNotes,
  loadWorkout,
  loadWorkouts,
  pingStore,
  renderAthlete,
  renderInsights,
  renderJourney,
  renderLift,
  renderNotes,
} from './store.ts'

const editExercise = z.object({
  name: z.string().describe('Exercise name'),
  sets: z.number().int().min(1).max(10).optional(),
  reps: z.string().optional().describe('Rep spec, e.g. "5", "8-10", "30s"'),
  load: z.string().optional().describe('bodyweight | light | moderate | heavy'),
  cue: z.string().optional(),
  target_rpe: z.number().min(1).max(10).nullable().optional(),
})

const editObject = z.object({
  type: z.enum([
    'add_exercise', 'update_exercise', 'remove_exercise',
    'add_session', 'update_session', 'set_sessions_per_week', 'add_note',
  ]).describe('Surgical edit kind. Never rewrite a whole week — send only the deltas.'),
  rationale: z.string().optional(),
  session_name: z.string().nullable().optional().describe('Existing session to change (fuzzy match).'),
  exercise_name: z.string().nullable().optional(),
  after_exercise: z.string().nullable().optional().describe('For add_exercise, insert after this lift.'),
  set_name: z.string().nullable().optional().describe('New session name (update_session / add_session).'),
  set_intent: z.string().nullable().optional(),
  set_session_type: z.string().nullable().optional().describe('strength | power | conditioning | mobility'),
  set_intended_dow: z.number().int().min(0).max(6).nullable().optional().describe('0=Mon … 6=Sun'),
  sets: z.number().int().min(1).max(10).nullable().optional(),
  reps: z.string().nullable().optional(),
  load: z.string().nullable().optional(),
  cue: z.string().nullable().optional(),
  target_rpe: z.number().min(1).max(10).nullable().optional(),
  sessions_per_week: z.number().int().min(1).max(7).nullable().optional(),
  note: z.string().nullable().optional(),
  exercises: z.array(editExercise).optional().describe('Required for add_session.'),
})

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError }
}

async function safe(run: () => Promise<string>) {
  try {
    return text(await run())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return text(message, true)
  }
}

export const SERVER_INSTRUCTIONS = [
  'Zeroed is the athlete\'s live training log and program.',
  'Start almost every conversation with get_training_brief so you have the current week, open insights, and recent sessions.',
  'Chat against the record: list_workouts, get_workout, search_lifts, get_program_journey, get_coach_notes.',
  'To change the program: propose surgical edits (add/update/remove exercise or session), call preview_program_edits, show the diff, then apply_program_edits with confirm=true only after the athlete agrees.',
  'Never dump a whole new week. Code — not you — clamps sets, loads, and tracking types. Sessions cannot be deleted; drop work by removing exercises.',
  'Use timing=next_week when sessions this week have already been logged and should stay as written.',
].join(' ')

export function createZeroedServer(): McpServer {
  const server = new McpServer({
    name: 'zeroed',
    version: '0.1.0',
    instructions: SERVER_INSTRUCTIONS,
  })

  server.tool(
    'get_training_brief',
    'Compact briefing: who the athlete is, open insights, the live week, and the last few logged sessions. Call this first.',
    {},
    async () => safe(async () => {
      const store = await connectStore()
      const [athlete, insights, live, workouts] = await Promise.all([
        loadAthlete(store),
        loadInsights(store),
        loadLiveProgram(store),
        loadWorkouts(store, { limit: 5 }),
      ])
      const week = live
        ? [
            `## Live program — ${live.phaseName} (${live.weekStart} → ${live.weekEnd})`,
            live.goal ? `Goal: ${live.goal}` : null,
            live.nonNegotiables.length ? `Non-negotiables: ${live.nonNegotiables.join('; ')}` : null,
            live.scheduledPhase
              ? formatQueuedBlock(live.scheduledPhase, live.scheduledSessions)
              : null,
            '',
            formatDraft(liveToDraft(live)),
          ].filter((l) => l !== null).join('\n')
        : '## Live program\nNo active program.'
      const recent = workouts.length
        ? workouts.map((w) => formatLoggedWorkout(w, store.env.unit)).join('\n\n')
        : 'None logged.'
      return [
        await pingStore(),
        '',
        renderAthlete(athlete),
        '',
        '## Open insights',
        renderInsights(insights),
        '',
        week,
        '',
        '## Recent sessions',
        recent,
      ].join('\n')
    }),
  )

  server.tool(
    'get_athlete',
    'Athlete profile: target, obstacle, training age, standing preferences, current phase.',
    {},
    async () => safe(async () => {
      const store = await connectStore()
      return renderAthlete(await loadAthlete(store))
    }),
  )

  server.tool(
    'get_insights',
    'Current weak-link map (insights). Include settled claims when you need the already-answered questions.',
    { include_settled: z.boolean().optional().describe('Include resolved/disproved insights') },
    async ({ include_settled }) => safe(async () => {
      const store = await connectStore()
      return renderInsights(await loadInsights(store, Boolean(include_settled)))
    }),
  )

  server.tool(
    'get_current_program',
    'The live training week: sessions, exercises, dose, cues, and any block already queued for Monday.',
    {},
    async () => safe(async () => {
      const store = await connectStore()
      const live = await loadLiveProgram(store)
      if (!live) return 'No active program or phase.'
      const draft = liveToDraft(live)
      return [
        `# ${live.phaseName} · ${live.weekStart} → ${live.weekEnd}`,
        live.goal ? `Goal: ${live.goal}` : null,
        live.nonNegotiables.length ? `Non-negotiables:\n${live.nonNegotiables.map((n) => `- ${n}`).join('\n')}` : null,
        live.advancementCriteria.length ? `Advances when:\n${live.advancementCriteria.map((n) => `- ${n}`).join('\n')}` : null,
        live.scheduledPhase ? formatQueuedBlock(live.scheduledPhase, live.scheduledSessions) : null,
        live.standingPreferences ? `\nStanding preferences:\n${live.standingPreferences}` : null,
        '',
        formatDraft(draft),
        '',
        jsonBlock({
          programId: live.programId,
          phaseId: live.phaseId,
          sessions: live.sessions.map((s) => ({
            routineId: s.routineId,
            name: s.name,
            intendedDow: s.intendedDow,
            exercises: s.exercises.map((e) => e.name),
          })),
          queued: live.scheduledPhase
            ? {
                name: live.scheduledPhase.name,
                weekStart: live.scheduledPhase.weekStart,
                sessions: live.scheduledSessions.map((s) => ({
                  routineId: s.routineId,
                  name: s.name,
                  intendedDow: s.intendedDow,
                  exercises: s.exercises.map((e) => e.name),
                })),
              }
            : null,
        }),
      ].filter((l) => l !== null).join('\n')
    }),
  )

  server.tool(
    'list_workouts',
    'Logged sessions, newest first. Filter by date or exercise name. Covers every program, not just the active block.',
    {
      limit: z.number().int().min(1).max(120).optional(),
      since: z.string().optional().describe('ISO date or timestamp, inclusive'),
      until: z.string().optional().describe('ISO date or timestamp, inclusive'),
      exercise: z.string().optional().describe('Substring match on a logged lift name'),
    },
    async ({ limit, since, until, exercise }) => safe(async () => {
      const store = await connectStore()
      const rows = await loadWorkouts(store, { limit, since, until, exercise })
      if (!rows.length) return 'No workouts matched.'
      return rows.map((w) => formatLoggedWorkout(w, store.env.unit)).join('\n\n')
    }),
  )

  server.tool(
    'get_workout',
    'One logged session in full, including session observations from the debrief.',
    { workout_id: z.string().describe('Workout UUID from list_workouts') },
    async ({ workout_id }) => safe(async () => {
      const store = await connectStore()
      const row = await loadWorkout(store, workout_id)
      if (!row) return `No workout ${workout_id} on this athlete.`
      const obs = row.observations.length
        ? ['', '## Observations', ...row.observations.map((o) => `- [${o.severity}] ${o.category}: ${o.signal}`)]
        : []
      return [formatLoggedWorkout(row.workout, store.env.unit), ...obs].join('\n')
    }),
  )

  server.tool(
    'search_lifts',
    'Per-lift history: every matched top set, best load, and Epley e1RM trend.',
    { exercise: z.string().describe('Lift name or substring, e.g. "squat" or "bench"') },
    async ({ exercise }) => safe(async () => {
      const store = await connectStore()
      return renderLift(await loadLiftHistory(store, exercise), store.env.unit)
    }),
  )

  server.tool(
    'get_program_journey',
    'Blocks already run and every recorded reprogramming event (what was asked for, what moved).',
    {},
    async () => safe(async () => {
      const store = await connectStore()
      return renderJourney(await loadJourney(store))
    }),
  )

  server.tool(
    'get_coach_notes',
    'Weekly review notes and the coach log (phase changes, chats, retests).',
    { limit: z.number().int().min(1).max(40).optional() },
    async ({ limit }) => safe(async () => {
      const store = await connectStore()
      return renderNotes(await loadNotes(store, limit ?? 12))
    }),
  )

  server.tool(
    'preview_program_edits',
    'Apply surgical edits in memory against the live week and return the deterministic diff. Writes nothing. Always preview before apply_program_edits.',
    { edits: z.array(editObject).min(1) },
    async ({ edits }) => safe(async () => {
      const store = await connectStore()
      const live = await loadLiveProgram(store)
      if (!live) return 'No active program/phase to edit.'
      return previewEdits(live, edits as EditInput[]).text
    }),
  )

  server.prompt(
    'coach',
    'Open a coaching session against the live Zeroed log and current program.',
    async () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Call get_training_brief first. Then help me review my training from the record — lifts, sessions, insights, and the live week. Do not change the program unless I ask. If I ask to change it, preview_program_edits first and wait for my confirm before apply_program_edits.',
        },
      }],
    }),
  )

  server.tool(
    'apply_program_edits',
    'Write previewed surgical edits to the live program. Requires confirm=true. Uses the same in-place / next-Monday path as the in-app editor.',
    {
      edits: z.array(editObject).min(1),
      confirm: z.boolean().describe('Must be true. Refuses otherwise.'),
      timing: z.enum(['now', 'next_week']).optional().describe('now (default) rewrites the live week; next_week queues Monday and leaves this week alone.'),
      request: z.string().optional().describe('The athlete\'s own words — stored as a standing preference so the next block does not drop it.'),
    },
    async ({ edits, confirm, timing, request }) => safe(async () => {
      if (!confirm) {
        return 'Refused: apply_program_edits requires confirm=true. Call preview_program_edits first, then apply with confirm=true.'
      }
      const store = await connectStore()
      return applyEdits(store, edits as EditInput[], {
        confirm,
        timing: timing ?? 'now',
        request,
      })
    }),
  )

  return server
}
