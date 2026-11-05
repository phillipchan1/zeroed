// =============================================================================
// programDraft — the deterministic half of the program editor.
//
// Pure, no I/O: bounds, the in-memory application of proposed edits, the diff
// the athlete confirms, and the time estimate that answers "I finished in 25
// minutes and had gas left". Kept separate from programEdit.ts (which talks to
// Supabase and the agent) so this layer can be exercised on its own — see
// programDraft.check.ts.
//
// The rule this file enforces: a model PROPOSES edits, code DISPOSES them. What
// lands on screen is the result of applying them here, never a description the
// model wrote of what it meant to do.
// =============================================================================

// Explicit .ts extensions on the runtime imports: this module is exercised by
// `node --experimental-strip-types programDraft.check.ts`, and node resolves
// specifiers literally. Vite is happy either way.
import { resolveTrackingType } from './exerciseLibrary.ts'
import { intervalPlanFor, blockSeconds, canonicalBlock } from './intervals.ts'
import {
  diffSession, tallyChanges, normalizeExerciseName, MAIN_LIFT,
  type SessionDiff,
} from './weekDiff.ts'
import type { ProgramEdit } from './types.ts'
import type { ExerciseKind, ExerciseTemplate } from './types.ts'

// ---- the working draft ------------------------------------------------------

/** One session in the draft. `routineId` is null for a session not yet written. */
export interface DraftSession {
  routineId: string | null
  name: string
  intent: string
  sessionType: string
  intendedDow: number | null
  exercises: ExerciseTemplate[]
}

/** The whole editable week, plus the schedule fact that decides what shows up. */
export interface ProgramDraft {
  sessions: DraftSession[]
  sessionsPerWeek: number
}

// ---- deterministic bounds ---------------------------------------------------
//
// Deliberately looser than the phase designer's. That surface builds a week for
// an athlete who has not asked for anything; this one only ever does what the
// athlete just asked for, so the ceiling is "a real training session someone
// chose", not "what a cautious template would prescribe".

export const MAX_EXERCISES_PER_SESSION = 12
export const MAX_SESSIONS = 7
export const MAX_SETS = 10
const LOADS = ['bodyweight', 'light', 'moderate', 'heavy']
const SESSION_TYPES = ['strength', 'power', 'conditioning', 'mobility']

// A session this long is not refused — it is flagged, with its own estimate, so
// the athlete decides whether they have the time.
const LONG_SESSION_MINS = 75

export function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return fallback
  return Math.max(lo, Math.min(hi, v))
}

function cleanText(s: unknown, max: number): string {
  return String(s ?? '').trim().slice(0, max)
}

/** A written load: "~170 lb", "RPE 5 · ~170 lb", "70%". Word buckets stay separate. */
function isExplicitLoad(s: string): boolean {
  return /\d/.test(s)
}

function cleanLoad(s: unknown): string | undefined {
  const raw = String(s ?? '').trim()
  if (!raw) return undefined
  const word = raw.toLowerCase()
  if (LOADS.includes(word)) return word
  const explicit = cleanText(raw, 40)
  return explicit && isExplicitLoad(explicit) ? explicit : undefined
}

function cleanSessionType(s: unknown): string | null {
  const v = String(s ?? '').trim().toLowerCase()
  return SESSION_TYPES.includes(v) ? v : null
}

// ---- session time estimate --------------------------------------------------
//
// "I finished in 25 minutes and had gas left" is the complaint this answers, so
// the editor has to be able to show what an addition costs in minutes. Rough by
// construction — work time from the rep spec, rest scaled by load — and labelled
// as an estimate everywhere it is shown.

const REST_SECS: Record<string, number> = {
  heavy: 150, moderate: 100, light: 65, bodyweight: 50,
}

// "30s", "8 × 20s on / 40s off", "45 sec" → seconds of work in one set.
function workSecondsFromReps(reps: string): number {
  const timed = reps.match(/(\d+)\s*(s|sec|secs|second|seconds)\b/i)
  if (timed) return clampInt(timed[1], 5, 600, 30)
  const repCount = reps.match(/(\d+)/)
  // ~4s per rep is a working tempo across the loads this app programs.
  return repCount ? clampInt(Number(repCount[1]) * 4, 8, 240, 30) : 30
}

