/**
 * Readiness and pain, the pure half (G4, tracks_v1). No I/O:
 * worker/src/readiness.ts reads the rows and calls these.
 *
 * U6  readiness modifies the day, not the plan. A flag is one of:
 *       one day: sleep < 5 h · stress 5 · soreness 5 (v1.2; v1 / v1.1 and
 *         under 18: sleep < 6 h · stress ≥ 4 · soreness ≥ 4)
 *       a streak: sleep < 6 h for 3+ nights, or stress / soreness ≥ 4 for
 *       3+ days, ending on the day prescribed (each streak is one more flag)
 *     One flag → trim accessories (one set off, never below one).
 *     Two or more → also pull HIIT and plyos. Cut order: HIIT, then
 *     accessories. The main lift is never touched by U6.
 *
 * U7  pain caps, per region, 0–10:
 *       ≤ cap (3)              proceed
 *       4–5                    regress: plyo/impact work for that region is
 *                              dropped, loaded work for it is 10% lighter
 *       > 5, or worse the      blocked, and the athlete is told to see a
 *       next morning           clinician. "Worse the next morning" (v1.2):
 *                              above the day before's rating and ≥ 4.
 *     v1.2: such a block covers that day and the next session, then lapses
 *     (temporary). v1.3: the next session that loads the region (knee, ankle,
 *     hip: squats, lunges, jumps, cuts, basketball; others: a tagged
 *     exercise), within 14 days. It is persistent — no loading until the athlete marks it
 *     cleared by a clinician — only on a red flag, > 5 twice within 14 days,
 *     or a rating rising across 3 sessions (with this one a block). Under 18,
 *     and in v1 / v1.1, every block is persistent.
 *     A raised cap (≤ 5 if it settles by the next morning, D2) counts only
 *     for an adult (age known, 18+), and only when the region was at or
 *     under the cap the day before. Red flags always win.
 *
 * Exercise → region comes from methodology/classify.ts (a small, conservative
 * table). An exercise it can't place, in a session with a blocked region, is
 * flagged for the athlete to check rather than silently loaded.
 *
 * The base prescription stays deterministic; these only adjust it, and every
 * adjustment says why, with its rule.
 */
import type { ExerciseTemplate } from '../../../src/types/database.ts'
import type { SessionPrescription } from '../../../src/engine/sessionRxCompute.ts'
import { resolvePattern } from '../../../src/engine/exerciseLibrary.ts'
import { roundToIncrement, type WeightUnit } from '../../../src/lib/units.ts'
import { classify } from '../methodology/classify.ts'
import { PAIN_REGIONS, type MethodologyParams, type PainRegion } from '../methodology/v1.ts'

/** Section 8, as the check-in records them. */
export const RED_FLAGS = [
  'swelling', 'locking', 'giving_way', 'numbness_tingling', 'radiating',
  'chest_pain', 'fainting', 'breathlessness', 'acute_injury', 'worsening',
] as const
export type RedFlag = typeof RED_FLAGS[number]

export const RED_FLAG_LABEL: Record<RedFlag, string> = {
  swelling: 'swelling',
  locking: 'locking',
  giving_way: 'giving way',
  numbness_tingling: 'numbness or tingling',
  radiating: 'radiating pain',
  chest_pain: 'chest pain',
  fainting: 'fainting',
  breathlessness: 'unusual breathlessness',
  acute_injury: 'an acute injury',
  worsening: 'getting worse each session',
}

export const REFER_OUT = 'See a doctor or physio before loading this area again. Once a clinician clears it, mark it cleared in the app.'

/** v1.2: the refer-out notice for a block that lapses after the next session. */
export const REFER_OUT_TEMPORARY = 'No loading this area today or your next session. If the pain hasn\'t settled by then, or keeps coming back, see a doctor or physio.'

export function isPainRegion(v: unknown): v is PainRegion {
  return typeof v === 'string' && (PAIN_REGIONS as readonly string[]).includes(v)
}

export function isRedFlag(v: unknown): v is RedFlag {
  return typeof v === 'string' && (RED_FLAGS as readonly string[]).includes(v)
}

export function regionLabel(region: string): string {
  return region.replace(/_/g, ' ')
}

// ---- U6 ---------------------------------------------------------------------------------

export interface CheckinDay {
  date: string
  sleep_hours: number | null
  stress: number | null
  soreness: number | null
}

