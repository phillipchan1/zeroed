import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { History, Lock, Sparkles } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import {
  gatherProgramMap, gatherTrainingLog,
  type NextWeekProjection, type MapPhase,
} from '../../engine'
import { capIsActive, clearanceTestOf, describeClearanceTest } from '../../engine/prescription'
import { pendingSessionsRaw } from '../../lib/workoutOutbox'
import { unitContext } from '../../lib/units'
import {
  PageHeader, SectionHeader, Skeleton, Disclosure, Chip, Row, Button,
} from '../../components/ui'
import type { ProgramRow, PhaseRow, RoutineRow, AthleteProfileRow, InsightRow, PhaseName, WeeklyDirective } from '../../types/database'

// Directive → chip tone, matching the recap banner so "the call" reads the same
// everywhere it appears.
const DIRECTIVE_TONE: Record<WeeklyDirective, 'done' | 'todo' | 'pending'> = {
  PROGRESS:        'done',
  HOLD:            'todo',
  'HOLD (missed)': 'pending',
  DELOAD:          'pending',
  RECOVERY:        'pending',
}

/**
 * PROGRAM — "you are here." One instrument at the top (the phase arc, the week
 * position, the countdown to retest), then everything else folded into
 * disclosure rows.
 *
 * The previous version stacked seven full sections — gate, sessions, next week,
 * road ahead, recent, non-negotiables — each with its own explanatory paragraph,
 * for roughly six screens of scrolling on a phone. The detail hasn't been
 * removed; it's behind a row that tells you how much is in there.
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
  // The open exit condition on the limiter, if one is capping load. The gate
  // block is where the athlete comes to ask "what am I waiting on" — the load
  // cap belongs in that answer, not only inside a workout.
  clearance: { requirement: string; sessionsPassed: number; sessionsNeeded: number } | null
}

export async function fetchProgramView(athleteId: string): Promise<ProgramView> {
  const [programRes, profileRes, insightRes] = await Promise.all([
    supabase.from('program').select('*').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
    supabase.from('athlete_profile').select('*').eq('athlete_id', athleteId).maybeSingle(),
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
  ])
  if (programRes.error) throw programRes.error
  if (profileRes.error) throw profileRes.error
  const program = programRes.data as ProgramRow | null
  const profile = profileRes.data as AthleteProfileRow | null

  const p1 = ((insightRes.data ?? []) as InsightRow[])
    .filter((i) => i.status !== 'resolved' && i.status !== 'disproved')[0] ?? null
  const openTest = capIsActive(p1) ? clearanceTestOf(p1) : null
  const clearance = openTest
    ? {
        requirement: describeClearanceTest(openTest),
        sessionsPassed: openTest.sessions_passed,
        sessionsNeeded: openTest.criterion.sessions,
      }
    : null

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
  return { program, phase, routines, profile, clearance }
}

export function ProgramScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const { data, loading: coldLoading } = useCachedLoader(
    `program:${athleteId}`,
    () => fetchProgramView(athleteId),
  )
  const { data: map } = useCachedLoader(
    `programmap:${athleteId}`,
    () => gatherProgramMap(athleteId, unitContext()),
  )
  const { data: log } = useCachedLoader(
    `history:${athleteId}`,
    () => gatherTrainingLog(athleteId, pendingSessionsRaw()),
  )

  const nextWeek = map?.nextWeek ?? null
  const aheadPhases = (map?.phases ?? []).filter((p) => p.state === 'upcoming')
  const recentWeeks = (log?.weeks ?? []).slice(0, 3)
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
  const clearance      = data?.clearance ?? null

  return (
    <div className="screen with-nav">
      <div className="page">
       <div className="page__main">
        <PageHeader eyebrow="The plan" title="Program" />

        {loading ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Skeleton height={12} width={90} /><Skeleton height={34} width="100%" /><Skeleton height={24} width={150} />
          </div>
        ) : !program ? (
          <div className="card">
            <p className="text-base text-dim">
              No active program yet. Finish onboarding and your first session builds here.
            </p>
          </div>
        ) : (
          <>
            {/* THE INSTRUMENT — where you are, at a glance. The only thing on
                this screen that is always open. */}
            <div className="card fade-rise" style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 22 }}>
                <SectionHeader>Current phase</SectionHeader>
                {retestDays !== null && (
                  <span className={`num text-xs${retestDays <= 7 ? ' text-signal' : ' text-dim'}`}>
                    {retestDays > 0 ? `${retestDays}d to retest` : 'Retest due'}
                  </span>
                )}
              </div>

              <PhaseArc currentIdx={currentIdx} />

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 26 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--signal)', letterSpacing: '-0.01em' }}>
                  {phaseName}
                </span>
                <div style={{ textAlign: 'right' }}>
                  <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', marginBottom: 8 }}>
                    WEEK <span className="num text-signal">{weekCurrent}</span>/{weekTotal}
                  </p>
                  <WeekDots current={weekCurrent} total={weekTotal} />
                </div>
              </div>

              {program.goal && (
                <p className="text-sm text-dim" style={{ marginTop: 16, lineHeight: 1.55 }}>{program.goal}</p>
              )}
            </div>

            {/* The steering wheel. This used to be a textarea at the bottom of
                the Sessions accordion — three taps deep, one shot, no way to
                answer back. It is the second thing on the screen now. */}
            <button type="button" className="program-edit-cta" onClick={() => navigate('/app/program/edit')}>
              <span className="program-edit-cta__icon"><Sparkles size={18} strokeWidth={1.75} /></span>
              <span style={{ minWidth: 0 }}>
                <span className="program-edit-cta__title">Change the program</span>
                <span className="program-edit-cta__sub">
                  Add explosiveness, conditioning, size, or just more work — in conversation,
                  with the whole week in front of you.
                </span>
              </span>
              <span className="program-edit-cta__chev">›</span>
            </button>

            {/* The other half of steering: what you've already changed, and what
                your lifts did about it. A program you can change but not look
                back on is one you have to hold in your head. */}
            <button type="button" className="program-edit-cta program-edit-cta--quiet" onClick={() => navigate('/app/program/journey')}>
              <span className="program-edit-cta__icon"><History size={18} strokeWidth={1.75} /></span>
              <span style={{ minWidth: 0 }}>
                <span className="program-edit-cta__title">Your training so far</span>
                <span className="program-edit-cta__sub">
                  Every block you've run, every change you've made, and where each lift has actually gone.
                </span>
              </span>
              <span className="program-edit-cta__chev">›</span>
            </button>

            {/* Everything else folds away. Each row states its own size so you
                know what's behind it before you open it. */}

            {nextWeek && (
              <Disclosure
                label="Next week"
                meta={
                  nextWeek.directive
                    ? <Chip tone={DIRECTIVE_TONE[nextWeek.directive] ?? 'todo'}>{nextWeek.directive}</Chip>
                    : <span>Not set</span>
                }
              >
                <NextWeekBody nextWeek={nextWeek} />
              </Disclosure>
            )}

            <Disclosure label="Sessions" meta={<span className="num">{routines.length}</span>}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {routines.length > 0 ? routines.map((r) => (
                  <div key={r.id} className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <h3 style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{r.name}</h3>
                      <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>
                        {r.exercises.length} ex
                      </span>
                    </div>
                    {r.intent && <p className="text-sm text-dim" style={{ marginTop: 6, lineHeight: 1.5 }}>{r.intent}</p>}
                  </div>
                )) : (
                  <p className="text-sm text-dim">No sessions in this phase yet.</p>
                )}
              </div>
            </Disclosure>

            {(advancement.length > 0 || clearance) && (
              <Disclosure
                label={nextPhase ? `What graduates you to ${nextPhase}` : 'What graduates you'}
                meta={<span className="num">{advancement.length + (clearance ? 1 : 0)}</span>}
              >
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {advancement.map((c, i) => (
                    <li key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span
                        title="Awaiting evidence"
                        style={{ marginTop: 7, flexShrink: 0, width: 9, height: 9, borderRadius: '50%', border: '1.5px solid var(--pending)' }}
                      />
                      <span className="text-base" style={{ lineHeight: 1.5 }}>{c}</span>
                    </li>
                  ))}
                  {/* The load cap's own exit condition. It belongs here because
                      it is the gate the athlete feels every session, and it is
                      the only one with a number they can move this week. */}
                  {clearance && (
                    <li style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span
                        title="Clearance test"
                        style={{ marginTop: 7, flexShrink: 0, width: 9, height: 9, borderRadius: '50%', border: '1.5px solid var(--signal)' }}
                      />
                      <span style={{ flex: 1 }}>
                        <span className="text-base" style={{ lineHeight: 1.5, display: 'block' }}>
                          Lifts the load cap: {clearance.requirement}
                        </span>
                        <span className="num text-sm text-dim" style={{ display: 'block', marginTop: 4 }}>
                          {clearance.sessionsPassed}/{clearance.sessionsNeeded} banked
                        </span>
                      </span>
                    </li>
                  )}
                </ul>
              </Disclosure>
            )}

            {nonNegotiables.length > 0 && (
              <Disclosure label="Non-negotiables" meta={<span className="num">{nonNegotiables.length}</span>}>
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {nonNegotiables.map((rule, i) => (
                    <li key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span className="num text-signal" style={{ fontSize: 'var(--fs-sm)', flexShrink: 0, fontWeight: 700, lineHeight: 1.55 }}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="text-base" style={{ lineHeight: 1.5 }}>{rule}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}

            {aheadPhases.length > 0 && (
              <Disclosure label="The road ahead" meta={<span className="num">{aheadPhases.length}</span>}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {aheadPhases.map((p) => <RoadAheadCard key={p.name} phase={p} />)}
                </div>
              </Disclosure>
            )}

            {recentWeeks.length > 0 && (
              <Disclosure label="Recent weeks" meta={<span className="num">{recentWeeks.length}</span>}>
                {recentWeeks.map((wk) => (
                  <Row
                    key={wk.weekEnding}
                    title={fmtWeekRange(wk.weekStart, wk.weekEnding)}
                    value={`${wk.sessions.length} · ${wk.totalSets} sets`}
                    onClick={() => navigate('/app/history')}
                  />
                ))}
                <Button variant="ghost" full style={{ marginTop: 12 }} onClick={() => navigate('/app/history')}>
                  View full history →
                </Button>
              </Disclosure>
            )}
          </>
        )}
       </div>
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
            ? { width: 14, height: 14, background: 'var(--signal)', border: 'none', boxShadow: '0 0 0 5px var(--signal-dim)' }
            : state === 'done'
            ? { width: 11, height: 11, background: 'var(--confirmed)', border: 'none', boxShadow: 'none' }
            : { width: 11, height: 11, background: 'transparent', border: '1.5px solid var(--pending)', boxShadow: 'none' }
        const labelColor = state === 'current' ? 'var(--signal)' : state === 'done' ? 'var(--confirmed)' : 'var(--text-dim)'
        return (
          <Fragment key={p}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto' }}>
              <span style={{ borderRadius: '50%', ...dot }} />
              <span
                style={{
                  marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', letterSpacing: '0.04em',
                  textTransform: 'uppercase', color: labelColor, opacity: state === 'pending' ? 0.7 : 1, whiteSpace: 'nowrap',
                }}
              >
                {p}
              </span>
            </div>
            {!last && (
              <div
                style={{
                  flex: 1, height: 0, margin: '0 6px', marginBottom: 24,
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
function NextWeekBody({ nextWeek }: { nextWeek: NextWeekProjection }) {
  const sessionsWithLines = nextWeek.sessions.filter((s) => s.lines.length > 0)
  if (!nextWeek.directive) {
    return (
      <p className="text-base text-dim">
        No call yet — train this week and the projection sharpens.
      </p>
    )
  }
  return (
    <>
      {nextWeek.rationale && (
        <p className="text-base" style={{ marginBottom: 14, lineHeight: 1.55 }}>{nextWeek.rationale}</p>
      )}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {nextWeek.loadDeltaPct !== 0 && (
          <Chip tone={nextWeek.loadDeltaPct > 0 ? 'done' : 'pending'}>
            {nextWeek.loadDeltaPct > 0 ? '+' : ''}{nextWeek.loadDeltaPct}% load
          </Chip>
        )}
        {nextWeek.rpeTarget != null && <Chip tone="todo">Target RPE {nextWeek.rpeTarget}</Chip>}
        {nextWeek.provisional && <Chip tone="pending">Provisional</Chip>}
      </div>

      {sessionsWithLines.length > 0 ? (
        sessionsWithLines.map((s) => (
          <div key={s.routineId} className="card" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{s.routineName}</h3>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {s.lines.map((l, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span className="text-sm">{l.name}</span>
                  <span className="num text-sm" style={{ color: l.held ? 'var(--pending)' : 'var(--text-dim)', textAlign: 'right' }}>{l.hint}</span>
                </div>
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="text-sm text-dim">
          Per-lift targets appear once you've logged a session this phase.
        </p>
      )}
    </>
  )
}

// ---- A future phase — concept only (its sessions build on advancement). Locked.
function RoadAheadCard({ phase }: { phase: MapPhase }) {
  return (
    <div className="card" style={{ opacity: 0.85 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Lock size={16} strokeWidth={1.75} color="var(--text-dim)" />
        <h3 style={{ fontSize: 'var(--fs-base)', fontWeight: 700 }}>{phase.name}</h3>
      </div>
      {phase.goal && (
        <p className="text-sm text-dim" style={{ marginTop: 8, lineHeight: 1.5 }}>{phase.goal}</p>
      )}
      {phase.gate.length > 0 && (
        <p className="text-xs text-dim" style={{ marginTop: 10, fontFamily: 'var(--font-mono)', lineHeight: 1.5 }}>
          UNLOCKS · {phase.gate[0]}
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
            width: i === current - 1 ? 18 : 9,
            height: 5,
            borderRadius: 3,
            background: i < current ? 'var(--signal)' : 'var(--line)',
          }}
        />
      ))}
    </div>
  )
}
