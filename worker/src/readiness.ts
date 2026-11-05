/**
 * Manual readiness + pain check-in (G4, tracks_v1), the I/O half. The rules
 * are pure (readiness/rules.ts); the reads are in regionStatus.ts.
 *
 *   check-in       the athlete's own, from Today: sleep, stress, soreness, and
 *                  pain by region with red flags. Logging: standing approval,
 *                  one change_log row per submission. A pain report can move a
 *                  region's U7 status (region_status), in the same transaction.
 *   clear_region   the athlete marks a blocked region cleared by a clinician.
 *                  Athlete only; their tap is the approval; logged. No coach,
 *                  app_coach included, can ever clear a block. Under 18, or
 *                  with no age on file (section 11b), it also needs a parent
 *                  or guardian's confirmation, recorded in the row.
 *   clear_red_flag the same for the other kind of block: a red flag set in the
 *                  athlete's rules (methodology U7.regions.<region>.blocked,
 *                  G3). Supersedes that override; athlete only; logged. Each
 *                  clear says whether the other kind still blocks the region.
 *   health toggle  D3: per coach, whether it sees pain and check-in data. On
 *                  by default; the athlete's tap changes it; logged.
 *   coach role     D3: per coach, read or propose (coachRoles.ts). Default
 *                  propose; the athlete's tap changes it; logged.
 *
 * MCP (flag on): get_checkins, get_region_status, get_weekly_review. A coach
 * without the health toggle gets a refusal for the first two and a review
 * without pain / check-in sections.
 *
 * Routes, the athlete's own session, 404 with the flag off:
 *   POST /api/readiness   { action: 'today' | 'checkin' | 'clear_region' | 'clear_red_flag' | 'age' | 'confirm_adult' | 'coach_access' | 'set_coach_health' | 'set_coach_role' | 'weekly_review' }
 *   GET  /api/weekly-review?week=YYYY-MM-DD
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { beginAuthCors, json } from './cors.ts'
import { withSql, type WaitUntil } from './db.ts'
import type { Env } from './env.ts'
import { resolveAthleteId, sessionFromRequest } from './data.ts'
import { ApprovalSpent, consumeApproval, directTapApproval } from './approvals.ts'
import { STANDING_LOGGING, voidDowngradedCoachWork, withTx, writeChange } from './changeLog.ts'
import { listCoachReads } from './coachReads.ts'
import { blockedRegions, loadOverrides, resolveMethodology, type OverrideRow, type Resolved } from './methodology.ts'
import { athleteAge } from './ageStatus.ts'
import { ageView, confirmAdult } from './adultConfirmation.ts'
import { CURRENT_METHODOLOGY, PAIN_REGIONS, type PainRegion } from './methodology/v1.ts'
import { resolveParams } from './methodology/resolve.ts'
import { isCoachRole, parseRole, type CoachRole } from './coachRoles.ts'
import {
  addDays, evaluateReport, isPainRegion, isRedFlag, readinessView, REFER_OUT, REFER_OUT_TEMPORARY, RED_FLAGS, regionLabel, u6Flags,
  type PainEntry, type ReadinessFlag, type ReadinessView, type RedFlag, type RegionEval,
} from './readiness/rules.ts'
import {
  blocksNow, loadCheckins, loadPain, loadRegionStatus, readinessTables, regionSessions, seesHealth, workoutDates,
  type PainRow, type RegionStatusRow,
} from './regionStatus.ts'

export { seesHealth }
import { athleteToday, tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { makeStore, type ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'
import { computeWeeklyReview, WEEKLY_REVIEW_TOOL } from './weeklyReview.ts'

export const readinessUnavailable = 'Check-ins are not set up on this database yet. Nothing was written.'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isAthlete(store: ConnectedStore, actor: OverrideActor): boolean {
  return actor.type === 'athlete' && actor.id === store.athleteId
}

/** What a guardian confirmed, as the change_log row records it. */
export interface GuardianConfirmation {
  guardian_confirmed: true
  confirmed_at: string
  name: string | null
  relationship: string | null
}

const guardianText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null)

/**
 * Section 11b: a minor, or an athlete whose age isn't on file, can't clear a
 * block alone. The app's second step ("A parent/guardian confirms a clinician
 * cleared this") sends `guardian: { confirmed: true, name?, relationship? }`.
 * Null for an adult (nothing extra asked or recorded, as before); otherwise
 * the confirmation to record, or the refusal.
 */
async function guardianFor(store: ConnectedStore, raw: unknown): Promise<{ ok: true; guardian: GuardianConfirmation | null } | { ok: false; text: string }> {
  const age = await athleteAge(store)
  if (!age.minorRules) return { ok: true, guardian: null }
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (g.confirmed !== true) {
    return {
      ok: false,
      text: age.status === 'minor'
        ? 'Refused: under 18, a parent or guardian has to confirm a clinician cleared this. Nothing changed.'
        : 'Refused: your age isn\'t on file, so the under-18 rules apply: a parent or guardian has to confirm a clinician cleared this (or confirm you\'re 18 or older in Profile). Nothing changed.',
    }
  }
  return { ok: true, guardian: { guardian_confirmed: true, confirmed_at: new Date().toISOString(), name: guardianText(g.name), relationship: guardianText(g.relationship) } }
}

