// =============================================================================
// WEAK LINKS — related lifts that stopped agreeing, read off the log.
//
// The ratio between two related lifts is information. A DB press that sits at
// a third of the bench when most lifters sit near 40% says the press is fine
// and the shoulder's control isn't; a DB press that slid from 41% to 37% of
// YOUR bench over a block says something changed. The second read is the
// stronger one, so once there are enough paired weeks the athlete's own ratio
// replaces the population prior (shrunk toward it while the data is thin).
//
// What it reads: every working set's estimated max (evidence.ts, the RPE
// chart), the best per lift per week, paired by week with the lift it reads
// against (liftFamilies.ts). Also left/right goals that drifted apart.
//
// What it doesn't claim: leverages, limb length and sport move ratios, so a
// population read says "usually", never "is". Every weak link carries its
// basis (prior or own) and the athlete sees it.
//
// Pure, no I/O (see weakLinks.check.ts).
// =============================================================================

import { strengthEvidence, type EvidenceSet } from './evidence.ts'
import { canonicalLift, LIFT_PAIRS, pairId, type LiftPair } from './liftFamilies.ts'
import { goalNumber, pairKey } from './goals.ts'

/** One logged session, in the shape every read here takes. */
export interface TrainingSession {
  /** YYYY-MM-DD, athlete-local. */
  date: string
  exercises: Array<{ name: string; sets: EvidenceSet[] }>
  session_rpe?: number | null
  duration_mins?: number | null
  readiness?: number | null
  sleep_hours?: number | null
  bodyweight?: number | null
}

export interface LiftPoint {
  lift: string
  day: number
  date: string
  value: number
}

/** Paired weeks needed before the athlete's own ratio is trusted. */
export const OWN_MIN_PAIRS = 6
/** How many prior-strength pairs the own ratio is shrunk toward. */
const SHRINK_PAIRS = 3
/** "Recent" for a weak link. */
export const RECENT_DAYS = 28
/** Off the prior by this much (as a share of it) and it's called out. */
export const PRIOR_FLAG = 0.1
/** Moved off the athlete's own baseline by this much and it's called out. */
export const OWN_FLAG = 0.06
/** Sides this far apart (as a share of the stronger) are an asymmetry. */
export const ASYMMETRY_FLAG = 0.1

export function dayNumber(day: string): number | null {
  const t = Date.parse(`${String(day).slice(0, 10)}T12:00:00Z`)
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null
}

/** Every session's best estimated max per lift, canonical names, oldest first. */
export function liftPoints(sessions: TrainingSession[]): LiftPoint[] {
  const out: LiftPoint[] = []
  for (const s of sessions) {
    const day = dayNumber(s.date)
    if (day == null) continue
    const best = new Map<string, number>()
    for (const ex of s.exercises) {
      const ev = strengthEvidence(ex.sets.filter((x) => x.done === true))
      if (!ev) continue
      const lift = canonicalLift(ex.name)
      if (ev.value > (best.get(lift) ?? 0)) best.set(lift, ev.value)
    }
    for (const [lift, value] of best) out.push({ lift, day, date: s.date.slice(0, 10), value })
  }
  return out.sort((a, b) => a.day - b.day)
}

/** Best per lift per week (week = floor(day / 7)). */
function weekly(points: LiftPoint[], lift: string): Map<number, { value: number; day: number; date: string }> {
  const m = new Map<number, { value: number; day: number; date: string }>()
  for (const p of points) {
    if (p.lift !== lift) continue
    const w = Math.floor(p.day / 7)
    const prev = m.get(w)
    if (!prev || p.value > prev.value) m.set(w, { value: p.value, day: p.day, date: p.date })
  }
  return m
}

interface PairedWeek { week: number; day: number; date: string; ratio: number }

