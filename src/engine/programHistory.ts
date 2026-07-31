// =============================================================================
// programHistory — the athlete's training journey, written down and read back.
//
// Two audiences, one record.
//
//   THE ATHLETE gets a timeline: the blocks they've run, the days they changed
//   something, what they asked for in their own words, and what moved. Before
//   program_revision existed the editor overwrote routine rows in place and left
//   a coach_message carrying counts ("3 added · 1 dropped"), so "what did my
//   program look like before I reprogrammed in July?" had no answer at all.
//
//   REPROGRAMMING gets a memory. Phase design used to see one thing about the
//   athlete's training: the newest top set per lift, from the last 40 sessions.
//   That cannot tell a squat that went 225 → 315 over four months from one stuck
//   at 225 the whole time, and those two athletes need opposite blocks. It also
//   could not see which blocks had already been run, what the weekly reviews had
//   been saying, or which questions were already settled — so every boundary
//   designed as though the athlete had just arrived.
//
// Reads are scoped and capped: this is a summary for a model's context window
// and a screen, not an export of the whole log.
// =============================================================================

import { supabase } from '../lib/supabaseClient'
import { readLoggedExercises, type LoggedWorkoutLike } from './loggedSets'
import type {
  ExerciseTemplate, PhaseRow, ProgramRevisionRow, RevisionDiff, RevisionSession,
  RevisionTrigger, SetLog,
} from '../types/database'
import type { DraftDiff, DraftSession, ProgramDraft } from './programDraft'

// ---- writing a revision -----------------------------------------------------

/** Freeze a draft's sessions into the shape a snapshot stores. */
export function toRevisionSessions(sessions: DraftSession[]): RevisionSession[] {
  return sessions.map((s) => ({
    name: s.name,
    intent: s.intent,
    session_type: s.sessionType,
    intended_dow: s.intendedDow,
    exercises: s.exercises,
  }))
}

/**
 * Compress a DraftDiff for storage. 'kept' movements are dropped — they are the
 * bulk of the payload and carry no information a timeline needs; the snapshot
 * already holds the full week for anyone who wants to reconstruct it.
 */
export function toRevisionDiff(diff: DraftDiff): RevisionDiff {
  return {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    new_sessions: diff.newSessions,
    sessions: diff.sessions
      .map((s) => ({
        name: s.name,
        changes: s.changes
          .filter((c) => c.kind !== 'kept')
          .map((c) => ({ kind: c.kind, name: c.name, before: c.before, after: c.after })),
      }))
      .filter((s) => s.changes.length > 0),
  }
}

/** The one line a timeline row shows. */
export function summarizeRevision(diff: RevisionDiff): string {
  const parts = [
    diff.new_sessions > 0 ? `${diff.new_sessions} new session${diff.new_sessions === 1 ? '' : 's'}` : null,
    diff.added > 0 ? `${diff.added} added` : null,
    diff.removed > 0 ? `${diff.removed} dropped` : null,
    diff.changed > 0 ? `${diff.changed} retuned` : null,
  ].filter(Boolean)
  return parts.join(' · ') || 'no net change'
}

export interface RecordRevisionInput {
  programId: string
  phaseId: string | null
  trigger: RevisionTrigger
  /** The day the change takes effect — today for an immediate apply. */
  effectiveOn: string
  /** The athlete's own words, newest first. */
  requests: string[]
  /** The week BEFORE the change. */
  before: DraftSession[]
  diff: DraftDiff
}

/**
 * Append one reprogramming event. Best-effort by design: a revision is a record
 * OF a change, not part of making it, so a failure here must never leave the
 * program half-applied. Returns the row id, or null if it could not be written.
 */
export async function recordProgramRevision(input: RecordRevisionInput): Promise<string | null> {
  const diff = toRevisionDiff(input.diff)
  const { data, error } = await supabase
    .from('program_revision')
    .insert({
      program_id: input.programId,
      phase_id: input.phaseId,
      trigger: input.trigger,
      effective_on: input.effectiveOn,
      requests: input.requests.map((r) => r.trim()).filter(Boolean).slice(0, 10),
      snapshot: toRevisionSessions(input.before),
      diff,
      summary: summarizeRevision(diff),
    })
    .select('id')
    .maybeSingle()
  if (error || !data) return null
  return (data as { id: string }).id
}

// ---- the journey, for the athlete ------------------------------------------

/** One entry on the program timeline — a block started, or a change made. */
export interface JourneyEntry {
  kind: 'block' | 'change'
  id: string
  /** ISO date this entry belongs at on the timeline. */
  date: string
  title: string
  detail: string | null
  /** Present on 'change' entries: what the athlete asked for, in their words. */
  requests: string[]
  /** Present on 'change' entries: the movement-level delta. */
  diff: RevisionDiff | null
  /** True while a change is scheduled but has not taken effect yet. */
  scheduled: boolean
  /** Present on 'block' entries. */
  phaseStatus: string | null
}

