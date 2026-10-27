// =============================================================================
// LIFT MODEL — what the bar should say next, per main lift, from the log alone.
//
// The load the app recommended used to come from two blunt instruments: one
// weekly +5%-or-hold call shared by every lift (an average RPE across the whole
// week — a grinding bench and an easy squat cancelled out), and Epley's e1RM,
// which reads 115×5 the same whether it was an RPE 6 or a missed sixth rep. That
// is how a lifter whose best logged strict press is 125 got asked for a 135
// single: the estimate ran ahead of anything the log could back up, and nothing
// checked it against what had actually been lifted.
//
// This file replaces both for the four main lifts. For each one it reads every
// logged set and builds:
//
//   e1RM      — per set, off the RTS (Tuchscherer) reps × RPE chart. A set
//               without an RPE says only "at least this", so it is read at RPE
//               10: a floor, never a guess upward.
//   working   — the best recent evidence: qualifying sets only (1–6 reps, RPE
//   max         6–9.5, the main barbell variation, nothing missed), last six
//               weeks, recency-weighted (half-life ~3 weeks). A time series,
//               with a 4- and 8-week trend.
//   training  — 90% of the working max, unless the athlete has set one by hand.
//   max         Every prescription is a % of it, in % and in plates.
//   all-time  — context and a ceiling, never a target. Below 90% of it reads as
//   best        "returning"; nothing is prescribed above it +2.5% outside a
//               flagged test day.
//
// Then a weekly push / hold / drop off THIS lift's own top-set RPE, the in-session
// back-off and missed-rep rules, the readiness / knee / missed-week / deload
// modifiers, and a reason line on every number so it can be checked by hand:
// "245 = 65% of TM 377 (from 365x1 @8, Oct 6)".
//
// Pure, no I/O (see liftModel.check.ts). Doctrine as everywhere else: code owns
// the arithmetic. A model may narrate a recommendation; it never makes one.
//
// supabase/functions/_shared/engine/liftModel.ts is a copy for the Deno edge
// function and the Worker — keep the two identical apart from the type import.
// =============================================================================

import type { ExerciseTemplate, SetLog } from './types.ts'
import { findLibraryExercise, resolveCategory, resolvePattern } from './exerciseLibrary.ts'
import { readLoggedExercises, type LoggedWorkoutLike } from './loggedSets.ts'

// ────────────────────────────────────────────────────────────────────────────
// CANONICAL LIFTS — exact identity, never a substring.
//
// "squat" used to match anything with the word in it, so Cossack squats, ATG
// split squats and Bulgarians all fed the squat's numbers; "press" pulled the
// bench. A lift is now one of four ids, decided by the exercise library's
// canonical entry AND the absence of any word that makes it a different lift
// for e1RM purposes. The library files "paused squat" and "tempo squat" under
// Back Squat because they swap for one another; they do not estimate the same
// max, so the variation list overrules it.
// ────────────────────────────────────────────────────────────────────────────

export type MainLiftId = 'squat' | 'bench' | 'deadlift' | 'ohp'

export const MAIN_LIFTS: readonly MainLiftId[] = ['squat', 'bench', 'deadlift', 'ohp']

export const LIFT_LABEL: Record<MainLiftId, string> = {
  squat: 'Squat',
  bench: 'Bench press',
  deadlift: 'Deadlift',
  ohp: 'Strict OHP',
}

/** Upper-body lifts step 2.5% a week, lower-body 5%. */
export const IS_UPPER: Record<MainLiftId, boolean> = {
  squat: false, bench: true, deadlift: false, ohp: true,
}

const LIBRARY_LIFT: Record<string, MainLiftId> = {
  'Back Squat': 'squat',
  'Bench Press': 'bench',
  'Deadlift': 'deadlift',
  'Overhead Press': 'ohp',
}

// Any of these in the name (qualifiers included) makes it a variation. Bench is
// the one exception to "paused": a touch-and-hold bench IS the competition lift,
// and it is how this athlete benches.
const VARIATION = new RegExp(
  '\\b(' + [
    'tempo', 'pin', 'pins', 'box', 'deficit', 'block', 'blocks', 'rack', 'band', 'bands', 'banded',
    'chain', 'chains', 'spoto', 'close', 'wide', 'incline', 'decline', 'floor', 'board',
    'safety', 'ssb', 'front', 'zercher', 'landmine', 'smith', 'db', 'dumbbell', 'kb',
    'kettlebell', 'single', 'split', 'cossack', 'atg', 'bulgarian', 'goblet', 'hack', 'belt squat',
    'seated', 'push', 'behind', 'z', 'sumo', 'snatch', 'trap', 'hex', 'romanian', 'rdl',
    'stiff', 'quarter', 'half', 'partial', 'eccentric', 'isometric', 'iso', 'speed', 'dynamic',
    'one and a quarter', '1 1 4', 'jump', 'jumping', 'overhead squat',
  ].join('|') + ')\\b',
)
const PAUSE = /\b(pause|paused)\b/

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Which main lift a logged or programmed exercise IS, or null. "Squat (no
 * belt)", "Low bar squat", "Bench press", "Deadlift (conventional, no belt)",
 * "Strict OHP" resolve; "Cossack Squat", "ATG split squat", "Close-grip bench",
 * "Push press", "Seated OHP", "Pause squat" do not.
 */
export function canonicalLiftId(name: string | null | undefined): MainLiftId | null {
  if (!name) return null
  const key = nameKey(name)
  // The library has no bare "bench" (it would collide with bench-supported work).
  const entry = findLibraryExercise(key === 'bench' ? 'bench press' : name)
  const id = entry ? LIBRARY_LIFT[entry.name] ?? null : null
  if (!id) return null
  // "belt squat" is a machine; "no belt" on a squat is just how it was done.
  const scrubbed = key.replace(/\b(no|without|w o) belt\b/g, ' ')
  if (VARIATION.test(scrubbed)) return null
  if (id !== 'bench' && PAUSE.test(scrubbed)) return null
  return id
}

/** A lift named in conversation ("OHP", "overhead press", "bench") → its id. */
export function parseLiftId(query: string | null | undefined): MainLiftId | null {
  if (!query) return null
  const q = nameKey(query)
  if ((MAIN_LIFTS as readonly string[]).includes(q)) return q as MainLiftId
  const short: Record<string, MainLiftId> = {
    'back squat': 'squat', 'squats': 'squat', 'bench': 'bench', 'bench press': 'bench',
    'dead': 'deadlift', 'deadlifts': 'deadlift', 'dl': 'deadlift',
    'press': 'ohp', 'strict press': 'ohp', 'overhead': 'ohp', 'overhead press': 'ohp',
    'military': 'ohp', 'military press': 'ohp', 'strict ohp': 'ohp',
  }
  return short[q] ?? canonicalLiftId(query)
}

// ────────────────────────────────────────────────────────────────────────────
// THE RPE CHART — reps × RPE → %1RM (RTS / Tuchscherer).
//
// The chart is one curve: a set of r reps at RPE p is r + (10 − p) reps from
// failure, and %1RM depends only on that. So it is stored once, by half-rep
// steps of "reps to failure", 1 (a true single) to 16 (12 @ 6).
// ────────────────────────────────────────────────────────────────────────────

const PCT_BY_REPS_TO_FAILURE: readonly number[] = [
  // 1.0   1.5   2.0   2.5   3.0   3.5   4.0   4.5   5.0   5.5
  100.0, 97.8, 95.5, 93.9, 92.2, 90.7, 89.2, 87.8, 86.3, 85.0,
  // 6.0   6.5   7.0   7.5   8.0   8.5   9.0   9.5  10.0  10.5
  83.7, 82.4, 81.1, 79.9, 78.6, 77.4, 76.2, 75.1, 73.9, 72.3,
  // 11.0 11.5  12.0  12.5  13.0  13.5  14.0  14.5  15.0  15.5  16.0
  70.7, 69.4, 68.0, 66.7, 65.3, 64.0, 62.6, 61.3, 59.9, 58.6, 57.4,
]

/** Fraction of 1RM a set of `reps` at `rpe` represents, or null off the chart. */
export function rpePercent(reps: number, rpe: number): number | null {
  if (!Number.isFinite(reps) || !Number.isFinite(rpe)) return null
  if (reps < 1 || reps > 12 || rpe < 6 || rpe > 10) return null
  const toFailure = Math.round((reps + (10 - rpe)) * 2) / 2
  const idx = Math.round((toFailure - 1) * 2)
  const pct = PCT_BY_REPS_TO_FAILURE[idx]
  return pct == null ? null : pct / 100
}

/** e1RM off the chart. A missing RPE reads as 10 — the floor the set proves. */
export function e1rmFromSet(weight: number, reps: number, rpe: number | null): number | null {
  if (!(weight > 0) || !(reps >= 1)) return null
  const pct = rpePercent(reps, rpe ?? 10)
  return pct == null ? null : weight / pct
}

