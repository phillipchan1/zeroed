import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { SessionZeroed, type FinishedSession } from '../../components/SessionZeroed'
import { ConvergenceReticle } from '../../components/convergence/ConvergenceReticle'
import { supabase } from '../../lib/supabaseClient'
import { loadCache, mutateCache, useCachedLoader } from '../../lib/cache'
import {
  runLoopTriggers, isRetestDue, closeOutCurrentWeek, gatherWeekPager, gatherSessionPrescription,
  gatherSessionActuals, actualsFromPending,
  sessionStateForWeek, weekLoggedDays, activeBlockRetestDate,
  weekWindowInZone, upcomingWeekWindow, isoInWeek,
  type PagerWeekView, type WeekPagerData, type SessionActuals,
} from '../../engine'
import { effectiveTrackingType } from '../../engine/exerciseLibrary'
import { tallySession } from '../../engine/volume'
import { unitContext, type UnitContext } from '../../lib/units'
import { ChevronLeft, ChevronRight, Lock, Sparkles, Activity, CloudUpload, CloudAlert, Flag } from 'lucide-react'
import { loadDraftStarts } from '../../lib/workoutDraft'
import { seedWorkoutBootstrap, workoutBootKey, type WorkoutBootstrap } from '../../lib/workoutBoot'
import { cacheKeys, invalidateLoopViews } from '../../lib/loopCache'
import {
  pendingSessionsRaw, useOutboxStatus, retryBlocked, discardBlocked,
  pendingRef, parsePendingRef, pendingSessionById,
} from '../../lib/workoutOutbox'
import { setIntendedDay, orderByPlannedDay, DAY_LABELS as PLAN_DAYS } from '../../lib/weekPlan'
import { Button, SectionHeader, Skeleton, Ring, Chip, Sheet, Banner, LockOn } from '../../components/ui'
import type { RoutineRow, InsightRow, OnboardingStep, SetLog, TrackingType, ExerciseTemplate, WeeklyDirective } from '../../types/database'

const PAGER_DIRECTIVE_TONE: Record<WeeklyDirective, 'done' | 'todo' | 'pending'> = {
  PROGRESS: 'done',
  HOLD: 'todo',
  'HOLD (missed)': 'pending',
  DELOAD: 'pending',
  RECOVERY: 'pending',
}

interface TodayScreenProps {
  athleteId: string
  todayRoutine: RoutineRow | null
  routines: RoutineRow[]
  onboardingStep?: OnboardingStep
}

interface LoopContext {
  refresh: () => void
  athleteName: string | null
}

// Athletes whose lazy triggers have already run this page-session. Module-level
// (not a ref) so it survives the brief unmount/remount a refresh() causes —
// otherwise the trigger effect would re-fire on every remount and loop.
const triggeredThisSession = new Set<string>()

interface WeekDayStatus {
  date: Date
  logged: boolean
  isToday: boolean
}

