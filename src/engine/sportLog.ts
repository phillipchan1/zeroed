// =============================================================================
// SPORT / CONDITIONING LOG (log_session_v1, spec section 13) — a game of
// basketball, a run, a class, logged as what it was, when, how long, how hard
// the whole thing was (session RPE, 1–10), any pain by region, and a note.
//
// One log is one workout of kind 'sport_conditioning'; two games on one day
// are two rows. Logged from a planned conditioning / sport card, the first log
// that day closes that card; anything else (rest day, a second game, a
// primer-only day with no matching card) goes on the athlete's external
// program and never fills a planned slot. The Worker decides which
// (worker/src/sportSessions.ts); the app only says which card it came from.
//
// The rules here are the app's AND the Worker's: both validate with
// parseSportLog, so a log the sheet lets through is one the server takes.
//
// Pure, no I/O, no client imports: the Worker reads it too (see
// sportLog.check.ts). The outbox row is built in sportLogPending.ts.
// =============================================================================

import type { ExerciseTemplate, SetLog } from '../types/database.ts'

export const SPORT_KIND = 'sport_conditioning'

/** The starter chips. "Other" opens a free-text field; the activity is always free text. */
export const SPORT_STARTERS = ['Basketball', 'Run', 'Ride', 'Class', 'Match', 'Other'] as const

export const SPORT_MINUTE_CHOICES = [25, 30, 45, 60, 90] as const

/** How far back a log may be dated: today and the 6 days before (7 inclusive days). */
export const BACKDATE_DAYS = 7

export const MAX_SPORT_MINUTES = 600
const MAX_ACTIVITY = 40
const MAX_NOTES = 2000

/** The check-in's regions (worker/src/methodology/v1.ts PAIN_REGIONS; a check keeps them equal). */
export const SPORT_PAIN_REGIONS = [
  'neck', 'shoulder', 'elbow', 'wrist', 'upper_back', 'low_back', 'hip', 'groin',
  'hamstring', 'knee', 'shin', 'ankle', 'achilles', 'foot',
] as const

/** The check-in's red flags (worker/src/readiness/rules.ts RED_FLAGS; a check keeps them equal). */
export const SPORT_RED_FLAGS = [
  'swelling', 'locking', 'giving_way', 'numbness_tingling', 'radiating',
  'chest_pain', 'fainting', 'breathlessness', 'acute_injury', 'worsening',
] as const

export interface SportPain {
  region: string
  score: number
  red_flags: string[]
}

export interface SportLogFields {
  activity: string
  /** The athlete's calendar date, YYYY-MM-DD. */
  date: string
  duration_min: number
  /** 1–10. Null only when a coach without health access logs it. */
  session_rpe: number | null
  pain: SportPain[]
  notes: string | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The dates a log may carry, newest first: today and the 6 days before. */
export function loggableDates(today: string): string[] {
  return Array.from({ length: BACKDATE_DAYS }, (_, i) => addDaysIso(today, -i))
}

/** Why this date can't carry a log, or null. */
export function dateProblem(date: unknown, today: string): string | null {
  if (typeof date !== 'string' || !DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    return 'date must be YYYY-MM-DD.'
  }
  if (date > today) return 'a session can\'t be logged for a future day.'
  if (date < addDaysIso(today, -(BACKDATE_DAYS - 1))) return `a session can only be logged for today or the ${BACKDATE_DAYS - 1} days before.`
  return null
}

/** What the athlete typed, tidied: one line, capped, first letter up. Null when there's nothing. */
export function cleanSportActivity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY).trim()
  if (!s) return null
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function wholeIn(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : null
}

/** Whole minutes, 1–600, or null. Same bounds as session_rpe.duration_min. */
export function cleanSportMinutes(v: unknown): number | null {
  return wholeIn(v, 1, MAX_SPORT_MINUTES)
}

/** Session RPE for a session that happened: a whole number 1–10, or null. */
export function cleanSportRpe(v: unknown): number | null {
  return wholeIn(v, 1, 10)
}

export function cleanNotes(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, MAX_NOTES)
  return s || null
}

const isRegion = (r: unknown): r is string => typeof r === 'string' && (SPORT_PAIN_REGIONS as readonly string[]).includes(r)
const isFlag = (f: unknown): f is string => typeof f === 'string' && (SPORT_RED_FLAGS as readonly string[]).includes(f)

/** Pain entries, checked like the check-in's: a known region once each, a whole score 0–10, known red flags. */
export function parseSportPain(raw: unknown): SportPain[] | string {
  if (raw == null) return []
  if (!Array.isArray(raw)) return 'pain must be a list of { region, score, red_flags? }.'
  const out: SportPain[] = []
  for (const item of raw) {
    const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (!isRegion(p.region)) return `unknown pain region. Regions: ${SPORT_PAIN_REGIONS.join(', ')}.`
    const score = wholeIn(p.score, 0, 10)
    if (score == null) return 'pain scores are whole numbers 0–10.'
    const flags = p.red_flags == null ? [] : p.red_flags
    if (!Array.isArray(flags) || !flags.every(isFlag)) return `unknown red flag. Red flags: ${SPORT_RED_FLAGS.join(', ')}.`
    if (out.some((x) => x.region === p.region)) return `${p.region} is listed twice.`
    out.push({ region: p.region, score, red_flags: [...new Set(flags)] })
  }
  return out
}

