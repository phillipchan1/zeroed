import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, Clock, Undo2, X } from 'lucide-react'
import { useCachedLoader } from '../../lib/cache'
import { invalidateLoopViews } from '../../lib/loopCache'
import { getWeightUnit } from '../../lib/units'
import {
  gatherProgramEditState, runProgramEditChat, applyEditsToDraft, diffDraft,
  estimateSessionMinutes, applyProgramDraft, nextMondayISO,
  type ProgramDraft, type ProgramEditState, type DraftDiff,
  type SessionDiff, type ExerciseChange, type ApplyTiming,
} from '../../engine'
import type { ProgramEditTurn } from '../../engine/agentClient'
import { Button, Markdown, SectionHeader, Skeleton, Chip } from '../../components/ui'

/**
 * CHANGE THE PROGRAM — the steering wheel.
 *
 * The old escape hatch was a textarea buried in the Program screen's Sessions
 * accordion that fired one shot at a full-week regeneration: you got a diff of
 * six additions and five deletions you never asked for, no way to answer back,
 * and no sense of whether you'd changed this week or the whole block. This
 * screen is the other shape.
 *
 *   - It's a CONVERSATION. Every message edits the same working draft, so the
 *     fourth message refines the third instead of re-rolling the program.
 *   - It's VISUAL. The week sits next to the thread and marks itself up live:
 *     what's added, dropped, retuned, and what each session now costs in
 *     minutes — the number that answers "I finished in 25 and had gas left".
 *   - It's PERMISSIVE. Additive by default: nothing is removed unless it was
 *     asked for, and adding a whole session, a HIIT day, or an hour of work is
 *     a normal outcome rather than something the guardrails talk you out of.
 *
 * Nothing is written until Apply. Until then this is all in memory, and every
 * turn can be undone one at a time.
 */

// A staged turn's effect on the draft. Kept as a stack so "undo the last thing
// you did" is a pop, not a re-generation.
interface Stage {
  draft: ProgramDraft
  labels: string[]
  notes: string[]
  /** The athlete's own words that produced this stage — kept as a standing steer. */
  request: string
}

interface Turn {
  role: 'athlete' | 'coach'
  content: string
  fresh?: boolean
  /** Per-turn diff counts, so each reply carries its own receipt. */
  effect?: { added: number; removed: number; changed: number; sessions: number }
  /** Edits the deterministic layer refused, with why — never silent. */
  skipped?: string[]
}

