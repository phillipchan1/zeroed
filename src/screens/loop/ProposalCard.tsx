import { useState } from 'react'
import { Banner, Button, LockOn, SectionHeader, Sheet } from '../../components/ui'
import { invalidateCache, useCachedLoader } from '../../lib/cache'
import { cacheKeys, invalidateLoopViews } from '../../lib/loopCache'
import { fetchProposals, resolveProposal, type CoachProposal } from '../../lib/proposals'
import { fetchGoalsView, type GoalView } from '../../lib/tracksData'
import { tracksOn } from '../../lib/tracksFlag'
import { success } from '../../lib/haptics'
import { proposalWarnings } from '../../lib/previewWarnings'
import { PreviewWarnings } from './PreviewWarnings'

type Phase = 'pending' | 'working' | 'applied' | 'declined' | 'stale' | 'error'

/**
 * A change the coach proposed, for the athlete to accept. The diff is the
 * engine's own (what Claude previewed); Accept applies exactly that. On accept
 * only what changed moves: added movements slide in and lock, removed ones
 * fade, and nothing else on the card animates. The card's one yellow is
 * Approve, and it is the screen's only call to act. Approve is approve +
 * apply: the Worker records the athlete's tap as an approval of exactly this
 * diff, and the apply spends it (G10).
 */
