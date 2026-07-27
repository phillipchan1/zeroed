import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Sparkles } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { invalidateLoopViews } from '../../lib/loopCache'
import { gatherProgramMap, gatherTrainingLog, redesignActivePhase, type NextWeekProjection, type MapPhase } from '../../engine'
import { pendingSessionsRaw } from '../../lib/workoutOutbox'
import { getWeightUnit } from '../../lib/units'
import { SectionHeader, Skeleton, BracketFrame } from '../../components/ui'
import type { ProgramRow, PhaseRow, RoutineRow, AthleteProfileRow, PhaseName, WeeklyDirective } from '../../types/database'

// Directive → colour, matching the recap banner so "the call" reads the same
// everywhere it appears.
const DIRECTIVE_COLOR: Record<WeeklyDirective, string> = {
  PROGRESS:        'var(--confirmed)',
  HOLD:            'var(--text-dim)',
  'HOLD (missed)': 'var(--pending)',
  DELOAD:          'var(--pending)',
  RECOVERY:        'var(--pending)',
}

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

function fmtWeekRange(startISO: string, endISO: string): string {
  const s = new Date(`${startISO}T12:00:00`)
  const e = new Date(`${endISO}T12:00:00`)
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return mon(s) === mon(e) ? `${mon(s)} ${s.getDate()}–${e.getDate()}` : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`
}

interface ProgramView {
  program: ProgramRow | null
  phase: PhaseRow | null
  routines: RoutineRow[]
  profile: AthleteProfileRow | null
}

export async function fetchProgramView(athleteId: string): Promise<ProgramView> {
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
  const navigate = useNavigate()
  const [redesigning, setRedesigning] = useState(false)
  const { data, loading: coldLoading, refetch: refetchProgram } = useCachedLoader(
    `program:${athleteId}`,
    () => fetchProgramView(athleteId),
  )
  const { data: map, refetch: refetchMap } = useCachedLoader(
    `programmap:${athleteId}`,
    () => gatherProgramMap(athleteId, getWeightUnit()),
  )
  const { data: log } = useCachedLoader(
    `history:${athleteId}`,
    () => gatherTrainingLog(athleteId, pendingSessionsRaw()),
  )

  async function handleRedesign() {
    if (redesigning) return
    setRedesigning(true)
    try {
      const ok = await redesignActivePhase(athleteId, getWeightUnit())
      // A redesigned phase replaces the sessions themselves, so every view that
      // names or schedules them is now wrong.
      if (ok) { invalidateLoopViews(); refetchProgram(); refetchMap() }
    } catch (e) {
      console.error('[redesign] failed', e)
    } finally {
      setRedesigning(false)
    }
  }
  const nextWeek = map?.nextWeek ?? null
  const aheadPhases = (map?.phases ?? []).filter((p) => p.state === 'upcoming')
  const recentWeeks = (log?.weeks ?? []).slice(0, 2)
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 24, gap: 12 }}>
          <h2 style={{ fontSize: 22, fontWeight: 600 }}>Program</h2>
          <button
            type="button"
            onClick={() => navigate('/app/history')}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-dim)' }}
          >
            ‹ History
          </button>
        </div>

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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                <SectionHeader>Sessions</SectionHeader>
                <button
                  type="button"
                  onClick={handleRedesign}
                  disabled={redesigning}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: 0,
                    cursor: redesigning ? 'default' : 'pointer', opacity: redesigning ? 0.6 : 1,
                    fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--signal)',
                  }}
                >
                  <Sparkles size={12} strokeWidth={1.5} />
                  {redesigning ? 'Rebuilding…' : 'Rebuild from my lifts'}
                </button>
              </div>
              <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 12, lineHeight: 1.6 }}>
                Coach-designed around the lifts you actually log — same names, so your loading carries forward.
              </p>
              <div style={{ marginTop: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
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

            {/* NEXT WEEK — the standing prescription read forward. Provisional:
                the real numbers lock when the week closes (check-in / Sunday). */}
            {nextWeek && <NextWeekCard nextWeek={nextWeek} />}

            {/* THE ROAD AHEAD — phases after this one. Concept only: their
                sessions don't exist until you graduate into them. */}
            {aheadPhases.length > 0 && (
              <div className="fade-rise fade-rise-delay-3" style={{ marginBottom: 28 }}>
                <SectionHeader>The road ahead</SectionHeader>
                <p className="text-xs text-dim" style={{ marginTop: 6, marginBottom: 12, lineHeight: 1.6 }}>
                  What's after {phaseName}. The shape is set; the exact sessions build when you graduate in.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {aheadPhases.map((p) => <RoadAheadCard key={p.name} phase={p} />)}
                </div>
              </div>
            )}

            {/* RECENT — a glance back; the full log lives in History. Completes
                the timeline: road ahead above, what you've banked below. */}
            {recentWeeks.length > 0 && (
              <div className="fade-rise fade-rise-delay-3" style={{ marginBottom: 28 }}>
                <SectionHeader>Recent</SectionHeader>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {recentWeeks.map((wk) => (
                    <button
                      key={wk.weekEnding}
                      type="button"
                      onClick={() => navigate('/app/history')}
                      className="card"
                      style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                        <span className="text-sm" style={{ fontWeight: 600 }}>{fmtWeekRange(wk.weekStart, wk.weekEnding)}</span>
                        <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
                          {wk.sessions.length} session{wk.sessions.length === 1 ? '' : 's'} · {wk.totalSets} sets
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/app/history')}
                  style={{ marginTop: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-dim)' }}
                >
                  View full history ›
                </button>
              </div>
            )}

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

// ---- Next-week projection — the call + per-session projected loads, provisional.
function NextWeekCard({ nextWeek }: { nextWeek: NextWeekProjection }) {
  const directive = nextWeek.directive
  const color = directive ? DIRECTIVE_COLOR[directive] ?? 'var(--text-dim)' : 'var(--text-dim)'
  // Only show per-session rows once they carry real projected loads — otherwise
  // they just duplicate the Sessions list above (e.g. a freshly-started phase
  // with no logged history yet).
  const sessionsWithLines = nextWeek.sessions.filter((s) => s.lines.length > 0)
  return (
    <div className="fade-rise fade-rise-delay-2" style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <SectionHeader>Next week</SectionHeader>
        {nextWeek.provisional && (
          <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pending)' }}>
            Projection
          </span>
        )}
      </div>

      {/* The call — directive read forward, or a nudge if there's no read yet. */}
      <div className="card" style={{ marginTop: 10, marginBottom: 10, borderColor: directive ? color : undefined }}>
        {directive ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, letterSpacing: '0.04em', color }}>
                {directive}
              </span>
              {nextWeek.loadDeltaPct !== 0 && (
                <span className="num text-xs" style={{ color }}>
                  {nextWeek.loadDeltaPct > 0 ? '+' : ''}{nextWeek.loadDeltaPct}% load
                </span>
              )}
            </div>
            {nextWeek.rationale && (
              <p className="text-sm" style={{ marginTop: 8, lineHeight: 1.5 }}>{nextWeek.rationale}</p>
            )}
            {nextWeek.rpeTarget != null && (
              <p className="num text-xs text-dim" style={{ marginTop: 8 }}>Target RPE {nextWeek.rpeTarget}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
            No call yet — train this week and the projection sharpens once the coach reads it.
          </p>
        )}
      </div>

      {/* Per-session projected loads — only when they carry real numbers. */}
      {sessionsWithLines.length > 0 ? (
        <>
          {sessionsWithLines.map((s) => (
            <div key={s.routineId} className="card" style={{ marginBottom: 8 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600 }}>{s.routineName}</h3>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {s.lines.map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                    <span className="text-xs" style={{ color: 'var(--text)' }}>{l.name}</span>
                    <span className="num text-xs" style={{ color: l.held ? 'var(--pending)' : 'var(--text-dim)', textAlign: 'right' }}>{l.hint}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {nextWeek.provisional && (
            <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
              Projection — locks in when you close the week.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>
          Per-lift targets appear once you've logged a session this phase — the projection reads off your last working sets.
        </p>
      )}
    </div>
  )
}

// ---- A future phase — concept only (its sessions build on advancement). Locked.
function RoadAheadCard({ phase }: { phase: MapPhase }) {
  return (
    <div className="card" style={{ opacity: 0.82 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lock size={13} strokeWidth={1.5} color="var(--text-dim)" />
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>{phase.name}</h3>
      </div>
      {phase.goal && (
        <p className="text-xs text-dim" style={{ marginTop: 6, lineHeight: 1.5 }}>{phase.goal}</p>
      )}
      {phase.gate.length > 0 && (
        <p className="text-xs text-dim" style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.04em', lineHeight: 1.5 }}>
          UNLOCKS WHEN · {phase.gate[0]}
        </p>
      )}
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
