/**
 * The weekly review (G8, U15, tracks_v1): computed by the engine for one
 * week, read-only. Compliance (planned vs logged sessions, target ≥ 80%),
 * each priority lift's e1RM trend, whether maintenance lifts held (U12), the
 * pain trend, check-in averages, and a call — progress, hold or deload — with
 * the rules behind it and one line of why.
 *
 * The call, first match wins:
 *   deload  compliance under the U11 trigger (70%), a priority lift's e1RM
 *           down 2 sessions in a row, or U6 flags on 5+ days (U11)
 *   hold    compliance under target (U15), a region blocked or over its cap
 *           this week (U7), U6 flags on 3+ days, or a priority lift down (U5)
 *   progress  otherwise (U5, U15)
 *
 * Priority lifts: the main lifts in the live week whose progression rule is
 * not 'maintenance'. Maintenance lifts: exercises under a 'maintenance' rule.
 * Pain and check-in sections are health data (D3): a coach the athlete hasn't
 * shared it with gets them as null, and a why line that doesn't name them.
 *
 * Session load (G9): Σ session RPE × minutes this week against the mean of the
 * 4 weeks before (Foster). Additive: it informs, it doesn't move the call. It
 * comes from the athlete's session-RPE taps, so it is health data too.
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import { canonicalLiftId, estimateE1rm, type E1rmMethod } from '../../src/engine/liftModel.ts'
import { readLoggedExercises } from '../../src/engine/loggedSets.ts'
import { mcpStamp } from '../../src/engine/mcpStamp.ts'
import { topWorkingSet } from '../../supabase/functions/_shared/zeroedFormat.ts'
import { resolveMethodology, blockedRegions } from './methodology.ts'
import { addDays, u6Flags, type CheckinDay } from './readiness/rules.ts'
import { blockedDuring, loadCheckins, loadPain } from './regionStatus.ts'
import { athleteToday } from './sessionOverride.ts'
import { sessionLoadForWeek, type SessionLoadView } from './sessionRpe.ts'
import { calendarZone, loadLiveProgram, loadWorkouts, type ConnectedStore } from './store.ts'

export type WeeklyCall = 'progress' | 'hold' | 'deload'

export interface LiftTrend {
  lift: string
  /** Best e1RM logged this week, and in the 3 weeks before. */
  e1rm_week: number | null
  e1rm_prior: number | null
  /** U4: how each of those was estimated — the RPE chart, or Epley for a set with no RPE (v1.1). */
  e1rm_week_method: E1rmMethod | null
  e1rm_prior_method: E1rmMethod | null
  change_pct: number | null
  trend: 'up' | 'flat' | 'down' | 'no_data'
  /** Consecutive sessions, up to this week's last, each with a lower e1RM than the one before. */
  down_sessions: number
}

export interface MaintenanceHeld {
  exercise: string
  /** null: not trained this week. */
  held: boolean | null
  why: string
}

export interface PainTrend {
  region: string
  avg: number
  max: number
  prior_avg: number | null
  trend: 'better' | 'same' | 'worse' | 'new'
}

export interface WeeklyReviewView {
  week_start: string
  week_end: string
  methodology_version: string
  compliance: { planned: number; logged: number; ratio: number | null; target: number; met: boolean | null }
  priority_lifts: LiftTrend[]
  maintenance: MaintenanceHeld[]
  /** null when this coach can't see health data. */
  pain: { regions: PainTrend[]; blocked: string[]; cap: number } | null
  checkins: { days: number; sleep_avg: number | null; stress_avg: number | null; soreness_avg: number | null; flag_days: number } | null
  /** G9: session RPE × minutes. null when this coach can't see health data. */
  session_load: SessionLoadView | null
  health_hidden?: true
  call: WeeklyCall
  rule_refs: string[]
  why: string
}

export interface CallInput {
  compliance: { ratio: number | null; target: number; trigger: number }
  lifts: LiftTrend[]
  flagDays: number
  /** Blocked this week, or over the cap on some day. */
  painRegions: string[]
}

interface Reason { text: string; refs: string[]; health: boolean }