// ---- the engine's view of a day ------------------------------------------------------

/** v1.2: a block that covers the day it was set and the next session, then lapses on its own. */
export interface TemporaryBlock {
  region: string
  /** The date of the report that set it. */
  since: string
  reason: string
}

export interface ReadinessContext {
  date: string
  flags: ReadinessFlag[]
  regions: RegionEval[]
  /** Methodology red flags ∪ open region_status blocks ∪ today's new blocks ∪ (v1.2) temporary blocks. */
  blocked: string[]
  /** v1.2: the regions in `blocked` only for a temporary block. Empty in v1 / v1.1 and under 18. */
  temporary: TemporaryBlock[]
  /**
   * Anything readiness has to say about this date: a check-in, a pain report,
   * or an open block. False: the prescription is exactly the G3 one.
   */
  active: boolean
  view: ReadinessView
}

interface PainCall {
  report: PainRow
  call: RegionEval
}

/**
 * U7 calls for the reports on `date`, and (v1.2, temporary blocks on) for
 * each report in the 14 days before it, each against its own day before and
 * earlier reports. In v1 / v1.1 only the day before matters.
 */
async function painCalls(store: ConnectedStore, date: string, methodology: Resolved): Promise<{ today: PainCall[]; earlier: PainCall[] }> {
  const p = methodology.params.U7
  const days = p.persistent_after?.within_days ?? 0
  const window = p.temporary_blocks ? days * 2 : days
  const pain = await loadPain(store, addDays(date, -Math.max(1, window)), date)
  const todays = pain.filter((x) => x.date === date)
  const earlier = p.temporary_blocks ? pain.filter((x) => x.date < date && x.date >= addDays(date, -days)) : []
  if (!todays.length && !earlier.length) return { today: [], earlier: [] }
  const adult = (await athleteAge(store)).status === 'adult' && !methodology.minor
  const callOf = (report: PainRow): PainCall => ({ report, call: evaluateReport(pain, report, p, adult) })
  return { today: todays.map(callOf), earlier: earlier.map(callOf) }
}

/** Today's U7 calls for the pain reported on `date`. */
async function regionCalls(store: ConnectedStore, date: string, methodology: Resolved): Promise<RegionEval[]> {
  return (await painCalls(store, date, methodology)).today.map((c) => c.call)
}

const after = (a: string | null | undefined, b: string) => a != null && Date.parse(a) > Date.parse(b)

/**
 * v1.2: temporary blocks in force on `date` — set by a report that day, or by
 * one on an earlier day with no session logged since (that day and the next
 * session). v1.3 (section 11c): only a session that loads the region ends it,
 * so an upper-body day leaves a knee block in place. Either way it lapses
 * after 14 days. A clinician clear after the report lifts it too.
 */
async function temporaryBlocks(store: ConnectedStore, date: string, calls: { today: PainCall[]; earlier: PainCall[] }, status: RegionStatusRow[], p: Resolved['params']['U7']): Promise<TemporaryBlock[]> {
  const temp = (c: PainCall) => c.call.status === 'blocked' && c.call.block === 'temporary'
    && !after(status.find((s) => s.region === c.report.region)?.cleared_at, c.report.created_at)
  const earlier = calls.earlier.filter(temp)
  const from = earlier.map((c) => c.report.date).sort()[0]
  const byRegion = p.temporary_ends_on === 'region_session'
  const sessions = !earlier.length ? []
    : byRegion ? await regionSessions(store, from, addDays(date, -1), [...new Set(earlier.map((c) => c.report.region))])
    : (await workoutDates(store, from, addDays(date, -1))).map((d) => ({ date: d, regions: null }))
  const ends = (c: PainCall) => sessions.some((x) => x.date > c.report.date && (x.regions == null || x.regions.includes(c.report.region)))
  const out = new Map<string, TemporaryBlock>()
  for (const c of [...earlier, ...calls.today.filter(temp)]) {
    if (c.report.date < date && ends(c)) continue
    out.set(c.report.region, { region: c.report.region, since: c.report.date, reason: c.call.reason })
  }
  return [...out.values()].sort((a, b) => a.region.localeCompare(b.region))
}

