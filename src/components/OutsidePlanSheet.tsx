import { useMemo, useState } from 'react'
import { Button, Sheet } from './ui'
import { SessionEffort } from './SessionEffort'
import {
  activityChoices, buildOutsidePlanSession, cleanActivity, cleanMinutes, MINUTE_CHOICES,
} from '../engine/outsidePlan'
import { enqueueSession, commitPending } from '../lib/workoutOutbox'
import { invalidateLoopViews } from '../lib/loopCache'
import { recentActivities, saveActivity } from '../lib/outsidePlanMemory'
import type { ExposureTags } from '../types/database'

// =============================================================================
// Log outside the plan — the class, the run with a friend, the match. Four taps
// in the common case: what, how long, how hard, Log it. Durable before any
// network, like a finished session: it goes to the outbox first and commits
// behind the sheet closing.
//
// It goes on the log, never in the planned week (engine/outsidePlan.ts says why).
// =============================================================================

interface Props {
  athleteId: string
  athleteName: string | null
  onClose: () => void
  /** What to say once it's queued, e.g. "BJJ · 90 min · effort 7". */
  onLogged: (summary: string) => void
}

const TAGS: Array<{ key: keyof ExposureTags; label: string }> = [
  { key: 'impact', label: 'Running or jumping' },
  { key: 'sprint', label: 'Sprinting' },
  { key: 'contact', label: 'Contact' },
]

// The day it happened, stamped at local noon like a backdated session, so the
// day never slips across a zone boundary. Today is now.
function performedAtFor(when: 'today' | 'yesterday'): string {
  if (when === 'today') return new Date().toISOString()
  const d = new Date()
  d.setDate(d.getDate() - 1)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

export function OutsidePlanSheet({ athleteId, athleteName, onClose, onLogged }: Props) {
  const choices = useMemo(() => activityChoices(recentActivities()), [])
  const [activity, setActivity] = useState('')
  const [other, setOther] = useState(false)
  const [minutesText, setMinutesText] = useState('')
  const [effort, setEffort] = useState<number | null>(null)
  const [when, setWhen] = useState<'today' | 'yesterday'>('today')
  const [tags, setTags] = useState<ExposureTags>({})

  const name = cleanActivity(activity)
  const minutes = cleanMinutes(minutesText)
  const ready = !!name && minutes != null && effort != null

  function log() {
    if (!ready) return
    const now = new Date().toISOString()
    const pending = buildOutsidePlanSession({
      id: crypto.randomUUID(),
      athleteId,
      athleteName,
      activity: name!,
      minutes: minutes!,
      sessionRpe: effort!,
      exposure: tags,
      performedAt: performedAtFor(when),
      queuedAt: now,
    })
    enqueueSession(pending)            // durable before any network
    saveActivity(name!)
    invalidateLoopViews()
    onLogged(`${pending.outsidePlan!.activity} · ${minutes} min · effort ${effort}`)
    void commitPending(pending).catch(() => { /* stays queued; the outbox retries */ })
  }

  return (
    <Sheet
      title="Log outside the plan"
      subtitle="A class, a run, a match. It goes on your log, not into your plan's week."
      onClose={onClose}
      actions={
        <Button variant="primary" full disabled={!ready} onClick={log}>
          Log it
        </Button>
      }
    >
      <span className="section-header field-label" style={{ marginTop: 0 }} id="op-what">What was it?</span>
      <div className="pick-row" role="group" aria-labelledby="op-what">
        {choices.map((c) => (
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
        <button
          type="button"
          className="pick"
          aria-pressed={other}
          onClick={() => { setOther(true); setActivity('') }}
        >
          Something else
        </button>
      </div>
      {other && (
        <input
          className="input"
          style={{ marginTop: 10 }}
          type="text"
          autoFocus
          maxLength={40}
          placeholder="Climbing, padel, a spin class…"
          aria-label="What was it?"
          value={activity}
          onChange={(e) => setActivity(e.target.value)}
        />
      )}

      <span className="section-header field-label" id="op-long">How long?</span>
      <div className="pick-row" role="group" aria-labelledby="op-long">
        {MINUTE_CHOICES.map((m) => (
          <button
            key={m}
            type="button"
            className="pick pick--num"
            aria-pressed={minutes === m}
            onClick={() => setMinutesText(String(m))}
          >
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
          value={MINUTE_CHOICES.some((m) => String(m) === minutesText) ? '' : minutesText}
          onChange={(e) => setMinutesText(e.target.value)}
        />
      </div>

      <div style={{ marginTop: 18 }}>
        <SessionEffort value={effort} onChange={setEffort} />
      </div>

      <span className="section-header field-label" id="op-when" style={{ marginTop: 0 }}>When</span>
      <div className="pick-row" role="radiogroup" aria-labelledby="op-when">
        {(['today', 'yesterday'] as const).map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            className="pick"
            aria-checked={when === w}
            onClick={() => setWhen(w)}
          >
            {w === 'today' ? 'Today' : 'Yesterday'}
          </button>
        ))}
      </div>

      <span className="section-header field-label" id="op-tags">Did it have any of these?</span>
      <div className="pick-row" role="group" aria-labelledby="op-tags">
        {TAGS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="pick"
            aria-pressed={!!tags[t.key]}
            onClick={() => setTags((prev) => ({ ...prev, [t.key]: !prev[t.key] }))}
          >
            {t.label}
          </button>
        ))}
      </div>
    </Sheet>
  )
}
