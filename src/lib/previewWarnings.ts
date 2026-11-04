/* Preview warnings, the app's side (tracks_v1, G5).
 *
 * Every preview the engine makes runs the methodology validators: session
 * order (U8), interference (U9), supersets (U10), the small-edit cap (U13) and
 * red flags (U7). U8–U10 are warnings; U13 and red flags refuse the preview.
 * The Worker hands the structured list to the athlete — on a parked proposal
 * (diff.warnings), on a refused override preview, on a refused Undo — and this
 * reads it for display. The athlete sees everything; nothing here goes to a
 * coach. With the flag off nothing is read, so nothing renders.
 */

export type WarningRule = 'U7' | 'U8' | 'U9' | 'U10' | 'U13'

export interface PreviewWarning {
  rule: WarningRule
  message: string
  /** "Session · Exercise", "Session A → Session B" (U9), or "week" (U13). */
  target: string
  /** U13 and red flags: the preview was refused. */
  blocking?: true
}

const RULES: readonly WarningRule[] = ['U7', 'U8', 'U9', 'U10', 'U13']

export const RULE_LABEL: Record<WarningRule, string> = {
  U7: 'Red flag',
  U8: 'Session order',
  U9: 'Interference',
  U10: 'Superset',
  U13: 'Edit size',
}

/** The Worker's list, defensively: unknown rules and malformed rows are dropped, refusals first. */
export function readWarnings(raw: unknown): PreviewWarning[] {
  if (!Array.isArray(raw)) return []
  const out: PreviewWarning[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const w = r as Record<string, unknown>
    if (!RULES.includes(w.rule as WarningRule) || typeof w.message !== 'string' || !w.message.trim()) continue
    out.push({
      rule: w.rule as WarningRule,
      message: w.message.trim(),
      target: typeof w.target === 'string' ? w.target.trim() : '',
      ...(w.blocking === true ? { blocking: true as const } : {}),
    })
  }
  return [...out.filter((w) => w.blocking), ...out.filter((w) => !w.blocking)]
}

export interface WarningsView {
  /** The refusal, when there is one: the change can't go ahead as previewed. */
  refusal: PreviewWarning | null
  /** Everything else, in the Worker's order. */
  notes: PreviewWarning[]
}

/** What to render. Flag off: nothing, whatever the payload says. */
export function warningsView(raw: unknown, on: boolean): WarningsView {
  if (!on) return { refusal: null, notes: [] }
  const all = readWarnings(raw)
  const refusal = all.find((w) => w.blocking) ?? null
  return { refusal, notes: all.filter((w) => w !== refusal) }
}

/** The warnings parked with a proposal (diff.warnings). */
export function proposalWarnings(diff: unknown, on: boolean): WarningsView {
  const d = diff && typeof diff === 'object' ? (diff as Record<string, unknown>) : {}
  return warningsView(d.warnings, on)
}

/** The target, plainly: "Upper · Bench Press" → session + exercise; "week" → the whole week. */
export function targetParts(target: string): { session: string | null; exercise: string | null; label: string } {
  const t = target.trim()
  if (!t || t === 'week') return { session: null, exercise: null, label: 'The whole week' }
  const dot = t.indexOf(' · ')
  if (dot >= 0) {
    const session = t.slice(0, dot).trim()
    const exercise = t.slice(dot + 3).trim()
    return { session, exercise: exercise || null, label: exercise ? `${exercise} (${session})` : session }
  }
  return { session: t, exercise: null, label: t }
}

/** The heading of a refusal. */
export function refusalTitle(w: PreviewWarning): string {
  return w.rule === 'U7' ? 'Refused: red flag' : w.rule === 'U13' ? 'Refused: too big for a small edit' : `Refused: ${RULE_LABEL[w.rule].toLowerCase()}`
}
