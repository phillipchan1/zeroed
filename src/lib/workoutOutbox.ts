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
export function useOutboxSync(): void {
  useEffect(() => {
    void flushOutbox()
    const onOnline = () => { void flushOutbox() }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])
}
