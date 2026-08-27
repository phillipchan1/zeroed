// =============================================================================
// weekDiff — what a proposed week does to the week you already have.
//
// Pure, no I/O. This is the only place that decides whether two prescriptions
// are "the same lift", so the phase rebuild and the conversational program
// editor describe a change identically. The diff is the athlete's undo: a
// routine write has no version history, so seeing the delta BEFORE applying it
// is the only chance to weigh it.
// =============================================================================

import type { ExerciseTemplate } from './types.ts'

/** One movement's fate in a proposed change. */
export interface ExerciseChange {
  kind: 'added' | 'removed' | 'changed' | 'kept'
  name: string
  before?: string   // "3×5 · heavy" — absent when added
  after?: string    // absent when removed
}

export interface SessionDiff {
  name: string
  previousName?: string  // set when the change renames the session
  isNew: boolean         // a session with no current counterpart
  intent: string
  changes: ExerciseChange[]
  added: number
  removed: number
  changed: number
}

// Compound barbell work: the movements a strength goal actually rides on. Used
// only to raise a flag on a preview — never to block a change.
export const MAIN_LIFT = /\b(squat|bench|deadlift|overhead\s*press|militar|press|row|chin-?up|pull-?up|clean|snatch)\b/i

/** "Squat (no belt)" and "squat" are the same lift for diffing purposes. */
export function normalizeExerciseName(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The one-line prescription an athlete reads: "4×6 · heavy · RPE 8". */
export function describePrescription(ex: ExerciseTemplate): string {
  const bits = [`${ex.sets}×${ex.reps}`]
  if (ex.load) bits.push(ex.load)
  if (ex.target_rpe != null) bits.push(`RPE ${ex.target_rpe}`)
  return bits.join(' · ')
}

// Pair by normalized name, then by containment either way ("Squat" ↔ "Front
// Squat" never pairs; "Bench press" ↔ "Bench Press (paused)" does).
export function findCounterpart(name: string, pool: ExerciseTemplate[], taken: Set<number>): number {
  const want = normalizeExerciseName(name)
  let idx = pool.findIndex((e, i) => !taken.has(i) && normalizeExerciseName(e.name) === want)
  if (idx >= 0) return idx
  idx = pool.findIndex((e, i) => {
    if (taken.has(i)) return false
    const other = normalizeExerciseName(e.name)
    return other.startsWith(want) || want.startsWith(other)
  })
  return idx
}

/** Movement-by-movement: what stays, what moves, what's gone. */
export function diffSession(before: ExerciseTemplate[], after: ExerciseTemplate[]): ExerciseChange[] {
  const changes: ExerciseChange[] = []
  const taken = new Set<number>()

  for (const prev of before) {
    const idx = findCounterpart(prev.name, after, taken)
    if (idx < 0) {
      changes.push({ kind: 'removed', name: prev.name, before: describePrescription(prev) })
      continue
    }
    taken.add(idx)
    const next = after[idx]
    const b = describePrescription(prev)
    const a = describePrescription(next)
    const renamed = prev.name !== next.name
    if (b === a && !renamed) {
      changes.push({ kind: 'kept', name: next.name, before: b, after: a })
    } else {
      // Only carry the old NAME when the movement itself was swapped — otherwise
      // the row header already says it and the before/after is pure noise.
      changes.push({ kind: 'changed', name: next.name, before: renamed ? `${prev.name} — ${b}` : b, after: a })
    }
  }
  after.forEach((ex, i) => {
    if (!taken.has(i)) changes.push({ kind: 'added', name: ex.name, after: describePrescription(ex) })
  })
  return changes
}

/** Roll a set of per-exercise changes into the counts a header can show. */
export function tallyChanges(changes: ExerciseChange[]): { added: number; removed: number; changed: number } {
  return {
    added: changes.filter((c) => c.kind === 'added').length,
    removed: changes.filter((c) => c.kind === 'removed').length,
    changed: changes.filter((c) => c.kind === 'changed').length,
  }
}
