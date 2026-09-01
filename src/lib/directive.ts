// The weekly directive, as it looks on screen.
//
// One mapping, because two screens now render it. The recap had this table
// inline; the block volume chart needs exactly the same colour and the same
// plain-language gist, and a second copy is how "DELOAD" ends up amber in one
// place and red in another.
//
// The colours are the app's RESERVED status palette, not free categorical hues,
// and every use pairs them with the directive's own text — a colour alone never
// carries the meaning.

import type { WeeklyDirective } from '../types/database'

export interface DirectiveTone {
  color: string
  /** Plain language, for anyone who doesn't read PROGRESS/HOLD/DELOAD fluently. */
  gist: string
  /**
   * Two letters for a chart axis, where the full word will not fit.
   * NOT "PR" for PROGRESS — this app now uses PR for a personal record in the
   * set row, and the same two letters meaning two things is worse than a
   * slightly less obvious abbreviation.
   */
  short: string
}

export const DIRECTIVE_TONE: Record<WeeklyDirective, DirectiveTone> = {
  PROGRESS:        { color: 'var(--confirmed)', gist: 'Earned more load',              short: 'UP' },
  HOLD:            { color: 'var(--text-dim)',  gist: 'Holding the line',              short: 'HOLD' },
  'HOLD (missed)': { color: 'var(--pending)',   gist: 'Resetting the week',            short: 'MISS' },
  DELOAD:          { color: 'var(--pending)',   gist: 'Backing off to recover',        short: 'DELD' },
  RECOVERY:        { color: 'var(--pending)',   gist: 'Healing — recovery is the work', short: 'REC' },
}

export function toneFor(d: WeeklyDirective | null | undefined): DirectiveTone {
  return (d && DIRECTIVE_TONE[d]) || DIRECTIVE_TONE.HOLD
}