/** Rough minutes for one session, warm-up included. Never presented as exact. */
export function estimateSessionMinutes(exercises: ExerciseTemplate[]): number {
  if (!exercises.length) return 0
  let secs = 8 * 60   // warm-up + setup, the part that doesn't scale with volume
  for (const ex of exercises) {
    // An interval block is exactly as long as its clock — "8 × 20s on / 40s
    // off" is eight minutes, not one set of twenty seconds.
    const block = intervalPlanFor(ex)
    if (block) { secs += blockSeconds(block) + 60; continue }
    const sets = clampInt(ex.sets, 1, MAX_SETS, 3)
    const work = workSecondsFromReps(String(ex.reps ?? ''))
    const rest = REST_SECS[String(ex.load ?? 'light').toLowerCase()] ?? 65
    // The last set of a movement runs into the next one's setup, not a full rest.
    secs += sets * work + (sets - 1) * rest + 45
  }
  return Math.round(secs / 60)
}

/** Every session's estimate, for the board and for the model's context. */
export function estimateDraft(draft: ProgramDraft): Array<{ session: string; minutes: number }> {
  return draft.sessions.map((s) => ({ session: s.name, minutes: estimateSessionMinutes(s.exercises) }))
}

// ---- applying edits to the draft (deterministic) ---------------------------

/** What actually happened to one proposed edit — shown next to the reply. */
export interface EditOutcome {
  edit: ProgramEdit
  applied: boolean
  label: string
  reason?: string   // why it was skipped
}

function findSession(draft: ProgramDraft, name: string | null): number {
  if (!name) return -1
  const want = name.trim().toLowerCase()
  let idx = draft.sessions.findIndex((s) => s.name.trim().toLowerCase() === want)
  if (idx >= 0) return idx
  idx = draft.sessions.findIndex((s) => {
    const other = s.name.trim().toLowerCase()
    return other.includes(want) || want.includes(other)
  })
  return idx
}

function findExercise(exs: ExerciseTemplate[], name: string | null): number {
  if (!name) return -1
  const want = normalizeExerciseName(name)
  let idx = exs.findIndex((e) => normalizeExerciseName(e.name) === want)
  if (idx >= 0) return idx
  idx = exs.findIndex((e) => {
    const other = normalizeExerciseName(e.name)
    return other.includes(want) || want.includes(other)
  })
  return idx
}

/** Build a template from an edit's fields, with the metric resolved by code. */
function buildExercise(
  rawName: string,
  sets: unknown, reps: unknown, load: unknown, cue: unknown, targetRpe: unknown,
): ExerciseTemplate {
  const cleanSets = clampInt(sets, 1, MAX_SETS, 3)
  // An interval block proposed with its dose in the name ("Bike finisher
  // 8x(15s hard / 45s easy)", reps "8 rounds") lands in the canonical shape:
  // the dose in reps, where the app's interval timer reads it.
  const block = canonicalBlock({ name: rawName, reps: cleanText(reps, 40), sets: cleanSets })
  const name = block?.name ?? rawName
  const cleanReps = block?.reps ?? (cleanText(reps, 40) || '8')
  // A block's "load" is the effort of the rounds, not a weight to find.
  const cleanedLoad = block ? 'bodyweight' : cleanLoad(load)
  const ex: ExerciseTemplate = {
    name,
    sets: cleanSets,
    reps: cleanReps,
    tracking_type: resolveTrackingType(name, cleanReps, cleanedLoad),
  }
  if (cleanedLoad) ex.load = cleanedLoad
  const cueText = cleanText(cue, 160)
  if (cueText) ex.cue = cueText
  const rpe = Number(targetRpe)
  if (Number.isFinite(rpe)) {
    ex.target_rpe = Math.max(1, Math.min(10, Math.round(rpe * 10) / 10))
    ex.rpe_source = 'coach'
  }
  return ex
}

function applyTrackFields(
  ex: ExerciseTemplate,
  e: {
    track_id?: string | null
    track?: string | null
    superset_group?: string | null
    rest_s?: number | null
    contacts?: number | null
    kind?: ExerciseKind | null
    window_s?: number | null
  },
): boolean {
  let touched = false
  const tid = String(e.track_id ?? e.track ?? '').trim()
  if (tid) { ex.track_id = tid; touched = true }
  const sg = String(e.superset_group ?? '').trim().toUpperCase()
  if (/^[A-Z]\d+$/.test(sg)) { ex.superset_group = sg; touched = true }
  if (e.rest_s != null && Number.isFinite(Number(e.rest_s))) {
    ex.rest_s = Math.max(0, Math.round(Number(e.rest_s)))
    touched = true
  }
  if (e.contacts != null && Number.isFinite(Number(e.contacts))) {
    ex.contacts = Math.max(0, Math.round(Number(e.contacts)))
    touched = true
  }
  // skill_blocks_v1: only ever present when the flag let them through (the
  // Worker strips them otherwise), so an edit without them reads as before.
  if (e.kind === 'skill' || e.kind === 'interval') {
    ex.kind = e.kind
    touched = true
  }
  if (e.window_s != null && Number.isFinite(Number(e.window_s))) {
    ex.window_s = Math.max(0, Math.min(7200, Math.round(Number(e.window_s))))
    touched = true
  }
  return touched
}

