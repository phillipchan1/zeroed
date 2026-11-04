import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ChevronRight, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { invalidateLoopViews } from '../../lib/loopCache'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import {
  InsightCard, Markdown, SectionHeader, Skeleton, StatusCounts,
  ChatComposer, TypingDots,
} from '../../components/ui'
import {
  countInsightsByStatus, gatherCoachContext, coachStarterPrompts, runCoachChat,
  applyCoachActions, describeCoachAction, type AppliedAction,
} from '../../engine'
import type { CoachContext, CoachChatTurn, CoachAction } from '../../engine/agentClient'
import { mergeCoachActions, proposePlaceholderRpeFixes } from '../../engine/rpePlaceholder'
import type { ExerciseTemplate } from '../../types/database'
import { ConvergenceReticle } from '../../components/convergence/ConvergenceReticle'
import { computeLoopConvergence } from '../../components/convergence/state'
import { PendingProposals, ProposalsBanner } from './ProposalCard'
import { AppCoachPanel } from './AppCoachPanel'
import { coachOn } from '../../lib/tracksFlag'
import { CoachMessage, ProposedChangesCard, useThreadScroll, type ChatTurn } from './CoachThread'
import type { InsightRow, CoachMessageRow, WeeklyPrescription } from '../../types/database'

/**
 * COACH — the intelligence, and the conversation. The read is the cold
 * instrument: the status counts, the weak-link stack. The chat is the warm layer
 * (Agent #8, Jarvis Doctrine) — it can see a scoped slice of the athlete and
 * answer "why". It can PROPOSE changes, but nothing is written until the athlete
 * taps Apply; when the athlete reports something new it routes them to the
 * session log, the only place a signal becomes evidence.
 *
 * On a phone this is a chat app, not a page: a fixed header, ONE scrolling
 * thread, and a composer docked under it. The read folds behind the header and
 * opens full-screen; what's waiting on the athlete is a one-line banner, never
 * a card tall enough to take the screen from the conversation.
 */

// The coach's event memory (§4.5) — weekly reviews, phase changes, retests.
const KIND_LABEL: Record<string, string> = {
  weekly_review: 'WEEKLY REVIEW',
  phase_change:  'PHASE',
  retest:        'RETEST',
  note:          'ADAPTED',
  chat:          'CHAT',
}

