/**
 * Activities + the composed block (G6, coach_v1), the I/O half. The rules are
 * pure (coach/composer.ts on coach/modules.ts); this file reads the rows,
 * keeps previews, and writes approved changes through the same change_log
 * path as every other write (G2) with the athlete's approval (G10):
 *
 *   get_activities          the athlete's activities, the module catalog, the
 *                           block of record and whether it is due a
 *                           re-compose (block boundary, or an activity or
 *                           goal added, removed or re-weighted).
 *   preview_activity_change add | update | remove one activity. A kept
 *                           preview (change_preview); writes nothing.
 *   apply_activity_change   confirm=true + preview_id (< 24 h, diff still
 *                           matching) + approval_ref. Removing sets
 *                           active = false; nothing is deleted. Re-composes:
 *                           the result carries a fresh block preview.
 *   preview_composed_block  compose from the activities and goals on file,
 *                           plus anything the request adds (intake) or
 *                           re-weights, and the trade-offs the athlete
 *                           picked. A kept preview.
 *   apply_composed_block    the same approval rules; refused while a
 *                           trade-off is undecided. Writes the block of
 *                           record, any activities/goals the request added,
 *                           goal weights, tracks + progression rules, and the
 *                           program's deload/retest dates, in one transaction
 *                           with one change_log row. Screen baselines then go
 *                           in under standing approval (log_goal_measurement).
 *
 * coach_v1 only counts together with tracks_v1; with it off every tool here
 * is unknown and nothing here is called. app_coach can preview and never
 * apply (it can never hold an approval_ref; changeLog.writeApprovalProblem).
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { asJson, jsonParam } from './db.ts'
import {
  authorizeWrite, commitAuthorized, makeWriteGate, previewFooter, programMetaSnapshot, storeChangePreview, type ChangeActor,
} from './changeLog.ts'
import { ruleRefsFrom } from './changeSummary.ts'
import { athleteMinor, blockedRegions, resolveMethodology } from './methodology.ts'
import { seesHealth, statusBlockedRegions } from './regionStatus.ts'
import { athleteToday, canonicalJson, tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { runTrackTool } from './trackTools.ts'
import type { ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'
import {
  addDaysIso, compose, composeKey, recomposeReason, TRAINING_AGES, weekLines,
  type ComposeActivity, type ComposedBlock, type ComposeGoal, type ComposeInjury, type ComposeInput, type GoalWeight,
  type Season, type TrainingAge,
} from './coach/composer.ts'
import {
  COMPOSER_V1, isModuleKey, isQuality, moduleCatalog, moduleForSport, MODULES, MODULES_V1_VERSION, QUALITY_LABEL, SCREENS,
  type ModuleKey, type Quality, type ScreenKey,
} from './coach/modules.ts'
import { ageOn } from './coach/intake.ts'
import { PAIN_REGIONS, type PainRegion } from './methodology/v1.ts'

export const ACTIVITY_TOOL = 'apply_activity_change'
export const BLOCK_TOOL = 'apply_composed_block'

export const coachUnavailable = 'Activities and composed blocks are not set up on this database yet. Nothing was written.'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

function json(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

function missingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return code === '42P01' || code === '42703'
}

/** A write that named a coach_v1 table or column before worker/schema/coach-v1.sql. */
export function coachSchemaMissing(e: unknown): boolean {
  return missingSchema(e) && /activity|composed_block|coach_intake|weight|quality/.test(String((e as { message?: string })?.message ?? ''))
}

// ---- flag -----------------------------------------------------------------------------------

/** coach_v1 on for this athlete. It only counts with tracks_v1 (the gate, approvals, change_log). */
export async function coachV1On(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ on: boolean | null }[]>`
    SELECT ((flags->'coach_v1') = 'true'::jsonb AND (flags->'tracks_v1') = 'true'::jsonb) AS on
    FROM athlete WHERE id = ${store.athleteId}
  `
  return row?.on === true
}