/**
 * The whole arc, newest first: every block the athlete has run, and every time
 * they changed the program inside one.
 */
export async function gatherProgramJourney(athleteId: string): Promise<JourneyEntry[]> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return []
  const programId = (prog as { id: string }).id

  const [{ data: phaseRows }, { data: revRows }] = await Promise.all([
    supabase.from('phase')
      .select('id, name, week_start, week_end, status, non_negotiables')
      .eq('program_id', programId).order('week_start', { ascending: false }),
    supabase.from('program_revision')
      .select('*').eq('program_id', programId).order('created_at', { ascending: false }).limit(50),
  ])

  const today = isoToday()
  const entries: JourneyEntry[] = []

  for (const p of (phaseRows ?? []) as PhaseRow[]) {
    const nn = Array.isArray(p.non_negotiables) ? (p.non_negotiables as string[]) : []
    entries.push({
      kind: 'block',
      id: p.id,
      date: p.week_start,
      title: `${p.name} block`,
      detail: nn.length ? nn[0] : null,
      requests: [],
      diff: null,
      scheduled: p.status === 'pending',
      phaseStatus: p.status,
    })
  }

  for (const r of (revRows ?? []) as ProgramRevisionRow[]) {
    const diff = (r.diff ?? {}) as RevisionDiff
    entries.push({
      kind: 'change',
      id: r.id,
      // A scheduled change belongs on the timeline at the day it takes effect;
      // an applied one at the day it was made. Both are "when this became true".
      date: r.effective_on,
      title: r.trigger === 'editor' ? 'You changed the program' : titleForTrigger(r.trigger),
      detail: r.summary,
      requests: Array.isArray(r.requests) ? r.requests : [],
      diff,
      scheduled: r.effective_on > today,
      phaseStatus: null,
    })
  }

  return entries.sort((a, b) => (a.date === b.date ? rank(a) - rank(b) : b.date.localeCompare(a.date)))
}

// A block and a change dated the same day read best with the block first.
function rank(e: JourneyEntry): number {
  return e.kind === 'block' ? 0 : 1
}