/** The progress / hold / deload call, and its reasons (pure). */
export function weeklyCall(input: CallInput): { call: WeeklyCall; reasons: Reason[] } {
  const pct = (r: number) => `${Math.round(r * 100)}%`
  const { ratio, target, trigger } = input.compliance
  const deload: Reason[] = []
  if (ratio != null && ratio < trigger) deload.push({ text: `compliance ${pct(ratio)}, under ${pct(trigger)}`, refs: ['U11', 'U15'], health: false })
  for (const l of input.lifts) {
    if (l.down_sessions >= 2) deload.push({ text: `${l.lift} e1RM down ${l.down_sessions} sessions in a row`, refs: ['U11'], health: false })
  }
  if (input.flagDays >= 5) deload.push({ text: `readiness flags on ${input.flagDays} days`, refs: ['U11', 'U6'], health: true })
  if (deload.length) return { call: 'deload', reasons: deload }
  const hold: Reason[] = []
  if (ratio != null && ratio < target) hold.push({ text: `compliance ${pct(ratio)}, under the ${pct(target)} target`, refs: ['U15'], health: false })
  if (input.painRegions.length) hold.push({ text: `pain over the cap at the ${input.painRegions.map((r) => r.replace(/_/g, ' ')).join(', ')}`, refs: ['U7'], health: true })
  if (input.flagDays >= 3) hold.push({ text: `readiness flags on ${input.flagDays} days`, refs: ['U6'], health: true })
  for (const l of input.lifts) if (l.trend === 'down') hold.push({ text: `${l.lift} e1RM down ${Math.abs(l.change_pct ?? 0)}%`, refs: ['U5'], health: false })
  if (hold.length) return { call: 'hold', reasons: hold }
  const ok = ratio == null ? 'no sessions were planned' : `compliance ${pct(ratio)}`
  const up = input.lifts.filter((l) => l.trend === 'up').map((l) => l.lift)
  return {
    call: 'progress',
    reasons: [{ text: `${ok}${up.length ? `, ${up.join(' and ')} trending up` : ''}, nothing flagged`, refs: ['U5', 'U15'], health: false }],
  }
}

function mondayOf(date: string): string {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
  return addDays(date, -dow)
}

const round1 = (n: number) => Math.round(n * 10) / 10
const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

