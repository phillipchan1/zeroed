/**
 * The app coach (G7, coach_v1; spec sections 5, 7, 8, D4): a server-side
 * actor, app_coach, that works ONLY through the same MCP tool functions
 * (executeZeroedTool) and the same change_log path as an outside coach. No
 * extra powers:
 *
 *   - it calls read tools (logged as coach reads, phase 5), preview_* tools
 *     and the logging tools, and only tools this athlete's coaches can see;
 *   - it never passes approval_ref and never sends confirm=true on anything
 *     but logging (refused here, and again by the G10 gate underneath);
 *   - it never creates an approval: the athlete does, with a tap or with
 *     their own chat message (msg:<id>), and the athlete's session applies.
 *
 * Chat lives in coach_message (role athlete | coach, kind 'chat'). Only the
 * athlete's own request writes role 'athlete'; the app coach writes 'coach'.
 * A chat approval needs the athlete's message, newer than the preview, saying
 * yes to it; the apply consumes the approval once (approvals.ts).
 *
 * Intake (section 5) runs here too: answers → red flag stop (section 8
 * refer-out, pain logged so the region blocks) or one composed-block preview
 * by the app coach → the athlete approves → apply.
 *
 * POST /api/coach, the athlete's own session; 404 unless coach_v1 (with
 * tracks_v1) is on:
 *   { action: 'state' }                              activities, block, chat
 *   { action: 'intake', answers }                    stopped | preview
 *   { action: 'repreview', preview_id, resolutions } the athlete's trade-off picks
 *   { action: 'approve', preview_id }                tap approve (+ apply when the app can)
 *   { action: 'chat', message, approves? }           one app-coach turn, or a chat yes
 */
import { beginAuthCors, json } from './cors.ts'
import { asJson, jsonParam, withSql, type Sql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { callOpenAISpec } from './agent.ts'
import { ApprovalSpent, consumeApproval, createApproval, directTapApproval } from './approvals.ts'
import { withTx, writeChange } from './changeLog.ts'
import { acceptProposal } from './proposals.ts'
import { resolveMethodology } from './methodology.ts'
import { saveCheckin } from './readiness.ts'
import { REFER_OUT, RED_FLAGS } from './readiness/rules.ts'
import { PAIN_REGIONS } from './methodology/v1.ts'
import { moduleCatalog } from './coach/modules.ts'
import { statusBlockedRegions } from './regionStatus.ts'
import { APP_COACH, athleteToday, type OverrideActor } from './sessionOverride.ts'
import { makeStore, type ConnectedStore } from './store.ts'
import { executeZeroedTool, LOGGING_TOOLS, zeroedToolsFor } from './tools.ts'
import { isMcpUserError, McpUserError } from './userError.ts'
import {
  athleteApplyPreview, BLOCK_TOOL, blockSummary, coachTables, coachUnavailable, coachV1On, currentBlock, lastIntake,
  loadActivities, previewBlockState, programView, recomposeDue, type BlockRequest,
} from './activities.ts'
import { parseIntake, type ParsedIntake } from './coach/intake.ts'
import {
  APP_COACH_SCHEMA, appCoachSystemPrompt, ESCALATE_REASONS, ESCALATION_TEXT, guardReply,
  type AppCoachModelTurn, type EscalateReason,
} from './coach/prompt.ts'
import { addDaysIso } from './coach/composer.ts'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ROUNDS = 3
const MAX_CALLS = 4
const OUTPUT_CLIP = 4000

/** The model, injectable so checks drive the app coach without a network. */
export type AppCoachModel = (input: { system: string; payload: unknown }) => Promise<AppCoachModelTurn | null>

export function openAiAppCoachModel(env: Env): AppCoachModel | null {
  if (!env.OPENAI_API_KEY) return null
  return async ({ system, payload }) => {
    const spec = { schemaName: 'app_coach_turn', system, schema: APP_COACH_SCHEMA, effort: 'low' as const }
    let r = await callOpenAISpec(env, spec, payload, null)
    if (!r.ok) r = await callOpenAISpec(env, spec, payload, r.reason)
    if (!r.ok) {
      console.error('[app_coach] model failed:', r.reason)
      return null
    }
    return r.data as AppCoachModelTurn
  }
}

// ---- the tool boundary ------------------------------------------------------------------------

/** Kinds of tool the app coach may call: reads, previews, logging. Never apply_* or a gated write. */
export function appCoachMayCall(name: string): boolean {
  return /^(get|list|search)_/.test(name) || name.startsWith('preview_') || LOGGING_TOOLS.has(name)
}

function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key))
  if (v && typeof v === 'object') return Object.entries(v as Obj).some(([k, x]) => k === key || hasKey(x, key))
  return false
}

