import type { McpTool } from './mcpProtocol.ts'
import { applyEdits, liveToDraft, previewEdits, type EditInput } from './zeroedEdits.ts'
import { formatDraft, formatLoggedWorkout, formatQueuedBlock, jsonBlock } from './zeroedFormat.ts'
import {
  loadAthlete,
  loadInsights,
  loadJourney,
  loadLiftHistory,
  loadLiveProgram,
  loadNotes,
  loadWorkout,
  loadWorkouts,
  makeStore,
  renderAthlete,
  renderInsights,
  renderJourney,
  renderLift,
  renderNotes,
  type ConnectedStore,
} from './zeroedStore.ts'
import { admin } from './admin.ts'

const editExerciseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Exercise name' },
    sets: { type: 'integer', minimum: 1, maximum: 10 },
    reps: { type: 'string', description: 'Rep spec, e.g. "5", "8-10", "30s"' },
    load: { type: 'string', description: 'bodyweight | light | moderate | heavy' },
    cue: { type: 'string' },
    target_rpe: { type: ['number', 'null'], minimum: 1, maximum: 10 },
  },
  required: ['name'],
}

const editObjectSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'add_exercise', 'update_exercise', 'remove_exercise',
        'add_session', 'update_session', 'set_sessions_per_week', 'add_note',
      ],
      description: 'Surgical edit kind. Never rewrite a whole week — send only the deltas.',
    },
    rationale: { type: 'string' },
    session_name: { type: ['string', 'null'], description: 'Existing session to change (fuzzy match).' },
    exercise_name: { type: ['string', 'null'] },
    after_exercise: { type: ['string', 'null'], description: 'For add_exercise, insert after this lift.' },
    set_name: { type: ['string', 'null'], description: 'New session name (update_session / add_session).' },
    set_intent: { type: ['string', 'null'] },
    set_session_type: { type: ['string', 'null'], description: 'strength | power | conditioning | mobility' },
    set_intended_dow: { type: ['integer', 'null'], minimum: 0, maximum: 6, description: '0=Mon … 6=Sun' },
    sets: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
    reps: { type: ['string', 'null'] },
    load: { type: ['string', 'null'] },
    cue: { type: ['string', 'null'] },
    target_rpe: { type: ['number', 'null'], minimum: 1, maximum: 10 },
    sessions_per_week: { type: ['integer', 'null'], minimum: 1, maximum: 7 },
    note: { type: ['string', 'null'] },
    exercises: { type: 'array', items: editExerciseSchema, description: 'Required for add_session.' },
  },
  required: ['type'],
}

