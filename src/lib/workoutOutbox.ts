// Offline-completion outbox — the durable queue behind "Complete workout".
//
// Finishing a session writes to the server (the workout row, the observations)
// and runs the AI debrief — all of which need a connection. Rather than block or
// lose the work offline, a finished session is enqueued here (localStorage, so it
// survives reloads and the PWA being killed) and committed via the engine's
// commitSession. The live flow commits immediately; whatever can't reach the
// server stays queued and is flushed on the next launch or return to connectivity.
//
// The AI debrief is the one inherently online step — for a session completed
// offline it simply runs at sync time, when the connection is back.
//
// HEAD-OF-LINE BLOCKING is the failure this file is built around. A queue that
// stops at its first failure is fine when every failure is "you're offline", and
// catastrophic when one entry can NEVER commit: the server rejects it forever, the
// pass aborts on it every time, and every good session behind it is held hostage.
// That is how an athlete ends up looking at "10 sessions saved offline" on full
// signal. So a failure is now classified before it's acted on:
//
//   - Can't reach the server  → stop the pass, change nothing, try again later.
//     (Nothing behind it could succeed either, so there's no point burning it.)
//   - Server rejected THIS one → record it against that entry and CARRY ON.
//     Permanent rejections (permission, foreign key, duplicate, row gone) never
//     self-heal, so the entry is retired immediately rather than retried forever;
//     anything murkier is retried up to MAX_ATTEMPTS first.
//
// A retired entry is still *kept* — the athlete did that session and it still
// counts on their week — but it stops claiming it's about to sync, and it stops
// standing in front of sessions that can.

import { useEffect, useState } from 'react'
import { commitSession, type PendingSession, type CommitResult } from '../engine'
import { invalidateLoopViews } from './loopCache'
import { isKnownOffline, subscribeOnline } from './useOnline'

const OUTBOX_KEY = 'zeroed:workout-outbox'

// How many times a session is retried against an error we can't classify before
// we stop calling it "syncing". Definite rejections don't get this many.
const MAX_ATTEMPTS = 5

/** A queued session plus what we've learned trying to send it. */
export interface OutboxEntry {
  session: PendingSession
  attempts: number
  lastError: string | null
  /** Retired: it won't be retried automatically, and it isn't "about to sync". */
  blocked: boolean
}

// ---- storage ---------------------------------------------------------------

const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

/** Subscribe to queue changes, so a "waiting to sync" note can clear itself. */
export function subscribeOutbox(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Entries used to be stored as bare PendingSession objects. Anything already on a
// device is in that shape, including the sessions this change exists to unstick,
// so it's read forward rather than dropped.
function normalize(raw: unknown): OutboxEntry | null {
  if (!raw || typeof raw !== 'object') return null
  if ('session' in raw) {
    const e = raw as Partial<OutboxEntry>
    if (!e.session) return null
    return {
      session: e.session,
      attempts: typeof e.attempts === 'number' ? e.attempts : 0,
      lastError: typeof e.lastError === 'string' ? e.lastError : null,
      blocked: e.blocked === true,
    }
  }
  const session = raw as PendingSession
  if (!session.id) return null
  return { session, attempts: 0, lastError: null, blocked: false }
}

function readQueue(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown[]
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalize).filter((e): e is OutboxEntry => e !== null)
  } catch {
    return []
  }
}

function writeQueue(q: OutboxEntry[]): void {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)) } catch { /* quota — non-fatal */ }
  notify()
}

// Enqueue (or replace by id) — call this BEFORE attempting a commit so the
// session is durable the instant the athlete finishes, even if the tab dies.
export function enqueueSession(p: PendingSession): void {
  writeQueue([
    ...readQueue().filter((e) => e.session.id !== p.id),
    { session: p, attempts: 0, lastError: null, blocked: false },
  ])
}

function removeFromQueue(id: string): void {
  writeQueue(readQueue().filter((e) => e.session.id !== id))
}

// ---- failure classification ------------------------------------------------

/**
 * PostgREST hands back a populated `code` for anything the server actually
 * answered; a fetch that never landed surfaces with an empty one. That's the line
 * between "we're offline" and "this session was rejected".
 */
