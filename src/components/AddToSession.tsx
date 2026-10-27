import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Minus, Play, Plus, Search } from 'lucide-react'
import { Sheet } from './ui'
import {
  searchLibrary, findLibraryExercise, PATTERN_LABEL, EQUIPMENT_LABEL, TRACKING_LABEL,
  type LibraryExercise,
} from '../engine/exerciseLibrary'
import {
  buildAddition, suggestAdditions, browseLibrary, BROWSE_CATEGORIES, INTERVAL_MOVEMENTS,
} from '../engine/addExercise'
import {
  INTERVAL_PRESETS, INTERVAL_LIMITS, manualPlan, intervalExercise, blockSeconds, fmtClock,
  fmtDuration, stepSeconds, secondsFromReps, describePlan, type IntervalPlan,
} from '../engine/intervals'
import { loadLastIntervals, saveLastIntervals, recentAdditions, rememberAddition } from '../lib/addMemory'
import { primeCueAudio } from '../lib/intervalCues'
import type { UnitContext } from '../lib/units'
import type { ExerciseTemplate, SetLog } from '../types/database'

// =============================================================================
// Add to session — the + that used to only add a set.
//
// One sheet, two tabs, both built for the rack: nothing here asks for more
// than it needs. An exercise arrives with a dose already on it (your last
// sets of it, or a sane default for what it is), so adding one is pick → Add.
// An interval block opens on the last one you built, so a finisher is open →
// Start, and the timer is running before the sheet has finished leaving.
// =============================================================================

type Tab = 'exercise' | 'intervals'

const CATEGORY_LABEL: Record<typeof BROWSE_CATEGORIES[number], string> = {
  'Lower Chain': 'Lower',
  'Posterior Chain': 'Posterior',
  'Upper Chain': 'Upper',
  'Core': 'Core',
  'Conditioning': 'Engine',
}

const DEFAULT_INTERVALS = { name: 'Assault Bike', work: 30, rest: 30, rounds: 10, sets: 1 }

interface AddToSessionProps {
  initialTab: Tab
  sessionNames: string[]
  u: UnitContext
  /** The athlete's most recent sets of a movement anywhere in the program. */
  lastSetsFor: (name: string) => SetLog[] | null
  /** Unscreened (first) session: ballistic/maximal movements aren't offered. */
  screened: boolean
  onAdd: (ex: ExerciseTemplate) => void
  /** Add the block and start it — called from inside the tap, audio unlocked. */
  onStartIntervals: (ex: ExerciseTemplate) => void
  onClose: () => void
}

export function AddToSessionSheet({
  initialTab, sessionNames, u, lastSetsFor, screened, onAdd, onStartIntervals, onClose,
}: AddToSessionProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  return (
    <Sheet title="Add to session" subtitle="Just for today — your program stays as it is" onClose={onClose}>
      <div className="tabseg" role="tablist" aria-label="What to add">
        <span className="tabseg__ind" style={{ transform: tab === 'intervals' ? 'translateX(100%)' : undefined }} aria-hidden />
        <button type="button" role="tab" aria-selected={tab === 'exercise'} className="tabseg__opt" onClick={() => setTab('exercise')}>
          Exercise
        </button>
        <button type="button" role="tab" aria-selected={tab === 'intervals'} className="tabseg__opt" onClick={() => setTab('intervals')}>
          Intervals
        </button>
      </div>
      {tab === 'exercise' ? (
        <ExercisePicker
          sessionNames={sessionNames}
          u={u}
          lastSetsFor={lastSetsFor}
          screened={screened}
          onAdd={(ex) => { rememberAddition(ex.name); onAdd(ex) }}
        />
      ) : (
        <IntervalBuilder
          initial={loadLastIntervals() ?? DEFAULT_INTERVALS}
          primaryLabel="Start now"
          secondaryLabel="Add as finisher"
          onPrimary={(ex) => onStartIntervals({ ...ex, added: true })}
          onSecondary={(ex) => onAdd({ ...ex, added: true })}
        />
      )}
    </Sheet>
  )
}

// ---- exercises ------------------------------------------------------------------