/** The load a max implies for `reps` at `rpe`. */
export function loadForReps(max: number, reps: number, rpe: number): number | null {
  const pct = rpePercent(reps, rpe)
  return pct == null ? null : max * pct
}

// ────────────────────────────────────────────────────────────────────────────
// READING THE LOG — one row per set, attributed, dated, deduplicated.
// ────────────────────────────────────────────────────────────────────────────

/** One logged set, as the model reads it. Weights in the caller's unit. */
export interface LiftSet {
  lift: MainLiftId | null
  exercise: string
  /** Athlete-local calendar day, YYYY-MM-DD. */
  date: string
  weight: number
  /** Reps completed. */
  reps: number
  rpe: number | null
  missedReps: number
  workoutId: string | null
}

/** The per-session check-in. Any field may be absent. */
export interface SessionCheckin {
  date: string
  kneePainL: number | null
  kneePainR: number | null
  sleepHours: number | null
  readiness: number | null
  bodyweight: number | null
}

/** A pain report on a named movement (a Tweak/Pain chip, severity ≥ 4). */
export interface PainFlag {
  date: string
  exercise: string
  severity: number
}

/** The workout row shape the model reads — every column optional but the log. */
export interface ModelWorkout extends LoggedWorkoutLike {
  id?: string | null
  performed_at: string
  knee_pain_l?: number | string | null
  knee_pain_r?: number | string | null
  sleep_hours?: number | string | null
  readiness?: number | string | null
  bodyweight?: number | string | null
}

/** YYYY-MM-DD of an instant, on the athlete's calendar. */
export function localDay(iso: string, timeZone = 'America/Los_Angeles'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// Postgres NUMERIC arrives as a string through some drivers; a check-in is a number or nothing.
function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function setIsLogged(s: SetLog): boolean {
  return s.done !== false || s.reps != null
}

/**
 * Every loaded set in a list of workouts, plus each session's check-in.
 * `convert` maps a stored weight into the unit the model should reason in.
 */
export function readModelLog(
  workouts: ModelWorkout[],
  opts: { timeZone?: string; convert?: (w: number) => number } = {},
): { sets: LiftSet[]; checkins: SessionCheckin[] } {
  const convert = opts.convert ?? ((w: number) => w)
  const sets: LiftSet[] = []
  const checkins: SessionCheckin[] = []
  for (const w of workouts) {
    const date = localDay(w.performed_at, opts.timeZone)
    const checkin: SessionCheckin = {
      date,
      kneePainL: num(w.knee_pain_l),
      kneePainR: num(w.knee_pain_r),
      sleepHours: num(w.sleep_hours),
      readiness: num(w.readiness),
      bodyweight: num(w.bodyweight),
    }
    if ([checkin.kneePainL, checkin.kneePainR, checkin.sleepHours, checkin.readiness, checkin.bodyweight]
      .some((v) => v != null)) checkins.push(checkin)
    for (const { name, sets: logged } of readLoggedExercises(w)) {
      const lift = canonicalLiftId(name)
      for (const s of logged) {
        if (!setIsLogged(s) || s.weight == null || !(s.weight > 0)) continue
        const missed = Math.max(0, Math.round(Number(s.missed_reps ?? 0)) || 0)
        const reps = s.reps ?? 0
        if (reps <= 0 && missed === 0) continue
        sets.push({
          lift,
          exercise: name,
          date,
          weight: convert(s.weight),
          reps,
          rpe: s.rpe ?? null,
          missedReps: missed,
          workoutId: w.id ?? null,
        })
      }
    }
  }
  return { sets, checkins }
}

/**
 * Same exercise, same day, same load, same reps → one set.
 *
 * The same session reaching the log twice (an outbox retry, an import on top of
 * an in-app log) used to count twice. It also collapses straight sets, which is
 * what the model wants: three 255×5s are one piece of evidence about the max,
 * not three. When copies disagree the HARDER reading wins — higher RPE, more
 * missed reps — so a merge can only make the estimate more conservative.
 *
 * `duplicates` counts only copies that came from a DIFFERENT workout row — the
 * double-logged sessions worth knowing about — per lift (or exercise name).
 */
export function dedupeSets(sets: LiftSet[]): { sets: LiftSet[]; removed: number; duplicates: Record<string, number> } {
  const byKey = new Map<string, LiftSet>()
  const duplicates: Record<string, number> = {}
  for (const s of sets) {
    const ex = s.lift ?? nameKey(s.exercise)
    const key = `${ex}|${s.date}|${s.weight}|${s.reps}`
    const prior = byKey.get(key)
    if (!prior) { byKey.set(key, { ...s }); continue }
    if (prior.workoutId !== s.workoutId) duplicates[ex] = (duplicates[ex] ?? 0) + 1
    const rpe = prior.rpe == null ? s.rpe : s.rpe == null ? prior.rpe : Math.max(prior.rpe, s.rpe)
    byKey.set(key, { ...prior, rpe, missedReps: Math.max(prior.missedReps, s.missedReps) })
  }
  const out = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || b.weight - a.weight)
  return { sets: out, removed: sets.length - out.length, duplicates }
}

// ────────────────────────────────────────────────────────────────────────────
// DAYS AND WEEKS — Monday-to-Sunday, on plain YYYY-MM-DD strings.
// ────────────────────────────────────────────────────────────────────────────

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from)
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days)
}

/** The Monday on or before `iso`. */
export function mondayOf(iso: string): string {
  const n = dayNumber(iso)
  const dow = (n + 4) % 7 // 1970-01-01 was a Thursday; 0 = Sunday
  return fromDayNumber(n - ((dow + 6) % 7))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 6" */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}`
}

// ────────────────────────────────────────────────────────────────────────────
// LOADS AND ROUNDING
// ────────────────────────────────────────────────────────────────────────────

export type ModelUnit = 'lb' | 'kg'

/** The smallest jump worth prescribing: 5 lb, or 2.5 lb on the press (half in kg). */
export function liftIncrement(lift: MainLiftId | null, unit: ModelUnit): number {
  const base = unit === 'kg' ? 2.5 : 5
  return lift === 'ohp' ? base / 2 : base
}

function roundTo(x: number, inc: number): number {
  return Math.round(x / inc) * inc
}

function floorTo(x: number, inc: number): number {
  return Math.floor(x / inc + 1e-9) * inc
}

