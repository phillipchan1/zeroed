import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button, Input, PresenceDot } from '../../components/ui'
import { FunnelFrame } from '../../components/layout/FunnelFrame'
import { SignInScreen } from './SignInScreen'
import { visibleStarterPacks, type StarterPackId } from '../../engine/starterPacks'
import {
  EMPTY_ANSWERS,
  EXPERIENCE,
  MODALITIES,
  SPORTS,
  WEEKDAYS,
  coachRead,
  endurancePicked,
  focusOptions,
  inferPack,
  intakeSteps,
  packCard,
  planLanes,
  readOwnWords,
  resolveIntake,
  type IntakeAnswers,
  type IntakeStep,
  type Modality,
} from '../../engine/intake'
import { stashFromResolved, writeStarterPack } from './starterPackStorage'
import { signOutLocal } from '../../lib/authClient'

/**
 * Flag-on onboarding (`onboarding_agent_v1`): a short conversation with the
 * coach, not a form and not a catalogue. What do you train, what matters, how
 * long have you lifted — then one or two follow-ups only where the plan uses
 * the answer. The starter pack is inferred from that, shown on the plan with
 * its reason, and changeable there.
 *
 * Signed out, "Save my plan" opens the email-code sign-in; the plan rides the
 * same localStorage stash as before and OnboardingRouter's bootstrap builds it.
 * Signed in (after a reset), it hands straight to `onAuthedComplete`.
 */
export function CoachIntake({
  authed,
  signedInAs,
  onExit,
  onAuthedComplete,
}: {
  authed: boolean
  /** Signed in with no plan yet: say which email, in case it's the wrong one. */
  signedInAs?: string | null
  /** Back from the first question (signed out: to the welcome screen). */
  onExit?: () => void
  onAuthedComplete: () => void
}) {
  const [a, setA] = useState<IntakeAnswers>(EMPTY_ANSWERS)
  const [step, setStep] = useState<IntakeStep>('train')
  const [ownWords, setOwnWords] = useState('')
  const [saving, setSaving] = useState(false)

  const steps = intakeSteps(a)
  const at = Math.max(0, steps.indexOf(step))
  const resolved = resolveIntake(a)

  function go(next: IntakeAnswers, from: IntakeStep) {
    const s = intakeSteps(next)
    setA(next)
    setStep(s[Math.min(s.indexOf(from) + 1, s.length - 1)])
  }

  function back() {
    if (at === 0) onExit?.()
    else setStep(steps[at - 1])
  }

  function finish() {
    writeStarterPack(stashFromResolved(resolved, a.name))
    if (authed) onAuthedComplete()
    else setSaving(true)
  }

  if (saving) {
    const card = packCard(resolved.id)
    return (
      <SignInScreen
        intent="save"
        onBack={() => setSaving(false)}
        summary={
          <p className="signin__plan">
            <span className="signin__plan-dot" aria-hidden />
            {card.title} · {resolved.sessions} days a week
          </p>
        }
      />
    )
  }

  return (
    <FunnelFrame>
      <div className="intake">
        <div className="intake__top">
          {(at > 0 || onExit) ? (
            <button type="button" className="signin__back intake__back" onClick={back} aria-label="Back">
              <ChevronLeft size={22} strokeWidth={2} />
            </button>
          ) : <span />}
          <div className="intake__progress" aria-hidden>
            {steps.map((s, i) => (
              <span key={s} className={`intake__tick${i <= at ? ' intake__tick--on' : ''}`} />
            ))}
          </div>
        </div>

        {at > 0 && (
          <div className="intake__thread">
            {steps.slice(0, at).map((s) => (
              <button key={s} type="button" className="intake__said" onClick={() => setStep(s)}>
                <span className="intake__said-q">{question(s, a)}</span>
                <span className="intake__said-a">{answerOf(s, a)}</span>
              </button>
            ))}
          </div>
        )}

        {authed && signedInAs && step === 'train' && (
          <p className="intake__signed">
            Signed in as <span className="signin__email">{signedInAs}</span>. No plan here yet.{' '}
            <button type="button" className="signin__link" onClick={() => void signOutLocal()}>
              Use another email
            </button>
          </p>
        )}

        <section className="intake__turn" key={step}>
          <p className="eyebrow intake__who fade-rise"><PresenceDot /> {step === 'plan' ? 'Your plan' : 'Coach'}</p>
          <h1 className="hero-headline intake__q fade-rise fade-rise-delay-1">{question(step, a)}</h1>

          <div className="fade-rise fade-rise-delay-2">
            {step === 'train' && (
              <TrainStep
                a={a}
                ownWords={ownWords}
                onOwnWords={setOwnWords}
                onChange={setA}
                onNext={() => {
                  const read = readOwnWords(ownWords)
                  const modalities = MODALITIES.map((m) => m.id)
                    .filter((id) => a.modalities.includes(id) || read.modalities.includes(id))
                  const next: IntakeAnswers = {
                    ...a,
                    modalities,
                    nothingYet: modalities.length ? false : a.nothingYet,
                    sport: a.sport || read.sport || '',
                  }
                  // A focus the new answers no longer offer is stale.
                  if (next.focus && !focusOptions(next).some((o) => o.id === next.focus)) next.focus = null
                  go(next, 'train')
                }}
              />
            )}

            {step === 'focus' && (
              <Options
                options={focusOptions(a).map((o) => ({ key: o.id, label: o.label, sub: o.sub }))}
                selected={a.focus}
                onPick={(focus) => go({ ...a, focus: focus as IntakeAnswers['focus'], packOverride: null }, 'focus')}
              />
            )}

            {step === 'experience' && (
              <Options
                options={EXPERIENCE.map((e) => ({ key: e.id, label: e.label }))}
                selected={a.experience}
                onPick={(experience) => go({ ...a, experience: experience as IntakeAnswers['experience'] }, 'experience')}
              />
            )}

            {step === 'sport' && <SportStep a={a} onChange={setA} onNext={() => go(a, 'sport')} />}

            {step === 'endurance' && (
              <Chips
                options={['1', '2', '3', '4', '5', '6']}
                selected={a.enduranceDays ? [String(a.enduranceDays)] : []}
                onToggle={(v) => go({ ...a, enduranceDays: Number(v) }, 'endurance')}
                big
              />
            )}

            {step === 'lifts' && <LiftsStep a={a} onChange={setA} onNext={() => go(a, 'lifts')} />}

            {step === 'plan' && (
              <PlanStep
                a={a}
                onChange={setA}
                onPack={(id) => {
                  const next = { ...a, packOverride: id }
                  setA(next)
                  // A sport plan needs the sport; ask before showing it.
                  if (inferPack(next) === 'sport_sc' && !next.sport.trim()) setStep('sport')
                }}
                onSave={finish}
              />
            )}
          </div>
        </section>
      </div>
    </FunnelFrame>
  )
}