/** The coach_v1 tables and columns exist (worker/schema/coach-v1.sql). Checked, not caught. */
export async function coachTables(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT (to_regclass('public.activity') IS NOT NULL
        AND to_regclass('public.composed_block') IS NOT NULL
        AND to_regclass('public.coach_intake') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'athlete_goal' AND column_name = 'weight')) AS ok
  `
  return row?.ok === true
}

// ---- reads -------------------------------------------------------------------------------------

export interface ActivityRow {
  id: string
  module: ModuleKey
  name: string
  sessions_per_week: number
  season: Season
  days: number[]
  active: boolean
  updated_at: string
}

function parseDays(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isInteger(n))
  if (typeof v === 'string') return v.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
  return []
}

function daysLiteral(days: number[]): string {
  return `{${days.join(',')}}`
}

export async function loadActivities(store: ConnectedStore, opts: { includeInactive?: boolean } = {}): Promise<ActivityRow[]> {
  const rows = await store.sql<Array<Omit<ActivityRow, 'days' | 'module'> & { module_key: ModuleKey; days: unknown }>>`
    SELECT id::text AS id, module_key, name, sessions_per_week, season, days, active, to_json(updated_at) #>> '{}' AS updated_at
    FROM activity
    WHERE athlete_id = ${store.athleteId} AND (${opts.includeInactive === true} OR active)
    ORDER BY created_at, id
  `
  return rows.map((r) => ({
    id: r.id, module: r.module_key, name: r.name, sessions_per_week: Number(r.sessions_per_week), season: r.season,
    days: parseDays(r.days), active: r.active, updated_at: r.updated_at,
  }))
}

interface GoalRow {
  id: string
  name: string
  metric: string
  test_protocol: string | null
  due_date: string | null
  status: string
  weight: GoalWeight | null
  quality: Quality | null
  track_id: string | null
}

async function loadGoals(store: ConnectedStore): Promise<GoalRow[]> {
  return store.sql<GoalRow[]>`
    SELECT id::text AS id, name, metric, test_protocol, due_date::text AS due_date, status, weight, quality, track_id::text AS track_id
    FROM athlete_goal
    WHERE athlete_id = ${store.athleteId} AND status <> 'hit' AND name NOT LIKE 'Screen: %'
    ORDER BY created_at, id
  `
}

export interface BlockRow {
  id: string
  program_id: string | null
  start_date: string
  end_date: string
  methodology_version: string
  modules_version: string
  compose_key: string
  block: ComposedBlock
  request: BlockRequest
  created_at: string
  change_id: string
}

export async function currentBlock(store: ConnectedStore): Promise<BlockRow | null> {
  const [r] = await store.sql<Array<Omit<BlockRow, 'block' | 'request'> & { block: unknown; request: unknown }>>`
    SELECT id::text AS id, program_id::text AS program_id, start_date::text AS start_date, end_date::text AS end_date,
           methodology_version, modules_version, compose_key, block, request,
           to_json(created_at) #>> '{}' AS created_at, change_id::text AS change_id
    FROM composed_block
    WHERE athlete_id = ${store.athleteId} AND superseded_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `
  if (!r) return null
  return { ...r, block: asJson<ComposedBlock>(r.block, {} as ComposedBlock), request: asJson<BlockRequest>(r.request, {}) }
}

/** The newest intake answers on file (sanitized), for the schedule and injuries a re-compose reuses. */
export async function lastIntake(store: ConnectedStore): Promise<{ id: string; answers: Obj; outcome: string; created_at: string } | null> {
  const [r] = await store.sql<{ id: string; answers: unknown; outcome: string; created_at: string }[]>`
    SELECT id::text AS id, answers, outcome, to_json(created_at) #>> '{}' AS created_at
    FROM coach_intake WHERE athlete_id = ${store.athleteId}
    ORDER BY created_at DESC, id DESC LIMIT 1
  `
  return r ? { ...r, answers: obj(asJson<unknown>(r.answers, {})) } : null
}

/**
 * Section 4 rule 3: sessions logged outside the plan (the external program,
 * arc_load_v1) in the two weeks before `start`, per activity, a week. A
 * logged session counts for the first active activity of the module its
 * name maps to.
 */
async function loggedPerWeek(store: ConnectedStore, activities: ComposeActivity[], start: string): Promise<Record<string, number>> {
  const rows = await store.sql<{ name: string; n: number }[]>`
    SELECT r.name, count(*)::int AS n
    FROM workout w
    JOIN routine r ON r.id = w.routine_id
    JOIN program p ON p.id = r.program_id
    WHERE p.athlete_id = ${store.athleteId} AND p.status = 'external'
      AND w.performed_at >= (${start}::date - 14) AND w.performed_at < ${start}::date
    GROUP BY r.name
  `
  const out: Record<string, number> = {}
  for (const r of rows) {
    const m = moduleForSport(r.name)
    const a = m ? activities.find((x) => x.module === m && x.id) : null
    if (a?.id) out[a.id] = (out[a.id] ?? 0) + Number(r.n) / 2
  }
  return out
}

// ---- requests ------------------------------------------------------------------------------------

export interface BlockRequest {
  goal_weights?: Array<{ goal: string; weight: GoalWeight; quality?: Quality | null }>
  add_goals?: Array<{
    name: string; test?: string | null; target?: number | null; current?: number | null; unit?: string | null
    direction?: 'higher' | 'lower'; due_date?: string | null; weight: GoalWeight; quality?: Quality | null
  }>
  add_activities?: Array<{ module: ModuleKey; name: string; sessions_per_week: number; season: Season; days: number[] }>
  schedule?: { days_per_week: number; minutes_per_session: number; rest_days: number[] }
  training_age?: TrainingAge
  injuries?: ComposeInjury[]
  resolutions?: Record<string, string>
  start?: string
  /** From intake: screen baselines logged once the block (and its screen goals) exist. */
  screens?: Array<{ key: ScreenKey; value: number; side: 'L' | 'R' | null }>
  intake_id?: string
}

function days(v: unknown): number[] | null {
  const out: number[] = []
  for (const d of arr(v)) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return null
    if (!out.includes(d)) out.push(d)
  }
  return out.sort((a, b) => a - b)
}

function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1
}

export function mondayOnOrAfter(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDaysIso(date, (8 - dow) % 7)
}

/** The MCP arguments of preview_composed_block, checked. Internal fields (screens, intake_id) are not taken from coaches. */
export function parseBlockRequest(args: Obj, today: string): { ok: true; request: BlockRequest } | { ok: false; text: string } {
  const req: BlockRequest = {}
  if (args.goal_weights !== undefined) {
    req.goal_weights = []
    for (const v of arr(args.goal_weights)) {
      const x = obj(v)
      const goal = str(x.goal, 80)
      if (!goal) return { ok: false, text: 'goal_weights: each needs goal (id or name).' }
      if (x.weight !== 'priority' && x.weight !== 'maintenance') return { ok: false, text: `goal_weights: "${goal}" weight is priority or maintenance.` }
      if (x.quality != null && !isQuality(x.quality)) return { ok: false, text: `goal_weights: "${goal}" quality is one of ${Object.keys(QUALITY_LABEL).join(', ')}.` }
      req.goal_weights.push({ goal, weight: x.weight, quality: isQuality(x.quality) ? x.quality : null })
    }
  }
  if (args.add_goals !== undefined) {
    req.add_goals = []
    for (const v of arr(args.add_goals)) {
      const x = obj(v)
      const name = str(x.name, 80)
      if (!name) return { ok: false, text: 'add_goals: each needs a name.' }
      if (x.weight !== 'priority' && x.weight !== 'maintenance') return { ok: false, text: `add_goals: "${name}" weight is priority or maintenance.` }
      if (x.quality != null && !isQuality(x.quality)) return { ok: false, text: `add_goals: "${name}" has an unknown quality.` }
      const due = str(x.due_date, 10)
      if (due && (!DATE_RE.test(due) || due < today)) return { ok: false, text: `add_goals: "${name}" due_date is today or later, YYYY-MM-DD.` }
      const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null)
      req.add_goals.push({
        name, test: str(x.test, 80), target: num(x.target), current: num(x.current), unit: str(x.unit, 16),
        direction: x.direction === 'lower' ? 'lower' : 'higher', due_date: due, weight: x.weight, quality: isQuality(x.quality) ? x.quality : null,
      })
    }
    if (req.add_goals.length > 3) return { ok: false, text: 'add_goals: at most 3.' }
  }
  if (args.add_activities !== undefined) {
    req.add_activities = []
    for (const v of arr(args.add_activities)) {
      const a = activityFields(obj(v))
      if (!a.ok) return { ok: false, text: `add_activities: ${a.text}` }
      req.add_activities.push(a.value)
    }
  }
  if (args.schedule !== undefined) {
    const s = obj(args.schedule)
    const dpw = Number(s.days_per_week)
    const mins = Number(s.minutes_per_session)
    const rest = days(s.rest_days ?? [])
    if (!Number.isInteger(dpw) || dpw < 1 || dpw > 7) return { ok: false, text: 'schedule.days_per_week is 1–7.' }
    if (!Number.isFinite(mins) || mins < 20 || mins > 180) return { ok: false, text: 'schedule.minutes_per_session is 20–180.' }
    if (!rest) return { ok: false, text: 'schedule.rest_days are 0 (Mon) to 6 (Sun).' }
    req.schedule = { days_per_week: dpw, minutes_per_session: mins, rest_days: rest }
  }
  if (args.training_age !== undefined) {
    if (!TRAINING_AGES.includes(args.training_age as TrainingAge)) return { ok: false, text: `training_age is one of ${TRAINING_AGES.join(', ')}.` }
    req.training_age = args.training_age as TrainingAge
  }
  if (args.resolutions !== undefined) {
    const r = obj(args.resolutions)
    req.resolutions = {}
    for (const k of ['interference', 'priority_cap', 'time_budget']) {
      const v = str(r[k], 80)
      if (v) req.resolutions[k] = v
    }
  }
  if (args.start !== undefined) {
    const s = str(args.start, 10)
    if (!s || !DATE_RE.test(s) || !isMonday(s)) return { ok: false, text: 'start is a Monday, YYYY-MM-DD.' }
    if (s < addDaysIso(today, -6) || s > addDaysIso(today, 35)) return { ok: false, text: 'start is this week\'s Monday or one in the next 5 weeks.' }
    req.start = s
  }
  return { ok: true, request: req }
}

function activityFields(x: Obj, base?: ActivityRow): { ok: true; value: { module: ModuleKey; name: string; sessions_per_week: number; season: Season; days: number[] } } | { ok: false; text: string } {
  const module = x.module ?? base?.module
  if (!isModuleKey(module)) return { ok: false, text: `module is one of ${Object.keys(MODULES).join(', ')}.` }
  const name = str(x.name, 60) ?? base?.name ?? MODULES[module].label
  const spw = x.sessions_per_week ?? base?.sessions_per_week
  if (typeof spw !== 'number' || !Number.isInteger(spw) || spw < 0 || spw > 14) return { ok: false, text: 'sessions_per_week is a whole number 0–14.' }
  const season = x.season ?? base?.season ?? 'in'
  if (season !== 'in' && season !== 'off') return { ok: false, text: 'season is in or off.' }
  const d = x.days !== undefined ? days(x.days) : base?.days ?? []
  if (!d) return { ok: false, text: 'days are 0 (Mon) to 6 (Sun).' }
  return { ok: true, value: { module, name, sessions_per_week: spw, season, days: d } }
}

// ---- compose ---------------------------------------------------------------------------------------

function trainingAgeOf(years: number | null): TrainingAge {
  if (years == null || years < 1) return 'lt1'
  if (years < 3) return '1to3'
  if (years < 10) return '3to10'
  return '10plus'
}

export interface Composed {
  input: ComposeInput
  block: ComposedBlock
  key: string
  methodology_version: string
  /** The request with everything it fell back to filled in: what a preview keeps, so its apply recomputes the same block. */
  effective: BlockRequest
}

/** Everything the composer reads for this athlete, plus what the request adds. Same request + same rows → same input. */
export async function composeFor(store: ConnectedStore, req: BlockRequest): Promise<Composed> {
  const [acts, goals, methodology, statusBlocked, today, intake, block, minor] = await Promise.all([
    loadActivities(store), loadGoals(store), resolveMethodology(store), statusBlockedRegions(store),
    athleteToday(store), lastIntake(store), currentBlock(store), athleteMinor(store),
  ])
  const [athlete] = await store.sql<{ training_age: number | null; sessions_per_week: number | null; birth_date: string | null }[]>`
    SELECT training_age, sessions_per_week, birth_date::text AS birth_date FROM athlete WHERE id = ${store.athleteId}
  `
  const prior = obj(intake?.answers)
  const start = req.start ?? mondayOnOrAfter(today)
  const activities: ComposeActivity[] = [
    ...acts.map((a) => ({ id: a.id, module: a.module, name: a.name, sessions_per_week: a.sessions_per_week, season: a.season, days: a.days })),
    ...(req.add_activities ?? []).map((a, i) => ({ id: `new-activity:${i}`, ...a })),
  ]
  const weights = new Map((req.goal_weights ?? []).map((w) => [w.goal.toLowerCase(), w]))
  const pick = (g: GoalRow) => weights.get(g.id.toLowerCase()) ?? weights.get(g.name.toLowerCase())
  const added = (req.add_goals ?? []).filter((g) => !goals.some((x) => x.name.toLowerCase() === g.name.toLowerCase()))
  const sameName = new Map((req.add_goals ?? []).map((g) => [g.name.toLowerCase(), g]))
  const composeGoals: ComposeGoal[] = [
    ...goals.map((g) => {
      const w = pick(g) ?? sameName.get(g.name.toLowerCase())
      return {
        id: g.id, name: g.name, test: g.test_protocol ?? g.metric,
        weight: w?.weight ?? g.weight ?? 'maintenance', quality: w?.quality ?? g.quality ?? null, due_date: g.due_date,
      }
    }),
    ...added.map((g, i) => ({ id: `new-goal:${i}`, name: g.name, test: g.test ?? null, weight: g.weight, quality: g.quality ?? null, due_date: g.due_date ?? null })),
  ]
  // Not in the request: what the block of record ran on, then the newest
  // intake, then the athlete row. The athlete's trade-off picks carry over
  // too, so a re-compose doesn't ask again what they already decided (a pick
  // only applies while that trade-off and that option still exist).
  const priorSchedule = obj(prior.schedule)
  const schedule = req.schedule
    ?? block?.request.schedule
    ?? (priorSchedule.days_per_week ? {
      days_per_week: Number(priorSchedule.days_per_week), minutes_per_session: Number(priorSchedule.minutes_per_session),
      rest_days: parseDays(priorSchedule.rest_days),
    } : null)
    ?? { days_per_week: athlete?.sessions_per_week ?? COMPOSER_V1.default_days_per_week, minutes_per_session: COMPOSER_V1.default_minutes, rest_days: [] }
  const trainingAge = req.training_age
    ?? block?.request.training_age
    ?? (TRAINING_AGES.includes(prior.training_age as TrainingAge) ? prior.training_age as TrainingAge : null)
    ?? trainingAgeOf(athlete?.training_age ?? null)
  const injuries = req.injuries ?? block?.request.injuries ?? injuriesFrom(prior)
  const resolutions = req.resolutions ?? block?.request.resolutions ?? {}
  const input: ComposeInput = {
    start,
    activities,
    goals: composeGoals,
    schedule,
    training_age: trainingAge,
    minor: minor === true || methodology.minor,
    age: athlete?.birth_date ? ageOn(athlete.birth_date, today) : null,
    injuries,
    blocked_regions: [...new Set([...blockedRegions(methodology), ...statusBlocked])].sort(),
    logged_sessions_per_week: await loggedPerWeek(store, activities, start),
    params: methodology.params,
    minors: methodology.minors,
    resolutions,
  }
  const effective: BlockRequest = { ...req, start, schedule, training_age: trainingAge, injuries, resolutions }
  return { input, block: compose(input), key: composeKey(input), methodology_version: methodology.version, effective }
}

function injuriesFrom(answers: Obj): ComposeInjury[] {
  const out = new Map<PainRegion, ComposeInjury>()
  for (const h of arr(answers.injury_history)) {
    const r = obj(h).region
    if ((PAIN_REGIONS as readonly unknown[]).includes(r)) out.set(r as PainRegion, { region: r as PainRegion, history: true, pain: null })
  }
  for (const p of arr(answers.pain)) {
    const x = obj(p)
    if (!(PAIN_REGIONS as readonly unknown[]).includes(x.region)) continue
    const prev = out.get(x.region as PainRegion)
    out.set(x.region as PainRegion, { region: x.region as PainRegion, history: prev?.history ?? false, pain: typeof x.score === 'number' ? x.score : null })
  }
  return [...out.values()].sort((a, b) => a.region.localeCompare(b.region))
}

/** What a composed-block preview holds and its apply must still match. */
interface BlockState {
  request: BlockRequest
  methodology_version: string
  modules_version: string
  compose_key: string
  block: ComposedBlock
}

async function planBlock(store: ConnectedStore, req: BlockRequest): Promise<BlockState> {
  const c = await composeFor(store, req)
  return { request: c.effective, methodology_version: c.methodology_version, modules_version: MODULES_V1_VERSION, compose_key: c.key, block: c.block }
}

/** Re-compose: the reason the block on file no longer stands, or null. */
export async function recomposeDue(store: ConnectedStore): Promise<ReturnType<typeof recomposeReason>> {
  const [block, c, today] = await Promise.all([currentBlock(store), composeFor(store, {}), athleteToday(store)])
  return recomposeReason(block ? { key: block.compose_key, end: block.end_date } : null, { key: c.key, today })
}

// ---- views -----------------------------------------------------------------------------------------

/**
 * D3: a coach the athlete hasn't shared pain and check-ins with sees that
 * something is held, not which region or why; prehab order reasons (injury
 * history, pain) and red-flag warnings are left out.
 */
export function redactHealth(b: ComposedBlock): ComposedBlock {
  const healthy = (w: string) => !/red-flagged|injury history|pain/i.test(w)
  return {
    ...b,
    // A held prehab item's name says which region; jumps and drills don't.
    held: b.held.map((h) => ({
      what: /^(Jumps|Change of direction)/.test(h.what) ? h.what : 'A prehab item',
      regions: [],
      note: 'Held for a health reason (not shared with you).',
    })),
    prehab: { ...b.prehab, items: b.prehab.items.map((i) => ({ ...i, why: null })) },
    goals: b.goals.map((g) => (g.role === 'held' ? { ...g, note: 'Held for a health reason (not shared with you).' } : g)),
    tracks: b.tracks.map((t) => ({ ...t, why: healthy(t.why) ? t.why : t.why.replace(/ ?(Moved to bike or rower|[^.]*red-flagged)[^.]*\./gi, '').trim() })),
    warnings: b.warnings.filter(healthy),
  }
}

export function blockSummary(b: ComposedBlock) {
  return {
    start: b.start,
    end: b.end,
    priorities: b.priorities.map((q) => QUALITY_LABEL[q]),
    tracks: b.tracks.map((t) => ({ name: t.name, role: t.role, engine: t.engine_type, added_per_week: t.sessions_per_week, from_activities: t.supplied_by_activities, why: t.why, rule_refs: t.rule_refs })),
    goals: b.goals,
    week: weekLines(b),
    deload_week: b.deload_week,
    retest_week: b.retest_week,
    prehab: b.prehab,
    screens: b.screens.map((s) => s.name),
    held: b.held,
    trade_offs: b.trade_offs,
    needs_decision: b.needs_decision,
    warnings: b.warnings,
    minor: b.minor,
    rule_refs: b.rule_refs,
  }
}

async function getActivities(store: ConnectedStore): Promise<string> {
  const [all, block, due] = await Promise.all([loadActivities(store, { includeInactive: true }), currentBlock(store), recomposeDue(store)])
  return json({
    activities: all.map((a) => ({ id: a.id, module: a.module, name: a.name, sessions_per_week: a.sessions_per_week, season: a.season, days: a.days, active: a.active })),
    block: block
      ? {
          id: block.id, start: block.start_date, end: block.end_date,
          methodology_version: block.methodology_version, modules_version: block.modules_version,
          priorities: block.block.priorities.map((q) => QUALITY_LABEL[q]),
          week: weekLines(block.block),
          trade_offs_chosen: block.block.trade_offs.map((t) => ({ id: t.id, chosen: t.chosen })),
          change_id: block.change_id,
        }
      : null,
    recompose: { due: due != null, reason: due },
    modules: { version: MODULES_V1_VERSION, catalog: moduleCatalog() },
    next: due
      ? `Re-compose is due (${due}): preview_composed_block, show the athlete the block and any trade-offs, and apply once they approve.`
      : 'The block on file stands. A new activity or goal, or the block ending, makes a re-compose due.',
  })
}

// ---- activity changes ----------------------------------------------------------------------------------

interface ActivityState {
  request: { op: 'add' | 'update' | 'remove'; activity_id: string | null; fields: Obj }
  before: Omit<ActivityRow, 'updated_at'> | null
  after: { module: ModuleKey; name: string; sessions_per_week: number; season: Season; days: number[]; active: boolean }
}

async function planActivity(store: ConnectedStore, req: ActivityState['request']): Promise<{ ok: true; state: ActivityState } | { ok: false; text: string }> {
  if (req.op === 'add') {
    const f = activityFields(req.fields)
    if (!f.ok) return f
    return { ok: true, state: { request: req, before: null, after: { ...f.value, active: true } } }
  }
  if (!req.activity_id || !UUID_RE.test(req.activity_id)) return { ok: false, text: 'activity_id is required (get_activities lists them).' }
  const row = (await loadActivities(store, { includeInactive: true })).find((a) => a.id === req.activity_id)
  if (!row) return { ok: false, text: 'No such activity on this athlete.' }
  const { updated_at: _u, ...before } = row
  if (req.op === 'remove') {
    if (!row.active) return { ok: false, text: `${row.name} is already removed.` }
    return { ok: true, state: { request: req, before, after: { module: row.module, name: row.name, sessions_per_week: row.sessions_per_week, season: row.season, days: row.days, active: false } } }
  }
  const f = activityFields(req.fields, row)
  if (!f.ok) return f
  const after = { ...f.value, active: true }
  if (canonicalJson(after) === canonicalJson({ module: row.module, name: row.name, sessions_per_week: row.sessions_per_week, season: row.season, days: row.days, active: row.active })) {
    return { ok: false, text: 'Nothing to change.' }
  }
  return { ok: true, state: { request: req, before, after } }
}

async function previewActivity(store: ConnectedStore, args: Obj, actor: ChangeActor): Promise<string> {
  const op = args.op
  if (op !== 'add' && op !== 'update' && op !== 'remove') throw new McpUserError('op is add, update or remove')
  const fields: Obj = {}
  for (const k of ['module', 'name', 'sessions_per_week', 'season', 'days']) if (args[k] !== undefined) fields[k] = args[k]
  const plan = await planActivity(store, { op, activity_id: str(args.activity_id, 40), fields })
  if (!plan.ok) return `Refused: ${plan.text}`
  const rationale = str(args.rationale, 500)
  const previewId = await storeChangePreview(store, actor, ACTIVITY_TOOL, plan.state, { rationale, targetId: plan.state.request.activity_id })
  const { before, after } = plan.state
  return [
    `# Preview: ${op} activity`,
    op === 'add'
      ? `+ ${after.name} (${MODULES[after.module].label}), ${after.sessions_per_week}×/wk, ${after.season}-season${after.days.length ? `, days ${after.days.join(',')}` : ''}`
      : op === 'remove'
        ? `− ${before!.name} (set inactive; nothing deleted)`
        : `~ ${before!.name}: ${json({ before, after })}`,
    'Nothing was written. Applying it makes a re-compose due; the apply returns a fresh block preview for the athlete.',
    '',
    json({ preview_id: previewId, diff: plan.state }),
    '',
    previewFooter(previewId),
  ].join('\n')
}

