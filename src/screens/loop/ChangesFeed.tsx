import { useState } from 'react'
import { Button, Chip } from '../../components/ui'
import { undoChange, whenLabel, type ChangeItem } from '../../lib/changeLog'
import { success } from '../../lib/haptics'

type Phase = 'idle' | 'confirm' | 'working' | 'undone' | 'refused'

/**
 * One recorded change: who made it, what moved, why, when. Undo is one tap
 * and a confirm; the Worker refuses (and says why) if what it changed has
 * moved since. A row that was undone stays, marked, so the record is whole.
 */
function ChangeRow({ change, onUndone }: { change: ChangeItem; onUndone: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const undone = phase === 'undone' || change.reverted_by != null

  async function undo() {
    setPhase('working')
    const res = await undoChange(change.id)
    setPhase(res.ok ? 'undone' : 'refused')
    setMessage(res.ok ? null : res.text || null)
    if (res.ok) {
      success()
      onUndone()
    }
  }

  return (
    <div className={`change${undone ? ' change--undone' : ''}`}>
      <p className="change__k">
        <span className="change__who">{change.who}</span>
        <span className="change__when">{whenLabel(change.created_at)}</span>
        {undone && <Chip tone="pending">Undone</Chip>}
        {change.revert_of && <Chip tone="info">Undo</Chip>}
      </p>
      <p className="change__what">{change.summary}</p>
      {(change.rationale || change.rule_refs.length > 0) && (
        <p className="change__why">
          {change.rationale}
          {change.rule_refs.map((r) => <span key={r} className="change__rule num">{r}</span>)}
        </p>
      )}
      {change.revert_suggested && !undone && (
        <p className="change__suggest">Your coach suggests undoing this.</p>
      )}
      {message && <p className="change__message">{message}</p>}
      {change.revertible && !undone && phase !== 'refused' && (
        phase === 'confirm' || phase === 'working' ? (
          <div className="change__acts">
            <Button variant="primary" disabled={phase === 'working'} onClick={() => void undo()}>Undo it</Button>
            <Button variant="outline" disabled={phase === 'working'} onClick={() => setPhase('idle')}>Keep</Button>
          </div>
        ) : (
          <button type="button" className="change__undo" onClick={() => setPhase('confirm')}>Undo</button>
        )
      )}
    </div>
  )
}

/** The Changes feed under Program (tracks_v1): every write, newest first. */
export function ChangesFeed({ changes, onUndone }: { changes: ChangeItem[]; onUndone: () => void }) {
  if (!changes.length) {
    return (
      <p className="text-sm text-dim" style={{ lineHeight: 1.5 }}>
        Nothing yet. Every change you or a coach makes shows up here, with why, and you can undo it.
      </p>
    )
  }
  return (
    <div className="changes">
      {changes.map((c) => <ChangeRow key={c.id} change={c} onUndone={onUndone} />)}
    </div>
  )
}
