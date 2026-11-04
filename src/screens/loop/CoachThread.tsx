import {
  memo, useCallback, useEffect, useState, type RefObject,
} from 'react'
import { Check, ChevronDown, Copy, Dumbbell, NotebookPen, Target, TriangleAlert } from 'lucide-react'
import { Button, Markdown } from '../../components/ui'
import { describeCoachActionParts, type AppliedAction } from '../../engine'
import type { CoachAction } from '../../engine/agentClient'

/**
 * The pieces of the Coach conversation that are not plain text: a message with
 * its tools, the card the coach conjures when it wants to change something, the
 * report of what an apply did, and the scroll behaviour of the thread itself.
 * CoachScreen owns the state; these own how it reads on a phone.
 */

export interface ChatTurn {
  /** Stable identity — the thread scrolls to a turn by id, not by position. */
  id: number
  role: 'athlete' | 'coach'
  content: string
  /** The just-arrived coach reply: it settles in rather than appearing. */
  fresh?: boolean
  /** On the reply that reports an apply: what landed, what didn't. */
  results?: AppliedAction[]
}

// ---- clipboard --------------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* insecure origin / denied — fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // 16px so iOS doesn't zoom or raise a keyboard for a field nobody sees.
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      className="coach-msg__tool"
      onClick={() => { void copyText(text).then((ok) => { if (ok) setDone(true) }) }}
      aria-label={done ? 'Copied' : 'Copy reply'}
    >
      {done ? <Check size={16} strokeWidth={2.25} /> : <Copy size={16} strokeWidth={2} />}
      {done && <span className="coach-msg__tool-label" role="status">Copied</span>}
    </button>
  )
}

// ---- messages ----------------------------------------------------------------------