/** 127.5 stays 127.5, 245.0 prints 245. */
export function fmtLoad(x: number): string {
  const r = Math.round(x * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function fmtSet(s: Pick<LiftSet, 'weight' | 'reps' | 'rpe'>): string {
  return `${fmtLoad(s.weight)}x${s.reps}${s.rpe != null ? ` @${fmtLoad(s.rpe)}` : ''}`
}

// ────────────────────────────────────────────────────────────────────────────
// WORKING MAX
// ────────────────────────────────────────────────────────────────────────────

export const WINDOW_DAYS = 42
export const HALF_LIFE_DAYS = 21
// How much an e1RM is discounted by the time it ages out of the window, at most.
// Half of it is gone at the half-life. See workingMaxAsOf for why this is a
// weighted BEST rather than a weighted average.
export const MAX_AGE_DISCOUNT = 0.10
export const TM_FRACTION = 0.9

/**
 * A set that is allowed to say what the max is. RPE 10 counts on a single only:
 * a made max single IS the max, no chart in between, while "10" on a set of five
 * is the rating lifters hand out loosely to anything that felt brutal.
 */
export function isQualifying(s: LiftSet): boolean {
  return s.lift != null
    && s.reps >= 1 && s.reps <= 6
    && s.rpe != null && s.rpe >= 6 && (s.rpe <= 9.5 || (s.rpe === 10 && s.reps === 1))
    && s.missedReps === 0
}

/** A made single at RPE 10: the max, measured rather than estimated. */
export function isTestedMax(s: LiftSet): boolean {
  return s.reps === 1 && s.rpe === 10 && s.missedReps === 0
}

export interface EvidenceSet extends LiftSet {
  e1rm: number
}

function withE1rm(s: LiftSet, assumeRpe?: number): EvidenceSet | null {
  const e1rm = e1rmFromSet(s.weight, s.reps, s.rpe ?? assumeRpe ?? null)
  return e1rm == null ? null : { ...s, e1rm }
}

/** The recency weight of a piece of evidence `age` days old (1 → today). */
export function recencyFactor(ageDays: number): number {
  const decay = Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS)
  return 1 - MAX_AGE_DISCOUNT * (1 - decay)
}

export interface WorkingMaxReading {
  value: number
  anchor: EvidenceSet
  /** How the number was arrived at. */
  basis: 'qualifying' | 'no_rpe_floor' | 'capped_by_miss' | 'carried'
  sessions: number
}

/**
 * The working max as of `asOf`: the best recency-weighted e1RM among the
 * qualifying sets of the last six weeks.
 *
 * A weighted BEST, not a weighted average, on purpose. An average is dragged
 * down by every light day that happens to qualify — a deload top set of 65% × 5
 * honestly logged at RPE 6 estimates the max 15% low, and this athlete deloads
 * every fifth week. Instead each session's best e1RM is discounted by its age
 * (nothing today, ~5% at three weeks, ~7.5% at six) and the highest one stands.
 * A new best counts in full the day it happens; an old one has to have been
 * clearly better to outrank it. The set that wins is the anchor every reason
 * line names.
 *
 * Fallbacks, both flagged: with no qualifying sets but RPE-less ones in range,
 * those are read at RPE 10 (a floor — "you did at least this"); and when the
 * newest session on the lift missed 2+ reps, the max is recomputed with that
 * failure as its ceiling.
 */
export function workingMaxAsOf(sets: LiftSet[], lift: MainLiftId, asOf: string): WorkingMaxReading | null {
  const inWindow = sets.filter((s) =>
    s.lift === lift && s.date <= asOf && daysBetween(s.date, asOf) <= WINDOW_DAYS)
  if (!inWindow.length) return null

  let basis: WorkingMaxReading['basis'] = 'qualifying'
  let evidence = inWindow.filter(isQualifying).map((s) => withE1rm(s)).filter((s): s is EvidenceSet => !!s)
  // A made max single supersedes every estimate before it: an older 5 @8 read
  // off the chart is a guess at what the test then measured. Sets after it
  // can still raise the max again.
  const tested = evidence.filter(isTestedMax).reduce<EvidenceSet | null>((a, b) => (!a || b.date > a.date ? b : a), null)
  if (tested) evidence = evidence.filter((e) => e.date >= tested.date)
  if (!evidence.length) {
    evidence = inWindow
      .filter((s) => s.rpe == null && s.missedReps === 0 && s.reps >= 1 && s.reps <= 6)
      .map((s) => withE1rm(s, 10))
      .filter((s): s is EvidenceSet => !!s)
    basis = 'no_rpe_floor'
  }
  if (!evidence.length) return null

  // Best per session first, so a session of eight singles is one vote, not eight.
  const bestByDay = new Map<string, EvidenceSet>()
  for (const e of evidence) {
    const cur = bestByDay.get(e.date)
    if (!cur || e.e1rm > cur.e1rm) bestByDay.set(e.date, e)
  }
  let anchor: EvidenceSet | null = null
  let value = 0
  for (const e of bestByDay.values()) {
    const v = e.e1rm * recencyFactor(daysBetween(e.date, asOf))
    if (v > value) { value = v; anchor = e }
  }
  if (!anchor) return null

  // 2+ missed reps on the newest session is the log saying the estimate is
  // too high. The failure set, read at RPE 10 on the reps it DID complete, caps it.
  const lastDay = inWindow.reduce((d, s) => (s.date > d ? s.date : d), '')
  const missed = inWindow.filter((s) => s.date === lastDay && s.missedReps > 0)
  const missedTotal = missed.reduce((n, s) => n + s.missedReps, 0)
  if (missedTotal >= 2) {
    const caps = missed.map((s) => (s.reps >= 1 ? s.weight / (rpePercent(s.reps, 10) ?? 1) : s.weight * 0.975))
    const cap = Math.min(...caps)
    if (cap < value) {
      const failed = missed.reduce((a, b) => (b.weight > a.weight ? b : a))
      return { value: cap, anchor: { ...failed, e1rm: cap }, basis: 'capped_by_miss', sessions: bestByDay.size }
    }
  }
  return { value, anchor, basis, sessions: bestByDay.size }
}

export interface WorkingMaxPoint {
  date: string
  value: number
  anchor: string
}

/**
 * The working max after every session that produced evidence for it — the series
 * a trend reads. A session with nothing that could move the max (no RPE while
 * RPE'd sets exist, all accessories) adds no point: the max only aging between
 * two real readings is not the lifter getting weaker.
 */
export function workingMaxSeries(sets: LiftSet[], lift: MainLiftId, through: string): WorkingMaxPoint[] {
  const mine = sets.filter((s) => s.lift === lift && s.date <= through)
  const days = [...new Set(mine.map((s) => s.date))].sort()
  const out: WorkingMaxPoint[] = []
  for (const day of days) {
    const r = workingMaxAsOf(sets, lift, day)
    if (!r) continue
    const today = mine.filter((s) => s.date === day)
    const evidence = r.basis === 'qualifying' ? today.some(isQualifying)
      : r.basis === 'no_rpe_floor' ? today.some((s) => s.rpe == null && s.reps >= 1 && s.reps <= 6)
        : today.some((s) => s.missedReps > 0)
    if (evidence) out.push({ date: day, value: r.value, anchor: `${fmtSet(r.anchor)} ${shortDay(r.anchor.date)}` })
  }
  return out
}

export interface Trend {
  weeks: number
  /** Least-squares slope, in load per week. */
  perWeek: number
  /** The same slope as a share of the latest working max, per week. */
  pctPerWeek: number
  points: number
}

/** Slope of the working-max series over the last `weeks`, or null without two points a week apart. */
export function trendOver(series: WorkingMaxPoint[], asOf: string, weeks: number): Trend | null {
  const from = addDays(asOf, -weeks * 7)
  const pts = series.filter((p) => p.date >= from && p.date <= asOf)
  if (pts.length < 2 || daysBetween(pts[0].date, pts[pts.length - 1].date) < 7) return null
  const xs = pts.map((p) => daysBetween(from, p.date))
  const ys = pts.map((p) => p.value)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2 })
  if (den === 0) return null
  const perWeek = (num / den) * 7
  const last = ys[ys.length - 1]
  return {
    weeks,
    perWeek: Math.round(perWeek * 10) / 10,
    pctPerWeek: Math.round((perWeek / last) * 1000) / 10,
    points: pts.length,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ALL-TIME BEST — context and a ceiling, never a target.
// ────────────────────────────────────────────────────────────────────────────

export interface AllTimeBest {
  /** Best e1RM ever logged on the main variation (RPE-less sets read at 10). */
  e1rm: number
  e1rmSet: LiftSet
  /** Heaviest load ever completed for at least one rep. */
  heaviest: LiftSet
}

export const CEILING_PCT = 2.5
export const DETRAINED_BELOW = 0.9

export function allTimeBest(sets: LiftSet[], lift: MainLiftId): AllTimeBest | null {
  const mine = sets.filter((s) => s.lift === lift && s.reps >= 1)
  if (!mine.length) return null
  const heaviest = mine.reduce((a, b) => (b.weight > a.weight || (b.weight === a.weight && b.reps > a.reps) ? b : a))
  let best: EvidenceSet | null = null
  for (const s of mine) {
    if (s.missedReps > 0 || s.reps > 10) continue
    const e = withE1rm(s, 10)
    if (e && (!best || e.e1rm > best.e1rm)) best = e
  }
  if (!best) return null
  return { e1rm: best.e1rm, e1rmSet: best, heaviest }
}

/**
 * The most a prescription may ask for: the heaviest load ever completed + 2.5%,
 * and no set whose implied e1RM beats the best ever + 2.5%. Both, because a 135
 * single is out of reach for a lifter whose heaviest press is 125 even when a
 * fast set of fives says the e1RM could carry it.
 */
export function ceilingLoad(best: AllTimeBest, reps: number, rpe: number): number {
  const byLoad = best.heaviest.weight * (1 + CEILING_PCT / 100)
  const byE1rm = (loadForReps(best.e1rm * (1 + CEILING_PCT / 100), reps, Math.min(10, rpe)) ?? Infinity)
  return Math.min(byLoad, byE1rm)
}

// ────────────────────────────────────────────────────────────────────────────
// IN-SESSION AUTOREGULATION
// ────────────────────────────────────────────────────────────────────────────

/**
 * What the back-off sets should be once the top set is in. A top set a full
 * point over target takes 5% off the back-offs; a full point under adds 2.5%
 * (upper) or 5% (lower). Anything closer than a point is the plan working.
 */
export function backoffLoad(
  topLoad: number, topRpe: number | null, targetRpe: number, upper: boolean,
): { load: number; deltaPct: number; why: string } {
  if (topRpe != null && topRpe >= targetRpe + 1) {
    return { load: topLoad * 0.95, deltaPct: -5, why: `top set @${fmtLoad(topRpe)} vs target ${fmtLoad(targetRpe)} → back-offs −5%` }
  }
  if (topRpe != null && topRpe <= targetRpe - 1) {
    const up = upper ? 2.5 : 5
    return { load: topLoad * (1 + up / 100), deltaPct: up, why: `top set @${fmtLoad(topRpe)} vs target ${fmtLoad(targetRpe)} → back-offs +${up}%` }
  }
  return { load: topLoad, deltaPct: 0, why: 'top set on target → back-offs stay' }
}

// ────────────────────────────────────────────────────────────────────────────
// THE WEEKLY CALL — push / hold / drop, off THIS lift's top set.
// ────────────────────────────────────────────────────────────────────────────

export type WeeklyCall = 'push' | 'hold' | 'drop' | 'repeat' | 'miss'

export interface TopSetWeek {
  weekStart: string
  top: LiftSet
  /** Reps missed across the lift's last session that week. */
  missedReps: number
  lastSessionDate: string
}

export interface CallInput {
  upper: boolean
  target: number
  last: TopSetWeek | null
  prior: TopSetWeek | null
  pain: string | null
}

/**
 * Precedence, first match wins:
 *   1. missed reps on the last session — 1 repeats the load, 2+ drops 5%
 *   2. no RPE on the top set — hold (nothing to autoregulate against)
 *   3. above target two weeks running — drop 5%
 *   4. at or below target, pain-free — push (+2.5% upper, +5% lower)
 *   5. otherwise hold: within half a point over target, a first week further
 *      over (the back-offs already came down in-session), or a pain flag
 */
export function weeklyCall(c: CallInput): { call: WeeklyCall; deltaPct: number; why: string } {
  const t = fmtLoad(c.target)
  if (!c.last) return { call: 'hold', deltaPct: 0, why: 'no top set to read' }
  const top = c.last.top
  const at = `${fmtSet(top)} on ${shortDay(top.date)}`
  if (c.last.missedReps >= 2) {
    return { call: 'miss', deltaPct: -5, why: `missed ${c.last.missedReps} reps on ${shortDay(c.last.lastSessionDate)} → −5%, working max recomputed` }
  }
  if (c.last.missedReps === 1) {
    return { call: 'repeat', deltaPct: 0, why: `missed 1 rep on ${shortDay(c.last.lastSessionDate)} → repeat the load` }
  }
  if (top.rpe == null) {
    return { call: 'hold', deltaPct: 0, why: `hold: no RPE on ${at} — log it on the top set to unlock progression` }
  }
  const priorRpe = c.prior?.top.rpe ?? null
  if (top.rpe > c.target && priorRpe != null && priorRpe > c.target) {
    return { call: 'drop', deltaPct: -5, why: `drop −5%: above target ${t} two weeks running (@${fmtLoad(priorRpe)} ${shortDay(c.prior!.top.date)}, @${fmtLoad(top.rpe)} ${shortDay(top.date)})` }
  }
  if (top.rpe <= c.target && !c.pain) {
    const up = c.upper ? 2.5 : 5
    return { call: 'push', deltaPct: up, why: `push +${up}%: ${at} vs target ${t}, no pain flags` }
  }
  if (c.pain) return { call: 'hold', deltaPct: 0, why: `hold: ${c.pain} — no push until it settles` }
  if (top.rpe <= c.target + 0.5) return { call: 'hold', deltaPct: 0, why: `hold: ${at} is within 0.5 of target ${t}` }
  return { call: 'hold', deltaPct: 0, why: `hold: ${at} is over target ${t} — one week isn't a trend` }
}

// ────────────────────────────────────────────────────────────────────────────
// MODIFIERS — knee, sleep / readiness, missed weeks, deload.
// ────────────────────────────────────────────────────────────────────────────

export const KNEE_PAIN_LIMIT = 4
export const JUMP_PAIN_LIMIT = 3
export const SLEEP_FLOOR_HOURS = 6
export const READINESS_FLOOR = 5
export const LOW_READINESS_RPE_CAP = 7
export const DELOAD_TM_PCT = 65
export const DELOAD_RPE_CAP = 6

export interface DayOf {
  sleepHours?: number | null
  readiness?: number | null
  kneePainL?: number | null
  kneePainR?: number | null
}

export function kneePain(d: DayOf | SessionCheckin | null | undefined): number | null {
  if (!d) return null
  const vals = [d.kneePainL, d.kneePainR].filter((v): v is number => v != null)
  return vals.length ? Math.max(...vals) : null
}

/** Squat-, lunge- and jump-pattern work: what a sore knee reduces. */
export function isKneeDominant(exerciseName: string): { knee: boolean; jump: boolean } {
  const id = canonicalLiftId(exerciseName)
  if (id === 'squat') return { knee: true, jump: false }
  const p = resolvePattern(exerciseName)
  return { knee: p === 'squat' || p === 'single_leg' || p === 'jump', jump: p === 'jump' }
}

export interface Modifier {
  factor: number
  rpeCap: number | null
  skip: boolean
  note: string
}

/**
 * The day-of modifiers for one movement. Knee pain ≥ 4 takes 10% off squat,
 * lunge and jump work (or cut the range); jumps are skipped above 3. Under 6 h
 * of sleep or readiness under 5 takes 5% off everything and caps RPE at 7.
 */
export function dayOfModifiers(exerciseName: string, d: DayOf | null | undefined): Modifier[] {
  if (!d) return []
  const out: Modifier[] = []
  const knee = kneePain(d)
  const { knee: kneeWork, jump } = isKneeDominant(exerciseName)
  if (knee != null && kneeWork) {
    if (jump && knee > JUMP_PAIN_LIMIT) {
      out.push({ factor: 0, rpeCap: null, skip: true, note: `knee pain ${fmtLoad(knee)}/10 → skip jumps today` })
    } else if (knee >= KNEE_PAIN_LIMIT) {
      out.push({ factor: 0.9, rpeCap: null, skip: false, note: `knee pain ${fmtLoad(knee)}/10 → −10% (or cut the range)` })
    }
  }
  const sleepShort = d.sleepHours != null && d.sleepHours < SLEEP_FLOOR_HOURS
  const lowReady = d.readiness != null && d.readiness < READINESS_FLOOR
  if (sleepShort || lowReady) {
    const why = [sleepShort ? `${fmtLoad(d.sleepHours!)}h sleep` : null, lowReady ? `readiness ${d.readiness}/10` : null]
      .filter(Boolean).join(', ')
    out.push({ factor: 0.95, rpeCap: LOW_READINESS_RPE_CAP, skip: false, note: `${why} → −5%, cap RPE ${LOW_READINESS_RPE_CAP}` })
  }
  return out
}

/** −5% after one week off the lift, −10% (and re-establish) after two or more. */
export function missedWeeksModifier(weeks: number): Modifier | null {
  if (weeks >= 2) return { factor: 0.9, rpeCap: null, skip: false, note: `${weeks} weeks without this lift → −10%, re-establish the working max` }
  if (weeks === 1) return { factor: 0.95, rpeCap: null, skip: false, note: 'missed last week → −5%' }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// THE MODEL
// ────────────────────────────────────────────────────────────────────────────

/** What the program asks of the lift this week. */
// ────────────────────────────────────────────────────────────────────────────
// HAND-SET TRAINING MAX — and when it has stopped being right.
//
// An override is the athlete saying "load me off this number". It wins over the
// computed TM, but it is a snapshot: the log keeps moving under it. So each one
// is stored with when it was set and what the model's own TM was then, and it
// reads as stale when it is old, when the model has since moved a long way, or
// when reps were missed after it was set. Stale is a flag, never a reset.
// ────────────────────────────────────────────────────────────────────────────

/**
 * One entry of athlete.training_max_overrides. Writes before set_at existed
 * are a bare number, and read as { value } with no date.
 */
export interface TmOverride {
  value: number
  /** ISO timestamp of the write. */
  set_at?: string | null
  /** The computed TM when it was set, in the same unit as value. */
  model_tm?: number | null
}

export function readTmOverride(v: unknown): TmOverride | null {
  if (v != null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const value = num(o.value)
    if (value == null || value <= 0) return null
    return { value, set_at: typeof o.set_at === 'string' ? o.set_at : null, model_tm: num(o.model_tm) }
  }
  const value = num(v)
  return value != null && value > 0 ? { value } : null
}

/** The same override in another unit: value and model_tm both move. */
export function convertTmOverride(o: TmOverride, f: (w: number) => number): TmOverride {
  return { ...o, value: f(o.value), model_tm: o.model_tm != null ? f(o.model_tm) : null }
}

export const STALE_OVERRIDE_DAYS = 28
/** How far the computed TM may move after an override before it reads stale. */
export const MODEL_MOVED_PCT = 5
/** An undated override is only flagged when it sits this far from the model. */
export const UNDATED_DRIFT_PCT = 10

export interface OverrideStatus {
  /** Athlete-local day it was set, or null for an undated write. */
  setOn: string | null
  ageDays: number | null
  modelAtSet: number | null
  /** Why the hand-set number may no longer be right. Empty when it still holds. */
  stale: string[]
}

export function overrideStatus(input: {
  value: number
  setOn: string | null
  modelAtSet: number | null
  computedNow: number | null
  sets: LiftSet[]
  lift: MainLiftId
  today: string
}): OverrideStatus {
  const { value, setOn, modelAtSet, computedNow, today } = input
  const stale: string[] = []
  const ageDays = setOn ? Math.max(0, daysBetween(setOn, today)) : null
  if (ageDays != null && ageDays >= STALE_OVERRIDE_DAYS) {
    stale.push(`set ${Math.floor(ageDays / 7)} weeks ago (${shortDay(setOn!)})`)
  }
  if (modelAtSet != null && modelAtSet > 0 && computedNow != null) {
    const moved = ((computedNow - modelAtSet) / modelAtSet) * 100
    if (Math.abs(moved) >= MODEL_MOVED_PCT) {
      stale.push(`the model's TM has moved ${fmtLoad(Math.round(modelAtSet))} → ${fmtLoad(Math.round(computedNow))} since`)
    }
  } else if (!setOn && computedNow != null && computedNow > 0) {
    const off = ((value - computedNow) / computedNow) * 100
    if (Math.abs(off) >= UNDATED_DRIFT_PCT) {
      stale.push(`${Math.round(Math.abs(off))}% ${off > 0 ? 'above' : 'below'} the model's ${fmtLoad(Math.round(computedNow))}, date set unknown`)
    }
  }
  // Strictly after the day it was set: a TM lowered in answer to a miss that
  // same morning is the athlete already acting on it.
  if (setOn) {
    const miss = input.sets
      .filter((s) => s.lift === input.lift && s.date > setOn && s.date <= today && s.missedReps > 0)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    if (miss) stale.push(`missed reps on ${shortDay(miss.date)}, after it was set`)
  }
  return { setOn, ageDays, modelAtSet, stale }
}

export interface LiftPrescription {
  sets: number
  reps: string | number
  targetRpe?: number | null
  /** The program's own load text — a % here is a % of the training max. */
  load?: string | null
  exercise?: string
}

export interface LiftModelInput {
  lift: MainLiftId
  /** Every logged set, any lift — the model filters and dedupes. */
  sets: LiftSet[]
  checkins?: SessionCheckin[]
  pain?: PainFlag[]
  /** Athlete-local today, YYYY-MM-DD. */
  today: string
  unit?: ModelUnit
  tmOverride?: number | null
  /** When the override was set (athlete-local day) and the computed TM then. */
  tmOverrideSet?: { on: string | null; modelTm: number | null } | null
  prescription?: LiftPrescription | null
  /** The block's RPE target when the lift carries none of its own. */
  defaultTargetRpe?: number
  deload?: boolean
  testDay?: boolean
  /** Today's check-in, when the athlete has given one. */
  dayOf?: DayOf | null
  /** A standing reason a push may not happen (the app's limiter cap). Holds instead. */
  noPush?: string | null
}

export interface Recommendation {
  weekStart: string
  exercise: string | null
  sets: number
  reps: number
  targetRpe: number
  /** The most the top set should feel like today, when a modifier caps it. */
  rpeCap: number | null
  load: number
  pctOfTm: number | null
  call: WeeklyCall | 'deload' | 'program_pct' | 'establish'
  basis: 'last_top_set' | 'rpe_chart' | 'program_pct' | 'deload'
  /** "245 = 65% of TM 377 (from 365x1 @8, Oct 6)" */
  reason: string
  /** The decision, the base, each modifier, the ceiling — one line each. */
  why: string[]
  backoff: { onTarget: number; ifHeavy: number; ifLight: number }
  /** Day-of modifiers not yet known — what changes if today goes badly. */
  conditional: string[]
  capped: boolean
  skip: boolean
}

export interface LiftModel {
  lift: MainLiftId
  label: string
  unit: ModelUnit
  asOf: string
  workingMax: (WorkingMaxReading & { rounded: number }) | null
  trainingMax: {
    value: number
    source: 'computed' | 'override'
    computed: number | null
    /** Only on an override. */
    override: OverrideStatus | null
  } | null
  trend: { w4: Trend | null; w8: Trend | null }
  series: WorkingMaxPoint[]
  allTimeBest: AllTimeBest | null
  /** Working max under 90% of the all-time best: returning, not chasing. */
  detrained: boolean
  lastQualifying: EvidenceSet[]
  lastWeek: TopSetWeek | null
  priorWeek: TopSetWeek | null
  /** Consecutive full weeks before this one without the lift. */
  missedWeeks: number
  /** Sets on this lift that were logged twice by different workout rows. */
  duplicatesRemoved: number
  recommendation: Recommendation | null
  notes: string[]
}

/** "5", "3-5", "5 reps" → the rep count to load for (the top of a range: the lighter load). */
export function targetReps(reps: string | number | null | undefined): { lo: number; hi: number } | null {
  if (typeof reps === 'number') return reps >= 1 ? { lo: reps, hi: reps } : null
  if (!reps) return null
  const m = String(reps).match(/(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/)
  if (!m) return null
  const lo = Number(m[1])
  const hi = m[2] != null ? Number(m[2]) : lo
  return lo >= 1 ? { lo: Math.min(lo, hi), hi: Math.max(lo, hi) } : null
}

/** "70%", "65-70% TM" → 67.5. Null when the load text carries no percentage. */
export function percentOf(load: string | null | undefined): number | null {
  if (!load) return null
  const m = load.match(/(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?))?\s*%/)
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] != null ? Number(m[2]) : a
  const p = (a + b) / 2
  return p > 0 && p <= 110 ? p : null
}

/** The heaviest set of each week the lift was trained, newest first. */
function topSetWeeks(sets: LiftSet[], lift: MainLiftId, before: string): TopSetWeek[] {
  const byWeek = new Map<string, LiftSet[]>()
  for (const s of sets) {
    if (s.lift !== lift || s.date >= before) continue
    const wk = mondayOf(s.date)
    const list = byWeek.get(wk) ?? []
    list.push(s)
    byWeek.set(wk, list)
  }
  const out: TopSetWeek[] = []
  for (const [weekStart, list] of byWeek) {
    // Heaviest load wins; at the same load the harder reading is the honest one.
    const top = list.reduce((a, b) => {
      if (b.weight !== a.weight) return b.weight > a.weight ? b : a
      if (b.reps !== a.reps) return b.reps > a.reps ? b : a
      return (b.rpe ?? -1) > (a.rpe ?? -1) ? b : a
    })
    const lastSessionDate = list.reduce((d, s) => (s.date > d ? s.date : d), '')
    const missedReps = list.filter((s) => s.date === lastSessionDate).reduce((n, s) => n + s.missedReps, 0)
    out.push({ weekStart, top, missedReps, lastSessionDate })
  }
  return out.sort((a, b) => b.weekStart.localeCompare(a.weekStart))
}

function painFor(lift: MainLiftId, pain: PainFlag[], checkins: SessionCheckin[], from: string, to: string): string | null {
  const flag = pain.find((p) => p.severity >= 4 && p.date >= from && p.date <= to && canonicalLiftId(p.exercise) === lift)
  if (flag) return `pain flag on ${shortDay(flag.date)}`
  if (lift === 'squat') {
    const knee = checkins
      .filter((c) => c.date >= from && c.date <= to)
      .map((c) => ({ c, k: kneePain(c) }))
      .find(({ k }) => k != null && k >= KNEE_PAIN_LIMIT)
    if (knee) return `knee pain ${fmtLoad(knee.k!)}/10 on ${shortDay(knee.c.date)}`
  }
  return null
}

export function buildLiftModel(input: LiftModelInput): LiftModel {
  const { lift, today } = input
  const unit = input.unit ?? 'lb'
  const inc = liftIncrement(lift, unit)
  const upper = IS_UPPER[lift]
  const notes: string[] = []

  const deduped = dedupeSets(input.sets)
  const sets = deduped.sets.filter((s) => s.date <= today)
  const mine = sets.filter((s) => s.lift === lift)
  const checkins = input.checkins ?? []
  const weekStart = mondayOf(today)

  const series = workingMaxSeries(sets, lift, today)
  const best = allTimeBest(sets, lift)
  const lastQualifying = mine.filter(isQualifying).map((s) => withE1rm(s)).filter((s): s is EvidenceSet => !!s)
    .sort((a, b) => b.date.localeCompare(a.date) || b.e1rm - a.e1rm).slice(0, 6)

  // A max older than the window is still the last thing the log knew. It is
  // carried, flagged, and taken down by the missed-weeks modifier below.
  // It is the max as it stood the last day the lift was trained — already
  // discounted for the age of its evidence then — not a fresh reading.
  let wm = workingMaxAsOf(sets, lift, today)
  const lastTrained = mine.reduce((d, s) => (s.date > d ? s.date : d), '')
  if (!wm && lastTrained) {
    const then = workingMaxAsOf(sets, lift, lastTrained)
      ?? (series.length ? workingMaxAsOf(sets, lift, series[series.length - 1].date) : null)
    if (then) {
      wm = { ...then, basis: 'carried' }
      notes.push(`nothing on it in the last ${WINDOW_DAYS / 7} weeks — working max carried from ${shortDay(lastTrained)}, last trained`)
    }
  }
  if (wm?.basis === 'no_rpe_floor') notes.push('no RPE logged in the window — working max is a floor (those sets read at RPE 10)')
  if (wm?.basis === 'capped_by_miss') notes.push(`working max recomputed from the miss on ${shortDay(wm.anchor.date)}`)
  if (wm && isTestedMax(wm.anchor)) {
    const anchor = wm.anchor
    const outranked = mine.some((s) => s.date < anchor.date && daysBetween(s.date, today) <= WINDOW_DAYS
      && isQualifying(s) && (withE1rm(s)?.e1rm ?? 0) > anchor.e1rm)
    if (outranked) notes.push(`working max is the tested single ${fmtSet(anchor)} on ${shortDay(anchor.date)} — higher estimates from before it no longer count`)
  }

  const computedTm = wm ? wm.value * TM_FRACTION : null
  const override = input.tmOverride != null && input.tmOverride > 0 ? input.tmOverride : null
  const tm = override ?? computedTm
  const overrideState = override != null
    ? overrideStatus({
      value: override,
      setOn: input.tmOverrideSet?.on ?? null,
      modelAtSet: input.tmOverrideSet?.modelTm ?? null,
      computedNow: computedTm,
      sets,
      lift,
      today,
    })
    : null
  const trainingMax = tm != null
    ? {
      value: tm,
      source: override != null ? 'override' as const : 'computed' as const,
      computed: computedTm,
      override: overrideState,
    }
    : null
  if (overrideState?.stale.length) notes.push(`hand-set TM may be out of date: ${overrideState.stale.join('; ')}`)

  const detrained = wm != null && best != null && wm.value < best.e1rm * DETRAINED_BELOW
  if (detrained && wm && best) {
    notes.push(`returning: working max ${fmtLoad(Math.round(wm.value))} is ${Math.round((wm.value / best.e1rm) * 100)}% of the all-time best e1RM ${fmtLoad(Math.round(best.e1rm))} — build back, don't chase it`)
  }

  const weeks = topSetWeeks(sets, lift, weekStart)
  const thisWeek = topSetWeeks(sets, lift, addDays(today, 1)).find((w) => w.weekStart === weekStart) ?? null
  const lastWeek = weeks.find((w) => w.weekStart === addDays(weekStart, -7)) ?? null
  const priorWeek = weeks.find((w) => w.weekStart === addDays(weekStart, -14)) ?? null
  let missedWeeks = 0
  if (weeks.length) {
    while (missedWeeks < 52 && !weeks.some((w) => w.weekStart === addDays(weekStart, -7 * (missedWeeks + 1)))) missedWeeks++
  }
  if (thisWeek) notes.push(`already trained this week: top set ${fmtSet(thisWeek.top)} on ${shortDay(thisWeek.top.date)}`)

  const model: LiftModel = {
    lift,
    label: LIFT_LABEL[lift],
    unit,
    asOf: today,
    workingMax: wm ? { ...wm, rounded: Math.round(wm.value) } : null,
    trainingMax,
    trend: { w4: trendOver(series, today, 4), w8: trendOver(series, today, 8) },
    series,
    allTimeBest: best,
    detrained,
    lastQualifying,
    lastWeek,
    priorWeek,
    missedWeeks,
    duplicatesRemoved: deduped.duplicates[lift] ?? 0,
    recommendation: null,
    notes,
  }
  if (!mine.length) return model

  // ── what is being asked for ────────────────────────────────────────────────
  const rx = input.prescription ?? null
  const newestTrained = weeks[0] ?? null
  const reps = targetReps(rx?.reps) ?? { lo: newestTrained?.top.reps ?? 5, hi: newestTrained?.top.reps ?? 5 }
  const repCount = Math.min(12, reps.hi)
  const target = rx?.targetRpe ?? input.defaultTargetRpe ?? 8
  const setCount = rx?.sets ?? 3
  const why: string[] = []

  // The week the call reads: the newest week the lift was trained before this
  // one. After a missed week that is two back, and the missed-weeks modifier
  // takes the load down on top of whatever it says. A miss earlier THIS week is
  // newer news than any of it.
  const last = lastWeek ?? newestTrained
  const prior = last ? weeks.find((w) => w.weekStart === addDays(last.weekStart, -7)) ?? null : null
  const missedThisWeek = thisWeek != null && thisWeek.missedReps >= 1
  const ref = missedThisWeek ? thisWeek : last
  const kneeToday = lift === 'squat' ? kneePain(input.dayOf) : null
  const pain = kneeToday != null && kneeToday >= KNEE_PAIN_LIMIT
    ? `knee pain ${fmtLoad(kneeToday)}/10 today`
    : painFor(lift, input.pain ?? [], checkins, addDays(weekStart, -7), today)
  // Everything loads off the TRAINING max, so a hand-set TM moves every number.
  const chartMax = tm != null ? tm / TM_FRACTION : null

  let base: number
  let basis: Recommendation['basis']
  let call: Recommendation['call']
  let deltaPct = 0
  const programPct = percentOf(rx?.load)

  if (input.deload && tm != null) {
    base = tm * DELOAD_TM_PCT / 100
    basis = 'deload'
    call = 'deload'
    why.push(`deload week: ${DELOAD_TM_PCT}% of TM, RPE ≤ ${DELOAD_RPE_CAP}`)
  } else if (programPct != null && tm != null) {
    base = tm * programPct / 100
    basis = 'program_pct'
    call = 'program_pct'
    why.push(`program prescribes ${fmtLoad(programPct)}% of TM`)
  } else {
    let decision = weeklyCall({ upper, target, last: ref, prior: missedThisWeek ? null : prior, pain })
    // A push reads last week's effort as this week's capacity. After time off
    // it isn't, so the missed-weeks modifier is the only step taken.
    if (missedWeeks >= 1 && decision.call === 'push') {
      decision = { call: 'hold', deltaPct: 0, why: `hold: last trained ${shortDay(last!.top.date)} — no push straight back from time off` }
    }
    if (input.noPush && decision.call === 'push') {
      decision = { call: 'hold', deltaPct: 0, why: `hold: ${input.noPush} (would have been ${decision.why})` }
    }
    call = missedWeeks >= 2 ? 'establish' : decision.call
    deltaPct = decision.deltaPct
    why.push(decision.why)
    // A hand-set TM scales last week's top set by how far it sits from the
    // model's own: equal to it changes nothing, 5% under takes 5% off. Without
    // this, setting one would move nothing on a week that repeats a rep range.
    // With no model TM to compare against, it charts the base instead.
    const comparable = ref != null && ref.top.reps >= reps.lo && ref.top.reps <= reps.hi
    const tmScale = override != null && computedTm != null && computedTm > 0 ? override / computedTm : null
    if (comparable && (override == null || tmScale != null)) {
      base = ref!.top.weight * (tmScale ?? 1)
      basis = 'last_top_set'
      const pct = tmScale != null ? Math.round((tmScale - 1) * 1000) / 10 : 0
      why.push(`base: top set ${fmtSet(ref!.top)} on ${shortDay(ref!.top.date)}${pct !== 0
        ? `, ${pct > 0 ? '+' : '−'}${fmtLoad(Math.abs(pct))}% for the hand-set TM (${fmtLoad(Math.round(override!))} vs the model's ${fmtLoad(Math.round(computedTm!))})`
        : ''}`)
    } else if (chartMax != null) {
      base = loadForReps(chartMax, repCount, target) ?? ref?.top.weight ?? 0
      basis = 'rpe_chart'
      const pct = rpePercent(repCount, target)
      why.push(`base: ${repCount} @${fmtLoad(target)} is ${pct != null ? fmtLoad(pct * 100) : '?'}% of ${fmtLoad(Math.round(chartMax))} on the RPE chart${override != null ? ', off the hand-set TM' : ''}${ref ? ` (last top set was ${fmtSet(ref.top)})` : ''}`)
    } else {
      base = ref?.top.weight ?? 0
      basis = 'last_top_set'
      why.push('base: last top set — no working max to chart from')
    }
    if (call === 'establish') why.push('re-establish: log an honest RPE on the top set; the working max rebuilds from it')
  }

  let load = base * (1 + deltaPct / 100)
  let rpeCap: number | null = input.deload ? DELOAD_RPE_CAP : null
  let skip = false
  const mods: Modifier[] = []
  if (!input.deload) {
    const missed = missedWeeksModifier(missedWeeks)
    if (missed) mods.push(missed)
  }
  const exerciseName = rx?.exercise ?? LIFT_LABEL[lift]
  // A check-in from earlier this week still says something about the knee; the
  // sleep and readiness rules are today-only.
  const recentCheckin = checkins.filter((c) => c.date >= weekStart && c.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null
  const todayCheckin = checkins.find((c) => c.date === today) ?? null
  const dayOf: DayOf | null = input.dayOf ?? (todayCheckin
    ? todayCheckin
    : recentCheckin ? { kneePainL: recentCheckin.kneePainL, kneePainR: recentCheckin.kneePainR } : null)
  mods.push(...dayOfModifiers(exerciseName, dayOf))
  for (const m of mods) {
    if (m.skip) { skip = true; why.push(m.note); continue }
    load *= m.factor
    if (m.rpeCap != null) rpeCap = rpeCap == null ? m.rpeCap : Math.min(rpeCap, m.rpeCap)
    why.push(m.note)
  }
  const effectiveRpe = rpeCap != null ? Math.min(target, rpeCap) : target

  // The ceiling, last, so nothing above can talk its way past it.
  const ceiling = best && !input.testDay ? ceilingLoad(best, repCount, effectiveRpe) : Infinity
  let capped = false
  if (load > ceiling) {
    load = ceiling
    capped = true
    why.push(`capped: heaviest ever is ${fmtSet(best!.heaviest)} (${shortDay(best!.heaviest.date)}), best e1RM ${fmtLoad(Math.round(best!.e1rm))} — nothing above +${CEILING_PCT}% except on a test day`)
  }
  if (input.testDay) why.push('test day: the all-time-best ceiling is lifted')
  const fit = (x: number) => (x >= ceiling ? floorTo(ceiling, inc) : roundTo(x, inc))
  const rounded = fit(load)

  const conditional: string[] = []
  if (!input.dayOf && !todayCheckin) {
    conditional.push(`if sleep < ${SLEEP_FLOOR_HOURS}h or readiness < ${READINESS_FLOOR} today: −5% → ${fmtLoad(fit(load * 0.95))}, cap RPE ${LOW_READINESS_RPE_CAP}`)
    const knee = kneePain(dayOf)
    if (lift === 'squat' && !(knee != null && knee >= KNEE_PAIN_LIMIT)) {
      conditional.push(`if a knee is ≥ ${KNEE_PAIN_LIMIT}/10 today: −10% → ${fmtLoad(fit(load * 0.9))}, or cut the range`)
    }
  }

  const pctOfTm = tm != null && tm > 0 ? Math.round((rounded / tm) * 100) : null
  const anchor = wm?.anchor ?? null
  const source = anchor ? `from ${fmtSet(anchor)}${anchor.rpe == null ? ' (no RPE)' : ''}, ${shortDay(anchor.date)}` : null
  const reason = tm != null
    ? `${fmtLoad(rounded)} = ${pctOfTm}% of TM ${fmtLoad(Math.round(tm))}${override != null ? ' (set by hand)' : ''}${source ? ` (${source})` : ''}`
    : `${fmtLoad(rounded)} (no training max yet${ref ? ` — from top set ${fmtSet(ref.top)}, ${shortDay(ref.top.date)}` : ''})`

  model.recommendation = {
    weekStart,
    exercise: rx?.exercise ?? null,
    sets: setCount,
    reps: repCount,
    targetRpe: effectiveRpe,
    rpeCap,
    load: rounded,
    pctOfTm,
    call,
    basis,
    reason,
    why,
    backoff: {
      onTarget: rounded,
      ifHeavy: fit(backoffLoad(rounded, effectiveRpe + 1, effectiveRpe, upper).load),
      ifLight: fit(backoffLoad(rounded, effectiveRpe - 1, effectiveRpe, upper).load),
    },
    conditional,
    capped,
    skip,
  }
  return model
}

/** Build all four from one log read. */
export function buildLiftModels(
  base: Omit<LiftModelInput, 'lift' | 'tmOverride' | 'prescription'> & {
    tmOverrides?: Partial<Record<MainLiftId, number | null>>
    prescriptions?: Partial<Record<MainLiftId, LiftPrescription | null>>
  },
): Record<MainLiftId, LiftModel> {
  const out = {} as Record<MainLiftId, LiftModel>
  for (const lift of MAIN_LIFTS) {
    out[lift] = buildLiftModel({
      ...base,
      lift,
      tmOverride: base.tmOverrides?.[lift] ?? null,
      prescription: base.prescriptions?.[lift] ?? null,
    })
  }
  return out
}

/** The first exercise in a week of sessions that is this lift, as a prescription. */
export function prescriptionFromProgram(
  lift: MainLiftId,
  sessions: Array<{ name?: string; intent?: string | null; exercises: ExerciseTemplate[] }>,
): (LiftPrescription & { session: string | null; sessionIntent: string | null }) | null {
  for (const s of sessions) {
    for (const ex of s.exercises ?? []) {
      if (canonicalLiftId(ex.name) !== lift) continue
      return {
        sets: ex.sets,
        reps: ex.reps,
        targetRpe: ex.target_rpe ?? null,
        load: ex.load ?? null,
        exercise: ex.name,
        session: s.name ?? null,
        sessionIntent: s.intent ?? null,
      }
    }
  }
  return null
}

/**
 * Is this a deload or a test day, from the words the program used? The same two
 * rules prescription.ts's trainingIntent reads, kept here so the edge copy of
 * this file needs nothing it doesn't already have.
 */
export function sessionFlags(...texts: Array<string | null | undefined>): { deload: boolean; testDay: boolean } {
  const hay = texts.filter(Boolean).join(' ')
  return {
    deload: /\bdeload\b/i.test(hay),
    testDay: /\b(test|retest|max out|1rm test|pr day|pr week)\b/i.test(hay),
  }
}

/**
 * How a search for a lift matches a logged name. A main lift matches by identity
 * — "squat" is the squat and nothing else — and anything else still matches by
 * substring, so "row" keeps finding every row.
 */
export function liftNameMatcher(query: string): (name: string) => boolean {
  const id = parseLiftId(query)
  if (id) return (name) => canonicalLiftId(name) === id
  const want = query.trim().toLowerCase()
  return (name) => name.toLowerCase().includes(want)
}

/** Upper-body accessory or lower? (+2.5% vs +5% on a push.) */
export function isUpperBody(exerciseName: string): boolean {
  const id = canonicalLiftId(exerciseName)
  if (id) return IS_UPPER[id]
  return resolveCategory(exerciseName) === 'Upper Chain'
}

// ────────────────────────────────────────────────────────────────────────────
// FROM ROWS — the one assembly every caller shares (the app, and the local,
// edge and Worker MCPs), so none of them decides on its own what counts as a
// deload, which RPE a lift is aiming at, or which pain report belongs to it.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The block's RPE target when a lift carries none of its own. Mirrors PHASE_RPE
 * in prescription.ts (liftModel.check.ts fails if they drift); duplicated so the
 * edge copy of this file stands alone.
 */
export const BLOCK_TARGET_RPE: Record<string, number> = { Stability: 6, Strength: 8, Power: 7, Sport: 7 }
export const DEFAULT_TARGET_RPE = 8

export interface LiftModelSources {
  workouts: ModelWorkout[]
  /** session_observation rows; a Tweak/Pain chip reads "<exercise> — Pain". */
  observations?: Array<{ logged_at: string; signal: string; severity: number }>
  /** athlete.training_max_overrides, in the model's unit: numbers or TmOverride entries. */
  overrides?: Record<string, unknown> | null
  /** The live week, in training order. */
  sessions?: Array<{ name?: string; intent?: string | null; exercises: ExerciseTemplate[] }>
  phaseName?: string | null
  /** The latest weekly directive, when it applies to this week. Only RECOVERY moves loads. */
  directive?: string | null
  today?: string
  timeZone?: string
  unit?: ModelUnit
  convert?: (w: number) => number
  dayOf?: DayOf | null
  testDay?: boolean
  deload?: boolean
  noPush?: string | null
}

export function modelFromSources(lift: MainLiftId, src: LiftModelSources): LiftModel {
  const timeZone = src.timeZone ?? 'America/Los_Angeles'
  const today = src.today ?? localDay(new Date().toISOString(), timeZone)
  const { sets, checkins } = readModelLog(src.workouts, { timeZone, convert: src.convert })
  const pain: PainFlag[] = (src.observations ?? [])
    .filter((o) => o.severity >= 4)
    .map((o) => ({ date: localDay(o.logged_at, timeZone), exercise: o.signal.split('—')[0].trim(), severity: o.severity }))
  const rx = prescriptionFromProgram(lift, src.sessions ?? [])
  const flags = sessionFlags(rx?.session, rx?.sessionIntent, rx?.load, src.phaseName)
  const override = readTmOverride(src.overrides?.[lift])
  // The weekly review's DELOAD is chosen off an average RPE across every lift —
  // exactly the signal this model exists to stop reading — so only an explicit
  // deload (the program's words, the athlete's RECOVERY, or the caller) counts.
  const deload = src.deload ?? (flags.deload || src.directive === 'RECOVERY')
  return buildLiftModel({
    lift,
    sets,
    checkins,
    pain,
    today,
    unit: src.unit,
    tmOverride: override?.value ?? null,
    tmOverrideSet: override
      ? { on: override.set_at ? localDay(override.set_at, timeZone) : null, modelTm: override.model_tm ?? null }
      : null,
    prescription: rx,
    defaultTargetRpe: (src.phaseName && BLOCK_TARGET_RPE[src.phaseName]) || DEFAULT_TARGET_RPE,
    deload,
    testDay: src.testDay ?? flags.testDay,
    dayOf: src.dayOf ?? null,
    noPush: src.noPush ?? null,
  })
}

/**
 * The same push / hold / drop for a movement that isn't a main lift — an
 * accessory read off its own two most recent weeks, never the week's average.
 * Null when the log has nothing on it before this week.
 */
export function exerciseCall(
  sets: LiftSet[], exerciseName: string, today: string, target: number,
): { call: WeeklyCall; deltaPct: number; why: string } | null {
  const key = nameKey(exerciseName)
  const weekStart = mondayOf(today)
  const byWeek = new Map<string, LiftSet[]>()
  for (const s of dedupeSets(sets).sets) {
    if (nameKey(s.exercise) !== key || s.date >= weekStart) continue
    const wk = mondayOf(s.date)
    byWeek.set(wk, [...(byWeek.get(wk) ?? []), s])
  }
  const weeks: TopSetWeek[] = [...byWeek.entries()].map(([wk, list]) => {
    const top = list.reduce((a, b) => (b.weight > a.weight || (b.weight === a.weight && (b.rpe ?? -1) > (a.rpe ?? -1)) ? b : a))
    const lastSessionDate = list.reduce((d, s) => (s.date > d ? s.date : d), '')
    return { weekStart: wk, top, lastSessionDate, missedReps: list.filter((s) => s.date === lastSessionDate).reduce((n, s) => n + s.missedReps, 0) }
  }).sort((a, b) => b.weekStart.localeCompare(a.weekStart))
  const last = weeks[0]
  if (!last) return null
  const prior = weeks.find((w) => w.weekStart === addDays(last.weekStart, -7)) ?? null
  return weeklyCall({ upper: isUpperBody(exerciseName), target, last, prior, pain: null })
}

/** A hand-set TM write, previewed: what the change does to this week's number. */
/**
 * The entry a write stores: the value, now, and the computed TM it overrides
 * (rounded to a tenth), so a later read can tell how far the model has moved.
 * Null clears the override.
 */
export function tmOverrideEntry(lift: MainLiftId, value: number | null, src: LiftModelSources, now = new Date()): TmOverride | null {
  if (value == null) return null
  const rest = { ...(src.overrides ?? {}) }
  delete rest[lift]
  const computed = modelFromSources(lift, { ...src, overrides: rest }).trainingMax?.computed ?? null
  return { value, set_at: now.toISOString(), model_tm: computed != null ? Math.round(computed * 10) / 10 : null }
}

/** The sources with one lift's override set to `value` as of now (or cleared). */
export function withTrainingMax(lift: MainLiftId, value: number | null, src: LiftModelSources, now = new Date()): LiftModelSources {
  const overrides = { ...(src.overrides ?? {}) }
  const entry = tmOverrideEntry(lift, value, src, now)
  if (entry) overrides[lift] = entry
  else delete overrides[lift]
  return { ...src, overrides }
}

export function previewTrainingMax(lift: MainLiftId, value: number | null, src: LiftModelSources): string {
  const before = modelFromSources(lift, src)
  const after = modelFromSources(lift, withTrainingMax(lift, value, src))
  const tm = (m: LiftModel) => m.trainingMax
    ? `${fmtLoad(Math.round(m.trainingMax.value))}${m.unit}${m.trainingMax.source === 'override' ? ' (set by hand)' : ''}`
    : 'none'
  const rec = (m: LiftModel) => m.recommendation ? `${fmtLoad(m.recommendation.load)}${m.unit} — ${m.recommendation.reason}` : 'no recommendation'
  return [
    `# ${LIFT_LABEL[lift]} training max: ${tm(before)} → ${tm(after)}`,
    value == null && before.trainingMax?.computed != null
      ? `Back to the computed TM (${fmtLoad(Math.round(before.trainingMax.computed))}).`
      : null,
    `This week before: ${rec(before)}`,
    `This week after:  ${rec(after)}`,
  ].filter((l): l is string => l != null).join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// TEXT — the shape get_lift_model returns. One formatter, so the local and the
// remote MCP can never describe the same model two ways.
// ────────────────────────────────────────────────────────────────────────────

function fmtTrend(t: Trend | null): string {
  if (!t) return 'not enough points'
  const sign = t.perWeek > 0 ? '+' : t.perWeek < 0 ? '−' : '±'
  return `${sign}${fmtLoad(Math.abs(t.perWeek))}/wk (${sign}${fmtLoad(Math.abs(t.pctPerWeek))}%/wk, ${t.points} pts)`
}

export function renderLiftModel(m: LiftModel): string {
  const u = m.unit
  const lines: string[] = [`# ${m.label} — as of ${shortDay(m.asOf)}`]
  if (m.workingMax) {
    const wm = m.workingMax
    const span = wm.basis === 'carried' ? 'carried — not refreshed in the window' : `${wm.sessions} session${wm.sessions === 1 ? '' : 's'} in ${WINDOW_DAYS / 7} wk`
    lines.push(`Working max: ${fmtLoad(wm.rounded)}${u} (${fmtSet(wm.anchor)}, ${shortDay(wm.anchor.date)} · e1RM ${fmtLoad(Math.round(wm.anchor.e1rm))} · ${span})`)
  } else {
    lines.push('Working max: none in the last six weeks')
  }
  if (m.trainingMax) {
    const tm = m.trainingMax
    const setOn = tm.override?.setOn ? ` ${shortDay(tm.override.setOn)}` : ''
    lines.push(`Training max: ${fmtLoad(Math.round(tm.value))}${u}${tm.source === 'override'
      ? ` (set by hand${setOn}; computed would be ${tm.computed != null ? fmtLoad(Math.round(tm.computed)) : '—'})`
      : ` (${TM_FRACTION * 100}% of working max)`}`)
  }
  lines.push(`Trend: 4 wk ${fmtTrend(m.trend.w4)} · 8 wk ${fmtTrend(m.trend.w8)}`)
  if (m.allTimeBest) {
    const b = m.allTimeBest
    lines.push(`All-time best: heaviest ${fmtSet(b.heaviest)} (${shortDay(b.heaviest.date)}) · best e1RM ${fmtLoad(Math.round(b.e1rm))} from ${fmtSet(b.e1rmSet)} (${shortDay(b.e1rmSet.date)})${m.detrained ? ' · RETURNING' : ''}`)
  }
  if (m.missedWeeks) lines.push(`Weeks without it: ${m.missedWeeks}`)
  if (m.duplicatesRemoved) lines.push(`Duplicate logs collapsed: ${m.duplicatesRemoved} set${m.duplicatesRemoved === 1 ? '' : 's'} logged twice across sessions`)
  for (const n of m.notes) lines.push(`Note: ${n}`)

  const r = m.recommendation
  lines.push('', `## This week (from ${shortDay(r?.weekStart ?? m.asOf)})`)
  if (!r) {
    lines.push('No logged sets on this lift — nothing to recommend from.')
  } else if (r.skip) {
    lines.push(`Skip today. ${r.why.join(' · ')}`)
  } else {
    lines.push(`**${r.exercise ?? m.label}: ${r.sets}×${r.reps} @ ${fmtLoad(r.load)}${u}, RPE ${fmtLoad(r.targetRpe)}${r.rpeCap != null ? ` (cap ${fmtLoad(r.rpeCap)})` : ''}**`)
    lines.push(`Reason: ${r.reason}`)
    lines.push(`Call: ${r.call}`)
    for (const w of r.why) lines.push(`- ${w}`)
    lines.push(`Back-offs: ${fmtLoad(r.backoff.onTarget)} if the top set lands on target · ${fmtLoad(r.backoff.ifHeavy)} if it's ≥ @${fmtLoad(r.targetRpe + 1)} · ${fmtLoad(r.backoff.ifLight)} if it's ≤ @${fmtLoad(r.targetRpe - 1)}`)
    for (const c of r.conditional) lines.push(`- ${c}`)
  }

  if (m.lastQualifying.length) {
    lines.push('', '## Last qualifying sets')
    for (const s of m.lastQualifying) lines.push(`- ${shortDay(s.date)}: ${s.exercise} ${fmtSet(s)} → e1RM ${fmtLoad(Math.round(s.e1rm))}`)
  }
  if (m.series.length) {
    lines.push('', '## Working max by session (last 8)')
    for (const p of m.series.slice(-8)) lines.push(`- ${shortDay(p.date)}: ${fmtLoad(Math.round(p.value))} (${p.anchor})`)
  }
  return lines.join('\n')
}
