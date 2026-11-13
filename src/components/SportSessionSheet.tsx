import { useMemo, useState } from 'react'
import { Button, Sheet } from './ui'
import { SessionEffort } from './SessionEffort'
import {
  cleanSportActivity, cleanSportMinutes, loggableDates, sportSummary, SPORT_MINUTE_CHOICES, SPORT_PAIN_REGIONS,
  SPORT_RED_FLAGS, SPORT_STARTERS, type SportPain,
} from '../engine/sportLog'
import { buildSportLogPending } from '../engine/sportLogPending'
import type { PendingSession } from '../engine'
import { commitPending, discardQueuedSportLog, enqueueSession } from '../lib/workoutOutbox'
import { invalidateLoopViews } from '../lib/loopCache'
import { deleteSportLog, updateSportLog, type SportLogView } from '../lib/sportSessionApi'
import { RED_FLAG_LABEL, regionLabel } from '../lib/readiness'

// =============================================================================
// Add session (log_session_v1, spec section 13) — the game, the run, the class.
// What it was, which day, how long, how hard (session RPE), any pain, a note.
// Durable before any network: a new log goes to the workout outbox first and
// commits behind the sheet closing, like "Log outside the plan".
//
// The same sheet edits and deletes: a log still in the outbox is changed or
// discarded on the device; a synced one is changed through the Worker, which
// logs the change and re-reads session load and U7.
// =============================================================================

export type SportSheetEdit =
  | { kind: 'pending'; session: PendingSession }
  | { kind: 'committed'; log: SportLogView }

interface Props {
  athleteId: string
  athleteName: string | null
  /** The athlete's calendar date (YYYY-MM-DD). */
  today: string
  /** "Log this session" on a planned card: the Worker closes it with the first log that day. */
  planned?: { id: string; name: string } | null
  edit?: SportSheetEdit | null
  onClose: () => void
  /** What to say once it's queued or saved, e.g. "Basketball · 25 min · effort 6". */
  onDone: (summary: string) => void
}

function dayLabel(date: string, today: string, i: number): string {
  if (i === 0 && date === today) return 'Today'
  if (i === 1) return 'Yesterday'
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
}

function initialOf(edit: SportSheetEdit | null | undefined) {
  if (edit?.kind === 'pending' && edit.session.sportLog) {
    const s = edit.session.sportLog
    return { activity: s.activity, date: s.date, minutes: String(s.minutes), effort: s.sessionRpe as number | null, pain: s.pain, notes: s.notes ?? '' }
  }
  if (edit?.kind === 'committed') {
    const l = edit.log
    return { activity: l.activity, date: l.date, minutes: String(l.duration_min), effort: l.session_rpe, pain: l.pain, notes: l.notes ?? '' }
  }
  return null
}