// ---- Copy --------------------------------------------------------------------

function enduranceVerb(a: IntakeAnswers): string {
  const first = endurancePicked(a.modalities)[0]
  if (first === 'cycling') return 'ride'
  if (first === 'swimming') return 'swim'
  if (first === 'hyrox') return 'train for Hyrox'
  return 'run'
}

function question(step: IntakeStep, a: IntakeAnswers): string {
  switch (step) {
    case 'train': return 'What do you train right now?'
    case 'focus': return 'What matters most for the next three months?'
    case 'experience': return 'How long have you been lifting consistently?'
    case 'sport': return 'Tell me about your sport.'
    case 'endurance': return `How many days a week do you ${enduranceVerb(a)}?`
    case 'lifts': return 'Any recent best lifts?'
    case 'plan': return "Here's where I'd start."
  }
}

function answerOf(step: IntakeStep, a: IntakeAnswers): string {
  switch (step) {
    case 'train':
      if (a.nothingYet || !a.modalities.length) return 'Nothing yet'
      return a.modalities
        .map((m) => (m === 'sport' && a.sport.trim() ? a.sport.trim() : MODALITIES.find((x) => x.id === m)!.label))
        .join(', ')
    case 'focus': return focusOptions(a).find((o) => o.id === a.focus)?.label ?? '—'
    case 'experience': return EXPERIENCE.find((e) => e.id === a.experience)?.label ?? '—'
    case 'sport': return `${a.sport.trim() || 'Sport'} · ${a.season === 'in' ? 'in-season' : 'off-season'} · lift ${a.liftDays} days`
    case 'endurance': return `${a.enduranceDays} ${a.enduranceDays === 1 ? 'day' : 'days'}`
    case 'lifts': {
      const l = [a.squat && `S ${a.squat}`, a.bench && `B ${a.bench}`, a.deadlift && `D ${a.deadlift}`].filter(Boolean)
      return l.length ? l.join(' · ') : 'Skipped'
    }
    case 'plan': return ''
  }
}