export type FlagKind = 'sleep' | 'stress' | 'soreness' | 'sleep_streak' | 'stress_streak' | 'soreness_streak'

export interface ReadinessFlag {
  kind: FlagKind
  message: string
  rule_refs: string[]
}

/** YYYY-MM-DD ± n days (UTC calendar arithmetic; dates carry no zone). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The U6 flags for `date`, from the check-ins on and before it (latest per date). */
export function u6Flags(days: CheckinDay[], date: string, p: MethodologyParams['U6']): ReadinessFlag[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const today = byDate.get(date)
  if (!today) return []
  const lowSleep = (d: CheckinDay | undefined) => d?.sleep_hours != null && d.sleep_hours < p.sleep_flag_hours
  const high = (v: number | null | undefined) => v != null && v >= p.stress_soreness_flag_at
  // One day alone (v1.2): only the extremes. v1 / v1.1 and under 18: the streak thresholds.
  const dayHours = p.single_day_sleep_under_hours ?? p.sleep_flag_hours
  const dayAt = p.single_day_stress_soreness_at ?? p.stress_soreness_flag_at
  const streak = (test: (d: CheckinDay | undefined) => boolean, n: number) => {
    for (let i = 0; i < n; i++) if (!test(byDate.get(addDays(date, -i)))) return false
    return true
  }
  const out: ReadinessFlag[] = []
  if (today.sleep_hours != null && today.sleep_hours < dayHours) out.push({ kind: 'sleep', message: `Slept ${today.sleep_hours} h (under ${dayHours})`, rule_refs: ['U6'] })
  if (today.stress != null && today.stress >= dayAt) out.push({ kind: 'stress', message: `Stress ${today.stress}/5`, rule_refs: ['U6'] })
  if (today.soreness != null && today.soreness >= dayAt) out.push({ kind: 'soreness', message: `Soreness ${today.soreness}/5`, rule_refs: ['U6'] })
  if (streak(lowSleep, p.sleep_flag_nights)) {
    out.push({ kind: 'sleep_streak', message: `Under ${p.sleep_flag_hours} h of sleep ${p.sleep_flag_nights}+ nights running`, rule_refs: ['U6'] })
  }
  if (streak((d) => high(d?.stress), p.stress_soreness_flag_days)) {
    out.push({ kind: 'stress_streak', message: `Stress ${p.stress_soreness_flag_at}+ for ${p.stress_soreness_flag_days}+ days`, rule_refs: ['U6'] })
  }
  if (streak((d) => high(d?.soreness), p.stress_soreness_flag_days)) {
    out.push({ kind: 'soreness_streak', message: `Soreness ${p.stress_soreness_flag_at}+ for ${p.stress_soreness_flag_days}+ days`, rule_refs: ['U6'] })
  }
  return out
}

// ---- U7 ---------------------------------------------------------------------------------

export interface PainEntry {
  date: string
  region: PainRegion
  score: number
  red_flags: RedFlag[]
}

export type RegionState = 'ok' | 'capped' | 'blocked'

export interface RegionEval {
  region: PainRegion
  status: RegionState
  score: number
  /** The cap in force for this region today. */
  cap: number
  reason: string
  rule_refs: string[]
  /** True when the athlete must be told to see a clinician (section 8). */
  refer_out: boolean
  /**
   * v1.2, with status blocked: persistent (until the athlete marks it cleared
   * by a clinician) or temporary (that day and the next session). Absent in
   * v1 / v1.1, where every block is persistent.
   */
  block?: 'persistent' | 'temporary'
}

export interface RegionInput {
  today: PainEntry
  /** The same region's report the day before, if any. */
  yesterday: PainEntry | null
  params: MethodologyParams['U7']
  /** The region carries a raised cap (D2) in the athlete's methodology. */
  raised: boolean
  /** True only when the athlete is known to be 18+. A raised cap never counts otherwise. */
  adult: boolean
  /**
   * v1.2: the same region's earlier reports (latest per date, any order), for
   * the persistence criteria. Only those within persistent_after.within_days count.
   */
  history?: PainEntry[]
}

/** Whole days from `a` to `b` (dates). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/**
 * v1.2 (section 11a): the block, if any, for a report without a red flag.
 * > 5 or worse the next morning blocks; > 5 twice within 14 days, or the
 * rating rising across the last 3 sessions (reports within 14 days, this one
 * included), makes that block persistent. Otherwise it is temporary, unless
 * temporary blocks are off (under 18), when every block persists.
 */
