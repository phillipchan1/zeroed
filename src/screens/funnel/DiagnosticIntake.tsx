import { useState, useCallback, useMemo } from 'react'
import { X, HelpCircle } from 'lucide-react'
import { getWeightUnit } from '../../lib/units'
import {
  Logo, Button, Input, StepIndicator, ScorePicker,
  SectionHeader, InsightCard, Spinner, Ring, Chip, Sheet,
} from '../../components/ui'
import type { DiagnosticResults, InsightRow } from '../../types/database'
import { MOVEMENT_PATTERNS } from '../../types/database'

// ---- Types -----------------------------------------------------------------

interface StrengthData {
  squat_1rm_est: string
  hinge_1rm_est: string
  push_1rm_est: string
  pull_1rm_est: string
  plank_secs: string
}

interface SubjectiveData {
  sleep: number | null
  energy: number | null
  stress: number | null
  pain: string
}

type Step = 'movement' | 'strength' | 'subjective' | 'saving'

// ---- Goal → battery mapping ------------------------------------------------
// A good coach doesn't run the same combine on a marathoner and a powerlifter.
// The movement screen is the universal spine (everyone benefits from knowing
// how they move); strength baselines are switched on only when the goal needs
// them. The "goal" signal in the new flow is the obstacle answer + the sport.

type GoalType = 'strength' | 'sport' | 'rehab' | 'endurance' | 'general'

interface BatteryPlan {
  goalType: GoalType
  includeStrength: boolean
}

function planBattery(goals: string, sport: string): BatteryPlan {
  const text = `${goals} ${sport}`.toLowerCase()
  const has = (re: RegExp) => re.test(text)

  const isStrength  = has(/strength|strong|muscle|hypertroph|1rm|lift|powerlift|olympic|bench|squat|deadlift|press|mass|bigger|gain|tone|build/)
  const isSport     = has(/rugby|football|soccer|basketball|tennis|sprint|jump|athletic|sport|competit|\bgame\b|season|field|court|combine|hockey|baseball|volleyball|mma|boxing|climb/)
  const isRehab     = has(/pain|injur|rehab|recover|ache|hurt|tight|prehab|niggle|impinge/)
  const isEndurance = has(/\brun|marathon|\b5k\b|\b10k\b|\bhalf\b|ultra|endurance|cardio|aerobic|cycling|cycle|triathlon|swim|stamina/)

  let goalType: GoalType = 'general'
  if (isStrength) goalType = 'strength'
  else if (isSport) goalType = 'sport'
  else if (isRehab) goalType = 'rehab'
  else if (isEndurance) goalType = 'endurance'

  const includeStrength = !(goalType === 'rehab' || goalType === 'endurance')

  return { goalType, includeStrength }
}

// Detects category concentration — fires the "pattern emerging" callout when
// two or more weak patterns cluster in the same category.
function detectEmergingCategory(scores: Record<string, number | null>): string | null {
  const weak = MOVEMENT_PATTERNS.filter((p) => (scores[p.key] ?? 3) < 2)
  if (weak.length < 2) return null
  const counts: Record<string, number> = {}
  weak.forEach((p) => { counts[p.category] = (counts[p.category] ?? 0) + 1 })
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const [topCategory, topCount] = sorted[0]
  return topCount >= 2 ? topCategory : null
}

// Plain-language "why" + how-to for each movement pattern.
const PATTERN_GUIDE: Record<string, string> = {
  deep_squat:        'Whole-body mobility — ankles, hips, and upper back working together. Limits how deep and upright you can load a squat.',
  hurdle_step:       'Single-leg control and hip stability. Where most landing and cutting issues show up.',
  inline_lunge:      'Stability in a split stance — balance, hip flexibility, and trunk control under a stagger.',
  shoulder_mobility: 'Overhead range and shoulder freedom. Gates pressing, pulling, and anything over your head.',
  aslr:              'Hamstring and posterior chain length, plus core control. Underpins hinging and sprinting.',
  trunk_stability:   'Can your core stay rigid while your limbs move? Protects the spine when you press and push.',
  rotary_stability:  'Coordinated core control across the body — the base for rotation, throwing, and change of direction.',
}

