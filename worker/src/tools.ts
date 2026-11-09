import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { LIFT_MODEL_TOOLS, LIFT_MODEL_TOOL_NAMES, runLiftModelTool } from '../../supabase/functions/_shared/liftModelTools.ts'
import { parseLiftId, rpeHalfStepsOn } from '../../src/engine/liftModel.ts'
import { applyEditsToDraft, diffDraft } from '../../supabase/functions/_shared/engine/programDraft.ts'
import { applyEdits, liveToDraft, previewEdits, revisionPayload, toProgramEdit, type EditInput } from './edits.ts'
import { acceptProposal, appliedOk, parkProposal, programFingerprint, resolveGoalIds } from './proposals.ts'
import { formatDraft, formatLoggedWorkout, formatQueuedBlock, jsonBlock } from '../../supabase/functions/_shared/zeroedFormat.ts'
import {
  loadAthlete,
  loadInsights,
  loadJourney,
  loadLiftHistory,
  loadLiftModelSources,
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
  saveTrainingMax,
  type ConnectedStore,
} from './store.ts'
import type { Sql } from './db.ts'
import { hiddenIds, idList } from './tombstones.ts'
import { McpUserError } from './userError.ts'
import { TRACK_TOOLS } from '../../supabase/functions/_shared/trackToolDefs.ts'
import { briefTracksAndGoals, runTrackTool, TRACK_TOOL_NAMES } from './trackTools.ts'
import {
  APP_COACH, runSessionOverrideTool, SESSION_OVERRIDE_TOOLS, SESSION_OVERRIDE_TOOL_NAMES, tracksV1On,
  type OverrideActor,
} from './sessionOverride.ts'
import {
  CHANGE_LOG_TOOLS, CHANGE_LOG_TOOL_NAMES, changeLogMissing, changeLogUnavailable, makeWriteGate, phaseRoutineSnapshots,
  previewFooter, queuedSnapshot, routineDelta, runChangeLogTool, trainingMaxEntry, writeApprovalProblem, type WriteGate,
} from './changeLog.ts'
import { approvalMissing, approvalsUnavailable, APPROVAL_TOOL_NAMES, APPROVAL_TOOLS, runApprovalTool } from './approvals.ts'
import { isMcpUserError } from './userError.ts'
import type { LiveProgram } from './store.ts'
import {
  blockedRegions, e1rmFallbackFor, METHODOLOGY_TOOL_NAMES, METHODOLOGY_TOOLS, methodologyMissing, methodologyUnavailable, resolveMethodology,
  runMethodologyTool,
} from './methodology.ts'
import { forViewer, validateEdit, warningsSection, type ValidateResult } from './methodology/validators.ts'
import { actorRef } from './sessionOverride.ts'
import { READINESS_TOOL_NAMES, READINESS_TOOLS, runReadinessTool } from './readiness.ts'
import { runSessionRpeTool, SESSION_RPE_TOOL_NAMES, SESSION_RPE_TOOLS } from './sessionRpe.ts'
import { isHealthObservation, redactHealthText, seesHealth, statusBlockedRegions } from './regionStatus.ts'
import { isReadTool, logCoachRead, logsReads } from './coachReads.ts'
import { refuseByRole } from './coachRoles.ts'
import { ACTIVITY_TOOL_NAMES, ACTIVITY_TOOLS, coachSchemaMissing, coachUnavailable, coachV1On, runActivityTool } from './activities.ts'
import { skillBlocksV1On, skillEditsFor, withSkillArgs } from './skillBlocks.ts'
import {
  ONBOARDING_TOOL_NAMES,
  runOnboardingTool,
} from './onboardingTools.ts'
import { workerOnboardingIo } from './onboardingStore.ts

const editExerciseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Exercise name' },
    sets: { type: 'integer', minimum: 1, maximum: 10 },
    reps: { type: 'string', description: 'Rep spec, e.g. "5", "8-10", "30s". An interval/HIIT block goes here whole — "8 × 15s on / 45s off", "Tabata", "EMOM 10 min" — with sets 1 and the name just the movement ("Assault Bike"); the app runs it on its interval timer.' },
    load: { type: 'string', description: 'bodyweight | light | moderate | heavy' },
    cue: { type: 'string' },
    target_rpe: { type: ['number', 'null'], minimum: 1, maximum: 10 },
    track: { type: 'string', description: 'Track id or name to stamp on the exercise.' },
    track_id: { type: 'string' },
    superset_group: { type: 'string', description: 'A1 / A2 pairing.' },
    rest_s: { type: 'integer', minimum: 0, maximum: 600 },
    contacts: { type: 'integer', minimum: 0, maximum: 200 },
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
    reps: { type: ['string', 'null'], description: 'Rep spec, e.g. "5", "8-10", "30s". An interval/HIIT block goes here whole — "8 × 15s on / 45s off", "Tabata", "EMOM 10 min" — with sets 1 and the name just the movement ("Assault Bike"); the app runs it on its interval timer.' },
    load: { type: ['string', 'null'] },
    cue: { type: ['string', 'null'] },
    target_rpe: { type: ['number', 'null'], minimum: 1, maximum: 10 },
    sessions_per_week: { type: ['integer', 'null'], minimum: 1, maximum: 7 },
    note: { type: ['string', 'null'] },
    exercises: { type: 'array', items: editExerciseSchema, description: 'Required for add_session.' },
    track: { type: ['string', 'null'] },
    track_id: { type: ['string', 'null'] },
    superset_group: { type: ['string', 'null'] },
    rest_s: { type: ['integer', 'null'], minimum: 0, maximum: 600 },
    contacts: { type: ['integer', 'null'], minimum: 0, maximum: 200 },
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
        exercise: { type: 'string', description: 'A main lift matches by identity; anything else by substring' },
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
    description: 'Per-lift history: every matched top set, best load, and RPE-chart e1RM trend. A main lift (squat, bench, deadlift, ohp/press) matches by identity, not substring.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'A main lift ("squat", "bench", "deadlift", "ohp") or any name substring, e.g. "row"' },
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
    description: 'Apply surgical edits in memory against the live week and return the deterministic diff. Writes nothing to the program. Always preview before apply_program_edits. With propose=true the preview is parked as a proposal the athlete sees on the goal it serves and in Coach, and accepts on their phone; that Accept applies exactly these edits, and refuses if the program changes first. Propose when the athlete is not in this conversation to approve; apply directly when they already said yes here.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: { type: 'array', items: editObjectSchema, minItems: 1 },
        week_start: { type: 'string', description: 'YYYY-MM-DD Monday. Queued block if it matches; otherwise the live template, labeled with this week.' },
        propose: { type: 'boolean', description: 'Park this preview for the athlete to accept in the app.' },
        title: { type: 'string', description: 'With propose: one sentence the athlete reads, e.g. "Add a Friday push press. Cap set 4 at RPE 7."' },
        rationale: { type: 'string', description: 'With propose: why, in the athlete\'s terms, tied to the goal.' },
        goal_ids: { type: 'array', items: { type: 'string' }, description: 'With propose: the goals this serves, by id or name (see get_goal_brief).' },
        timing: { type: 'string', enum: ['now', 'next_week'], description: 'With propose: when the accepted change takes effect.' },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_program_edits',
    description: 'Write previewed surgical edits to the live program. Requires confirm=true. Uses the same in-place / next-Monday path as the in-app editor. Pass proposal_id instead of edits to apply a parked proposal exactly as previewed; it refuses if the program changed since.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: { type: 'array', items: editObjectSchema, minItems: 1 },
        proposal_id: { type: 'string', description: 'Apply this parked proposal instead of edits.' },
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
      required: ['confirm'],
      additionalProperties: false,
    },
  },
  ...TRACK_TOOLS,
  ...LIFT_MODEL_TOOLS,
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

export function storeForAthlete(sql: Sql, athleteId: string): ConnectedStore {
  return makeStore(sql, athleteId, 'lb')
}