async function storedPreview<T>(store: ConnectedStore, tool: string, previewId: string): Promise<{ state: T; rationale: string | null; actor_type: ChangeActor['type'] } | null> {
  const [p] = await store.sql<{ diff: unknown; rationale: string | null; actor_type: ChangeActor['type'] }[]>`
    SELECT diff, rationale, actor_type FROM change_preview
    WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId} AND tool = ${tool}
    LIMIT 1
  `
  if (!p) return null
  const state = asJson<T | null>(p.diff, null)
  return state ? { state, rationale: p.rationale, actor_type: p.actor_type } : null
}

async function applyActivity(store: ConnectedStore, args: Obj, actor: ChangeActor): Promise<string> {
  if (args.confirm !== true) return `Refused: ${ACTIVITY_TOOL} requires confirm=true. Preview first, show the athlete, then apply.`
  const previewId = str(args.preview_id, 80)
  if (!previewId) return 'Refused: preview_id is required. Call preview_activity_change first.'
  const stored = await storedPreview<ActivityState>(store, ACTIVITY_TOOL, previewId)
  if (!stored?.state.request) return `Refused: no ${ACTIVITY_TOOL} preview with that id on this athlete. Preview again.`
  const plan = await planActivity(store, stored.state.request)
  if (!plan.ok) return `Refused: ${plan.text} Preview again.`
  const auth = await authorizeWrite(store, actor, ACTIVITY_TOOL, args, plan.state)
  if (!auth.ok) return auth.text
  const changeId = crypto.randomUUID()
  const { request, after } = plan.state
  try {
    const text = await commitAuthorized(store, actor, ACTIVITY_TOOL, auth, stored.rationale, ruleRefsFrom(stored.rationale), async () => {
      let id = request.activity_id
      if (request.op === 'add') {
        const [row] = await store.sql<{ id: string }[]>`
          INSERT INTO activity (athlete_id, module_key, name, sessions_per_week, season, days, active, change_id)
          VALUES (${store.athleteId}, ${after.module}, ${after.name}, ${after.sessions_per_week}, ${after.season},
                  ${daysLiteral(after.days)}::smallint[], true, ${changeId})
          RETURNING id::text AS id
        `
        id = row.id
      } else {
        const done = await store.sql<{ id: string }[]>`
          UPDATE activity SET module_key = ${after.module}, name = ${after.name}, sessions_per_week = ${after.sessions_per_week},
                 season = ${after.season}, days = ${daysLiteral(after.days)}::smallint[], active = ${after.active},
                 change_id = ${changeId}, updated_at = NOW()
          WHERE id = ${id} AND athlete_id = ${store.athleteId}
          RETURNING id::text AS id
        `
        if (!done.length) throw new McpUserError('Refused: that activity changed since the preview. Preview again.')
      }
      return {
        result: `${request.op === 'add' ? 'Added' : request.op === 'remove' ? 'Removed' : 'Updated'} ${after.name}. change_id: ${changeId}`,
        entry: { id: changeId, targetType: 'activity', targetId: id, diff: { op: request.op, activity_id: id, before: plan.state.before, after }, rationale: stored.rationale },
      }
    })
    // Section 4 rule 6: an activity added or removed re-composes. The result is a preview, never applied.
    const recomposed = await previewBlock(store, {}, actor).catch(() => null)
    return recomposed ? `${text}\n\nRe-composed (an activity changed):\n${recomposed}` : text
  } catch (e) {
    if (e instanceof McpUserError) return e.message
    throw e
  }
}

