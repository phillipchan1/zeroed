// =============================================================================
// A one-off session the coach plans (arc_load_v1). The I/O half of
// engine/outsidePlan.ts: read what the program editor already reads about the
// athlete, ask its task for one session, and — when the athlete starts it —
// write it as its own routine in the external program, so the workout screen
// runs it like any other session without it ever joining the week.
// =============================================================================

import { supabase } from '../lib/supabaseClient'
import { gatherProgramEditState, runProgramEditChat } from './programEdit'
import { nextOneOff, oneOffDraft, oneOffMessage } from './outsidePlan'
import { ensureOutsidePlanProgram } from './index'
import type { ProgramEditTurn } from './agentClient'
import type { DraftSession } from './programDraft'
import type { RoutineRow } from '../types/database'
import type { UnitContext } from '../lib/units'

export interface OneOffReply {
  reply: string
  followups: string[]
  /** The session now on the table: new, revised, or unchanged. */
  session: DraftSession | null
}

export async function planOneOff(
  athleteId: string,
  u: UnitContext,
  current: DraftSession | null,
  history: ProgramEditTurn[],
  request: string,
): Promise<OneOffReply> {
  const state = await gatherProgramEditState(athleteId, u).catch(() => null)
  if (!state) {
    return {
      reply: "I couldn't load your training just now, so I can't plan around it. Try again in a moment.",
      followups: [],
      session: current,
    }
  }
  const res = await runProgramEditChat(state.context, oneOffDraft(current), [], history, oneOffMessage(request, !!current))
  return { reply: res.reply, followups: res.followups, session: nextOneOff(current, res.edits) }
}

/**
 * Write the session as a routine of the external program and hand it back to
 * open. 'adhoc' marks it: the workout screen logs it as source 'external', so
 * it never fills a planned slot.
 */
export async function startOneOff(athleteId: string, session: DraftSession): Promise<RoutineRow> {
  const programId = await ensureOutsidePlanProgram(athleteId)
  const { data, error } = await supabase
    .from('routine')
    .insert({
      program_id: programId,
      phase_id: null,
      name: session.name,
      session_type: 'adhoc',
      exercises: session.exercises,
      intent: session.intent || null,
      intended_dow: null,
    })
    .select()
    .single()
  if (error || !data) throw error ?? new Error('could not start the session')
  return data as RoutineRow
}