/** Non-logging writes. With tracks_v1 on, confirm=true needs approval_ref + preview_id and is logged (G2). */
export const GATED_WRITE_TOOLS = new Set([
  'apply_program_edits', 'create_track', 'update_track', 'assign_exercise_to_track', 'set_track_progression_rule',
  'upsert_autoreg_rule', 'upsert_goal', 'update_athlete_target', 'update_program_meta', 'set_training_max',
])
/** Standing-approved logging writes: logged as standing:logging. */
export const LOGGING_TOOLS = new Set(['log_goal_measurement', 'add_workout_note'])

/** A write tool as tracks_v1 athletes' coaches see it: the approval arguments it now needs. */
function withApprovalArgs(tool: McpTool): McpTool {
  if (!GATED_WRITE_TOOLS.has(tool.name)) return tool
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } & Record<string, unknown>
  return {
    ...tool,
    description: `${tool.description} With confirm=true it also needs the preview_id the preview call returned (under 24 h old, diff unchanged) and approval_ref = the approval the athlete created for that preview in the app (tap:<id> or msg:<id>; list_approvals(preview_id) shows it)${tool.name === 'apply_program_edits' ? '; a proposal_id stands in for the preview' : ''}. Coaches cannot create approvals, and each one applies once. Every write is recorded in the change log.`,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        preview_id: { type: 'string', description: 'With confirm=true: the preview_id from the preview call.' },
        approval_ref: { type: 'string', description: 'With confirm=true: the athlete\'s approval of this preview, tap:<approval id> or msg:<approval id> (from list_approvals).' },
        rule_refs: { type: 'array', items: { type: 'string' }, description: 'Methodology rules this applies, e.g. ["U5"]. U# named in the rationale are picked up too.' },
      },
    },
  }
}

/** preview_program_edits as tracks_v1 athletes' coaches see it: rewrite (U13) and rule_refs. */
function withValidatorArgs(tool: McpTool): McpTool {
  if (tool.name !== 'preview_program_edits') return tool
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } & Record<string, unknown>
  return {
    ...tool,
    description: `${tool.description} The preview runs the methodology validators (U8 session order, U9 interference, U10 supersets) and lists warnings; changing more than 30% of the week's exercises fails it (U13) unless rewrite=true, and loading a red-flagged region fails it (U7).`,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        rewrite: { type: 'boolean', description: 'This edit is a deliberate rewrite of the week: lifts the U13 small-edit cap.' },
      },
    },
  }
}

/**
 * The tools this athlete's coach sees. tracks_v1 adds the week-only override,
 * change-log and approval-lookup tools, and the approval arguments on writes;
 * with it off the list is exactly ZEROED_TOOLS. coach_v1 (only with
 * tracks_v1) adds the activity and composed-block tools at the end; with it
 * off the tracks_v1 list is exactly as before.
 */
export async function zeroedToolsFor(sql: Sql, athleteId: string): Promise<McpTool[]> {
  const store = storeForAthlete(sql, athleteId)
  const list = await baseToolsFor(store)
  // skill_blocks_v1 (on its own flag): kind / window_s on the edit tools. Off, the list as above.
  return await skillBlocksV1On(store) ? list.map(withSkillArgs) : list
}

async function baseToolsFor(store: ConnectedStore): Promise<McpTool[]> {
  if (!(await tracksV1On(store))) return ZEROED_TOOLS
  const tracks = [...ZEROED_TOOLS.map(withApprovalArgs).map(withValidatorArgs), ...SESSION_OVERRIDE_TOOLS, ...CHANGE_LOG_TOOLS, ...APPROVAL_TOOLS, ...METHODOLOGY_TOOLS, ...READINESS_TOOLS, ...SESSION_RPE_TOOLS]
  return await coachV1On(store) ? [...tracks, ...ACTIVITY_TOOLS] : tracks
}

