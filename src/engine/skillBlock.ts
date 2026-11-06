// =============================================================================
// SKILL BLOCKS — the third exercise kind (spec §12, skill_blocks_v1). A station
// whose target is quality — N makes, N/side, N possessions, technique — not
// seconds. Time can be suggested; it is never the boss: no clock advances the
// athlete, who taps Done / Next when the station is actually done.
//
// Intervals stay strictly for conditioning. With the flag on, the interval
// timer runs only on an exercise that isn't a skill block, so work/rest syntax
// ("6 × 10s / 50s") on a skill or technique block, or makes / possessions /
// per-side language, never launches it. An exercise tagged `kind: 'interval'`
// is always an interval, whatever its name says.
//
// With the flag off nothing here is consulted, and every exercise reads
// exactly as before (intervals.ts takes `skill = false` by default).
//
// Pure, no I/O (see skillBlock.check.ts).
// =============================================================================

import type { ExerciseTemplate } from '../types/database.ts'

export type SkillFields = Pick<ExerciseTemplate, 'name' | 'reps' | 'sets'> & Partial<Pick<ExerciseTemplate, 'kind' | 'window_s' | 'rest_s' | 'cue'>>

// The target is a count of quality, not a clock: "6 makes", "8 possessions".
const QUALITY_TARGET = /\b(makes?|made|possessions?)\b/

// Per-side language ("4/side", "5 per side", "3 each hand"). On its own this is
// just how unilateral work is counted — Cossack Squat 5/side, Lateral Bounce
// 8 each leg are reps to log, not stations. It only reads as a skill target
// when it sits on work/rest clock syntax ("4/side 10s on / 20s off"), where the
// question is skill-vs-interval and the per-side count says the count is boss.
const PER_SIDE = /\/\s*(side|leg|arm|hand)\b|\b(per|each|a)\s+(side|leg|arm|hand)\b/
// Work/rest syntax only — "10s on / 20s off", "10s / 50s" — not a hold
// time like "30s/side".
const CLOCK = /\b(on|off)\b|\d\s*(s|sec|secs|seconds?|min|mins|minutes?)\s*\/\s*\d/

// A name that says skill or technique work. Narrow on purpose: a station a
// coach would run for quality, never a conditioning piece.
const SKILL_NAME =
  /\b(skills?|technique|finishing|shooting|free throws?|layups?|footwork|ball handling|dribbling)\b/

// Named outright as conditioning protocol: the clock is the point.
const EXPLICIT_INTERVAL = /\b(hiit|tabata|e\d?mom|intervals?)\b/

/**
 * Whether this exercise is a skill block. Precedence: the coach's tag
 * (`kind`), then the protocol named outright (Tabata, EMOM, HIIT,
 * intervals), then a quality target, then a skill / technique name.
 */
export function isSkillBlock(ex: SkillFields | null | undefined): boolean {
  if (!ex) return false
  if (ex.kind === 'skill') return true
  if (ex.kind === 'interval') return false
  const name = (ex.name ?? '').toLowerCase()
  const reps = String(ex.reps ?? '').toLowerCase()
  if (EXPLICIT_INTERVAL.test(name) || EXPLICIT_INTERVAL.test(reps)) return false
  if (QUALITY_TARGET.test(reps) || QUALITY_TARGET.test(name)) return true
  if ((PER_SIDE.test(reps) || PER_SIDE.test(name)) && CLOCK.test(reps)) return true
  return SKILL_NAME.test(name)
}

/** "~8 min", "~45s", "~1:30" — advisory time, as copy. */
export function fmtApprox(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return `~${s}s`
  if (s % 60 === 0) return `~${s / 60} min`
  return `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "0:42", "12:05" — the count-up clock face. */
export function fmtElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface SkillView {
  /** The quality target as the coach wrote it: "6 makes", "3 × 4/side". */
  target: string
  /** Suggested window, display only. Null when none was written. */
  window: string | null
  /** Suggested rest, display only. Null when none was written. */
  rest: string | null
  /** The quality notes stay on the cue ("skip if the knee talks, miss = one extra"). */
  cue: string | null
}

const positive = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null

/** What the station shows. Nothing in it is ever enforced. */
export function skillView(ex: SkillFields): SkillView {
  const reps = String(ex.reps ?? '').trim()
  const sets = Math.round(Number(ex.sets) || 1)
  const target = reps ? (sets > 1 ? `${sets} × ${reps}` : reps) : `${sets} × station`
  const w = positive(ex.window_s)
  const r = positive(ex.rest_s)
  const cue = String(ex.cue ?? '').trim()
  return {
    target,
    window: w != null ? fmtApprox(w) : null,
    rest: r != null ? fmtApprox(r) : null,
    cue: cue || null,
  }
}

/** One line for a list: "6 makes · ~8 min". */
export function fmtSkillDose(ex: SkillFields): string {
  const v = skillView(ex)
  return v.window ? `${v.target} · ${v.window}` : v.target
}

/**
 * The station's set grid once the athlete taps Done: every row marked done,
 * nothing else claimed. Makes vs attempts is a later bet (§12); the v1 log is
 * complete + session RPE, and session RPE is taken where it always is.
 */
export function skillDoneLogs<T extends { done: boolean }>(rows: readonly T[], sets: number, blank: (set: number) => T): T[] {
  const n = Math.max(rows.length, Math.round(Number(sets) || 1), 1)
  return Array.from({ length: n }, (_, i) => ({ ...(rows[i] ?? blank(i + 1)), done: true }))
}

/** Whether a station is already marked done. */
export function skillDone(rows: readonly { done: boolean }[] | null | undefined): boolean {
  return !!rows && rows.length > 0 && rows.every((r) => r.done)
}

// ---- the clocks the athlete owns ---------------------------------------------
// Both are pure reads of a start time the athlete set with a tap. Neither has
// an end that does anything: a rest past its suggestion just says so.

export interface Stopwatch {
  /** Epoch ms the current run started, or null when paused / not started. */
  runningSince: number | null
  /** Seconds banked from earlier runs. */
  banked: number
}

export const STOPWATCH_IDLE: Stopwatch = { runningSince: null, banked: 0 }

export function stopwatchSeconds(w: Stopwatch, now: number): number {
  return w.banked + (w.runningSince != null ? Math.max(0, now - w.runningSince) / 1000 : 0)
}

export function toggleStopwatch(w: Stopwatch, now: number): Stopwatch {
  return w.runningSince != null
    ? { runningSince: null, banked: stopwatchSeconds(w, now) }
    : { runningSince: now, banked: w.banked }
}

export interface RestRead {
  /** Seconds since the athlete started the rest. */
  elapsed: number
  /** Past the suggestion: shown as copy, never acted on. */
  pastSuggestion: boolean
}

export function readRest(startedAt: number, suggestedSecs: number | null | undefined, now: number): RestRead {
  const elapsed = Math.max(0, (now - startedAt) / 1000)
  const s = positive(suggestedSecs)
  return { elapsed, pastSuggestion: s != null && elapsed >= s }
}
