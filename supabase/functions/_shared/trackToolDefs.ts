import type { McpTool } from './mcpProtocol.ts'

const confirm = { type: 'boolean', description: 'true writes; anything else returns a preview {diff, warnings, preview_id}' }
const clientKey = { type: 'string', description: 'Idempotency key. The same key never creates a second row.' }
const rationale = { type: 'string', description: 'Why this write — stored on the preview and the row.' }

export const TRACK_TOOLS: McpTool[] = [
  {
    name: 'list_tracks',
    description: 'Named qualities inside the current (or given) program: color, engine, exercise count, and which days they hit.',
    inputSchema: {
      type: 'object',
      properties: { program_id: { type: 'string', description: 'Program UUID. Defaults to the active program.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_track',
    description: 'One track: methodology, progression rules, autoreg rules, exercises, goals, deload/retest policy.',
    inputSchema: {
      type: 'object',
      properties: {
        track_id: { type: 'string' },
        track: { type: 'string', description: 'Track id or name (fuzzy).' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_track',
    description: 'Create a named track on the active program. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: { type: 'string' },
        icon: { type: 'string' },
        purpose: { type: 'string' },
        methodology_text: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        parent_track: { type: 'string' },
        deload_policy: { type: 'object' },
        retest_policy: { type: 'object' },
        confirm,
        client_key: clientKey,
        rationale,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_track',
    description: 'Patch a track. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track id or name.' },
        track_id: { type: 'string' },
        name: { type: 'string' },
        set_name: { type: 'string' },
        set_color: { type: 'string' },
        set_purpose: { type: 'string' },
        set_methodology_text: { type: 'string' },
        set_sources: { type: 'array', items: { type: 'string' } },
        set_order: { type: 'integer' },
        set_deload_policy: { type: 'object' },
        set_retest_policy: { type: 'object' },
        confirm,
        rationale,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assign_exercise_to_track',
    description: 'Stamp track_id on live-week exercises. Preview unless confirm=true. Does not change load, sets, or reps.',
    inputSchema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              session_name: { type: 'string' },
              exercise_name: { type: 'string' },
              track: { type: 'string' },
              track_id: { type: 'string' },
            },
          },
        },
        confirm,
        rationale,
      },
      required: ['assignments'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_track_progression',
    description: 'Engine params, recent history, and the proposed next-week prescription. Never writes the live week.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        track_id: { type: 'string' },
        weeks_back: { type: 'integer', minimum: 1, maximum: 16 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_track_progression_rule',
    description: 'Set or replace a progression engine on a track (optionally one exercise). Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        track_id: { type: 'string' },
        exercise_name: { type: 'string' },
        engine_type: {
          type: 'string',
          enum: ['tm_wave', 'rpe_autoreg', 'double_progression', 'maintenance', 'time_interval', 'contacts', 'measurement', 'manual'],
        },
        params: { type: 'object' },
        active_from: { type: 'string', description: 'YYYY-MM-DD' },
        confirm,
        rationale,
      },
      required: ['engine_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_autoreg_rules',
    description: 'If-then autoregulation rules for this athlete (pain, sleep, RPE, warmup).',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        scope_type: { type: 'string', enum: ['program', 'track', 'exercise'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_autoreg_rule',
    description: 'Create or update an if-then rule. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string' },
        scope_type: { type: 'string', enum: ['program', 'track', 'exercise'] },
        scope: { type: 'string', description: 'Track/exercise name or id.' },
        signal: { type: 'string' },
        op: { type: 'string', enum: ['>', '>=', '<', '<=', '==', '!='] },
        value: { type: ['number', 'string'] },
        action: { type: 'string' },
        action_params: { type: 'object' },
        message: { type: 'string' },
        confirm,
        client_key: clientKey,
        rationale,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_goals',
    description: 'Structured athlete goals with computed status (on_track / behind / hit), the display the athlete sees (zeroed / on_course / off_course / needs_test), and a forecast: where the last three real measurements land on the due date and the rate per week needed.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        status: { type: 'string', enum: ['on_track', 'behind', 'hit'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_goal_brief',
    description: 'Start here when planning. Every goal as the athlete sees it (zeroed / on_course / off_course / needs_test), its forecast (where the last three real measurements land on the due date, the rate needed, the rate trending), its lane, the source binding that lets logged sets move it, the sessions this week that train it, the last coach moves pinned to it, and proposals waiting on the athlete. Off course first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'upsert_goal',
    description: 'Create or update a structured goal. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string' },
        name: { type: 'string' },
        track: { type: 'string' },
        metric: { type: 'string' },
        unit: { type: 'string' },
        side: { type: 'string', enum: ['L', 'R', 'both', 'none'] },
        direction: { type: 'string', enum: ['higher', 'lower', 'pass'] },
        target: { type: 'number' },
        target_range_hi: { type: 'number' },
        baseline: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        test_protocol: { type: 'string' },
        cadence: { type: 'string' },
        source_metric: {
          type: 'string',
          description: 'What logged work moves this goal, as kind:Exercise. Rolling kinds (every usable session writes; current is a recency- and tier-weighted capacity): e1rm (estimated 1RM off the reps x RPE chart; sets under RPE 7 or over 10 reps do not count; an e1rm goal also moves from a related lift such as DB Bench Press for Bench Press, as an inferred reading), relative_e1rm (e1RM / session bodyweight, unit xBW; pull-ups and dips add bodyweight), reps_to_failure (reps + reps left: 8 @8 is 10), output (mean output per round, unit cal, m or W), fade (last round output / first, %), success_rate (makes / attempts, %, 10+ attempts). Best kinds (a session writes when it holds or beats current): top_set (heaviest completed set), reps, distance (best rep), time (longest hold, or fastest when direction is lower), rounds. test is manual only. Example: e1rm:Bench Press. Name the exercise as the program spells it. Zeroed needs proof: a tested or strong reading at the target; an estimate at the target shows as confirm.',
        },
        confirm,
        rationale,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'log_goal_measurement',
    description: 'Append a dated measurement. Retries with the same client_key never duplicate. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal id or name.' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        value: { type: 'number' },
        side: { type: 'string', enum: ['L', 'R', 'both', 'none'] },
        note: { type: 'string' },
        source: { type: 'string', enum: ['workout_log', 'manual', 'agent'] },
        client_key: clientKey,
        confirm,
      },
      required: ['goal', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_goal_history',
    description: 'Measurements, trend, and a projection to the due date.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        since: { type: 'string', description: 'YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_workout_note',
    description: 'Attach a note to a logged workout or a session template. Distinct from add_note on program edits (coach inbox). Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        workout_id: { type: 'string' },
        session_name: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD, with session_name when workout_id is omitted.' },
        text: { type: 'string' },
        client_key: clientKey,
        confirm,
        rationale,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_athlete_target',
    description: 'Write the legacy free-text athlete.goals field. Structured goals are upsert_goal. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, confirm, rationale },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_program_meta',
    description: 'Set block name, free-text phase, dates, deload week, retest window. Does not change phase.name. Preview unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        set_name: { type: 'string' },
        set_phase: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        deload_week_start: { type: 'string' },
        retest_start: { type: 'string' },
        retest_end: { type: 'string' },
        confirm,
        rationale,
      },
      additionalProperties: false,
    },
  },
]

export const TRACK_TOOL_NAMES = new Set(TRACK_TOOLS.map((t) => t.name))
