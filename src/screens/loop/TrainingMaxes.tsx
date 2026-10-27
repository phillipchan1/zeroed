import { useCallback, useEffect, useMemo, useState } from 'react'
import { gatherTrainingMaxSources, saveTrainingMaxOverride } from '../../engine'
import {
  MAIN_LIFTS, TM_FRACTION, fmtLoad, liftIncrement, modelFromSources, shortDay, withTrainingMax,
  type LiftModel, type LiftModelSources, type MainLiftId,
} from '../../engine/liftModel'
import { invalidateLoopViews } from '../../lib/loopCache'
import { unitContext, type WeightUnit } from '../../lib/units'
import { Button, Input, Row, SectionHeader, Sheet, Skeleton } from '../../components/ui'

/**
 * TRAINING MAXES — the number every main-lift load is charted from, and the
 * athlete's one lever on it.
 *
 * The model's TM is 90% of the working max, refreshed from every qualifying set.
 * A hand-set TM replaces it outright, so the sheet shows the model's number next
 * to the one being typed, previews this week's load both ways before anything is
 * saved, and flags an override that has gone stale instead of quietly trusting
 * a number the log has since moved past.
 */
export function TrainingMaxes({ athleteId, unit }: { athleteId: string; unit: WeightUnit }) {
  const [src, setSrc] = useState<LiftModelSources | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState<MainLiftId | null>(null)

  const reload = useCallback(async () => {
    try {
      setSrc(await gatherTrainingMaxSources(athleteId, unitContext(unit)))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [athleteId, unit])

  useEffect(() => { void reload() }, [reload])

  const models = useMemo(
    () => (src ? MAIN_LIFTS.map((l) => modelFromSources(l, src)) : []),
    [src],
  )
  const openModel = open ? models.find((m) => m.lift === open) ?? null : null

  return (
    <div className="section">
      <SectionHeader>Training maxes</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, fontSize: 'var(--fs-sm)', lineHeight: 1.45 }}>
        Every squat, bench, deadlift and press number is loaded from these. They follow your log unless you set one.
      </p>
      {src === undefined && !loadError ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {MAIN_LIFTS.map((l) => <Skeleton key={l} height={44} />)}
        </div>
      ) : loadError && !src ? (
        <p className="text-dim" style={{ marginTop: 12, fontSize: 'var(--fs-sm)' }}>
          Couldn't load your log ({loadError}).{' '}
          <button type="button" className="tm-link" onClick={() => void reload()}>Try again</button>
        </p>
      ) : (
        <div style={{ marginTop: 4 }}>
          {models.map((m) => (
            <Row
              key={m.lift}
              title={<>{m.label}{(m.trainingMax?.override?.stale.length ?? 0) > 0 && <span className="tm-flag">Check</span>}</>}
              sub={rowSub(m)}
              value={m.trainingMax ? `${fmtLoad(Math.round(m.trainingMax.value))} ${m.unit}` : '—'}
              onClick={src ? () => setOpen(m.lift) : undefined}
            />
          ))}
        </div>
      )}
      {open && openModel && src && (
        <TrainingMaxSheet
          athleteId={athleteId}
          unit={unit}
          model={openModel}
          src={src}
          onClose={() => setOpen(null)}
          onSaved={async () => {
            invalidateLoopViews()
            await reload()
            setOpen(null)
          }}
        />
      )}
    </div>
  )
}

function rowSub(m: LiftModel): string {
  const tm = m.trainingMax
  if (!tm) return m.lastWeek || m.allTimeBest ? 'No qualifying sets in six weeks' : 'Nothing logged yet'
  const model = tm.computed != null ? `model ${fmtLoad(Math.round(tm.computed))}` : 'no model number'
  if (tm.source === 'override') {
    const on = tm.override?.setOn ? ` ${shortDay(tm.override.setOn)}` : ''
    return tm.override?.stale.length ? `Set by hand${on} · may be out of date` : `Set by hand${on} · ${model}`
  }
  return m.workingMax ? `${TM_FRACTION * 100}% of working max ${fmtLoad(m.workingMax.rounded)}` : model
}

function roundTo(x: number, inc: number): number {
  return Math.round(x / inc) * inc
}

/** "Bench press 3×5 @ 225 lb, RPE 8" — the line a preview compares. */
function weekLine(m: LiftModel): string | null {
  const r = m.recommendation
  if (!r) return null
  if (r.skip) return 'Skip today'
  return `${r.sets}×${r.reps} @ ${fmtLoad(r.load)} ${m.unit}, RPE ${fmtLoad(r.targetRpe)}${r.capped ? ' (capped)' : ''}`
}

interface SheetProps {
  athleteId: string
  unit: WeightUnit
  model: LiftModel
  src: LiftModelSources
  onClose: () => void
  onSaved: () => Promise<void>
}

