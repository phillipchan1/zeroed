import type { ExerciseTemplate, SetLog } from '../../src/types/database.ts'
import type { DraftDiff, DraftSession, ProgramDraft } from '../../src/engine/programDraft.ts'
import { estimateSessionMinutes } from '../../src/engine/programDraft.ts'
import { readLoggedExercises, type LoggedWorkoutLike } from '../../src/engine/loggedSets.ts'

export function isoDay(value: string): string {
  if (!value) return value
  return value.slice(0, 10)
}

export function shortDate(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatSet(s: SetLog, unit: string): string | null {
  if (s.weight != null) return `${s.weight}${unit}×${s.reps ?? '?'}${s.rpe != null ? ` @${s.rpe}` : ''}`
  if (s.duration != null) return `${s.duration}s${s.rpe != null ? ` @${s.rpe}` : ''}`
  if (s.distance != null) return `${s.distance}${s.rpe != null ? ` @${s.rpe}` : ''}`
  if (s.reps != null) return `${s.reps} reps${s.rpe != null ? ` @${s.rpe}` : ''}`
  return null
}

export function topWorkingSet(sets: SetLog[] | undefined): SetLog | null {
  if (!Array.isArray(sets) || sets.length === 0) return null
  const loaded = sets.filter((s) => s.weight != null)
  if (loaded.length) return loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  const logged = sets.filter((s) => s.done || s.reps != null || s.duration != null || s.distance != null)
  return logged.length ? logged[logged.length - 1] : null
}

export function formatPrescription(ex: ExerciseTemplate): string {
  const bits = [`${ex.sets}×${ex.reps}`]
  if (ex.load) bits.push(ex.load)
  if (ex.target_rpe != null) bits.push(`RPE ${ex.target_rpe}`)
  return bits.join(' · ')
}

export function formatSession(session: DraftSession): string {
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const pin = session.intendedDow != null ? dow[session.intendedDow] ?? '' : 'any day'
  const mins = estimateSessionMinutes(session.exercises)
  const lines = [
    `### ${session.name} (${session.sessionType || 'session'} · ${pin} · ~${mins} min)`,
  ]
  if (session.intent) lines.push(session.intent)
  for (const ex of session.exercises) {
    const cue = ex.cue ? ` — ${ex.cue}` : ''
    lines.push(`- ${ex.name}: ${formatPrescription(ex)}${cue}`)
  }
  return lines.join('\n')
}

export function formatDraft(draft: ProgramDraft): string {
  const header = `${draft.sessions.length} sessions · ${draft.sessionsPerWeek} training days / week`
  return [header, '', ...draft.sessions.map(formatSession)].join('\n')
}

export function formatLoggedWorkout(
  w: LoggedWorkoutLike & {
    id?: string
    performed_at: string
    rpe: number | null
    duration_mins: number | null
    routine?: { name?: string | null } | null
  },
  unit: string,
): string {
  const title = w.routine?.name ?? 'Session'
  const meta = [
    shortDate(w.performed_at),
    w.rpe != null ? `RPE ${w.rpe}` : null,
    w.duration_mins != null ? `${w.duration_mins} min` : null,
    w.id ? `id ${w.id}` : null,
  ].filter(Boolean)
  const lines = [`### ${title} — ${meta.join(' · ')}`]
  for (const { name, sets } of readLoggedExercises(w)) {
    const cells = sets.map((s) => formatSet(s, unit)).filter((c): c is string => c != null)
    if (cells.length) lines.push(`- ${name}: ${cells.join(', ')}`)
  }
  return lines.join('\n')
}

export function formatDiff(diff: DraftDiff): string {
  if (!diff.dirty) return 'No net change against the live week.'
  const parts = [
    diff.added > 0 ? `${diff.added} added` : null,
    diff.removed > 0 ? `${diff.removed} dropped` : null,
    diff.changed > 0 ? `${diff.changed} retuned` : null,
    diff.newSessions > 0 ? `${diff.newSessions} new session${diff.newSessions === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  const lines = [
    `**${parts.join(' · ') || 'changed'}**`,
    `Week time ~${diff.minutesBefore} → ~${diff.minutesAfter} min`,
  ]
  if (diff.sessionsPerWeekBefore !== diff.sessionsPerWeekAfter) {
    lines.push(`Training days ${diff.sessionsPerWeekBefore} → ${diff.sessionsPerWeekAfter}`)
  }
  if (diff.mainLiftsDropped.length) {
    lines.push(`⚠ Main lifts leaving the week: ${diff.mainLiftsDropped.join(', ')}`)
  }
  if (diff.longSessions.length) {
    lines.push(`⚠ Long sessions: ${diff.longSessions.map((s) => `${s.name} ~${s.minutes} min`).join(', ')}`)
  }
  for (const session of diff.sessions) {
    const moves = session.changes.filter((c) => c.kind !== 'kept')
    if (!moves.length && !session.isNew && !session.previousName) continue
    const tag = session.isNew ? 'new' : session.previousName ? `was ${session.previousName}` : 'changed'
    lines.push(`\n**${session.name}** (${tag})`)
    for (const c of moves) {
      if (c.kind === 'added') lines.push(`  + ${c.name}${c.after ? ` — ${c.after}` : ''}`)
      else if (c.kind === 'removed') lines.push(`  − ${c.name}${c.before ? ` — ${c.before}` : ''}`)
      else lines.push(`  ~ ${c.name}: ${c.before ?? '?'} → ${c.after ?? '?'}`)
    }
  }
  return lines.join('\n')
}

export function jsonBlock(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```'
}