export interface AppCoachToolResult {
  name: string
  ok: boolean
  refused: string | null
  output: string | null
  preview_ids: string[]
}

const PREVIEW_ID_RE = /\b(chp_[0-9a-f]{24}|sop_[0-9a-f]{8,})\b/g
const PROPOSAL_RE = /proposal ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g

/**
 * One app-coach tool call. The same function every coach goes through
 * (executeZeroedTool) with actor app_coach, after the app coach's own fences.
 */
export async function runAppCoachTool(
  sql: Sql,
  athleteId: string,
  call: { name: string; arguments: string | Obj },
  flags: { rpeHalfSteps?: boolean } = {},
): Promise<AppCoachToolResult> {
  const name = typeof call.name === 'string' ? call.name.trim() : ''
  const refuse = (why: string): AppCoachToolResult => ({ name, ok: false, refused: why, output: null, preview_ids: [] })
  let args: Obj
  try {
    args = typeof call.arguments === 'string' ? obj(call.arguments.trim() ? JSON.parse(call.arguments) : {}) : obj(call.arguments)
  } catch {
    return refuse('arguments must be a JSON object')
  }
  const store = makeStore(sql, athleteId, 'lb')
  if (!(await coachV1On(store))) return refuse('the app coach is off for this athlete')
  const visible = new Set((await zeroedToolsFor(sql, athleteId)).map((t) => t.name))
  if (!visible.has(name)) return refuse(`${name || 'that'} is not a tool this athlete's coaches have`)
  if (!appCoachMayCall(name)) return refuse('the app coach proposes; it cannot apply or write. Preview it, and the athlete approves and applies in the app.')
  if (hasKey(args, 'approval_ref')) return refuse('app_coach can never supply approval_ref; only the athlete approves.')
  if (args.confirm === true && !LOGGING_TOOLS.has(name)) return refuse('app_coach cannot confirm a write; only logging has standing approval.')
  try {
    const output = await executeZeroedTool(sql, athleteId, name, args, flags, APP_COACH)
    const ids = [...new Set([...output.matchAll(PREVIEW_ID_RE)].map((m) => m[1]).concat([...output.matchAll(PROPOSAL_RE)].map((m) => m[1])))]
    return { name, ok: true, refused: null, output: output.slice(0, OUTPUT_CLIP), preview_ids: ids }
  } catch (e) {
    if (isMcpUserError(e)) return refuse(e.message)
    throw e
  }
}

// ---- chat store -------------------------------------------------------------------------------

export interface ChatMessage { id: string; role: 'athlete' | 'coach'; body: string; created_at: string }

async function appendChat(store: ConnectedStore, role: 'athlete' | 'coach', body: string): Promise<ChatMessage> {
  const [row] = await store.sql<ChatMessage[]>`
    INSERT INTO coach_message (athlete_id, role, kind, body)
    VALUES (${store.athleteId}, ${role}, 'chat', ${body})
    RETURNING id::text AS id, role, body, to_json(created_at) #>> '{}' AS created_at
  `
  return row
}

export async function chatHistory(store: ConnectedStore, limit = 30): Promise<ChatMessage[]> {
  const rows = await store.sql<ChatMessage[]>`
    SELECT id::text AS id, role, body, to_json(created_at) #>> '{}' AS created_at
    FROM coach_message
    WHERE athlete_id = ${store.athleteId} AND kind = 'chat'
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.max(1, Math.min(100, limit))}
  `
  return rows.reverse()
}

// ---- approvals the athlete gives ----------------------------------------------------------------

export interface ApplyOutcome {
  ok: boolean
  approval_ref?: string
  applied: boolean
  text: string
}

/** Apply what the athlete just approved, when the app can (a composed block, an activity, a proposal). */
async function applyApproved(store: ConnectedStore, previewId: string, approvalRef: string): Promise<ApplyOutcome> {
  if (UUID_RE.test(previewId)) {
    const r = await acceptProposal(store, previewId, { approvalRef })
    return { ok: r.ok, approval_ref: approvalRef, applied: r.ok && r.status === 'applied', text: r.text }
  }
  const r = await athleteApplyPreview(store, previewId, approvalRef)
  if (r) return { ok: r.ok, approval_ref: approvalRef, applied: r.ok, text: r.text }
  return { ok: true, approval_ref: approvalRef, applied: false, text: `Approved (${approvalRef}). Your coach applies it with that approval; it works once.` }
}