// ---- composed block ----------------------------------------------------------------------------------------

/** Keep a composed-block preview. Internal requests (intake) may carry screens and intake_id. */
export async function previewBlockState(
  store: ConnectedStore,
  req: BlockRequest,
  actor: ChangeActor,
  rationale: string | null,
): Promise<{ preview_id: string; state: BlockState }> {
  const state = await planBlock(store, req)
  const previewId = await storeChangePreview(store, actor, BLOCK_TOOL, state, { rationale, targetId: 'block' })
  return { preview_id: previewId, state }
}

async function previewBlock(store: ConnectedStore, args: Obj, actor: ChangeActor): Promise<string> {
  const parsed = parseBlockRequest(args, await athleteToday(store))
  if (!parsed.ok) return `Refused: ${parsed.text}`
  const rationale = str(args.rationale, 500)
  const { preview_id, state } = await previewBlockState(store, parsed.request, actor, rationale)
  const b = await seesHealth(store, actor) ? state.block : redactHealth(state.block)
  return [
    `# Preview: composed block ${b.start} → ${b.end}`,
    `Priorities: ${b.priorities.map((q) => QUALITY_LABEL[q]).join(', ') || 'none (everything at maintenance)'}`,
    ...weekLines(b),
    `Deload ${b.deload_week.start}; retest ${b.retest_week.start} → ${b.retest_week.end}.`,
    ...(b.trade_offs.length
      ? ['', '## Trade-offs for the athlete to pick', ...b.trade_offs.map((t) => `- ${t.id}: ${t.message} Options: ${t.options.map((o) => `${o.id} (${o.label})`).join('; ')}.${t.chosen ? ` Picked: ${t.chosen}.` : ''}`)]
      : []),
    ...(b.needs_decision ? ['', 'Not appliable yet: the athlete picks each trade-off first. Preview again with resolutions = { <trade-off id>: <option id> }.'] : []),
    'Nothing was written.',
    '',
    json({ preview_id, block: blockSummary(b), methodology_version: state.methodology_version, modules_version: state.modules_version }),
    '',
    previewFooter(preview_id),
  ].join('\n')
}

