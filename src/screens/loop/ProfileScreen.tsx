import { useEffect, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import {
  InsightCard, SectionHeader, Skeleton, Divider, StatusCounts,
} from '../../components/ui'
import { countInsightsByStatus } from '../../engine'
import type { InsightRow, AthleteProfileRow, ProgramRow, PhaseRow } from '../../types/database'

interface ProfileScreenProps {
  athleteId: string
  athleteName: string | null
}

export function ProfileScreen({ athleteId, athleteName }: ProfileScreenProps) {
  const location = useLocation()

  // After a workout, navigate here with state: { pulsedCategory: string }
  const pulsedCategory = (location.state as { pulsedCategory?: string } | null)?.pulsedCategory

  const [insights, setInsights]   = useState<InsightRow[]>([])
  const [profile, setProfile]     = useState<AthleteProfileRow | null>(null)
  const [program, setProgram]     = useState<ProgramRow | null>(null)
  const [phase, setPhase]         = useState<PhaseRow | null>(null)
  const [loading, setLoading]     = useState(true)

  const load = useCallback(async () => {
    setLoading(true)

    const [insightRes, profileRes, programRes] = await Promise.all([
      // Load ALL statuses so the header can count by status (incl. resolved);
      // the weak-link stack filters to active ones client-side.
      supabase
        .from('insight')
        .select('*')
        .eq('athlete_id', athleteId)
        .order('priority'),
      supabase
        .from('athlete_profile')
        .select('*')
        .eq('athlete_id', athleteId)
        .maybeSingle(),
      supabase
        .from('program')
        .select('*')
        .eq('athlete_id', athleteId)
        .eq('status', 'active')
        .maybeSingle(),
    ])

    setInsights((insightRes.data ?? []) as InsightRow[])
    setProfile(profileRes.data as AthleteProfileRow | null)
    setProgram(programRes.data as ProgramRow | null)

    if (programRes.data) {
      const { data: phaseData } = await supabase
        .from('phase')
        .select('*')
        .eq('program_id', programRes.data.id)
        .eq('status', 'active')
        .maybeSingle()
      setPhase(phaseData as PhaseRow | null)
    }

    setLoading(false)
  }, [athleteId])

  useEffect(() => { load() }, [load])

  // After an observation write-back, reload after a tick so the pulse animation fires
  useEffect(() => {
    if (pulsedCategory) {
      // Clear the location state so it doesn't re-pulse on back navigation
      window.history.replaceState({}, '')
    }
  }, [pulsedCategory])

  function retestDaysRemaining(): number | null {
    if (!profile?.retest_date) return null
    const today  = new Date()
    const retest = new Date(profile.retest_date)
    const diff   = Math.ceil((retest.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    return diff
  }

  const retestDays = retestDaysRemaining()

  // All statuses drive the header counts; the stack shows active weak links only.
  const statusCounts   = countInsightsByStatus(insights)
  const activeInsights = insights.filter(
    (i) => i.status !== 'resolved' && i.status !== 'disproved',
  )

  return (
    <div className="screen with-nav">
      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>

        {/* Header */}
        <div className="fade-rise" style={{ marginBottom: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <p className="text-xs text-dim" style={{
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}>
              Athlete profile
            </p>
            <h2 style={{ marginTop: 4, fontSize: 22, fontWeight: 600 }}>
              {athleteName ?? 'Profile'}
            </h2>
            {!loading && statusCounts.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <StatusCounts counts={statusCounts} />
              </div>
            )}
          </div>
          <button
            className="btn btn--ghost text-xs"
            style={{ height: 32, padding: '0 8px', marginTop: 4 }}
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>

        {/* Program snapshot */}
        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={10} width={80} />
            <Skeleton height={18} width={140} />
            <Skeleton height={10} width={100} />
          </div>
        ) : profile && (
          <div className="card fade-rise fade-rise-delay-1" style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <SectionHeader>Current phase</SectionHeader>
              {retestDays !== null && (
                <span
                  className={`num text-xs${retestDays <= 7 ? ' text-signal' : ' text-dim'}`}
                  title="Days until retest"
                >
                  {retestDays > 0 ? `${retestDays}d to retest` : 'Retest due'}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 20,
                fontWeight: 600,
                color: 'var(--signal)',
              }}>
                {profile.current_phase ?? '—'}
              </span>
              {program?.goal && (
                <span className="text-xs text-dim" style={{ maxWidth: 160, textAlign: 'right', lineHeight: 1.4 }}>
                  {program.goal}
                </span>
              )}
            </div>

            {/* Phase non-negotiables */}
            {phase?.non_negotiables && (phase.non_negotiables as string[]).length > 0 && (
              <>
                <Divider />
                <p className="text-xs text-dim" style={{ marginBottom: 8, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Non-negotiables
                </p>
                <ul style={{ paddingLeft: 16 }}>
                  {(phase.non_negotiables as string[]).map((item, i) => (
                    <li key={i} className="text-sm text-dim" style={{ lineHeight: 1.7 }}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* Insight stack */}
        <div className="fade-rise fade-rise-delay-2">
          <SectionHeader>02 // WEAK LINK STACK</SectionHeader>

          <div style={{ marginTop: 12 }}>
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="card" style={{ marginBottom: 8 }}>
                  <Skeleton height={10} width={80} />
                  <div style={{ height: 8 }} />
                  <Skeleton height={14} width="90%" />
                  <div style={{ height: 4 }} />
                  <Skeleton height={11} width="70%" />
                </div>
              ))
            ) : activeInsights.length > 0 ? (
              activeInsights.map((ins) => (
                <InsightCard
                  key={ins.id}
                  insight={ins}
                  pulse={ins.category === pulsedCategory}
                />
              ))
            ) : (
              <p className="text-sm text-dim">
                No active weak links. Complete a diagnostic to populate this view.
              </p>
            )}
          </div>
        </div>

        {/* Advancement criteria */}
        {phase?.advancement_criteria && (phase.advancement_criteria as string[]).length > 0 && (
          <div className="fade-rise fade-rise-delay-3" style={{ marginTop: 24 }}>
            <SectionHeader>Advancement criteria</SectionHeader>
            <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 8, lineHeight: 1.6 }}>
              These conditions trigger progression to the Strength phase.
            </p>
            <ul style={{ paddingLeft: 16 }}>
              {(phase.advancement_criteria as string[]).map((c, i) => (
                <li key={i} className="text-sm text-dim" style={{ lineHeight: 1.7 }}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {/* TODO Prompt 2: resolved insights archive section */}
        {/* TODO Prompt 2: Re-Diagnostic delta view (shows score changes from baseline) */}
      </div>
    </div>
  )
}