// ---- Steps -------------------------------------------------------------------

function TrainStep({
  a, ownWords, onOwnWords, onChange, onNext,
}: {
  a: IntakeAnswers
  ownWords: string
  onOwnWords: (v: string) => void
  onChange: (a: IntakeAnswers) => void
  onNext: () => void
}) {
  const ready = a.modalities.length > 0 || a.nothingYet || ownWords.trim().length > 0
  function toggle(id: Modality) {
    const on = a.modalities.includes(id)
    onChange({ ...a, nothingYet: false, modalities: on ? a.modalities.filter((m) => m !== id) : [...a.modalities, id] })
  }
  return (
    <>
      <p className="text-sm text-dim intake__hint">Tap all that apply. Everything counts.</p>
      <div className="intake__chips">
        {MODALITIES.map((m) => (
          <Chip key={m.id} on={a.modalities.includes(m.id)} onClick={() => toggle(m.id)}>{m.label}</Chip>
        ))}
        <Chip on={a.nothingYet} onClick={() => onChange({ ...a, modalities: [], nothingYet: !a.nothingYet })}>
          Nothing yet
        </Chip>
      </div>
      <Input
        type="text"
        placeholder="Or tell me in your own words"
        value={ownWords}
        onChange={(e) => onOwnWords(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && ready) onNext() }}
        className="intake__words"
        enterKeyHint="next"
      />
      <Next disabled={!ready} onClick={onNext} />
    </>
  )
}

function SportStep({ a, onChange, onNext }: { a: IntakeAnswers; onChange: (a: IntakeAnswers) => void; onNext: () => void }) {
  const chip = SPORTS.find((s) => s.toLowerCase() === a.sport.trim().toLowerCase()) ?? null
  return (
    <div className="intake__fields">
      <Field label="Sport">
        <div className="intake__chips">
          {SPORTS.map((s) => (
            <Chip key={s} on={chip === s} onClick={() => onChange({ ...a, sport: chip === s ? '' : s })}>{s}</Chip>
          ))}
        </div>
        {!chip && (
          <Input
            type="text"
            placeholder="Or name it"
            value={a.sport}
            onChange={(e) => onChange({ ...a, sport: e.target.value })}
            style={{ marginTop: 10 }}
          />
        )}
      </Field>
      <Field label="Season">
        <div className="intake__chips">
          <Chip on={a.season === 'in'} onClick={() => onChange({ ...a, season: 'in' })}>In-season</Chip>
          <Chip on={a.season === 'off'} onClick={() => onChange({ ...a, season: 'off' })}>Off-season</Chip>
        </div>
      </Field>
      <Field label="Days you can lift around it">
        <div className="intake__chips">
          {([2, 3, 4] as const).map((n) => (
            <Chip key={n} on={a.liftDays === n} onClick={() => onChange({ ...a, liftDays: n })}>{n}</Chip>
          ))}
        </div>
      </Field>
      <Field label="Game or practice days (optional)">
        <div className="intake__chips">
          {WEEKDAYS.map((d) => {
            const on = a.gameDays.includes(d)
            return (
              <Chip
                key={d}
                on={on}
                onClick={() => onChange({
                  ...a,
                  gameDays: on ? a.gameDays.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || a.gameDays.includes(x)),
                })}
              >
                {d}
              </Chip>
            )
          })}
        </div>
      </Field>
      <Next disabled={!a.sport.trim()} onClick={onNext} />
    </div>
  )
}

function LiftsStep({ a, onChange, onNext }: { a: IntakeAnswers; onChange: (a: IntakeAnswers) => void; onNext: () => void }) {
  const any = !!(a.squat.trim() || a.bench.trim() || a.deadlift.trim())
  return (
    <div className="intake__fields">
      <p className="text-sm text-dim intake__hint">A recent heavy set is fine, like “140 × 3”. Skip it and I'll find them with you.</p>
      <div className="intake__lifts">
        <Input mono placeholder="Squat" value={a.squat} onChange={(e) => onChange({ ...a, squat: e.target.value })} />
        <Input mono placeholder="Bench" value={a.bench} onChange={(e) => onChange({ ...a, bench: e.target.value })} />
        <Input mono placeholder="Deadlift" value={a.deadlift} onChange={(e) => onChange({ ...a, deadlift: e.target.value })} />
      </div>
      <Next label={any ? 'Continue' : 'Skip'} onClick={onNext} />
    </div>
  )
}