/** What preview_program_edits showed and apply_program_edits must still match: the live week and the diff. */
async function programEditState(live: LiveProgram, edits: EditInput[]) {
  const base = liveToDraft(live)
  const { draft } = applyEditsToDraft(base, edits.map(toProgramEdit))
  return { fingerprint: await programFingerprint(live), revision: revisionPayload(base.sessions, diffDraft(base, draft)) }
}

/**
 * G5 on program edits (tracks_v1): the live week before and after the edits,
 * against this athlete's methodology.
 */
async function validateProgramEdits(store: ConnectedStore, live: LiveProgram, edits: EditInput[], rewrite: boolean): Promise<ValidateResult> {
  const base = liveToDraft(live)
  const { draft } = applyEditsToDraft(base, edits.map(toProgramEdit))
  const diff = diffDraft(base, draft)
  const [methodology, statusBlocked] = await Promise.all([resolveMethodology(store), statusBlockedRegions(store)])
  const week = (sessions: typeof base.sessions) => sessions.map((x) => ({
    key: x.routineId ?? `new:${x.name.trim().toLowerCase()}`,
    name: x.name,
    dow: x.intendedDow,
    exercises: x.exercises,
  }))
  return validateEdit({
    before: week(base.sessions),
    after: week(draft.sessions),
    params: methodology.params,
    changed: diff.added + diff.removed + diff.changed,
    total: base.sessions.reduce((n, x) => n + x.exercises.length, 0),
    rewrite,
    blockedRegions: [...new Set([...blockedRegions(methodology), ...statusBlocked])].sort(),
  })
}

/** apply_program_edits(edits) with tracks_v1 on: approved, previewed, written and logged in one transaction. */
async function applyEditsLogged(store: ConnectedStore, gate: WriteGate, args: Record<string, unknown>, edits: EditInput[]): Promise<string> {
  const live = await loadLiveProgram(store)
  if (!live) return 'No active program/phase to edit.'
  const timing = args.timing === 'next_week' ? 'next_week' : 'now'
  const state = await programEditState(live, edits)
  try {
    return await gate.commit('apply_program_edits', args, state, async () => {
      const before = await phaseRoutineSnapshots(store, live.phaseId)
      const text = await applyEdits(store, edits, { confirm: true, timing, request: asString(args.request) })
      if (!appliedOk(text)) return { result: text, entry: null }
      const [athlete] = await store.sql<{ n: number }[]>`SELECT sessions_per_week AS n FROM athlete WHERE id = ${store.athleteId}`
      const spw = Number(athlete?.n ?? live.sessionsPerWeek)
      return {
        result: text,
        entry: {
          targetType: 'program',
          targetId: live.phaseId,
          diff: {
            timing,
            program_id: live.programId,
            phase_id: live.phaseId,
            revision: state.revision,
            ...routineDelta(before, await phaseRoutineSnapshots(store, live.phaseId)),
            ...(timing === 'next_week' ? { queued: await queuedSnapshot(store, live.programId, live.phaseId, live.weekEnd) } : {}),
            ...(spw !== live.sessionsPerWeek ? { sessions_per_week: { before: live.sessionsPerWeek, after: spw } } : {}),
          },
          rationale: edits.map((e) => e.rationale).filter((r): r is string => typeof r === 'string' && r.trim() !== '').join(' ') || null,
        },
      }
    })
  } catch (e) {
    if (isMcpUserError(e)) return e.message
    throw e
  }
}