const TRACK_COLOR: Record<string, string> = {
  max_strength: '#E5484D', other_lifts: '#9A9A9A', power: '#F5A524', aerobic: '#30A46C', alactic: '#0090FF',
  change_of_direction: '#8E4EC6', tissue_capacity: '#12A594', mobility: '#6E56CF',
}

async function applyBlock(store: ConnectedStore, args: Obj, actor: ChangeActor): Promise<string> {
  if (args.confirm !== true) return `Refused: ${BLOCK_TOOL} requires confirm=true. Preview first, show the athlete, then apply.`
  const previewId = str(args.preview_id, 80)
  if (!previewId) return 'Refused: preview_id is required. Call preview_composed_block first.'
  const stored = await storedPreview<BlockState>(store, BLOCK_TOOL, previewId)
  if (!stored?.state.request) return `Refused: no ${BLOCK_TOOL} preview with that id on this athlete. Preview again.`
  // Every rule again, against the athlete as they are now: the approval and
  // the diff first, then the athlete's picks.
  const plan = await planBlock(store, stored.state.request)
  const auth = await authorizeWrite(store, actor, BLOCK_TOOL, args, plan)
  if (!auth.ok) return auth.text
  if (plan.block.needs_decision) {
    const open = plan.block.trade_offs.filter((t) => t.chosen == null).map((t) => t.id)
    return `Refused: the athlete has not picked ${open.join(', ')} yet. The engine never decides a trade-off for them (section 4); preview again with resolutions.`
  }
  const req = plan.request
  const b = plan.block
  const changeId = crypto.randomUUID()
  const blockId = crypto.randomUUID()
  try {
    const text = await commitAuthorized(store, actor, BLOCK_TOOL, auth, stored.rationale, b.rule_refs, async () => {
      const diff: Obj = { block_id: blockId, start: b.start, end: b.end, priorities: b.priorities, methodology_version: plan.methodology_version, modules_version: plan.modules_version }

      // Activities and goals the request added (intake), and goal weights.
      const activitiesAdded: string[] = []
      for (const a of req.add_activities ?? []) {
        const [row] = await store.sql<{ id: string }[]>`
          INSERT INTO activity (athlete_id, module_key, name, sessions_per_week, season, days, active, change_id)
          VALUES (${store.athleteId}, ${a.module}, ${a.name}, ${a.sessions_per_week}, ${a.season}, ${daysLiteral(a.days)}::smallint[], true, ${changeId})
          RETURNING id::text AS id
        `
        activitiesAdded.push(row.id)
      }
      if (activitiesAdded.length) diff.activities_added = activitiesAdded
      const goalIds = new Map<string, string>()
      const goalsAdded: string[] = []
      const weighted: Obj[] = []
      for (const g of b.goals) {
        const fromReq = (req.add_goals ?? []).find((x) => x.name.toLowerCase() === g.name.toLowerCase())
        if (g.id && UUID_RE.test(g.id)) {
          const [was] = await store.sql<{ weight: string | null; quality: string | null }[]>`
            SELECT weight, quality FROM athlete_goal WHERE id = ${g.id} AND athlete_id = ${store.athleteId}
          `
          if (!was) throw new McpUserError('Refused: a goal changed since the preview. Preview again.')
          const quality = g.quality ?? null
          if (was.weight !== g.requested || (was.quality ?? null) !== quality) {
            await store.sql`
              UPDATE athlete_goal SET weight = ${g.requested}, quality = ${quality}, updated_at = NOW()
              WHERE id = ${g.id} AND athlete_id = ${store.athleteId}
            `
            weighted.push({ goal_id: g.id, before: { weight: was.weight, quality: was.quality }, after: { weight: g.requested, quality } })
          }
          goalIds.set(g.name.toLowerCase(), g.id)
        } else if (fromReq) {
          const [row] = await store.sql<{ id: string }[]>`
            INSERT INTO athlete_goal (athlete_id, name, metric, unit, direction, target, baseline, current, due_date, test_protocol, status, weight, quality)
            VALUES (${store.athleteId}, ${fromReq.name}, ${fromReq.test ?? fromReq.name}, ${fromReq.unit ?? null}, ${fromReq.direction ?? 'higher'},
                    ${fromReq.target ?? null}, ${fromReq.current ?? null}, ${fromReq.current ?? null}, ${fromReq.due_date ?? null},
                    ${fromReq.test ?? null}, 'on_track', ${g.requested}, ${g.quality ?? null})
            ON CONFLICT (athlete_id, name) DO NOTHING
            RETURNING id::text AS id
          `
          if (!row) throw new McpUserError(`Refused: a goal named "${fromReq.name}" appeared since the preview. Preview again.`)
          goalsAdded.push(row.id)
          goalIds.set(g.name.toLowerCase(), row.id)
        }
      }
      // Screens become monthly goals so their baselines and retests have somewhere to go (section 5).
      const screenGoals: string[] = []
      for (const s of b.screens) {
        const def = SCREENS[s.key]
        const [row] = await store.sql<{ id: string }[]>`
          INSERT INTO athlete_goal (athlete_id, name, metric, unit, side, direction, test_protocol, cadence, status, weight, quality)
          VALUES (${store.athleteId}, ${`Screen: ${def.name}`}, ${def.key}, ${def.unit === 'pass' ? null : def.unit},
                  ${def.sided ? 'both' : 'none'}, ${def.direction}, ${def.name}, 'monthly', 'on_track', 'maintenance',
                  ${def.regions.some((r) => ['achilles', 'hamstring', 'groin', 'shin'].includes(r)) ? 'tissue_capacity' : 'mobility'})
          ON CONFLICT (athlete_id, name) DO NOTHING
          RETURNING id::text AS id
        `
        if (row) screenGoals.push(row.id)
      }
      if (goalsAdded.length) diff.goals_added = goalsAdded
      if (screenGoals.length) diff.screen_goals_added = screenGoals
      if (weighted.length) diff.goals_weighted = weighted

      // The program: tracks (created or re-purposed), a progression rule each from the block start, block dates.
      const [program] = await store.sql<{ id: string }[]>`
        SELECT id::text AS id FROM program WHERE athlete_id = ${store.athleteId} AND status = 'active' LIMIT 1
      `
      if (program) {
        const tracksOut: Obj[] = []
        // D3: a track's purpose is program data every coach reads, so it never
        // names a red-flagged region; the block of record keeps the full why.
        const safeWhy = new Map(redactHealth(b).tracks.map((t) => [t.name, t.why]))
        for (const t of b.tracks) {
          const purpose = `${t.role === 'priority' ? 'Priority' : t.role === 'maintenance' ? 'Maintenance' : 'Minimum dose'} this block. ${safeWhy.get(t.name) ?? ''}`.trim().slice(0, 500)
          const [existing] = await store.sql<{ id: string; purpose: string | null }[]>`
            SELECT id::text AS id, purpose FROM track WHERE program_id = ${program.id} AND lower(name) = ${t.name.toLowerCase()} LIMIT 1
          `
          let trackId = existing?.id ?? null
          if (existing) {
            await store.sql`UPDATE track SET purpose = ${purpose} WHERE id = ${existing.id} AND program_id = ${program.id}`
          } else {
            const [row] = await store.sql<{ id: string }[]>`
              INSERT INTO track (program_id, name, color, icon, sort_order, purpose)
              SELECT ${program.id}, ${t.name}, ${TRACK_COLOR[t.quality] ?? '#9A9A9A'}, 'circle',
                     COALESCE((SELECT MAX(sort_order) + 1 FROM track WHERE program_id = ${program.id}), 1), ${purpose}
              WHERE EXISTS (SELECT 1 FROM program WHERE id = ${program.id} AND athlete_id = ${store.athleteId})
              RETURNING id::text AS id
            `
            trackId = row.id
          }
          // Rules still open at the block start end the day before it (a rule a
          // superseded block started on the same day ends before it began).
          const ended = await store.sql<{ id: string }[]>`
            UPDATE progression_rule SET active_to = (${b.start}::date - 1)
            WHERE track_id = ${trackId} AND program_id = ${program.id} AND (active_to IS NULL OR active_to >= ${b.start}::date)
            RETURNING id::text AS id
          `
          const [rule] = await store.sql<{ id: string }[]>`
            INSERT INTO progression_rule (program_id, track_id, exercise_name, engine_type, params, active_from)
            VALUES (${program.id}, ${trackId}, NULL, ${t.engine_type}, ${jsonParam(store.sql, { ...t.params, role: t.role, block_id: blockId })}, ${b.start}::date)
            RETURNING id::text AS id
          `
          tracksOut.push({
            track_id: trackId, name: t.name, role: t.role, created: !existing, purpose_before: existing?.purpose ?? null,
            rule_id: rule.id, ended_rules: ended.map((r) => r.id).sort(),
          })
        }
        for (const g of b.goals) {
          const id = goalIds.get(g.name.toLowerCase())
          const track = tracksOut.find((t) => t.name === g.track)
          if (id && track) {
            await store.sql`
              UPDATE athlete_goal SET track_id = ${String(track.track_id)}
              WHERE id = ${id} AND athlete_id = ${store.athleteId} AND track_id IS NULL
            `
          }
        }
        const metaBefore = await programMetaSnapshot(store, program.id)
        await store.sql`
          UPDATE program SET block_phase = 'build', end_date = ${b.end}::date, deload_week_start = ${b.deload_week.start}::date,
                 retest_start = ${b.retest_week.start}::date, retest_end = ${b.retest_week.end}::date
          WHERE id = ${program.id} AND athlete_id = ${store.athleteId}
        `
        diff.program_id = program.id
        diff.tracks = tracksOut
        diff.program_meta = { before: metaBefore, after: await programMetaSnapshot(store, program.id) }
      } else {
        diff.program_id = null
      }

      // The block of record. Its key is what the rows say now, so the next
      // re-compose check compares like with like.
      const prior = await currentBlock(store)
      const key = (await composeFor(store, {})).key
      await store.sql`
        INSERT INTO composed_block (
          id, athlete_id, program_id, start_date, end_date, methodology_version, modules_version, compose_key, block, request,
          intake_id, preview_id, approval_ref, change_id, actor_type, actor_id
        ) VALUES (
          ${blockId}, ${store.athleteId}, ${program?.id ?? null}, ${b.start}::date, ${b.end}::date, ${plan.methodology_version},
          ${plan.modules_version}, ${key}, ${jsonParam(store.sql, b)}, ${jsonParam(store.sql, req)},
          ${req.intake_id && UUID_RE.test(req.intake_id) ? req.intake_id : null}, ${auth.previewId}, ${auth.approvalRef}, ${changeId},
          ${actor.type}, ${actor.id}
        )
      `
      if (prior) {
        await store.sql`
          UPDATE composed_block SET superseded_at = NOW(), superseded_by = ${blockId}
          WHERE id = ${prior.id} AND athlete_id = ${store.athleteId} AND superseded_at IS NULL
        `
        diff.superseded = prior.id
      }
      return {
        result: [
          `Applied the composed block ${b.start} → ${b.end} (methodology ${plan.methodology_version}, ${plan.modules_version}).`,
          `Priorities: ${b.priorities.map((q) => QUALITY_LABEL[q]).join(', ') || 'none'}.`,
          ...(program ? [] : ['No active program, so no tracks or dates were written; the block of record is kept.']),
          `change_id: ${changeId}`,
        ].join('\n'),
        entry: { id: changeId, targetType: 'composed_block', targetId: blockId, diff, rationale: stored.rationale },
      }
    })
    // Section 5: screen baselines, as measurements (standing approval: logging).
    const logged = await logScreenBaselines(store, actor, req)
    return logged ? `${text}\nLogged ${logged} screen baseline${logged === 1 ? '' : 's'}.` : text
  } catch (e) {
    if (e instanceof McpUserError) return e.message
    throw e
  }
}

