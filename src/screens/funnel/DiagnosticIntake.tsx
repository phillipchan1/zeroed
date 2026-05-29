import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import {
  Logo, Button, Input, StepIndicator, ScorePicker,
  SectionHeader, InsightCard, Spinner, PresenceDot, TickingNumber,
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

function relativeFrom(anchorMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - anchorMs) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
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
    <div style={{ marginTop: 8, padding: '12px 14px', background: 'var(--ground)', border: '1px solid var(--line)', borderRadius: 8 }}>
      <p className="text-xs text-dim" style={{ lineHeight: 1.5, marginBottom: 10 }}>{test.setup}</p>
      <p style={{ fontSize: 13, marginBottom: 10, lineHeight: 1.5 }}>{q.prompt}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="outline" onClick={q.a.onClick} style={{ flex: 1 }}>{q.a.label}</Button>
        <Button variant="ghost"   onClick={q.b.onClick} style={{ flex: 1 }}>{q.b.label}</Button>
      </div>
    </div>
  )
}

function MovementStep({
  stepNo,
  scores,
  onScore,
  revealedInsights,
  startedAtMs,
  onNext,
}: {
  stepNo: number
  scores: Record<string, number | null>
  onScore: (key: string, score: number) => void
  revealedInsights: InsightRow[]
  startedAtMs: number
  onNext: () => void
}) {
  const allScored = MOVEMENT_PATTERNS.every((p) => scores[p.key] !== null)
  const [guidedKey, setGuidedKey] = useState<string | null>(null)

  // Tick the "STARTED" relative time every second.
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const scoredCount = MOVEMENT_PATTERNS.filter((p) => scores[p.key] !== null).length
  const weakLinkCount = MOVEMENT_PATTERNS.filter((p) => (scores[p.key] ?? 3) < 2).length
  const emergingCategory = detectEmergingCategory(scores)

  return (
    <div>
      {/* Live screening telemetry — converts the form into an observed event.
          One presence dot per screen lives here. */}
      <div className="telemetry-strip" style={{ marginLeft: -20, marginRight: -20, marginBottom: 20, marginTop: -24 }}>
        <span className="telemetry-strip__item"><PresenceDot /></span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">SCREENING <span className="num">{scoredCount}/7</span></span>
        <span className="telemetry-strip__sep">·</span>
        <span className={`telemetry-strip__item${weakLinkCount > 0 ? ' telemetry-strip__signal' : ''}`}>
          WEAK LINKS <TickingNumber value={weakLinkCount} className="num" />
        </span>
        <span className="telemetry-strip__sep">·</span>
        <span className="telemetry-strip__item">STARTED {relativeFrom(startedAtMs)}</span>
      </div>

      <SectionHeader>{String(stepNo).padStart(2, '0')} // FIND YOUR WEAKNESSES</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        How you move determines what you can load. Tap
        <span className="text-signal"> Test me</span> on any pattern and we'll walk you through it with
        yes/no questions — or score it yourself.
      </p>

      {/* Pattern emerging callout — the system is thinking as you go. */}
      {emergingCategory && (
        <p className="fade-rise" style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.6 }}>
          <span className="num text-signal">PATTERN EMERGING — </span>
          your {emergingCategory.toLowerCase()} looks like the bigger story.
        </p>
      )}

      {/* Scoring rubric */}
      <div
        style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          padding: '12px 14px', background: 'var(--surface)',
          border: '1px solid var(--line)', borderRadius: 8, marginBottom: 24,
        }}
      >
        <span className="text-xs text-dim"><span className="num text-signal">0</span> — pain anywhere in the movement</span>
        <span className="text-xs text-dim"><span className="num text-signal">1</span> — can't complete it</span>
        <span className="text-xs text-dim"><span className="num text-signal">2</span> — complete it, but with compensation or wobble</span>
        <span className="text-xs text-dim"><span className="num text-signal">3</span> — clean, controlled, no compensation</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {MOVEMENT_PATTERNS.map((pattern) => {
          const scored = scores[pattern.key] !== null
          const guided = guidedKey === pattern.key
          return (
            <div key={pattern.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{pattern.label}</span>
                <span className="text-xs text-dim">{pattern.category}</span>
              </div>
              {PATTERN_GUIDE[pattern.key] && (
                <p className="text-xs text-dim" style={{ marginBottom: 8, lineHeight: 1.5 }}>
                  {PATTERN_GUIDE[pattern.key]}
                </p>
              )}

              {guided ? (
                <GuidedMovementTest
                  patternKey={pattern.key}
                  onResolve={(s) => { onScore(pattern.key, s); setGuidedKey(null) }}
                />
              ) : !scored ? (
                <>
                  {/* Test me is the primary affordance for unfamiliar patterns. */}
                  <Button variant="outline" full onClick={() => setGuidedKey(pattern.key)}>
                    Test me — walk me through it →
                  </Button>
                  <p className="text-xs text-dim" style={{ margin: '10px 0 6px' }}>
                    Already know it? Score it yourself.
                  </p>
                  <ScorePicker value={null} onChange={(s) => onScore(pattern.key, s)} />
                </>
              ) : (
                <>
                  <ScorePicker value={scores[pattern.key]} onChange={(s) => onScore(pattern.key, s)} />
                  <button
                    type="button"
                    onClick={() => setGuidedKey(pattern.key)}
                    className="text-xs text-dim link-button"
                    style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    Re-test — walk me through it →
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Micro-reveal: insights surface as patterns are scored */}
      {revealedInsights.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <p className="text-xs text-dim" style={{ marginBottom: 12, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            Weak link identified
          </p>
          {revealedInsights.map((ins, i) => (
            <InsightReveal key={ins.id} insight={ins} index={i} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 32 }}>
        <Button variant="primary" full disabled={!allScored} onClick={onNext}>
          Continue →
        </Button>
      </div>
    </div>
  )
}

function StrengthStep({
  stepNo, data, onChange, onNext, onBack,
}: {
  stepNo: number
  data: StrengthData
  onChange: (key: keyof StrengthData, val: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const fields: Array<{ key: keyof StrengthData; label: string; placeholder: string }> = [
    { key: 'squat_1rm_est', label: 'Back Squat — estimated 1RM (kg)', placeholder: '0' },
    { key: 'hinge_1rm_est', label: 'Hip Hinge / Deadlift — estimated 1RM (kg)', placeholder: '0' },
    { key: 'push_1rm_est',  label: 'Press (Bench or Push Press) — estimated 1RM (kg)', placeholder: '0' },
    { key: 'pull_1rm_est',  label: 'Pull (Row or Pull-Up) — estimated 1RM (kg)', placeholder: '0' },
    { key: 'plank_secs',    label: 'Plank hold — seconds', placeholder: '0' },
  ]

  return (
    <div>
      <SectionHeader>{String(stepNo).padStart(2, '0')} // STRENGTH BASELINES</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Strength baselines next. Approximate is fine — these set your starting load, not your max.
        Leave at 0 if untested.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {fields.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>{label}</label>
            <Input
              type="number"
              inputMode="decimal"
              placeholder={placeholder}
              value={data[key]}
              onChange={(e) => onChange(key, e.target.value)}
              mono
            />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 32, display: 'flex', gap: 8 }}>
        <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
        <Button variant="primary" onClick={onNext} style={{ flex: 2 }}>Continue →</Button>
      </div>
    </div>
  )
}

function SubjectiveStep({
  stepNo, data, onChange, onSubmit, onBack, saving,
}: {
  stepNo: number
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
      <SectionHeader>{String(stepNo).padStart(2, '0')} // READINESS</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Last check — how you're showing up today. Calibrates day-one load to where you actually are.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {scaleFields.map(({ key, label, anchor }) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontSize: 14 }}>{label}</span>
              {data[key] !== null ? (
                <span className="num text-signal" style={{ fontSize: 14 }}>{data[key]}/3</span>
              ) : (
                <span className="text-xs text-dim">{anchor}</span>
              )}
            </div>
            <ScorePicker value={data[key]} onChange={(v) => onChange(key, v)} />
          </div>
        ))}

        <div>
          <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>
            Pain or discomfort — describe or write "none"
          </label>
          <textarea
            className="input"
            placeholder="e.g. Mild left knee ache, or: none"
            value={data.pain}
            onChange={(e) => onChange('pain', e.target.value)}
            rows={2}
          />
        </div>
      </div>

      <div style={{ marginTop: 32, display: 'flex', gap: 8 }}>
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
}

export function DiagnosticIntake({ obstacle, sport, trainingAge, sessions, onComplete }: ScreeningProps) {
  const [step, setStep] = useState<Step>('movement')
  const startedAtRef = useRef<number>(Date.now())

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
  const currentStepIndex = Math.max(0, activeSteps.indexOf(stepForIndex))
  const stepNo = (s: Step) => activeSteps.indexOf(s) + 1

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
        <StepIndicator total={activeSteps.length} current={currentStepIndex} />
      </div>

      <div style={{ flex: 1, padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        {step === 'movement' && (
          <MovementStep
            stepNo={stepNo('movement')}
            scores={movementScores}
            onScore={handleMovementScore}
            revealedInsights={revealedInsights}
            startedAtMs={startedAtRef.current}
            onNext={goNext}
          />
        )}

        {step === 'strength' && plan.includeStrength && (
          <StrengthStep
            stepNo={stepNo('strength')}
            data={strength}
            onChange={(k, v) => setStrength((prev) => ({ ...prev, [k]: v }))}
            onNext={goNext}
            onBack={goBack}
          />
        )}

        {(step === 'subjective' || step === 'saving') && (
          <SubjectiveStep
            stepNo={stepNo('subjective')}
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
