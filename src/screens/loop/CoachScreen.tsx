import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { invalidateLoopViews } from '../../lib/loopCache'
import {
  InsightCard, Markdown, SectionHeader, Skeleton, StatusCounts, TelemetryStrip,
} from '../../components/ui'
import {
  countInsightsByStatus, gatherCoachContext, coachStarterPrompts, runCoachChat,
  applyCoachActions, describeCoachAction,
} from '../../engine'
import type { CoachContext, CoachChatTurn, CoachAction } from '../../engine/agentClient'
import type { InsightRow, CoachMessageRow, WeeklyPrescription } from '../../types/database'

/**
 * COACH — the intelligence, and now the conversation. The top half is the cold
 * instrument: the read, the status counts, the weak-link stack. The bottom half
 * is the warm layer (Agent #8, Jarvis Doctrine) — a STRICTLY READ-ONLY chat that
 * can see a scoped slice of the athlete and answer "why". It writes nothing; when
 * the athlete reports something new it routes them to the session log, the only
 * place a signal becomes evidence.
 */

interface ChatTurn {
  role: 'athlete' | 'coach'
  content: string
  fresh?: boolean          // true for the just-arrived coach reply → type-on it
}

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
}

export async function fetchCoachView(athleteId: string): Promise<CoachView> {
  // The read and the event feed are independent — issue them together.
  const [insightRes, msgRes] = await Promise.all([
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
    supabase
      .from('coach_message')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(30),
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

  return { insights, messages, directiveByRef, context }
}

export function CoachScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()

  // Offline-first: paints from the held view on the first frame, revalidates
  // behind it. `loading` is true only on the very first visit ever.
  const { data: view, loading, refetch } = useCachedLoader(
    `coach:${athleteId}`,
    () => fetchCoachView(athleteId),
  )
  const insights = view?.insights ?? []
  const messages = view?.messages ?? []
  const directiveByRef = view?.directiveByRef ?? {}
  const context = view?.context ?? null

  // ---- conversation state ----
  const [turns, setTurns]           = useState<ChatTurn[]>([])
  // Starter prompts are derived from the read; a sent question clears them.
  const [suggestionsOverride, setSuggestionsOverride] = useState<string[] | null>(null)
  const suggestions = suggestionsOverride ?? (context ? coachStarterPrompts(context) : [])
  const [pending, setPending]       = useState(false)
  const [draft, setDraft]           = useState('')
  const [stackOpen, setStackOpen]   = useState(false)   // full read collapsed by default
  // On mobile the conversation is the screen; the read instrument folds into a
  // header so chat isn't stranded at the bottom of a long page. Desktop keeps
  // the split layout, so the read starts open there.
  const [readOpen, setReadOpen]     = useState(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1000)
  const threadEndRef = useRef<HTMLDivElement | null>(null)

  // Coach-proposed changes awaiting the athlete's confirmation, plus a key that
  // forces a re-pull of the read after an apply so the screen reflects the write.
  const [proposed, setProposed]   = useState<CoachAction[]>([])
  const [applying, setApplying]   = useState(false)

  // Keep the latest turn in view as the thread grows.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, pending])

  const active = insights.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const p1read = active[0] ?? null         // the anchor read, always shown
  const rest   = active.slice(1)           // the rest of the stack, one tap away
  const statusCounts = countInsightsByStatus(insights)
  const lastSignalAt = insights.reduce<string | null>((max, i) =>
    !max || i.updated_at > max ? i.updated_at : max, null)

  const countBy = (s: string) => insights.filter((i) => i.status === s).length
  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: String(countBy('confirmed')), value: 'CONFIRMED' },
    { label: String(countBy('likely')), value: 'LIKELY' },
    { label: String(countBy('hypothesis')), value: 'HYP' },
  ]

  // The pre-emptive opener — the system has already noticed something. Deterministic
  // (no model call) so the conversation feels alive the instant it loads.
  const p1 = context?.insights[0] ?? null
  const opener = p1
    ? `I'm tracking ${context!.insights.length} read${context!.insights.length === 1 ? '' : 's'} on you. Your ${p1.category.toLowerCase()} is the one I'm watching closest — ${Math.round(p1.confidence * 100)}%, ${p1.status}. Ask me why, or anything about the program.`
    : `Nothing tracked yet. Log a session and I'll have a read to talk through. Until then, ask me how this works.`

  async function send(question: string) {
    const q = question.trim()
    if (!q || pending || !context) return
    setDraft('')
    setSuggestionsOverride([])
    setProposed([])   // a new question supersedes any un-applied proposal
    // Mark prior coach turns stale so only the new reply types on.
    const history: CoachChatTurn[] = turns.map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), { role: 'athlete', content: q }])
    setPending(true)

    const res = await runCoachChat(context, history, q)

    setTurns((prev) => [...prev, { role: 'coach', content: res.reply, fresh: true }])
    setSuggestionsOverride(res.followups.length ? res.followups : [])
    setProposed(res.actions ?? [])
    setPending(false)
  }

  // Apply the coach's proposed changes — the only place the conversation writes,
  // and only on an explicit tap. Reports what landed, then re-pulls the read.
  async function applyProposed() {
    if (!proposed.length || applying) return
    setApplying(true)
    const results = await applyCoachActions(athleteId, proposed)
    const okCount = results.filter((r) => r.ok).length
    const fails = results.filter((r) => !r.ok)
    const summary = fails.length === 0
      ? `Done — applied ${okCount} change${okCount === 1 ? '' : 's'}.`
      : `Applied ${okCount}/${results.length}. Couldn't apply: ${fails.map((f) => `${f.label} (${f.error ?? 'failed'})`).join('; ')}`
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), { role: 'coach', content: summary, fresh: true }])
    setProposed([])
    setApplying(false)
    // Applied actions rewrite insights and exercises — the read here and the
    // reticle, Today and Program around it.
    invalidateLoopViews()
    refetch()
  }

  return (
    <div className="screen with-nav coach-screen">
      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div className="page page--split">
       <div className="page__main coach-read-pane">
        {/* On mobile the read folds behind this header so the conversation owns
            the screen; tap to expand the instrument. On desktop it's the left
            column and always shown (the toggle is hidden). */}
        <button
          type="button"
          className="coach-read-toggle"
          onClick={() => setReadOpen((o) => !o)}
          aria-expanded={readOpen}
        >
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
            <span className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
              The read
            </span>
            <span style={{ fontSize: 22, fontWeight: 600 }}>Coach</span>
          </span>
          <span className="coach-read-toggle__hint text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
            {readOpen ? 'Hide ⌄' : `${active.length} read${active.length === 1 ? '' : 's'} ›`}
          </span>
        </button>

        <div className={`coach-read${readOpen ? ' is-open' : ''}`}>
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
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', color: 'var(--text-dim)' }}>
                          {KIND_LABEL[m.kind] ?? m.kind.toUpperCase()}
                        </span>
                        {directive && (
                          <span className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>
                            {directive}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-dim num">{relativeTime(m.created_at)}</span>
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

        {/* Conversation — the warm layer. Right pane on desktop, stacked below
            the read on mobile (with a separator). Read-only: narrate and route. */}
        <div className="fade-rise fade-rise-delay-1 page__main coach-convo">
          <SectionHeader>Ask why</SectionHeader>

          <div className="coach-chat" style={{ marginTop: 12 }}>
            {/* Pre-emptive opener. Speaker is read from alignment + fill, not a
                label — one presence dot per screen lives in the telemetry strip. */}
            {context && (
              <div className="coach-msg coach-msg--coach fade-rise">
                <Markdown className="coach-msg__body" text={opener} />
              </div>
            )}

            {/* Thread */}
            {turns.map((t, i) =>
              t.role === 'athlete' ? (
                <div key={i} className="coach-msg coach-msg--athlete fade-rise">
                  <p className="coach-msg__body">{t.content}</p>
                </div>
              ) : (
                <div key={i} className={`coach-msg coach-msg--coach fade-rise${t.fresh ? ' coach-msg--fresh' : ''}`}>
                  <Markdown className="coach-msg__body" text={t.content} />
                </div>
              ),
            )}

            {/* Generating — thinking shimmer, the real-computation signal */}
            {pending && (
              <div className="coach-msg coach-msg--coach">
                <div className="coach-msg__thinking thinking-shimmer" />
              </div>
            )}

            <div ref={threadEndRef} />

            {/* Suggestion bubbles — grounded in the read; tap to ask */}
            {!pending && suggestions.length > 0 && (
              <div className="coach-suggestions">
                {suggestions.map((s, i) => (
                  <button key={i} className="coach-suggestion" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Proposed changes — the coach can write, but only behind this gate.
                Nothing is persisted until the athlete taps Apply. */}
            {!pending && proposed.length > 0 && (
              <div className="card fade-rise" style={{ marginTop: 12, borderColor: 'var(--signal)' }}>
                <p className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                  Proposed changes · confirm to apply
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                  {proposed.map((a, i) => (
                    <div key={i}>
                      <p className="text-sm" style={{ lineHeight: 1.4 }}>{describeCoachAction(a)}</p>
                      {a.rationale && (
                        <p className="text-xs text-dim" style={{ lineHeight: 1.4, marginTop: 2 }}>{a.rationale}</p>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => void applyProposed()} disabled={applying}>
                    {applying ? 'Applying…' : 'Apply'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setProposed([])}
                    disabled={applying}
                    style={{ background: 'transparent', color: 'var(--text-dim)' }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <form
            className="coach-input"
            onSubmit={(e) => { e.preventDefault(); void send(draft) }}
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={context ? 'Ask about your read, the program, the why…' : 'Loading your read…'}
              disabled={!context || pending}
              aria-label="Ask the coach"
            />
            <button type="submit" disabled={!context || pending || !draft.trim()}>Ask</button>
          </form>

          <p className="text-xs text-dim" style={{ marginTop: 8, lineHeight: 1.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
            The coach can propose changes — you approve each before anything is written. Noticed something mid-session? Still log it next session; that's where it counts as evidence.
          </p>
        </div>
      </div>
    </div>
  )
}
