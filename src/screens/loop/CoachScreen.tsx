import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import {
  InsightCard, SectionHeader, Skeleton, StatusCounts, TelemetryStrip, TypeOn,
} from '../../components/ui'
import {
  countInsightsByStatus, gatherCoachContext, coachStarterPrompts, runCoachChat,
} from '../../engine'
import type { CoachContext, CoachChatTurn } from '../../engine/agentClient'
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

export function CoachScreen({ athleteId }: { athleteId: string }) {
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [loading, setLoading]   = useState(true)

  // Coach log — the event feed (weekly reviews etc.), newest-first.
  const [messages, setMessages] = useState<CoachMessageRow[]>([])
  const [directiveByRef, setDirectiveByRef] = useState<Record<string, string>>({})

  // ---- conversation state ----
  const [context, setContext]       = useState<CoachContext | null>(null)
  const [turns, setTurns]           = useState<ChatTurn[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [pending, setPending]       = useState(false)
  const [draft, setDraft]           = useState('')
  const [stackOpen, setStackOpen]   = useState(false)   // full read collapsed by default
  const threadEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const { data } = await supabase
        .from('insight')
        .select('*')
        .eq('athlete_id', athleteId)
        .order('priority')
      setInsights((data ?? []) as InsightRow[])
      setLoading(false)

      // The coach log — event memory, newest-first.
      const { data: msgs } = await supabase
        .from('coach_message')
        .select('*')
        .eq('athlete_id', athleteId)
        .order('created_at', { ascending: false })
        .limit(30)
      const msgRows = (msgs ?? []) as CoachMessageRow[]
      setMessages(msgRows)

      // Pull the directive for any weekly-review messages so the card can chip it.
      const reviewRefs = msgRows.filter((m) => m.kind === 'weekly_review' && m.ref_id).map((m) => m.ref_id as string)
      if (reviewRefs.length) {
        const { data: reviews } = await supabase
          .from('weekly_review')
          .select('id, next_week_prescription')
          .in('id', reviewRefs)
        const map: Record<string, string> = {}
        ;(reviews ?? []).forEach((r) => {
          const presc = (r as { next_week_prescription: WeeklyPrescription | null }).next_week_prescription
          if (presc?.directive) map[(r as { id: string }).id] = presc.directive
        })
        setDirectiveByRef(map)
      }

      // Gather the scoped read for the conversation (separate from the display
      // stack above — this is the trimmed slice the coach is allowed to see).
      const ctx = await gatherCoachContext(athleteId)
      setContext(ctx)
      setSuggestions(coachStarterPrompts(ctx))
    })()
  }, [athleteId])

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
    setSuggestions([])
    // Mark prior coach turns stale so only the new reply types on.
    const history: CoachChatTurn[] = turns.map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), { role: 'athlete', content: q }])
    setPending(true)

    const res = await runCoachChat(context, history, q)

    setTurns((prev) => [...prev, { role: 'coach', content: res.reply, fresh: true }])
    setSuggestions(res.followups.length ? res.followups : [])
    setPending(false)
  }

  return (
    <div className="screen with-nav">
      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div className="page page--split">
       <div className="page__main">
        <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
          The read
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>Coach</h2>

        {/* Headline moment — the freshest adaptation, grounded in real data. This
            is the "it changed because of what I did" beat a static program can't
            produce. */}
        {!loading && messages[0] && (
          <div className="card fade-rise" style={{ marginBottom: 16, borderColor: 'var(--signal)' }}>
            <p className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
              {KIND_LABEL[messages[0].kind] ?? 'UPDATE'} · {relativeTime(messages[0].created_at)}
            </p>
            <p style={{ fontSize: 15, lineHeight: 1.5 }}>{messages[0].body}</p>
          </div>
        )}

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
                return (
                  <div key={m.id} className="card">
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
                    <p className="text-sm" style={{ lineHeight: 1.5 }}>{m.body}</p>
                  </div>
                )
              })}
            </div>
          </div>
        )}
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
                <p className="coach-msg__body">{opener}</p>
              </div>
            )}

            {/* Thread */}
            {turns.map((t, i) =>
              t.role === 'athlete' ? (
                <div key={i} className="coach-msg coach-msg--athlete fade-rise">
                  <p className="coach-msg__body">{t.content}</p>
                </div>
              ) : (
                <div key={i} className="coach-msg coach-msg--coach fade-rise">
                  <p className="coach-msg__body">
                    {t.fresh ? <TypeOn text={t.content} delay={16} /> : t.content}
                  </p>
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
            Read-only. Noticed something? Log it in your next session — that's where it counts.
          </p>
        </div>
      </div>
    </div>
  )
}
