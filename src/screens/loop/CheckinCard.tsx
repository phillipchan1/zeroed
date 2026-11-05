import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '../../components/ui'
import { success } from '../../lib/haptics'
import {
  clearRedFlag, clearRegion, RED_FLAG_LABEL, regionLabel, submitCheckin,
  type PainInput, type ReadinessToday,
} from '../../lib/readiness'

// ---- Daily check-in (tracks_v1, G4) ------------------------------------------
// Sleep, stress, soreness and pain by region, once a day. The Worker turns it
// into today's adjustments (U6 trims accessories, then pulls HIIT/plyos; U7
// regresses or blocks a painful region) and the session shows them with why.
// Folded to one line until it's wanted; skipping it is fine.

const FIELDS = [
  { key: 'sleep_hours', label: 'Sleep h', min: 0, max: 24, step: 0.5 },
  { key: 'stress', label: 'Stress 1–5', min: 1, max: 5, step: 1 },
  { key: 'soreness', label: 'Soreness 1–5', min: 1, max: 5, step: 1 },
] as const

type FieldKey = typeof FIELDS[number]['key']

function summary(t: ReadinessToday): string {
  const c = t.checkin
  const bits = [
    c?.sleep_hours != null ? `${c.sleep_hours}h sleep` : null,
    c?.stress != null ? `stress ${c.stress}` : null,
    c?.soreness != null ? `soreness ${c.soreness}` : null,
    ...t.pain.map((p) => `${regionLabel(p.region).toLowerCase()} ${p.score}/10`),
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : 'sleep, stress, soreness, pain'
}

// Two kinds of block, each cleared on its own: one set by a check-in (a red
// flag ticked, pain over 5 twice in 14 days, or rising 3 sessions running)
// and a red flag set in the athlete's rules. Each row says which kind it is
// and whether the other still blocks the region; only the athlete can clear
// either. A one-off over 5, or worse the next morning, only blocks today and
// the next session (methodology v1.2): shown, with nothing to clear.
//
// Under 18, or with no age on file (section 11b), a clear takes a second
// step: a parent or guardian confirms a clinician cleared it (the checkbox is
// required; name and relationship are optional). The Worker refuses the clear
// without it and records it in the change.
function BlockedRow({ region, reason, kind, otherBlocks, guardianRequired, onCleared }: {
  region: string
  reason: string | null
  kind: 'checkin' | 'rule'
  otherBlocks: boolean
  guardianRequired: boolean
  onCleared: (text: string) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'guardian' | 'working'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [guardianOk, setGuardianOk] = useState(false)
  const [guardianName, setGuardianName] = useState('')
  const [relationship, setRelationship] = useState('')
  async function clear() {
    setPhase('working')
    const guardian = guardianRequired
      ? { confirmed: guardianOk, name: guardianName.trim() || undefined, relationship: relationship.trim() || undefined }
      : undefined
    const res = kind === 'rule' ? await clearRedFlag(region, guardian) : await clearRegion(region, guardian)
    setPhase('idle')
    setGuardianOk(false)
    setMessage(res.ok ? null : res.text)
    if (res.ok) {
      success()
      onCleared(res.text)
    }
  }
  const other = kind === 'rule' ? 'Your check-in also blocks it.' : 'A red flag in your rules also blocks it.'
  return (
    <div className="checkin__blocked">
      <p className="text-sm">
        <strong>{regionLabel(region)}: no loading</strong>
        {kind === 'rule' ? ' (red flag in your rules).' : ' (from your check-in).'} {reason}
      </p>
      {otherBlocks && <p className="text-xs text-dim">{other} Clear both once a clinician has cleared it.</p>}
      {message && <p className="text-xs text-dim">{message}</p>}
      {phase === 'idle' && (
        <button type="button" className="checkin__clear" onClick={() => setPhase('confirm')}>A clinician cleared it</button>
      )}
      {phase === 'confirm' && (
        <div className="checkin__acts">
          <Button variant="primary" onClick={() => (guardianRequired ? setPhase('guardian') : void clear())}>Yes, cleared</Button>
          <Button variant="outline" onClick={() => setPhase('idle')}>Not yet</Button>
        </div>
      )}
      {(phase === 'guardian' || (phase === 'working' && guardianRequired)) && (
        <div className="checkin__guardian">
          <p className="text-xs text-dim">Under 18 (or no age on file), a parent or guardian has to confirm this too.</p>
          <label className="text-sm">
            <input type="checkbox" checked={guardianOk} onChange={(e) => setGuardianOk(e.target.checked)} />{' '}
            A parent/guardian confirms a clinician cleared this
          </label>
          <input className="input" placeholder="Their name (optional)" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} aria-label="Parent or guardian name" />
          <input className="input" placeholder="Relationship (optional)" value={relationship} onChange={(e) => setRelationship(e.target.value)} aria-label="Relationship" />
          <div className="checkin__acts">
            <Button variant="primary" disabled={!guardianOk || phase === 'working'} onClick={() => void clear()}>Confirm clear</Button>
            <Button variant="outline" disabled={phase === 'working'} onClick={() => setPhase('idle')}>Not yet</Button>
          </div>
        </div>
      )}
      {phase === 'working' && !guardianRequired && (
        <div className="checkin__acts">
          <Button variant="primary" disabled>Yes, cleared</Button>
          <Button variant="outline" disabled>Not yet</Button>
        </div>
      )}
    </div>
  )
}

export function CheckinCard({ today, onSaved }: { today: ReadinessToday; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<FieldKey, number | null>>({
    sleep_hours: today.checkin?.sleep_hours ?? null,
    stress: today.checkin?.stress ?? null,
    soreness: today.checkin?.soreness ?? null,
  })
  const [pain, setPain] = useState<PainInput[]>([])
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [clearNote, setClearNote] = useState<string | null>(null)
  const onCleared = (text: string) => {
    setClearNote(text || null)
    onSaved()
  }

  const setField = (key: FieldKey, raw: string, min: number, max: number) => {
    const n = raw === '' ? null : Number(raw)
    setValues({ ...values, [key]: n == null || !Number.isFinite(n) ? null : Math.min(max, Math.max(min, n)) })
  }
  const setPainAt = (i: number, next: Partial<PainInput>) => setPain(pain.map((p, k) => (k === i ? { ...p, ...next } : p)))
  const toggleFlag = (i: number, flag: string) => {
    const has = pain[i].red_flags.includes(flag)
    setPainAt(i, { red_flags: has ? pain[i].red_flags.filter((f) => f !== flag) : [...pain[i].red_flags, flag] })
  }
  const nothing = values.sleep_hours == null && values.stress == null && values.soreness == null && !pain.length

  async function save() {
    if (busy || nothing) return
    setBusy(true)
    const res = await submitCheckin({ ...values, pain })
    setBusy(false)
    setMessage(res.text || null)
    if (res.ok) {
      success()
      setPain([])
      onSaved()
    }
  }

  const r = today.readiness
  return (
    <div className="checkin checkin--daily fade-rise">
      <button
        type="button"
        className="checkin__toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Daily check-in: ${summary(today)}`}
      >
        <span className="checkin__label">Check-in</span>
        <span className="checkin__summary">{summary(today)}</span>
        <ChevronRight size={14} strokeWidth={2} style={{ transform: open ? 'rotate(90deg)' : undefined, color: 'var(--text-dim)' }} />
      </button>

      {today.blocked.map((b) => (
        <BlockedRow key={`checkin:${b.region}`} region={b.region} reason={b.reason} kind="checkin" otherBlocks={b.also_rule === true} guardianRequired={today.guardian_required === true} onCleared={onCleared} />
      ))}
      {(today.rule_blocked ?? []).map((b) => (
        <BlockedRow key={`rule:${b.region}`} region={b.region} reason={b.reason} kind="rule" otherBlocks={b.also_checkin} guardianRequired={today.guardian_required === true} onCleared={onCleared} />
      ))}
      {(today.temporary_blocked ?? []).map((b) => (
        <div key={`temp:${b.region}`} className="checkin__blocked">
          <p className="text-sm">
            <strong>{regionLabel(b.region)}: no loading today or next session.</strong> {b.reason}
          </p>
        </div>
      ))}
      {clearNote && <p className="text-xs text-dim checkin__note">{clearNote}</p>}
      {r.refer_out && <p className="text-xs text-dim checkin__note">{r.refer_out}</p>}
      {r.flags.length > 0 && (
        <p className="text-xs text-dim checkin__note">
          {r.flags.map((f) => f.message).join(' · ')} — {r.level === 'pull_hiit_plyo' ? 'accessories trimmed, HIIT and plyos pulled today' : 'accessories trimmed today'}. Main lifts stay.
        </p>
      )}

      {open && (
        <>
          <div className="checkin__grid">
            {FIELDS.map((f) => (
              <label key={f.key} className="checkin__field">
                <span>{f.label}</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  aria-label={f.label}
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value, f.min, f.max)}
                />
              </label>
            ))}
          </div>

          {pain.map((p, i) => (
            <div key={p.region} className="checkin__pain">
              <label className="checkin__field">
                <span>{regionLabel(p.region)} pain 0–10</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  aria-label={`${regionLabel(p.region)} pain 0 to 10`}
                  min={0}
                  max={10}
                  step={1}
                  value={p.score}
                  onChange={(e) => setPainAt(i, { score: Math.min(10, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
                />
              </label>
              <div className="checkin__flags" role="group" aria-label={`${regionLabel(p.region)} red flags`}>
                {today.red_flags.map((flag) => (
                  <button
                    key={flag}
                    type="button"
                    className={`checkin__flag${p.red_flags.includes(flag) ? ' checkin__flag--on' : ''}`}
                    aria-pressed={p.red_flags.includes(flag)}
                    onClick={() => toggleFlag(i, flag)}
                  >
                    {RED_FLAG_LABEL[flag] ?? flag}
                  </button>
                ))}
              </div>
              <button type="button" className="checkin__clear" onClick={() => setPain(pain.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}

          <label className="checkin__field" style={{ marginTop: 10 }}>
            <span>Pain somewhere?</span>
            <select
              className="input"
              value={adding}
              onChange={(e) => {
                const region = e.target.value
                setAdding('')
                if (region && !pain.some((p) => p.region === region)) setPain([...pain, { region, score: 0, red_flags: [] }])
              }}
            >
              <option value="">Add a region…</option>
              {today.regions.filter((x) => !pain.some((p) => p.region === x)).map((x) => (
                <option key={x} value={x}>{regionLabel(x)}</option>
              ))}
            </select>
          </label>

          <div className="checkin__acts">
            <Button variant="primary" disabled={busy || nothing} onClick={() => void save()}>{busy ? 'Saving…' : 'Log check-in'}</Button>
          </div>
          {message && <p className="text-xs text-dim checkin__note">{message}</p>}
          <p className="text-xs text-dim checkin__note">
            Pain over 3/10 lightens that area today. Over 5, or worse the next morning (4 or more), stops loading it today and next session. A red flag, over 5 twice in 14 days, or pain rising 3 sessions running stops it until a clinician clears it (under 18, every block does).
          </p>
        </>
      )}
    </div>
  )
}