/** What an apply actually did, row by row — a ✓ or a reason, never a paragraph. */
function AppliedResults({ results }: { results: AppliedAction[] }) {
  return (
    <ul className="coach-applied" aria-label="What was applied">
      {results.map((r, i) => (
        <li key={i} className={`coach-applied__row${r.ok ? '' : ' is-fail'}`}>
          {r.ok ? <Check size={16} strokeWidth={2.5} aria-label="Applied" /> : <TriangleAlert size={16} strokeWidth={2.25} aria-label="Not applied" />}
          <span>
            {r.label}
            {!r.ok && r.error && <span className="coach-applied__err"> — {r.error}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * One message. Memoised: the draft in the composer changes on every keystroke,
 * and re-parsing a long thread of Markdown on each one is exactly the kind of
 * cost that makes typing on a phone feel heavy.
 */
export const CoachMessage = memo(function CoachMessage({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'athlete') {
    return (
      <div className="coach-msg coach-msg--athlete fade-rise" data-turn={turn.id}>
        {/* pre-wrap (in CSS) keeps the line breaks the athlete typed. */}
        <p className="coach-msg__body">{turn.content}</p>
      </div>
    )
  }
  return (
    <div className={`coach-msg coach-msg--coach fade-rise${turn.fresh ? ' coach-msg--fresh' : ''}`} data-turn={turn.id}>
      <Markdown className="coach-msg__body" text={turn.content} breaks />
      {turn.results && <AppliedResults results={turn.results} />}
      <CopyButton text={turn.content} />
    </div>
  )
})

// ---- the proposed-changes card ----------------------------------------------------------

const ICON = { exercise: Dumbbell, read: Target, note: NotebookPen } as const

/** A cue or a rewritten claim can run long: clamp it, keep it one tap from whole. */
function Quote({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 110
  return (
    <div className="chg__quote">
      <span className="chg__quote-k">{label}</span>
      <p className={long && !open ? 'is-clamped' : undefined}>{text}</p>
      {long && (
        <button type="button" className="chg__link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function ChangeRow({ action, insightLabel }: { action: CoachAction; insightLabel: (id: string) => string | undefined }) {
  const p = describeCoachActionParts(action, { insightLabel })
  const Icon = ICON[p.kind]
  return (
    <li className="chg__item">
      <span className="chg__icon" aria-hidden="true"><Icon size={16} strokeWidth={2} /></span>
      <div className="chg__body">
        <p className="chg__title">{p.title}</p>
        {p.subtitle && <p className="chg__where">{p.subtitle}</p>}
        {p.fields.length > 0 && (
          <ul className="chg__chips" aria-label="What changes">
            {p.fields.map((f) => (
              <li key={f.label} className="chg__chip"><span>{f.label}</span><b className="num">{f.value}</b></li>
            ))}
          </ul>
        )}
        {p.quote && <Quote label={p.quote.label} text={p.quote.text} />}
        {p.fields.length === 0 && !p.quote && <p className="chg__where">No change</p>}
        {action.rationale && <p className="chg__why">{action.rationale}</p>}
      </div>
    </li>
  )
}

const COLLAPSED_ROWS = 3

/**
 * The coach can write, but only behind this card, and only on a tap. It used to
 * be one line of text per change — `Back Squat (Lower A) — load → 205 lbs, sets
 * → 4, reps → 5, cue → "…"` — which on a phone is a wall with nowhere to break.
 * Now each change is a row: what, where, the numbers as chips, the long field as
 * a clamped quote, then why.
 */
export const ProposedChangesCard = memo(function ProposedChangesCard({
  actions, insightLabel, applying, onApply, onDismiss,
}: {
  actions: CoachAction[]
  insightLabel: (id: string) => string | undefined
  applying: boolean
  onApply: () => void
  onDismiss: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? actions : actions.slice(0, COLLAPSED_ROWS)
  const hidden = actions.length - shown.length
  return (
    <section className="chg fade-rise" aria-label="Proposed changes">
      <header className="chg__head">
        <p className="chg__k">Proposed changes <span className="chg__count num">{actions.length}</span></p>
        <p className="chg__note">Nothing is saved until you apply.</p>
      </header>
      <ul className="chg__list">
        {shown.map((a, i) => <ChangeRow key={i} action={a} insightLabel={insightLabel} />)}
      </ul>
      {hidden > 0 && (
        <button type="button" className="chg__more" onClick={() => setShowAll(true)}>
          Show {hidden} more <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      <div className="chg__acts">
        <Button variant="primary" onClick={onApply} disabled={applying}>
          {applying ? 'Applying…' : actions.length > 1 ? `Apply ${actions.length} changes` : 'Apply change'}
        </Button>
        <Button variant="ghost" onClick={onDismiss} disabled={applying}>Dismiss</Button>
      </div>
    </section>
  )
})

// ---- scrolling ---------------------------------------------------------------------------------

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Where the thread lands when something arrives.
 *
 *  - Your own message, or an apply report: the bottom — you're looking at the
 *    thing you just did.
 *  - A reply: if it (with the card and chips that belong to it) fits on screen,
 *    the bottom, so all of it is in view. If it does NOT, its FIRST LINE, not
 *    its last. Landing at the end of a long answer drops you in the middle of a
 *    thought and makes you scroll up to start reading; that is what the old
 *    `scrollIntoView(end)` did.
 *
 * It scrolls the thread's own box (scrollTo), never the page: scrollIntoView
 * walks every scrollable ancestor, and on iOS that includes the one this screen
 * is deliberately locked inside.
 *
 * `away` is true once the reader has left the bottom, for the jump-to-latest
 * control — the thread never yanks you back down while you're reading above.
 */
export function useThreadScroll(ref: RefObject<HTMLDivElement | null>) {
  const [away, setAway] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
  }, [ref])

  const toBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [ref])

  const toTurn = useCallback((id: number) => {
    const el = ref.current
    if (!el) return
    const node = el.querySelector<HTMLElement>(`[data-turn="${id}"]`)
    const behavior = reducedMotion() ? 'auto' : 'smooth'
    if (!node) { el.scrollTo({ top: el.scrollHeight, behavior }); return }
    const fits = el.scrollHeight - node.offsetTop <= el.clientHeight - 16
    el.scrollTo({ top: fits ? el.scrollHeight : Math.max(0, node.offsetTop - 8), behavior })
  }, [ref])

  return { away, measure, toBottom, toTurn }
}