async function logScreenBaselines(store: ConnectedStore, actor: ChangeActor, req: BlockRequest): Promise<number> {
  let n = 0
  const gate = makeWriteGate(store, actor)
  const date = await athleteToday(store)
  for (const s of req.screens ?? []) {
    const def = SCREENS[s.key]
    if (!def) continue
    // The athlete entered it: source manual, marked as the intake baseline.
    // One failed baseline never undoes the block (already committed) or the others.
    try {
      await runTrackTool(store, 'log_goal_measurement', {
        goal: `Screen: ${def.name}`, value: s.value, side: s.side ?? undefined, date, confirm: true, source: 'manual',
        note: 'Intake baseline', client_key: `intake:${req.intake_id ?? 'mcp'}:${s.key}:${s.side ?? 'x'}`,
      }, null, gate)
      n++
    } catch (e) {
      console.error('[coach_v1] screen baseline', s.key, e instanceof Error ? e.message : String(e))
    }
  }
  return n
}

// ---- MCP ----------------------------------------------------------------------------------------------------

const activityProps = {
  module: { type: 'string', enum: ['court', 'endurance', 'field', 'strength', 'general'], description: 'Activity module (get_activities lists the catalog).' },
  name: { type: 'string', description: 'What the athlete calls it, e.g. "Rec basketball".' },
  sessions_per_week: { type: 'integer', minimum: 0, maximum: 14 },
  season: { type: 'string', enum: ['in', 'off'] },
  days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0=Mon … 6=Sun.' },
}