const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function getWeekDays(): Date[] {
  const today = new Date()
  const dow   = today.getDay()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((dow + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

function daysFromWeekStart(weekStart: string): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T12:00:00`)
    d.setDate(d.getDate() + i)
    return d
  })
}

function asRoutineRow(r: {
  id: string
  name: string
  exercises: ExerciseTemplate[]
  intent: string | null
  intended_dow: number | null
  session_type?: string | null
}): RoutineRow {
  return {
    id: r.id,
    program_id: '',
    phase_id: null,
    name: r.name,
    session_type: r.session_type ?? null,
    exercises: r.exercises,
    intent: r.intent,
    intended_dow: r.intended_dow,
  }
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  )
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

// The cached Today view. Everything here is serializable (ISO strings, plain
// numbers) so it round-trips through localStorage; the date-derived week strip
// is recomputed at render from the workouts against "now".
interface WeekWorkout {
  id: string
  routineId: string
  performedAt: string
}
interface TodayView {
  weekWorkouts: WeekWorkout[]    // every workout logged this week (for status + strip)
  totalInsights: number
  likelyCount: number
  p1Count: number
  lastSignalAt: string | null
  goal: string | null
  p1: { category: string; confidence: number; claim: string } | null
  retestDate: string | null
  sessionsPerWeek: number | null
  latestReview: { id: string; weekEnding: string } | null
  lastDoneByRoutine: Record<string, string>   // routineId → most recent performed_at (any week)
}

export async function fetchTodayView(athleteId: string): Promise<TodayView> {
  const days = getWeekDays()
  const from = new Date(days[0])
  from.setDate(from.getDate() - 7)
  from.setHours(0, 0, 0, 0)
  const weekEnd = new Date(days[6].getFullYear(), days[6].getMonth(), days[6].getDate() + 7, 23, 59, 59)

  const [workoutRes, insightRes, athRes, profileRes, progRes] = await Promise.all([
    supabase
      .from('workout')
      .select('id, performed_at, routine_id, routine!inner(program!inner(athlete_id))')
      .gte('performed_at', from.toISOString())
      .lte('performed_at', weekEnd.toISOString()),
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
    supabase.from('athlete').select('goals, obstacle, sessions_per_week').eq('id', athleteId).maybeSingle(),
    supabase.from('athlete_profile').select('retest_date').eq('athlete_id', athleteId).maybeSingle(),
    supabase.from('program').select('id, retest_date').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle(),
  ])
  if (workoutRes.error) throw workoutRes.error
  if (insightRes.error) throw insightRes.error
  if (athRes.error) throw athRes.error
  if (profileRes.error) throw profileRes.error
  if (progRes.error) throw progRes.error

  const all = (insightRes.data ?? []) as InsightRow[]
  const active = all.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const top = active[0] ?? null
  const ath = athRes.data as { goals: string | null; obstacle: string | null; sessions_per_week: number | null } | null
  const prog = progRes.data as { id: string; retest_date: string | null } | null

  let blockRetest: string | null = null
  if (prog?.id) {
    const { data: phaseRow } = await supabase
      .from('phase').select('week_start, week_end').eq('program_id', prog.id).eq('status', 'active').maybeSingle()
    const ph = phaseRow as { week_start: string | null; week_end: string | null } | null
    blockRetest = activeBlockRetestDate({
      programRetest: prog.retest_date,
      phaseStart: ph?.week_start,
      phaseEnd: ph?.week_end,
    })
  }

  // Latest weekly review (recap prompt) + last-performed per routine (so a
  // session done in a prior week still shows its history, not a blank "to do").
  // Both scoped by the active program.
  let latestReview: { id: string; weekEnding: string } | null = null
  const lastDoneByRoutine: Record<string, string> = {}
  if (prog?.id) {
    const [{ data: rev }, { data: recent }] = await Promise.all([
      supabase
        .from('weekly_review').select('id, week_ending')
        .eq('program_id', prog.id)
        .order('week_ending', { ascending: false })
        .limit(1).maybeSingle(),
      supabase
        .from('workout').select('routine_id, performed_at, routine!inner(program_id)')
        .eq('routine.program_id', prog.id)
        .order('performed_at', { ascending: false })
        .limit(80),
    ])
    if (rev) latestReview = { id: rev.id as string, weekEnding: rev.week_ending as string }
    for (const w of (recent ?? []) as { routine_id: string; performed_at: string }[]) {
      if (!lastDoneByRoutine[w.routine_id]) lastDoneByRoutine[w.routine_id] = w.performed_at
    }
  }

  return {
    weekWorkouts: (workoutRes.data ?? []).map((w) => ({
      id: w.id as string,
      routineId: w.routine_id as string,
      performedAt: w.performed_at as string,
    })),
    totalInsights: all.length,
    likelyCount: all.filter((i) => i.status === 'likely').length,
    p1Count: active.filter((i) => i.priority === 'P1').length,
    lastSignalAt: all.reduce<string | null>((max, i) => (!max || i.updated_at > max ? i.updated_at : max), null),
    goal: (ath?.goals as string | null) || (ath?.obstacle as string | null) || null,
    p1: top ? { category: top.category, confidence: top.confidence, claim: top.claim } : null,
    retestDate: blockRetest ?? (profileRes.data?.retest_date as string | null) ?? null,
    sessionsPerWeek: (ath?.sessions_per_week as number | null) ?? null,
    latestReview,
    lastDoneByRoutine,
  }
}

// Recap prompts are dismissed locally (no "seen" column needed).
const RECAP_SEEN_KEY = 'zeroed:recap-seen'
function recapSeen(id: string): boolean {
  try { return (JSON.parse(localStorage.getItem(RECAP_SEEN_KEY) || '[]') as string[]).includes(id) }
  catch { return false }
}
function markRecapSeen(id: string): void {
  try {
    const seen = JSON.parse(localStorage.getItem(RECAP_SEEN_KEY) || '[]') as string[]
    if (!seen.includes(id)) localStorage.setItem(RECAP_SEEN_KEY, JSON.stringify([...seen.slice(-20), id]))
  } catch { /* non-fatal */ }
}

// Athlete swiped back to "This week" after we auto-opened next week's preview.
function weekPreviewDismissed(weekEnding: string): boolean {
  try { return localStorage.getItem(`zeroed:week-preview-dismiss:${weekEnding}`) === '1' }
  catch { return false }
}
function dismissWeekPreview(weekEnding: string): void {
  try { localStorage.setItem(`zeroed:week-preview-dismiss:${weekEnding}`, '1') }
  catch { /* non-fatal */ }
}

// ---- one session row in the week list -------------------------------------

type SessionState =
  | { kind: 'todo' }
  | { kind: 'in_progress' }
  | { kind: 'done'; lastWorkout: WeekWorkout; count: number }

const STATE_CHIP: Record<SessionState['kind'], { tone: 'todo' | 'doing' | 'done'; label: string }> = {
  todo:        { tone: 'todo',  label: 'To do' },
  in_progress: { tone: 'doing', label: 'In progress' },
  done:        { tone: 'done',  label: 'Done' },
}

// ---- what a finished session actually was ----------------------------------

const isSetLogged = (s: SetLog) => s.done || s.reps != null || s.duration != null || s.distance != null

// One performed set, in the shape its tracking type is read in.
function fmtSet(t: TrackingType, s: SetLog, u: UnitContext): string {
  if (t === 'time')     return s.duration != null ? `${s.duration}s` : '—'
  if (t === 'distance') return s.distance != null ? `${s.distance}${u.distance}` : '—'
  if (t === 'bodyweight_reps') return `${s.reps ?? '?'}${s.weight ? `+${u.fmt(s.weight)}${u.unit}` : ''}`
  return `${s.weight != null ? `${u.fmt(s.weight)}${u.unit}` : 'BW'}×${s.reps ?? '?'}`
}

// What was prescribed, as one string: "3×8 · moderate".
function fmtPrescribed(ex: ExerciseTemplate): string {
  return `${ex.sets}×${ex.reps}${ex.load ? ` · ${ex.load}` : ''}`
}

const CMP_LABEL: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)',
  letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)',
}

/**
 * One exercise, prescribed against performed. The whole point of opening a
 * finished session: what was asked for, what actually happened, and where the two
 * parted company — which sets went missing, which load was different.
 */
function PerformedRow({
  ex, logs, u,
}: {
  ex: ExerciseTemplate
  logs: SetLog[]
  u: UnitContext
}) {
  const t = effectiveTrackingType(ex)
  const done = logs.filter(isSetLogged)
  const rpes = done.map((s) => s.rpe).filter((r): r is number => r != null)
  const avgRpe = rpes.length ? Math.round(rpes.reduce((a, b) => a + b, 0) / rpes.length) : null
  const short = done.length < ex.sets
  const tone = done.length === 0 ? 'var(--text-dim)' : short ? 'var(--pending)' : 'var(--confirmed)'

  return (
    <div style={{ padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span className="text-base" style={{ fontWeight: 500, minWidth: 0 }}>
          {ex.name}
          {ex.swapped_from && (
            <span className="text-xs text-dim" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>
              Swapped in for {ex.swapped_from}
            </span>
          )}
        </span>
        <span className="num text-xs" style={{ whiteSpace: 'nowrap', color: tone }}>
          {done.length}/{ex.sets} sets
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 12px', marginTop: 10 }}>
        <span style={CMP_LABEL}>Planned</span>
        <span className="num text-sm text-dim">{fmtPrescribed(ex)}</span>
        <span style={CMP_LABEL}>Logged</span>
        <span className="num text-sm" style={{ color: done.length ? 'var(--text)' : 'var(--text-dim)' }}>
          {done.length
            ? done.map((s) => fmtSet(t, s, u)).join(', ')
                + (avgRpe != null ? ` · RPE ${avgRpe}` : '')
            : 'Not logged'}
        </span>
      </div>
    </div>
  )
}

/**
 * The session detail sub-screen. Everything that used to crowd the card — the
 * intent, the exercise list, the day-pinning, the secondary actions — lives
 * here, one tap away, so the week list stays scannable.
 */
function SessionSheet({
  routine, state, targets, actuals, u, plannedDow, onPlanDay, onClose, onStart, onEdit, onLogAgain,
}: {
  routine: RoutineRow
  state: SessionState
  // Per-exercise recommended working load (athlete's unit), from the same
  // prescription the workout screen shows. Null/missing → no history yet.
  targets: Record<number, number | null> | null
  // The session as performed, once it's done. Null until it loads (or if the
  // log can't be reached) — the sheet falls back to the plan.
  actuals: SessionActuals | null
  u: UnitContext
  plannedDow: number | null
  onPlanDay: (dow: number | null) => void
  onClose: () => void
  onStart: () => void
  onEdit: () => void
  onLogAgain: () => void
}) {
  const exercises = routine.exercises
  const chip = STATE_CHIP[state.kind]
  // A finished session is read for what happened, not what was asked for.
  const showPerformed = state.kind === 'done' && !!actuals
  const performedVolume = tallySession(actuals?.setLogs)
  const loggedSets = actuals
    ? Object.values(actuals.setLogs).flat().filter(isSetLogged).length
    : 0
  const plannedSets = exercises.reduce((n, ex) => n + ex.sets, 0)

  const actions =
    state.kind === 'done' ? (
      <>
        <Button variant="primary" full onClick={onEdit}>Review / edit →</Button>
        <Button variant="ghost" full style={{ marginTop: 6 }} onClick={onLogAgain}>Log it again</Button>
      </>
    ) : (
      <Button variant="primary" full onClick={onStart}>
        {state.kind === 'in_progress' ? 'Resume session →' : 'Start session →'}
      </Button>
    )

  return (
    <Sheet title={routine.name} onClose={onClose} actions={actions}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="text-xs text-dim num">
          {showPerformed
            ? [
                `${loggedSets} of ${plannedSets} sets`,
                // What you moved, not only how many times you stopped.
                performedVolume.load > 0 ? `${u.volume(performedVolume.load)}${u.unit}` : null,
                actuals!.rpe != null ? `RPE ${actuals!.rpe}` : null,
                actuals!.durationMins ? `${actuals!.durationMins} min` : null,
              ].filter(Boolean).join(' · ')
            : `${exercises.length} exercises`}
        </span>
      </div>

      {/* The intent is the pitch for work not yet done; a finished session is
          past being sold on. */}
      {routine.intent && !showPerformed && (
        <p className="text-sm text-dim" style={{ marginBottom: 20, lineHeight: 1.55 }}>{routine.intent}</p>
      )}

      <SectionHeader>{showPerformed ? 'What you logged' : 'The work'}</SectionHeader>
      <div style={{ marginTop: 10, marginBottom: 24 }}>
        {showPerformed
          // What you logged is read against the prescription you logged it
          // against — not the routine's current shape, which the program editor
          // may have reshaped since. Falls back to the routine for sessions
          // logged before snapshots existed.
          ? (actuals!.exercisesSnapshot ?? exercises).map((ex, i) => (
              <PerformedRow
                key={i}
                ex={ex}
                logs={actuals!.setLogs[i] ?? []}
                u={u}
              />
            ))
          : exercises.map((ex, i) => {
            // The concrete recommended weight beats the vague label ("50lb" over
            // "moderate") — it's the number you prep the bar with. The label is
            // the fallback for lifts with no logged history yet.
            const target = targets?.[i]
            return (
              <div
                key={i}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  gap: 14, padding: '12px 0', borderBottom: '1px solid var(--line)',
                }}
              >
                <span className="text-base" style={{ fontWeight: 500, minWidth: 0 }}>
          {ex.name}
          {ex.swapped_from && (
            <span className="text-xs text-dim" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>
              Swapped in for {ex.swapped_from}
            </span>
          )}
        </span>
                <span className="num text-sm text-dim" style={{ whiteSpace: 'nowrap' }}>
                  {ex.sets}×{ex.reps}
                  {target != null ? ` · ${target}${u.unit}` : ex.load ? ` · ${ex.load}` : ''}
                </span>
              </div>
            )
          })}
      </div>

      {/* Day-pinning — a suggestion, never enforced. */}
      <SectionHeader>Plan for a day</SectionHeader>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {PLAN_DAYS.map((label, dow) => {
          const active = plannedDow === dow
          return (
            <button
              key={dow}
              type="button"
              onClick={() => onPlanDay(active ? null : dow)}
              className="num"
              style={{
                flex: 1, minWidth: 0, height: 46, borderRadius: 10, cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)',
                border: `1px solid ${active ? 'var(--signal)' : 'var(--line)'}`,
                background: active ? 'var(--signal-dim)' : 'transparent',
                color: active ? 'var(--signal)' : 'var(--text-dim)',
              }}
            >
              {label}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}

/**
 * One session in the week list. Deliberately thin: name, state, one metadata
 * line. No intent paragraph, no stacked buttons — the whole card is the tap
 * target for the detail sheet, and only the next-up session carries a CTA.
 */
function SessionCard({
  routine, recommended, state, lastDone, plannedDow, onOpen, onStart,
}: {
  routine: RoutineRow
  recommended: boolean
  state: SessionState
  lastDone: string | null
  plannedDow: number | null
  onOpen: () => void
  onStart: () => void
}) {
  const exCount = routine.exercises.length
  const chip = STATE_CHIP[state.kind]
  const showCta = recommended && state.kind !== 'done'

  // One line of metadata, in priority order — never more.
  const meta =
    state.kind === 'done'
      ? `Logged ${shortDay(state.lastWorkout.performedAt)}${state.count > 1 ? ` · ×${state.count}` : ''}`
      : plannedDow != null
        ? `${exCount} exercises · planned ${PLAN_DAYS[plannedDow]}`
        : lastDone
          ? `${exCount} exercises · last ${shortDate(lastDone)}`
          : `${exCount} exercises`

  return (
    <div
      className="card card--tap fade-rise"
      style={{
        marginBottom: 10,
        borderColor: state.kind === 'in_progress' ? 'var(--signal)' : undefined,
      }}
      onClick={onOpen}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, lineHeight: 1.3 }}>{routine.name}</h3>
          <p className="meta" style={{ marginTop: 4 }}>{meta}</p>
        </div>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </div>

      {showCta && (
        <div style={{ marginTop: 16 }} onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" full onClick={onStart}>
            {state.kind === 'in_progress' ? 'Resume →' : 'Start session →'}
          </Button>
        </div>
      )}
    </div>
  )
}

const fmtWeekRange = (startISO: string, endISO: string) => {
  const s = new Date(`${startISO}T12:00:00`), e = new Date(`${endISO}T12:00:00`)
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return mon(s) === mon(e) ? `${mon(s)} ${s.getDate()}–${e.getDate()}` : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`
}

// A non-current week in the pager: past (real, logged) or future (projected).
// Read-only; past sessions tap through to the log.
function PagerWeekBody({ week, mode, onTapSession }: {
  week: PagerWeekView
  mode: 'past' | 'future'
  onTapSession?: (routineId: string) => void
}) {
  if (week.sessions.length === 0) {
    return (
      <div className="card">
        <p className="text-sm text-dim">
          {mode === 'past' ? 'Nothing logged this week.' : 'Projections appear once you log a session this phase.'}
        </p>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {mode === 'future' && week.directive && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Chip tone={PAGER_DIRECTIVE_TONE[week.directive] ?? 'todo'}>{week.directive}</Chip>
            {week.provisional && <Chip tone="pending">Provisional</Chip>}
          </div>
          {week.rationale && (
            <p className="text-sm text-dim" style={{ marginTop: 10, lineHeight: 1.5 }}>{week.rationale}</p>
          )}
        </div>
      )}
      {week.sessions.map((s, i) => (
        <div
          key={`${s.routineId}-${i}`}
          className={`card${mode === 'past' && onTapSession ? ' card--tap' : ''}`}
          style={{ opacity: mode === 'future' ? 0.9 : 1 }}
          onClick={mode === 'past' && onTapSession ? () => onTapSession(s.routineId) : undefined}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700 }}>{s.routineName}</h3>
            {s.tag
              ? <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>{s.tag}</span>
              : <Chip tone="pending">Projected</Chip>}
          </div>
          {s.lines.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {s.lines.map((l, j) => (
                <div key={j} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span className="text-sm">{l.name}</span>
                  <span className="num text-sm text-dim">{l.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// The far edge of the pager: the next phase, concept only (its sessions don't
// exist until you graduate in).
function PagerBoundary({ boundary }: { boundary: NonNullable<WeekPagerData['boundary']> }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Lock size={16} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />
        <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700 }}>{boundary.phaseName}</h3>
      </div>
      {boundary.goal && <p className="text-sm text-dim" style={{ marginTop: 10 }}>{boundary.goal}</p>}
      {boundary.gate.length > 0 && (
        <>
          <p className="section-header" style={{ marginTop: 18, marginBottom: 6 }}>Unlocks when</p>
          <p className="text-sm">{boundary.gate[0]}</p>
        </>
      )}
    </div>
  )
}

// "I'm done with the week" — the end-of-week close-out. Crunches the week now
// (instead of waiting for the Mon rollover), sets next week's call, and writes
// the coach's note. The injury path forces a recovery back-off.
function CloseWeekSheet({
  doneCount, planned, closing, onClose, onConfirm, onInjury,
}: {
  doneCount: number
  planned: number
  closing: boolean
  onClose: () => void
  onConfirm: () => void
  onInjury: () => void
}) {
  return (
    <Sheet
      title="Close out the week"
      subtitle="The coach reads the week, sets next week's load, and leaves a note. You can still log more after."
      // Once the crunch is running, closing would strand a write in flight —
      // the × is dropped along with backdrop dismissal, not just the latter.
      onClose={onClose}
      dismissOnBackdrop={!closing}
      hideClose={closing}
      actions={
        <>
          <Button variant="primary" full disabled={closing} onClick={onConfirm}>
            {closing ? 'Crunching…' : 'Crunch my week →'}
          </Button>
          <Button variant="ghost" full disabled={closing} style={{ marginTop: 6 }} onClick={onInjury}>
            Injured / taking time off
          </Button>
        </>
      }
    >
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Ring value={planned ? doneCount / planned : 0} size={64} label={`${doneCount} of ${planned} sessions logged`}>
          <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 700 }}>{doneCount}</span>
          <span className="text-micro text-dim" style={{ marginTop: 1 }}>/{planned}</span>
        </Ring>
        <div style={{ minWidth: 0 }}>
          <p className="text-lg" style={{ fontWeight: 700 }}>
            {doneCount === planned ? 'Full week' : `${doneCount} of ${planned} logged`}
          </p>
          <p className="text-xs text-dim" style={{ marginTop: 2 }}>Sessions this week</p>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * The sessions the server refused. They're finished work that still counts on the
 * week, so the sheet's job is to be honest about the state and offer the only two
 * moves that exist: try again (after a fix has shipped, or a server hiccup has
 * passed) or discard. Discarding is destructive — the set logs live nowhere else
 * — so it's a second tap behind an explicit confirm.
 */
function StuckSessionsSheet({
  count,
  reasons,
  retrying,
  onRetry,
  onDiscard,
  onClose,
}: {
  count: number
  reasons: string[]
  retrying: boolean
  onRetry: () => void
  onDiscard: () => void
  onClose: () => void
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // A known signature gets a known fix. 42501 on `workout` is the database
  // missing the allow_session_edit migration (editing a logged session UPDATEs
  // a table that was append-only until 20260727000002) — these sessions sync
  // as-is the moment it's applied, so say that instead of leaving a bare code.
  const missingEditMigration = reasons.some((r) => /42501/.test(r) && /workout/i.test(r))
  return (
    <Sheet
      title={`${count} session${count === 1 ? '' : 's'} couldn't sync`}
      subtitle="They're saved on this device and still counted in your week — the server rejected the upload."
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" full disabled={retrying} onClick={onRetry}>
            {retrying ? 'Trying…' : 'Try again'}
          </Button>
          <Button
            variant="ghost"
            full
            disabled={retrying}
            style={{ marginTop: 6 }}
            onClick={() => (confirmDiscard ? onDiscard() : setConfirmDiscard(true))}
          >
            {confirmDiscard ? 'Tap again to delete for good' : 'Discard them'}
          </Button>
        </>
      }
    >
      <div className="card">
        <p className="text-xs text-dim" style={{ marginBottom: reasons.length ? 10 : 0 }}>
          Nothing is lost by waiting. If this keeps happening, the reason below is
          what the server said.
        </p>
        {reasons.map((r, i) => (
          <p key={i} className="text-micro text-dim num" style={{ wordBreak: 'break-word', marginTop: i ? 6 : 0 }}>
            {r}
          </p>
        ))}
        {missingEditMigration && (
          <p className="text-xs" style={{ marginTop: 12, lineHeight: 1.5 }}>
            Permission denied on <span className="num">workout</span> means the database
            hasn&apos;t been given the session-edit migration yet. Apply the committed
            migrations (<span className="num">supabase db push</span>), then tap Try
            again — these sessions upload exactly as logged.
          </p>
        )}
      </div>
    </Sheet>
  )
}

/**
 * TRAIN — the week, in full. Every session is on the surface with its state
 * (to-do / in-progress / done), startable in any order. Mobile shape: one
 * summary instrument, at most one attention banner, then the session list.
 * Detail lives in sheets, never inline.
 */
export function TodayScreen({ athleteId, todayRoutine, routines, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const location   = useLocation()
  // A session finished a moment ago rides in on router state. Cleared on dismiss
  // (replace, no state) so a reload or a back-swipe never replays it.
  const finished = (location.state as { finished?: FinishedSession } | null)?.finished ?? null
  const dismissFinished = () => navigate(location.pathname, { replace: true, state: null })
  const { refresh, athleteName } = (useOutletContext<LoopContext>() ?? { refresh: () => {}, athleteName: null })
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [draftStarts, setDraftStarts] = useState<Record<string, string>>({})
  const [showCloseSheet, setShowCloseSheet] = useState(false)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [weekOffset, setWeekOffset] = useState(0)   // 0 = this week, <0 past, >0 future/boundary
  // Planned day rides on routine.intended_dow (synced). Keep an optimistic
  // override so the chip/picker updates instantly before the refetch lands.
  const [dowOverride, setDowOverride] = useState<Record<string, number | null>>({})
  const [stuckOpen, setStuckOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const handlePlanDay = (routineId: string, dow: number | null) => {
    setDowOverride((o) => ({ ...o, [routineId]: dow }))
    void setIntendedDay(routineId, dow).then(() => refresh())
  }
  const plannedDowFor = (r: RoutineRow): number | null =>
    r.id in dowOverride ? dowOverride[r.id] : (r.intended_dow ?? null)
  // The week list reads in calendar order by planned day, not by name.
  const weekList = orderByPlannedDay(routines, plannedDowFor)
  // Sessions finished offline. Subscribed to the outbox, so the note appears and
  // clears as the queue actually moves rather than on a guessed delay.
  const outbox = useOutboxStatus()

  const { data: view, loading, refetch } = useCachedLoader(
    `today:${athleteId}`,
    () => fetchTodayView(athleteId),
  )
  const { data: pager } = useCachedLoader(
    `weekpager:${athleteId}`,
    () => gatherWeekPager(athleteId, unitContext()),
  )

  const p1            = view?.p1 ?? null
  const retestDue     = isRetestDue(view?.retestDate ?? null)

  // Sessions finished but not yet committed (offline, or a commit still in
  // flight) are folded in alongside the synced ones, so a session reads DONE the
  // instant it's finished — with no connection and no refetch. They drop out on
  // their own once the outbox drains and the real rows arrive.
  const allWorkouts: WeekWorkout[] = (() => {
    const committed = view?.weekWorkouts ?? []
    const queued = pendingSessionsRaw()
      .map((p) => ({ id: pendingRef(p.id), routineId: p.routineId, performedAt: p.performedAt ?? p.queuedAt }))
      .filter((p) => !committed.some(
        (w) => w.routineId === p.routineId && isSameDay(new Date(w.performedAt), new Date(p.performedAt)),
      ))
    return [...committed, ...queued]
  })()

  const today = new Date()
  const thisWindow = weekWindowInZone(today)
  const nextWindow = upcomingWeekWindow(today)

  // Plant a bootstrap for every session on the week list, so the FIRST tap on
  // one paints its exercises immediately instead of spinning on the network.
  // Existing (fetched) bootstraps — which carry last session's numbers and the
  // prescription — are left alone; the workout screen revalidates either way.
  useEffect(() => {
    routines.forEach((r) => seedWorkoutBootstrap(r, athleteId, athleteName, onboardingStep ?? null))
    for (const r of pager?.upcoming?.routines ?? []) {
      seedWorkoutBootstrap(asRoutineRow(r), athleteId, athleteName, onboardingStep ?? null)
    }
  }, [routines, pager, athleteId, athleteName, onboardingStep])

  // Which sessions are mid-flight (a live draft). Offline-tolerant — the local
  // scan alone is enough, so the markers show with no connection.
  useEffect(() => {
    void loadDraftStarts(athleteId).then(setDraftStarts).catch(() => setDraftStarts({}))
  }, [athleteId, view])

  // Lazy outer-cadence triggers (§4.2, §5): run the weekly review + phase
  // advancement once per page-session, then refresh ONLY if something changed.
  useEffect(() => {
    if (triggeredThisSession.has(athleteId)) return
    triggeredThisSession.add(athleteId)
    void (async () => {
      const changed = await runLoopTriggers(athleteId)
      if (changed) {
        invalidateLoopViews()
        refetch()
        refresh()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  const latestReview = view?.latestReview ?? null
  const pastWeeks = pager?.past ?? []
  const futureWeeks = pager?.future ?? []
  const boundary = pager?.boundary ?? null
  const minWeekOffset = -pastWeeks.length
  const maxWeekOffset = Math.max(1, futureWeeks.length) + (boundary ? 1 : 0)
  const wOffset = Math.max(minWeekOffset, Math.min(maxWeekOffset, weekOffset))
  const atBoundary = boundary != null && wOffset === Math.max(1, futureWeeks.length) + 1
  const pagerWeek: PagerWeekView | null =
    wOffset < 0 ? pastWeeks[pastWeeks.length + wOffset]
    : wOffset > 0 && wOffset <= futureWeeks.length ? futureWeeks[wOffset - 1]
    : null

  const viewingUpcoming = wOffset === 1
  const displayWindow = viewingUpcoming ? (pager?.upcoming
    ? { weekStart: pager.upcoming.weekStart, weekEnd: pager.upcoming.weekEnd }
    : nextWindow) : thisWindow

  const plannedThisWeek = Math.max(1, view?.sessionsPerWeek ?? (routines.length || 3))
  const thisWeekDone = weekLoggedDays(allWorkouts, thisWindow.weekStart, thisWindow.weekEnd)
  const doneCount = weekLoggedDays(allWorkouts, displayWindow.weekStart, displayWindow.weekEnd)
  const lastDoneByRoutine = view?.lastDoneByRoutine ?? {}

  const weekDays: WeekDayStatus[] = daysFromWeekStart(displayWindow.weekStart).map((d) => ({
    date: d,
    logged: allWorkouts.some((w) =>
      isSameDay(new Date(w.performedAt), d) && isoInWeek(w.performedAt, displayWindow.weekStart, displayWindow.weekEnd),
    ),
    isToday: isSameDay(d, today),
  }))

  function statusFor(routineId: string): SessionState {
    const state = sessionStateForWeek({
      routineId,
      weekStart: displayWindow.weekStart,
      weekEnd: displayWindow.weekEnd,
      workouts: allWorkouts,
      draftStartedAt: draftStarts[routineId] ?? null,
    })
    if (state.kind === 'done' && state.lastPerformedAt) {
      const last = allWorkouts
        .filter((w) => w.routineId === routineId && w.performedAt === state.lastPerformedAt)
        .sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0]
      if (last) return { kind: 'done', lastWorkout: last, count: state.count }
    }
    if (state.kind === 'in_progress') return { kind: 'in_progress' }
    return { kind: 'todo' }
  }

  const confidencePct = p1 ? Math.round(p1.confidence * 100) : null

  // THE WEEK'S PLAN — one number, the same one the rest of the app uses.
  //
  // This screen used to measure the week against `routines.length` (how many
  // sessions the block contains) while the scheduler, the weekly review and the
  // adherence gate all measured it against `sessions_per_week` (how many the
  // athlete said they train). Those are different numbers the moment a block
  // carries three sessions and the athlete trains five: Train said "Week
  // complete · 3 of 3" on the same day the recap said "Only 3/5 sessions logged
  // — holding load". Both were reading their own definition correctly.
  //
  // Sessions done is counted the way computeWeekSchedule counts it — distinct
  // calendar DAYS trained, so logging Session A twice in one week counts twice
  // and twice in one day counts once. Counts are scoped to the week instance
  // so last week's logs never fill this week's ring.
  const weekZeroed = doneCount >= plannedThisWeek
  // "Week zeroed" on the finish moment only for the session that filled it, not
  // every session logged after. Days are what count toward the week, so it's
  // the day count without this session against the day count with it. (If the
  // commit has already landed, the pending id is gone and this reads false:
  // the moment just says "Session zeroed", which is still true.)
  const filledWeekNow = (() => {
    if (!finished || thisWeekDone < plannedThisWeek) return false
    const mine = pendingRef(finished.pendingId)
    const thisWeekLogs = allWorkouts.filter((w) =>
      isoInWeek(w.performedAt, thisWindow.weekStart, thisWindow.weekEnd),
    )
    if (!thisWeekLogs.some((w) => w.id === mine)) return false
    const before = weekLoggedDays(
      thisWeekLogs.filter((w) => w.id !== mine),
      thisWindow.weekStart,
      thisWindow.weekEnd,
    )
    return before < plannedThisWeek
  })()
  const upcomingRoutines = (pager?.upcoming?.routines ?? []).map(asRoutineRow)
  const liveList = viewingUpcoming && upcomingRoutines.length
    ? upcomingRoutines
    : weekList
  const startWeek = viewingUpcoming ? displayWindow.weekStart : null
  const startHref = (id: string) => startWeek ? `/app/workout/${id}?week=${startWeek}` : `/app/workout/${id}`

  const primaryRoutineId =
    (!viewingUpcoming && todayRoutine && statusFor(todayRoutine.id).kind === 'todo' ? todayRoutine.id : null)
    ?? liveList.find((r) => statusFor(r.id).kind === 'in_progress')?.id
    ?? liveList.find((r) => statusFor(r.id).kind === 'todo')?.id
    ?? null

  const recapRecent = latestReview
    ? Date.now() - new Date(`${latestReview.weekEnding}T12:00:00`).getTime() < 11 * 864e5
    : false
  const showRecap = !loading && !!latestReview && recapRecent && !recapSeen(latestReview.id)

  const curRange = fmtWeekRange(thisWindow.weekStart, thisWindow.weekEnd)
  const weekTitle = wOffset === 0 ? 'This week'
    : atBoundary ? boundary!.phaseName
    : wOffset === 1 ? 'Next week'
    : pagerWeek ? fmtWeekRange(pagerWeek.weekStart, pagerWeek.weekEnd) : ''
  const weekSub = wOffset === 0 ? curRange
    : atBoundary ? 'Upcoming phase'
    : wOffset < 0 ? `${pagerWeek ? fmtWeekRange(pagerWeek.weekStart, pagerWeek.weekEnd) : ''} · logged`
    : viewingUpcoming
      ? `${pager?.upcoming?.phaseName ? pager.upcoming.phaseName + ' · ' : ''}${fmtWeekRange(displayWindow.weekStart, displayWindow.weekEnd)}`
      : `${pagerWeek?.phaseName ? pagerWeek.phaseName + ' · ' : ''}projected`

  const currentWeekEnding = thisWindow.weekEnd
  const weekClosed = (latestReview?.weekEnding ?? null) === currentWeekEnding
  const weekLoggedOut = thisWeekDone >= plannedThisWeek
  const canPreviewNextWeek = (pager?.future?.length ?? 0) > 0 || !!pager?.upcoming

  // Finished the week (or closed it) → land on next week's preview unless they
  // explicitly swiped back to this week.
  useEffect(() => {
    if (loading || !canPreviewNextWeek) return
    if (!weekLoggedOut && !weekClosed) return
    if (weekPreviewDismissed(currentWeekEnding)) return
    if (weekOffset !== 0) return
    setWeekOffset(1)
  }, [loading, canPreviewNextWeek, weekLoggedOut, weekClosed, currentWeekEnding, weekOffset])

  async function handleCloseWeek(injury: boolean) {
    if (closing) return
    setClosing(true)
    try {
      const res = await closeOutCurrentWeek(athleteId, { injury })
      setShowCloseSheet(false)
      // Closing the week cuts a review and can advance the phase — that lands in
      // the recap, the program map, the coach log and the schedule alike.
      invalidateLoopViews()
      refetch()
      refresh()
      if (res) navigate(`/app/recap/${res.reviewId}`)
    } catch (e) {
      console.error('[close-week] failed', e)
    } finally {
      setClosing(false)
    }
  }

  const openSession =
    liveList.find((r) => r.id === openSessionId)
    ?? routines.find((r) => r.id === openSessionId)
    ?? upcomingRoutines.find((r) => r.id === openSessionId)
    ?? null

  // The open sheet's prescription — the concrete lb/kg number per lift, from the
  // same engine read the workout screen shows. Cached per routine so a re-open
  // paints instantly and offline; the fetch also refreshes the workout
  // bootstrap's copy, so the number the preview promises is the one the session
  // opens with.
  const u = unitContext()
  const { data: openRx } = useCachedLoader(
    openSession ? cacheKeys.sessionRx(openSession.id) : null,
    async () => {
      const rx = await gatherSessionPrescription(athleteId, openSession!.id, openSession!.exercises, u)
      mutateCache<WorkoutBootstrap>(workoutBootKey(openSession!.id), (b) => ({ ...b, prescription: rx }))
      return rx
    },
  )
  // Cold rx key (first-ever open, maybe offline): fall back to the bootstrap's
  // copy, planted by a previous visit to the workout screen.
  const openTargets = openSession
    ? (openRx ?? loadCache<WorkoutBootstrap>(workoutBootKey(openSession.id))?.prescription)?.targets ?? null
    : null

  // A finished session opens on what it actually was. The numbers come from the
  // outbox while it's still queued (so a session finished seconds ago reads
  // correctly, offline included) and from the workout row once it has synced.
  const openState = openSession ? statusFor(openSession.id) : null
  const doneRef = openState?.kind === 'done' ? openState.lastWorkout.id : null
  const donePendingId = parsePendingRef(doneRef)
  const { data: committedActuals } = useCachedLoader(
    doneRef && !donePendingId ? cacheKeys.sessionActuals(doneRef) : null,
    () => gatherSessionActuals(doneRef!),
  )
  const openActuals = donePendingId
    ? actualsFromPending(pendingSessionById(donePendingId))
    : committedActuals

  // At most ONE attention banner. Ranked by urgency so the screen never stacks
  // three competing yellow boxes the way it used to.
  const banner = (() => {
    if (loading) return null
    if (retestDue) {
      return (
        <Banner
          icon={<Activity size={20} strokeWidth={1.75} style={{ color: 'var(--signal)' }} />}
          title="Retest due"
          sub="A quick rescreen re-scopes your program."
          onClick={() => navigate('/app/retest')}
        />
      )
    }
    if (showRecap && latestReview) {
      return (
        <Banner
          icon={<Sparkles size={20} strokeWidth={1.75} style={{ color: 'var(--signal)' }} />}
          title="Your weekly recap is ready"
          sub="What moved, and the call for this week."
          onClick={() => { markRecapSeen(latestReview.id); navigate(`/app/recap/${latestReview.id}`) }}
        />
      )
    }
    // Sync state, in either direction, is NOT banner material — see the footnote
    // under the week ring. A banner is for something the week needs from you;
    // sessions that are already logged and already counted aren't that, even when
    // the upload is stuck.
    return null
  })()

  return (
    <div className="screen with-nav">
      {finished && (
        <SessionZeroed
          session={finished}
          // The session that fills the week says so. Queued sessions count the
          // instant they're finished, so this is already true on arrival.
          week={filledWeekNow ? { done: doneCount, planned: plannedThisWeek } : null}
          onDone={dismissFinished}
        />
      )}
      <div className="page page--rail">
       <div className="page__main">

        {/* Week pager — the one header. Arrows are 44px targets. */}
        <div className="pager">
          <button
            type="button" aria-label="Previous week"
            className="pager__btn"
            disabled={wOffset <= minWeekOffset}
            onClick={() => {
              if (wOffset === 1 && (weekLoggedOut || weekClosed)) dismissWeekPreview(currentWeekEnding)
              setWeekOffset(wOffset - 1)
            }}
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <div className="pager__label">
            <p className="pager__title">{weekTitle}</p>
            {weekSub && <p className="pager__sub">{weekSub}</p>}
          </div>
          <button
            type="button" aria-label="Next week"
            className="pager__btn"
            disabled={wOffset >= maxWeekOffset}
            onClick={() => setWeekOffset(wOffset + 1)}
          >
            <ChevronRight size={22} strokeWidth={2} />
          </button>
        </div>

        {wOffset === 0 || viewingUpcoming ? (
          <>
            {isFirstVisit && !viewingUpcoming && (
              <Banner
                tone="quiet"
                title="Start anywhere"
                sub="Every session for the week is here — do whichever fits your day."
              />
            )}

            {banner}

            {/* THE WEEK, AT A GLANCE — a ring and seven dots instead of a
                sentence. Replaces the old "2/4 done" text plus a separate
                day strip stranded in a desktop-only rail. */}
            {!loading && liveList.length > 0 && (
              <div className="card fade-rise" style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  {/* A full week is the instrument's lock: the brackets close on the
                      ring. Anything short of it is just a ring. */}
                  {weekZeroed ? (
                    <LockOn style={{ '--lock-gap': '-6px', '--lock-from': '12px', '--lock-size': '10px' } as React.CSSProperties}>
                      <Ring value={1} size={72} label={`${doneCount} of ${plannedThisWeek} sessions logged ${viewingUpcoming ? 'next week' : 'this week'}`}>
                        <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700 }}>{doneCount}</span>
                        <span className="text-micro text-dim" style={{ marginTop: 2 }}>of {plannedThisWeek}</span>
                      </Ring>
                    </LockOn>
                  ) : (
                    <Ring value={doneCount / plannedThisWeek} size={72} label={`${doneCount} of ${plannedThisWeek} sessions logged ${viewingUpcoming ? 'next week' : 'this week'}`}>
                      <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700 }}>{doneCount}</span>
                      <span className="text-micro text-dim" style={{ marginTop: 2 }}>of {plannedThisWeek}</span>
                    </Ring>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="text-lg" style={{ fontWeight: 700, lineHeight: 1.25 }}>
                      {doneCount === 0 ? 'Nothing logged yet'
                        : weekZeroed ? 'Week zeroed'
                        : `${plannedThisWeek - doneCount} to go`}
                    </p>
                    <div className="week-strip" style={{ marginTop: 12, padding: 0, gap: 2 }}>
                      {weekDays.map((day, i) => (
                        <div
                          key={i}
                          className={`week-day${day.isToday ? ' week-day--today' : ''}${day.logged ? ' week-day--logged' : ''}`}
                        >
                          <span className="week-day__label">{DAY_LABELS[(day.date.getDay() + 6) % 7]}</span>
                          <div className="week-day__dot" />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Upload state lives here, as one line at the bottom of the
                    instrument that already counts these sessions — not as a card
                    of its own. Both states are footnotes; the stuck one is merely
                    a tappable footnote, because there's a decision behind it. */}
                {outbox.blocked > 0 ? (
                  <button
                    type="button"
                    className="ring-card__note ring-card__note--tap"
                    onClick={() => setStuckOpen(true)}
                  >
                    <CloudAlert size={13} strokeWidth={1.75} />
                    <span>
                      {outbox.blocked} couldn&apos;t upload — counted here, tap to fix
                    </span>
                    <ChevronRight size={13} strokeWidth={2} />
                  </button>
                ) : outbox.pending > 0 ? (
                  <p className="ring-card__note">
                    <CloudUpload size={13} strokeWidth={1.75} />
                    <span>{outbox.pending} saved on this device, syncing</span>
                  </p>
                ) : null}
              </div>
            )}

            {/* Sessions */}
            {loading && liveList.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Skeleton height={18} width={170} /><Skeleton height={12} width={110} />
                  </div>
                ))}
              </div>
            ) : liveList.length === 0 ? (
              <div className="card">
                <p className="text-base text-dim">
                  No sessions yet. Finish onboarding and your program builds here.
                </p>
              </div>
            ) : (
              <>
                <div className="section__head">
                  <SectionHeader>Sessions</SectionHeader>
                  <button
                    type="button"
                    className="page-head__action"
                    onClick={() => navigate('/app/history')}
                  >
                    History ›
                  </button>
                </div>
                <div className="stagger">
                  {liveList.map((r) => (
                    <SessionCard
                      key={r.id}
                      routine={r}
                      recommended={r.id === primaryRoutineId}
                      state={statusFor(r.id)}
                      lastDone={lastDoneByRoutine[r.id] ?? null}
                      plannedDow={plannedDowFor(r)}
                      onOpen={() => setOpenSessionId(r.id)}
                      onStart={() => navigate(startHref(r.id), { viewTransition: true })}
                    />
                  ))}
                </div>
              </>
            )}

            {/* The read — a glance that taps through to Coach. A meter, not a
                mono string of telemetry nobody could parse. */}
            {!loading && p1 && confidencePct !== null && (
              <button
                type="button"
                onClick={() => navigate('/app/coach')}
                className="card card--tap fade-rise"
                style={{ width: '100%', textAlign: 'left', marginTop: 24, marginBottom: 12, color: 'var(--text)' }}
              >
                {/* The brand's reticle, doing its actual job: its tightness IS this
                    read's confidence (real state, never a timer), so the one place
                    the phone shows "the read" is also where Zeroed looks like
                    Zeroed. It collapses in once on arrival, then holds. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ flexShrink: 0 }}>
                    <ConvergenceReticle confidence={p1.confidence} size={64} showLabel={false} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <span className="section-header">The read</span>
                      <span className="num text-sm text-signal">{confidencePct}%</span>
                    </div>
                    <p className="text-base prose-clamp" style={{ marginTop: 6, lineHeight: 1.45 }}>{p1.claim}</p>
                  </div>
                </div>
              </button>
            )}

            {/* End-of-week close-out. */}
            {!loading && !viewingUpcoming && routines.length > 0 && (
              weekClosed ? (
                <Banner
                  tone="good"
                  icon={<Flag size={20} strokeWidth={1.75} style={{ color: 'var(--confirmed)' }} />}
                  title="Week closed"
                  sub="View the recap"
                  onClick={() => latestReview && navigate(`/app/recap/${latestReview.id}`)}
                />
              ) : (
                <Banner
                  tone="quiet"
                  icon={<Flag size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
                  title="Done with the week?"
                  sub="Crunch the numbers and set next week."
                  onClick={() => setShowCloseSheet(true)}
                />
              )
            )}
          </>
        ) : atBoundary && boundary ? (
          <PagerBoundary boundary={boundary} />
        ) : pagerWeek ? (
          <PagerWeekBody
            week={pagerWeek}
            mode={wOffset < 0 ? 'past' : 'future'}
            onTapSession={() => navigate('/app/history')}
          />
        ) : null}
       </div>
      </div>

      {openSession && (
        <SessionSheet
          routine={openSession}
          state={statusFor(openSession.id)}
          targets={openTargets}
          actuals={openActuals}
          u={u}
          plannedDow={plannedDowFor(openSession)}
          onPlanDay={(dow) => handlePlanDay(openSession.id, dow)}
          onClose={() => setOpenSessionId(null)}
          onStart={() => navigate(startHref(openSession.id), { viewTransition: true })}
          onLogAgain={() => navigate(startHref(openSession.id))}
          onEdit={() => {
            const s = statusFor(openSession.id)
            if (s.kind === 'done') navigate(`/app/workout/${openSession.id}?w=${s.lastWorkout.id}`)
          }}
        />
      )}

      {stuckOpen && outbox.blocked > 0 && (
        <StuckSessionsSheet
          count={outbox.blocked}
          reasons={outbox.reasons}
          retrying={retrying}
          onClose={() => setStuckOpen(false)}
          onRetry={() => {
            setRetrying(true)
            void retryBlocked().finally(() => {
              setRetrying(false)
              refetch()
            })
          }}
          onDiscard={() => { discardBlocked(); setStuckOpen(false); refetch() }}
        />
      )}

      {showCloseSheet && (
        <CloseWeekSheet
          doneCount={doneCount}
          planned={plannedThisWeek}
          closing={closing}
          onClose={() => setShowCloseSheet(false)}
          onConfirm={() => void handleCloseWeek(false)}
          onInjury={() => void handleCloseWeek(true)}
        />
      )}
    </div>
  )
}