/** A human one-liner for an edit — the pending list and the coach note use it. */
export function summarizeEdit(e: ProgramEdit): string {
  switch (e.type) {
    case 'add_exercise':
      return `Add ${e.exercise_name ?? 'an exercise'} to ${e.session_name ?? 'a session'}`
    case 'update_exercise': {
      const bits: string[] = []
      if (e.sets != null) bits.push(`${e.sets} sets`)
      if (e.reps) bits.push(e.reps)
      if (e.load) bits.push(e.load)
      if (e.target_rpe != null) bits.push(`RPE ${e.target_rpe}`)
      if (e.cue) bits.push('new cue')
      if (e.track || e.track_id) bits.push('track')
      if (e.superset_group) bits.push(e.superset_group)
      if (e.rest_s != null) bits.push(`${e.rest_s}s rest`)
      if (e.contacts != null) bits.push(`${e.contacts} contacts`)
      if (e.kind) bits.push(e.kind === 'skill' ? 'skill block' : 'interval')
      if (e.window_s != null) bits.push(`~${e.window_s}s window`)
      return `Retune ${e.exercise_name ?? 'a lift'} in ${e.session_name ?? 'a session'}${bits.length ? ` → ${bits.join(' · ')}` : ''}`
    }
    case 'remove_exercise':
      return `Drop ${e.exercise_name ?? 'an exercise'} from ${e.session_name ?? 'a session'}`
    case 'add_session':
      return `Add session "${e.session_name ?? 'New session'}" (${e.exercises?.length ?? 0} exercises)`
    case 'update_session': {
      const bits: string[] = []
      if (e.set_name) bits.push(`rename → ${e.set_name}`)
      if (e.set_intent) bits.push('new intent')
      if (e.set_session_type) bits.push(e.set_session_type)
      if (e.set_intended_dow != null) bits.push(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][e.set_intended_dow] ?? '')
      return `Update ${e.session_name ?? 'a session'}${bits.length ? ` — ${bits.filter(Boolean).join(', ')}` : ''}`
    }
    case 'set_sessions_per_week':
      return `Train ${e.sessions_per_week ?? '?'} days a week`
    case 'add_note':
      return `Coach note — "${cleanText(e.note, 80)}"`
    default:
      return 'Change'
  }
}

/**
 * Apply a batch of proposed edits to the draft IN MEMORY. Pure: returns a new
 * draft and a per-edit outcome, writes nothing. This is what makes the diff on
 * screen exact rather than a re-description of what a model intended — the
 * athlete confirms the same object the DB will receive.
 *
 * A session is never deleted here (the routine table has no delete policy, and
 * an athlete's logged workouts point at it); removing work means removing
 * exercises, which the model is told to do only on request.
 */
