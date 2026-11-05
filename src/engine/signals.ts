// =============================================================================
// SIGNALS — how the domains moved together. Hypotheses, never verdicts.
//
// Strength, engine, power and recovery share one body. A coach watches for:
//
//   interference   conditioning load climbed while the lifts went flat
//   fatigue        low-readiness or short-sleep days ran under capacity (the
//                  goals already ignore those, and the athlete should know why)
//   transfer       the squat went up and the jump didn't: strength isn't
//                  turning into power, so the next block wants speed work
//   engine         repeat-effort fade improved (or got worse) across sessions
//
// One athlete over a few weeks is thin evidence, so every signal is phrased as
// a hypothesis for Claude to raise in a proposal. Nothing here changes a
// status, a load or a goal.
//
// Pure, no I/O (see signals.check.ts). Also the one place the app and the
// Worker turn a log into a training read (readTraining).
// =============================================================================

import { fadeEvidence } from './evidence.ts'
import { findLibraryExercise } from './exerciseLibrary.ts'
import { canonicalLift } from './liftFamilies.ts'
import {
  asymmetryWeakLinks, dayNumber, learnedRatios, liftPoints, ratioWeakLinks,
  type LiftPoint, type SidedGoal, type TrainingSession, type WeakLink,
} from './weakLinks.ts'

export type SignalKind = 'interference' | 'fatigue' | 'transfer' | 'engine'

export interface Signal {
  kind: SignalKind
  /** One line for the athlete and for Claude. */
  text: string
  /** What the numbers were, for anyone checking. */
  evidence: string
}

const MAIN = ['Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press']
const WINDOW = 21

function isConditioning(name: string): boolean {
  const lib = findLibraryExercise(name)
  if (lib) return lib.pattern === 'cardio' || lib.pattern === 'sprint' || lib.pattern === 'sled'
  return /\b(bike|row(ing)? (erg|machine)|ski ?erg|run|sprint|interval|conditioning|airdyne)\b/i.test(name)
}

function isJump(name: string): boolean {
  const lib = findLibraryExercise(name)
  return lib ? lib.pattern === 'jump' : /\bjump\b/i.test(name)
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function pctChange(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a === 0) return null
  return (b - a) / a
}

function pct(x: number): string {
  return `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`
}

/** Session load in arbitrary units: session RPE × minutes (Foster). */
function conditioningLoad(sessions: TrainingSession[], from: number, to: number): number {
  let load = 0
  for (const s of sessions) {
    const d = dayNumber(s.date)
    if (d == null || d < from || d > to) continue
    const share = s.exercises.length ? s.exercises.filter((e) => isConditioning(e.name)).length / s.exercises.length : 0
    if (!share) continue
    load += (s.session_rpe ?? 6) * (s.duration_mins ?? 45) * share
  }
  return load
}

/** Mean of each main lift's best in the window, as a share of its overall median. */
function strengthIndex(points: LiftPoint[], from: number, to: number): number | null {
  const shares: number[] = []
  for (const lift of MAIN) {
    const all = points.filter((p) => p.lift === lift).map((p) => p.value).sort((a, b) => a - b)
    if (all.length < 3) continue
    const median = all[Math.floor(all.length / 2)]
    const inWin = points.filter((p) => p.lift === lift && p.day >= from && p.day <= to).map((p) => p.value)
    if (!inWin.length) continue
    shares.push(Math.max(...inWin) / median)
  }
  return mean(shares)
}

export function interferenceSignal(sessions: TrainingSession[], points: LiftPoint[], todayN: number): Signal | null {
  const recentFrom = todayN - WINDOW
  const priorFrom = todayN - 2 * WINDOW
  const loadNow = conditioningLoad(sessions, recentFrom, todayN)
  const loadBefore = conditioningLoad(sessions, priorFrom, recentFrom - 1)
  const loadUp = pctChange(loadBefore, loadNow)
  const strNow = strengthIndex(points, recentFrom, todayN)
  const strBefore = strengthIndex(points, priorFrom, recentFrom - 1)
  const strMove = pctChange(strBefore, strNow)
  if (loadUp == null || strMove == null) return null
  if (loadUp < 0.3 || strMove > 0.005) return null
  return {
    kind: 'interference',
    text: `Conditioning went up ${pct(loadUp)} over the last three weeks while the main lifts went ${strMove < -0.005 ? 'down' : 'flat'}. Worth testing whether the extra engine work is costing strength.`,
    evidence: `conditioning load ${Math.round(loadBefore)} → ${Math.round(loadNow)}; strength index ${pct(strMove)}`,
  }
}