const CHANGE_TONE: Record<ExerciseChange['kind'], string> = {
  added:   'var(--confirmed)',
  removed: 'var(--veto)',
  changed: 'var(--computing)',
  kept:    'var(--text-dim)',
}
const CHANGE_MARK: Record<ExerciseChange['kind'], string> = {
  added: '+', removed: '−', changed: '~', kept: '·',
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Deterministic openers — the things this athlete is most likely to want and
// least likely to discover. No model call, so they're there on the first frame.
const STARTERS = [
  'Add basketball explosiveness',
  'Add a short HIIT day',
  'More hypertrophy volume',
  'My sessions are too short',
]

export function ProgramEditScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()

  const { data: state, loading, refetch } = useCachedLoader<ProgramEditState | null>(
    `programedit:${athleteId}`,
    () => gatherProgramEditState(athleteId, getWeightUnit()),
  )

  const [stages, setStages]   = useState<Stage[]>([])
  const [turns, setTurns]     = useState<Turn[]>([])
  const [draftText, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [applying, setApplying] = useState(false)
  // Apply no longer writes. It opens the confirm screen, which is where the
  // question that actually matters gets asked: does this start now, or Monday?
  const [confirming, setConfirming] = useState(false)
  const [followups, setFollowups] = useState<string[] | null>(null)
  const [boardOpen, setBoardOpen] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1000)

  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const base = state?.base ?? null
  const working = stages.length ? stages[stages.length - 1].draft : base
  const diff: DraftDiff | null = base && working ? diffDraft(base, working) : null
  const stagedLabels = stages.flatMap((s) => s.labels)
  const stagedNotes  = stages.flatMap((s) => s.notes)
  // What the athlete actually asked for, in their words — stored on Apply so the
  // next phase is designed with it instead of quietly reverting to the template.
  const stagedRequests = stages.map((s) => s.request)

  // Minutes per session BEFORE the edits, so a card can show 24 → 38 min.
  const baseMinutes = useMemo(() => {
    const m = new Map<string, number>()
    base?.sessions.forEach((s) => m.set(s.name.trim().toLowerCase(), estimateSessionMinutes(s.exercises)))
    return m
  }, [base])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, pending])

  // The week marking itself up IS the answer on a phone, where the board starts
  // folded. Open it the moment a change lands — but only on the way up, so
  // collapsing it by hand sticks until the next change.
  const stageCountRef = useRef(0)
  useEffect(() => {
    if (stages.length > stageCountRef.current) setBoardOpen(true)
    stageCountRef.current = stages.length
  }, [stages.length])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draftText])

  async function send(message: string) {
    const q = message.trim()
    if (!q || pending || !state || !working) return
    setDraft('')
    setFollowups([])
    const history: ProgramEditTurn[] = turns.map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), { role: 'athlete', content: q }])
    setPending(true)

    const res = await runProgramEditChat(state.context, working, stagedLabels, history, q)

    // The model proposes; this applies the edits in memory and reports exactly
    // what landed. The board below is rendered from the RESULT, not the intent.
    const { draft: nextDraft, outcomes, notes } = applyEditsToDraft(working, res.edits)
    const applied = outcomes.filter((o) => o.applied)
    const skipped = outcomes.filter((o) => !o.applied).map((o) => `${o.label} — ${o.reason ?? 'skipped'}`)

    if (applied.length) {
      // The receipt is this TURN's delta (draft → draft), not the running total.
      const turnDiff = diffDraft(working, nextDraft)
      setStages((prev) => [...prev, {
        draft: nextDraft,
        labels: applied.map((o) => o.label),
        notes,
        request: q,
      }])
      setTurns((prev) => [...prev, {
        role: 'coach',
        content: res.reply,
        fresh: true,
        effect: {
          added: turnDiff.added, removed: turnDiff.removed, changed: turnDiff.changed,
          sessions: turnDiff.newSessions,
        },
        skipped: skipped.length ? skipped : undefined,
      }])
    } else {
      setTurns((prev) => [...prev, {
        role: 'coach', content: res.reply, fresh: true,
        skipped: skipped.length ? skipped : undefined,
      }])
    }
    setFollowups(res.followups.slice(0, 3))
    setPending(false)
  }

  function undoLast() {
    if (!stages.length || applying || pending) return
    setStages((prev) => prev.slice(0, -1))
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), {
      role: 'coach', content: 'Rolled that one back. The rest of your staged changes are still here.', fresh: true,
    }])
  }

  function discardAll() {
    if (!stages.length || applying || pending) return
    setStages([])
    setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), {
      role: 'coach', content: 'Cleared. Your program is exactly as it was.', fresh: true,
    }])
  }

  async function apply(timing: ApplyTiming) {
    if (!state || !working || !diff?.dirty || applying) return
    setApplying(true)
    const res = await applyProgramDraft(athleteId, state, working, stagedNotes, stagedRequests, timing)
    if (res.ok) {
      setStages([])
      setConfirming(false)
      setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), {
        role: 'coach',
        content: res.scheduled
          ? `**Scheduled.** This week stays exactly as it is — everything you've already logged is untouched. Your reshaped ${state.phaseName} week goes live Monday.`
          : `**Applied.** Your ${state.phaseName} week is updated — it's live on Train now, and it stays this way for the rest of the block.`,
        fresh: true,
      }])
      invalidateLoopViews()
      refetch()
    } else {
      setConfirming(false)
      setTurns((prev) => [...prev.map((t) => ({ ...t, fresh: false })), {
        role: 'coach',
        content: `Couldn't save all of that: ${res.errors.join('; ') || 'the write failed'}. Nothing else changed — try Apply again.`,
        fresh: true,
      }])
    }
    setApplying(false)
  }

  const scopeLine = state
    ? `Edits the repeating week for the rest of your ${state.phaseName} block${
        state.weeksRemaining != null ? ` (~${state.weeksRemaining} week${state.weeksRemaining === 1 ? '' : 's'} left)` : ''
      } — not just this week.`
    : ''

  const suggestions = followups && followups.length ? followups : followups === null ? STARTERS : []

  return (
    <div className="screen with-nav coach-screen">
      <div className="page page--split">
        {/* ---- The week, marked up live. Left column on desktop; a header that
             expands on a phone, so the conversation owns the screen. ---- */}
        <div className="page__main coach-read-pane">
          <button
            type="button"
            className="coach-read-toggle"
            onClick={() => setBoardOpen((o) => !o)}
            aria-expanded={boardOpen}
          >
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left' }}>
              <span className="eyebrow">Change the program</span>
              <span className="screen-title">Your week</span>
            </span>
            <span className="coach-read-toggle__hint text-xs" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
              {boardOpen ? 'Hide ⌄' : diff?.dirty ? (
                <span className="text-signal">
                  {diff.added > 0 && `+${diff.added} `}
                  {diff.removed > 0 && `−${diff.removed} `}
                  {diff.changed > 0 && `~${diff.changed}`} ›
                </span>
              ) : (
                <span className="text-dim">{working?.sessions.length ?? 0} sessions ›</span>
              )}
            </span>
          </button>

          <div className={`coach-read${boardOpen ? ' is-open' : ''}`}>
            {loading ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skeleton height={12} width={120} /><Skeleton height={28} width="100%" /><Skeleton height={20} width="70%" />
              </div>
            ) : !state || !working || !diff ? (
              <div className="card">
                <p className="text-base text-dim">
                  No active program to edit yet. Finish onboarding and your first block builds here.
                </p>
              </div>
            ) : (
              <>
                <WeekSummary state={state} draft={working} diff={diff} scopeLine={scopeLine} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                  {diff.sessions.map((s, i) => (
                    <SessionCard
                      key={`${s.name}-${i}`}
                      diff={s}
                      // With nothing staged yet, the week IS the content — show it
                      // open. Once changes exist, untouched sessions fold away so
                      // the marked-up ones own the board.
                      openByDefault={!diff.dirty}
                      minutesAfter={estimateSessionMinutes(working.sessions[i]?.exercises ?? [])}
                      minutesBefore={baseMinutes.get((s.previousName ?? s.name).trim().toLowerCase()) ?? null}
                      sessionType={working.sessions[i]?.sessionType ?? null}
                      dow={working.sessions[i]?.intendedDow ?? null}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---- The conversation ---- */}
        <div className="page__main coach-convo">
          <div className="coach-chat" style={{ marginTop: 12 }}>
            {state && (
              <div className="coach-msg coach-msg--coach fade-rise">
                <Markdown
                  className="coach-msg__body"
                  text={`This is your program to change. Tell me what you want more of — **explosiveness, conditioning, size, prehab, or just more work** — and I'll add it. I won't drop anything you didn't ask me to drop.`}
                />
              </div>
            )}

            {turns.map((t, i) =>
              t.role === 'athlete' ? (
                <div key={i} className="coach-msg coach-msg--athlete fade-rise">
                  <p className="coach-msg__body">{t.content}</p>
                </div>
              ) : (
                <div key={i} className={`coach-msg coach-msg--coach fade-rise${t.fresh ? ' coach-msg--fresh' : ''}`}>
                  <Markdown className="coach-msg__body" text={t.content} />
                  {t.effect && (
                    <div className="edit-receipt">
                      {t.effect.sessions > 0 && <span style={{ color: 'var(--confirmed)' }}>{t.effect.sessions} new session{t.effect.sessions === 1 ? '' : 's'}</span>}
                      {t.effect.added > 0 && <span style={{ color: 'var(--confirmed)' }}>+{t.effect.added} added</span>}
                      {t.effect.removed > 0 && <span style={{ color: 'var(--veto)' }}>−{t.effect.removed} dropped</span>}
                      {t.effect.changed > 0 && <span style={{ color: 'var(--computing)' }}>~{t.effect.changed} retuned</span>}
                    </div>
                  )}
                  {t.skipped?.map((s, k) => (
                    <p key={k} className="text-xs text-dim" style={{ marginTop: 6, lineHeight: 1.45 }}>
                      Couldn't stage: {s}
                    </p>
                  ))}
                </div>
              ),
            )}

            {pending && (
              <div className="coach-msg coach-msg--coach">
                <div className="coach-msg__thinking thinking-shimmer" />
              </div>
            )}

            <div ref={threadEndRef} />

            {!pending && state && suggestions.length > 0 && (
              <div className="coach-suggestions">
                {suggestions.map((s, i) => (
                  <button key={i} className="coach-suggestion" onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            )}
          </div>

          {/* Staged changes — the gate. Everything above is memory until this. */}
          {diff?.dirty && (
            <div className="card fade-rise edit-apply" style={{ borderColor: 'var(--signal)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                <p className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {stagedLabels.length} staged change{stagedLabels.length === 1 ? '' : 's'}
                </p>
                <span className="num text-xs text-dim">
                  ~{diff.minutesBefore} → {diff.minutesAfter} min/week
                </span>
              </div>

              {diff.mainLiftsDropped.length > 0 && (
                <p className="text-sm" style={{ color: 'var(--veto)', lineHeight: 1.45, marginBottom: 8, display: 'flex', gap: 8 }}>
                  <AlertTriangle size={15} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>This drops {diff.mainLiftsDropped.join(', ')} from your week. Say "keep {diff.mainLiftsDropped[0]}" if that wasn't the idea.</span>
                </p>
              )}
              {diff.longSessions.length > 0 && (
                <p className="text-sm text-dim" style={{ lineHeight: 1.45, marginBottom: 8, display: 'flex', gap: 8 }}>
                  <Clock size={15} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    {diff.longSessions.map((s) => `${s.name} ≈ ${s.minutes} min`).join(' · ')} — long, but it's your call.
                  </span>
                </p>
              )}
              {diff.sessionsPerWeekAfter !== diff.sessionsPerWeekBefore && (
                <p className="text-sm text-dim" style={{ lineHeight: 1.45, marginBottom: 8 }}>
                  Training days: <span className="num">{diff.sessionsPerWeekBefore}</span> →{' '}
                  <span className="num text-signal">{diff.sessionsPerWeekAfter}</span> a week, so the week counts
                  the new session instead of marking you short.
                </p>
              )}

              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {stagedLabels.map((l, i) => (
                  <li key={i} className="text-sm" style={{ lineHeight: 1.4, color: 'var(--text-dim)' }}>· {l}</li>
                ))}
              </ul>

              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={() => setConfirming(true)} disabled={applying || pending} style={{ flex: 2 }}>
                  Review &amp; apply
                </Button>
                <Button variant="ghost" onClick={undoLast} disabled={applying || pending} style={{ flex: 1 }}>
                  <Undo2 size={15} strokeWidth={1.75} style={{ marginRight: 6 }} />Undo
                </Button>
              </div>
              <button
                type="button"
                className="edit-discard"
                onClick={discardAll}
                disabled={applying || pending}
              >
                Discard all staged changes
              </button>
            </div>
          )}

          <form className="coach-input" onSubmit={(e) => { e.preventDefault(); void send(draftText) }}>
            <textarea
              ref={inputRef}
              rows={1}
              value={draftText}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draftText) }
              }}
              placeholder={state ? 'Add jumps, a HIIT day, more volume…' : 'Loading your program…'}
              disabled={!state || pending}
              aria-label="Tell the coach what to change"
            />
            <button type="submit" disabled={!state || pending || !draftText.trim()}>Send</button>
          </form>

          <p className="text-xs text-dim" style={{ marginTop: 10, lineHeight: 1.5 }}>
            Nothing is saved until you tap Apply. {state && `Back to `}
            {state && (
              <button type="button" className="link-inline" onClick={() => navigate('/app/program')}>the program</button>
            )}
          </p>
        </div>
      </div>

      {confirming && state && working && diff?.dirty && (
        <ApplyConfirm
          state={state}
          diff={diff}
          applying={applying}
          onCancel={() => setConfirming(false)}
          onConfirm={(timing) => void apply(timing)}
        />
      )}
    </div>
  )
}

// ---- The confirm screen ----------------------------------------------------

const DAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Mon=0 … Sun=6, the order the strip is drawn in. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * WHEN DOES THIS START — the question the editor used to answer for you.
 *
 * Applying wrote routine rows in place the instant you tapped it, with one
 * sentence of scope buried on the board behind the thread. On a Friday with four
 * sessions already logged that is the wrong default and the wrong altitude: the
 * athlete is mid-week, the change lands on a week they've nearly finished, and
 * nothing on screen says so.
 *
 * So it gets the whole screen, and it leads with the week itself — seven days,
 * what's already done, and where the change actually lands under each option.
 * The diff is still here, below, because "what changes" and "when" are one
 * decision. Nothing has been written when this opens.
 */
function ApplyConfirm({
  state, diff, applying, onConfirm, onCancel,
}: {
  state: ProgramEditState
  diff: DraftDiff
  applying: boolean
  onConfirm: (timing: ApplyTiming) => void
  onCancel: () => void
}) {
  const logged = state.loggedThisWeek
  // Default to the safe answer. Mid-week with work already logged, "now" changes
  // a week the athlete has largely spent — so the burden of the extra tap goes on
  // the disruptive option, not the careful one.
  const [timing, setTiming] = useState<ApplyTiming>(logged.length > 0 ? 'next_week' : 'now')

  const today = new Date()
  const todayIdx = mondayIndex(today)
  const monday = nextMondayISO()

  // Which days already carry a logged session, and what was trained on them.
  const loggedByDay = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const s of logged) {
      const i = mondayIndex(new Date(s.performedAt))
      m.set(i, [...(m.get(i) ?? []), s.sessionName])
    }
    return m
  }, [logged])

  // The block ends before the deferral would land, so there is nothing to defer
  // into — the phase boundary will design the next block regardless.
  const blockEndsFirst = state.phase.weekEnd < monday

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !applying) onCancel() }
    document.addEventListener('keydown', onKey)
    const root = document.getElementById('root')
    const prevBody = document.body.style.overflow
    const prevRoot = root?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (root) root.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevBody
      if (root) root.style.overflow = prevRoot
    }
  }, [applying, onCancel])

  const changedSessions = diff.sessions.filter((s) => s.isNew || s.added > 0 || s.removed > 0 || s.changed > 0)

  return (
    <div className="apply-confirm" role="dialog" aria-modal="true" aria-label="When should this change start">
      <div className="apply-confirm__bar">
        <button type="button" className="sheet-close" onClick={onCancel} disabled={applying} aria-label="Back to editing">
          <X size={20} strokeWidth={2} />
        </button>
        <span className="eyebrow">Nothing saved yet</span>
      </div>

      <div className="apply-confirm__body">
        <h1 className="screen-title" style={{ marginBottom: 6 }}>When should this start?</h1>
        <p className="text-sm text-dim" style={{ lineHeight: 1.55, marginBottom: 22 }}>
          {logged.length > 0 ? (
            <>
              You've logged <span className="num text-signal">{logged.length}</span>{' '}
              session{logged.length === 1 ? '' : 's'} this week. Starting now changes the week you're
              already most of the way through.
            </>
          ) : (
            <>Nothing logged this week yet, so either option leaves your history untouched.</>
          )}
        </p>

        <TimingOption
          selected={timing === 'now'}
          onSelect={() => setTiming('now')}
          title="Start now"
          meta="Live on Train immediately"
          disabled={applying}
        >
          <WeekStrip
            todayIdx={todayIdx}
            loggedByDay={loggedByDay}
            changeFromIdx={todayIdx}
            label="This week"
          />
          <p className="apply-note">
            {logged.length > 0 ? (
              <>
                Your <span className="num">{logged.length}</span> logged session
                {logged.length === 1 ? '' : 's'} keep their own record — what you did is stored with
                the session, not read back off the program. The new week applies from your next one.
              </>
            ) : (
              <>The reshaped week applies from your next session.</>
            )}
          </p>
        </TimingOption>

        <TimingOption
          selected={timing === 'next_week'}
          onSelect={() => setTiming('next_week')}
          title={`Start Monday · ${formatDay(monday)}`}
          meta="This week finishes as planned"
          disabled={applying}
        >
          <WeekStrip
            todayIdx={todayIdx}
            loggedByDay={loggedByDay}
            changeFromIdx={null}
            label="This week"
          />
          <WeekStrip
            todayIdx={null}
            loggedByDay={new Map()}
            changeFromIdx={0}
            label="Next week"
          />
          <p className="apply-note">
            This week is left exactly as it is. Your reshaped week is queued as a new block and goes
            live on its own — you don't have to come back and do anything.
          </p>
          {blockEndsFirst && (
            <p className="apply-note" style={{ color: 'var(--pending)' }}>
              Heads up: your {state.phaseName} block already ends {formatDay(state.phase.weekEnd)}, so
              a new block would normally be designed at that boundary anyway. Scheduling this still
              works — your asks are also saved as standing preferences either way.
            </p>
          )}
        </TimingOption>

        {/* What changes — the same marked-up diff from the board, so the two
            halves of the decision sit on one screen instead of two. */}
        <div style={{ marginTop: 26 }}>
          <SectionHeader>What changes</SectionHeader>
          <div className="apply-summary">
            {diff.newSessions > 0 && <Chip tone="done">{diff.newSessions} new session{diff.newSessions === 1 ? '' : 's'}</Chip>}
            {diff.added > 0 && <Chip tone="done">+{diff.added} added</Chip>}
            {diff.removed > 0 && <Chip tone="pending">−{diff.removed} dropped</Chip>}
            {diff.changed > 0 && <Chip tone="todo">~{diff.changed} retuned</Chip>}
            <span className="num text-xs text-dim" style={{ alignSelf: 'center' }}>
              ~{diff.minutesBefore} → {diff.minutesAfter} min/week
            </span>
          </div>

          {diff.mainLiftsDropped.length > 0 && (
            <p className="text-sm" style={{ color: 'var(--veto)', lineHeight: 1.45, margin: '12px 0', display: 'flex', gap: 8 }}>
              <AlertTriangle size={15} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>This drops {diff.mainLiftsDropped.join(', ')} from your week.</span>
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {changedSessions.map((s, i) => (
              <div className="card" key={`${s.name}-${i}`} style={{ borderColor: 'var(--signal)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <h3 style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{s.name}</h3>
                  <span className="num text-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
                    {s.isNew ? <span style={{ color: 'var(--confirmed)' }}>NEW</span> : (
                      <>
                        {s.added > 0 && <span style={{ color: 'var(--confirmed)' }}>+{s.added} </span>}
                        {s.removed > 0 && <span style={{ color: 'var(--veto)' }}>−{s.removed} </span>}
                        {s.changed > 0 && <span style={{ color: 'var(--computing)' }}>~{s.changed}</span>}
                      </>
                    )}
                  </span>
                </div>
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                  {s.changes.filter((c) => c.kind !== 'kept').map((c, k) => (
                    <ChangeRow key={`${c.kind}-${c.name}-${k}`} change={c} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="apply-confirm__actions">
        <Button onClick={() => onConfirm(timing)} disabled={applying} full>
          {applying
            ? 'Saving…'
            : timing === 'now' ? 'Apply now' : `Schedule for ${formatDay(monday)}`}
        </Button>
        <button type="button" className="edit-discard" onClick={onCancel} disabled={applying}>
          Keep editing
        </button>
      </div>
    </div>
  )
}

/** One of the two answers, as a big tap target that shows its own consequence. */
function TimingOption({
  selected, onSelect, title, meta, disabled, children,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  meta: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`timing-option${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="timing-option__head"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
      >
        <span className={`timing-option__radio${selected ? ' is-on' : ''}`} aria-hidden>
          {selected && <Check size={13} strokeWidth={3} />}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="timing-option__title">{title}</span>
          <span className="timing-option__meta">{meta}</span>
        </span>
      </button>
      <div className="timing-option__body">{children}</div>
    </div>
  )
}

/**
 * Seven days, and where the change lands. This is the visual that replaces the
 * sentence "edits the repeating week for the rest of your block": a logged day
 * reads as done, and the band under the days the change covers shows the actual
 * blast radius rather than describing it.
 */
function WeekStrip({
  todayIdx, loggedByDay, changeFromIdx, label,
}: {
  todayIdx: number | null
  loggedByDay: Map<number, string[]>
  /** First day the change applies to, or null when this week is untouched. */
  changeFromIdx: number | null
  label: string
}) {
  return (
    <div className="week-strip">
      <p className="week-strip__label">{label}</p>
      <div className="week-strip__days">
        {DAY_KEYS.map((d, i) => {
          const done = loggedByDay.has(i)
          const covered = changeFromIdx != null && i >= changeFromIdx
          return (
            <div
              key={d}
              className={[
                'week-strip__day',
                done ? 'is-done' : '',
                covered ? 'is-covered' : '',
                todayIdx === i ? 'is-today' : '',
              ].filter(Boolean).join(' ')}
              title={done ? loggedByDay.get(i)!.join(', ') : undefined}
            >
              <span className="week-strip__dow">{d[0]}</span>
              <span className="week-strip__mark">
                {done ? <Check size={12} strokeWidth={3} /> : <span className="week-strip__dot" />}
              </span>
            </div>
          )
        })}
      </div>
      <div className={`week-strip__band${changeFromIdx != null ? ' is-on' : ''}`}>
        <span
          className="week-strip__band-fill"
          style={{
            left: `${((changeFromIdx ?? 0) / 7) * 100}%`,
            width: `${(((7 - (changeFromIdx ?? 0))) / 7) * 100}%`,
          }}
        />
      </div>
      <p className="week-strip__caption">
        {changeFromIdx == null
          ? 'unchanged'
          : changeFromIdx === 0
            ? 'the new week, all of it'
            : `the new week, from ${DAY_KEYS[changeFromIdx]}`}
      </p>
    </div>
  )
}

// ---- The week board --------------------------------------------------------

function WeekSummary({
  state, draft, diff, scopeLine,
}: { state: ProgramEditState; draft: ProgramDraft; diff: DraftDiff; scopeLine: string }) {
  const exercises = draft.sessions.reduce((n, s) => n + s.exercises.length, 0)
  const standing = (state.context.standing_preferences ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  return (
    <div className="card fade-rise">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
        <SectionHeader>{state.phaseName} block</SectionHeader>
        {diff.dirty ? <Chip tone="pending">Unsaved</Chip> : <Chip tone="done">Live</Chip>}
      </div>
      <p className="text-sm text-dim" style={{ lineHeight: 1.5 }}>{scopeLine}</p>
      <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
        <Metric label="Sessions" value={draft.sessions.length} />
        <Metric label="Days/week" value={draft.sessionsPerWeek} moved={diff.sessionsPerWeekAfter !== diff.sessionsPerWeekBefore} />
        <Metric label="Exercises" value={exercises} />
        <Metric label="Min/week" value={`~${diff.minutesAfter}`} moved={diff.minutesAfter !== diff.minutesBefore} />
      </div>

      {/* What you've asked for before. Shown because it is real state: it steers
          the NEXT block's design too, and invisible state that changes your
          training is exactly what this screen exists to end. */}
      {standing.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            Standing asks · carried into the next block
          </p>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {standing.map((l, i) => (
              <li key={i} className="text-sm text-dim" style={{ lineHeight: 1.4 }}>· {l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, moved }: { label: string; value: number | string; moved?: boolean }) {
  return (
    <div>
      <p
        className="num"
        style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: moved ? 'var(--signal)' : 'var(--text)' }}
      >
        {value}
      </p>
      <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
        {label}
      </p>
    </div>
  )
}

function SessionCard({
  diff, minutesBefore, minutesAfter, sessionType, dow, openByDefault,
}: {
  diff: SessionDiff
  minutesBefore: number | null
  minutesAfter: number
  sessionType: string | null
  dow: number | null
  openByDefault: boolean
}) {
  const touched = diff.isNew || diff.added > 0 || diff.removed > 0 || diff.changed > 0
  // An untouched session collapses to a one-line summary once something else in
  // the week has moved — present, one tap away, never competing with the change.
  const [open, setOpen] = useState(touched || openByDefault)
  useEffect(() => { if (touched) setOpen(true) }, [touched])

  return (
    <div className="card" style={touched ? { borderColor: 'var(--signal)' } : undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
          width: '100%', background: 'none', border: 'none', padding: 0, color: 'inherit',
          textAlign: 'left', cursor: 'pointer',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{diff.name}</h3>
          <p className="text-xs text-dim" style={{ marginTop: 3 }}>
            {[
              diff.previousName ? `was ${diff.previousName}` : null,
              sessionType && sessionType !== 'strength' ? sessionType : null,
              dow != null ? DOW[dow] : null,
              `${minutesBefore != null && minutesBefore !== minutesAfter ? `~${minutesBefore} → ` : '~'}${minutesAfter} min`,
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
        <span className="num text-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
          {diff.isNew ? <span style={{ color: 'var(--confirmed)' }}>NEW</span> : !touched ? (open ? 'hide' : `${diff.changes.length} ex`) : (
            <>
              {diff.added > 0 && <span style={{ color: 'var(--confirmed)' }}>+{diff.added} </span>}
              {diff.removed > 0 && <span style={{ color: 'var(--veto)' }}>−{diff.removed} </span>}
              {diff.changed > 0 && <span style={{ color: 'var(--computing)' }}>~{diff.changed}</span>}
            </>
          )}
        </span>
      </button>

      {diff.intent && open && (
        <p className="text-sm text-dim" style={{ marginTop: 8, lineHeight: 1.5 }}>{diff.intent}</p>
      )}

      {open && (
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
          {diff.changes.map((c, i) => <ChangeRow key={`${c.kind}-${c.name}-${i}`} change={c} />)}
        </ul>
      )}
    </div>
  )
}

function ChangeRow({ change }: { change: ExerciseChange }) {
  const tone = CHANGE_TONE[change.kind]
  const dim = change.kind === 'kept'
  return (
    <li style={{ display: 'flex', gap: 10, alignItems: 'flex-start', opacity: dim ? 0.55 : 1 }}>
      <span
        className="num"
        aria-hidden
        style={{ color: tone, fontSize: 'var(--fs-sm)', fontWeight: 700, lineHeight: 1.5, width: 12, flexShrink: 0 }}
      >
        {CHANGE_MARK[change.kind]}
      </span>
      <div style={{ minWidth: 0 }}>
        <p className="text-sm" style={{ lineHeight: 1.45, color: change.kind === 'removed' ? 'var(--text-dim)' : 'var(--text)' }}>
          <span style={{ textDecoration: change.kind === 'removed' ? 'line-through' : 'none' }}>{change.name}</span>
        </p>
        <p className="num text-xs text-dim" style={{ marginTop: 3, lineHeight: 1.4 }}>
          {change.kind === 'changed' && change.before ? (
            <>
              <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{change.before}</span>
              {' → '}
              <span style={{ color: tone }}>{change.after}</span>
            </>
          ) : (
            change.after ?? change.before
          )}
        </p>
      </div>
    </li>
  )
}