/** Weeks where both lifts have a reading (the `to` lift may be a week either side). */
export function pairedWeeks(points: LiftPoint[], pair: Pick<LiftPair, 'from' | 'to'>): PairedWeek[] {
  const from = weekly(points, pair.from)
  const to = weekly(points, pair.to)
  const out: PairedWeek[] = []
  for (const [w, f] of from) {
    const t = to.get(w) ?? to.get(w - 1) ?? to.get(w + 1)
    if (!t || !(t.value > 0)) continue
    out.push({ week: w, day: f.day, date: f.date, ratio: f.value / t.value })
  }
  return out.sort((a, b) => a.week - b.week)
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * The athlete's own ratio per pair, shrunk toward the prior: n paired weeks
 * of their own count n, the prior counts three. Only pairs with enough data.
 */
export function learnedRatios(points: LiftPoint[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of LIFT_PAIRS) {
    const weeks = pairedWeeks(points, pair)
    if (weeks.length < OWN_MIN_PAIRS) continue
    const own = mean(weeks.map((w) => w.ratio))
    out[pairId(pair.from, pair.to)] = (own * weeks.length + pair.ratio * SHRINK_PAIRS) / (weeks.length + SHRINK_PAIRS)
  }
  return out
}

export type WeakLinkState = 'low' | 'high' | 'slipping' | 'asymmetry'

export interface WeakLink {
  kind: 'ratio' | 'asymmetry'
  state: WeakLinkState
  /** The lift (or goal pair) that's behind. */
  subject: string
  /** What it's read against. */
  against: string
  /** The ratio now (or the weaker side ÷ the stronger). */
  ratio: number
  /** What it's compared to: the prior, the athlete's own baseline, or 1. */
  expected: number
  basis: 'prior' | 'own' | 'sides'
  /** Signed share off what's expected: −0.08 is 8% under. */
  delta: number
  /** What it usually means. */
  meaning: string | null
  /** One line for the athlete. */
  text: string
  /** The date the comparison runs from, for own-baseline reads. */
  since: string | null
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function shortDay(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Pairs whose recent ratio is off. With enough history, against the athlete's
 * own earlier ratio; otherwise against the prior. Biggest first.
 */
export function ratioWeakLinks(points: LiftPoint[], today: string): WeakLink[] {
  const todayN = dayNumber(today)
  if (todayN == null) return []
  const out: WeakLink[] = []
  for (const pair of LIFT_PAIRS) {
    const weeks = pairedWeeks(points, pair)
    const recent = weeks.filter((w) => todayN - w.day <= RECENT_DAYS)
    if (!recent.length) continue
    const now = mean(recent.map((w) => w.ratio))
    const earlier = weeks.filter((w) => todayN - w.day > RECENT_DAYS)
    if (weeks.length >= OWN_MIN_PAIRS && earlier.length >= 3) {
      const base = mean(earlier.map((w) => w.ratio))
      const delta = (now - base) / base
      if (delta <= -OWN_FLAG) {
        out.push({
          kind: 'ratio', state: 'slipping', subject: pair.from, against: pair.to,
          ratio: now, expected: base, basis: 'own', delta, meaning: pair.low, since: earlier[0].date,
          text: `${pair.from} has slipped from ${pct(base)} to ${pct(now)} of your ${pair.to} since ${shortDay(earlier[0].date)}. Usually ${pair.low}.`,
        })
      } else if (delta >= OWN_FLAG && pair.high) {
        out.push({
          kind: 'ratio', state: 'slipping', subject: pair.to, against: pair.from,
          ratio: now, expected: base, basis: 'own', delta: -delta, meaning: pair.high, since: earlier[0].date,
          text: `${pair.to} has fallen behind your ${pair.from}: the ${pair.from} went from ${pct(base)} to ${pct(now)} of it since ${shortDay(earlier[0].date)}. Usually ${pair.high}.`,
        })
      }
      continue
    }
    const delta = (now - pair.ratio) / pair.ratio
    if (delta <= -PRIOR_FLAG) {
      out.push({
        kind: 'ratio', state: 'low', subject: pair.from, against: pair.to,
        ratio: now, expected: pair.ratio, basis: 'prior', delta, meaning: pair.low, since: null,
        text: `${pair.from} is ${pct(now)} of your ${pair.to}; most lifters sit near ${pct(pair.ratio)}. Usually ${pair.low}, though build can move it.`,
      })
    } else if (delta >= PRIOR_FLAG && pair.high) {
      out.push({
        kind: 'ratio', state: 'high', subject: pair.to, against: pair.from,
        ratio: now, expected: pair.ratio, basis: 'prior', delta: -delta, meaning: pair.high, since: null,
        text: `${pair.from} is ${pct(now)} of your ${pair.to}, above the usual ${pct(pair.ratio)}: the ${pair.to} is the one behind. Usually ${pair.high}.`,
      })
    }
  }
  return out.sort((a, b) => a.delta - b.delta)
}

export interface SidedGoal {
  name: string
  side?: string | null
  current?: number | string | null
  direction: string
}

/** Left/right goals more than 10% apart. */
export function asymmetryWeakLinks(goals: SidedGoal[]): WeakLink[] {
  const byPair = new Map<string, { L?: SidedGoal; R?: SidedGoal }>()
  for (const g of goals) {
    if (g.side !== 'L' && g.side !== 'R') continue
    const k = pairKey(g.name)
    const entry = byPair.get(k) ?? {}
    entry[g.side] = g
    byPair.set(k, entry)
  }
  const out: WeakLink[] = []
  for (const [, { L, R }] of byPair) {
    if (!L || !R) continue
    const l = goalNumber(L.current)
    const r = goalNumber(R.current)
    if (l == null || r == null || l <= 0 || r <= 0) continue
    const lower = L.direction === 'lower'
    // The weaker side: the smaller number, or the bigger for a lower-is-better goal.
    const weakIsL = lower ? l > r : l < r
    const weak = weakIsL ? l : r
    const strong = weakIsL ? r : l
    const share = lower ? strong / weak : weak / strong
    const delta = share - 1
    if (-delta < ASYMMETRY_FLAG) continue
    const name = (weakIsL ? L : R).name
    out.push({
      kind: 'asymmetry', state: 'asymmetry', subject: name, against: (weakIsL ? R : L).name,
      ratio: share, expected: 1, basis: 'sides', delta, meaning: 'a side-to-side gap worth closing before it becomes a compensation',
      since: null,
      text: `${name} is ${pct(-delta)} behind the other side.`,
    })
  }
  return out.sort((a, b) => a.delta - b.delta)
}
