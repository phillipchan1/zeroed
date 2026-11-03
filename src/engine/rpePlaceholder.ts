/**
 * Placeholder target RPE. A stored 1 that a coach never stamped is not a
 * real target — surface it as a proposed fix. Never rewrite the live week
 * without the athlete approving the coach / preview card.
 */
import { rpeContract } from './prescription.ts'

export const COACH_RPE_SOURCE = 'coach' as const

/** CoachAction-shaped so Coach / preview can apply it without this file importing the client. */
export interface PlaceholderRpeAction {
  type: 'update_exercise'
  rationale: string
  insight_id: null
  routine_name: string
  exercise_name: string
  set_confidence: null
  set_status: null
  set_priority: null
  set_claim: null
  set_load: null
  set_sets: null
  set_reps: null
  set_cue: null
  set_target_rpe: number
  note: null
}

export interface RpeExercise {
  name: string
  target_rpe?: number | null
  rpe_source?: string | null
}

export function isPlaceholderTargetRpe(ex: RpeExercise): boolean {
  return ex.target_rpe === 1 && ex.rpe_source !== COACH_RPE_SOURCE
}

export function suggestedTargetRpe(phaseName?: string | null): number {
  const raw = rpeContract(phaseName).target
  const rounded = Math.round(raw)
  return Math.max(2, Math.min(10, rounded))
}

export function stampCoachTargetRpe<T extends RpeExercise>(ex: T, rpe: number): T & { rpe_source: typeof COACH_RPE_SOURCE } {
  const next = Math.max(1, Math.min(10, Math.round(rpe * 10) / 10))
  return { ...ex, target_rpe: next, rpe_source: COACH_RPE_SOURCE }
}

export function proposePlaceholderRpeFixes(
  sessions: Array<{ name: string; exercises: RpeExercise[] }>,
  phaseName?: string | null,
): PlaceholderRpeAction[] {
  const suggested = suggestedTargetRpe(phaseName)
  const actions: PlaceholderRpeAction[] = []
  for (const session of sessions) {
    for (const ex of session.exercises) {
      if (!isPlaceholderTargetRpe(ex)) continue
      actions.push({
        type: 'update_exercise',
        rationale: `${ex.name} still has RPE 1, which looks like a placeholder — not a coach-set target. Setting the ${phaseName ?? 'block'} target (RPE ${suggested}). Approve to write it; nothing changes until you do.`,
        insight_id: null,
        routine_name: session.name,
        exercise_name: ex.name,
        set_confidence: null,
        set_status: null,
        set_priority: null,
        set_claim: null,
        set_load: null,
        set_sets: null,
        set_reps: null,
        set_cue: null,
        set_target_rpe: suggested,
        note: null,
      })
    }
  }
  return actions
}

export function mergeCoachActions<T extends { type: string; routine_name?: string | null; exercise_name?: string | null; insight_id?: string | null }>(base: T[], extra: T[]): T[] {
  const key = (a: T) => `${a.type}|${a.routine_name ?? ''}|${a.exercise_name ?? ''}|${a.insight_id ?? ''}`
  const seen = new Set(base.map(key))
  const out = [...base]
  for (const a of extra) {
    if (seen.has(key(a))) continue
    seen.add(key(a))
    out.push(a)
  }
  return out
}

/** Preview-only markdown. Does not mutate the draft. */
export function placeholderRpePreviewSection(
  sessions: Array<{ name: string; exercises: RpeExercise[] }>,
  phaseName?: string | null,
): string {
  const actions = proposePlaceholderRpeFixes(sessions, phaseName)
  if (!actions.length) return ''
  return [
    '## Suggested RPE fixes (approve to write; not applied)',
    'These target_rpe=1 values were never coach-stamped. Include them in apply_program_edits with confirm=true, or Apply them on Coach. Nothing is rewritten until then.',
    ...actions.map((a) => `- ${a.exercise_name} (${a.routine_name}): target_rpe → ${a.set_target_rpe}`),
  ].join('\n')
}