export type ParsedSportLog = { ok: true; value: Partial<SportLogFields> } | { ok: false; error: string }

/**
 * A new log (partial false: activity, date, duration and — with requireRpe —
 * session RPE are required) or an edit (partial true: only the fields given
 * are checked and returned). `today` is the athlete's calendar date.
 */
export function parseSportLog(raw: Record<string, unknown>, today: string, opts: { partial?: boolean; requireRpe?: boolean } = {}): ParsedSportLog {
  const partial = opts.partial === true
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined
  const value: Partial<SportLogFields> = {}
  if (!partial || has('activity')) {
    const a = cleanSportActivity(raw.activity)
    if (!a) return { ok: false, error: 'activity is required (what it was: Basketball, Run, Ride, Class, Match, or anything else).' }
    value.activity = a
  }
  if (!partial || has('date')) {
    if (raw.date == null || raw.date === '') return { ok: false, error: 'date is required (YYYY-MM-DD).' }
    const why = dateProblem(raw.date, today)
    if (why) return { ok: false, error: why }
    value.date = raw.date as string
  }
  if (!partial || has('duration_min')) {
    if (raw.duration_min == null || raw.duration_min === '') return { ok: false, error: 'duration_min is required: whole minutes, 1–600.' }
    const m = cleanSportMinutes(raw.duration_min)
    if (m == null) return { ok: false, error: 'duration_min must be whole minutes, 1–600.' }
    value.duration_min = m
  }
  if (has('session_rpe') && raw.session_rpe !== null) {
    const r = cleanSportRpe(raw.session_rpe)
    if (r == null) return { ok: false, error: 'session_rpe must be a whole number 1–10.' }
    value.session_rpe = r
  } else if (!partial) {
    if (opts.requireRpe !== false) return { ok: false, error: 'session_rpe is required: how hard the whole session was, 1–10.' }
    value.session_rpe = null
  }
  if (!partial || has('pain')) {
    const pain = parseSportPain(raw.pain)
    if (typeof pain === 'string') return { ok: false, error: pain }
    value.pain = pain
  }
  if (!partial || has('notes')) value.notes = cleanNotes(raw.notes)
  return { ok: true, value }
}

/** Session load (AU) = session RPE × minutes; null without a rating. */
export function sessionLoadAu(sessionRpe: number | null | undefined, minutes: number | null | undefined): number | null {
  return sessionRpe == null || minutes == null ? null : sessionRpe * minutes
}

/** One line of what was logged, e.g. "Basketball · 25 min · effort 6". */
export function sportSummary(f: Pick<SportLogFields, 'activity' | 'duration_min' | 'session_rpe'>): string {
  return [f.activity, `${f.duration_min} min`, f.session_rpe != null ? `effort ${f.session_rpe}` : null].filter(Boolean).join(' · ')
}

// ---- where the app offers it ------------------------------------------------

const SPORT_CARD_NAME = /\b(basketball|hoops|conditioning|sport|game|match|practice|pickup|soccer|football|tennis|volleyball|run|ride|bike|swim|class)\b/i

/** A planned card the athlete can "Log this session" against: a conditioning or sport day (primer-only ones included). */
export function isSportCard(r: { name?: string | null; session_type?: string | null }): boolean {
  return r.session_type === 'conditioning' || r.session_type === 'sport' || SPORT_CARD_NAME.test(r.name ?? '')
}

/** Today's "Add session": always on the current week with the flag on, whatever the week holds. */
export function addSessionVisible(s: { flagOn: boolean; weekOffset: number }): boolean {
  return s.flagOn && s.weekOffset === 0
}

/** "Log this session" on a planned card's sheet. */
export function logThisSessionVisible(s: { flagOn: boolean; weekOffset: number; routine: { name?: string | null; session_type?: string | null } }): boolean {
  return s.flagOn && s.weekOffset === 0 && isSportCard(s.routine)
}

/** arc_load_v1's "Log outside the plan" row, exactly as before this change: unaffected by log_session_v1. */
export function outsidePlanEntryVisible(s: { arcLoad: boolean; weekOffset: number; liveCount: number }): boolean {
  return s.arcLoad && s.weekOffset === 0 && s.liveCount > 0
}

// ---- the queued row ----------------------------------------------------------

/** What travels in the outbox with a sport log: everything the Worker needs, health fields included. */
export interface SportLogPending {
  activity: string
  date: string
  minutes: number
  sessionRpe: number
  pain: SportPain[]
  notes: string | null
  /** The planned card it was logged from, if any. The Worker decides whether it closes it. */
  plannedRoutineId: string | null
}

/** The one time-tracked row a sport log is, so readers that know timed sets (History, MCP) show it. */
export function sportSnapshot(activity: string, minutes: number): { exercises: ExerciseTemplate[]; weights: Record<string, SetLog[]>; reps: Record<string, number[]> } {
  return {
    exercises: [{ name: activity, sets: 1, reps: `${minutes} min`, tracking_type: 'time' }],
    weights: { 0: [{ set: 1, weight: null, reps: null, rpe: null, done: true, duration: minutes * 60, distance: null }] },
    reps: { 0: [0] },
  }
}

/** The day at local noon, so a backdated log never slips across a zone boundary; today is now. */
export function performedAtForDate(date: string, today: string, now: Date = new Date()): string {
  if (date === today) return now.toISOString()
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString()
}