function doseText(ex: ExerciseTemplate): string {
  return `${ex.sets}×${ex.reps}`
}

function lastTimeText(sets: SetLog[] | null, u: UnitContext): string | null {
  const done = (sets ?? []).filter((s) => s.done || s.reps != null || s.duration != null)
  if (!done.length) return null
  const top = done.reduce<number | null>((m, s) => (s.weight != null && (m == null || s.weight > m) ? s.weight : m), null)
  const reps = done.map((s) => s.reps).filter((r): r is number => r != null)
  const secs = done.map((s) => s.duration).filter((d): d is number => d != null)
  const body = secs.length && !reps.length
    ? `${done.length}×${fmtDuration(Math.max(...secs))}`
    : `${done.length}×${reps.length ? Math.max(...reps) : '?'}`
  return `Last time ${body}${top != null ? ` · top ${u.fmt(top)}${u.unit}` : ''}`
}

type DoseKind = 'reps' | 'time' | 'fixed'

function doseKind(ex: ExerciseTemplate): DoseKind {
  if (ex.tracking_type === 'time' && secondsFromReps(ex.reps) != null) return 'time'
  if ((ex.tracking_type === 'weight_reps' || ex.tracking_type === 'bodyweight_reps') && /^\d+$/.test(ex.reps)) return 'reps'
  return 'fixed'
}