export function applyEditsToDraft(
  draft: ProgramDraft,
  edits: ProgramEdit[],
): { draft: ProgramDraft; outcomes: EditOutcome[]; notes: string[] } {
  const next: ProgramDraft = {
    sessionsPerWeek: draft.sessionsPerWeek,
    sessions: draft.sessions.map((s) => ({ ...s, exercises: s.exercises.map((e) => ({ ...e })) })),
  }
  const outcomes: EditOutcome[] = []
  const notes: string[] = []

  for (const e of edits ?? []) {
    const label = summarizeEdit(e)
    const skip = (reason: string) => outcomes.push({ edit: e, applied: false, label, reason })

    switch (e.type) {
      case 'add_exercise': {
        const si = findSession(next, e.session_name)
        if (si < 0) { skip(`no session called "${e.session_name ?? '—'}"`); break }
        const name = cleanText(e.exercise_name, 80)
        if (!name) { skip('no exercise name'); break }
        const session = next.sessions[si]
        if (session.exercises.length >= MAX_EXERCISES_PER_SESSION) {
          skip(`${session.name} is already at ${MAX_EXERCISES_PER_SESSION} exercises`); break
        }
        const ex = buildExercise(name, e.sets, e.reps, e.load, e.cue, e.target_rpe)
        applyTrackFields(ex, e)
        const anchor = findExercise(session.exercises, e.after_exercise)
        if (anchor >= 0) session.exercises.splice(anchor + 1, 0, ex)
        else session.exercises.push(ex)
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      case 'update_exercise': {
        const si = findSession(next, e.session_name)
        if (si < 0) { skip(`no session called "${e.session_name ?? '—'}"`); break }
        const session = next.sessions[si]
        const ei = findExercise(session.exercises, e.exercise_name)
        if (ei < 0) { skip(`${e.exercise_name ?? 'that exercise'} isn't in ${session.name}`); break }
        const ex = { ...session.exercises[ei] }
        let touched = false
        if (e.sets != null) { ex.sets = clampInt(e.sets, 1, MAX_SETS, ex.sets); touched = true }
        if (e.reps) { ex.reps = cleanText(e.reps, 40) || ex.reps; touched = true }
        const load = cleanLoad(e.load)
        if (load && load.toLowerCase() !== String(ex.load ?? '').trim().toLowerCase()) {
          ex.load = load
          touched = true
        }
        if (e.cue) { ex.cue = cleanText(e.cue, 160); touched = true }
        if (e.target_rpe != null && Number.isFinite(Number(e.target_rpe))) {
          ex.target_rpe = Math.max(1, Math.min(10, Math.round(Number(e.target_rpe) * 10) / 10))
          ex.rpe_source = 'coach'
          touched = true
        }
        if (applyTrackFields(ex, e)) touched = true
        if (!touched) { skip('nothing to change'); break }
        // The metric can move with the prescription ("8" → "30s").
        ex.tracking_type = resolveTrackingType(ex.name, ex.reps, ex.load)
        session.exercises[ei] = ex
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      case 'remove_exercise': {
        const si = findSession(next, e.session_name)
        if (si < 0) { skip(`no session called "${e.session_name ?? '—'}"`); break }
        const session = next.sessions[si]
        const ei = findExercise(session.exercises, e.exercise_name)
        if (ei < 0) { skip(`${e.exercise_name ?? 'that exercise'} isn't in ${session.name}`); break }
        if (session.exercises.length <= 1) { skip(`${session.name} would be left empty`); break }
        session.exercises.splice(ei, 1)
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      case 'add_session': {
        if (next.sessions.length >= MAX_SESSIONS) { skip(`already ${MAX_SESSIONS} sessions in the week`); break }
        const name = cleanText(e.session_name, 60)
        if (!name) { skip('no session name'); break }
        if (findSession(next, name) >= 0) { skip(`"${name}" already exists`); break }
        const exercises = (e.exercises ?? [])
          .slice(0, MAX_EXERCISES_PER_SESSION)
          .map((x) => {
            const built = buildExercise(cleanText(x.name, 80), x.sets, x.reps, x.load, x.cue, x.target_rpe)
            applyTrackFields(built, x)
            return built
          })
          .filter((x) => x.name)
        if (!exercises.length) { skip('no exercises in the new session'); break }
        next.sessions.push({
          routineId: null,
          name,
          intent: cleanText(e.set_intent, 200),
          sessionType: cleanSessionType(e.set_session_type) ?? 'strength',
          intendedDow: e.set_intended_dow != null ? clampInt(e.set_intended_dow, 0, 6, 0) : null,
          exercises,
        })
        // A session the schedule never reaches may as well not exist: the week
        // plans `sessionsPerWeek` sessions, so adding one raises the count
        // unless the athlete is already training more days than they have
        // sessions. Stated in the diff, never silent.
        if (next.sessionsPerWeek < next.sessions.length) {
          next.sessionsPerWeek = Math.min(MAX_SESSIONS, next.sessions.length)
        }
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      case 'update_session': {
        const si = findSession(next, e.session_name)
        if (si < 0) { skip(`no session called "${e.session_name ?? '—'}"`); break }
        const session = next.sessions[si]
        let touched = false
        const newName = cleanText(e.set_name, 60)
        if (newName) { session.name = newName; touched = true }
        if (e.set_intent) { session.intent = cleanText(e.set_intent, 200); touched = true }
        const type = cleanSessionType(e.set_session_type)
        if (type) { session.sessionType = type; touched = true }
        if (e.set_intended_dow != null) { session.intendedDow = clampInt(e.set_intended_dow, 0, 6, 0); touched = true }
        if (!touched) { skip('nothing to change'); break }
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      case 'set_sessions_per_week': {
        const v = clampInt(e.sessions_per_week, 1, MAX_SESSIONS, next.sessionsPerWeek)
        if (v === next.sessionsPerWeek) { skip(`already ${v} days a week`); break }
        next.sessionsPerWeek = v
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      case 'add_note': {
        const note = cleanText(e.note, 400)
        if (!note) { skip('empty note'); break }
        notes.push(note)
        outcomes.push({ edit: e, applied: true, label })
        break
      }

      default:
        skip('unrecognised change')
    }
  }

  return { draft: next, outcomes, notes }
}

// ---- diffing the draft against what's live ---------------------------------

export interface DraftDiff {
  sessions: SessionDiff[]
  added: number
  removed: number
  changed: number
  newSessions: number
  /** Main lifts programmed today that the draft no longer contains anywhere. */
  mainLiftsDropped: string[]
  sessionsPerWeekBefore: number
  sessionsPerWeekAfter: number
  /** Sessions whose estimate crosses the long-session line, with the estimate. */
  longSessions: Array<{ name: string; minutes: number }>
  minutesBefore: number
  minutesAfter: number
  dirty: boolean
}

/**
 * The whole delta between the live program and the draft — per session, per
 * movement, plus the two facts an athlete actually weighs: is a main lift about
 * to disappear, and what does this cost me in minutes.
 */
export function diffDraft(base: ProgramDraft, draft: ProgramDraft): DraftDiff {
  const usedBase = new Set<number>()
  const sessions: SessionDiff[] = draft.sessions.map((s) => {
    // Pair by routine id where we have one (a rename must not read as a new
    // session), then by name, then by position.
    let bi = s.routineId ? base.sessions.findIndex((b) => b.routineId === s.routineId) : -1
    if (bi < 0) bi = base.sessions.findIndex((b, i) => !usedBase.has(i) && b.name.trim().toLowerCase() === s.name.trim().toLowerCase())
    if (bi >= 0) usedBase.add(bi)
    const prev = bi >= 0 ? base.sessions[bi] : null
    const changes = diffSession(prev?.exercises ?? [], s.exercises)
    return {
      name: s.name,
      previousName: prev && prev.name !== s.name ? prev.name : undefined,
      isNew: !prev,
      intent: s.intent,
      changes,
      ...tallyChanges(changes),
    }
  })

  const plannedNames = new Set(draft.sessions.flatMap((s) => s.exercises.map((e) => normalizeExerciseName(e.name))))
  const stillProgrammed = (name: string) => {
    const want = normalizeExerciseName(name)
    if (plannedNames.has(want)) return true
    return [...plannedNames].some((p) => p.startsWith(want) || want.startsWith(p))
  }
  const mainLiftsDropped = [
    ...new Set(
      base.sessions
        .flatMap((s) => s.exercises)
        .filter((e) => MAIN_LIFT.test(e.name) && !stillProgrammed(e.name))
        .map((e) => e.name),
    ),
  ]

  const minutes = (d: ProgramDraft) => d.sessions.reduce((n, s) => n + estimateSessionMinutes(s.exercises), 0)
  const longSessions = draft.sessions
    .map((s) => ({ name: s.name, minutes: estimateSessionMinutes(s.exercises) }))
    .filter((s) => s.minutes >= LONG_SESSION_MINS)

  const added = sessions.reduce((n, s) => n + s.added, 0)
  const removed = sessions.reduce((n, s) => n + s.removed, 0)
  const changed = sessions.reduce((n, s) => n + s.changed, 0)
  const newSessions = sessions.filter((s) => s.isNew).length
  const renamed = sessions.filter((s) => s.previousName).length

  return {
    sessions,
    added, removed, changed, newSessions,
    mainLiftsDropped,
    sessionsPerWeekBefore: base.sessionsPerWeek,
    sessionsPerWeekAfter: draft.sessionsPerWeek,
    longSessions,
    minutesBefore: minutes(base),
    minutesAfter: minutes(draft),
    dirty:
      added + removed + changed + newSessions + renamed > 0 ||
      base.sessionsPerWeek !== draft.sessionsPerWeek,
  }
}

// ---- standing preferences ---------------------------------------------------

const MAX_PREFERENCES = 6
const MAX_PREFERENCE_LEN = 200

/**
 * Fold this session's requests into the standing list, newest first, deduped and
 * capped. Plain text on purpose: it is read by the phase designer as an emphasis
 * and by a human in the profile, not parsed.
 */
export function mergePreferences(existing: string | null, requests: string[]): string | null {
  const lines = [
    ...requests.map((r) => r.trim().replace(/\s+/g, ' ').slice(0, MAX_PREFERENCE_LEN)).filter(Boolean),
    ...(existing ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
  ]
  const seen = new Set<string>()
  const kept: string[] = []
  for (const l of lines) {
    const key = l.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(l)
    if (kept.length >= MAX_PREFERENCES) break
  }
  return kept.length ? kept.join('\n') : null
}