/** The athlete's tap on Approve. */
export async function approveByTap(store: ConnectedStore, previewId: string): Promise<ApplyOutcome> {
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  const a = await createApproval(store, me, { preview_id: previewId })
  if (!a.ok) return { ok: false, applied: false, text: a.text }
  return applyApproved(store, a.preview_id, a.approval_ref)
}

const YES_RE = /^\s*(yes|yep|yeah|yup|ok|okay|sure|approve[ds]?|apply it|do it|go ahead|sounds good|let'?s do it|confirmed?)\b/i

// ---- one turn ------------------------------------------------------------------------------------

export interface TurnResult {
  ok: boolean
  status: number
  text?: string
  message_id?: string
  reply?: ChatMessage
  previews?: string[]
  tool_calls?: Array<{ name: string; ok: boolean; refused: string | null }>
  escalate?: EscalateReason | null
  guard?: string | null
  approval?: ApplyOutcome
  rule_refs?: string[]
}

async function redFlagActive(store: ConnectedStore): Promise<boolean> {
  if ((await statusBlockedRegions(store)).length) return true
  const methodology = await resolveMethodology(store)
  return Object.values(methodology.params.U7.regions).some((r) => r?.blocked === true)
}

/** The context section 7 lists, loaded through the same read tools (each one a logged coach read). */
async function loadContext(sql: Sql, athleteId: string, today: string, flags: { rpeHalfSteps?: boolean }): Promise<Record<string, string>> {
  const calls: Array<[string, Obj]> = [
    ['get_goal_brief', {}],
    ['list_tracks', {}],
    ['get_current_program', {}],
    ['list_workouts', { since: addDaysIso(today, -14), limit: 20 }],
    ['get_checkins', { since: addDaysIso(today, -7) }],
    ['get_region_status', {}],
    ['get_change_log', { since: addDaysIso(today, -90), limit: 10 }],
    ['get_activities', {}],
  ]
  const out: Record<string, string> = {}
  for (const [name, args] of calls) {
    const r = await runAppCoachTool(sql, athleteId, { name, arguments: args }, flags)
    out[name] = r.ok ? r.output ?? '' : `(unavailable: ${r.refused})`
  }
  return out
}

/**
 * The athlete sends a message. With `approves` (a preview id) and a yes, it
 * is their chat approval of that preview: the approval cites this message
 * (msg:<id>), and the app applies it when it can. Otherwise one app-coach
 * turn: context through the tools, the model, its tool calls through the
 * boundary, section 8 on the reply, escalation.
 */
export async function appCoachTurn(
  sql: Sql,
  athleteId: string,
  body: { message?: unknown; approves?: unknown },
  deps: { model: AppCoachModel | null; flags?: { rpeHalfSteps?: boolean } },
): Promise<TurnResult> {
  const store = makeStore(sql, athleteId, 'lb')
  if (!(await coachV1On(store))) return { ok: false, status: 404, text: 'not found' }
  if (!(await coachTables(store))) return { ok: false, status: 200, text: coachUnavailable }
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : ''
  if (!message) return { ok: false, status: 400, text: 'message is required' }
  const athleteMsg = await appendChat(store, 'athlete', message)
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }

  // A chat yes to a preview: the athlete's message is the approval. No model in the loop.
  if (typeof body.approves === 'string' && body.approves.trim()) {
    const previewId = body.approves.trim()
    let outcome: ApplyOutcome
    if (!YES_RE.test(message)) {
      outcome = { ok: false, applied: false, text: 'Not approved: say yes to approve it, or tap Approve.' }
    } else {
      const a = await createApproval(store, me, { preview_id: previewId, message_id: athleteMsg.id })
      outcome = a.ok ? await applyApproved(store, a.preview_id, a.approval_ref) : { ok: false, applied: false, text: a.text }
    }
    const reply = await appendChat(store, 'coach', outcome.text)
    return { ok: outcome.ok, status: 200, message_id: athleteMsg.id, reply, approval: outcome, previews: [], tool_calls: [], escalate: null }
  }

  const today = await athleteToday(store)
  const flags = deps.flags ?? {}
  const [context, history, redFlag, minorRow] = await Promise.all([
    loadContext(sql, athleteId, today, flags),
    chatHistory(store, 12),
    redFlagActive(store),
    resolveMethodology(store),
  ])
  const minor = minorRow.minor
  const tools = (await zeroedToolsFor(sql, athleteId)).map((t) => t.name).filter(appCoachMayCall)
  const system = appCoachSystemPrompt({ minor, tools })
  const toolResults: Array<{ name: string; ok: boolean; output?: string | null; refused?: string | null }> = []
  const toolCalls: TurnResult['tool_calls'] = []
  const previews: string[] = []
  let final: AppCoachModelTurn | null = null
  for (let round = 0; round < MAX_ROUNDS && deps.model; round++) {
    const turn = await deps.model({
      system,
      payload: { today, red_flag_active: redFlag, context, history: history.filter((m) => m.id !== athleteMsg.id).map((m) => ({ role: m.role, content: m.body })), message, tool_results: toolResults, round },
    })
    if (!turn) break
    final = turn
    const calls = Array.isArray(turn.tool_calls) ? turn.tool_calls.slice(0, MAX_CALLS) : []
    if (!calls.length || round === MAX_ROUNDS - 1) break
    for (const c of calls) {
      const r = await runAppCoachTool(sql, athleteId, c, flags)
      toolResults.push({ name: r.name, ok: r.ok, output: r.output, refused: r.refused })
      toolCalls.push({ name: r.name, ok: r.ok, refused: r.refused })
      for (const id of r.preview_ids) if (!previews.includes(id)) previews.push(id)
    }
  }
  const guarded = final ? guardReply(String(final.reply ?? ''), { minor }) : { text: 'The coach is not available right now. Your plan and the engine are unchanged; try again later.', guard: null }
  const modelEscalate = final && ESCALATE_REASONS.includes(final.escalate as EscalateReason) ? final.escalate as EscalateReason : null
  const escalate: EscalateReason | null = redFlag ? 'red_flag' : modelEscalate
  const text = escalate && !guarded.text.includes(ESCALATION_TEXT[escalate]) ? `${guarded.text}\n\n${ESCALATION_TEXT[escalate]}` : guarded.text
  const reply = await appendChat(store, 'coach', text)
  if (escalate) {
    // Section 7 step 8: flagged for a human, in the athlete's coach log.
    await store.sql`
      INSERT INTO coach_message (athlete_id, role, kind, body, ref_id)
      VALUES (${store.athleteId}, 'coach', 'note', ${`Escalated to a human coach (${escalate.replace(/_/g, ' ')}).`}, ${reply.id})
    `
  }
  return {
    ok: true,
    status: 200,
    message_id: athleteMsg.id,
    reply,
    previews,
    tool_calls: toolCalls,
    escalate,
    guard: guarded.guard,
    rule_refs: Array.isArray(final?.rule_refs) ? final!.rule_refs.filter((r) => /^U(1[0-5]|[1-9])$/.test(r)) : [],
  }
}

