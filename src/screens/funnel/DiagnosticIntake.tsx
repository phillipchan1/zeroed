import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { generateInsightsFromDiagnostic } from '../../engine'
import {
  Logo, Button, Input, StepIndicator, ScorePicker,
  SectionHeader, InsightCard, Spinner,
} from '../../components/ui'
import type { DiagnosticResults, InsightRow } from '../../types/database'
import { MOVEMENT_PATTERNS } from '../../types/database'

// ---- Types -----------------------------------------------------------------

interface SportProfile {
  name: string
  sport: string
  goals: string
  training_age: string     // string for controlled input
  sessions_per_week: string
}

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

type Step = 'profile' | 'movement' | 'strength' | 'subjective' | 'saving'

// Goal-first ordering: we ask what the athlete wants BEFORE we screen them,
// so the diagnostic reads as the answer to a question they just asked.
// The active step list is built dynamically from the battery plan (below),
// so step numbering and the progress indicator adapt per athlete.

// ---- Goal → battery mapping ------------------------------------------------
// A good coach doesn't run the same combine on a marathoner and a powerlifter.
// The movement screen is the universal spine (everyone benefits from knowing
// how they move); strength baselines are switched on only when the goal needs
// them. For pain-led rehab and pure-endurance goals a 1RM ask is irrelevant
// (and intimidating), so we skip it and let the movement screen carry the load.

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

  // Precedence: an explicit strength/sport intent wins — those athletes want
  // (and expect) load testing even if they also mention a niggle.
  let goalType: GoalType = 'general'
  if (isStrength) goalType = 'strength'
  else if (isSport) goalType = 'sport'
  else if (isRehab) goalType = 'rehab'
  else if (isEndurance) goalType = 'endurance'

  const includeStrength = !(goalType === 'rehab' || goalType === 'endurance')

  return { goalType, includeStrength }
}

// Plain-language "why" + how-to for each movement pattern. The athlete is
// self-scoring, so they need to know what each test reveals and how to grade it.
const PATTERN_GUIDE: Record<string, string> = {
  deep_squat:        'Whole-body mobility — ankles, hips, and upper back working together. Limits how deep and upright you can load a squat.',
  hurdle_step:       'Single-leg control and hip stability. Where most landing and cutting issues show up.',
  inline_lunge:      'Stability in a split stance — balance, hip flexibility, and trunk control under a stagger.',
  shoulder_mobility: 'Overhead range and shoulder freedom. Gates pressing, pulling, and anything over your head.',
  aslr:              'Hamstring and posterior chain length, plus core control. Underpins hinging and sprinting.',
  trunk_stability:   'Can your core stay rigid while your limbs move? Protects the spine when you press and push.',
  rotary_stability:  'Coordinated core control across the body — the base for rotation, throwing, and change of direction.',
}

// Guided "test me" decomposition. When an athlete can't honestly self-grade a
// pattern, we hand them the protocol and a set of observable yes/no checks, then
// compute the 0–3 score deterministically — facts they can see, not a grade they
// have to judge. (Prompt 3: replace with video/vision-based scoring.)
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