const approvalProps = {
  preview_id: { type: 'string' },
  confirm: { type: 'boolean', description: 'Must be true.' },
  approval_ref: { type: 'string', description: 'tap:<approval id> or msg:<approval id> (from list_approvals).' },
}

export const ACTIVITY_TOOLS: McpTool[] = [
  {
    name: 'get_activities',
    description: 'The athlete\'s activities (sports, races, hobbies, lifting), the activity-module catalog (demands, screens, prehab, how a session counts as load), the composed block on file (priorities, week, versions) and whether a re-compose is due (block boundary, or an activity or goal added, removed or re-weighted).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'preview_activity_change',
    description: 'Preview adding, updating or removing ONE activity. Removing sets it inactive; nothing is deleted. Writes nothing; returns preview_id + diff. Apply with apply_activity_change after the athlete approves; the apply then returns a re-composed block preview.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'update', 'remove'] },
        activity_id: { type: 'string', description: 'For update/remove (get_activities).' },
        ...activityProps,
        rationale: { type: 'string', description: 'Why, in the athlete\'s terms. Cite the rule (U#).' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_activity_change',
    description: 'Write a previewed activity change. Requires confirm=true, the preview_id (under 24 h old, diff unchanged) and approval_ref = the athlete\'s approval of that preview in the app (list_approvals(preview_id)). Applies once, recorded in the change log. The in-app coach cannot apply.',
    inputSchema: { type: 'object', properties: approvalProps, required: ['preview_id', 'confirm', 'approval_ref'], additionalProperties: false },
  },
  {
    name: 'preview_composed_block',
    description: 'Compose the next block from the athlete\'s activities and goals (section 4): merged demands, max 2 priority qualities (U2), the activities counted as load (U9, U14), deduped prehab and screens, the week layout (U8, U9), deload and retest weeks (U11, U12). Conflicts come back as trade-offs the athlete picks; nothing is dropped silently. Optionally re-weight goals, add goals or activities, set the schedule, or pass the athlete\'s picks as resolutions. Writes nothing; returns preview_id + the block.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_weights: {
          type: 'array',
          items: { type: 'object', properties: { goal: { type: 'string', description: 'Goal id or name.' }, weight: { type: 'string', enum: ['priority', 'maintenance'] }, quality: { type: 'string', enum: ['max_strength', 'power', 'aerobic', 'alactic', 'change_of_direction', 'tissue_capacity', 'mobility'] } }, required: ['goal', 'weight'] },
        },
        add_goals: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, test: { type: 'string' }, target: { type: 'number' }, current: { type: 'number' }, unit: { type: 'string' }, due_date: { type: 'string' }, weight: { type: 'string', enum: ['priority', 'maintenance'] }, quality: { type: 'string' } }, required: ['name', 'weight'] },
        },
        add_activities: { type: 'array', items: { type: 'object', properties: activityProps, required: ['module', 'sessions_per_week'] } },
        schedule: {
          type: 'object',
          properties: { days_per_week: { type: 'integer', minimum: 1, maximum: 7 }, minutes_per_session: { type: 'integer', minimum: 20, maximum: 180 }, rest_days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } } },
        },
        training_age: { type: 'string', enum: TRAINING_AGES },
        resolutions: {
          type: 'object',
          description: 'The athlete\'s pick per trade-off id (interference, priority_cap, time_budget) → option id.',
          properties: { interference: { type: 'string' }, priority_cap: { type: 'string' }, time_budget: { type: 'string' } },
        },
        start: { type: 'string', description: 'Monday the block starts (default: the next one).' },
        rationale: { type: 'string', description: 'Why, in the athlete\'s terms. Cite the rule (U#).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'apply_composed_block',
    description: 'Write a previewed composed block: the block of record, any goals/activities it added, goal weights, tracks + progression rules from the block start, and the program\'s deload/retest dates. Refused while a trade-off is undecided. Requires confirm=true, the preview_id (under 24 h old, and the block recomputed now must equal it) and approval_ref = the athlete\'s approval of that preview (list_approvals(preview_id)). Applies once, recorded in the change log. The in-app coach cannot apply.',
    inputSchema: { type: 'object', properties: approvalProps, required: ['preview_id', 'confirm', 'approval_ref'], additionalProperties: false },
  },
]