export async function readinessContextFor(store: ConnectedStore, date: string, methodology: Resolved): Promise<ReadinessContext> {
  const [checkins, calls, status] = await Promise.all([
    loadCheckins(store, addDays(date, -6), date),
    painCalls(store, date, methodology),
    loadRegionStatus(store),
  ])
  const open = status.filter(blocksNow).map((s) => s.region)
  // A block the athlete has since cleared (by a clinician) no longer blocks,
  // even though the report that set it still reads as a block.
  const regions = calls.today.map(({ report, call: c }): RegionEval => {
    const s = status.find((x) => x.region === c.region)
    return c.status === 'blocked' && s?.status === 'blocked' && after(s.cleared_at, report.created_at)
      ? { ...c, status: 'ok', refer_out: false, reason: `${regionLabel(c.region)} was cleared by a clinician after this report (U7).` }
      : c
  })
  const temporary = methodology.params.U7.temporary_blocks ? await temporaryBlocks(store, date, calls, status, methodology.params.U7) : []
  const persistent = [...new Set([
    ...blockedRegions(methodology), ...open,
    ...regions.filter((r) => r.status === 'blocked' && r.block !== 'temporary').map((r) => r.region),
  ])]
  const tempOnly = temporary.filter((t) => !persistent.includes(t.region))
  const blocked = [...new Set([...persistent, ...tempOnly.map((t) => t.region)])].sort()
  const flags = u6Flags(checkins, date, methodology.params.U6)
  const active = flags.length > 0 || regions.length > 0 || open.length > 0 || tempOnly.length > 0
  return {
    date,
    flags,
    regions,
    blocked,
    temporary: tempOnly,
    active,
    view: readinessView({ date, flags, regions, blocked, temporary: tempOnly.map((t) => t.region), params: methodology.params }),
  }
}

// ---- health-data visibility (D3) ----------------------------------------------------------

export const HEALTH_HIDDEN = 'The athlete has not shared check-in and pain data with you. Ask them to turn on health data for this coach in Profile.'

// ---- check-in (logging) --------------------------------------------------------------------

export interface CheckinResult {
  ok: boolean
  text: string
  date?: string
  change_id?: string
  regions?: RegionEval[]
  refer_out?: string | null
  readiness?: ReadinessView
}

function numIn(v: unknown, lo: number, hi: number, int: boolean): number | null | 'bad' {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) return 'bad'
  return n
}

interface ParsedCheckin {
  date: string
  sleep_hours: number | null
  stress: number | null
  soreness: number | null
  pain: Array<{ region: PainRegion; score: number; red_flags: RedFlag[] }>
}

function parseCheckin(body: Record<string, unknown>, today: string): ParsedCheckin | string {
  const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : today
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return 'date must be YYYY-MM-DD.'
  if (date > today) return 'A check-in can\'t be for a future day.'
  if (date < addDays(today, -6)) return 'A check-in can only be logged for the last 7 days.'
  const sleep = numIn(body.sleep_hours, 0, 24, false)
  const stress = numIn(body.stress, 1, 5, true)
  const soreness = numIn(body.soreness, 1, 5, true)
  if (sleep === 'bad') return 'sleep_hours must be 0–24.'
  if (stress === 'bad') return 'stress must be a whole number 1–5.'
  if (soreness === 'bad') return 'soreness must be a whole number 1–5.'
  const pain: ParsedCheckin['pain'] = []
  for (const raw of Array.isArray(body.pain) ? body.pain : []) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (!isPainRegion(p.region)) return `Unknown region. Regions: ${PAIN_REGIONS.join(', ')}.`
    const score = numIn(p.score, 0, 10, true)
    if (score === 'bad' || score == null) return 'Pain scores are whole numbers 0–10.'
    const flags = Array.isArray(p.red_flags) ? p.red_flags : []
    if (!flags.every(isRedFlag)) return `Unknown red flag. Red flags: ${RED_FLAGS.join(', ')}.`
    if (pain.some((x) => x.region === p.region)) return `${regionLabel(p.region)} is listed twice.`
    pain.push({ region: p.region, score, red_flags: [...new Set(flags as RedFlag[])] })
  }
  if (sleep == null && stress == null && soreness == null && !pain.length) return 'Nothing to log: give sleep, stress, soreness or a pain score.'
  return { date, sleep_hours: sleep, stress, soreness, pain }
}

