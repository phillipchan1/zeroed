import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { History, Lock, Sparkles } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { invalidateCache, useCachedLoader } from '../../lib/cache'
import { PullToRefresh } from '../../components/PullToRefresh'
import { cacheKeys, invalidateLoopViews } from '../../lib/loopCache'
import {
  gatherProgramMap, gatherTrainingLog,
  gatherBlockVolume, activeBlockRetestDate,
  type NextWeekProjection, type MapPhase, type BlockVolume, type BlockVolumeWeek,
} from '../../engine'
import { capIsActive, clearanceTestOf, describeClearanceTest } from '../../engine/prescription'
import { pendingSessionsRaw } from '../../lib/workoutOutbox'
import { unitContext } from '../../lib/units'
import { toneFor } from '../../lib/directive'
import {
  PageHeader, SectionHeader, Skeleton, Disclosure, Chip, Row, Button,
} from '../../components/ui'
import type { ProgramRow, PhaseRow, RoutineRow, AthleteProfileRow, InsightRow, PhaseName, WeeklyDirective } from '../../types/database'
import { tracksOn } from '../../lib/tracksFlag'
import { useProgramTracks } from '../../lib/tracksData'
import { CoverageGrid, TrackLabel } from './tracksUi'
import { daysHitByTrack } from '../../engine/tracks'
import { weekWindowInZone } from '../../engine/weekDates'
import { fetchWeekOverrides, overridesByRoutine, weekdayOf, WEEK_ONLY_LABEL } from '../../lib/sessionOverrides'
import { fetchChanges } from '../../lib/changeLog'
import { ChangesFeed } from './ChangesFeed'

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

/**
 * LOAD MOVED, WEEK BY WEEK — the app explaining itself.
 *
 * The volume line and the PROGRESS / HOLD / DELOAD calls are the same story told
 * twice, and until volume existed there was no way to see whether the calls were
 * working. One series (load), so no legend: the heading names it. The directive
 * is a separate, RESERVED status colour and never carries meaning on its own —
 * every dot ships with its word underneath.
 */