function TrainingMaxSheet({ athleteId, unit, model, src, onClose, onSaved }: SheetProps) {
  const tm = model.trainingMax
  const computed = tm?.computed ?? null
  const isOverride = tm?.source === 'override'
  const stale = tm?.override?.stale ?? []
  const inc = liftIncrement(model.lift, model.unit)

  const [draft, setDraft] = useState(() => (tm ? fmtLoad(Math.round(tm.value)) : ''))
  // 'clear' previews going back to the model's number without typing it in —
  // typing the model's number would freeze it as a hand-set one.
  const [choice, setChoice] = useState<'set' | 'clear'>('set')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const typed = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(typed) && typed > 0
  const target = choice === 'clear' ? null : valid ? typed : undefined
  // Saving the model's own number unchanged would only freeze it: no change.
  const current = isOverride ? tm!.value : computed != null ? Math.round(computed) : null
  const changes = choice === 'clear'
    ? isOverride
    : valid && (current == null || Math.abs(typed - current) >= 0.05)

  const after = useMemo(
    () => (target === undefined ? null : modelFromSources(model.lift, withTrainingMax(model.lift, target, src))),
    [model.lift, src, target],
  )

  function nudge(pct: number) {
    const base = valid && choice === 'set' ? typed : tm?.value ?? computed
    if (base == null) return
    let next = roundTo(base * (1 + pct / 100), inc)
    if (next === roundTo(base, inc)) next += Math.sign(pct) * inc
    setDraft(fmtLoad(next))
    setChoice('set')
  }

  async function save(value: number | null) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await saveTrainingMaxOverride(athleteId, model.lift, value, src, unitContext(unit))
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const best = model.allTimeBest
  const impliedOverBest = choice === 'set' && valid && best != null && typed / TM_FRACTION > best.e1rm
  const before = weekLine(model)
  const afterLine = after ? weekLine(after) : null
  const label = choice === 'clear' && computed != null
    ? `Use the model's ${fmtLoad(Math.round(computed))} ${model.unit}`
    : valid ? `Save ${fmtLoad(typed)} ${model.unit}` : 'Save'

  return (
    <Sheet
      title={`${model.label} training max`}
      subtitle={[
        model.workingMax ? `Working max ${fmtLoad(model.workingMax.rounded)}` : 'No working max yet',
        best ? `best e1RM ${fmtLoad(Math.round(best.e1rm))}` : null,
      ].filter(Boolean).join(' · ')}
      onClose={onClose}
      actions={
        <Button variant="primary" full disabled={!changes || busy} onClick={() => void save(target ?? null)}>
          {busy ? 'Saving…' : label}
        </Button>
      }
    >
      {stale.length > 0 && isOverride && choice === 'set' && (
        <div className="tm-stale">
          <p className="tm-stale__title">This may be out of date</p>
          <ul>{stale.map((s) => <li key={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</li>)}</ul>
          <div className="tm-stale__actions">
            <Button variant="outline" disabled={busy} onClick={() => void save(tm!.value)}>
              Still right
            </Button>
            {computed != null && (
              <Button variant="outline" disabled={busy} onClick={() => setChoice('clear')}>
                Use the model's {fmtLoad(Math.round(computed))}
              </Button>
            )}
          </div>
        </div>
      )}

      <label className="tm-field">
        <span className="tm-field__label">Training max ({model.unit})</span>
        <Input
          type="number"
          inputMode="decimal"
          mono
          value={choice === 'clear' && computed != null ? fmtLoad(Math.round(computed)) : draft}
          onChange={(e) => { setDraft(e.target.value); setChoice('set') }}
          aria-label={`${model.label} training max in ${model.unit}`}
        />
      </label>
      <div className="tm-nudges" role="group" aria-label="Nudge">
        {[-5, -2.5, 2.5, 5].map((p) => (
          <button key={p} type="button" className="tm-nudge" onClick={() => nudge(p)}>
            {p > 0 ? '+' : '−'}{fmtLoad(Math.abs(p))}%
          </button>
        ))}
      </div>

      <div className="tm-model">
        {computed != null ? (
          <>
            <span>
              Model: <strong>{fmtLoad(Math.round(computed))} {model.unit}</strong>, {TM_FRACTION * 100}% of the working max
              {model.workingMax ? ` (from ${fmtLoad(model.workingMax.anchor.weight)}×${model.workingMax.anchor.reps}${model.workingMax.anchor.rpe != null ? ` @${fmtLoad(model.workingMax.anchor.rpe)}` : ''}, ${shortDay(model.workingMax.anchor.date)})` : ''}
            </span>
            {isOverride && choice === 'set' && stale.length === 0 && (
              <button type="button" className="tm-link" onClick={() => setChoice('clear')}>Use it</button>
            )}
          </>
        ) : (
          <span>No model number yet: no qualifying sets (1–6 reps at RPE 6–9.5, or a single at 10) in six weeks.</span>
        )}
      </div>
      {isOverride && tm?.override?.setOn && (
        <p className="tm-note">You set {fmtLoad(Math.round(tm.value))} on {shortDay(tm.override.setOn)}.</p>
      )}

      {impliedOverBest && best && (
        <p className="tm-warn">
          {fmtLoad(typed)} implies a max of {fmtLoad(Math.round(typed / TM_FRACTION))}, above your best e1RM of {fmtLoad(Math.round(best.e1rm))}.
          Loads still stop at your all-time best +2.5% unless it's a test day.
        </p>
      )}

      <div className="tm-preview">
        <span className="tm-field__label">This week</span>
        {before == null && afterLine == null ? (
          <p className="tm-note">Nothing logged on it yet, so there's no week to preview. The TM takes over from your first logged set.</p>
        ) : (
          <>
            <p><span className="text-dim">Now</span> {before ?? '—'}</p>
            {after && changes && (
              <p>
                <span className="text-dim">After</span>{' '}
                <strong>{afterLine ?? '—'}</strong>
              </p>
            )}
            {(changes ? after : model)?.recommendation && (
              <p className="tm-note">{(changes ? after! : model).recommendation!.reason}</p>
            )}
            {after?.recommendation && before === afterLine && changes && (
              <p className="tm-note">
                {after.recommendation.capped
                  ? 'Same load: it is already at your all-time-best ceiling.'
                  : 'Same load: the change rounds to the same plates this week.'}
              </p>
            )}
          </>
        )}
      </div>

      {error && <p className="tm-warn">Couldn't save: {error}</p>}
    </Sheet>
  )
}