/** The athlete's check-in: logged under standing approval, with any region status it moves. */
export async function saveCheckin(store: ConnectedStore, actor: OverrideActor, body: Record<string, unknown>): Promise<CheckinResult> {
  if (!isAthlete(store, actor)) return { ok: false, text: 'Refused: only the athlete logs their own check-in.' }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Check-ins are off for this athlete.' }
  if (!(await readinessTables(store))) return { ok: false, text: readinessUnavailable }
  const today = await athleteToday(store)
  const parsed = parseCheckin(body, today)
  if (typeof parsed === 'string') return { ok: false, text: `Refused: ${parsed}` }
  const methodology = await resolveMethodology(store)
  const changeId = crypto.randomUUID()

  return withTx(store.sql, async () => {
    let checkinId: string | null = null
    if (parsed.sleep_hours != null || parsed.stress != null || parsed.soreness != null) {
      const [row] = await store.sql<{ id: string }[]>`
        INSERT INTO checkin (athlete_id, date, sleep_hours, stress, soreness, change_id)
        VALUES (${store.athleteId}, ${parsed.date}::date, ${parsed.sleep_hours}, ${parsed.stress}, ${parsed.soreness}, ${changeId})
        RETURNING id::text AS id
      `
      checkinId = row.id
    }
    const painIds = new Map<string, string>()
    for (const p of parsed.pain) {
      const [row] = await store.sql<{ id: string }[]>`
        INSERT INTO pain_report (athlete_id, date, region, score, red_flags, checkin_id, change_id)
        VALUES (${store.athleteId}, ${parsed.date}::date, ${p.region}, ${p.score}, ${`{${p.red_flags.join(',')}}`}::text[], ${checkinId}, ${changeId})
        RETURNING id::text AS id
      `
      painIds.set(p.region, row.id)
    }
    // U7 for each region reported, against the day before.
    const calls = parsed.pain.length ? await regionCalls(store, parsed.date, methodology) : []
    const current = new Map((await loadRegionStatus(store)).map((s) => [s.region, s]))
    const moves: Array<{ region: string; from: string; to: string; reason: string }> = []
    // v1.2: a temporary block (that day and the next session) is derived from
    // the report itself, so it writes no region_status row; it lapses on its own.
    const temporary: Array<{ region: string; reason: string }> = []
    for (const c of calls.filter((x) => painIds.has(x.region))) {
      const now = current.get(c.region)
      // A block stays until the athlete clears it; a low score doesn't lift it.
      if (blocksNow(now)) continue
      if (c.status === 'blocked' && c.block === 'temporary') {
        temporary.push({ region: c.region, reason: c.reason })
        continue
      }
      const from = now && !(now.status === 'blocked' && now.cleared_at) ? now.status : 'ok'
      if (from === c.status) continue
      await store.sql`
        INSERT INTO region_status (athlete_id, region, status, reason, pain_report_id, change_id)
        VALUES (${store.athleteId}, ${c.region}, ${c.status}, ${c.reason}, ${painIds.get(c.region)!}, ${changeId})
      `
      moves.push({ region: c.region, from, to: c.status, reason: c.reason })
    }
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'log_checkin',
      targetType: 'checkin',
      targetId: parsed.date,
      diff: {
        date: parsed.date,
        checkin: checkinId ? { sleep_hours: parsed.sleep_hours, stress: parsed.stress, soreness: parsed.soreness } : null,
        pain: parsed.pain,
        regions: moves,
        ...(temporary.length ? { temporary_blocks: temporary } : {}),
      },
      rationale: null,
      ruleRefs: [...(checkinId ? ['U6'] : []), ...(parsed.pain.length ? ['U7'] : [])],
      approvalRef: STANDING_LOGGING,
      previewId: null,
    })
    const ctx = await readinessContextFor(store, parsed.date, methodology)
    const blockedNow = moves.filter((m) => m.to === 'blocked')
    const notes = [
      ...(blockedNow.length ? [blockedNow.map((m) => m.reason).join(' '), REFER_OUT] : []),
      ...(temporary.length ? [temporary.map((m) => m.reason).join(' '), REFER_OUT_TEMPORARY] : []),
    ]
    return {
      ok: true,
      text: notes.length ? `Logged. ${notes.join(' ')}` : 'Logged.',
      date: parsed.date,
      change_id: changeId,
      regions: calls,
      refer_out: ctx.view.refer_out,
      readiness: ctx.view,
    }
  })
}

// ---- clearing a block (athlete only) --------------------------------------------------------

