import { useState, useCallback } from 'react'
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

type Step = 'movement' | 'strength' | 'profile' | 'subjective' | 'saving'

const STEP_INDICES: Record<Step, number> = {
  movement: 0,
  strength: 1,
  profile: 2,
  subjective: 3,
  saving: 3,
}

const TOTAL_STEPS = 4

// ---- Helper: micro-reveal --------------------------------------------------

function InsightReveal({ insight, index }: { insight: InsightRow; index: number }) {
  const delay = `fade-rise-delay-${Math.min(index + 1, 4) as 1 | 2 | 3 | 4}`
  return (
    <div className={`fade-rise ${delay}`}>
      <InsightCard insight={insight} />
    </div>
  )
}

// ---- Step sub-components ---------------------------------------------------

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

  return (
    <div>
      <SectionHeader>01 // MOVEMENT SCREEN</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Score each pattern 0–3. Perform as described. Be honest — this determines everything.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {MOVEMENT_PATTERNS.map((pattern) => (
          <div key={pattern.key}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500 }}>{pattern.label}</span>
              <span className="text-xs text-dim">{pattern.category}</span>
            </div>
            <ScorePicker
              value={scores[pattern.key] ?? null}
              onChange={(s) => onScore(pattern.key, s)}
            />
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

      <div style={{ marginTop: 32 }}>
        <Button variant="primary" full disabled={!allScored} onClick={onNext}>
          Continue →
        </Button>
      </div>
    </div>
  )
}

function StrengthStep({
  data,
  onChange,
  onNext,
  onBack,
}: {
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
      <SectionHeader>02 // STRENGTH BASELINES</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Approximate values are fine. Leave at 0 if untested. These set your load prescription.
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
  data,
  onChange,
  onNext,
  onBack,
}: {
  data: SportProfile
  onChange: (key: keyof SportProfile, val: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const complete = data.name.trim() && data.sport.trim()

  return (
    <div>
      <SectionHeader>03 // SPORT & GOAL PROFILE</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Brief answers. This shapes program design and AI coaching context.
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
        <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
        <Button variant="primary" onClick={onNext} disabled={!complete} style={{ flex: 2 }}>
          Continue →
        </Button>
      </div>
    </div>
  )
}

function SubjectiveStep({
  data,
  onChange,
  onSubmit,
  onBack,
  saving,
}: {
  data: SubjectiveData
  onChange: (key: keyof SubjectiveData, val: number | string) => void
  onSubmit: () => void
  onBack: () => void
  saving: boolean
}) {
  const scaleFields: Array<{ key: 'sleep' | 'energy' | 'stress'; label: string }> = [
    { key: 'sleep',  label: 'Sleep quality' },
    { key: 'energy', label: 'Energy level' },
    { key: 'stress', label: 'Stress level (1 = low)' },
  ]

  return (
    <div>
      <SectionHeader>04 // READINESS</SectionHeader>
      <p className="text-dim" style={{ marginTop: 8, marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        Your baseline today. Honest inputs calibrate load prescription.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {scaleFields.map(({ key, label }) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 14 }}>{label}</span>
              {data[key] !== null && (
                <span className="num text-signal" style={{ fontSize: 14 }}>
                  {data[key]}/5
                </span>
              )}
            </div>
            <ScorePicker
              value={data[key]}
              onChange={(v) => onChange(key, v === 0 ? 1 : v)}
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

  // Step state
  const [step, setStep] = useState<Step>('movement')

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

  const currentStepIndex = STEP_INDICES[step]

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
        <StepIndicator total={TOTAL_STEPS} current={currentStepIndex} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        {step === 'movement' && (
          <MovementStep
            scores={movementScores}
            onScore={handleMovementScore}
            revealedInsights={revealedInsights}
            onNext={() => setStep('strength')}
          />
        )}

        {step === 'strength' && (
          <StrengthStep
            data={strength}
            onChange={(k, v) => setStrength((prev) => ({ ...prev, [k]: v }))}
            onNext={() => setStep('profile')}
            onBack={() => setStep('movement')}
          />
        )}

        {step === 'profile' && (
          <ProfileStep
            data={sportProfile}
            onChange={(k, v) => setSportProfile((prev) => ({ ...prev, [k]: v }))}
            onNext={() => setStep('subjective')}
            onBack={() => setStep('strength')}
          />
        )}

        {(step === 'subjective' || step === 'saving') && (
          <SubjectiveStep
            data={subjective}
            onChange={(k, v) => setSubjective((prev) => ({ ...prev, [k]: v }))}
            onSubmit={handleSubmit}
            onBack={() => setStep('profile')}
            saving={step === 'saving'}
          />
        )}
      </div>
    </div>
  )
}