function rejectionCode(err: unknown): string | null {
  if (!err || typeof err !== 'object' || !('code' in err)) return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

// Rejections with no path to succeeding on a retry:
//   42501 — insufficient privilege (RLS / missing grant)
//   23503 — foreign key violation (the routine is gone, e.g. a phase rebuild)
//   23505 — unique violation (already committed)
//   23502 — not-null violation (the payload can't satisfy the table)
//   22P02 — invalid text representation (a malformed stored value)
//   PGRST116 — no row returned where exactly one was required
const PERMANENT_CODES = new Set(['42501', '23503', '23505', '23502', '22P02', 'PGRST116'])

function describe(err: unknown): string {
  if (!err) return 'unknown error'
  if (typeof err === 'object' && 'message' in err) {
    const { message } = err as { message?: unknown }
    const code = rejectionCode(err)
    return `${code ? `[${code}] ` : ''}${typeof message === 'string' ? message : 'request failed'}`
  }
  return String(err)
}

/** Record an attempt against one entry, retiring it when retrying is pointless. */
function recordFailure(id: string, err: unknown): void {
  const code = rejectionCode(err)
  writeQueue(
    readQueue().map((e) => {
      if (e.session.id !== id) return e
      const attempts = e.attempts + 1
      const permanent = code !== null && PERMANENT_CODES.has(code)
      return {
        ...e,
        attempts,
        lastError: describe(err),
        blocked: permanent || attempts >= MAX_ATTEMPTS,
      }
    }),
  )
}

// ---- reads -----------------------------------------------------------------

/** Sessions still expected to sync on their own. */
export function pendingCount(): number {
  return readQueue().filter((e) => !e.blocked).length
}

/** Sessions the server refused — they need a decision, not more waiting. */
export function blockedCount(): number {
  return readQueue().filter((e) => e.blocked).length
}

/** Why the retired sessions were refused (most recent error per entry). */
export function blockedReasons(): string[] {
  return readQueue().filter((e) => e.blocked).map((e) => e.lastError ?? 'unknown error')
}

// Finished-but-uncommitted sessions, shaped like `workout` rows so the schedule
// can fold them in. The outbox — not the `workout` table — is the durable source
// of truth for "I finished a session"; until a commit lands, scheduling reads
// (today's routine, the week strip) must still count these or a finished session
// stays invisible across reloads. The day it counts for is `performedAt` (a
// session can be backdated), falling back to the completion time. Retired entries
// are included: the athlete still did the session, whatever the server thinks.
export function pendingWorkouts(): Array<{ routine_id: string; performed_at: string }> {
  return readQueue().map((e) => ({
    routine_id: e.session.routineId,
    performed_at: e.session.performedAt ?? e.session.queuedAt,
  }))
}

// The full queued sessions — same source of truth, but with the set logs / RPE a
// rich read (the training log) needs to render a finished-but-uncommitted session
// before its `workout` row lands. Committed reads still flush on launch/reconnect;
// this just stops a session you finished seconds ago from looking lost.
export function pendingSessionsRaw(): PendingSession[] {
  return readQueue().map((e) => e.session)
}

// ---- committing ------------------------------------------------------------

// Ids currently being committed — guards against the live commit and a concurrent
// flush (e.g. reconnecting mid-submit) double-inserting the workout.
const inFlight = new Set<string>()

// Commit one queued session, removing it on success. Returns null if it's already
// being committed elsewhere. Throws (leaving it queued, with the failure recorded
// against it) if the write fails.
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
  } catch (err) {
    // Only a rejection tells us anything about this session; an unreachable
    // server says nothing about it, so it mustn't count against it.
    if (rejectionCode(err) !== null) recordFailure(p.id, err)
    throw err
  } finally {
    inFlight.delete(p.id)
  }
}

let flushing = false

/**
 * Try to commit everything queued. A rejected session is recorded and stepped
 * over so the rest of the queue still drains; an unreachable server ends the pass
 * untouched, to be retried on the next launch or reconnect. Safe to call
 * concurrently.
 */
export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (const entry of readQueue()) {
      if (entry.blocked) continue
      try {
        await commitPending(entry.session)
      } catch (err) {
        // Rejected: commitPending has already recorded it. Move on — the next
        // session in the queue has nothing to do with this one's problem.
        if (rejectionCode(err) !== null) continue
        // Couldn't reach the server: nothing behind this can succeed either.
        break
      }
    }
  } finally {
    flushing = false
  }
}

/** Give the retired sessions another go — after a fix has shipped, say. */
export async function retryBlocked(): Promise<void> {
  writeQueue(readQueue().map((e) => (e.blocked ? { ...e, attempts: 0, blocked: false } : e)))
  await flushOutbox()
}

/**
 * Drop the sessions that can't sync. Destructive and athlete-initiated only: the
 * set logs live nowhere else, so nothing calls this automatically.
 */
export function discardBlocked(): void {
  writeQueue(readQueue().filter((e) => !e.blocked))
  invalidateLoopViews()
}

// ---- hooks -----------------------------------------------------------------

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

export interface OutboxStatus {
  /** Sessions still expected to sync on their own. */
  pending: number
  /** Sessions the server refused, which won't clear without a decision. */
  blocked: number
  reasons: string[]
}

/**
 * Live queue status. Subscribed rather than polled, so the note disappears the
 * moment the queue drains instead of lingering until the next focus event.
 */
export function useOutboxStatus(): OutboxStatus {
  const read = (): OutboxStatus => ({
    pending: pendingCount(),
    blocked: blockedCount(),
    reasons: blockedReasons(),
  })
  const [status, setStatus] = useState<OutboxStatus>(read)
  useEffect(() => {
    // The mount-time flush can drain the queue before this subscription exists,
    // so re-read once here rather than showing a count that's already wrong.
    setStatus(read())
    return subscribeOutbox(() => setStatus(read()))
  }, [])
  return status
}
