// Offline-completion outbox — the durable queue behind "Complete workout".
//
// Finishing a session writes to the server (the workout row, the observations)
// and runs the AI debrief — all of which need a connection. Rather than block or
// lose the work offline, a finished session is enqueued here (localStorage, so it
// survives reloads and the PWA being killed) and committed via the engine's
// commitSession. The live flow commits immediately; whatever can't reach the
// server stays queued and is flushed on the next launch or `online` event.
//
// The AI debrief is the one inherently online step — for a session completed
// offline it simply runs at sync time, when the connection is back.

import { useEffect } from 'react'
import { commitSession, type PendingSession, type CommitResult } from '../engine'
import { invalidateLoopViews } from './loopCache'
import { isKnownOffline, subscribeOnline } from './useOnline'

const OUTBOX_KEY = 'zeroed:workout-outbox'

function readQueue(): PendingSession[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    return raw ? (JSON.parse(raw) as PendingSession[]) : []
  } catch {
    return []
  }
}

function writeQueue(q: PendingSession[]): void {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)) } catch { /* quota — non-fatal */ }
}

// Enqueue (or replace by id) — call this BEFORE attempting a commit so the
// session is durable the instant the athlete finishes, even if the tab dies.
export function enqueueSession(p: PendingSession): void {
  writeQueue([...readQueue().filter((x) => x.id !== p.id), p])
}

function removeFromQueue(id: string): void {
  writeQueue(readQueue().filter((x) => x.id !== id))
}

export function pendingCount(): number {
  return readQueue().length
}

// Finished-but-uncommitted sessions, shaped like `workout` rows so the schedule
// can fold them in. The outbox — not the `workout` table — is the durable source
// of truth for "I finished a session"; until a commit lands, scheduling reads
// (today's routine, the week strip) must still count these or a finished session
// stays invisible across reloads. The day it counts for is `performedAt` (a
// session can be backdated), falling back to the completion time.
export function pendingWorkouts(): Array<{ routine_id: string; performed_at: string }> {
  return readQueue().map((p) => ({ routine_id: p.routineId, performed_at: p.performedAt ?? p.queuedAt }))
}

// The full queued sessions — same source of truth, but with the set logs / RPE a
// rich read (the training log) needs to render a finished-but-uncommitted session
// before its `workout` row lands. Committed reads still flush on launch/`online`;
// this just stops a session you finished seconds ago from looking lost.
export function pendingSessionsRaw(): PendingSession[] {
  return readQueue()
}

// Ids currently being committed — guards against the live commit and a concurrent
// flush (e.g. an `online` event firing mid-submit) double-inserting the workout.
const inFlight = new Set<string>()

// Commit one queued session, removing it on success. Returns null if it's already
// being committed elsewhere. Throws (leaving it queued) if the write fails.
export async function commitPending(p: PendingSession): Promise<CommitResult | null> {
  if (inFlight.has(p.id)) return null
  inFlight.add(p.id)
  try {
    const result = await commitSession(p)
    removeFromQueue(p.id)
    // The session is now a real row, and the queued copy that screens were
    // folding in is gone. Mark every view due so whatever is on screen catches
    // up to the committed truth without the athlete doing anything.
    invalidateLoopViews()
    return result
  } finally {
    inFlight.delete(p.id)
  }
}

let flushing = false

// Try to commit everything queued. Stops at the first failure (offline) and
// leaves the remainder for the next trigger. Safe to call concurrently.
export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (const p of readQueue()) {
      try {
        await commitPending(p)
      } catch {
        break // offline / transient — retry on the next launch or `online` event
      }
    }
  } finally {
    flushing = false
  }
}

// Flush on mount and whenever connectivity returns. Mount once near the app root.
//
// Three triggers, because a finished session sitting unsynced is the worst thing
// this app can do and the browser's `online` event is not dependable: it never
// fires at all in some iOS PWA resume paths. So we also flush on a verified
// connectivity transition, and whenever the app is brought back to the
// foreground. flushOutbox is a no-op on an empty queue and guards re-entry, so
// the extra triggers cost nothing.
export function useOutboxSync(): void {
  useEffect(() => {
    const flush = () => { void flushOutbox() }
    flush()
    const onVisible = () => { if (document.visibilityState === 'visible') flush() }
    window.addEventListener('online', flush)
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = subscribeOnline(() => { if (!isKnownOffline()) flush() })
    return () => {
      window.removeEventListener('online', flush)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [])
}