/** set_training_max with tracks_v1 on: the prior value is kept so the athlete can undo it. */
async function trainingMaxLogged(
  store: ConnectedStore,
  gate: WriteGate,
  args: Record<string, unknown>,
  rpeHalfSteps: boolean,
): Promise<string> {
  const run = (save = (lift: Parameters<typeof saveTrainingMax>[1], entry: Parameters<typeof saveTrainingMax>[2]) => saveTrainingMax(store, lift, entry)) =>
    runLiftModelTool('set_training_max', args, { load: () => loadLiftModelSources(store), saveTrainingMax: save, rpeHalfSteps })
  const lift = parseLiftId(typeof args.lift === 'string' ? args.lift : null)
  if (!lift) return run()
  const state = { lift, training_max: args.training_max ?? null, before: await trainingMaxEntry(store, lift) }
  if (args.confirm !== true) {
    const text = await run()
    return `${text}

${previewFooter(await gate.preview('set_training_max', state, null))}`
  }
  try {
    return await gate.commit('set_training_max', args, state, async () => {
      let after: unknown
      let saved = false
      const text = await run(async (l, entry) => {
        const out = await saveTrainingMax(store, l, entry)
        after = out[l] ?? null
        saved = true
        return out
      })
      return { result: text, entry: saved ? { targetType: 'training_max', targetId: lift, diff: { lift, before: state.before, after } } : null }
    })
  } catch (e) {
    if (isMcpUserError(e)) return e.message
    throw e
  }
}

/** tracks_v1 on and this actor doesn't see health data (D3). Flag off: false, so nothing changes. */
async function hidesHealth(store: ConnectedStore, actor: OverrideActor): Promise<boolean> {
  return await tracksV1On(store) && !(await seesHealth(store, actor))
}

export async function executeZeroedTool(
  sql: Sql,
  athleteId: string,
  name: string,
  args: Record<string, unknown>,
  flags?: { rpeHalfSteps?: boolean; onboardingAgentV1?: boolean },
  // Who is calling. A caller that doesn't say gets app_coach's powers: it can
  // preview and propose, never approve.
  actor: OverrideActor = APP_COACH,
): Promise<string> {
  try {
    return await runZeroedTool(sql, athleteId, name, args, flags, actor)
  } catch (e) {
    // tracks_v1 on before worker/schema/change-log.sql: the write rolled back.
    if (changeLogMissing(e)) throw new McpUserError(changeLogUnavailable)
    // …or before worker/schema/approval.sql (G10).
    if (approvalMissing(e)) throw new McpUserError(approvalsUnavailable)
    // …or before worker/schema/methodology.sql (G3).
    if (methodologyMissing(e)) throw new McpUserError(methodologyUnavailable)
    // …or before worker/schema/coach-v1.sql (G6/G7).
    if (coachSchemaMissing(e)) throw new McpUserError(coachUnavailable)
    throw e
  }
}

