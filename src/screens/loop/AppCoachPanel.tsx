import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Banner, Button, ChatComposer, Markdown, TypingDots } from '../../components/ui'
import { approvePreview, fetchCoachState, sendCoachMessage, type ChatMessage, type CoachState } from '../../lib/coachV1'
import { invalidateLoopViews } from '../../lib/loopCache'
import { useThreadScroll } from './CoachThread'

/**
 * The app coach's conversation (coach_v1). The Worker keeps the chat and runs
 * the coach as app_coach through the same tools as any coach; it can only
 * read, preview and log. A change it previews waits for the athlete: Approve
 * (a tap) or a "yes" reply to it (a chat approval citing that message).
 */
export function AppCoachPanel() {
  const navigate = useNavigate()
  const [state, setState] = useState<CoachState | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState<string[]>([])
  const chatRef = useRef<HTMLDivElement | null>(null)
  const { toBottom } = useThreadScroll(chatRef)

  useEffect(() => {
    void fetchCoachState().then((s) => { setState(s); setChat(s?.chat ?? []) })
  }, [])
  // Scrolls the thread's own box, never the page: scrollIntoView walks every
  // scrollable ancestor, including the one this screen is locked inside.
  useEffect(() => { toBottom() }, [chat, pending, toBottom])

  async function send(text: string, approves?: string) {
    const q = text.trim()
    if (!q || pending) return
    setDraft('')
    setPending(true)
    const r = await sendCoachMessage(q, approves)
    const mine: ChatMessage = { id: r.message_id ?? `local-${Date.now()}`, role: 'athlete', body: q, created_at: new Date().toISOString() }
    setChat((prev) => [...prev, mine, ...(r.reply ? [r.reply] : [{ id: `err-${Date.now()}`, role: 'coach' as const, body: r.text ?? 'Something went wrong.', created_at: new Date().toISOString() }])])
    if (approves) setOpen((prev) => prev.filter((p) => p !== approves))
    if (r.previews?.length) setOpen((prev) => [...new Set([...prev, ...r.previews!])])
    if (r.approval?.applied) invalidateLoopViews()
    setPending(false)
  }

  async function tap(previewId: string) {
    setPending(true)
    const r = await approvePreview(previewId)
    setChat((prev) => [...prev, { id: `tap-${Date.now()}`, role: 'coach', body: r.text, created_at: new Date().toISOString() }])
    setOpen((prev) => prev.filter((p) => p !== previewId))
    if (r.applied) invalidateLoopViews()
    setPending(false)
  }

  return (
    <div className="fade-rise fade-rise-delay-1 page__main coach-convo">
      {state && !state.block && (
        <Banner title="Build your block" sub="Goals, sports, schedule and history: about 3 minutes." onClick={() => navigate('/app/coach/intake')} />
      )}
      {state?.block && state.recompose && (
        <Banner title="Time to re-compose" sub={state.recompose === 'block_boundary' ? 'Your block ended.' : 'An activity or goal changed.'} onClick={() => void send('Re-compose my block.')} />
      )}
      <div className="coach-thread">
      <div className="coach-chat" ref={chatRef}>
        {chat.length === 0 && (
          <div className="coach-msg coach-msg--coach fade-rise">
            <Markdown className="coach-msg__body" breaks text="Ask me about your week, your goals, or how something felt. I propose; you approve; the engine does the math." />
          </div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`coach-msg coach-msg--${m.role === 'athlete' ? 'athlete' : 'coach'} fade-rise`}>
            {m.role === 'athlete' ? <p className="coach-msg__body">{m.body}</p> : <Markdown className="coach-msg__body" text={m.body} breaks />}
          </div>
        ))}
        {pending && <div className="coach-msg coach-msg--coach"><TypingDots /></div>}
        {!pending && open.map((id) => (
          <div key={id} className="card fade-rise" style={{ marginTop: 12, borderColor: 'var(--signal)' }}>
            <p className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              Proposed change · waiting on you
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="primary" onClick={() => void tap(id)} style={{ flex: 2 }}>Approve</Button>
              <Button variant="outline" onClick={() => void send('Yes, apply it.', id)} style={{ flex: 1 }}>Reply yes</Button>
              <Button variant="ghost" onClick={() => setOpen((prev) => prev.filter((p) => p !== id))} style={{ flex: 1 }}>Not now</Button>
            </div>
          </div>
        ))}
      </div>
      </div>
      <div className="coach-dock">
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void send(draft)}
          placeholder="Ask your coach…"
          sendDisabled={pending}
          ariaLabel="Ask the coach"
          sendLabel="Ask"
        />
        <p className="coach-foot text-xs text-dim" style={{ marginTop: 10, lineHeight: 1.5 }}>
          Nothing is written until you approve it. The coach doesn't give medical, supplement or diet advice.
        </p>
      </div>
    </div>
  )
}