/** The review for the week starting `week` (a date in it; Monday by default this week). */
export async function computeWeeklyReview(
  store: ConnectedStore,
  opts: { week?: unknown; showHealth: boolean },
): Promise<WeeklyReviewView | { error: string }> {
  const today = await athleteToday(store)
  const asked = typeof opts.week === 'string' && opts.week.trim() ? opts.week.trim() : today
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked) || Number.isNaN(Date.parse(`${asked}T00:00:00Z`))) return { error: 'week must be a date, YYYY-MM-DD' }
  const monday = mondayOf(asked)
  const sunday = addDays(monday, 6)
  const priorStart = addDays(monday, -21)

  const [methodology, live, tz, workouts, rules] = await Promise.all([
    resolveMethodology(store),
    loadLiveProgram(store),
    store.sql<{ time_zone: string | null; spw: number | null }[]>`SELECT time_zone, sessions_per_week AS spw FROM athlete WHERE id = ${store.athleteId}`,
    loadWorkouts(store, { limit: 120, since: `${addDays(priorStart, -1)}T00:00:00Z`, until: `${addDays(sunday, 1)}T23:59:59Z` }),
    store.sql<{ track_id: string | null; exercise_name: string | null; engine_type: string }[]>`
      SELECT pr.track_id::text AS track_id, pr.exercise_name, pr.engine_type
      FROM progression_rule pr JOIN program p ON p.id = pr.program_id
      WHERE p.athlete_id = ${store.athleteId} AND p.status = 'active'
        AND (pr.active_to IS NULL OR pr.active_to >= ${monday}::date)
    `,
  ])
  const params = methodology.params
  const zone = calendarZone(tz[0]?.time_zone)
  const dayOf = (iso: string) => mcpStamp(new Date(iso), zone).local_date
  const inWeek = (d: string) => d >= monday && d <= sunday

  // ---- compliance ----
  const [phase] = await store.sql<{ n: number }[]>`
    SELECT (SELECT count(*)::int FROM routine r WHERE r.phase_id = ph.id) AS n
    FROM phase ph JOIN program p ON p.id = ph.program_id
    WHERE p.athlete_id = ${store.athleteId}
      AND ph.week_start <= ${sunday}::date AND (ph.week_end IS NULL OR ph.week_end >= ${monday}::date)
    ORDER BY (ph.status = 'active') DESC, ph.week_start DESC
    LIMIT 1
  `
  const planned = Number(phase?.n ?? 0) || Number(tz[0]?.spw ?? 0)
  const weekWorkouts = workouts.filter((w) => inWeek(dayOf(w.performed_at)))
  const logged = weekWorkouts.length
  const ratio = planned > 0 ? Math.round((logged / planned) * 100) / 100 : null
  const compliance = {
    planned, logged, ratio, target: params.U15.compliance_target,
    met: ratio == null ? null : ratio >= params.U15.compliance_target,
  }

  // ---- lifts ----
  const maintenanceNames = new Set<string>()
  const maintenanceTracks = new Set<string>()
  for (const r of rules) {
    if (r.engine_type !== 'maintenance') continue
    if (r.exercise_name) maintenanceNames.add(r.exercise_name.trim().toLowerCase())
    else if (r.track_id) maintenanceTracks.add(r.track_id)
  }
  const weekExercises = (live?.sessions ?? []).flatMap((s) => s.exercises)
  const isMaintenance = (name: string, trackId?: string) => maintenanceNames.has(name.trim().toLowerCase()) || (trackId != null && maintenanceTracks.has(trackId))
  const priority = [...new Set(weekExercises.filter((e) => !isMaintenance(e.name, e.track_id)).map((e) => canonicalLiftId(e.name)).filter((x): x is NonNullable<typeof x> => x != null))].sort()
  const maintenance = [...new Set(weekExercises.filter((e) => isMaintenance(e.name, e.track_id)).map((e) => e.name))].sort()

  // Top sets per exercise, oldest first.
  const tops: Array<{ date: string; name: string; lift: string | null; e1rm: number | null; method: E1rmMethod | null; weight: number | null; rpe: number | null }> = []
  const noRpe = params.U4.e1rm_without_rpe === 'epley' ? 'epley' : 'rpe10_floor'
  for (const w of [...workouts].reverse()) {
    const date = dayOf(w.performed_at)
    if (date < priorStart || date > sunday) continue
    for (const { name, sets } of readLoggedExercises(w)) {
      const top = topWorkingSet(sets)
      if (!top || top.weight == null || top.reps == null) continue
      const est = estimateE1rm(top.weight, top.reps, top.rpe ?? null, noRpe)
      tops.push({ date, name, lift: canonicalLiftId(name), e1rm: est ? Math.round(est.e1rm) : null, method: est?.method ?? null, weight: top.weight, rpe: top.rpe ?? null })
    }
  }
  const best = (xs: Array<number | null>) => xs.reduce<number | null>((m, x) => (x != null && (m == null || x > m) ? x : m), null)
  const bestPoint = <T extends { e1rm: number | null }>(xs: T[]) => xs.reduce<T | null>((m, x) => (x.e1rm != null && (m == null || x.e1rm > m.e1rm!) ? x : m), null)
  const priority_lifts: LiftTrend[] = priority.map((lift) => {
    const pts = tops.filter((t) => t.lift === lift && t.e1rm != null)
    const weekTop = bestPoint(pts.filter((p) => inWeek(p.date)))
    const priorTop = bestPoint(pts.filter((p) => p.date < monday))
    const week = weekTop?.e1rm ?? null
    const prior = priorTop?.e1rm ?? null
    const change = week != null && prior != null && prior > 0 ? round1(((week - prior) / prior) * 100) : null
    let down = 0
    const seq = pts.map((p) => p.e1rm!)
    if (pts.some((p) => inWeek(p.date))) {
      for (let i = seq.length - 1; i > 0 && seq[i] < seq[i - 1]; i--) down++
    }
    const trend = week == null || prior == null ? 'no_data' : change! > 1 ? 'up' : change! < -1 ? 'down' : 'flat'
    return {
      lift, e1rm_week: week, e1rm_prior: prior, e1rm_week_method: weekTop?.method ?? null, e1rm_prior_method: priorTop?.method ?? null,
      change_pct: change, trend, down_sessions: down,
    }
  })
  const heldAt = params.U12.maintenance_held_at_rpe
  const maintenanceView: MaintenanceHeld[] = maintenance.map((exercise) => {
    const key = exercise.trim().toLowerCase()
    const pts = tops.filter((t) => t.name.trim().toLowerCase() === key)
    const week = pts.filter((p) => inWeek(p.date))
    if (!week.length) return { exercise, held: null, why: 'Not trained this week.' }
    const priorTop = best(pts.filter((p) => p.date < monday).map((p) => p.weight))
    const ok = week.some((p) => p.rpe != null && p.rpe <= heldAt && (priorTop == null || (p.weight ?? 0) >= priorTop))
    return {
      exercise,
      held: ok,
      why: ok
        ? `Moved ${priorTop == null ? 'its load' : `${priorTop} or more`} at RPE ≤ ${heldAt} (U12).`
        : `Not at its load at RPE ≤ ${heldAt} this week (U12).`,
    }
  })

  // ---- health ----
  const [checkins, pain, statusBlocked, sessionLoad] = await Promise.all([
    loadCheckins(store, addDays(monday, -2), sunday),
    loadPain(store, addDays(monday, -7), sunday),
    blockedDuring(store, monday, sunday),
    opts.showHealth ? sessionLoadForWeek(store, monday) : null,
  ])
  const days: CheckinDay[] = checkins
  const weekCheckins = checkins.filter((c) => inWeek(c.date))
  let flagDays = 0
  for (let d = monday; d <= sunday; d = addDays(d, 1)) if (u6Flags(days, d, params.U6).length) flagDays++
  const nums = (k: 'sleep_hours' | 'stress' | 'soreness') => weekCheckins.map((c) => c[k]).filter((v): v is number => v != null)
  const regions = [...new Set(pain.filter((p) => inWeek(p.date)).map((p) => p.region))].sort()
  const cap = params.U7.pain_cap
  const painTrend: PainTrend[] = regions.map((region) => {
    const now = pain.filter((p) => p.region === region && inWeek(p.date)).map((p) => p.score)
    const before = pain.filter((p) => p.region === region && p.date < monday).map((p) => p.score)
    const a = avg(now)!
    const b = avg(before)
    return { region, avg: a, max: Math.max(...now), prior_avg: b, trend: b == null ? 'new' : a > b + 0.5 ? 'worse' : a < b - 0.5 ? 'better' : 'same' }
  })
  // Red flags in the athlete's rules are current state: they count for this week and later.
  const blocked = [...new Set([...statusBlocked, ...(sunday >= today ? blockedRegions(methodology) : [])])].sort()
  const painRegions = [...new Set([...blocked, ...painTrend.filter((p) => p.max > cap).map((p) => p.region)])].sort()

  const { call, reasons } = weeklyCall({
    compliance: { ratio, target: params.U15.compliance_target, trigger: params.U11.compliance_trigger },
    lifts: priority_lifts,
    flagDays,
    painRegions,
  })
  const shown = opts.showHealth ? reasons : reasons.filter((r) => !r.health)
  const hiddenCount = reasons.length - shown.length
  const whyParts = shown.map((r) => r.text)
  if (hiddenCount) whyParts.push('health inputs the athlete hasn\'t shared with you')
  const label = call === 'progress' ? 'Progress' : call === 'hold' ? 'Hold' : 'Deload'
  const refs = [...new Set(shown.flatMap((r) => r.refs))]
  return {
    week_start: monday,
    week_end: sunday,
    methodology_version: methodology.version,
    compliance,
    priority_lifts,
    maintenance: maintenanceView,
    pain: opts.showHealth ? { regions: painTrend, blocked, cap } : null,
    checkins: opts.showHealth
      ? { days: weekCheckins.length, sleep_avg: avg(nums('sleep_hours')), stress_avg: avg(nums('stress')), soreness_avg: avg(nums('soreness')), flag_days: flagDays }
      : null,
    session_load: sessionLoad,
    ...(opts.showHealth ? {} : { health_hidden: true as const }),
    call,
    rule_refs: refs.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    why: `${label}: ${whyParts.join('; ')}.`,
  }
}

export const WEEKLY_REVIEW_TOOL: McpTool = {
  name: 'get_weekly_review',
  description: 'The engine\'s weekly review (U15) for one week: compliance (planned vs logged sessions, target ≥ 80%), each priority lift\'s e1RM trend, whether maintenance lifts held (U12), the pain trend, check-in averages and session load (session RPE × minutes against the 4 weeks before; when the athlete shares health data with you), and the call — progress, hold or deload — with rule_refs and one line of why. Read-only. Propose any change it suggests through the usual preview → approval → apply.',
  inputSchema: {
    type: 'object',
    properties: {
      week: { type: 'string', description: 'YYYY-MM-DD, any day of the week (default: this week).' },
    },
    additionalProperties: false,
  },
}