export async function clearRegion(store: ConnectedStore, actor: OverrideActor, regionArg: unknown, guardianArg?: unknown): Promise<{ ok: boolean; text: string; change_id?: string }> {
  if (!isAthlete(store, actor)) {
    return { ok: false, text: 'Refused: only the athlete can mark a region cleared by a clinician. A coach can never clear a block.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Check-ins are off for this athlete.' }
  if (!(await readinessTables(store))) return { ok: false, text: readinessUnavailable }
  if (!isPainRegion(regionArg)) return { ok: false, text: 'Refused: unknown region.' }
  const region = regionArg
  const status = (await loadRegionStatus(store)).find((s) => s.region === region)
  if (!blocksNow(status)) return { ok: false, text: `The ${regionLabel(region)} isn't blocked.` }
  const g = await guardianFor(store, guardianArg)
  if (!g.ok) return g
  const methodology = await resolveMethodology(store)
  const stillFlagged = blockedRegions(methodology).includes(region)
  const changeId = crypto.randomUUID()
  const diff = {
    region, status_id: status!.id, blocked_since: status!.created_at, reason: status!.reason, cleared_by: `athlete:${store.athleteId}`,
    ...(g.guardian ? { guardian: g.guardian } : {}),
  }
  try {
    return await withTx(store.sql, async () => {
      const tap = await directTapApproval(store, 'app_editor', `region:${status!.id}`, diff)
      const done = await store.sql<{ id: string }[]>`
        UPDATE region_status SET cleared_at = NOW(), cleared_by = ${`athlete:${store.athleteId}`}, clear_change_id = ${changeId}
        WHERE id = ${status!.id} AND athlete_id = ${store.athleteId} AND status = 'blocked' AND cleared_at IS NULL
        RETURNING id::text AS id
      `
      if (!done.length) throw new McpUserError('That block changed since you opened it. Try again.')
      await writeChange(store, {
        id: changeId,
        actor,
        tool: 'clear_region',
        targetType: 'region',
        targetId: region,
        diff,
        rationale: g.guardian ? 'Cleared by a clinician; a parent or guardian confirmed it (under-18 rules).' : 'Cleared by a clinician.',
        ruleRefs: ['U7'],
        approvalRef: tap.ref,
        approvalId: tap.id,
      })
      if (!(await consumeApproval(store, tap.id, changeId))) throw new ApprovalSpent()
      return {
        ok: true,
        change_id: changeId,
        text: stillFlagged
          ? `Marked the ${regionLabel(region)} cleared. A red flag is also set on it in your rules (U7.regions.${region}.blocked); it stays blocked until you clear that too.`
          : `Marked the ${regionLabel(region)} cleared by a clinician. It can be loaded again.`,
      }
    })
  } catch (e) {
    if (e instanceof McpUserError) return { ok: false, text: e.message }
    throw e
  }
}

/** The active red flag on a region in the athlete's rules (G3): athlete-scoped, set to true. */
export function redFlagOverride(overrides: OverrideRow[], region: string): OverrideRow | null {
  return overrides.find((o) => o.path === `U7.regions.${region}.blocked` && o.track_id == null && o.value === true) ?? null
}

/**
 * The athlete marks a red flag in their rules cleared by a clinician: the
 * override row is superseded (methodology_override allows exactly that), with
 * the athlete's tap as the approval, logged in change_log. Like clearRegion:
 * athlete only, never a coach. The minors rules are not touched; a red flag
 * isn't one of them. Like the check-in clear, a minor (or an unknown age)
 * needs a guardian's confirmation too (section 11b).
 */
export async function clearRedFlag(store: ConnectedStore, actor: OverrideActor, regionArg: unknown, guardianArg?: unknown): Promise<{ ok: boolean; text: string; change_id?: string }> {
  if (!isAthlete(store, actor)) {
    return { ok: false, text: 'Refused: only the athlete can mark a red flag cleared by a clinician. A coach can never clear one.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Check-ins are off for this athlete.' }
  if (!isPainRegion(regionArg)) return { ok: false, text: 'Refused: unknown region.' }
  const region = regionArg
  const path = `U7.regions.${region}.blocked`
  const [overrides, age] = await Promise.all([loadOverrides(store), athleteAge(store)])
  const flag = redFlagOverride(overrides, region)
  if (!flag) return { ok: false, text: `There's no red flag on the ${regionLabel(region)} in your rules.` }
  const g = await guardianFor(store, guardianArg)
  if (!g.ok) return g
  const after = resolveParams(CURRENT_METHODOLOGY, overrides.filter((o) => o.id !== flag.id), { trackId: null, minor: age.minorRules })
  const ruleStill = blockedRegions(after).includes(region)
  const checkinStill = (await readinessTables(store)) && blocksNow((await loadRegionStatus(store)).find((s) => s.region === region))
  const changeId = crypto.randomUUID()
  const diff = {
    path,
    region,
    before: true,
    after: ruleStill,
    override_id: flag.id,
    set_by: flag.created_by,
    set_at: flag.created_at,
    cleared_by: `athlete:${store.athleteId}`,
    ...(g.guardian ? { guardian: g.guardian } : {}),
  }
  try {
    return await withTx(store.sql, async () => {
      const tap = await directTapApproval(store, 'app_editor', `red_flag:${flag.id}`, diff)
      const done = await store.sql<{ id: string }[]>`
        UPDATE methodology_override SET superseded_at = NOW()
        WHERE id = ${flag.id} AND athlete_id = ${store.athleteId} AND superseded_at IS NULL
        RETURNING id::text AS id
      `
      if (!done.length) throw new McpUserError('That red flag changed since you opened it. Try again.')
      await writeChange(store, {
        id: changeId,
        actor,
        tool: 'clear_red_flag',
        targetType: 'methodology',
        targetId: path,
        diff,
        rationale: g.guardian ? 'Cleared by a clinician; a parent or guardian confirmed it (under-18 rules).' : 'Cleared by a clinician.',
        ruleRefs: ['U7'],
        approvalRef: tap.ref,
        approvalId: tap.id,
      })
      if (!(await consumeApproval(store, tap.id, changeId))) throw new ApprovalSpent()
      return {
        ok: true,
        change_id: changeId,
        text: checkinStill
          ? `Cleared the red flag on the ${regionLabel(region)} in your rules. Your check-in still blocks it; it stays blocked until you mark that cleared too.`
          : `Cleared the red flag on the ${regionLabel(region)}. It can be loaded again.`,
      }
    })
  } catch (e) {
    if (e instanceof McpUserError) return { ok: false, text: e.message }
    throw e
  }
}

// ---- coach access (D3) -----------------------------------------------------------------------

export interface CoachAccessView {
  id: string
  name: string
  last_four: string
  share_health: boolean
  /** D3: read (read tools only) or propose. */
  role: CoachRole
  revoked_at: string | null
  last_used_at: string | null
}

export async function coachAccess(store: ConnectedStore): Promise<CoachAccessView[]> {
  // expires_at exists only on some databases (see mcpToken.ts), so read it through to_jsonb.
  const rows = await store.sql<{ id: string; name: string; last_four: string; share_health: boolean | null; role: string | null; revoked_at: string | null; last_used_at: string | null }[]>`
    SELECT t.id::text AS id, t.name, t.last_four, COALESCE((to_jsonb(t) ->> 'share_health')::boolean, true) AS share_health,
           to_jsonb(t) ->> 'role' AS role,
           COALESCE(to_json(t.revoked_at) #>> '{}', CASE WHEN (to_jsonb(t) ->> 'expires_at')::timestamptz <= NOW() THEN to_jsonb(t) ->> 'expires_at' END) AS revoked_at,
           to_json(t.last_used_at) #>> '{}' AS last_used_at
    FROM mcp_token t WHERE t.athlete_id = ${store.athleteId}
    ORDER BY t.created_at DESC
  `
  return rows.map((r) => ({ ...r, share_health: r.share_health !== false, role: parseRole(r.role) }))
}

export async function setCoachHealth(
  store: ConnectedStore,
  actor: OverrideActor,
  tokenId: unknown,
  on: unknown,
): Promise<{ ok: boolean; text: string; change_id?: string }> {
  if (!isAthlete(store, actor)) return { ok: false, text: 'Refused: only the athlete decides what a coach sees.' }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Off for this athlete.' }
  if (!(await readinessTables(store))) return { ok: false, text: readinessUnavailable }
  if (typeof tokenId !== 'string' || typeof on !== 'boolean') return { ok: false, text: 'token_id and on are required.' }
  const coach = (await coachAccess(store)).find((c) => c.id === tokenId && !c.revoked_at)
  if (!coach) return { ok: false, text: 'No such coach.' }
  if (coach.share_health === on) return { ok: true, text: 'Already set.' }
  const changeId = crypto.randomUUID()
  const diff = { coach: coach.name, token_id: coach.id, share_health: { before: coach.share_health, after: on } }
  return withTx(store.sql, async () => {
    const tap = await directTapApproval(store, 'app_editor', `coach_health:${coach.id}:${changeId}`, diff)
    await store.sql`UPDATE mcp_token SET share_health = ${on} WHERE id = ${coach.id} AND athlete_id = ${store.athleteId}`
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'set_coach_health_access',
      targetType: 'mcp_token',
      targetId: coach.id,
      diff,
      rationale: null,
      ruleRefs: [],
      approvalRef: tap.ref,
      approvalId: tap.id,
    })
    if (!(await consumeApproval(store, tap.id, changeId))) throw new ApprovalSpent()
    return { ok: true, change_id: changeId, text: on ? `${coach.name} can see your check-ins and pain.` : `${coach.name} no longer sees your check-ins and pain.` }
  })
}

