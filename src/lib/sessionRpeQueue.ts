/* Session RPE taps waiting to sync (tracks_v1, G9 follow-up).
 *
 * The CR-10 tap after a session is one small write, and the finish is exactly
 * when the gym's signal is worst. So a tap is queued first (localStorage, like
 * the workout outbox: it survives reloads and the app being killed, and works
 * the same in the Capacitor shell) and then sent; whatever can't be sent stays
 * here and is retried on launch, reconnect and resume.
 *
 * Each tap carries a client_id minted at the tap and its own tapped_at. The
 * Worker dedupes on client_id (a retry whose first send landed is "Already
 * logged", never a second write) and judges the rating window at tapped_at,
 * within bounds (worker/src/sessionRpe.ts): a session dated D can be rated
 * until 04:00 on D+1, and a queued tap is trusted back 48 h at most.
 *
 * An answer is acted on by kind:
 *   accepted     the server took it (or already had it, or has a newer one) → drop
 *   rejected     the server refused it for good (bad tap, out of the window,
 *                flag off → 404) → drop; retrying can't change the answer
 *   later        no answer (offline, 5xx, signed out, table not there yet)
 *                → keep, and stop this pass: nothing behind it would get through
 *
 * Pure: no network, no React. The sender and the hooks live in sessionRpe.ts.
 */

const QUEUE_KEY = 'zeroed:session-rpe-queue'

/** The Worker refuses a queued tap older than this (QUEUE_MAX_AGE_MS); keeping one longer is pointless. */
export const TAP_KEEP_MS = 48 * 60 * 60 * 1000

export interface QueuedTap {
  client_id: string
  session_id: string
  /** The session's local date (YYYY-MM-DD). */
  date: string
  rating: number
  duration_min: number | null
  workout_id: string | null
  /** When the athlete tapped (ISO). */
  tapped_at: string
  attempts: number
}

export type TapOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'later' }

/** What a response means for a queued tap. status null: the request never got an answer. */
export function tapOutcome(status: number | null, body: unknown): TapOutcome {
  if (status == null) return { kind: 'later' }
  if (status === 401 || status === 408 || status === 429 || status >= 500) return { kind: 'later' }
  if (status >= 400) return { kind: 'rejected', reason: `session rpe ${status}` }
  const out = body && typeof body === 'object' ? body as { ok?: unknown; retry?: unknown; text?: unknown } : null
  if (out?.ok === true) return { kind: 'accepted' }
  if (out?.retry === true) return { kind: 'later' }
  return { kind: 'rejected', reason: typeof out?.text === 'string' ? out.text : 'refused' }
}

// ---- storage ---------------------------------------------------------------

type TapStorage = Pick<Storage, 'getItem' | 'setItem'>

function storage(): TapStorage | null {
  try {
    return (globalThis as { localStorage?: TapStorage }).localStorage ?? null
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

/** Subscribe to queue changes, so a "will sync" note clears itself. */
export function subscribeTapQueue(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function isTap(x: unknown): x is QueuedTap {
  if (!x || typeof x !== 'object') return false
  const t = x as Partial<QueuedTap>
  return typeof t.client_id === 'string' && typeof t.session_id === 'string' && typeof t.date === 'string'
    && typeof t.rating === 'number' && typeof t.tapped_at === 'string'
}

function readQueue(): QueuedTap[] {
  try {
    const raw = storage()?.getItem(QUEUE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(isTap).map((t) => ({ ...t, duration_min: t.duration_min ?? null, workout_id: t.workout_id ?? null, attempts: t.attempts ?? 0 }))
      : []
  } catch {
    return []
  }
}

function writeQueue(q: QueuedTap[]): void {
  try { storage()?.setItem(QUEUE_KEY, JSON.stringify(q)) } catch { /* quota — non-fatal */ }
  listeners.forEach((fn) => fn())
}

/** Taps still waiting. */
export function queuedTaps(): QueuedTap[] {
  return readQueue()
}

/** The tap waiting for this session on this date, if any. */
export function queuedTapFor(sessionId: string, date: string): QueuedTap | null {
  return readQueue().find((t) => t.session_id === sessionId && t.date === date) ?? null
}

/**
 * Queue a tap, durable before any network. A newer tap for the same session
 * and date replaces one still waiting (the newer rating is the one that
 * counts); one already in flight carries its own client_id and an older
 * tapped_at, so the Worker never lets it land over this one.
 */
export function enqueueTap(
  input: { session_id: string; date: string; rating: number; duration_min: number | null; workout_id?: string | null },
  now: Date = new Date(),
  newId: () => string = () => crypto.randomUUID(),
): QueuedTap {
  const tap: QueuedTap = {
    client_id: newId(),
    session_id: input.session_id,
    date: input.date,
    rating: input.rating,
    duration_min: input.duration_min,
    workout_id: input.workout_id ?? null,
    tapped_at: now.toISOString(),
    attempts: 0,
  }
  writeQueue([...readQueue().filter((t) => !(t.session_id === tap.session_id && t.date === tap.date)), tap])
  return tap
}

function removeTap(clientId: string): void {
  writeQueue(readQueue().filter((t) => t.client_id !== clientId))
}

// ---- syncing ---------------------------------------------------------------

let flushing: Promise<void> | null = null

/**
 * Send every waiting tap, oldest first (each once per pass). Accepted and rejected taps leave the
 * queue; the first "later" ends the pass with it and everything behind it kept.
 * Taps older than the Worker would take are dropped unsent. Concurrent callers
 * share one pass, so a tap is never sent twice at once.
 */
export function flushTapQueue(send: (tap: QueuedTap) => Promise<TapOutcome>, now: () => Date = () => new Date()): Promise<void> {
  if (flushing) return flushing
  flushing = (async () => {
    // Re-read each turn: a tap queued mid-pass is sent in this pass too.
    const tried = new Set<string>()
    for (let tap: QueuedTap | undefined = readQueue()[0]; tap; tap = readQueue().find((t) => !tried.has(t.client_id))) {
      tried.add(tap.client_id)
      if (now().getTime() - new Date(tap.tapped_at).getTime() > TAP_KEEP_MS) {
        removeTap(tap.client_id)
        continue
      }
      let out: TapOutcome
      try {
        out = await send(tap)
      } catch {
        out = { kind: 'later' }
      }
      if (out.kind === 'later') {
        writeQueue(readQueue().map((t) => (t.client_id === tap.client_id ? { ...t, attempts: t.attempts + 1 } : t)))
        break
      }
      removeTap(tap.client_id)
    }
  })().finally(() => { flushing = null })
  return flushing
}