export function SportSessionSheet({ athleteId, athleteName, today, planned = null, edit = null, onClose, onDone }: Props) {
  const init = useMemo(() => initialOf(edit), [edit])
  const dates = useMemo(() => loggableDates(today), [today])
  const starterHit = (a: string) => SPORT_STARTERS.some((s) => s !== 'Other' && s.toLowerCase() === a.toLowerCase())
  const [activity, setActivity] = useState(init?.activity ?? (planned && /basketball/i.test(planned.name) ? 'Basketball' : ''))
  const [other, setOther] = useState(init ? !starterHit(init.activity) : false)
  const [date, setDate] = useState(init?.date ?? today)
  const [minutesText, setMinutesText] = useState(init?.minutes ?? '')
  const [effort, setEffort] = useState<number | null>(init?.effort ?? null)
  const [pain, setPain] = useState<SportPain[]>(init?.pain ?? [])
  const [notes, setNotes] = useState(init?.notes ?? '')
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const name = cleanSportActivity(activity)
  const minutes = cleanSportMinutes(minutesText)
  // An old log keeps its date even outside the window; only a new date has to be inside it.
  const dateOk = dates.includes(date) || (init != null && date === init.date)
  const ready = !!name && minutes != null && effort != null && effort >= 1 && dateOk && !busy
  const fields = () => ({ activity: name!, date, duration_min: minutes!, session_rpe: effort!, pain, notes: notes.trim() || null })

  function queue(id: string, plannedId: string | null) {
    const pending = buildSportLogPending({
      id, athleteId, athleteName, fields: fields(), plannedRoutineId: plannedId, today, queuedAt: new Date().toISOString(),
    })
    enqueueSession(pending)            // durable before any network
    invalidateLoopViews()
    onDone(sportSummary(fields()))
    void commitPending(pending).catch(() => { /* stays queued, shown as Syncing; the outbox retries */ })
  }

  async function save() {
    if (!ready) return
    setMessage(null)
    if (!edit) return queue(crypto.randomUUID(), planned?.id ?? null)
    if (edit.kind === 'pending') return queue(edit.session.id, edit.session.sportLog?.plannedRoutineId ?? null)
    // Synced: send only what changed (an old log's date stays as it was).
    const l = edit.log
    const f = fields()
    const patch: Record<string, unknown> = {}
    if (f.activity !== l.activity) patch.activity = f.activity
    if (f.date !== l.date) patch.date = f.date
    if (f.duration_min !== l.duration_min) patch.duration_min = f.duration_min
    if (f.session_rpe !== l.session_rpe) patch.session_rpe = f.session_rpe
    if (JSON.stringify(f.pain) !== JSON.stringify(l.pain)) patch.pain = f.pain
    if ((f.notes ?? null) !== (l.notes ?? null)) patch.notes = f.notes ?? ''
    if (!Object.keys(patch).length) return onClose()
    setBusy(true)
    try {
      const text = await updateSportLog(l.workout_id, patch)
      invalidateLoopViews()
      onDone(text)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Couldn\'t save. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!edit || busy) return
    setMessage(null)
    if (edit.kind === 'pending') {
      if (!discardQueuedSportLog(edit.session.id)) {
        setMessage('It\'s syncing right now. Try again in a moment, or delete it from History once it has synced.')
        return
      }
      onDone('Deleted.')
      return
    }
    setBusy(true)
    try {
      const text = await deleteSportLog(edit.log.workout_id)
      invalidateLoopViews()
      onDone(text)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Couldn\'t delete. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={edit ? 'Edit session' : planned ? 'Log this session' : 'Add session'}
      subtitle={edit ? undefined : planned ? `${planned.name}. Logging it closes this card for the day; no need to finish the primer sets first.` : 'A game, a run, a class. Counts toward your conditioning load.'}
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" full disabled={!ready} onClick={() => void save()}>
            {busy ? 'Saving…' : edit ? 'Save' : 'Log it'}
          </Button>
          {edit && (
            <Button variant="ghost" full style={{ marginTop: 6 }} disabled={busy} onClick={() => void remove()}>
              Delete this log
            </Button>
          )}
          {message && <p className="text-xs text-dim" role="status" style={{ marginTop: 8 }}>{message}</p>}
        </>
      }
    >
      <span className="section-header field-label" style={{ marginTop: 0 }} id="ss-what">What was it?</span>
      <div className="pick-row" role="group" aria-labelledby="ss-what">
        {SPORT_STARTERS.filter((s) => s !== 'Other').map((c) => (
          <button
            key={c}
            type="button"
            className="pick"
            aria-pressed={!other && name?.toLowerCase() === c.toLowerCase()}
            onClick={() => { setOther(false); setActivity(c) }}
          >
            {c}
          </button>
        ))}
        <button type="button" className="pick" aria-pressed={other} onClick={() => { setOther(true); if (!other) setActivity('') }}>
          Other
        </button>
      </div>
      {other && (
        <input
          className="input"
          style={{ marginTop: 10 }}
          type="text"
          maxLength={40}
          placeholder="Climbing, padel, a spin class…"
          aria-label="What was it?"
          value={activity}
          onChange={(e) => setActivity(e.target.value)}
        />
      )}

      <span className="section-header field-label" id="ss-when">When</span>
      <div className="pick-row" role="radiogroup" aria-labelledby="ss-when">
        {dates.map((d, i) => (
          <button key={d} type="button" role="radio" className="pick" aria-checked={date === d} onClick={() => setDate(d)}>
            {dayLabel(d, today, i)}
          </button>
        ))}
        {init && !dates.includes(init.date) && (
          <button type="button" role="radio" className="pick" aria-checked={date === init.date} onClick={() => setDate(init.date)}>
            {new Date(`${init.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </button>
        )}
      </div>

      <span className="section-header field-label" id="ss-long">How long?</span>
      <div className="pick-row" role="group" aria-labelledby="ss-long">
        {SPORT_MINUTE_CHOICES.map((m) => (
          <button key={m} type="button" className="pick pick--num" aria-pressed={minutes === m} onClick={() => setMinutesText(String(m))}>
            {m}
          </button>
        ))}
        <input
          className="input num"
          style={{ width: 96, minHeight: 44 }}
          type="number"
          inputMode="numeric"
          min={1}
          max={600}
          placeholder="min"
          aria-label="Minutes"
          value={SPORT_MINUTE_CHOICES.some((m) => String(m) === minutesText) ? '' : minutesText}
          onChange={(e) => setMinutesText(e.target.value)}
        />
      </div>

      <div style={{ marginTop: 18 }}>
        <SessionEffort value={effort} onChange={setEffort} min={1} />
      </div>

      {/* Pain is optional, but always asked: it is what U7 reads. */}
      <span className="section-header field-label" id="ss-pain" style={{ marginTop: 0 }}>Any pain?</span>
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
              onChange={(e) => setPain(pain.map((x, k) => (k === i ? { ...x, score: Math.min(10, Math.max(0, Math.round(Number(e.target.value) || 0))) } : x)))}
            />
          </label>
          <div className="checkin__flags" role="group" aria-label={`${regionLabel(p.region)} red flags`}>
            {SPORT_RED_FLAGS.map((flag) => (
              <button
                key={flag}
                type="button"
                className={`checkin__flag${p.red_flags.includes(flag) ? ' checkin__flag--on' : ''}`}
                aria-pressed={p.red_flags.includes(flag)}
                onClick={() => setPain(pain.map((x, k) => (k === i
                  ? { ...x, red_flags: x.red_flags.includes(flag) ? x.red_flags.filter((f) => f !== flag) : [...x.red_flags, flag] }
                  : x)))}
              >
                {RED_FLAG_LABEL[flag] ?? flag}
              </button>
            ))}
          </div>
          <button type="button" className="checkin__clear" onClick={() => setPain(pain.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <label className="checkin__field" style={{ marginTop: 6 }}>
        <span>{pain.length ? 'Somewhere else?' : 'None, or add where it hurts'}</span>
        <select
          className="input"
          aria-labelledby="ss-pain"
          value={adding}
          onChange={(e) => {
            const region = e.target.value
            setAdding('')
            if (region && !pain.some((p) => p.region === region)) setPain([...pain, { region, score: 0, red_flags: [] }])
          }}
        >
          <option value="">Add a region…</option>
          {SPORT_PAIN_REGIONS.filter((x) => !pain.some((p) => p.region === x)).map((x) => (
            <option key={x} value={x}>{regionLabel(x)}</option>
          ))}
        </select>
      </label>

      <label className="checkin__field" style={{ marginTop: 14 }}>
        <span>Notes</span>
        <textarea
          className="input"
          rows={2}
          maxLength={2000}
          placeholder="Optional"
          aria-label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
    </Sheet>
  )
}