/** True once worker/schema/coach-roles.sql is on this database. */
async function coachRolesReady(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mcp_token' AND column_name = 'role'
    ) AS ok
  `
  return row?.ok === true
}

export const coachRolesUnavailable = 'Coach roles are not set up on this database yet. Nothing changed.'

/**
 * D3: the athlete sets a coach to read (read tools only) or propose. A logged
 * athlete write with the athlete's tap as its approval, like the health
 * toggle. Down to read also voids the coach's open previews, parked proposals
 * and their approvals (section 11b), with a system row like a revoke's; back
 * to propose revives none of them. No coach can change a role: there is no tool for it, and /api/data
 * can't write the column.
 */
export async function setCoachRole(
  store: ConnectedStore,
  actor: OverrideActor,
  tokenId: unknown,
  role: unknown,
): Promise<{ ok: boolean; text: string; change_id?: string }> {
  if (!isAthlete(store, actor)) return { ok: false, text: 'Refused: only the athlete decides what a coach can do.' }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Off for this athlete.' }
  if (!(await coachRolesReady(store))) return { ok: false, text: coachRolesUnavailable }
  if (typeof tokenId !== 'string' || !isCoachRole(role)) return { ok: false, text: 'token_id and role (read | propose) are required.' }
  const coach = (await coachAccess(store)).find((c) => c.id === tokenId && !c.revoked_at)
  if (!coach) return { ok: false, text: 'No such coach.' }
  if (coach.role === role) return { ok: true, text: 'Already set.' }
  const changeId = crypto.randomUUID()
  const diff = { coach: coach.name, token_id: coach.id, role: { before: coach.role, after: role } }
  return withTx(store.sql, async () => {
    const tap = await directTapApproval(store, 'app_editor', `coach_role:${coach.id}:${changeId}`, diff)
    const done = await store.sql<{ id: string }[]>`
      UPDATE mcp_token SET role = ${role}
      WHERE id = ${coach.id} AND athlete_id = ${store.athleteId} AND revoked_at IS NULL
      RETURNING id::text AS id
    `
    if (!done.length) throw new McpUserError('No such coach.')
    await writeChange(store, {
      id: changeId,
      actor,
      tool: 'set_coach_role',
      targetType: 'mcp_token',
      targetId: coach.id,
      diff,
      rationale: null,
      ruleRefs: [],
      approvalRef: tap.ref,
      approvalId: tap.id,
    })
    if (!(await consumeApproval(store, tap.id, changeId))) throw new ApprovalSpent()
    // Section 11b (D3): down to read voids its open previews and proposals, like a revoke.
    const work = role === 'read' ? await voidDowngradedCoachWork(store, coach, changeId) : null
    const n = work ? work.voided_previews.length + (work.voided_proposals?.length ?? 0) : 0
    return {
      ok: true,
      change_id: changeId,
      text: role === 'read'
        ? `${coach.name} can now only read. It can't preview or propose changes.${n ? ` Its open previews and proposals (${n}) were voided.` : ''}`
        : `${coach.name} can now propose changes. You still approve every one.`,
    }
  }).catch((e: unknown) => {
    if (e instanceof McpUserError) return { ok: false, text: e.message }
    throw e
  })
}