function blockV12(input: RegionInput): RegionEval | null {
  const { today, yesterday, params: p } = input
  const rules = p.persistent_after!
  const name = regionLabel(today.region)
  const recent = (input.history ?? [])
    .filter((h) => h.region === today.region && h.date < today.date && daysBetween(h.date, today.date) <= rules.within_days)
    .sort((a, b) => a.date.localeCompare(b.date))
  const over = today.score > p.stop_above
  const worse = yesterday != null && today.score > yesterday.score && today.score >= (p.worse_next_morning_at ?? p.pain_cap + 1)
  const lastN = [...recent.slice(-(rules.rising_sessions - 1)), today]
  // Rising and "twice" make a block persistent; neither blocks on its own (section 11a).
  if (!over && !worse) return null
  const rising = lastN.length === rules.rising_sessions && lastN.every((r, i) => i === 0 || r.score > lastN[i - 1].score)
  const earlierOver = over ? recent.filter((h) => h.score > p.stop_above).pop() : undefined
  const blocked = (reason: string, block: 'persistent' | 'temporary'): RegionEval => ({
    region: today.region, score: today.score, rule_refs: ['U7'], status: 'blocked', cap: p.pain_cap, refer_out: true, reason, block,
  })
  const untilCleared = 'No loading there until a clinician clears it (U7).'
  if (earlierOver) {
    return blocked(`${name} over ${p.stop_above}/10 twice within ${rules.within_days} days (${earlierOver.score}/10 on ${earlierOver.date}, ${today.score}/10 now). ${untilCleared}`, 'persistent')
  }
  if (rising) {
    return blocked(`${name} rising ${rules.rising_sessions} sessions running (${lastN.map((r) => r.score).join(' → ')}/10). ${untilCleared}`, 'persistent')
  }
  const what = over
    ? `${name} at ${today.score}/10 (over ${p.stop_above})`
    : `${name} worse the next morning (${yesterday!.score} → ${today.score}/10)`
  if (!p.temporary_blocks) return blocked(`${what}. ${untilCleared}`, 'persistent')
  const next = p.temporary_ends_on === 'region_session' ? `your next session that loads the ${name}` : 'your next session'
  return blocked(`${what}. No loading there today or ${next} (U7).`, 'temporary')
}

/** The U7 call for one report among `pain` (that region's day before and earlier reports from the same list). */
export function evaluateReport(pain: PainEntry[], report: PainEntry, params: MethodologyParams['U7'], adult: boolean): RegionEval {
  return evaluateRegion({
    today: report,
    yesterday: pain.find((p) => p.region === report.region && p.date === addDays(report.date, -1)) ?? null,
    params,
    raised: params.regions[report.region]?.raised_cap === true,
    adult,
    history: pain.filter((p) => p.region === report.region && p.date < report.date),
  })
}

/** One region's U7 call for today's report. */
export function evaluateRegion(input: RegionInput): RegionEval {
  const { today, yesterday, params: p } = input
  const region = today.region
  const name = regionLabel(region)
  const base = { region, score: today.score, rule_refs: ['U7'] }
  if (today.red_flags.length) {
    return {
      ...base, status: 'blocked', cap: p.pain_cap, refer_out: true,
      reason: `Red flag at the ${name}: ${today.red_flags.map((f) => RED_FLAG_LABEL[f]).join(', ')}. No loading there (U7, section 8).`,
      ...(p.persistent_after ? { block: 'persistent' as const } : {}),
    }
  }
  if (p.persistent_after) {
    const blocked = blockV12(input)
    if (blocked) return blocked
  } else {
    if (today.score > p.stop_above) {
      return { ...base, status: 'blocked', cap: p.pain_cap, refer_out: true, reason: `${name} at ${today.score}/10 (over ${p.stop_above}). No loading there (U7).` }
    }
    if (yesterday && yesterday.score > p.pain_cap && today.score > yesterday.score) {
      return {
        ...base, status: 'blocked', cap: p.pain_cap, refer_out: true,
        reason: `${name} worse than yesterday (${yesterday.score} → ${today.score}/10). No loading there (U7).`,
      }
    }
  }
  const settled = !yesterday || yesterday.score <= p.pain_cap
  const cap = input.raised && input.adult && settled ? p.raised_cap : p.pain_cap
  if (today.score <= cap) {
    const note = cap > p.pain_cap && today.score > p.pain_cap
      ? `${name} ${today.score}/10, within its raised cap of ${cap} — it has to settle by tomorrow morning (U7).`
      : `${name} ${today.score}/10, within the cap of ${cap} (U7).`
    return { ...base, status: 'ok', cap, refer_out: false, reason: note }
  }
  return {
    ...base, status: 'capped', cap, refer_out: false,
    reason: `${name} ${today.score}/10 (over the cap of ${cap}): impact dropped and load lowered for the ${name} today (U7).`,
  }
}