export function fatigueSignal(sessions: TrainingSession[], points: LiftPoint[], todayN: number): Signal | null {
  const from = todayN - 28
  const gaps: number[] = []
  for (const s of sessions) {
    const d = dayNumber(s.date)
    if (d == null || d < from) continue
    const low = (s.readiness != null && s.readiness <= 4) || (s.sleep_hours != null && s.sleep_hours < 6)
    if (!low) continue
    for (const ex of s.exercises) {
      const lift = canonicalLift(ex.name)
      const today = points.find((p) => p.lift === lift && p.day === d)
      if (!today) continue
      const others = points.filter((p) => p.lift === lift && p.day !== d && Math.abs(p.day - d) <= 28).map((p) => p.value)
      const typical = mean(others)
      if (typical == null) continue
      gaps.push((today.value - typical) / typical)
    }
  }
  if (gaps.length < 2) return null
  const avg = mean(gaps)!
  if (avg > -0.03) return null
  return {
    kind: 'fatigue',
    text: `On low-readiness or short-sleep days your lifts ran ${pct(avg)} under your usual. That's fatigue, not lost strength; the goals don't count those dips.`,
    evidence: `${gaps.length} lifts on low days, mean ${pct(avg)}`,
  }
}

export function transferSignal(sessions: TrainingSession[], points: LiftPoint[], todayN: number): Signal | null {
  const from = todayN - 42
  const mid = todayN - 21
  const jumps: Array<{ day: number; value: number }> = []
  for (const s of sessions) {
    const d = dayNumber(s.date)
    if (d == null || d < from) continue
    for (const ex of s.exercises) {
      if (!isJump(ex.name)) continue
      const best = Math.max(0, ...ex.sets.filter((x) => x.done === true).map((x) => x.distance ?? 0))
      if (best > 0) jumps.push({ day: d, value: best })
    }
  }
  const squat = points.filter((p) => p.lift === 'Back Squat' && p.day >= from)
  const jumpMove = pctChange(
    mean(jumps.filter((j) => j.day < mid).map((j) => j.value)),
    mean(jumps.filter((j) => j.day >= mid).map((j) => j.value)),
  )
  const squatMove = pctChange(
    mean(squat.filter((p) => p.day < mid).map((p) => p.value)),
    mean(squat.filter((p) => p.day >= mid).map((p) => p.value)),
  )
  if (jumpMove == null || squatMove == null) return null
  if (squatMove < 0.03 || jumpMove > 0.005) return null
  return {
    kind: 'transfer',
    text: `Your squat is up ${pct(squatMove)} over six weeks and your jumps are ${jumpMove < -0.005 ? 'down' : 'flat'}. Strength isn't turning into power yet; speed and plyo work is the usual fix.`,
    evidence: `squat ${pct(squatMove)}, jump ${pct(jumpMove)}`,
  }
}

export function engineSignal(sessions: TrainingSession[], todayN: number): Signal | null {
  const reads: Array<{ day: number; fade: number; name: string }> = []
  for (const s of sessions) {
    const d = dayNumber(s.date)
    if (d == null || d < todayN - 42) continue
    for (const ex of s.exercises) {
      const f = fadeEvidence(ex.sets, null)
      if (f) reads.push({ day: d, fade: f.value, name: ex.name })
    }
  }
  if (reads.length < 3) return null
  reads.sort((a, b) => a.day - b.day)
  const first = reads[0]
  const last = reads[reads.length - 1]
  const move = last.fade - first.fade
  if (Math.abs(move) < 5) return null
  return {
    kind: 'engine',
    text: move > 0
      ? `Your last round now holds ${Math.round(last.fade)}% of your first (it was ${Math.round(first.fade)}%). The aerobic base under the intervals is improving.`
      : `Your last round fell to ${Math.round(last.fade)}% of your first (it was ${Math.round(first.fade)}%). Repeat efforts are fading more; easy aerobic work is the usual fix.`,
    evidence: `${reads.length} interval sessions, fade ${Math.round(first.fade)}% → ${Math.round(last.fade)}%`,
  }
}

export interface TrainingRead {
  /** Weak links, biggest first: ratio drift and side-to-side gaps. */
  weak_links: WeakLink[]
  /** Cross-domain hypotheses. */
  signals: Signal[]
  /** The athlete's own lift ratios, for inferred goal reads. */
  ratios: Record<string, number>
  /** Latest estimated max per lift, for context. */
  lifts: Array<{ lift: string; value: number; date: string }>
}

/** Everything the log says beyond single goals. */
export function readTraining(sessions: TrainingSession[], today: string, goals: SidedGoal[] = []): TrainingRead {
  const todayN = dayNumber(today)
  const points = liftPoints(sessions)
  const latest = new Map<string, LiftPoint>()
  for (const p of points) latest.set(p.lift, p)
  const signals = todayN == null ? [] : [
    interferenceSignal(sessions, points, todayN),
    fatigueSignal(sessions, points, todayN),
    transferSignal(sessions, points, todayN),
    engineSignal(sessions, todayN),
  ].filter((s): s is Signal => s != null)
  return {
    weak_links: [...ratioWeakLinks(points, today), ...asymmetryWeakLinks(goals)].sort((a, b) => a.delta - b.delta),
    signals,
    ratios: learnedRatios(points),
    lifts: [...latest.values()].map((p) => ({ lift: p.lift, value: Math.round(p.value), date: p.date })),
  }
}