function ExercisePicker({
  sessionNames, u, lastSetsFor, screened, onAdd,
}: {
  sessionNames: string[]
  u: UnitContext
  lastSetsFor: (name: string) => SetLog[] | null
  screened: boolean
  onAdd: (ex: ExerciseTemplate) => void
}) {
  const [query, setQuery] = useState('')
  const [shelf, setShelf] = useState<'today' | typeof BROWSE_CATEGORIES[number]>('today')
  const [picked, setPicked] = useState<ExerciseTemplate | null>(null)

  // An unscreened first session never gets a ballistic movement offered — the
  // same rule the swap sheet keeps.
  const allowed = (e: LibraryExercise) => screened || !e.contra
  const q = query.trim()
  const list = (
    q ? searchLibrary(q, 24)
    : shelf === 'today' ? suggestAdditions(sessionNames, recentAdditions(), 10)
    : browseLibrary(shelf)
  ).filter(allowed)
  const exactHit = list.some((e) => e.name.toLowerCase() === q.toLowerCase())

  const pick = (name: string) => setPicked(buildAddition(name, lastSetsFor(name)))

  if (picked) {
    const lib = findLibraryExercise(picked.name)
    const last = lastTimeText(lastSetsFor(picked.name), u)
    const kind = doseKind(picked)
    const secs = secondsFromReps(picked.reps) ?? 30
    const repsN = Number(picked.reps) || 10
    const setReps = (reps: string) => setPicked({ ...picked, reps })
    return (
      <div className="add-config" key={picked.name}>
        <button type="button" className="add-back" onClick={() => setPicked(null)}>
          <ChevronLeft size={16} strokeWidth={2} /> All exercises
        </button>
        <h3 className="add-config__name">{picked.name}</h3>
        <p className="text-xs text-dim" style={{ marginTop: 4 }}>
          {lib
            ? `${PATTERN_LABEL[lib.pattern]} · ${EQUIPMENT_LABEL[lib.equipment]} · logs ${TRACKING_LABEL[lib.tracking]}`
            : `Logs ${TRACKING_LABEL[picked.tracking_type ?? 'weight_reps']}`}
        </p>
        {last && <p className="add-config__last num text-xs">{last}</p>}

        <div className="stepper-grid stepper-grid--two">
          <Stepper
            label="Sets"
            value={String(picked.sets)}
            onDec={() => setPicked({ ...picked, sets: Math.max(1, picked.sets - 1) })}
            onInc={() => setPicked({ ...picked, sets: Math.min(10, picked.sets + 1) })}
            decDisabled={picked.sets <= 1}
            incDisabled={picked.sets >= 10}
          />
          {kind === 'reps' && (
            <Stepper
              label="Reps"
              value={String(repsN)}
              onDec={() => setReps(String(Math.max(1, repsN - 1)))}
              onInc={() => setReps(String(Math.min(50, repsN + 1)))}
              decDisabled={repsN <= 1}
              incDisabled={repsN >= 50}
            />
          )}
          {kind === 'time' && (
            <Stepper
              label="Time"
              value={fmtDuration(secs)}
              onDec={() => setReps(fmtDuration(stepSeconds(secs, -1, 5)))}
              onInc={() => setReps(fmtDuration(stepSeconds(secs, 1, 5)))}
              decDisabled={secs <= 5}
            />
          )}
          {kind === 'fixed' && (
            <div className="stepper">
              <span className="stepper__label">Each set</span>
              <span className="stepper__value num">{picked.reps}</span>
            </div>
          )}
        </div>

        <div className="sheet-actions">
          <button type="button" className="btn btn--primary btn--full" onClick={() => onAdd(picked)}>
            <Plus size={18} strokeWidth={2.4} style={{ marginRight: 8 }} />
            Add {doseText(picked)} to session
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <label className="add-search">
        <Search size={16} strokeWidth={2} aria-hidden />
        <input
          type="search"
          className="add-search__input"
          placeholder="Search 300+ movements"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search exercises"
          enterKeyHint="search"
        />
      </label>

      {!q && (
        <div className="add-shelves" role="tablist" aria-label="Browse">
          {(['today', ...BROWSE_CATEGORIES] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={shelf === s}
              className={`add-shelf${shelf === s ? ' add-shelf--on' : ''}`}
              onClick={() => setShelf(s)}
            >
              {s === 'today' ? 'For today' : CATEGORY_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      <div className="add-list stagger" key={q ? `q` : shelf}>
        {list.map((e) => {
          const dose = buildAddition(e.name, lastSetsFor(e.name))
          return (
            <button key={e.name} type="button" className="add-row" onClick={() => pick(e.name)}>
              <span className="add-row__main">
                <span className="add-row__name">{e.name}</span>
                <span className="add-row__sub">{PATTERN_LABEL[e.pattern]} · {EQUIPMENT_LABEL[e.equipment]}</span>
              </span>
              <span className="add-row__dose num">{doseText(dose)}</span>
              <ChevronRight size={16} strokeWidth={2} className="add-row__chev" aria-hidden />
            </button>
          )
        })}
        {q && !exactHit && (
          <button type="button" className="add-row" onClick={() => pick(q.slice(0, 60))}>
            <span className="add-row__main">
              <span className="add-row__name">Use “{q.slice(0, 60)}”</span>
              <span className="add-row__sub">Log it under the name you typed</span>
            </span>
            <ChevronRight size={16} strokeWidth={2} className="add-row__chev" aria-hidden />
          </button>
        )}
        {!q && shelf === 'today' && list.length === 0 && (
          <p className="text-sm text-dim" style={{ padding: '14px 0' }}>
            Today already covers the usual gaps — browse a category or search.
          </p>
        )}
      </div>
    </div>
  )
}

// ---- intervals --------------------------------------------------------------------

function Stepper({
  label, value, onDec, onInc, decDisabled, incDisabled, sub,
}: {
  label: string
  value: ReactNode
  onDec: () => void
  onInc: () => void
  decDisabled?: boolean
  incDisabled?: boolean
  sub?: string
}) {
  return (
    <div className="stepper">
      <span className="stepper__label">{label}</span>
      <span className="stepper__value num" key={String(value)}>{value}</span>
      {sub && <span className="stepper__sub">{sub}</span>}
      <div className="stepper__btns">
        <button type="button" className="stepper__btn" onClick={onDec} disabled={decDisabled} aria-label={`Less ${label.toLowerCase()}`}>
          <Minus size={18} strokeWidth={2.4} />
        </button>
        <button type="button" className="stepper__btn" onClick={onInc} disabled={incDisabled} aria-label={`More ${label.toLowerCase()}`}>
          <Plus size={18} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}

export interface IntervalDraft {
  name: string
  work: number
  rest: number
  rounds: number
  sets: number
}

/**
 * The block builder. Presets set three numbers at once; the steppers move one;
 * the total is always on screen, because "how long is this going to take" is
 * the question a finisher gets asked before it gets started.
 */
export function IntervalBuilder({
  initial, lockName, primaryLabel, secondaryLabel, onPrimary, onSecondary,
}: {
  initial: IntervalDraft
  /** Re-dosing a programmed block: the movement is the slot's, not up for change here. */
  lockName?: boolean
  primaryLabel: string
  secondaryLabel: string
  onPrimary: (ex: ExerciseTemplate) => void
  onSecondary: (ex: ExerciseTemplate) => void
}) {
  const [d, setD] = useState<IntervalDraft>(initial)
  const [otherOpen, setOtherOpen] = useState(false)
  const [query, setQuery] = useState('')
  const plan: IntervalPlan = manualPlan(d)
  const total = blockSeconds(plan)
  const workTotal = plan.work * plan.rounds * plan.sets
  const set = (patch: Partial<IntervalDraft>) => setD((prev) => ({ ...prev, ...patch }))
  const movements: string[] = INTERVAL_MOVEMENTS.includes(d.name as typeof INTERVAL_MOVEMENTS[number])
    ? [...INTERVAL_MOVEMENTS]
    : [d.name, ...INTERVAL_MOVEMENTS]
  const results = query.trim() ? searchLibrary(query, 8) : []

  const commit = (fn: (ex: ExerciseTemplate) => void) => {
    saveLastIntervals({ name: d.name, work: plan.work, rest: plan.rest, rounds: plan.rounds, sets: plan.sets })
    fn(intervalExercise(d.name, plan))
  }

  const last = loadLastIntervals()
  const lastIsPreset = last && INTERVAL_PRESETS.some((p) => p.work === last.work && p.rest === last.rest && p.rounds === last.rounds)
  const isOn = (p: { work: number; rest: number; rounds: number }) =>
    d.work === p.work && d.rest === p.rest && d.rounds === p.rounds

  return (
    <div className="ivb">
      <div className="ivb__presets" role="group" aria-label="Presets">
        {last && !lastIsPreset && !lockName && (
          <button
            type="button"
            className={`ivb__preset${isOn(last) && d.sets === last.sets ? ' ivb__preset--on' : ''}`}
            onClick={() => set({ work: last.work, rest: last.rest, rounds: last.rounds, sets: last.sets })}
          >
            <span className="ivb__preset-label">Last</span>
            <span className="ivb__preset-sub num">{last.rounds}×{last.work}/{last.rest}</span>
          </button>
        )}
        {INTERVAL_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`ivb__preset${isOn(p) ? ' ivb__preset--on' : ''}`}
            onClick={() => set({ work: p.work, rest: p.rest, rounds: p.rounds, sets: 1 })}
          >
            <span className="ivb__preset-label">{p.label}</span>
            <span className="ivb__preset-sub num">
              {p.rest === 0 ? `${p.rounds} min` : `${p.rounds} rounds`}
            </span>
          </button>
        ))}
      </div>

      <div className="stepper-grid">
        <Stepper
          label="Work"
          value={fmtDuration(d.work)}
          onDec={() => set({ work: stepSeconds(d.work, -1, INTERVAL_LIMITS.MIN_WORK) })}
          onInc={() => set({ work: stepSeconds(d.work, 1, INTERVAL_LIMITS.MIN_WORK) })}
          decDisabled={d.work <= INTERVAL_LIMITS.MIN_WORK}
        />
        <Stepper
          label="Rest"
          value={d.rest === 0 ? 'None' : fmtDuration(d.rest)}
          onDec={() => set({ rest: stepSeconds(d.rest, -1, 0) })}
          onInc={() => set({ rest: Math.min(INTERVAL_LIMITS.MAX_REST, stepSeconds(d.rest, 1, 0)) })}
          decDisabled={d.rest <= 0}
        />
        <Stepper
          label="Rounds"
          value={String(d.rounds)}
          onDec={() => set({ rounds: Math.max(1, d.rounds - 1) })}
          onInc={() => set({ rounds: Math.min(INTERVAL_LIMITS.MAX_ROUNDS, d.rounds + 1) })}
          decDisabled={d.rounds <= 1}
          incDisabled={d.rounds >= INTERVAL_LIMITS.MAX_ROUNDS}
        />
        <Stepper
          label="Sets"
          value={String(d.sets)}
          sub={d.sets > 1 ? `${fmtDuration(plan.setRest)} between` : undefined}
          onDec={() => set({ sets: Math.max(1, d.sets - 1) })}
          onInc={() => set({ sets: Math.min(INTERVAL_LIMITS.MAX_SETS, d.sets + 1) })}
          decDisabled={d.sets <= 1}
          incDisabled={d.sets >= INTERVAL_LIMITS.MAX_SETS}
        />
      </div>

      <div className="ivb__total">
        <span className="ivb__total-clock num" key={total}>{fmtClock(total)}</span>
        <span className="ivb__total-sub">{describePlan(plan)} · {fmtClock(workTotal)} of work</span>
      </div>

      {lockName ? (
        <p className="text-xs text-dim" style={{ marginTop: 14 }}>On {d.name} — swap the movement from the session.</p>
      ) : (
        <div style={{ marginTop: 18 }}>
          <p className="section-header" style={{ marginBottom: 8 }}>On</p>
          <div className="ivb__moves">
            {movements.map((m) => (
              <button
                key={m}
                type="button"
                className={`howto-tag${d.name === m ? ' howto-tag--on' : ''}`}
                aria-pressed={d.name === m}
                onClick={() => { set({ name: m }); setOtherOpen(false) }}
              >
                {m}
              </button>
            ))}
            <button type="button" className={`howto-tag${otherOpen ? ' howto-tag--on' : ''}`} onClick={() => setOtherOpen((o) => !o)}>
              Other…
            </button>
          </div>
          {otherOpen && (
            <div style={{ marginTop: 10 }}>
              <input
                type="search"
                className="input"
                placeholder="Any movement"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search movements"
                style={{ width: '100%' }}
              />
              <div className="add-list">
                {results.map((e) => (
                  <button key={e.name} type="button" className="add-row" onClick={() => { set({ name: e.name }); setOtherOpen(false); setQuery('') }}>
                    <span className="add-row__main">
                      <span className="add-row__name">{e.name}</span>
                      <span className="add-row__sub">{PATTERN_LABEL[e.pattern]} · {EQUIPMENT_LABEL[e.equipment]}</span>
                    </span>
                  </button>
                ))}
                {query.trim() && !results.some((e) => e.name.toLowerCase() === query.trim().toLowerCase()) && (
                  <button type="button" className="add-row" onClick={() => { set({ name: query.trim().slice(0, 60) }); setOtherOpen(false); setQuery('') }}>
                    <span className="add-row__main">
                      <span className="add-row__name">Use “{query.trim().slice(0, 60)}”</span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn--primary btn--full"
          // Unlock audio INSIDE the tap — the timer's cues play on this context.
          onClick={() => { primeCueAudio(); commit(onPrimary) }}
        >
          <Play size={18} strokeWidth={2.2} fill="currentColor" style={{ marginRight: 8 }} />
          {primaryLabel} · {fmtClock(total)}
        </button>
        <button type="button" className="btn btn--ghost btn--full" style={{ marginTop: 6 }} onClick={() => commit(onSecondary)}>
          {secondaryLabel}
        </button>
      </div>
    </div>
  )
}

/** Re-dose a block already in the session — the coach's, or one you added. */
export function AdjustIntervalsSheet({
  name, plan, lockName, onStart, onSave, onClose,
}: {
  name: string
  plan: IntervalPlan
  lockName: boolean
  onStart: (ex: ExerciseTemplate) => void
  onSave: (ex: ExerciseTemplate) => void
  onClose: () => void
}) {
  return (
    <Sheet title="Adjust intervals" subtitle="For today — the program keeps its own dose" onClose={onClose}>
      <IntervalBuilder
        initial={{ name, work: plan.work, rest: plan.rest, rounds: plan.rounds, sets: plan.sets }}
        lockName={lockName}
        primaryLabel="Start now"
        secondaryLabel="Save for later in the session"
        onPrimary={onStart}
        onSecondary={onSave}
      />
    </Sheet>
  )
}