// ---- applying it --------------------------------------------------------------------

export type AdjustmentAction = 'skip' | 'trim_sets' | 'reduce_load' | 'check_region'

export interface Adjustment {
  index: number
  exercise: string
  action: AdjustmentAction
  reason: string
  rule_refs: string[]
  before?: number | null
  after?: number | null
}

export interface ReadinessView {
  date: string
  flags: ReadinessFlag[]
  /** U6 at this flag count: none, trim accessories, or also pull HIIT/plyos. */
  level: 'none' | 'trim_accessories' | 'pull_hiit_plyo'
  regions: RegionEval[]
  blocked_regions: string[]
  /** v1.2: the blocked regions that lapse after the next session. Absent when none. */
  temporary_regions?: string[]
  refer_out: string | null
}

export interface ReadinessInput {
  date: string
  flags: ReadinessFlag[]
  regions: RegionEval[]
  /** Every blocked region: red-flag overrides, open region_status blocks and (v1.2) temporary blocks. */
  blocked: string[]
  /** v1.2: those of `blocked` that are only temporary (that day and the next session). */
  temporary?: string[]
  params: MethodologyParams
  unit: WeightUnit
}

export function readinessView(input: Omit<ReadinessInput, 'unit'>): ReadinessView {
  const n = input.flags.length
  const p = input.params.U6
  const level = n >= p.pull_hiit_plyo_at_flags ? 'pull_hiit_plyo' : n >= p.trim_accessories_at_flags ? 'trim_accessories' : 'none'
  const blocked = [...new Set(input.blocked)].sort()
  const temporary = blocked.filter((r) => input.temporary?.includes(r))
  const persistent = blocked.length > temporary.length || input.regions.some((r) => r.refer_out && r.block !== 'temporary')
  return {
    date: input.date,
    flags: input.flags,
    level,
    regions: input.regions,
    blocked_regions: blocked,
    ...(temporary.length ? { temporary_regions: temporary } : {}),
    refer_out: persistent ? REFER_OUT : temporary.length || input.regions.some((r) => r.refer_out) ? REFER_OUT_TEMPORARY : null,
  }
}

type Kind = 'main' | 'hiit_plyo' | 'accessory' | 'other'

function kindOf(ex: ExerciseTemplate): Kind {
  const c = classify(ex)
  if (c.classes.has('warmup')) return 'other'
  if (c.classes.has('heavy') && c.rank === 2) return 'main'
  if (c.classes.has('hiit') || c.classes.has('plyo')) return 'hiit_plyo'
  if (c.rank === 3) return 'accessory'
  return 'other'
}

/**
 * The prescription with readiness applied, and the list of what changed. With
 * no flags, no capped region and nothing blocked it is returned untouched.
 * Blocked regions were already skipped by the methodology limits; they are
 * listed here so the response explains every change in one place.
 */