// ---- intake -----------------------------------------------------------------------------------------

export interface IntakeResult {
  ok: boolean
  text?: string
  errors?: string[]
  needs_consent?: boolean
  stopped?: boolean
  regions?: Array<{ region: string; why: string }>
  refer_out?: string
  intake_id?: string
  preview_id?: string
  block?: ReturnType<typeof blockSummary>
}

/** The athlete's birth date, once: recorded by their own intake tap and logged. Never changed here. */
async function recordBirthDate(store: ConnectedStore, birthDate: string, minor: boolean): Promise<void> {
  const changeId = crypto.randomUUID()
  const diff = { field: 'birth_date', before: null, after: birthDate, under_18: minor }
  try {
    await withTx(store.sql, async () => {
      const tap = await directTapApproval(store, 'app_editor', `birth_date:${store.athleteId}`, diff)
      const done = await store.sql<{ id: string }[]>`
        UPDATE athlete SET birth_date = ${birthDate}::date WHERE id = ${store.athleteId} AND birth_date IS NULL RETURNING id::text AS id
      `
      if (!done.length) throw new McpUserError('Your birth date is already on file.')
      await writeChange(store, {
        id: changeId, actor: { type: 'athlete', id: store.athleteId }, tool: 'set_birth_date', targetType: 'athlete', targetId: store.athleteId,
        diff, rationale: minor ? 'Intake: under 18, so the under-18 rules apply (section 8).' : 'Intake.', ruleRefs: [],
        approvalRef: tap.ref, approvalId: tap.id,
      })
      if (!(await consumeApproval(store, tap.id, changeId))) throw new ApprovalSpent()
    })
  } catch (e) {
    if (!(e instanceof McpUserError)) throw e
  }
}

