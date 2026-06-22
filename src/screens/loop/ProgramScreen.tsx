import { Fragment, useState } from 'react'
import { History, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { SectionHeader, Skeleton, BracketFrame } from '../../components/ui'
import { ExerciseHistorySheet } from '../../components/ExerciseHistorySheet'
import type { ProgramRow, PhaseRow, RoutineRow, AthleteProfileRow, PhaseName, ExerciseTemplate } from '../../types/database'

/**
 * PROGRAM — "you are here." The macro view (per the Notion Screen Architecture
 * spec): the phase arc Stability → Strength → Power → Sport, where you are in it,
 * the gates that graduate you, the session structure, and the non-negotiables.
 *
 * Doctrine: this is an INSTRUMENT showing position, not a game. No streaks, no
 * levels, no XP bar. The arc is static (a phase changes every ~5 weeks, not live
 * — only the moment of advancement would earn a one-time pulse). Phase is
 * data-driven from phase.name, so the arc moves on its own once the coach-driven
 * advancement engine flips it. Gates show pending (amber) until that lands.
 */

const PHASES: PhaseName[] = ['Stability', 'Strength', 'Power', 'Sport']

interface ProgramView {
  program: ProgramRow | null
  phase: PhaseRow | null
  routines: RoutineRow[]
  profile: AthleteProfileRow | null
}

async function fetchProgramView(athleteId: string): Promise<ProgramView> {
  const [programRes, profileRes] = await Promise.all([
    supabase.from('program').select('*').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
    supabase.from('athlete_profile').select('*').eq('athlete_id', athleteId).maybeSingle(),
  ])
  if (programRes.error) throw programRes.error
  if (profileRes.error) throw profileRes.error
  const program = programRes.data as ProgramRow | null
  const profile = profileRes.data as AthleteProfileRow | null

  let phase: PhaseRow | null = null
  let routines: RoutineRow[] = []
  if (program) {
    const phaseRes = await supabase
      .from('phase').select('*').eq('program_id', program.id).eq('status', 'active').maybeSingle()
    phase = phaseRes.data as PhaseRow | null

    // Sessions belong to the ACTIVE phase only (a completed phase's routines
    // stay on the program but must not surface), falling back to all.
    let routineRes = phase
      ? await supabase.from('routine').select('*').eq('program_id', program.id).eq('phase_id', phase.id).order('name')
      : await supabase.from('routine').select('*').eq('program_id', program.id).order('name')
    if (phase && (!routineRes.data || routineRes.data.length === 0)) {
      routineRes = await supabase.from('routine').select('*').eq('program_id', program.id).order('name')
    }
    routines = (routineRes.data ?? []) as RoutineRow[]
  }
  return { program, phase, routines, profile }
}

export function ProgramScreen({ athleteId }: { athleteId: string }) {
  const [historyExercise, setHistoryExercise] = useState<string | null>(null)
  const [expandedRoutines, setExpandedRoutines] = useState<Set<string>>(new Set())

  const { data, loading: coldLoading } = useCachedLoader(
    `program:${athleteId}`,
    () => fetchProgramView(athleteId),
  )
  const program  = data?.program ?? null
  const phase     = data?.phase ?? null
  const routines  = data?.routines ?? []
  const profile   = data?.profile ?? null
  const loading   = coldLoading

  const retestDays = profile?.retest_date
    ? Math.ceil((new Date(profile.retest_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null

  const phaseName = (phase?.name ?? profile?.current_phase ?? 'Stability') as PhaseName
  const currentIdx = Math.max(0, PHASES.indexOf(phaseName))
  const nextPhase = PHASES[currentIdx + 1] ?? null

  let weekCurrent = 1
  let weekTotal = 5
  if (phase?.week_start && phase?.week_end) {
    const dayMs = 1000 * 60 * 60 * 24
    const start = new Date(phase.week_start).getTime()
    weekTotal = Math.max(1, Math.round((new Date(phase.week_end).getTime() - start) / dayMs / 7) + 1)
    weekCurrent = Math.min(weekTotal, Math.max(1, Math.floor((Date.now() - start) / dayMs / 7) + 1))
  }

  const nonNegotiables = (phase?.non_negotiables as string[] | null) ?? []
  const advancement    = (phase?.advancement_criteria as string[] | null) ?? []

  return (
    <div className="screen with-nav">
      <div className="page page--rail">
       <div className="page__main">
        <p className="text-xs text-dim" style={{ letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
          The plan
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Program</h2>

        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Skeleton height={10} width={80} /><Skeleton height={28} width="100%" /><Skeleton height={22} width={140} />
          </div>
        ) : !program ? (
          <div className="card">
            <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
              No active program yet. Finish onboarding and your first session builds here.
            </p>
          </div>
        ) : (
          <>
            {/* THE "YOU ARE HERE" INSTRUMENT — the focal surface (bracket-framed) */}
            <BracketFrame className="card fade-rise" style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
                <SectionHeader>Current phase</SectionHeader>
                {retestDays !== null && (
                  <span className={`num text-xs${retestDays <= 7 ? ' text-signal' : ' text-dim'}`}>
                    {retestDays > 0 ? `${retestDays}d to retest` : 'Retest due'}
                  </span>
                )}
              </div>

              {/* The arc */}
              <PhaseArc currentIdx={currentIdx} />

              {/* Phase name + week position */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 22 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 600, color: 'var(--signal)', letterSpacing: '-0.01em' }}>
                  {phaseName}
                </span>
                <div style={{ textAlign: 'right' }}>
                  <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', marginBottom: 6 }}>
                    WEEK <span className="num text-signal">{weekCurrent}</span>/{weekTotal}
                  </p>
                  <WeekDots current={weekCurrent} total={weekTotal} />
                </div>
              </div>

              {program.goal && (
                <p className="text-sm text-dim" style={{ marginTop: 14, lineHeight: 1.5 }}>{program.goal}</p>
              )}
            </BracketFrame>

            {/* THE GATE — what graduates you (coach reads it; code disposes) */}
            {advancement.length > 0 && (
              <div className="fade-rise fade-rise-delay-1" style={{ marginBottom: 28 }}>
                <SectionHeader>The gate</SectionHeader>
                <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 12, lineHeight: 1.6 }}>
                  What graduates you{nextPhase ? ` to ${nextPhase}` : ''}. Awaiting evidence.
                </p>
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {advancement.map((c, i) => (
                    <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5 }}>
                      <span
                        title="Awaiting evidence"
                        style={{ marginTop: 5, flexShrink: 0, width: 7, height: 7, borderRadius: '50%', border: '1px solid var(--pending)', background: 'transparent' }}
                      />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* SESSIONS — the work in this phase */}
            <div className="fade-rise fade-rise-delay-2" style={{ marginBottom: 28 }}>
              <SectionHeader>Sessions</SectionHeader>
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {routines.length > 0 ? routines.map((r) => {
                  const exercises = r.exercises as ExerciseTemplate[]
                  const isExpanded = expandedRoutines.has(r.id)
                  return (
                    <div key={r.id} className="card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                        <h3 style={{ fontSize: 15, fontWeight: 600 }}>{r.name}</h3>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          style={{ padding: '0 4px', height: 24, fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}
                          onClick={() => setExpandedRoutines((prev) => {
                            const next = new Set(prev)
                            if (next.has(r.id)) next.delete(r.id)
                            else next.add(r.id)
                            return next
                          })}
                        >
                          <span className="num">{exercises.length} exercises</span>
                          {isExpanded
                            ? <ChevronUp size={12} strokeWidth={2} />
                            : <ChevronDown size={12} strokeWidth={2} />}
                        </button>
                      </div>
                      {r.intent && <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{r.intent}</p>}
                      {isExpanded && (
                        <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {exercises.map((ex, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <div>
                                <span style={{ fontSize: 13 }}>{ex.name}</span>
                                <span className="num text-xs text-dim" style={{ marginLeft: 8 }}>
                                  {ex.sets}×{ex.reps}{ex.load ? ` · ${ex.load}` : ''}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="exercise-info-btn"
                                aria-label={`View history for ${ex.name}`}
                                onClick={() => setHistoryExercise(ex.name)}
                              >
                                <History size={12} strokeWidth={2} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }) : (
                  <p className="text-sm text-dim">No sessions in this phase yet.</p>
                )}
              </div>
            </div>

          </>
        )}
       </div>

       {/* NON-NEGOTIABLES — the rules. Desktop rail; stacked under sessions on
           mobile with a separator. */}
       <aside className="page__rail">
        {!loading && program && nonNegotiables.length > 0 && (
          <div className="fade-rise fade-rise-delay-3 program-rules">
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
       </aside>
      </div>

      {historyExercise && (
        <ExerciseHistorySheet
          exerciseName={historyExercise}
          athleteId={athleteId}
          onClose={() => setHistoryExercise(null)}
        />
      )}
    </div>
  )
}

// ---- Phase arc — the journey, static. done=green, current=signal, pending=amber.
function PhaseArc({ currentIdx }: { currentIdx: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {PHASES.map((p, i) => {
        const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'pending'
        const last = i === PHASES.length - 1
        const dot =
          state === 'current'
            ? { width: 12, height: 12, background: 'var(--signal)', border: 'none', boxShadow: '0 0 0 4px var(--signal-dim)' }
            : state === 'done'
            ? { width: 10, height: 10, background: 'var(--confirmed)', border: 'none', boxShadow: 'none' }
            : { width: 10, height: 10, background: 'transparent', border: '1px solid var(--pending)', boxShadow: 'none' }
        const labelColor = state === 'current' ? 'var(--signal)' : state === 'done' ? 'var(--confirmed)' : 'var(--text-dim)'
        return (
          <Fragment key={p}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto' }}>
              <span style={{ borderRadius: '50%', ...dot }} />
              <span
                style={{
                  marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: labelColor, opacity: state === 'pending' ? 0.6 : 1, whiteSpace: 'nowrap',
                }}
              >
                {p}
              </span>
            </div>
            {!last && (
              <div
                style={{
                  flex: 1, height: 0, margin: '0 6px', marginBottom: 22,
                  borderTop: i < currentIdx ? '1px solid var(--confirmed)' : '1px dashed var(--line)',
                }}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

// ---- Week position within the phase — segmented, current week emphasised.
function WeekDots({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          style={{
            width: i === current - 1 ? 16 : 8,
            height: 4,
            borderRadius: 2,
            background: i < current ? 'var(--signal)' : 'var(--line)',
          }}
        />
      ))}
    </div>
  )
}
