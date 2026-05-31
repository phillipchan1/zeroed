// Convergence state machine — the PURE logic behind the brand organism, kept in
// a .ts module (no JSX) so it's unit-testable and importable by the loop (Phase
// F) without pulling in the SVG component.

// All states the organism will ever show. v1 (onboarding) animates the first
// three; the loop (Phase F) adds the last three WITHOUT renaming these. The
// array order is the tightening axis.
export const CONVERGENCE_STATES = [
  'scattered',     // pre-input — a wide, drifting cloud of possibility
  'zeroing_in',    // each answer collapses a region
  'zeroed_in',     // locked enough to start (still sharpening, honestly)
  'holding_zero',  // F: loop — tight, clean sessions confirming the read
  'off_zero',      // F: loop — a surprise (pain / lift flew / stall) loosened it
  're_zero',       // F: loop — re-converging on a new north star / after a break
] as const
export type ConvergenceState = (typeof CONVERGENCE_STATES)[number]

export const CONVERGENCE_LABEL: Record<ConvergenceState, string> = {
  scattered: 'SCATTERED',
  zeroing_in: 'ZEROING IN',
  zeroed_in: 'ZEROED IN',
  holding_zero: 'HOLDING ZERO',
  off_zero: 'OFF ZERO',
  re_zero: 'RE-ZERO',
}

// Confidence thresholds for the v1 (onboarding) states. The onboarding read caps
// well under 1 (a 3-answer read lands ~0.33–0.45), and that IS "locked enough to
// start" — so zeroed_in is entered at a deliberately modest aggregate. Exported
// so Phase F extends (event-driven off_zero/re_zero) without re-deriving these.
export const CONVERGENCE_THRESHOLDS = {
  zeroingIn: 0.12,   // first real signal in
  zeroedIn: 0.3,     // the read is coherent enough to hand over Session 1
} as const

// Loop context (Phase F). The same threshold spine drives geometry; these flags
// only change which NAME the current tightness carries once the athlete is in the
// forever-loop. They are event-driven off REAL state (a logged surprise, a new
// north star) — never a timer. All come from the existing engine signals
// (isSurprise / aggregateReadConfidence), so there is no parallel signal.
export interface ConvergenceContext {
  loop?: boolean        // in the daily loop (post-onboarding) vs the onboarding read
  surprise?: boolean    // a recent logged result re-injected uncertainty (pain / disconfirm / stall)
  reZero?: boolean      // re-converging on a new north star / after a layoff
}

/**
 * Map aggregate confidence (+ optional loop context) → the convergence state.
 * Pure. Onboarding (no context, or loop:false) only ever yields the first three
 * states. In the loop, the SAME tightness gets a breathing name:
 *   • reZero        → re_zero      (re-scattering toward a new heading)
 *   • surprise      → off_zero     (a result loosened the read — honest wobble)
 *   • tight + clean → holding_zero (confirmed, sessions holding the lock)
 * Geometry still follows `confidence`; the flags never fake tightness they
 * haven't earned — a surprise has already lowered confidence via the engine, so
 * off_zero also looks looser. The label just makes the why legible.
 */
export function deriveConvergenceState(
  confidence: number,
  ctx: ConvergenceContext = {},
): ConvergenceState {
  const c = Math.max(0, Math.min(1, confidence))
  const base: ConvergenceState =
    c < CONVERGENCE_THRESHOLDS.zeroingIn ? 'scattered'
    : c < CONVERGENCE_THRESHOLDS.zeroedIn ? 'zeroing_in'
    : 'zeroed_in'

  if (!ctx.loop) return base

  // In the loop, layer the event-driven names on top of the tightness.
  if (ctx.reZero) return 're_zero'
  if (ctx.surprise) return 'off_zero'
  if (base === 'zeroed_in') return 'holding_zero'  // tight + clean = holding the lock
  return base                                       // still climbing back / early loop
}

// ── Loop convergence (Phase F) ──────────────────────────────────────────────
// The persistent reticle's tightness = LIVE program fit, read straight off the
// insight stack — the SAME state recordSessionAdaptation writes (insight
// .confidence) and the DB trigger maintains (prev_status / updated_at). No
// parallel signal: a clean logged session raises confidences → the cloud
// tightens; a disconfirming/pain observation lowers them → it loosens.

export interface LoopInsight {
  priority?: string
  confidence: number
  status: string
  prev_status?: string | null
  updated_at?: string | null
}

export interface LoopConvergence {
  confidence: number          // aggregate read = live program fit (mean active confidence)
  axes: number[]              // per-insight confidences (multi-axis data shape, ranked)
  context: ConvergenceContext // { loop:true, surprise, reZero }
  activeCount: number
}

const STATUS_RANK: Record<string, number> = {
  disproved: -1, hypothesis: 0, likely: 1, confirmed: 2, resolved: 3,
}
const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 }

const SURPRISE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000  // 3 days — a recent re-evaluation

/**
 * Reduce the insight stack to the loop's convergence reading. Pure: pass the same
 * rows + the same `nowMs` and you get the same result. `nowMs` is injected (not
 * read from Date.now inside) so it's deterministic and testable.
 *
 *  • confidence = mean confidence of ACTIVE insights (resolved/disproved excluded)
 *  • surprise   = an active insight whose status REGRESSED recently (prev_status
 *                 outranks current) — the trigger-backed "uncertainty re-injected"
 *                 event. Geometry already loosens via the lower mean; this only
 *                 sets the OFF ZERO *name*.
 *  • reZero is reserved for a north-star change (Arena swap) — not detected here
 *    yet; the flag is plumbed so it lights up without a reticle change.
 */
export function computeLoopConvergence(
  insights: LoopInsight[],
  nowMs: number,
): LoopConvergence {
  const active = insights.filter(
    (i) => i.status !== 'resolved' && i.status !== 'disproved',
  )
  if (active.length === 0) {
    return { confidence: 0, axes: [], context: { loop: true }, activeCount: 0 }
  }

  const ranked = [...active].sort(
    (a, b) => (PRIORITY_RANK[a.priority ?? 'P4'] ?? 9) - (PRIORITY_RANK[b.priority ?? 'P4'] ?? 9),
  )
  const axes = ranked.map((i) => Math.max(0, Math.min(1, i.confidence)))
  const confidence = axes.reduce((s, c) => s + c, 0) / axes.length

  const surprise = active.some((i) => {
    if (!i.prev_status || !i.updated_at) return false
    const regressed = (STATUS_RANK[i.prev_status] ?? 0) > (STATUS_RANK[i.status] ?? 0)
    if (!regressed) return false
    const age = nowMs - new Date(i.updated_at).getTime()
    return age >= 0 && age <= SURPRISE_WINDOW_MS
  })

  return {
    confidence,
    axes,
    context: { loop: true, surprise },
    activeCount: active.length,
  }
}