function relativeTime(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// The whole Coach surface as one cached view: the read (insights), the event
// feed, the directives those events carry, and the scoped slice the chat is
// allowed to see. One key, one composed object — so re-entering Coach paints
// from memory with no skeleton and no round-trip.
interface CoachView {
  insights: InsightRow[]
  messages: CoachMessageRow[]
  directiveByRef: Record<string, string>
  context: CoachContext | null
  placeholderRpeActions: CoachAction[]
}

export async function fetchCoachView(athleteId: string): Promise<CoachView> {
  // The read and the event feed are independent — issue them together.
  const [insightRes, msgRes, progRes] = await Promise.all([
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
    supabase
      .from('coach_message')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase.from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
  ])
  const insights = (insightRes.data ?? []) as InsightRow[]
  const messages = (msgRes.data ?? []) as CoachMessageRow[]

  // The directive for any weekly-review message, so the card can chip it.
  const directiveByRef: Record<string, string> = {}
  const reviewRefs = messages.filter((m) => m.kind === 'weekly_review' && m.ref_id).map((m) => m.ref_id as string)
  const [reviewRes, context] = await Promise.all([
    reviewRefs.length
      ? supabase.from('weekly_review').select('id, next_week_prescription').in('id', reviewRefs)
      : Promise.resolve({ data: [] as unknown[] }),
    // The trimmed slice the conversation is allowed to see (separate from the
    // display stack above).
    gatherCoachContext(athleteId),
  ])
  ;(reviewRes.data ?? []).forEach((r) => {
    const presc = (r as { next_week_prescription: WeeklyPrescription | null }).next_week_prescription
    if (presc?.directive) directiveByRef[(r as { id: string }).id] = presc.directive
  })

  let placeholderRpeActions: CoachAction[] = []
  if (progRes.data?.id) {
    const [phaseRes, routineRes] = await Promise.all([
      supabase.from('phase').select('name').eq('program_id', progRes.data.id).eq('status', 'active').maybeSingle(),
      supabase.from('routine').select('name, exercises').eq('program_id', progRes.data.id),
    ])
    placeholderRpeActions = proposePlaceholderRpeFixes(
      ((routineRes.data ?? []) as Array<{ name: string; exercises: ExerciseTemplate[] | null }>).map((r) => ({
        name: r.name,
        exercises: Array.isArray(r.exercises) ? r.exercises : [],
      })),
      phaseRes.data?.name,
    )
  }

  return { insights, messages, directiveByRef, context, placeholderRpeActions }
}


/**
 * The composer and the line under it. Its own component so the draft — which
 * changes on every keystroke — re-renders only this, not the thread above it.
 */
const CoachDock = memo(function CoachDock({ ready, busy, placeholder, onSend, onFocusChange }: {
  ready: boolean
  busy: boolean
  placeholder: string
  onSend: (text: string) => void
  onFocusChange: (focused: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <div
      className="coach-dock"
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
    >
      {/* The placeholder has to fit on one line at the narrowest phone and at 150%
          text — a wrapped one makes the field look already overflowed. */}
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => {
          const q = draft.trim()
          if (!q) return
          setDraft('')
          onSend(q)
        }}
        placeholder={placeholder}
        disabled={!ready}
        sendDisabled={busy}
        ariaLabel="Ask the coach"
        sendLabel="Ask"
      />
      <p className="coach-foot text-xs text-dim">
        Nothing is written until you approve it. Notice something mid-session? Log it next session so it counts.
      </p>
    </div>
  )
})

export function CoachScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 1000px)')

  // Offline-first: paints from the held view on the first frame, revalidates
  // behind it. `loading` is true only on the very first visit ever.
  const { data: view, loading, refetch } = useCachedLoader(
    `coach:${athleteId}`,
    () => fetchCoachView(athleteId),
  )
  const insights = useMemo(() => view?.insights ?? [], [view])
  const messages = view?.messages ?? []
  const directiveByRef = view?.directiveByRef ?? {}
  const context = view?.context ?? null

  // ---- conversation state ----
  const [turns, setTurns]           = useState<ChatTurn[]>([])
  const nextTurnId                  = useRef(1)
  const turn = (role: ChatTurn['role'], content: string, extra?: Partial<ChatTurn>): ChatTurn =>
    ({ id: nextTurnId.current++, role, content, ...extra })
  // Only the newest coach reply settles in; every send clears the old flag. A
  // turn that's already stale keeps its identity so its memoised row isn't redone.
  const settled = (list: ChatTurn[]) => list.map((t) => (t.fresh ? { ...t, fresh: false } : t))

  // Starter prompts are derived from the read; a sent question clears them.
  const [suggestionsOverride, setSuggestionsOverride] = useState<string[] | null>(null)
  const suggestions = suggestionsOverride ?? (context ? coachStarterPrompts(context) : [])
  const [pending, setPending]       = useState(false)
  const [stackOpen, setStackOpen]   = useState(false)   // full read collapsed by default
  // On mobile the conversation is the screen and the read folds behind the
  // header, opening full-screen. Desktop keeps the split layout, where the read
  // is simply the left column.
  const [readOpen, setReadOpen]     = useState(false)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  const chatRef = useRef<HTMLDivElement | null>(null)
  const { away, measure, toBottom, toTurn } = useThreadScroll(chatRef)

  // The keyboard is up while the field has focus. The nav only gets in its way
  // there: it would sit between the composer and the keyboard.
  const [typing, setTyping] = useState(false)
  const blurTimer = useRef<number | undefined>(undefined)
  const onFocusChange = useCallback((on: boolean) => {
    window.clearTimeout(blurTimer.current)
    if (on) setTyping(true)
    // Debounced: focus hops between the field and the send button, and a flicker
    // of the nav in between would shift the layout under the finger.
    else blurTimer.current = window.setTimeout(() => setTyping(false), 120)
  }, [])
  useEffect(() => {
    document.body.classList.toggle('is-typing', typing)
    return () => document.body.classList.remove('is-typing')
  }, [typing])
  useEffect(() => () => window.clearTimeout(blurTimer.current), [])

  // Coach-proposed changes awaiting the athlete's confirmation, plus a key that
  // forces a re-pull of the read after an apply so the screen reflects the write.
  const [proposed, setProposed]   = useState<CoachAction[]>([])
  const [applying, setApplying]   = useState(false)
  const dismissedPlaceholderRpe = useRef(false)
  const placeholderRpeActions = view?.placeholderRpeActions

  useEffect(() => {
    if (pending || dismissedPlaceholderRpe.current || !placeholderRpeActions?.length) return
    setProposed((prev) => mergeCoachActions(prev, placeholderRpeActions))
  }, [placeholderRpeActions, pending])

  // Land the thread where reading starts (see useThreadScroll): your own
  // message and apply reports at the bottom, a long reply at its first line.
  useLayoutEffect(() => {
    const last = turns[turns.length - 1]
    if (!last) return
    if (last.role === 'coach' && !last.results) toTurn(last.id)
    else toBottom()
  }, [turns.length, toTurn, toBottom])

  // Typing dots arrive below the last message; keep them in view.
  useLayoutEffect(() => { if (pending) toBottom() }, [pending, toBottom])

  // The jump control tracks content too, not just scrolling.
  useEffect(() => {
    const id = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(id)
  }, [measure, turns.length, proposed.length, suggestions.length, pending])

  // The read is a full-screen layer on a phone: Escape closes it, and focus
  // follows it in and back out.
  useEffect(() => {
    if (!readOpen) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReadOpen(false) }
    document.addEventListener('keydown', onKey)
    const toggle = toggleRef.current
    return () => { document.removeEventListener('keydown', onKey); toggle?.focus() }
  }, [readOpen])

  const active = insights.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const p1read = active[0] ?? null         // the anchor read, always shown
  const rest   = active.slice(1)           // the rest of the stack, one tap away
  const statusCounts = countInsightsByStatus(insights)
  // The coach's presence: the same live reticle the desktop rail carries, read
  // off the whole stack. Only while the thread is empty — once you're talking,
  // the conversation is the screen.
  const conv = active.length ? computeLoopConvergence(insights, Date.now()) : null
  const insightLabel = useCallback(
    (id: string) => insights.find((i) => i.id === id)?.category,
    [insights],
  )

  // The pre-emptive opener — the system has already noticed something. Deterministic
  // (no model call) so the conversation feels alive the instant it loads.
  const p1 = context?.insights[0] ?? null
  const opener = !context
    ? `I can't load your read right now. Check your connection and I'll be here when it's back.`
    : p1
      ? `**${p1.category}** is what I'm watching closest right now (${Math.round(p1.confidence * 100)}% sure, ${p1.status}). Ask me why, or anything about your program.`
      : `Nothing tracked yet. Log a session and I'll have something to talk through. Until then, ask me how this works.`

  async function send(question: string) {
    const q = question.trim()
    if (!q || pending || !context) return
    setSuggestionsOverride([])
    setProposed([])   // a new question supersedes any un-applied proposal
    const history: CoachChatTurn[] = turns.map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...settled(prev), turn('athlete', q)])
    setPending(true)

    try {
      const res = await runCoachChat(context, history, q)
      setTurns((prev) => [...settled(prev), turn('coach', res.reply, { fresh: true })])
      setSuggestionsOverride(res.followups.length ? res.followups : [])
      const rpeFixes = dismissedPlaceholderRpe.current ? [] : (placeholderRpeActions ?? [])
      setProposed(mergeCoachActions(res.actions ?? [], rpeFixes))
    } catch {
      // runCoachChat answers failures itself; this is the floor under it, so a
      // surprise can never leave the composer waiting on a reply that won't come.
      setTurns((prev) => [...settled(prev), turn('coach', `Something went wrong on my end. Try that again in a moment.`, { fresh: true })])
    } finally {
      setPending(false)
    }
  }

  // Apply the coach's proposed changes — the only place the conversation writes,
  // and only on an explicit tap. Reports what landed, then re-pulls the read.
  const applyProposed = useCallback(async () => {
    if (!proposed.length || applying) return
    setApplying(true)
    let results: AppliedAction[]
    try {
      results = await applyCoachActions(athleteId, proposed)
    } catch {
      results = proposed.map((a) => ({ ok: false, label: describeCoachAction(a), error: 'failed' }))
    }
    const okCount = results.filter((r) => r.ok).length
    const summary = okCount === results.length
      ? `Done — applied ${okCount} change${okCount === 1 ? '' : 's'}.`
      : `Applied ${okCount} of ${results.length}. The rest didn't go through:`
    setTurns((prev) => [...settled(prev), turn('coach', summary, { fresh: true, results })])
    setProposed([])
    setApplying(false)
    // Applied actions rewrite insights and exercises — the read here and the
    // reticle, Today and Program around it.
    invalidateLoopViews()
    refetch()
  }, [proposed, applying, athleteId, refetch])

  const dismissProposed = useCallback(() => {
    dismissedPlaceholderRpe.current = true
    setProposed([])
  }, [])

  const titleBlock = (
    <span className="coach-read-toggle__title">
      <span className="eyebrow">The read</span>
      <span className="screen-title">Coach</span>
    </span>
  )

  return (
    <div className={`screen with-nav coach-screen${typing ? ' is-typing' : ''}`}>
      {/* The telemetry strip that used to sit here read "0 CONFIRMED · 2 LIKELY
          · 3 HYP" — jargon counts nobody acts on, above the conversation that
          is the point of the screen. The same statuses live inside the read. */}
      <div className="page page--split">
       <div className={`page__main coach-read-pane${readOpen ? ' is-open' : ''}`}>
        {/* Changes the coach parked for you (tracks_v1). Desktop stacks the
            full cards above the read; a phone gets a one-line banner (below the
            header) that opens them in a sheet. */}
        {isDesktop && <PendingProposals athleteId={athleteId} />}

        {/* The header. On mobile it's a one-line bar — title left, "the read"
            right — and the read folds behind it. On desktop it's just the title
            of the left column. */}
        {isDesktop ? (
          <div className="coach-read-toggle">{titleBlock}</div>
        ) : (
          <button
            ref={toggleRef}
            type="button"
            className="coach-read-toggle"
            onClick={() => setReadOpen(true)}
            aria-expanded={readOpen}
            aria-controls="coach-read"
          >
            {titleBlock}
            <span className="coach-read-toggle__hint">
              {active.length > 0 ? `The read · ${active.length}` : 'The read'}
              <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
            </span>
          </button>
        )}
        {!isDesktop && <ProposalsBanner athleteId={athleteId} />}

        <div
          id="coach-read"
          className={`coach-read${readOpen ? ' is-open' : ''}`}
          role={readOpen && !isDesktop ? 'dialog' : undefined}
          aria-modal={readOpen && !isDesktop ? true : undefined}
          aria-label="The read"
        >
        {/* Mobile only: the way out. A full-screen layer needs its own close
            control — without one it covers the page and everything that could
            dismiss it. */}
        <div className="coach-read__bar">
          <span className="coach-read__bar-title">The read</span>
          <button ref={closeRef} type="button" className="coach-read__close" onClick={() => setReadOpen(false)} aria-label="Close the read">
            <X size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* Headline moment — the freshest adaptation, grounded in real data. This
            is the "it changed because of what I did" beat a static program can't
            produce. */}
        {!loading && messages[0] && (() => {
          const m = messages[0]
          const toRecap = m.kind === 'weekly_review' && m.ref_id ? `/app/recap/${m.ref_id}` : null
          return (
            <div
              className="card fade-rise"
              style={{ marginBottom: 16, borderColor: 'var(--signal)', cursor: toRecap ? 'pointer' : undefined }}
              onClick={toRecap ? () => navigate(toRecap) : undefined}
            >
              <p className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
                {KIND_LABEL[m.kind] ?? 'UPDATE'} · {relativeTime(m.created_at)}
              </p>
              <Markdown text={m.body} style={{ fontSize: 15, lineHeight: 1.5 }} />
              {toRecap && (
                <p className="text-xs text-signal" style={{ marginTop: 8, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
                  View full recap ›
                </p>
              )}
            </div>
          )
        })()}

        {/* The read — demoted to a compact header. P1 (the anchor the
            conversation is about) stays visible; the rest of the stack is one
            tap away. Conversation leads below. */}
        <div className="fade-rise" style={{ marginBottom: 4 }}>
          {loading ? (
            <div className="card">
              <Skeleton height={10} width={80} /><div style={{ height: 8 }} />
              <Skeleton height={14} width="90%" /><div style={{ height: 4 }} />
              <Skeleton height={11} width="70%" />
            </div>
          ) : p1read ? (
            <>
              {statusCounts.length > 0 && (
                <div style={{ marginBottom: 10 }}><StatusCounts counts={statusCounts} /></div>
              )}
              <InsightCard insight={p1read} />
              {stackOpen && rest.map((ins) => <InsightCard key={ins.id} insight={ins} />)}
              {rest.length > 0 && (
                <button className="stack-toggle" onClick={() => setStackOpen((o) => !o)}>
                  {stackOpen ? 'Hide stack' : `Full stack · ${rest.length} more`}
                </button>
              )}
            </>
          ) : (
            <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
              Nothing tracked yet. Your first read appears after the probe; it sharpens as you train.
            </p>
          )}
        </div>

        {/* Coach log — the event feed (§4.5): weekly reviews, phase changes,
            retests. The freshest is in the headline above; the rest log here. */}
        {!loading && messages.length > 1 && (
          <div className="fade-rise fade-rise-delay-1" style={{ marginTop: 28, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
            <SectionHeader>Coach log</SectionHeader>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {messages.slice(1).map((m) => {
                const directive = m.ref_id ? directiveByRef[m.ref_id] : undefined
                const toRecap = m.kind === 'weekly_review' && m.ref_id ? `/app/recap/${m.ref_id}` : null
                return (
                  <div
                    key={m.id}
                    className="card"
                    style={{ cursor: toRecap ? 'pointer' : undefined }}
                    onClick={toRecap ? () => navigate(toRecap) : undefined}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                        <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', color: 'var(--text-dim)' }}>
                          {KIND_LABEL[m.kind] ?? m.kind.toUpperCase()}
                        </span>
                        {directive && (
                          <span className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>
                            {directive}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-dim num" style={{ flexShrink: 0 }}>{relativeTime(m.created_at)}</span>
                    </div>
                    <Markdown className="text-sm" text={m.body} style={{ lineHeight: 1.5 }} />
                  </div>
                )
              })}
            </div>
          </div>
        )}
        </div>{/* /coach-read */}
       </div>

        {/* Conversation — the warm layer. Right pane on desktop; on a phone the
            rest of the screen: ONE scrolling thread, the composer docked below. */}
        {/* No section header: it sat directly under the screen's own "Coach"
            title, and the input placeholder already says what this is for. */}
        {/* coach_v1: the server-side app coach. Off: the chat below, unchanged. */}
        {coachOn() ? <AppCoachPanel /> : (
          <div className="fade-rise fade-rise-delay-1 page__main coach-convo">
            <div className="coach-thread">
              <div
                ref={chatRef}
                className="coach-chat"
                onScroll={measure}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Conversation with your coach"
              >
                {conv && turns.length === 0 && (
                  <div className="coach-presence">
                    <ConvergenceReticle
                      confidence={conv.confidence}
                      axes={conv.axes}
                      context={conv.context}
                      size={132}
                    />
                  </div>
                )}
                {/* Pre-emptive opener. Speaker is read from alignment + fill, not a
                    label — one presence dot per screen lives in the telemetry strip. */}
                {(context || !loading) ? (
                  <div className="coach-msg coach-msg--coach fade-rise">
                    <Markdown className="coach-msg__body" text={opener} breaks />
                  </div>
                ) : (
                  /* First visit ever, still fetching: a bubble-shaped placeholder,
                     so the thread reads as loading rather than broken. */
                  <div className="coach-msg coach-msg--coach" aria-hidden="true">
                    <div className="coach-msg__body">
                      <Skeleton height={12} width={220} /><div style={{ height: 8 }} />
                      <Skeleton height={12} width={160} />
                    </div>
                  </div>
                )}

                {turns.map((t) => <CoachMessage key={t.id} turn={t} />)}

                {/* Generating — typing dots, the one waiting signal that reads as
                    "a reply is coming" rather than "this part hasn't loaded". */}
                {pending && (
                  <div className="coach-msg coach-msg--coach">
                    <TypingDots />
                  </div>
                )}

                {/* What the coach wants to change. It belongs to the reply above
                    it, so it follows it directly — before the chips — and nothing
                    is written until the athlete taps Apply. */}
                {!pending && proposed.length > 0 && (
                  <ProposedChangesCard
                    actions={proposed}
                    insightLabel={insightLabel}
                    applying={applying}
                    onApply={() => void applyProposed()}
                    onDismiss={dismissProposed}
                  />
                )}

                {/* Suggestion bubbles — grounded in the read; tap to ask */}
                {!pending && suggestions.length > 0 && (
                  <div className="coach-suggestions" role="group" aria-label="Suggested questions">
                    {suggestions.map((s) => (
                      <button key={s} type="button" className="coach-suggestion" onClick={() => void send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Once you've scrolled up to read, the thread stays put; this is
                  the way back to the latest — and says so when what's waiting
                  down there is a change to approve. */}
              {away && (
                <button type="button" className="coach-jump" onClick={toBottom} aria-label={proposed.length && !pending ? 'Jump to proposed changes' : 'Jump to latest'}>
                  {proposed.length > 0 && !pending && <span>Review changes</span>}
                  <ArrowDown size={18} strokeWidth={2.25} aria-hidden="true" />
                </button>
              )}
            </div>

            <CoachDock
              ready={!!context}
              busy={pending}
              placeholder={context ? 'Ask the coach…' : loading ? 'Loading your read…' : 'Offline — reconnect to ask'}
              onSend={(q) => void send(q)}
              onFocusChange={onFocusChange}
            />
          </div>
        )}
      </div>
    </div>
  )
}