export function ProposalCard({ proposal, goalNames, onResolved }: {
  proposal: CoachProposal
  goalNames: string[]
  onResolved?: (status: Phase) => void
}) {
  const [phase, setPhase] = useState<Phase>('pending')
  const [message, setMessage] = useState<string | null>(null)
  const sessions = (proposal.diff?.sessions ?? []).filter((s) => s.changes.some((c) => c.kind !== 'kept'))
  // tracks_v1 (G5): the validators' warnings on what the coach previewed.
  const warnings = proposalWarnings(proposal.diff, tracksOn())

  async function act(action: 'accept' | 'decline') {
    setPhase('working')
    const res = await resolveProposal(proposal.id, action)
    const next: Phase = res.ok ? (action === 'accept' ? 'applied' : 'declined') : res.status === 'stale' ? 'stale' : 'error'
    setPhase(next)
    setMessage(res.ok && action === 'accept' ? null : res.text || null)
    if (res.ok && action === 'accept') {
      success()
      invalidateLoopViews()
    }
    onResolved?.(next)
  }

  const applied = phase === 'applied'
  const kicker = applied ? 'Applied'
    : phase === 'declined' ? 'Declined'
      : phase === 'stale' ? 'Out of date'
        : 'Proposed by your coach'

  return (
    <div className={`proposal proposal--${phase}`}>
      <p className="proposal__k">
        {kicker}
        {goalNames.length > 0 && <span className="proposal__for"> · for {goalNames.join(', ')}</span>}
      </p>
      <h3 className="proposal__title">{proposal.title}</h3>
      {proposal.rationale && <p className="proposal__why">{proposal.rationale}</p>}

      {sessions.length > 0 && (
        <div className="proposal__diff">
          {sessions.map((s) => (
            <div key={s.name} className="proposal__session">
              <p className="proposal__session-name">{s.name}</p>
              {s.changes.filter((c) => c.kind !== 'kept').map((c, i) => {
                const row = (
                  <p className={`proposal__change proposal__change--${c.kind}`}>
                    <span className="proposal__sign" aria-hidden>{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span>
                    <span className="proposal__change-name">{c.name}</span>
                    <span className="proposal__change-rx num">
                      {c.kind === 'changed' && c.before ? <><s>{c.before}</s> → {c.after}</> : c.after ?? c.before ?? ''}
                    </span>
                  </p>
                )
                return applied && c.kind === 'added' ? (
                  <LockOn
                    key={`${c.name}-${i}`}
                    className="proposal__lock"
                    style={{ '--lock-gap': '-4px', '--lock-from': '10px', '--lock-size': '8px', '--lock-color': 'var(--confirmed)' } as React.CSSProperties}
                  >
                    {row}
                  </LockOn>
                ) : <div key={`${c.name}-${i}`}>{row}</div>
              })}
            </div>
          ))}
          <p className="proposal__timing">
            {proposal.kind === 'session_override'
              ? 'This week only. Your plan itself doesn’t change.'
              : proposal.timing === 'next_week' ? 'Starts next Monday; this week stays as it is.' : 'Changes this week’s plan.'}
          </p>
        </div>
      )}

      {phase === 'pending' && <PreviewWarnings view={warnings} />}

      {message && <p className="proposal__message">{message}</p>}

      {(phase === 'pending' || phase === 'working' || phase === 'error') && (
        <div className="proposal__acts">
          <Button variant="primary" disabled={phase === 'working'} onClick={() => void act('accept')}>Approve</Button>
          <Button variant="outline" disabled={phase === 'working'} onClick={() => void act('decline')}>Not now</Button>
        </div>
      )}
    </div>
  )
}

/**
 * The list of what's waiting, shared by every way of showing it. A resolved
 * card stays where it was, showing what happened, even after the refreshed list
 * no longer includes it.
 */
function usePendingProposals(athleteId: string, goalId?: string) {
  const { data: proposals } = useCachedLoader<CoachProposal[]>(
    tracksOn() ? cacheKeys.proposals(athleteId) : null,
    fetchProposals,
  )
  const { data: goals } = useCachedLoader<GoalView[]>(
    tracksOn() ? cacheKeys.goals(athleteId) : null,
    () => fetchGoalsView(athleteId),
  )
  const [kept, setKept] = useState<CoachProposal[]>([])
  const pending = (proposals ?? []).filter((p) => !goalId || (p.goal_ids ?? []).includes(goalId))
  const list = [...pending, ...kept.filter((k) => !pending.some((p) => p.id === k.id))]
  const nameOf = (id: string) => goals?.find((g) => g.id === id)?.name
  const goalNamesOf = (p: CoachProposal) => (p.goal_ids ?? []).map(nameOf).filter((n): n is string => !!n)
  const onResolved = (p: CoachProposal) => (status: Phase) => {
    if (status === 'applied' || status === 'declined' || status === 'stale') {
      setKept((prev) => (prev.some((k) => k.id === p.id) ? prev : [...prev, p]))
      invalidateCache(cacheKeys.proposals(athleteId))
    }
  }
  return { pending, list, goalNamesOf, onResolved }
}

/**
 * What the coach is waiting on you for. Coach shows every pending proposal;
 * a goal's page shows the ones that serve it (pass goalId). Nothing renders
 * when there are none, or when the backend can't hold proposals yet.
 */
export function PendingProposals({ athleteId, goalId, heading = true }: {
  athleteId: string
  goalId?: string
  heading?: boolean
}) {
  const { list, goalNamesOf, onResolved } = usePendingProposals(athleteId, goalId)
  if (!list.length) return null
  return (
    <div className="pending-proposals fade-rise">
      {heading && <SectionHeader>Waiting on you</SectionHeader>}
      <div style={{ marginTop: heading ? 12 : 0 }}>
        {list.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            goalNames={goalNamesOf(p)}
            onResolved={onResolved(p)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The same proposals for a phone, where a full diff card cannot sit above a
 * conversation: one proposal with its diff is taller than the screen, and on the
 * Coach screen (which does not scroll as a page) it left the chat a 72px sliver.
 * Here the thing waiting on you is one line you can see at a glance, and the
 * diff opens in a sheet that scrolls on its own and can be dismissed.
 */
export function ProposalsBanner({ athleteId }: { athleteId: string }) {
  const { pending, list, goalNamesOf, onResolved } = usePendingProposals(athleteId)
  const [open, setOpen] = useState(false)
  // Stay mounted while the sheet is open: approving removes the proposal from
  // `pending`, and the card inside must keep showing what just happened.
  if (!pending.length && !open) return null
  return (
    <div className="coach-proposals">
      {pending.length > 0 && (
        <Banner
          title={pending.length === 1 ? 'A change is waiting on you' : `${pending.length} changes are waiting on you`}
          sub={pending[0].title}
          onClick={() => setOpen(true)}
        />
      )}
      {open && (
        <Sheet title="Waiting on you" onClose={() => setOpen(false)}>
          {list.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              goalNames={goalNamesOf(p)}
              onResolved={onResolved(p)}
            />
          ))}
        </Sheet>
      )}
    </div>
  )
}
