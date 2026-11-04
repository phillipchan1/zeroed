import { useState } from 'react'
import { Button, LockOn, SectionHeader } from '../../components/ui'
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
 * What the coach is waiting on you for. Coach shows every pending proposal;
 * a goal's page shows the ones that serve it (pass goalId). Nothing renders
 * when there are none, or when the backend can't hold proposals yet.
 */
export function PendingProposals({ athleteId, goalId, heading = true }: {
  athleteId: string
  goalId?: string
  heading?: boolean
}) {
  const { data: proposals } = useCachedLoader<CoachProposal[]>(
    tracksOn() ? cacheKeys.proposals(athleteId) : null,
    fetchProposals,
  )
  const { data: goals } = useCachedLoader<GoalView[]>(
    tracksOn() ? cacheKeys.goals(athleteId) : null,
    () => fetchGoalsView(athleteId),
  )
  // A resolved card stays where it was, showing what happened, even after the
  // refreshed list no longer includes it.
  const [kept, setKept] = useState<CoachProposal[]>([])
  const pending = (proposals ?? []).filter((p) => !goalId || (p.goal_ids ?? []).includes(goalId))
  const list = [...pending, ...kept.filter((k) => !pending.some((p) => p.id === k.id))]
  if (!list.length) return null
  const nameOf = (id: string) => goals?.find((g) => g.id === id)?.name
  return (
    <div className="pending-proposals fade-rise">
      {heading && <SectionHeader>Waiting on you</SectionHeader>}
      <div style={{ marginTop: heading ? 12 : 0 }}>
        {list.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            goalNames={(p.goal_ids ?? []).map(nameOf).filter((n): n is string => !!n)}
            onResolved={(status) => {
              if (status === 'applied' || status === 'declined' || status === 'stale') {
                setKept((prev) => (prev.some((k) => k.id === p.id) ? prev : [...prev, p]))
                invalidateCache(cacheKeys.proposals(athleteId))
              }
            }}
          />
        ))}
      </div>
    </div>
  )
}