function blockRequestFrom(intake: ParsedIntake, existing: Awaited<ReturnType<typeof loadActivities>>, intakeId: string): BlockRequest {
  const injuries = new Map<string, { region: ParsedIntake['pain'][number]['region']; history: boolean; pain: number | null }>()
  for (const h of intake.injury_history) injuries.set(h.region, { region: h.region, history: true, pain: null })
  for (const p of intake.pain) injuries.set(p.region, { region: p.region, history: injuries.get(p.region)?.history ?? false, pain: p.score })
  return {
    add_goals: intake.goals.map((g) => ({
      name: g.name, test: g.test, target: g.target, current: g.current, unit: g.unit, direction: g.direction,
      due_date: g.due_date, weight: g.weight, quality: g.quality,
    })),
    add_activities: intake.activities.filter((a) => !existing.some((x) => x.module === a.module && x.name.toLowerCase() === a.name.toLowerCase())),
    schedule: { days_per_week: intake.schedule.days_per_week, minutes_per_session: intake.schedule.minutes_per_session, rest_days: intake.schedule.rest_days },
    training_age: intake.training_age,
    injuries: [...injuries.values()].sort((a, b) => a.region.localeCompare(b.region)),
    screens: intake.screens,
    intake_id: intakeId,
  }
}

export async function runIntake(store: ConnectedStore, answers: unknown): Promise<IntakeResult> {
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  const [today, methodology, [row]] = await Promise.all([
    athleteToday(store),
    resolveMethodology(store),
    store.sql<{ birth_date: string | null }[]>`SELECT birth_date::text AS birth_date FROM athlete WHERE id = ${store.athleteId}`,
  ])
  const parsed = parseIntake(answers, { today, birthDateOnFile: row?.birth_date ?? null, params: methodology.params, minors: methodology.minors })
  if (!parsed.ok) return { ok: false, errors: parsed.errors, needs_consent: parsed.needs_consent === true }
  const intake = parsed.intake
  if (!row?.birth_date && intake.birth_date) await recordBirthDate(store, intake.birth_date, intake.minor)

  // Pain and the recovery baseline are a check-in: standing approval, and a
  // red flag (or pain above the stop line) blocks the region (U7) on the spot
  // (v1.2: pain above the stop line alone, for that day and the next session).
  let checkinChange: string | null = null
  const r = intake.recovery
  if (intake.pain.length || r.sleep_hours != null || r.stress != null || r.soreness != null) {
    const c = await saveCheckin(store, me, {
      sleep_hours: r.sleep_hours, stress: r.stress, soreness: r.soreness,
      pain: intake.pain.map((p) => ({ region: p.region, score: p.score, red_flags: p.red_flags })),
    })
    checkinChange = c.change_id ?? null
  }
  const intakeId = crypto.randomUUID()
  const record = async (outcome: 'stopped' | 'previewed', previewId: string | null) => {
    await store.sql`
      INSERT INTO coach_intake (id, athlete_id, answers, outcome, minor, parental_consent, preview_id, change_id)
      VALUES (${intakeId}, ${store.athleteId}, ${jsonParam(store.sql, intake)}, ${outcome}, ${intake.minor},
              ${intake.parental_consent ? jsonParam(store.sql, { ...intake.parental_consent, confirmed_on: today }) : null},
              ${previewId}, ${checkinChange})
    `
  }
  if (parsed.stop) {
    await record('stopped', null)
    return {
      ok: true,
      stopped: true,
      intake_id: intakeId,
      regions: parsed.stop.regions,
      refer_out: REFER_OUT,
      text: `Intake stopped: ${parsed.stop.regions.map((x) => x.why).join('; ')}. That area is not loaded. ${REFER_OUT}`,
    }
  }
  const existing = await loadActivities(store)
  const { preview_id, state } = await previewBlockState(store, blockRequestFrom(intake, existing, intakeId), APP_COACH, 'Intake (section 5): your goals, activities, schedule and history, composed (section 4).')
  await record('previewed', preview_id)
  return { ok: true, stopped: false, intake_id: intakeId, preview_id, block: blockSummary(state.block, programView(state, true)) }
}