function BlockVolumeChart({ data, u }: { data: BlockVolume; u: ReturnType<typeof unitContext> }) {
  // Tap a bar to read it. On a phone this beats a hover tooltip: the finger is
  // over the thing it is asking about, so the answer goes above the chart.
  const [selected, setSelected] = useState<number | null>(null)
  const weeks = data.weeks
  if (weeks.length === 0 || data.best <= 0) return null

  const shown = selected != null ? weeks[selected] : weeks[weeks.length - 1]
  const label = (w: BlockVolumeWeek) =>
    new Date(`${w.weekStart}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className="card fade-rise" style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <SectionHeader>Load moved</SectionHeader>
        <span className="num text-xs text-dim">{data.phaseName} block</span>
      </div>

      {/* The readout. Selective direct labelling — one number, for the week in
          question, rather than a figure over every bar. */}
      <div style={{ marginTop: 12, marginBottom: 16 }}>
        <p style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: '-0.02em', fontFamily: 'var(--font-mono)' }}>
          {u.volume(shown.load)}<span className="text-base text-dim" style={{ marginLeft: 4 }}>{u.unit}</span>
        </p>
        <p className="text-xs text-dim" style={{ marginTop: 4 }}>
          week of {label(shown)} · {shown.sessions} session{shown.sessions === 1 ? '' : 's'}
          {shown.directive ? ` · ${toneFor(shown.directive).gist.toLowerCase()}` : ''}
        </p>
      </div>

      <div
        className="vol-chart"
        role="img"
        aria-label={`Load moved per week this block: ${weeks.map((w) => `week of ${label(w)}, ${u.volume(w.load)} ${u.unit}`).join('; ')}`}
      >
        {weeks.map((w, i) => {
          const pct = data.best > 0 ? (w.load / data.best) * 100 : 0
          const isSel = (selected ?? weeks.length - 1) === i
          return (
            <button
              key={w.weekEnding}
              type="button"
              className={`vol-col${isSel ? ' vol-col--on' : ''}`}
              onClick={() => setSelected(i)}
              aria-label={`Week of ${label(w)}, ${u.volume(w.load)} ${u.unit}${w.directive ? `, ${w.directive}` : ''}`}
              aria-pressed={isSel}
            >
              <span className="vol-col__track">
                {/* A zero week draws as a visible floor rather than nothing, so a
                    missed week reads as "trained nothing" and not "no data". At
                    a 2px hairline it was indistinguishable from an empty track. */}
                {w.load > 0
                  ? <span className="vol-col__bar" style={{ height: `max(4px, ${pct}%)` }} />
                  : <span className="vol-col__bar vol-col__bar--zero" />}
              </span>
              <span className={`vol-col__tick${w.isCurrent ? ' vol-col__tick--now' : ''}`}>
                {new Date(`${w.weekStart}T12:00:00`).getDate()}
              </span>
              {/* Status: dot AND word. Colour never carries this alone. */}
              {w.directive ? (
                <span className="vol-col__dir">
                  <span className="vol-col__dot" style={{ background: toneFor(w.directive).color }} />
                  <span className="vol-col__dir-text">{toneFor(w.directive).short}</span>
                </span>
              ) : (
                <span className="vol-col__dir" aria-hidden="true">&nbsp;</span>
              )}
            </button>
          )
        })}
      </div>

      <p className="text-xs text-dim" style={{ marginTop: 12, lineHeight: 1.5 }}>
        Weight × reps, summed. Tap a week. The mark under each bar is the call the
        coach made that week.
      </p>
    </div>
  )
}

export function ProgramScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const { data, loading: coldLoading, refetch: refetchProgram } = useCachedLoader(
    `program:${athleteId}`,
    () => fetchProgramView(athleteId),
  )
  const { data: map, refetch: refetchMap } = useCachedLoader(
    `programmap:${athleteId}`,
    () => gatherProgramMap(athleteId, unitContext()),
  )
  const { data: log, refetch: refetchLog } = useCachedLoader(
    `history:${athleteId}`,
    () => gatherTrainingLog(athleteId, pendingSessionsRaw()),
  )
  const { data: blockVolume, refetch: refetchVolume } = useCachedLoader(
    `blockvol:${athleteId}`,
    () => gatherBlockVolume(athleteId),
  )
  // tracks_v1: which sessions carry a week-only override this week.
  const week = weekWindowInZone(new Date())
  const { data: weekOverrides } = useCachedLoader(
    tracksOn() ? cacheKeys.overrides(athleteId, week.weekStart) : null,
    () => fetchWeekOverrides(week.weekStart, week.weekEnd),
  )
  const overridesBy = overridesByRoutine(weekOverrides)
  // tracks_v1: every recorded change, newest first, each with its Undo.
  const { data: changes, refetch: refetchChanges } = useCachedLoader(
    tracksOn() ? cacheKeys.changes(athleteId) : null,
    fetchChanges,
  )

  const nextWeek = map?.nextWeek ?? null
  const aheadPhases = (map?.phases ?? []).filter((p) => p.state === 'upcoming')
  const recentWeeks = (log?.weeks ?? []).slice(0, 3)
  const program  = data?.program ?? null
  const phase     = data?.phase ?? null
  const routines  = data?.routines ?? []
  const tracks = useProgramTracks(program?.id)
  const coverage = tracks.length
    ? daysHitByTrack(routines.map((r) => ({ intendedDow: r.intended_dow, exercises: r.exercises })), tracks)
    : {}
  const profile   = data?.profile ?? null
  const loading   = coldLoading

  const retestDate = activeBlockRetestDate({
    programRetest: program?.retest_date ?? profile?.retest_date,
    phaseStart: phase?.week_start,
    phaseEnd: phase?.week_end,
  })
  const retestDays = retestDate
    ? Math.ceil((new Date(`${retestDate}T12:00:00`).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
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

  function pullRefresh() {
    invalidateCache((k) => (
      k === cacheKeys.program(athleteId)
      || k === cacheKeys.programMap(athleteId)
      || k === cacheKeys.history(athleteId)
      || k.startsWith('blockvol:')
      || k.startsWith('rx:')
      || k.startsWith('overrides:')
      || k.startsWith('changes:')
    ))
    refetchProgram()
    refetchMap()
    refetchLog()
    refetchVolume()
    if (tracksOn()) refetchChanges()
  }

  // An undo can move the week, the plan and the feed: refresh all of it.
  function afterUndo() {
    invalidateLoopViews()
    pullRefresh()
  }

  return (
    <div className="screen with-nav">
      <PullToRefresh onRefresh={pullRefresh}>
      <div className="page">
       <div className="page__main">
        <PageHeader
          eyebrow="The plan"
          title="Program"
          onBack={tracksOn() ? () => navigate('/app/goals') : undefined}
        />

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
                <span className="readout" style={{ color: 'var(--signal)' }}>
                  {phaseName}
                </span>
                <div style={{ textAlign: 'right' }}>
                  <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', marginBottom: 8 }}>
                    WEEK <span className="num" style={{ color: 'var(--text)' }}>{weekCurrent}</span>/{weekTotal}
                  </p>
                  <WeekDots current={weekCurrent} total={weekTotal} />
                </div>
              </div>

              {program.goal && (
                <p className="text-sm text-dim" style={{ marginTop: 16, lineHeight: 1.55 }}>{program.goal}</p>
              )}
              {tracksOn() && (program.name || program.block_phase || program.deload_week_start) && (
                <p className="text-xs text-dim" style={{ marginTop: 12 }}>
                  {[program.name, program.block_phase, program.deload_week_start ? `deload ${program.deload_week_start}` : null, program.retest_start ? `retest ${program.retest_start}` : null].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>

            {tracksOn() && tracks.length > 0 && (
              <div className="card fade-rise" style={{ marginBottom: 28 }}>
                <SectionHeader>Coverage</SectionHeader>
                <div style={{ marginTop: 14 }}>
                  <CoverageGrid tracks={tracks} days={coverage} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
                  {tracks.filter((t) => t.name !== 'General' || tracks.length === 1).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="card--tap"
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'none', color: 'var(--text)', padding: '8px 0', borderBottom: '1px solid var(--line)' }}
                      onClick={() => navigate(`/app/program/track/${t.id}`)}
                    >
                      <TrackLabel track={t} />
                      <span className="program-edit-cta__chev">›</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="program-edit-cta program-edit-cta--quiet"
                  style={{ marginTop: 16 }}
                  onClick={() => navigate('/app/goals')}
                >
                  <span className="program-edit-cta__title">Goals</span>
                  <span className="program-edit-cta__chev">›</span>
                </button>
              </div>
            )}

            {blockVolume && <BlockVolumeChart data={blockVolume} u={unitContext()} />}

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

            {tracksOn() && changes && (
              <Disclosure label="Changes" meta={<span className="num">{changes.length}</span>}>
                <ChangesFeed changes={changes} onUndone={afterUndo} />
              </Disclosure>
            )}

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
                    {(overridesBy[r.id]?.length ?? 0) > 0 && (
                      <p style={{ marginTop: 8 }}>
                        <span className="week-only">
                          {WEEK_ONLY_LABEL}
                          <span className="week-only__note">
                            {' · '}{overridesBy[r.id].map((o) => o.moved_out_to ? `moved to ${weekdayOf(o.moved_out_to)}` : weekdayOf(o.date)).join(', ')}
                          </span>
                        </span>
                      </p>
                    )}
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
      </PullToRefresh>
    </div>
  )
}

// ---- Phase arc — the journey, static. done=green, current=signal, pending=amber.
function PhaseArc({ currentIdx }: { currentIdx: number }) {
  return (
    // Four phase names on a 320px screen at 150% text do not fit, and the arc is
    // a fixed-order instrument that must not reflow. So it scrolls in its own
    // container rather than pushing the page sideways.
    <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', paddingBottom: 2 }}>
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
        <Lock size={16} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />
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
            // Text tones, not signal: the phase name is the screen's one yellow.
            background: i === current - 1 ? 'var(--text)' : i < current ? 'var(--text-dim)' : 'var(--line)',
          }}
        />
      ))}
    </div>
  )
}
