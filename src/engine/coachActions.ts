/**
 * How a coach-proposed change is DESCRIBED to the athlete.
 *
 * Two shapes of the same fact:
 *  - `describeCoachAction` — one line of text. Used where a line is all there is
 *    (the "couldn't apply: …" report after an apply).
 *  - `describeCoachActionParts` — structured, for the confirm card. The one-liner
 *    ran `Back Squat (Lower A — Squat pattern) — load → 205 lbs, sets → 4,
 *    reps → 5, cue → "Brace before you unrack…", target → RPE 7` together with
 *    no seams, which on a phone is a wall: nothing to scan, nowhere to break.
 *    Parts gives the card a title, a place, short chips for the numbers, and a
 *    quote for the one field that can run long (a cue, a rewritten claim, a note).
 *
 * Pure and dependency-free (type import only) so it is checked with node.
 */
import type { CoachAction } from './agentClient.ts'

/** One-line human summary of a proposed/applied action. */
export function describeCoachAction(a: CoachAction): string {
  switch (a.type) {
    case 'update_insight': {
      const bits: string[] = []
      if (a.set_status) bits.push(`status → ${a.set_status}`)
      if (a.set_confidence != null) bits.push(`confidence → ${Math.round(a.set_confidence * 100)}%`)
      if (a.set_priority) bits.push(`priority → ${a.set_priority}`)
      if (a.set_claim) bits.push(`claim → "${a.set_claim}"`)
      return `Update read — ${bits.join(', ') || 'no change'}`
    }
    case 'update_exercise': {
      const bits: string[] = []
      if (a.set_load) bits.push(`load → ${a.set_load}`)
      if (a.set_sets != null) bits.push(`sets → ${a.set_sets}`)
      if (a.set_reps) bits.push(`reps → ${a.set_reps}`)
      if (a.set_cue) bits.push(`cue → "${a.set_cue}"`)
      if (a.set_target_rpe != null) bits.push(`target → RPE ${a.set_target_rpe}`)
      return `${a.exercise_name ?? 'Exercise'} (${a.routine_name ?? 'routine'}) — ${bits.join(', ') || 'no change'}`
    }
    case 'add_note':
      return `Coach note — "${a.note ?? ''}"`
    default:
      return 'Change'
  }
}

export type CoachActionKind = 'exercise' | 'read' | 'note'

export interface CoachActionParts {
  kind: CoachActionKind
  /** What is being changed: an exercise, a read, or "Coach note". */
  title: string
  /** Where it lives — the routine, for an exercise. */
  subtitle?: string
  /** What moves, as short label/value pairs — rendered as chips. */
  fields: Array<{ label: string; value: string }>
  /** The one field that can run long, kept whole for the card to clamp. */
  quote?: { label: string; text: string }
}

export interface DescribeContext {
  /** Name a read by id ("Lower Chain") — the action itself only carries the id. */
  insightLabel?: (insightId: string) => string | undefined
}

export function describeCoachActionParts(a: CoachAction, ctx: DescribeContext = {}): CoachActionParts {
  switch (a.type) {
    case 'update_exercise': {
      const fields: CoachActionParts['fields'] = []
      if (a.set_load) fields.push({ label: 'Load', value: a.set_load })
      if (a.set_sets != null) fields.push({ label: 'Sets', value: String(a.set_sets) })
      if (a.set_reps) fields.push({ label: 'Reps', value: a.set_reps })
      if (a.set_target_rpe != null) fields.push({ label: 'Target RPE', value: String(a.set_target_rpe) })
      return {
        kind: 'exercise',
        title: a.exercise_name || 'Exercise',
        subtitle: a.routine_name || undefined,
        fields,
        quote: a.set_cue ? { label: 'Cue', text: a.set_cue } : undefined,
      }
    }
    case 'update_insight': {
      const fields: CoachActionParts['fields'] = []
      if (a.set_status) fields.push({ label: 'Status', value: a.set_status })
      if (a.set_confidence != null) fields.push({ label: 'Confidence', value: `${Math.round(a.set_confidence * 100)}%` })
      if (a.set_priority) fields.push({ label: 'Priority', value: a.set_priority })
      const name = a.insight_id ? ctx.insightLabel?.(a.insight_id) : undefined
      return {
        kind: 'read',
        title: name ? `${name} read` : 'A read',
        fields,
        quote: a.set_claim ? { label: 'New claim', text: a.set_claim } : undefined,
      }
    }
    case 'add_note':
      return {
        kind: 'note',
        title: 'Coach note',
        fields: [],
        quote: a.note ? { label: 'Note', text: a.note } : undefined,
      }
    default:
      return { kind: 'note', title: 'Change', fields: [] }
  }
}
