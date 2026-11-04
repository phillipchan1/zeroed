import { useState } from 'react'
import { Button, Chip } from '../../components/ui'
import { previewUndo, undoChange, whenLabel, type ChangeItem } from '../../lib/changeLog'
import { success } from '../../lib/haptics'

type Phase = 'idle' | 'previewing' | 'confirm' | 'working' | 'undone' | 'refused'

/**
 * One recorded change: who made it, what moved, why, when. Undo (or Redo, on
 * a row that was itself an undo) previews first: what it puts back, or the
 * newer change that has to go first. The confirm applies exactly that
 * preview; if anything moved since, the Worker refuses and asks to preview
 * again. A row that was undone stays, marked, so the record is whole.
 */
function ChangeRow({ change, onUndone }: { change: ChangeItem; onUndone: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | undefined>(undefined)
  const undone = phase === 'undone' || change.reverted_by != null
  const redo = change.revert_action === 'redo'
  const verb = redo ? 'Redo' : 'Undo'

  async function preview() {
    setPhase('previewing')
    const res = await previewUndo(change.id)
    if (!res.ok || !res.preview_id) {
      setPhase('refused')
      setMessage(res.text || null)
      return
    }
    setPreviewId(res.preview_id)
    setMessage(res.text || null)
    setPhase('confirm')
  }

  async function undo() {
    setPhase('working')
    const res = await undoChange(change.id, previewId)
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
        {change.revert_of && <Chip tone="info">{change.summary.startsWith('Redid') ? 'Redo' : 'Undo'}</Chip>}
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
            <Button variant="primary" disabled={phase === 'working'} onClick={() => void undo()}>{`${verb} it`}</Button>
            <Button variant="outline" disabled={phase === 'working'} onClick={() => { setPhase('idle'); setMessage(null) }}>Keep</Button>
          </div>
        ) : (
          <button type="button" className="change__undo" disabled={phase === 'previewing'} onClick={() => void preview()}>{verb}</button>
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