function PlanStep({
  a, onChange, onPack, onSave,
}: {
  a: IntakeAnswers
  onChange: (a: IntakeAnswers) => void
  onPack: (id: StarterPackId) => void
  onSave: () => void
}) {
  const [changing, setChanging] = useState(false)
  const resolved = resolveIntake(a)
  const card = packCard(resolved.id)
  const lanes = planLanes(a, resolved)

  return (
    <div className="intake__fields">
      <p className="intake__read">{coachRead(a, resolved)}</p>

      <div className="plan-week">
        <p className="section-header plan-week__head">Your week</p>
        {lanes.map((l) => (
          <div key={l.key} className={`plan-lane${l.planned ? ' plan-lane--planned' : ''}`}>
            <div className="plan-lane__main">
              <span className="plan-lane__label">{l.label}</span>
              <span className="plan-lane__detail">{l.detail}</span>
            </div>
            <span className="plan-lane__dots" aria-hidden>
              {Array.from({ length: Math.min(l.dots, 7) }, (_, i) => <i key={i} />)}
            </span>
            <span className="plan-lane__tag">{l.planned ? 'Planned' : 'Coach knows'}</span>
          </div>
        ))}
      </div>

      <div className="plan-start">
        <div>
          <span className="plan-start__label">Starting point</span>
          <span className="plan-start__title">{card.title}</span>
        </div>
        <button type="button" className="signin__link" onClick={() => setChanging((c) => !c)}>
          {changing ? 'Done' : 'Change'}
        </button>
      </div>
      {changing && (
        <div className="intake__options plan-packs">
          {visibleStarterPacks().map((p) => (
            <button
              key={p.id}
              type="button"
              className={`intake__option${p.id === resolved.id ? ' intake__option--on' : ''}`}
              onClick={() => { onPack(p.id); setChanging(false) }}
            >
              <span className="intake__option-label">{p.title}</span>
              <span className="intake__option-sub">{p.who}</span>
            </button>
          ))}
        </div>
      )}

      <Input
        type="text"
        placeholder="What should I call you? (optional)"
        value={a.name}
        onChange={(e) => onChange({ ...a, name: e.target.value })}
        autoCapitalize="words"
        autoComplete="given-name"
      />

      <Button variant="primary" full onClick={onSave}>Save my plan</Button>
      <p className="text-xs text-dim plan-fine">
        I design session one the moment it's saved. Every load is clamped for safety, and the plan adapts as you log.
      </p>
    </div>
  )
}

// ---- Bits ----------------------------------------------------------------------

function Options({
  options, selected, onPick,
}: {
  options: Array<{ key: string; label: string; sub?: string }>
  selected: string | null
  onPick: (key: string) => void
}) {
  return (
    <div className="intake__options">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`intake__option${selected === o.key ? ' intake__option--on' : ''}`}
          onClick={() => onPick(o.key)}
        >
          <span className="intake__option-label">{o.label}</span>
          {o.sub && <span className="intake__option-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  )
}

function Chips({
  options, selected, onToggle, big,
}: {
  options: string[]
  selected: string[]
  onToggle: (v: string) => void
  big?: boolean
}) {
  return (
    <div className={`intake__chips${big ? ' intake__chips--big' : ''}`}>
      {options.map((o) => <Chip key={o} on={selected.includes(o)} onClick={() => onToggle(o)}>{o}</Chip>)}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`intake__chip${on ? ' intake__chip--on' : ''}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="section-header intake__field-label">{label}</span>
      {children}
    </div>
  )
}

function Next({ disabled, onClick, label = 'Continue' }: { disabled?: boolean; onClick: () => void; label?: string }) {
  return (
    <Button variant="primary" full disabled={disabled} onClick={onClick} className="intake__next">
      {label}
    </Button>
  )
}

export default CoachIntake