// ---- MCP ----------------------------------------------------------------------------------

export const READINESS_TOOLS: McpTool[] = [
  {
    name: 'get_checkins',
    description: 'The athlete\'s manual daily check-ins (sleep hours, stress 1–5, soreness 1–5) and pain by region (0–10, with any red flags), latest per day, plus today\'s readiness flags (U6). Health data: only if the athlete shares it with you. Read-only; the athlete logs these themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        until: { type: 'string', description: 'YYYY-MM-DD, inclusive (default today).' },
      },
      required: ['since'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_region_status',
    description: 'Each body region\'s pain status (U7): ok, capped (4–5: regress load, drop impact) or blocked (> 5, worse the next morning — above the day before and ≥ 4 — or a red flag: no loading there and refer out). A block with block "temporary" covers that day and the next session, then lapses on its own. Any other block (a red flag, > 5 twice within 14 days, a rating rising across 3 sessions; every block under 18) stays until the athlete marks it cleared by a clinician; no coach can clear one. Health data: only if the athlete shares it with you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  WEEKLY_REVIEW_TOOL,
]

export const READINESS_TOOL_NAMES = new Set(READINESS_TOOLS.map((t) => t.name))

async function regionStatusView(store: ConnectedStore, methodology: Resolved) {
  const today = await athleteToday(store)
  const [status, pain, ctx] = await Promise.all([
    loadRegionStatus(store), loadPain(store, addDays(today, -13), today), readinessContextFor(store, today, methodology),
  ])
  const latest = new Map<string, PainEntry>()
  for (const p of pain) latest.set(p.region, p)
  const temporary = new Map(ctx.temporary.map((t) => [t.region, t]))
  const regions = [...new Set([...status.map((s) => s.region), ...latest.keys(), ...blockedRegions(methodology), ...temporary.keys()])].sort()
  const flagged = new Set(blockedRegions(methodology))
  return regions.map((region) => {
    const s = status.find((x) => x.region === region)
    const open = blocksNow(s)
    const p = latest.get(region) ?? null
    // v1.2: blocked today and the next session, then it lapses; no clinician clear needed.
    const temp = !open && !flagged.has(region) ? temporary.get(region) : undefined
    return {
      region,
      status: open || flagged.has(region) || temp ? 'blocked' : s && s.status !== 'blocked' && p?.date === today ? s.status : 'ok',
      reason: open ? s!.reason : flagged.has(region) ? 'Red flag set in the athlete\'s rules (U7.regions).' : temp ? temp.reason : s?.reason ?? null,
      since: open ? s!.created_at : temp ? temp.since : null,
      ...(temp ? { block: 'temporary', lapses: 'after the next session' } : {}),
      last_cleared: s?.cleared_at ? { at: s.cleared_at, by: 'the athlete (cleared by a clinician)' } : null,
      latest_score: p ? { date: p.date, score: p.score, red_flags: p.red_flags } : null,
    }
  })
}

export async function runReadinessTool(store: ConnectedStore, name: string, args: Record<string, unknown>, actor: OverrideActor): Promise<string> {
  if (!(await tracksV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  const health = await seesHealth(store, actor)
  if (name === 'get_weekly_review') {
    const out = await computeWeeklyReview(store, { week: args.week, showHealth: health })
    if ('error' in out) throw new McpUserError(out.error)
    return JSON.stringify(out, null, 2)
  }
  if (!READINESS_TOOL_NAMES.has(name)) throw new McpUserError(`Unknown tool: ${name}`)
  if (!health) return HEALTH_HIDDEN
  if (!(await readinessTables(store))) return readinessUnavailable.replace(' Nothing was written.', '')
  const methodology = await resolveMethodology(store)
  if (name === 'get_region_status') {
    const regions = await regionStatusView(store, methodology)
    const blocked = regions.filter((r) => r.status === 'blocked').map((r) => r.region)
    const persistent = regions.some((r) => r.status === 'blocked' && !('block' in r))
    const referOut = persistent ? REFER_OUT : blocked.length ? REFER_OUT_TEMPORARY : null
    return JSON.stringify({ regions, blocked_regions: blocked, refer_out: referOut, pain_cap: methodology.params.U7.pain_cap }, null, 2)
  }
  const today = await athleteToday(store)
  const since = typeof args.since === 'string' ? args.since.trim().slice(0, 10) : ''
  const until = typeof args.until === 'string' && args.until.trim() ? args.until.trim().slice(0, 10) : today
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) throw new McpUserError('since (and until) must be YYYY-MM-DD')
  const [checkins, pain, ctx] = await Promise.all([
    loadCheckins(store, since, until),
    loadPain(store, since, until),
    readinessContextFor(store, today, methodology),
  ])
  return JSON.stringify({
    since,
    until,
    checkins: checkins.map(({ date, sleep_hours, stress, soreness }) => ({ date, sleep_hours, stress, soreness })),
    pain: pain.map(({ date, region, score, red_flags }) => ({ date, region, score, red_flags })),
    today: { date: today, flags: ctx.flags, level: ctx.view.level, blocked_regions: ctx.blocked },
  }, null, 2)
}

// ---- app routes -----------------------------------------------------------------------------

/** The route's body (POST /api/readiness), separated so checks can drive it without an auth cookie. */
export async function athleteReadinessAction(store: ConnectedStore, body: Record<string, unknown>): Promise<[unknown, number]> {
  if (!(await tracksV1On(store))) return [{ error: 'not found' }, 404]
  const me: OverrideActor = { type: 'athlete', id: store.athleteId }
  switch (body.action) {
    case 'today': {
      const today = await athleteToday(store)
      const date = typeof body.date === 'string' && DATE_RE.test(body.date) ? body.date : today
      const methodology = await resolveMethodology(store)
      const [checkins, pain, ctx, status, overrides, age] = await Promise.all([
        loadCheckins(store, date, date),
        loadPain(store, date, date),
        readinessContextFor(store, date, methodology),
        loadRegionStatus(store),
        loadOverrides(store),
        athleteAge(store),
      ])
      const flagged = new Set(blockedRegions(methodology))
      const openRegions = new Set(status.filter(blocksNow).map((s) => s.region))
      return [{
        date,
        available: await readinessTables(store),
        checkin: checkins[0] ?? null,
        pain,
        readiness: ctx.view,
        blocked: status.filter(blocksNow).map((s) => ({
          region: s.region, reason: s.reason, since: s.created_at, kind: 'checkin', also_rule: flagged.has(s.region),
        })),
        // The other kind of block: red flags in the athlete's rules (G3), cleared with clear_red_flag.
        rule_blocked: [...flagged].flatMap((region) => {
          const o = redFlagOverride(overrides, region)
          return o ? [{ region, reason: o.rationale, since: o.created_at, kind: 'rule', also_checkin: openRegions.has(region) }] : []
        }),
        // v1.2: blocks that lapse after the next session. Nothing to clear.
        temporary_blocked: ctx.temporary,
        // Section 11b: under 18, or no age on file, a clear also needs a parent or guardian's confirmation.
        guardian_required: age.minorRules,
        regions: PAIN_REGIONS,
        red_flags: RED_FLAGS,
      }, 200]
    }
    case 'checkin':
      return [await saveCheckin(store, me, body), 200]
    case 'clear_region':
      return [await clearRegion(store, me, body.region, body.guardian), 200]
    case 'clear_red_flag':
      return [await clearRedFlag(store, me, body.region, body.guardian), 200]
    // Section 11b: the athlete's age status, and their own "I'm 18 or older".
    case 'age':
      return [await ageView(store), 200]
    case 'confirm_adult':
      return [await confirmAdult(store, me, { source: body.source === 'intake' ? 'intake' : 'profile' }), 200]
    case 'coach_access':
      return [{ coaches: (await coachAccess(store)).filter((c) => !c.revoked_at), reads: await listCoachReads(store, typeof body.limit === 'number' ? body.limit : 50) }, 200]
    case 'set_coach_health':
      return [await setCoachHealth(store, me, body.token_id, body.on), 200]
    case 'set_coach_role':
      return [await setCoachRole(store, me, body.token_id, body.role), 200]
    case 'weekly_review': {
      const out = await computeWeeklyReview(store, { week: body.week, showHealth: true })
      return 'error' in out ? [out, 400] : [out, 200]
    }
    default:
      return [{ error: 'unknown action' }, 400]
  }
}

/** POST /api/readiness, GET /api/weekly-review?week= — the athlete's own session; same auth as /api/session-rx. */
export async function handleReadiness(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const started = beginAuthCors(req.headers.get('Origin'), env)
  if (!started.ok) return started.response
  const cors = started.cors
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  const review = /\/weekly-review\/?$/.test(url.pathname)
  let body: Record<string, unknown>
  if (review) {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors)
    body = { action: 'weekly_review', week: url.searchParams.get('week') ?? undefined }
  } else {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)
    try {
      body = await req.json() as Record<string, unknown>
    } catch {
      return json({ error: 'invalid json' }, 400, cors)
    }
  }
  try {
    return await withSql(env, async (sql) => {
      const user = await sessionFromRequest(sql, req, env.BETTER_AUTH_SECRET)
      if (!user) return json({ error: 'unauthorized' }, 401, cors)
      const athleteId = await resolveAthleteId(sql, user.id)
      if (!athleteId) return json({ error: 'unauthorized' }, 401, cors)
      const [out, status] = await athleteReadinessAction(makeStore(sql, athleteId, 'lb'), body)
      return json(out, status, cors)
    }, waitUntil)
  } catch {
    return json({ error: 'readiness request failed' }, 500, cors)
  }
}