// Guided "test me" decomposition — observable yes/no checks resolved to a 0–3.
const PATTERN_TEST: Record<string, { setup: string; clean: string }> = {
  deep_squat:        { setup: 'Feet shoulder-width, arms straight overhead. Squat as deep as you can.',                                       clean: 'Heels stay flat, knees track over toes, torso stays upright, and hips drop below the knees.' },
  hurdle_step:       { setup: 'Stand tall. Step one foot up and over an imaginary knee-height bar, tap the heel down, return. Both sides.',   clean: 'Hips stay level, no wobble, the standing leg stays stable, and both sides feel equal.' },
  inline_lunge:      { setup: 'Step into a long split stance. Lower the back knee toward the floor behind the front heel. Both sides.',        clean: 'Torso stays upright, front heel stays down, no loss of balance, and both sides are equal.' },
  shoulder_mobility: { setup: 'Reach one hand over the shoulder and the other up the back, try to touch fingertips. Swap sides.',             clean: 'Fingertips touch (or nearly) on both sides without shrugging or arching the back.' },
  aslr:              { setup: 'Lie on your back. Keep one leg flat on the floor and raise the other straight up as high as it goes.',         clean: 'The raised leg passes the mid-thigh of the down leg while both knees stay straight.' },
  trunk_stability:   { setup: 'Push-up position with hands at forehead level. Press up as one rigid unit.',                                    clean: 'The body rises as one plank — no sag in the hips, no lag in the lower back.' },
  rotary_stability:  { setup: 'On hands and knees, extend the same-side arm and leg, then draw elbow to knee under the body. Both sides.',     clean: 'You stay balanced and level through the whole motion, on both sides.' },
}

// ---- Helper: micro-reveal --------------------------------------------------

function InsightReveal({ insight, index }: { insight: InsightRow; index: number }) {
  const delay = `fade-rise-delay-${Math.min(index + 1, 4) as 1 | 2 | 3 | 4}`
  return (
    <div className={`fade-rise ${delay}`}>
      <InsightCard insight={insight} typeOn />
    </div>
  )
}

// ---- Step sub-components ---------------------------------------------------

function GuidedMovementTest({
  patternKey,
  onResolve,
}: {
  patternKey: string
  onResolve: (score: number) => void
}) {
  const test = PATTERN_TEST[patternKey]
  const [stage, setStage] = useState<'pain' | 'complete' | 'clean'>('pain')
  if (!test) return null

  const questions = {
    pain: {
      prompt: 'Any pain during the movement?',
      a: { label: 'No pain',        onClick: () => setStage('complete') },
      b: { label: 'Yes — it hurt',  onClick: () => onResolve(0) },
    },
    complete: {
      prompt: 'Could you complete the movement at all?',
      a: { label: 'Yes',            onClick: () => setStage('clean') },
      b: { label: "No — couldn't",  onClick: () => onResolve(1) },
    },
    clean: {
      prompt: test.clean,
      a: { label: 'All true',       onClick: () => onResolve(3) },
      b: { label: 'Not quite',      onClick: () => onResolve(2) },
    },
  } as const

  const q = questions[stage]

  return (
    <div style={{ marginTop: 14, padding: '16px', background: 'var(--ground)', border: '1px solid var(--line)', borderRadius: 10 }}>
      <p className="text-sm text-dim" style={{ lineHeight: 1.55, marginBottom: 14 }}>{test.setup}</p>
      <p className="text-base" style={{ marginBottom: 14, lineHeight: 1.5, fontWeight: 600 }}>{q.prompt}</p>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button variant="outline" onClick={q.a.onClick} style={{ flex: 1 }}>{q.a.label}</Button>
        <Button variant="ghost"   onClick={q.b.onClick} style={{ flex: 1 }}>{q.b.label}</Button>
      </div>
    </div>
  )
}