export const ZEROED_TOOLS: McpTool[] = [
  {
    name: 'get_training_brief',
    description: 'Compact briefing: who the athlete is, open insights, the live week, and the last few logged sessions. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_athlete',
    description: 'Athlete profile: target, obstacle, training age, standing preferences, current phase.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_insights',
    description: 'Current weak-link map (insights). Include settled claims when you need the already-answered questions.',
    inputSchema: {
      type: 'object',
      properties: {
        include_settled: { type: 'boolean', description: 'Include resolved/disproved insights' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_program',
    description: 'The live training week: sessions, exercises, dose, cues, and any block already queued for Monday.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workouts',
    description: 'Logged sessions, newest first. Filter by date or exercise name. Covers every program, not just the active block.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 120 },
        since: { type: 'string', description: 'ISO date or timestamp, inclusive' },
        until: { type: 'string', description: 'ISO date or timestamp, inclusive' },
        exercise: { type: 'string', description: 'Substring match on a logged lift name' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_workout',
    description: 'One logged session in full, including session observations from the debrief.',
    inputSchema: {
      type: 'object',
      properties: {
        workout_id: { type: 'string', description: 'Workout UUID from list_workouts' },
      },
      required: ['workout_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_lifts',
    description: 'Per-lift history: every matched top set, best load, and Epley e1RM trend.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'Lift name or substring, e.g. "squat" or "bench"' },
      },
      required: ['exercise'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_program_journey',
    description: 'Blocks already run and every recorded reprogramming event (what was asked for, what moved).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_coach_notes',
    description: 'Weekly review notes and the coach log (phase changes, chats, retests).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_program_edits',
    description: 'Apply surgical edits in memory against the live week and return the deterministic diff. Writes nothing. Always preview before apply_program_edits.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: { type: 'array', items: editObjectSchema, minItems: 1 },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_program_edits',
    description: 'Write previewed surgical edits to the live program. Requires confirm=true. Uses the same in-place / next-Monday path as the in-app editor.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: { type: 'array', items: editObjectSchema, minItems: 1 },
        confirm: { type: 'boolean', description: 'Must be true. Refuses otherwise.' },
        timing: {
          type: 'string',
          enum: ['now', 'next_week'],
          description: 'now (default) rewrites the live week; next_week queues Monday and leaves this week alone.',
        },
        request: {
          type: 'string',
          description: "The athlete's own words — stored as a standing preference so the next block does not drop it.",
        },
      },
      required: ['edits', 'confirm'],
      additionalProperties: false,
    },
  },
]

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
}

export function storeForAthlete(athleteId: string): ConnectedStore {
  return makeStore(admin, athleteId, 'lb')
}

export async function executeZeroedTool(
  athleteId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const store = storeForAthlete(athleteId)

  switch (name) {
    case 'get_training_brief': {
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
        ? workouts.map((w) => formatLoggedWorkout(w, store.unit)).join('\n\n')
        : 'None logged.'
      return [
        `Connected (remote MCP) as ${athlete.name ?? athleteId}`,
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
    }
    case 'get_athlete':
      return renderAthlete(await loadAthlete(store))
    case 'get_insights':
      return renderInsights(await loadInsights(store, Boolean(asBool(args.include_settled))))
    case 'get_current_program': {
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
    }
    case 'list_workouts': {
      const rows = await loadWorkouts(store, {
        limit: asInt(args.limit),
        since: asString(args.since),
        until: asString(args.until),
        exercise: asString(args.exercise),
      })
      if (!rows.length) return 'No workouts matched.'
      return rows.map((w) => formatLoggedWorkout(w, store.unit)).join('\n\n')
    }
    case 'get_workout': {
      const workoutId = asString(args.workout_id)
      if (!workoutId) throw new Error('workout_id is required')
      const row = await loadWorkout(store, workoutId)
      if (!row) return `No workout ${workoutId} on this athlete.`
      const obs = row.observations.length
        ? ['', '## Observations', ...row.observations.map((o) => `- [${o.severity}] ${o.category}: ${o.signal}`)]
        : []
      return [formatLoggedWorkout(row.workout, store.unit), ...obs].join('\n')
    }
    case 'search_lifts': {
      const exercise = asString(args.exercise)
      if (!exercise) throw new Error('exercise is required')
      return renderLift(await loadLiftHistory(store, exercise), store.unit)
    }
    case 'get_program_journey':
      return renderJourney(await loadJourney(store))
    case 'get_coach_notes':
      return renderNotes(await loadNotes(store, asInt(args.limit) ?? 12))
    case 'preview_program_edits': {
      const edits = args.edits
      if (!Array.isArray(edits) || !edits.length) throw new Error('edits is required')
      const live = await loadLiveProgram(store)
      if (!live) return 'No active program/phase to edit.'
      return previewEdits(live, edits as EditInput[]).text
    }
    case 'apply_program_edits': {
      if (args.confirm !== true) {
        return 'Refused: apply_program_edits requires confirm=true. Call preview_program_edits first, then apply with confirm=true.'
      }
      const edits = args.edits
      if (!Array.isArray(edits) || !edits.length) throw new Error('edits is required')
      const timing = args.timing === 'next_week' ? 'next_week' : 'now'
      return applyEdits(store, edits as EditInput[], {
        confirm: true,
        timing,
        request: asString(args.request),
      })
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