// Guided self-test: walks the athlete through the protocol and resolves a 0–3
// score from observable yes/no answers instead of asking them to grade themselves.
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
  onNext,
  onBack,
}: {
  stepNo: number
  scores: Record<string, number | null>
  onScore: (key: string, score: number) => void
  revealedInsights: InsightRow[]
  onNext: () => void
  onBack: () => void
}) {
  const allScored = MOVEMENT_PATTERNS.every((p) => scores[p.key] !== null)
  const [guidedKey, setGuidedKey] = useState<string | null>(null)

  return (
    <div>
      <SectionHeader>{String(stepNo).padStart(2, '0')} // FIND YOUR WEAKNESSES</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        How you move determines what you can load. Score each pattern. Tap
        <span className="text-signal"> Test me</span> if you'd rather we walk you through it.
      </p>

      {/* Scoring rubric — the athlete is self-grading, so define the scale plainly */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '12px 14px',
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          marginBottom: 24,
        }}
      >
        <span className="text-xs text-dim"><span className="num text-signal">0</span> — pain anywhere in the movement</span>
        <span className="text-xs text-dim"><span className="num text-signal">1</span> — can't complete it</span>
        <span className="text-xs text-dim"><span className="num text-signal">2</span> — complete it, but with compensation or wobble</span>
        <span className="text-xs text-dim"><span className="num text-signal">3</span> — clean, controlled, no compensation</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {MOVEMENT_PATTERNS.map((pattern) => (
          <div key={pattern.key}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500 }}>{pattern.label}</span>
              <span className="text-xs text-dim">{pattern.category}</span>
            </div>
            {PATTERN_GUIDE[pattern.key] && (
              <p className="text-xs text-dim" style={{ marginBottom: 8, lineHeight: 1.5 }}>
                {PATTERN_GUIDE[pattern.key]}
              </p>
            )}
            <ScorePicker
              value={scores[pattern.key] ?? null}
              onChange={(s) => onScore(pattern.key, s)}
            />
            {guidedKey === pattern.key ? (
              <GuidedMovementTest
                patternKey={pattern.key}
                onResolve={(s) => { onScore(pattern.key, s); setGuidedKey(null) }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setGuidedKey(pattern.key)}
                className="text-xs text-dim link-button"
                style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                Not sure how to score? Test me →
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Micro-reveal: insights surface as patterns are scored */}
      {revealedInsights.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <p
            className="text-xs text-dim"
            style={{ marginBottom: 12, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}
          >
            Weak link identified
          </p>
          {revealedInsights.map((ins, i) => (
            <InsightReveal key={ins.id} insight={ins} index={i} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 32, display: 'flex', gap: 8 }}>
        <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
        <Button variant="primary" disabled={!allScored} onClick={onNext} style={{ flex: 2 }}>
          Continue →
        </Button>
      </div>
    </div>
  )
}

function StrengthStep({
  stepNo,
  data,
  onChange,
  onNext,
  onBack,
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
        Strength baselines. Sets the starting load. Approximate is fine — leave at 0 if untested.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {fields.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>
              {label}
            </label>
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

function ProfileStep({
  stepNo,
  data,
  onChange,
  onNext,
  onBack,
}: {
  stepNo: number
  data: SportProfile
  onChange: (key: keyof SportProfile, val: string) => void
  onNext: () => void
  onBack?: () => void
}) {
  const complete = data.name.trim() && data.sport.trim()

  return (
    <div>
      <SectionHeader>{String(stepNo).padStart(2, '0')} // WHAT YOU'RE CHASING</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Start with the goal. Everything after this is built around it.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>Name</label>
          <Input
            type="text"
            placeholder="Your name"
            value={data.name}
            onChange={(e) => onChange('name', e.target.value)}
            autoCapitalize="words"
          />
        </div>

        <div>
          <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>Sport or activity</label>
          <Input
            type="text"
            placeholder="e.g. Football, CrossFit, Tennis, General fitness"
            value={data.sport}
            onChange={(e) => onChange('sport', e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>Primary goal</label>
          <textarea
            className="input"
            placeholder="e.g. Reduce knee pain and build base strength for rugby season"
            value={data.goals}
            onChange={(e) => onChange('goals', e.target.value)}
            rows={3}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>
              Years training
            </label>
            <Input
              type="number"
              inputMode="numeric"
              placeholder="0"
              value={data.training_age}
              onChange={(e) => onChange('training_age', e.target.value)}
              mono
            />
          </div>
          <div>
            <label className="text-xs text-dim" style={{ display: 'block', marginBottom: 6 }}>
              Sessions / week
            </label>
            <Input
              type="number"
              inputMode="numeric"
              placeholder="3"
              value={data.sessions_per_week}
              onChange={(e) => onChange('sessions_per_week', e.target.value)}
              mono
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 32, display: 'flex', gap: 8 }}>
        {onBack && (
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
        )}
        <Button variant="primary" full={!onBack} onClick={onNext} disabled={!complete} style={{ flex: 2 }}>
          Continue →
        </Button>
      </div>
    </div>
  )
}

function SubjectiveStep({
  stepNo,
  data,
  onChange,
  onSubmit,
  onBack,
  saving,
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
        Last input. Calibrates day-one load to where you actually are.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {scaleFields.map(({ key, label, anchor }) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontSize: 14 }}>{label}</span>
              {data[key] !== null ? (
                <span className="num text-signal" style={{ fontSize: 14 }}>
                  {data[key]}/3
                </span>
              ) : (
                <span className="text-xs text-dim">{anchor}</span>
              )}
            </div>
            <ScorePicker
              value={data[key]}
              onChange={(v) => onChange(key, v)}
            />
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
        <Button variant="ghost" onClick={onBack} style={{ flex: 1 }} disabled={saving}>
          ← Back
        </Button>
        <Button
          variant="primary"
          onClick={onSubmit}
          style={{ flex: 2 }}
          disabled={saving || !data.pain.trim()}
        >
          {saving ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner /> Analysing…
            </span>
          ) : (
            'Run diagnostic →'
          )}
        </Button>
      </div>
    </div>
  )
}

// ---- Main component --------------------------------------------------------

interface DiagnosticIntakeProps {
  athleteId: string | null
  userId: string
  onComplete: () => void
}

export function DiagnosticIntake({ athleteId: existingAthleteId, userId, onComplete }: DiagnosticIntakeProps) {
  const navigate = useNavigate()

  // Step state — goal-first: profile leads, then we screen
  const [step, setStep] = useState<Step>('profile')

  // Movement scores: null = not yet scored
  const [movementScores, setMovementScores] = useState<Record<string, number | null>>(
    () => Object.fromEntries(MOVEMENT_PATTERNS.map((p) => [p.key, null]))
  )

  // Insights revealed so far (micro-reveals during movement step)
  const [revealedInsights, setRevealedInsights] = useState<InsightRow[]>([])

  // Other step data
  const [strength, setStrength] = useState<StrengthData>({
    squat_1rm_est: '', hinge_1rm_est: '', push_1rm_est: '', pull_1rm_est: '', plank_secs: '',
  })

  const [sportProfile, setSportProfile] = useState<SportProfile>({
    name: '', sport: '', goals: '', training_age: '', sessions_per_week: '3',
  })

  const [subjective, setSubjective] = useState<SubjectiveData>({
    sleep: null, energy: null, stress: null, pain: '',
  })

  // Handle scoring a movement pattern — reveal insight immediately if weak
  const handleMovementScore = useCallback((key: string, score: number) => {
    setMovementScores((prev) => ({ ...prev, [key]: score }))

    if (score < 2) {
      // Build a preview insight to show during intake (not yet saved to DB)
      const pattern = MOVEMENT_PATTERNS.find((p) => p.key === key)
      if (!pattern) return

      const alreadyRevealed = revealedInsights.find(
        (i) => i.claim.includes(pattern.label)
      )
      if (alreadyRevealed) return

      // Count existing weak patterns to assign priority
      const weakCount = Object.values(movementScores).filter((s) => s !== null && s < 2).length

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

      setRevealedInsights((prev) => {
        // Update priority ordering as we learn more
        const updated = prev.filter((i) => i.id !== `preview-${key}`)
        return [...updated, preview].sort((a, b) =>
          a.priority.localeCompare(b.priority)
        )
      })
    } else {
      // Score ≥ 2: remove any previously revealed insight for this pattern
      setRevealedInsights((prev) => prev.filter((i) => !i.claim.includes(
        MOVEMENT_PATTERNS.find((p) => p.key === key)?.label ?? ''
      )))
    }
  }, [movementScores, revealedInsights])

  // Submit the full diagnostic
  async function handleSubmit() {
    setStep('saving')

    const results: DiagnosticResults = {
      movement: Object.fromEntries(
        MOVEMENT_PATTERNS.map((p) => [p.key, movementScores[p.key] ?? 3])
      ),
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
        sport:            sportProfile.sport,
        goals:            sportProfile.goals,
        training_age:     parseInt(sportProfile.training_age) || 0,
        sessions_per_week: parseInt(sportProfile.sessions_per_week) || 3,
      },
    }

    let athleteId = existingAthleteId

    // 1. Create or update athlete row
    if (!athleteId) {
      const { data: newAthlete, error: athleteErr } = await supabase
        .from('athlete')
        .insert({
          auth_user_id: userId,
          name: sportProfile.name || null,
          sport: sportProfile.sport || null,
          goals: sportProfile.goals || null,
          training_age: parseInt(sportProfile.training_age) || null,
          sessions_per_week: parseInt(sportProfile.sessions_per_week) || null,
        })
        .select()
        .single()

      if (athleteErr || !newAthlete) {
        console.error('Failed to create athlete', athleteErr)
        setStep('subjective')
        return
      }
      athleteId = newAthlete.id
    } else {
      await supabase.from('athlete').update({
        name: sportProfile.name || null,
        sport: sportProfile.sport || null,
        goals: sportProfile.goals || null,
        training_age: parseInt(sportProfile.training_age) || null,
        sessions_per_week: parseInt(sportProfile.sessions_per_week) || null,
      }).eq('id', athleteId)
    }

    // 2. Save diagnostic row
    const { data: diagRow, error: diagErr } = await supabase
      .from('diagnostic')
      .insert({
        athlete_id: athleteId,
        test_battery: {
          movement_patterns: MOVEMENT_PATTERNS.map((p) => p.label),
          strength_tests: ['Squat', 'Hip Hinge', 'Push', 'Pull', 'Core'],
          subjective: ['sleep', 'energy', 'stress', 'pain'],
        },
        raw_results: results,
        version: 1,
      })
      .select()
      .single()

    if (diagErr || !diagRow) {
      console.error('Failed to save diagnostic', diagErr)
      setStep('subjective')
      return
    }

    // 3. Generate and save insights (deterministic placeholder)
    const generatedInsights = generateInsightsFromDiagnostic(
      athleteId!,
      diagRow.id,
      results,
    )

    if (generatedInsights.length > 0) {
      await supabase.from('insight').insert(generatedInsights)
    }

    // Navigate to ZeroedIn screen
    onComplete()
    navigate('/zeroed-in')
  }

  // Goal-adaptive battery: the goal selects which tests we run. Movement is the
  // universal spine; strength baselines switch on only when the goal needs them.
  const plan = useMemo(
    () => planBattery(sportProfile.goals, sportProfile.sport),
    [sportProfile.goals, sportProfile.sport],
  )

  const activeSteps = useMemo<Step[]>(
    () => [
      'profile',
      'movement',
      ...(plan.includeStrength ? (['strength'] as Step[]) : []),
      'subjective',
    ],
    [plan.includeStrength],
  )

  // 'saving' shares the subjective screen for indexing purposes
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
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid var(--line)',
          position: 'sticky',
          top: 0,
          background: 'var(--ground)',
          zIndex: 10,
        }}
      >
        <Logo />
        <StepIndicator total={activeSteps.length} current={currentStepIndex} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        {step === 'profile' && (
          <ProfileStep
            stepNo={stepNo('profile')}
            data={sportProfile}
            onChange={(k, v) => setSportProfile((prev) => ({ ...prev, [k]: v }))}
            onNext={goNext}
          />
        )}

        {step === 'movement' && (
          <MovementStep
            stepNo={stepNo('movement')}
            scores={movementScores}
            onScore={handleMovementScore}
            revealedInsights={revealedInsights}
            onNext={goNext}
            onBack={goBack}
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
