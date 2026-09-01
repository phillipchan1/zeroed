// =============================================================================
// STRENGTH BALANCE — which chain is actually behind, and by how much.
//
// I proposed a "strength score" and then changed what it measures. The obvious
// build is a population percentile: your squat against everyone your size and
// sex. That needs bodyweight and sex, neither of which Zeroed collects, and it
// answers a question this app is not asking. Zeroed's whole thesis is that
// something specific about YOU is the limiter. "You are a 62nd-percentile
// squatter" does not name a limiter; it names a peer group.
//
// So this scores the athlete against THEMSELVES: the well-established strength
// ratios between the main lifts. A bench around three quarters of a squat, a
// deadlift about a fifth above it, an overhead press about six tenths of the
// bench, a row near the bench. Those relationships hold across bodyweights and
// across sexes — that is exactly why coaches use them — so the read needs no new
// field and makes no claim it can't support.
//
// The output is a lagging chain and a number for how far behind it is, which is
// the same shape as the rest of the app's reads: falsifiable, specific, and
// something you could go and change.
//
// LIMITS, stated plainly because the number invites over-reading:
//   · ratios are a heuristic, not a law. Leverages, limb lengths and sport
//     demands all move them, and a "lagging" press on a tall lifter with long
//     arms may be perfectly normal for them.
//   · it needs at least two slots to say anything at all — a ratio needs two
//     numbers — and it says so rather than inventing a baseline.
//   · e1RM is an estimate. See prs.ts.
//
// Pure, no I/O (see balance.check.ts).
// =============================================================================

import type { StrengthSlot } from './strengthBaseline.ts'

/**
 * Expected strength relative to the SQUAT, the usual reference lift.
 *
 * The ordinary coaching numbers: deadlift a little above the squat, bench about
 * three quarters of it, a row close behind the bench. Deliberately round — false
 * precision here would imply a confidence the underlying heuristic doesn't have.
 */
export const EXPECTED_VS_SQUAT: Record<StrengthSlot, number> = {
  squat: 1,
  hinge: 1.2,
  push:  0.75,
  pull:  0.7,
}

/** Below this share of what the ratios expect, a chain is called out. */
export const LAGGING_THRESHOLD = 0.9
/** Above this, it's ahead — worth saying, because it's usually where the time went. */
export const LEADING_THRESHOLD = 1.1

export interface ChainBalance {
  slot: StrengthSlot
  /** The lift that carried this slot. */
  lift: string
  /** The athlete's e1RM for it, STORAGE units. */
  e1rm: number
  /** What the ratios expect, given everything else they lift. */
  expected: number
  /** actual / expected. 1.0 is on the line; 0.8 is 20% behind. */
  ratio: number
  state: 'lagging' | 'even' | 'leading'
}

export interface BalanceRead {
  chains: ChainBalance[]
  /** The furthest behind, when one is genuinely behind. The read, as a lift. */
  weakest: ChainBalance | null
  /** Why there is no read, when there isn't one. Never a silent empty state. */
  reason: string | null
}

export interface BalanceInput {
  slot: StrengthSlot
  lift: string
  e1rm: number
}

/**
 * Read the balance across whatever slots the athlete has numbers for.
 *
 * The reference is not the squat specifically — it is the athlete's own average
 * standing across every slot they train, expressed in squat-equivalents. Anchor
 * it to the squat alone and a lifter who simply squats badly reads as though
 * every other lift were ahead, which inverts the finding.
 */
export function readBalance(inputs: BalanceInput[]): BalanceRead {
  const usable = inputs.filter((i) => i.e1rm > 0 && i.slot in EXPECTED_VS_SQUAT)
  // One lift is not a ratio. Say so rather than inventing a second number.
  const bySlot = new Map<StrengthSlot, BalanceInput>()
  for (const i of usable) {
    const cur = bySlot.get(i.slot)
    if (!cur || i.e1rm > cur.e1rm) bySlot.set(i.slot, i)
  }
  if (bySlot.size < 2) {
    return { chains: [], weakest: null, reason: 'Needs two main lifts logged before the ratios mean anything.' }
  }

  // Each lift, restated as the squat it implies. An athlete in balance produces
  // the same number from every lift; the spread between them IS the imbalance.
  const implied = [...bySlot.values()].map((i) => i.e1rm / EXPECTED_VS_SQUAT[i.slot])
  const reference = implied.reduce((a, b) => a + b, 0) / implied.length

  const chains: ChainBalance[] = [...bySlot.values()]
    .map((i) => {
      const expected = reference * EXPECTED_VS_SQUAT[i.slot]
      const ratio = expected > 0 ? i.e1rm / expected : 1
      return {
        slot: i.slot,
        lift: i.lift,
        e1rm: i.e1rm,
        expected: Math.round(expected),
        ratio: Math.round(ratio * 100) / 100,
        state: ratio < LAGGING_THRESHOLD ? 'lagging' as const
             : ratio > LEADING_THRESHOLD ? 'leading' as const
             : 'even' as const,
      }
    })
    .sort((a, b) => a.ratio - b.ratio)

  const worst = chains[0]
  return {
    chains,
    weakest: worst && worst.state === 'lagging' ? worst : null,
    reason: worst && worst.state !== 'lagging' ? 'Nothing is meaningfully behind — the lifts are in proportion.' : null,
  }
}

const SLOT_LABEL: Record<StrengthSlot, string> = {
  squat: 'Squat pattern',
  hinge: 'Hinge / posterior',
  push:  'Upper push',
  pull:  'Upper pull',
}

export function labelForSlot(slot: StrengthSlot): string {
  return SLOT_LABEL[slot]
}

/** How far behind, as the athlete would say it: "18% behind your other lifts". */
export function describeGap(c: ChainBalance): string {
  const pct = Math.round(Math.abs(1 - c.ratio) * 100)
  if (c.state === 'lagging') return `${pct}% behind your other lifts`
  if (c.state === 'leading') return `${pct}% ahead of your other lifts`
  return 'in proportion'
}