export function applyReadiness(
  rx: SessionPrescription,
  exercises: ExerciseTemplate[],
  input: ReadinessInput,
): { rx: SessionPrescription; adjustments: Adjustment[] } {
  const view = readinessView(input)
  const capped = input.regions.filter((r) => r.status === 'capped').map((r) => r.region as string)
  if (view.level === 'none' && !capped.length && !view.blocked_regions.length) return { rx, adjustments: [] }
  const out: SessionPrescription = {
    ...rx,
    targets: { ...rx.targets },
    hints: { ...rx.hints },
    skip: { ...(rx.skip ?? {}) },
    reasons: { ...(rx.reasons ?? {}) },
    exercises: rx.exercises?.map((e) => ({ ...e, reasons: [...e.reasons] })),
  }
  const blockedSet = new Set(view.blocked_regions)
  const temporarySet = new Set(view.temporary_regions ?? [])
  const cut: Adjustment[] = []
  const note = (i: number, why: string) => {
    out.reasons![i] = [...(out.reasons![i] ?? []), why]
    const row = out.exercises?.[i]
    if (row) row.reasons = [...row.reasons, why]
  }
  const skip = (i: number, hint: string, why: string) => {
    out.targets[i] = null
    out.hints[i] = hint
    out.skip![i] = true
    note(i, why)
    const row = out.exercises?.[i]
    if (row) Object.assign(row, { load: null, skip: true, call: 'SKIP', reason: why })
  }

  exercises.forEach((ex, i) => {
    const regions = classify(ex).regions
    const kind = kindOf(ex)
    const row = out.exercises?.[i]
    const blockedHit = regions.find((r) => blockedSet.has(r))
    if (blockedHit) {
      const temporary = temporarySet.has(blockedHit)
      const why = temporary
        ? `${regionLabel(blockedHit)} is blocked today and your next session — no loading there (U7)`
        : `${regionLabel(blockedHit)} is blocked until a clinician clears it — no loading there (U7)`
      if (!out.skip![i]) skip(i, temporary ? 'Skip today — pain' : 'Skip today — red flag', why)
      cut.push({ index: i, exercise: ex.name, action: 'skip', reason: why, rule_refs: ['U7'] })
      return
    }
    if (blockedSet.size && !regions.length && resolvePattern(ex.name ?? '') == null && !classify(ex).classes.has('warmup')) {
      const why = `Can't tell whether ${ex.name} loads the ${[...blockedSet].map(regionLabel).join(' / ')}, which is blocked — check before you load it (U7)`
      note(i, why)
      cut.push({ index: i, exercise: ex.name, action: 'check_region', reason: why, rule_refs: ['U7'] })
    }
    if (out.skip![i]) return
    const cappedHit = regions.find((r) => capped.includes(r))
    if (cappedHit) {
      const name = regionLabel(cappedHit)
      if (kind === 'hiit_plyo') {
        const why = `${name} pain over its cap: impact dropped for the ${name} today (U7)`
        skip(i, 'Skip today — pain', why)
        cut.push({ index: i, exercise: ex.name, action: 'skip', reason: why, rule_refs: ['U7'] })
        return
      }
      if (row && row.load != null) {
        const before = row.load
        const after = roundToIncrement(before * 0.9, input.unit)
        if (after < before) {
          const why = `${name} pain over its cap: ${before} → ${after} ${input.unit} (−10%) today (U7)`
          row.load = after
          out.targets[i] = after
          note(i, why)
          cut.push({ index: i, exercise: ex.name, action: 'reduce_load', reason: why, rule_refs: ['U7'], before, after })
        }
      }
    }
    // U6 modifies the day around the main lift, never the main lift itself.
    if (kind === 'main') return
    if (view.level === 'pull_hiit_plyo' && kind === 'hiit_plyo') {
      const why = `${view.flags.length} readiness flags: HIIT and plyos pulled today (U6)`
      skip(i, 'Skip today — readiness', why)
      cut.push({ index: i, exercise: ex.name, action: 'skip', reason: why, rule_refs: ['U6'] })
      return
    }
    if (view.level !== 'none' && kind === 'accessory') {
      const before = row?.sets ?? ex.sets
      const after = Math.max(1, before - 1)
      if (after < before) {
        const why = `${view.flags.length} readiness flag${view.flags.length === 1 ? '' : 's'}: accessories trimmed to ${after} set${after === 1 ? '' : 's'} today (U6)`
        if (row) row.sets = after
        out.hints[i] = out.hints[i] ? `${out.hints[i]} · ${after} set${after === 1 ? '' : 's'} today` : `${after} set${after === 1 ? '' : 's'} today`
        note(i, why)
        cut.push({ index: i, exercise: ex.name, action: 'trim_sets', reason: why, rule_refs: ['U6'], before, after })
      }
    }
  })
  // Cut order (U6): HIIT, then accessories; U7 changes first, as they win.
  const order = (a: Adjustment) => (a.rule_refs.includes('U7') ? 0 : a.action === 'skip' ? 1 : 2)
  const adjustments = cut.map((a, k) => ({ a, k })).sort((x, y) => order(x.a) - order(y.a) || x.k - y.k).map((x) => x.a)
  return { rx: adjustments.length ? out : rx, adjustments }
}
