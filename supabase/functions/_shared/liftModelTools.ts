// get_lift_model + set_training_max for the two remote MCPs (the Supabase edge
// function and the Worker). Schemas, argument reading and the text returned live
// here once; each server only supplies how it reads the log and writes a TM.
// The local stdio server (mcp/src/server.ts) registers the same two tools with zod.

import type { McpTool } from './mcpProtocol.ts'
import {
  MAIN_LIFTS, modelFromSources, parseLiftId, previewTrainingMax, renderLiftModel,
  type DayOf, type LiftModelSources, type MainLiftId,
} from './engine/liftModel.ts'

export const LIFT_MODEL_TOOLS: McpTool[] = [
  {
    name: 'get_lift_model',
    description: 'One main lift\'s model from the whole log: working max (RPE-chart e1RM, qualifying sets, last 6 weeks, recency-weighted), training max, 4/8-week trend, all-time best, last qualifying sets, and this week\'s prescription with its reason line. lift: squat | bench | deadlift | ohp, or "all".',
    inputSchema: {
      type: 'object',
      properties: {
        lift: { type: 'string', description: 'squat | bench | deadlift | ohp | all' },
        sleep_hours: { type: 'number', minimum: 0, maximum: 24, description: 'Last night\'s sleep, if the athlete said' },
        readiness: { type: 'number', minimum: 1, maximum: 10, description: 'Readiness 1–10 today, if the athlete said' },
        knee_pain_l: { type: 'number', minimum: 0, maximum: 10 },
        knee_pain_r: { type: 'number', minimum: 0, maximum: 10 },
        test_day: { type: 'boolean', description: 'Lift the all-time-best ceiling for a planned max test' },
        deload: { type: 'boolean', description: 'Treat this as a deload week (65% TM, RPE ≤ 6)' },
      },
      required: ['lift'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_training_max',
    description: 'Set (or clear, with training_max null) one lift\'s hand-set training max. Without confirm=true it only previews what this week\'s number becomes.',
    inputSchema: {
      type: 'object',
      properties: {
        lift: { type: 'string', description: 'squat | bench | deadlift | ohp' },
        training_max: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'The TM in the athlete\'s unit, or null to go back to 90% of the working max' },
        confirm: { type: 'boolean', description: 'true writes it; anything else previews' },
      },
      required: ['lift', 'training_max'],
      additionalProperties: false,
    },
  },
]

export const LIFT_MODEL_TOOL_NAMES = new Set(LIFT_MODEL_TOOLS.map((t) => t.name))

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The lift(s) a get_lift_model call names, or null when it names none. */
export function liftsArg(v: unknown): MainLiftId[] | null {
  const raw = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!raw) return null
  if (raw === 'all') return [...MAIN_LIFTS]
  const id = parseLiftId(raw)
  return id ? [id] : null
}

/** Today's check-in from tool args, or null when the athlete told us nothing. */
export function dayOfArgs(args: Record<string, unknown>): DayOf | null {
  const d = {
    sleepHours: asNum(args.sleep_hours),
    readiness: asNum(args.readiness),
    kneePainL: asNum(args.knee_pain_l),
    kneePainR: asNum(args.knee_pain_r),
  }
  return Object.values(d).some((v) => v != null) ? d : null
}

export async function runLiftModelTool(
  name: string,
  args: Record<string, unknown>,
  io: {
    load: () => Promise<LiftModelSources>
    saveTrainingMax: (lift: MainLiftId, value: number | null) => Promise<unknown>
  },
): Promise<string> {
  if (name === 'get_lift_model') {
    const lifts = liftsArg(args.lift)
    if (!lifts) return `"${String(args.lift ?? '')}" is not a main lift. Use squat, bench, deadlift, ohp, or all.`
    const src = await io.load()
    const opts = {
      dayOf: dayOfArgs(args),
      testDay: typeof args.test_day === 'boolean' ? args.test_day : undefined,
      deload: typeof args.deload === 'boolean' ? args.deload : undefined,
    }
    return lifts.map((l) => renderLiftModel(modelFromSources(l, { ...src, ...opts }))).join('\n\n---\n\n')
  }
  if (name === 'set_training_max') {
    const id = parseLiftId(typeof args.lift === 'string' ? args.lift : null)
    if (!id) return `"${String(args.lift ?? '')}" is not a main lift. Use squat, bench, deadlift or ohp.`
    if (args.training_max !== null && asNum(args.training_max) == null) {
      throw new Error('training_max is required: a number, or null to clear it')
    }
    const value = args.training_max === null ? null : asNum(args.training_max)
    if (value != null && value <= 0) throw new Error('training_max must be positive, or null to clear it')
    const src = await io.load()
    const preview = previewTrainingMax(id, value, src)
    if (args.confirm !== true) return `${preview}\n\nPreview only — call again with confirm=true to save it.`
    await io.saveTrainingMax(id, value)
    return `${preview}\n\nSaved.`
  }
  throw new Error(`Unknown tool: ${name}`)
}