function titleForTrigger(t: RevisionTrigger): string {
  switch (t) {
    case 'phase_boundary': return 'Block advanced'
    case 'retest':         return 'Retest re-scoped your training'
    case 'deload':         return 'Load backed off'
    default:               return 'Program changed'
  }
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The window a trajectory is computed over. */
function oneYearAgoISO(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString()
}

// ---- the memory, for reprogramming -----------------------------------------

/**
 * A lift's arc rather than its latest number. `first` and `current` are the ends
 * of the athlete's logged history; `best` is the heaviest top set in between.
 * The three together are what separates "progressing" from "stuck" — the single
 * most important input to designing the next block, and the one phase design
 * could not see.
 */
export interface LiftTrajectory {
  name: string
  first: string
  best: string
  current: string
  sessions: number
  /** Rising, flat, or falling across the logged span — computed, not guessed. */
  direction: 'up' | 'flat' | 'down'
}

export interface ProgramHistorySummary {
  /** Blocks already run, oldest first: "Stability (Jun 2 → Jun 29, completed)". */
  blocks: string[]
  /** Per-lift arcs, heaviest-trained first. */
  trajectories: LiftTrajectory[]
  /** The most recent weekly-review notes, newest first. */
  weekly_notes: string[]
  /** Questions already answered, so a new block doesn't re-litigate them. */
  settled: string[]
  /** Reprogramming events already made, newest first. */
  revisions: string[]
}

const MAX_TRAJECTORIES = 16
const MAX_WEEKLY_NOTES = 6
const MAX_SETTLED = 8
const MAX_REVISIONS = 6

function describeSet(s: SetLog, unit: string): string {
  if (s.weight != null) return `${s.weight}${unit}×${s.reps ?? '?'}`
  if (s.duration != null) return `${s.duration}s`
  if (s.distance != null) return `${s.distance}`
  return `${s.reps ?? '?'} reps`
}

function topWorkingSet(sets: SetLog[] | undefined): SetLog | null {
  if (!Array.isArray(sets) || sets.length === 0) return null
  const loaded = sets.filter((s) => s.weight != null)
  if (loaded.length) return loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  const logged = sets.filter((s) => s.done || s.reps != null || s.duration != null || s.distance != null)
  return logged.length ? logged[logged.length - 1] : null
}

/** A short "Jun 2" for a date the model reads as a timeline, not a timestamp. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Everything reprogramming should know about what came before it. One call,
 * four scoped reads, all capped — this rides in an agent context window.
 */
export async function gatherProgramHistory(
  athleteId: string, programId: string, unit: string,
): Promise<ProgramHistorySummary> {
  const [{ data: phaseRows }, { data: reviewRows }, { data: insightRows }, { data: revRows }, { data: ws }] =
    await Promise.all([
      supabase.from('phase')
        .select('name, week_start, week_end, status')
        .eq('program_id', programId).order('week_start', { ascending: true }),
      supabase.from('weekly_review')
        .select('week_ending, coach_notes')
        .eq('program_id', programId).order('week_ending', { ascending: false }).limit(MAX_WEEKLY_NOTES),
      supabase.from('insight')
        .select('claim, status, category')
        .eq('athlete_id', athleteId).in('status', ['resolved', 'disproved']).limit(MAX_SETTLED),
      supabase.from('program_revision')
        .select('effective_on, requests, summary')
        .eq('program_id', programId).order('created_at', { ascending: false }).limit(MAX_REVISIONS),
      // Ascending, because the arc needs its START — a newest-first row cap would
      // cut off exactly the end that makes it an arc. Bounded by DATE instead:
      // "first" means first in the last year, which is both honest and the window
      // that says anything useful about where a lift is going.
      supabase.from('workout')
        .select('performed_at, actual_weights, exercises_snapshot, routine!inner(exercises, program_id)')
        .eq('routine.program_id', programId)
        .gte('performed_at', oneYearAgoISO())
        .order('performed_at', { ascending: true }),
    ])

  const blocks = ((phaseRows ?? []) as Array<{ name: string; week_start: string; week_end: string; status: string }>)
    .map((p) => `${p.name} (${shortDate(p.week_start)} → ${shortDate(p.week_end)}, ${p.status})`)

  const weekly_notes = ((reviewRows ?? []) as Array<{ week_ending: string; coach_notes: string | null }>)
    .filter((r) => r.coach_notes)
    .map((r) => `week ending ${shortDate(r.week_ending)}: ${String(r.coach_notes).slice(0, 300)}`)

  const settled = ((insightRows ?? []) as Array<{ claim: string; status: string; category: string }>)
    .map((i) => `${i.claim} — ${i.status}`)

  const revisions = ((revRows ?? []) as Array<{ effective_on: string; requests: string[] | null; summary: string | null }>)
    .map((r) => {
      const asks = Array.isArray(r.requests) && r.requests.length ? ` — asked for: ${r.requests.join('; ')}` : ''
      return `${shortDate(r.effective_on)}: ${r.summary ?? 'changed'}${asks}`
    })

  // ---- trajectories --------------------------------------------------------
  // One pass, oldest → newest, tracking the first and last top set per movement
  // plus the heaviest seen. Names come from each session's own snapshot, so a
  // program edit can't fold two different lifts into one arc.
  interface Acc { first: SetLog; last: SetLog; best: SetLog; sessions: number }
  const acc = new Map<string, Acc>()
  for (const w of (ws ?? []) as unknown as LoggedWorkoutLike[]) {
    for (const { name, sets } of readLoggedExercises(w)) {
      const top = topWorkingSet(sets)
      if (!top) continue
      const cur = acc.get(name)
      if (!cur) {
        acc.set(name, { first: top, last: top, best: top, sessions: 1 })
        continue
      }
      cur.last = top
      cur.sessions += 1
      if ((top.weight ?? 0) > (cur.best.weight ?? 0)) cur.best = top
    }
  }

  const trajectories: LiftTrajectory[] = [...acc.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, MAX_TRAJECTORIES)
    .map(([name, a]) => {
      const from = a.first.weight ?? a.first.reps ?? 0
      const to = a.last.weight ?? a.last.reps ?? 0
      // A 2.5% band around the starting number: real progress, not set-to-set noise.
      const band = Math.max(1, Math.abs(Number(from)) * 0.025)
      const direction: LiftTrajectory['direction'] =
        Number(to) - Number(from) > band ? 'up'
          : Number(from) - Number(to) > band ? 'down'
            : 'flat'
      return {
        name,
        first: describeSet(a.first, unit),
        best: describeSet(a.best, unit),
        current: describeSet(a.last, unit),
        sessions: a.sessions,
        direction,
      }
    })

  return { blocks, trajectories, weekly_notes, settled, revisions }
}

/**
 * gatherProgramHistory for callers that only hold an athlete id — the journey
 * screen, which has no reason to know how a program is resolved. Null when there
 * is no active program, or when the read fails (this is context, never a gate).
 */
export async function gatherProgramArc(
  athleteId: string, unit: string,
): Promise<ProgramHistorySummary | null> {
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
  if (!prog?.id) return null
  try {
    return await gatherProgramHistory(athleteId, (prog as { id: string }).id, unit)
  } catch {
    return null
  }
}

/** The draft shape a snapshot restores to — used by the journey view. */
export function fromRevisionSessions(sessions: RevisionSession[]): ProgramDraft {
  return {
    sessions: sessions.map((s) => ({
      routineId: null,
      name: s.name,
      intent: s.intent,
      sessionType: s.session_type,
      intendedDow: s.intended_dow,
      exercises: (s.exercises ?? []) as ExerciseTemplate[],
    })),
    sessionsPerWeek: sessions.length,
  }
}