function MovementStep({
  scores,
  onScore,
  revealedInsights,
  onNext,
}: {
  scores: Record<string, number | null>
  onScore: (key: string, score: number) => void
  revealedInsights: InsightRow[]
  onNext: () => void
}) {
  const allScored = MOVEMENT_PATTERNS.every((p) => scores[p.key] !== null)
  const [guidedKey, setGuidedKey] = useState<string | null>(null)
  const [explainKey, setExplainKey] = useState<string | null>(null)

  const scoredCount = MOVEMENT_PATTERNS.filter((p) => scores[p.key] !== null).length
  const weakLinkCount = MOVEMENT_PATTERNS.filter((p) => (scores[p.key] ?? 3) < 2).length
  const emergingCategory = detectEmergingCategory(scores)

  const explain = MOVEMENT_PATTERNS.find((p) => p.key === explainKey) ?? null

  return (
    <div>
      {/* Progress, drawn. This replaces a mono telemetry strip reading
          "SCREENING 3/7 · WEAK LINKS 1 · STARTED 2m ago" — of which only the
          first number meant anything to the person filling the form. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        <Ring value={scoredCount / MOVEMENT_PATTERNS.length} size={56} stroke={5} label={`${scoredCount} of ${MOVEMENT_PATTERNS.length} patterns scored`}>
          <span style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{scoredCount}</span>
          <span className="text-micro text-dim">of {MOVEMENT_PATTERNS.length}</span>
        </Ring>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="screen-title" style={{ fontSize: 'var(--fs-xl)' }}>How you move</h1>
          <p className="text-xs text-dim" style={{ marginTop: 3 }}>
            {scoredCount === 0 ? 'Tap “Test me” — I’ll walk you through each one.'
              : weakLinkCount > 0 ? `${weakLinkCount} weak ${weakLinkCount === 1 ? 'link' : 'links'} so far`
              : 'Clean so far'}
          </p>
        </div>
      </div>

      {/* Pattern emerging callout — the system is thinking as you go. */}
      {emergingCategory && (
        <div className="fade-rise" style={{ marginBottom: 18 }}>
          <Chip tone="doing">Pattern emerging</Chip>
          <p className="text-sm text-dim" style={{ marginTop: 8 }}>
            Your {emergingCategory.toLowerCase()} looks like the bigger story.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {MOVEMENT_PATTERNS.map((pattern) => {
          const score = scores[pattern.key]
          const scored = score !== null
          const guided = guidedKey === pattern.key
          return (
            <div key={pattern.key} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, lineHeight: 1.3 }}>{pattern.label}</p>
                  <p className="text-xs text-dim" style={{ marginTop: 2 }}>{pattern.category}</p>
                </div>
                {scored && (
                  <Chip tone={score! < 2 ? 'pending' : 'done'}>{score}/3</Chip>
                )}
                {/* The what-is-this / how-to prose used to sit inline under
                    every pattern — two paragraphs × seven patterns before you
                    could score anything. It's one tap away instead. */}
                <button
                  type="button"
                  className="sheet-close"
                  style={{ margin: 0, width: 36, height: 36 }}
                  aria-label={`About ${pattern.label}`}
                  onClick={() => setExplainKey(pattern.key)}
                >
                  <HelpCircle size={18} strokeWidth={2} />
                </button>
              </div>

              {guided ? (
                <GuidedMovementTest
                  patternKey={pattern.key}
                  onResolve={(s) => { onScore(pattern.key, s); setGuidedKey(null) }}
                />
              ) : (
                <div style={{ marginTop: 14 }}>
                  <Button variant={scored ? 'ghost' : 'outline'} full onClick={() => setGuidedKey(pattern.key)}>
                    {scored ? 'Re-test' : 'Test me →'}
                  </Button>
                  {!scored && (
                    <div style={{ marginTop: 12 }}>
                      <p className="text-xs text-dim" style={{ marginBottom: 8 }}>Or score it yourself</p>
                      <ScorePicker value={null} onChange={(s) => onScore(pattern.key, s)} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Micro-reveal: insights surface as patterns are scored */}
      {revealedInsights.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <SectionHeader>Weak link identified</SectionHeader>
          <div style={{ marginTop: 10 }}>
            {revealedInsights.map((ins, i) => (
              <InsightReveal key={ins.id} insight={ins} index={i} />
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <Button variant="primary" full disabled={!allScored} onClick={onNext}>
          {allScored ? 'Continue →' : `${MOVEMENT_PATTERNS.length - scoredCount} left`}
        </Button>
      </div>

      {explain && (
        <Sheet title={explain.label} subtitle={explain.category} onClose={() => setExplainKey(null)}>
          {PATTERN_GUIDE[explain.key] && (
            <>
              <p className="section-header" style={{ marginBottom: 8 }}>Why it matters</p>
              <p className="text-base" style={{ lineHeight: 1.55, marginBottom: 22 }}>{PATTERN_GUIDE[explain.key]}</p>
            </>
          )}
          {PATTERN_TEST[explain.key] && (
            <>
              <p className="section-header" style={{ marginBottom: 8 }}>How to test it</p>
              <p className="text-base" style={{ lineHeight: 1.55, marginBottom: 22 }}>{PATTERN_TEST[explain.key].setup}</p>
              <p className="section-header" style={{ marginBottom: 8 }}>A clean rep looks like</p>
              <p className="text-base" style={{ lineHeight: 1.55, marginBottom: 22 }}>{PATTERN_TEST[explain.key].clean}</p>
            </>
          )}
          <p className="section-header" style={{ marginBottom: 10 }}>The 0–3 scale</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              ['0', 'Pain anywhere in the movement'],
              ['1', "Can't complete it"],
              ['2', 'Complete it, but with compensation or wobble'],
              ['3', 'Clean and controlled'],
            ].map(([n, text]) => (
              <div key={n} style={{ display: 'flex', gap: 12 }}>
                <span className="num text-signal" style={{ fontWeight: 700, flexShrink: 0 }}>{n}</span>
                <span className="text-base" style={{ lineHeight: 1.5 }}>{text}</span>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  )
}

function StrengthStep({
  data, onChange, onNext, onBack,
}: {
  data: StrengthData
  onChange: (key: keyof StrengthData, val: string) => void
  onNext: () => void
  onBack: () => void
}) {
  // The unit the athlete actually trains in. These fields were hard-coded to kg
  // while the rest of the app defaults to lb, so a lifter typing "225" was
  // recorded as 225 kg.
  const unit = getWeightUnit()
  const fields: Array<{ key: keyof StrengthData; label: string; suffix: string }> = [
    { key: 'squat_1rm_est', label: 'Back Squat', suffix: unit },
    { key: 'hinge_1rm_est', label: 'Deadlift / hinge', suffix: unit },
    { key: 'push_1rm_est',  label: 'Press', suffix: unit },
    { key: 'pull_1rm_est',  label: 'Pull / row', suffix: unit },
    { key: 'plank_secs',    label: 'Plank hold', suffix: 'sec' },
  ]

  return (
    <div>
      <h1 className="screen-title" style={{ fontSize: 'var(--fs-xl)' }}>Rough numbers</h1>
      <p className="text-sm text-dim" style={{ marginTop: 6, marginBottom: 24 }}>
        Estimated 1-rep maxes. Approximate is fine — leave blank if untested.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {fields.map(({ key, label, suffix }) => (
          <div
            key={key}
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '12px 0', borderBottom: '1px solid var(--line)',
            }}
          >
            <label htmlFor={key} className="text-base" style={{ flex: 1, minWidth: 0 }}>{label}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <Input
                id={key}
                type="number"
                inputMode="decimal"
                placeholder="—"
                value={data[key]}
                onChange={(e) => onChange(key, e.target.value)}
                mono
                style={{ width: 96, textAlign: 'center' }}
              />
              <span className="text-xs text-dim" style={{ width: 26 }}>{suffix}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 32, display: 'flex', gap: 10 }}>
        <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
        <Button variant="primary" onClick={onNext} style={{ flex: 2 }}>Continue →</Button>
      </div>
    </div>
  )
}

function SubjectiveStep({
  data, onChange, onSubmit, onBack, saving,
}: {
  data: SubjectiveData
  onChange: (key: keyof SubjectiveData, val: number | string) => void
  onSubmit: () => void
  onBack: () => void
  saving: boolean
}) {
  const scaleFields: Array<{ key: 'sleep' | 'energy' | 'stress'; label: string; anchor: string }> = [
    { key: 'sleep',  label: 'Sleep quality',  anchor: '0 = terrible · 3 = great' },
    { key: 'energy', label: 'Energy level',   anchor: '0 = drained · 3 = fresh' },
    { key: 'stress', label: 'Stress level',   anchor: '0 = calm · 3 = maxed out' },
  ]

  return (
    <div>
      <h1 className="screen-title" style={{ fontSize: 'var(--fs-xl)' }}>Today</h1>
      <p className="text-sm text-dim" style={{ marginTop: 6, marginBottom: 26 }}>
        How you're showing up right now.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {scaleFields.map(({ key, label, anchor }) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, gap: 10 }}>
              <span className="text-base" style={{ fontWeight: 600 }}>{label}</span>
              {data[key] !== null ? (
                <span className="num text-signal text-base">{data[key]}/3</span>
              ) : (
                <span className="text-xs text-dim">{anchor}</span>
              )}
            </div>
            <ScorePicker value={data[key]} onChange={(v) => onChange(key, v)} />
          </div>
        ))}

        <div>
          <label className="text-base" style={{ display: 'block', marginBottom: 10, fontWeight: 600 }}>
            Anything hurting?
          </label>
          <textarea
            className="input"
            placeholder="Mild left knee ache — or just: none"
            value={data.pain}
            onChange={(e) => onChange('pain', e.target.value)}
            rows={2}
          />
        </div>
      </div>

      <div style={{ marginTop: 32, display: 'flex', gap: 10 }}>
        <Button variant="ghost" onClick={onBack} style={{ flex: 1 }} disabled={saving}>← Back</Button>
        <Button variant="primary" onClick={onSubmit} style={{ flex: 2 }} disabled={saving || !data.pain.trim()}>
          {saving ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Spinner /> Building…</span>
          ) : (
            'Build my read →'
          )}
        </Button>
      </div>
    </div>
  )
}

// ---- Main component (Act 3 — The Screen) -----------------------------------

interface ScreeningProps {
  obstacle: string
  sport: string
  trainingAge: number
  sessions: number
  /** Hands the collected diagnostic up; the compute screen persists it. */
  onComplete: (results: DiagnosticResults) => void
  /** When set, renders a close affordance that bails out of the screen without
   *  submitting — so you can open it to look around and back out. */
  onExit?: () => void
}

export function DiagnosticIntake({ obstacle, sport, trainingAge, sessions, onComplete, onExit }: ScreeningProps) {
  const [step, setStep] = useState<Step>('movement')

  const [movementScores, setMovementScores] = useState<Record<string, number | null>>(
    () => Object.fromEntries(MOVEMENT_PATTERNS.map((p) => [p.key, null])),
  )
  const [revealedInsights, setRevealedInsights] = useState<InsightRow[]>([])

  const [strength, setStrength] = useState<StrengthData>({
    squat_1rm_est: '', hinge_1rm_est: '', push_1rm_est: '', pull_1rm_est: '', plank_secs: '',
  })
  const [subjective, setSubjective] = useState<SubjectiveData>({
    sleep: null, energy: null, stress: null, pain: '',
  })

  const handleMovementScore = useCallback((key: string, score: number) => {
    setMovementScores((prev) => ({ ...prev, [key]: score }))

    if (score < 2) {
      const pattern = MOVEMENT_PATTERNS.find((p) => p.key === key)
      if (!pattern) return

      setRevealedInsights((prev) => {
        const weakCount = prev.length
        const priorities = ['P1', 'P2', 'P3', 'P4'] as const
        const preview: InsightRow = {
          id: `preview-${key}`,
          athlete_id: '',
          source_id: null,
          claim: `${pattern.label} scored ${score}/3 — pattern is limited.`,
          category: pattern.category,
          priority: priorities[Math.min(weakCount, 3)],
          confidence: 0.65,
          status: 'likely',
          evidence: null,
          source: 'diagnostic',
          program_impact: null,
          generated_at: new Date().toISOString(),
          resolved_at: null,
          updated_at: new Date().toISOString(),
          prev_status: null,
        }
        const updated = prev.filter((i) => i.id !== `preview-${key}`)
        return [...updated, preview].sort((a, b) => a.priority.localeCompare(b.priority))
      })
    } else {
      setRevealedInsights((prev) => prev.filter((i) => i.id !== `preview-${key}`))
    }
  }, [])

  function handleSubmit() {
    setStep('saving')

    const results: DiagnosticResults = {
      movement: Object.fromEntries(MOVEMENT_PATTERNS.map((p) => [p.key, movementScores[p.key] ?? 3])),
      strength: {
        squat_1rm_est: parseFloat(strength.squat_1rm_est) || null,
        hinge_1rm_est: parseFloat(strength.hinge_1rm_est) || null,
        push_1rm_est:  parseFloat(strength.push_1rm_est)  || null,
        pull_1rm_est:  parseFloat(strength.pull_1rm_est)  || null,
        plank_secs:    parseFloat(strength.plank_secs)    || null,
      },
      subjective: {
        sleep:  subjective.sleep  ?? 3,
        energy: subjective.energy ?? 3,
        stress: subjective.stress ?? 3,
        pain:   subjective.pain || 'none',
      },
      sport_profile: {
        sport,
        goals: obstacle,
        training_age: trainingAge,
        sessions_per_week: sessions,
      },
    }

    onComplete(results)
  }

  const plan = useMemo(() => planBattery(obstacle, sport), [obstacle, sport])

  const activeSteps = useMemo<Step[]>(
    () => ['movement', ...(plan.includeStrength ? (['strength'] as Step[]) : []), 'subjective'],
    [plan.includeStrength],
  )

  const stepForIndex: Step = step === 'saving' ? 'subjective' : step
  // Position in the flow is carried by the step-indicator dots in the header;
  // each step no longer prints its own "02 // STRENGTH BASELINES" heading.
  const currentStepIndex = Math.max(0, activeSteps.indexOf(stepForIndex))

  function goNext() {
    const next = activeSteps[activeSteps.indexOf(stepForIndex) + 1]
    if (next) setStep(next)
  }
  function goBack() {
    const prev = activeSteps[activeSteps.indexOf(stepForIndex) - 1]
    if (prev) setStep(prev)
  }

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--line)',
          position: 'sticky', top: 0, background: 'var(--ground)', zIndex: 10,
        }}
      >
        <Logo />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StepIndicator total={activeSteps.length} current={currentStepIndex} />
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              aria-label="Close — back to your workout"
              className="btn btn--ghost"
              style={{ padding: 0, height: 28, minWidth: 28, color: 'var(--text-dim)' }}
            >
              <X size={18} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        {step === 'movement' && (
          <MovementStep
            scores={movementScores}
            onScore={handleMovementScore}
            revealedInsights={revealedInsights}
            onNext={goNext}
          />
        )}

        {step === 'strength' && plan.includeStrength && (
          <StrengthStep
            data={strength}
            onChange={(k, v) => setStrength((prev) => ({ ...prev, [k]: v }))}
            onNext={goNext}
            onBack={goBack}
          />
        )}

        {(step === 'subjective' || step === 'saving') && (
          <SubjectiveStep
            data={subjective}
            onChange={(k, v) => setSubjective((prev) => ({ ...prev, [k]: v }))}
            onSubmit={handleSubmit}
            onBack={goBack}
            saving={step === 'saving'}
          />
        )}
      </div>
    </div>
  )
}