/** The athlete picks trade-offs on a block preview: a new preview with their picks, same request otherwise. */
async function repreview(store: ConnectedStore, previewId: unknown, resolutions: unknown): Promise<Obj> {
  const id = typeof previewId === 'string' ? previewId.trim() : ''
  const [p] = await store.sql<{ diff: unknown; rationale: string | null }[]>`
    SELECT diff, rationale FROM change_preview
    WHERE preview_id = ${id} AND athlete_id = ${store.athleteId} AND tool = ${BLOCK_TOOL} AND used_at IS NULL AND voided_at IS NULL
    LIMIT 1
  `
  if (!p) return { ok: false, text: 'No such block preview.' }
  const prior = asJson<{ request?: BlockRequest }>(p.diff, {}).request ?? {}
  const picks: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(resolutions))) {
    if (['interference', 'priority_cap', 'time_budget'].includes(k) && typeof v === 'string' && v.trim()) picks[k] = v.trim().slice(0, 80)
  }
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  const next = await previewBlockState(store, { ...prior, resolutions: { ...(prior.resolutions ?? {}), ...picks } }, me, p.rationale)
  return { ok: true, preview_id: next.preview_id, block: blockSummary(next.state.block, programView(next.state, true)) }
}

// ---- the route -------------------------------------------------------------------------------------

export async function athleteCoachAction(
  store: ConnectedStore,
  body: Obj,
  deps: { model: AppCoachModel | null; flags?: { rpeHalfSteps?: boolean } },
): Promise<[unknown, number]> {
  if (!(await coachV1On(store))) return [{ error: 'not found' }, 404]
  if (!(await coachTables(store))) return [{ ok: false, text: coachUnavailable }, 200]
  try {
    switch (body.action) {
      case 'state': {
        const [activities, block, recompose, intake, chat, methodology] = await Promise.all([
          loadActivities(store), currentBlock(store), recomposeDue(store), lastIntake(store), chatHistory(store, 30), resolveMethodology(store),
        ])
        const [a] = await store.sql<{ birth_date: string | null }[]>`SELECT birth_date::text AS birth_date FROM athlete WHERE id = ${store.athleteId}`
        return [{
          ok: true,
          activities,
          block: block ? { id: block.id, methodology_version: block.methodology_version, modules_version: block.modules_version, ...blockSummary(block.block) } : null,
          recompose,
          intake: intake ? { id: intake.id, outcome: intake.outcome, created_at: intake.created_at } : null,
          birth_date_on_file: !!a?.birth_date,
          minor: methodology.minor,
          chat,
          // What the intake form asks about, from the server's config.
          modules: moduleCatalog(),
          regions: PAIN_REGIONS,
          red_flags: RED_FLAGS,
        }, 200]
      }
      case 'intake':
        return [await runIntake(store, body.answers), 200]
      case 'repreview':
        return [await repreview(store, body.preview_id, body.resolutions), 200]
      case 'approve': {
        const id = typeof body.preview_id === 'string' ? body.preview_id.trim() : ''
        if (!id) return [{ ok: false, text: 'preview_id is required.' }, 400]
        return [await approveByTap(store, id), 200]
      }
      case 'chat': {
        const r = await appCoachTurn(store.sql, store.athleteId, { message: body.message, approves: body.approves }, deps)
        return [r, r.status]
      }
      default:
        return [{ error: 'unknown action' }, 400]
    }
  } catch (e) {
    if (isMcpUserError(e)) return [{ ok: false, text: e.message }, 200]
    throw e
  }
}

/** POST /api/coach — the athlete's own session; same auth as /api/session-rx. */
export async function handleCoach(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)
  let body: Obj
  try {
    body = obj(await req.json())
  } catch {
    return json({ error: 'invalid json' }, 400, cors)
  }
  try {
    return await withSql(env, async (sql) => {
      const user = await sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET)
      if (!user) return json({ error: 'unauthorized' }, 401, cors)
      const athleteId = await resolveAthleteId(sql, user.id)
      if (!athleteId) return json({ error: 'unauthorized' }, 401, cors)
      const [out, status] = await athleteCoachAction(makeStore(sql, athleteId, 'lb'), body, { model: openAiAppCoachModel(env) })
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'coach request failed' }, 500, cors)
  }
}
