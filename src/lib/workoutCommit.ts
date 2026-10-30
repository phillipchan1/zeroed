/* Resolve a workout insert that may have landed even when the client never
 * saw the response.
 *
 * The outbox sends `PendingSession.id` as `workout.client_key`. A commit that
 * times out after the server wrote the row looks like a failure; the retry
 * either unique-violates or looks the key up. Either way we return the
 * existing id instead of inserting a second copy.
 *
 * Isolated so the check can import it without pulling the engine / supabase.
 */

export type InsertError = { code?: string; message?: string }

export function resolveWorkoutInsert(args: {
  insertedId: string | null
  error: InsertError | null
  existingId: string | null
}): { ok: true; workoutId: string } | { ok: false; error: InsertError } {
  if (args.insertedId && !args.error) return { ok: true, workoutId: args.insertedId }
  if (args.existingId) return { ok: true, workoutId: args.existingId }
  return { ok: false, error: args.error ?? { message: 'workout insert failed' } }
}

/** True when the client never heard back — keep the outbox entry queued. */
export function commitFailedUnreachable(err: InsertError | null | undefined): boolean {
  if (!err) return true
  return !(typeof err.code === 'string' && err.code.length > 0)
}