async function runZeroedTool(
  sql: Sql,
  athleteId: string,
  name: string,
  args: Record<string, unknown>,
  flags: { rpeHalfSteps?: boolean; onboardingAgentV1?: boolean } | undefined,
  actor: OverrideActor,
): Promise<string> {
  const store = storeForAthlete(sql, athleteId)

  // D3 roles: a read-only coach's previews, applies and writes are refused
  // (and logged) before anything runs. Propose coaches, app_coach and the
  // athlete go on as before; every existing token is 'propose'.
  const refused = await refuseByRole(store, actor, name)
  if (refused) return refused


  if (ONBOARDING_TOOL_NAMES.has(name)) {
    if (!flags?.onboardingAgentV1) throw new McpUserError(`Unknown tool: ${name}`)
    return runOnboardingTool(name, args, workerOnboardingIo(sql, athleteId))
  }

  // Section 8 / D3, tracks_v1: every coach read is logged before it runs.
  // The athlete's own reads are not. Flag off: nothing is written.
  if (isReadTool(name) && logsReads(actor) && await tracksV1On(store)) {
    await logCoachRead(store, actor, name, args)
  }

  if (READINESS_TOOL_NAMES.has(name)) return runReadinessTool(store, name, args, actor)

  if (SESSION_RPE_TOOL_NAMES.has(name)) return runSessionRpeTool(store, name, args, actor)

  if (SESSION_OVERRIDE_TOOL_NAMES.has(name)) {
    return runSessionOverrideTool(store, name, args, actor, (refs) => resolveGoalIds(store, refs))
  }

  if (CHANGE_LOG_TOOL_NAMES.has(name)) return runChangeLogTool(store, name, args, actor)

  if (APPROVAL_TOOL_NAMES.has(name)) return runApprovalTool(store, name, args)

  if (METHODOLOGY_TOOL_NAMES.has(name)) return runMethodologyTool(store, name, args, actor)

  // G6 (coach_v1 + tracks_v1): unknown tools otherwise.
  if (ACTIVITY_TOOL_NAMES.has(name)) return runActivityTool(store, name, args, actor)

  // G2: with tracks_v1 on, writes go through the gate (approval, preview, change_log).
  // Off, gate stays undefined and every path below is exactly as before.
  const writes = GATED_WRITE_TOOLS.has(name) || LOGGING_TOOLS.has(name) || name === 'preview_program_edits'
  const gate = writes && await tracksV1On(store) ? makeWriteGate(store, actor) : undefined

  if (name === 'set_training_max' && gate) {
    return trainingMaxLogged(store, gate, args, flags?.rpeHalfSteps ?? rpeHalfStepsOn())  }

  if (LIFT_MODEL_TOOL_NAMES.has(name)) {
    const out = await runLiftModelTool(name, args, {
      // U4 (tracks_v1): RPE-less sets as the methodology reads them, each estimate's method shown.
      load: async () => {
        const [src, noRpe] = await Promise.all([loadLiftModelSources(store), e1rmFallbackFor(store)])
        return noRpe ? { ...src, params: { ...src.params, e1rmNoRpe: noRpe } } : src
      },
      saveTrainingMax: (lift, entry) => saveTrainingMax(store, lift, entry),
      rpeHalfSteps: flags?.rpeHalfSteps ?? rpeHalfStepsOn(),
    })
    // D3 (tracks_v1): the model's knee-pain, sleep and readiness readings are
    // health data; a coach the athlete hasn't shared it with sees the numbers it
    // moved, not the inputs.
    return await hidesHealth(store, actor) ? redactHealthText(out) : out
  }

  if (TRACK_TOOL_NAMES.has(name)) {
    const live = name === 'get_track_progression' ? await loadLiveProgram(store) : null
    const out = await runTrackTool(store, name, args, live, gate)
    if (out == null) throw new McpUserError(`Unknown tool: ${name}`)
    return out
  }

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
      const extras = await briefTracksAndGoals(store, live)
      return [
        `Connected (remote MCP) as ${athlete.name ?? athleteId}`,
        '',
        renderAthlete(athlete),
        '',
        '## Open insights',
        renderInsights(insights),
        '',
        week,
        extras,
        '',
        '## Recent sessions',
        recent,
      ].filter((l) => l !== '').join('\n')
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
      if (!workoutId) throw new McpUserError('workout_id is required')
      const row = await loadWorkout(store, workoutId)
      if (!row) return `No workout ${workoutId} on this athlete.`
      // D3 (tracks_v1): pain observations are health data.
      const hidden = await hidesHealth(store, actor)
      const shown = hidden ? row.observations.filter((o) => !isHealthObservation(o.category)) : row.observations
      const held = row.observations.length - shown.length
      const obs = row.observations.length
        ? ['', '## Observations', ...shown.map((o) => `- [${o.severity}] ${o.category}: ${o.signal}`),
          ...(held ? [`- ${held} health observation${held === 1 ? '' : 's'} the athlete hasn't shared with you`] : [])]
        : []
      const notes = await store.sql<{ author: string; body: string }[]>`
        SELECT author, body FROM workout_note
        WHERE athlete_id = ${store.athleteId} AND workout_id = ${workoutId}
          AND NOT (id::text = ANY(${idList(await hiddenIds(store, 'workout_note'))}::text[]))
        ORDER BY created_at
      `
      const noteLines = notes.length
        ? ['', '## Workout notes', ...notes.map((n) => `- ${n.author}: ${n.body}`)]
        : []
      return [formatLoggedWorkout(row.workout, store.unit), ...obs, ...noteLines].join('\n')
    }
    case 'search_lifts': {
      const exercise = asString(args.exercise)
      if (!exercise) throw new McpUserError('exercise is required')
      return renderLift(await loadLiftHistory(store, exercise, { noRpe: await e1rmFallbackFor(store) }), store.unit)
    }
    case 'get_program_journey':
      return renderJourney(await loadJourney(store))
    case 'get_coach_notes':
      return renderNotes(await loadNotes(store, asInt(args.limit) ?? 12))
    case 'preview_program_edits': {
      if (!Array.isArray(args.edits) || !args.edits.length) throw new McpUserError('edits is required')
      // skill_blocks_v1 off: kind / window_s dropped, as unknown keys always were.
      const edits = skillEditsFor(args.edits, await skillBlocksV1On(store))
      const live = await loadLiveProgram(store)
      if (!live) return 'No active program/phase to edit.'
      const preview = previewEdits(live, edits as EditInput[], asString(args.week_start))
      // G5 (tracks_v1 only): warnings in the preview; U13 and red flags refuse it.
      // D3: a coach without health access sees a held region only generically.
      const checked = gate
        ? forViewer(await validateProgramEdits(store, live, edits as EditInput[], args.rewrite === true), await seesHealth(store, actor))
        : null
      const warned = checked?.warnings.length ? `${preview.text}\n\n${warningsSection(checked.warnings)}` : preview.text
      if (checked?.blocked) {
        return `Refused (${checked.blocked.rule}): ${checked.blocked.message} Nothing was kept or parked.\n\n${warned}`
      }
      if (args.propose !== true) {
        if (!gate) return preview.text
        const id = await gate.preview('apply_program_edits', await programEditState(live, edits as EditInput[]), null)
        return `${warned}\n\n${previewFooter(id)}`
      }
      const title = asString(args.title)
      if (!title) throw new McpUserError('title is required with propose=true: one sentence the athlete reads')
      const parked = await parkProposal(store, live, edits as EditInput[], {
        title,
        rationale: asString(args.rationale) ?? null,
        goalIds: await resolveGoalIds(store, args.goal_ids),
        timing: args.timing === 'next_week' ? 'next_week' : 'now',
        request: null,
        ...(gate ? { createdBy: actorRef(actor), warnings: checked?.warnings ?? [] } : {}),
      })
      if (!parked.ok) {
        return `${warned}\n\n${parked.reason === 'unavailable'
          ? 'Not parked: proposals are not set up on this database yet. Ask the athlete here and apply with confirm=true.'
          : 'Not parked: these edits change nothing in the live week.'}`
      }
      return `${warned}\n\n## Proposed\n${parked.reused ? 'Already parked' : 'Parked'} for the athlete as proposal ${parked.id} (preview ${parked.previewId}). They see it in the app and accept it there; apply_program_edits with proposal_id does the same once they say yes here.`
    }
    case 'apply_program_edits': {
      if (args.confirm !== true) {
        return 'Refused: apply_program_edits requires confirm=true. Call preview_program_edits first, then apply with confirm=true.'
      }
      const proposalId = asString(args.proposal_id)
      if (proposalId) {
        if (!gate) return (await acceptProposal(store, proposalId)).text
        // The proposal is the preview (fingerprint + 24 h); the coach still
        // needs the athlete's yes from the chat.
        const problem = writeApprovalProblem(actor, args.approval_ref)
        if (problem) return problem
        return (await acceptProposal(store, proposalId, { approvalRef: String(args.approval_ref).trim(), actor })).text
      }
      if (!Array.isArray(args.edits) || !args.edits.length) throw new McpUserError('edits or proposal_id is required')
      const edits = skillEditsFor(args.edits, await skillBlocksV1On(store))
      if (gate) return applyEditsLogged(store, gate, args, edits as EditInput[])
      const timing = args.timing === 'next_week' ? 'next_week' : 'now'
      return applyEdits(store, edits as EditInput[], {
        confirm: true,
        timing,
        request: asString(args.request),
      })
    }
    default:
      throw new McpUserError(`Unknown tool: ${name}`)
  }
}
