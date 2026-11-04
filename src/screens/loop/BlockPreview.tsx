import { useState } from 'react'
import { Button, Markdown } from '../../components/ui'
import { approvePreview, repreviewBlock, type ApplyResult, type BlockView } from '../../lib/coachV1'

/**
 * A composed block as the athlete approves it (coach_v1). Display only: the
 * Worker composed it. Trade-offs are the athlete's to pick (a pick is a new
 * preview); Approve is their tap, which applies it. Nothing is written before.
 */
export function BlockPreview({ previewId, block, onApplied }: {
  previewId: string
  block: BlockView
  onApplied?: (r: ApplyResult) => void
}) {
  const [current, setCurrent] = useState({ previewId, block })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const b = current.block

  async function pick(tradeOff: string, option: string) {
    setBusy(true)
    setNote(null)
    const r = await repreviewBlock(current.previewId, { [tradeOff]: option })
    if (r.ok && r.preview_id && r.block) setCurrent({ previewId: r.preview_id, block: r.block })
    else setNote(r.text ?? 'Could not update the block.')
    setBusy(false)
  }

  async function approve() {
    setBusy(true)
    setNote(null)
    const r = await approvePreview(current.previewId)
    setNote(r.text)
    if (r.applied) setDone(true)
    setBusy(false)
    onApplied?.(r)
  }

  return (
    <div className="card fade-rise" style={{ borderColor: 'var(--signal)' }}>
      <p className="eyebrow" style={{ marginBottom: 6 }}>Proposed block · {b.start} → {b.end}</p>
      <p className="text-sm" style={{ marginBottom: 10 }}>
        <strong>Priorities:</strong> {b.priorities.length ? b.priorities.join(', ') : 'none (everything at maintenance)'}
      </p>
      <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {b.week.map((line, i) => <span key={i} style={{ lineHeight: 1.4 }}>{line}</span>)}
      </div>
      <p className="text-xs text-dim" style={{ marginBottom: 6 }}>
        Deload week {b.deload_week.start}: {b.deload_week.note} Retest {b.retest_week.start}: {b.retest_week.order.join(' → ')}.
      </p>
      {b.prehab.items.length > 0 && (
        <p className="text-xs text-dim" style={{ marginBottom: 6 }}>
          Prehab ({b.prehab.minutes} min): {b.prehab.items.map((p) => `${p.name} ${p.dose}`).join('; ')}
        </p>
      )}
      <div className="text-xs" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {b.goals.map((g) => (
          <span key={g.name}>{g.name}: <strong>{g.role}</strong>{g.track ? ` · ${g.track}` : ''}{g.note ? ` (${g.note})` : ''}</span>
        ))}
      </div>
      {b.held.map((h, i) => (
        <p key={i} className="text-xs" style={{ color: 'var(--warn, var(--signal))', marginBottom: 4 }}>{h.what}: {h.note}</p>
      ))}
      {b.warnings.map((w, i) => <p key={i} className="text-xs text-dim" style={{ marginBottom: 4 }}>{w}</p>)}

      {b.trade_offs.map((t) => (
        <div key={t.id} className="card" style={{ marginTop: 10 }}>
          <Markdown className="text-sm" text={t.message} style={{ lineHeight: 1.45 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {t.options.map((o) => (
              <Button
                key={o.id}
                variant={t.chosen === o.id ? 'primary' : 'outline'}
                disabled={busy || done}
                onClick={() => void pick(t.id, o.id)}
                style={{ textAlign: 'left' }}
              >
                {o.label}<span className="text-xs" style={{ display: 'block', opacity: 0.8 }}>{o.effect}</span>
              </Button>
            ))}
          </div>
        </div>
      ))}

      {note && <p className="text-sm" style={{ marginTop: 10 }}>{note}</p>}
      {!done && (
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" full disabled={busy || b.needs_decision} onClick={() => void approve()}>
            {b.needs_decision ? 'Pick the trade-offs first' : busy ? 'Applying…' : 'Approve and apply'}
          </Button>
          <p className="text-xs text-dim" style={{ marginTop: 6 }}>Nothing changes until you approve. Every change is in Program → Changes.</p>
        </div>
      )}
    </div>
  )
}
