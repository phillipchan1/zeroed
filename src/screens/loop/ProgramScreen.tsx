import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { SectionHeader, Skeleton, Divider, BracketFrame, TelemetryStrip } from '../../components/ui'
import type { ProgramRow, PhaseRow, RoutineRow, AthleteProfileRow } from '../../types/database'

/**
 * PROGRAM — the plan. The multi-week arc that governs training: current phase +
 * its objective, the session structure, the non-negotiable rules, and what
 * graduates you to the next phase. This is the "zoom out" from Train's "right
 * now"; the rules and structure that used to crowd Today live here.
 */
export function ProgramScreen({ athleteId }: { athleteId: string }) {
  const [program, setProgram] = useState<ProgramRow | null>(null)
  const [phase, setPhase]     = useState<PhaseRow | null>(null)
  const [routines, setRoutines] = useState<RoutineRow[]>([])
  const [profile, setProfile] = useState<AthleteProfileRow | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const [programRes, profileRes] = await Promise.all([
        supabase.from('program').select('*').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
        supabase.from('athlete_profile').select('*').eq('athlete_id', athleteId).maybeSingle(),
      ])
      const prog = programRes.data as ProgramRow | null
      setProgram(prog)
      setProfile(profileRes.data as AthleteProfileRow | null)

      if (prog) {
        const [phaseRes, routineRes] = await Promise.all([
          supabase.from('phase').select('*').eq('program_id', prog.id).eq('status', 'active').maybeSingle(),
          supabase.from('routine').select('*').eq('program_id', prog.id).order('name'),
        ])
        setPhase(phaseRes.data as PhaseRow | null)
        setRoutines((routineRes.data ?? []) as RoutineRow[])
      }
      setLoading(false)
    })()
  }, [athleteId])

  const retestDays = profile?.retest_date
    ? Math.ceil((new Date(profile.retest_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null

  let weekStr: string | null = null
  if (phase?.week_start && phase?.week_end) {
    const dayMs = 1000 * 60 * 60 * 24
    const start = new Date(phase.week_start).getTime()
    const total = Math.max(1, Math.round((new Date(phase.week_end).getTime() - start) / dayMs / 7) + 1)
    const current = Math.min(total, Math.max(1, Math.floor((Date.now() - start) / dayMs / 7) + 1))
    weekStr = `w${current}/${total}`
  }

  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = []
  if (phase?.name) telemetryItems.push({ label: 'PHASE', value: weekStr ? `${phase.name} ${weekStr}` : phase.name })
  if (retestDays !== null) telemetryItems.push({ label: 'RETEST', value: `${Math.max(0, retestDays)}d`, signal: retestDays <= 7 })

  const nonNegotiables = (phase?.non_negotiables as string[] | null) ?? []
  const advancement    = (phase?.advancement_criteria as string[] | null) ?? []

  return (
    <div className="screen with-nav">
      {!loading && telemetryItems.length > 0 && <TelemetryStrip items={telemetryItems} presence={false} />}

      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
          The plan
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Program</h2>

        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={10} width={80} /><Skeleton height={22} width={140} /><Skeleton height={12} width="90%" />
          </div>
        ) : !program ? (
          <div className="card">
            <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
              No active program yet. Finish onboarding and your first session builds here.
            </p>
          </div>
        ) : (
          <>
            {/* Current phase + objective */}
            <BracketFrame className="card fade-rise" style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <SectionHeader>Current phase</SectionHeader>
                {retestDays !== null && (
                  <span className={`num text-xs${retestDays <= 7 ? ' text-signal' : ' text-dim'}`}>
                    {retestDays > 0 ? `${retestDays}d to retest` : 'Retest due'}
                  </span>
                )}
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--signal)' }}>
                {phase?.name ?? profile?.current_phase ?? '—'}{weekStr ? ` · ${weekStr}` : ''}
              </span>
              {program.goal && (
                <p className="text-sm text-dim" style={{ marginTop: 10, lineHeight: 1.5 }}>{program.goal}</p>
              )}
            </BracketFrame>

            {/* Session structure */}
            <div className="fade-rise fade-rise-delay-1" style={{ marginBottom: 24 }}>
              <SectionHeader>Sessions</SectionHeader>
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {routines.length > 0 ? routines.map((r) => (
                  <div key={r.id} className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 600 }}>{r.name}</h3>
                      <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
                        {(r.exercises as unknown[]).length} exercises
                      </span>
                    </div>
                    {r.intent && <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{r.intent}</p>}
                  </div>
                )) : (
                  <p className="text-sm text-dim">No sessions in this phase yet.</p>
                )}
              </div>
            </div>

            {/* Non-negotiables — the rules that apply every session */}
            {nonNegotiables.length > 0 && (
              <div className="fade-rise fade-rise-delay-2" style={{ marginBottom: 24 }}>
                <SectionHeader>Non-negotiables</SectionHeader>
                <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Rules — every session, no skips
                </p>
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {nonNegotiables.map((rule, i) => (
                    <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5 }}>
                      <span className="num text-signal" style={{ fontSize: 13, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                      <span>{rule}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Advancement criteria — what graduates you */}
            {advancement.length > 0 && (
              <div className="fade-rise fade-rise-delay-3">
                <Divider />
                <SectionHeader>Advancement criteria</SectionHeader>
                <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 8, lineHeight: 1.6 }}>
                  What graduates you to the next phase.
                </p>
                <ul style={{ paddingLeft: 16 }}>
                  {advancement.map((c, i) => (
                    <li key={i} className="text-sm text-dim" style={{ lineHeight: 1.7 }}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