export const ACTIVITY_TOOL_NAMES = new Set(ACTIVITY_TOOLS.map((t) => t.name))

export async function runActivityTool(store: ConnectedStore, name: string, args: Obj, actor: OverrideActor): Promise<string> {
  if (!(await tracksV1On(store)) || !(await coachV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  if (!(await coachTables(store))) return name === 'get_activities' ? coachUnavailable.replace(' Nothing was written.', '') : coachUnavailable
  switch (name) {
    case 'get_activities':
      return getActivities(store)
    case 'preview_activity_change':
      return previewActivity(store, args, actor)
    case ACTIVITY_TOOL:
      return applyActivity(store, args, actor)
    case 'preview_composed_block':
      return previewBlock(store, args, actor)
    case BLOCK_TOOL:
      return applyBlock(store, args, actor)
    default:
      throw new McpUserError(`Unknown tool: ${name}`)
  }
}

/** The athlete's own apply of a preview they just approved (their tap or chat yes is the approval). */
export async function athleteApplyPreview(store: ConnectedStore, previewId: string, approvalRef: string): Promise<{ ok: boolean; text: string } | null> {
  const [p] = await store.sql<{ tool: string }[]>`
    SELECT tool FROM change_preview WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId} LIMIT 1
  `
  if (!p || (p.tool !== BLOCK_TOOL && p.tool !== ACTIVITY_TOOL)) return null
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  const text = await runActivityTool(store, p.tool, { preview_id: previewId, confirm: true, approval_ref: approvalRef }, me)
  return { ok: /^(Applied|Added|Removed|Updated)\b/.test(text), text }
}
