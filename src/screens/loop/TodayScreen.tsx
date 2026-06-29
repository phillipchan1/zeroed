import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { runLoopTriggers, isRetestDue, closeOutCurrentWeek, gatherWeekPager, type PagerWeekView, type WeekPagerData } from '../../engine'
import { getWeightUnit } from '../../lib/units'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { loadDraftRoutineIds } from '../../lib/workoutDraft'
import { pendingCount } from '../../lib/workoutOutbox'
import { setIntendedDay, DAY_LABELS as PLAN_DAYS } from '../../lib/weekPlan'
import { Button, SectionHeader, Skeleton, TelemetryStrip } from '../../components/ui'
import type { RoutineRow, InsightRow, OnboardingStep } from '../../types/database'

interface TodayScreenProps {
  athleteId: string
  todayRoutine: RoutineRow | null
  routines: RoutineRow[]
  onboardingStep?: OnboardingStep
}

interface LoopContext {
  refresh: () => void
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

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

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

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  )
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })
const dayAndDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
// Local YYYY-MM-DD (matches the engine's week_ending, which is local-time Sunday).
const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

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
  p1: { category: string; confidence: number } | null
  retestDate: string | null
  sessionsPerWeek: number | null
  latestReview: { id: string; weekEnding: string } | null
  lastDoneByRoutine: Record<string, string>   // routineId → most recent performed_at (any week)
}

async function fetchTodayView(athleteId: string): Promise<TodayView> {
  const days = getWeekDays()
  const weekEnd = new Date(days[6].getFullYear(), days[6].getMonth(), days[6].getDate(), 23, 59, 59)

  const [workoutRes, insightRes, athRes, profileRes] = await Promise.all([
    supabase
      .from('workout')
      .select('id, performed_at, routine_id, routine!inner(program!inner(athlete_id))')
      .gte('performed_at', days[0].toISOString())
      .lte('performed_at', weekEnd.toISOString()),
    supabase.from('insight').select('*').eq('athlete_id', athleteId).order('priority'),
    supabase.from('athlete').select('goals, obstacle, sessions_per_week').eq('id', athleteId).maybeSingle(),
    supabase.from('athlete_profile').select('retest_date').eq('athlete_id', athleteId).maybeSingle(),
  ])
  if (workoutRes.error) throw workoutRes.error
  if (insightRes.error) throw insightRes.error
  if (athRes.error) throw athRes.error
  if (profileRes.error) throw profileRes.error

  const all = (insightRes.data ?? []) as InsightRow[]
  const active = all.filter((i) => i.status !== 'resolved' && i.status !== 'disproved')
  const top = active[0] ?? null
  const ath = athRes.data as { goals: string | null; obstacle: string | null; sessions_per_week: number | null } | null

  // Latest weekly review (recap prompt) + last-performed per routine (so a
  // session done in a prior week still shows its history, not a blank "to do").
  // Both scoped by the active program.
  let latestReview: { id: string; weekEnding: string } | null = null
  const lastDoneByRoutine: Record<string, string> = {}
  const { data: prog } = await supabase
    .from('program').select('id').eq('athlete_id', athleteId).eq('status', 'active').maybeSingle()
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
    p1: top ? { category: top.category, confidence: top.confidence } : null,
    retestDate: (profileRes.data?.retest_date as string | null) ?? null,
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

// ---- one session row in the week list -------------------------------------

type SessionState =
  | { kind: 'todo' }
  | { kind: 'in_progress' }
  | { kind: 'done'; lastWorkout: WeekWorkout; count: number }

function WorkoutPreviewSheet({
  routine, recommended, state, plannedDow, onPlanDay, onClose, onStart, onResume, onEdit, onLogAgain,
}: {
  routine: RoutineRow
  recommended: boolean
  state: SessionState
  plannedDow: number | null
  onPlanDay: (dow: number | null) => void
  onClose: () => void
  onStart: () => void
  onResume: () => void
  onEdit: () => void
  onLogAgain: () => void
}) {
  return (
    <div className="obs-sheet" onClick={onClose}>
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <p className="section-header">{routine.name}</p>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>

        {routine.intent && (
          <p className="text-xs text-dim" style={{ marginBottom: 14, lineHeight: 1.5 }}>{routine.intent}</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {routine.exercises.map((ex, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <p className="text-sm" style={{ fontWeight: 500 }}>{ex.name}</p>
                {ex.cue && (
                  <p className="text-xs text-dim" style={{ marginTop: 2, lineHeight: 1.4 }}>{ex.cue}</p>
                )}
              </div>
              <p
                className="num text-xs"
                style={{ whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', paddingTop: 2 }}
              >
                {ex.sets}×{ex.reps}{ex.load ? ` · ${ex.load}` : ''}
              </p>
            </div>
          ))}
        </div>

        {/* Plan for — soft day-pinning. A suggestion, never enforced: scheduling
            stays count-based; this just lets you lay out the week. */}
        <div style={{ marginBottom: 16 }}>
          <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            Plan for
          </p>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {PLAN_DAYS.map((label, dow) => {
              const active = plannedDow === dow
              return (
                <button
                  key={dow}
                  type="button"
                  onClick={() => onPlanDay(active ? null : dow)}
                  className="num text-xs"
                  style={{
                    flex: '1 0 auto', minWidth: 38, padding: '6px 0', borderRadius: 6, cursor: 'pointer',
                    fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
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
          {plannedDow != null && (
            <button
              type="button"
              onClick={() => onPlanDay(null)}
              style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-dim)' }}
            >
              Clear day
            </button>
          )}
        </div>

        {state.kind === 'todo' && (
          <Button variant={recommended ? 'primary' : 'ghost'} full onClick={onStart}>
            {recommended ? 'Start session →' : 'Start →'}
          </Button>
        )}
        {state.kind === 'in_progress' && (
          <Button variant="primary" full onClick={onResume}>Resume session →</Button>
        )}
        {state.kind === 'done' && (
          <>
            <Button variant="ghost" full onClick={onEdit}>Review / edit →</Button>
            <button
              type="button"
              onClick={onLogAgain}
              style={{
                display: 'block', margin: '10px auto 0', background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-dim)',
              }}
            >
              Log again
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function SessionCard({
  routine, recommended, state, lastDone, plannedDow, onPlanDay, onStart, onResume, onEdit, onLogAgain,
}: {
  routine: RoutineRow
  recommended: boolean
  state: SessionState
  lastDone: string | null
  plannedDow: number | null
  onPlanDay: (dow: number | null) => void
  onStart: () => void
  onResume: () => void
  onEdit: () => void
  onLogAgain: () => void
}) {
  const [showPreview, setShowPreview] = useState(false)
  const exCount = (routine.exercises as unknown[]).length
  const done = state.kind === 'done'
  const inProg = state.kind === 'in_progress'
  const borderColor = inProg ? 'var(--signal)' : done ? 'var(--confirmed)' : undefined

  return (
    <>
      <div
        className="card fade-rise"
        style={{ marginBottom: 10, borderColor, cursor: 'pointer' }}
        onClick={() => setShowPreview(true)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            {routine.name}
            {recommended && state.kind === 'todo' && (
              <span className="text-xs text-signal" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Next up
              </span>
            )}
          </h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap' }}>
            {plannedDow != null && (
              <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--signal)' }}>
                {PLAN_DAYS[plannedDow]}
              </span>
            )}
            <span className="num text-xs text-dim">{exCount} ex</span>
          </div>
        </div>

        {/* Status line */}
        <p
          className="text-xs"
          style={{
            marginTop: 6, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase',
            color: done ? 'var(--confirmed)' : inProg ? 'var(--signal)' : 'var(--text-dim)',
          }}
        >
          {state.kind === 'done'
            ? `✓ Logged · ${shortDay(state.lastWorkout.performedAt)}${state.count > 1 ? ` · ×${state.count}` : ''}`
            : inProg ? '● In progress' : '○ To do'}
        </p>

        {/* History — proves a session logged even when it was a prior week, so a
            rolled-over week never looks like the work vanished. */}
        {state.kind !== 'done' && lastDone && (
          <p className="text-xs text-dim" style={{ marginTop: 4, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
            Last done {dayAndDate(lastDone)}
          </p>
        )}

        {routine.intent && state.kind === 'todo' && (
          <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{routine.intent}</p>
        )}

        {/* Action — one clear CTA per state. */}
        <div style={{ marginTop: 12 }} onClick={(e) => e.stopPropagation()}>
          {state.kind === 'todo' && (
            <Button variant={recommended ? 'primary' : 'ghost'} full onClick={onStart}>
              {recommended ? 'Start session →' : 'Start →'}
            </Button>
          )}
          {state.kind === 'in_progress' && (
            <Button variant="primary" full onClick={onResume}>Resume session →</Button>
          )}
          {state.kind === 'done' && (
            <>
              <Button variant="ghost" full onClick={onEdit}>Review / edit →</Button>
              <button
                type="button"
                onClick={onLogAgain}
                style={{
                  display: 'block', margin: '10px auto 0', background: 'none', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-dim)',
                }}
              >
                Log again
              </button>
            </>
          )}
        </div>
      </div>

      {showPreview && (
        <WorkoutPreviewSheet
          routine={routine}
          recommended={recommended}
          state={state}
          plannedDow={plannedDow}
          onPlanDay={onPlanDay}
          onClose={() => setShowPreview(false)}
          onStart={onStart}
          onResume={onResume}
          onEdit={onEdit}
          onLogAgain={onLogAgain}
        />
      )}
    </>
  )
}

const fmtWeekRange = (startISO: string, endISO: string) => {
  const s = new Date(`${startISO}T12:00:00`), e = new Date(`${endISO}T12:00:00`)
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return mon(s) === mon(e) ? `${mon(s)} ${s.getDate()}–${e.getDate()}` : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`
}

const pagerArrowStyle = (disabled: boolean): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
  border: '1px solid var(--line)', background: 'transparent',
  color: disabled ? 'var(--line)' : 'var(--text-dim)',
  cursor: disabled ? 'default' : 'pointer',
})

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
        <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
          {mode === 'past' ? 'Nothing logged this week.' : 'Projected loads appear once you’ve logged a session in this phase.'}
        </p>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {week.sessions.map((s, i) => (
        <div
          key={`${s.routineId}-${i}`}
          className="card"
          style={{ cursor: mode === 'past' && onTapSession ? 'pointer' : 'default', opacity: mode === 'future' ? 0.92 : 1 }}
          onClick={mode === 'past' && onTapSession ? () => onTapSession(s.routineId) : undefined}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>{s.routineName}</h3>
            {s.tag
              ? <span className="num text-xs text-dim" style={{ whiteSpace: 'nowrap' }}>{s.tag}</span>
              : <span className="text-xs" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pending)' }}>Projected</span>}
          </div>
          {s.lines.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {s.lines.map((l, j) => (
                <div key={j} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span className="text-xs" style={{ color: 'var(--text)' }}>{l.name}</span>
                  <span className="num text-xs text-dim">{l.detail}</span>
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
    <div className="card" style={{ opacity: 0.9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lock size={13} strokeWidth={1.5} color="var(--text-dim)" />
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>{boundary.phaseName} phase</h3>
      </div>
      {boundary.goal && <p className="text-xs text-dim" style={{ marginTop: 6, lineHeight: 1.5 }}>{boundary.goal}</p>}
      {boundary.gate.length > 0 && (
        <p className="text-xs text-dim" style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.04em', lineHeight: 1.5 }}>
          UNLOCKS WHEN · {boundary.gate[0]}
        </p>
      )}
      <p className="text-xs text-dim" style={{ marginTop: 10, lineHeight: 1.5 }}>
        Sessions build when you graduate in — the program reads your phase before it writes the next one.
      </p>
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
    <div className="obs-sheet" onClick={closing ? undefined : onClose}>
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <p className="section-header">Close out the week</p>
          {!closing && (
            <button
              type="button"
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          )}
        </div>

        <p className="text-sm text-dim" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          {doneCount}/{planned} sessions logged. The coach crunches the week, sets next week's load and effort, and leaves you a note. You can still log more after — this just draws the line.
        </p>

        <Button variant="primary" full disabled={closing} onClick={onConfirm}>
          {closing ? 'Crunching the week…' : "I'm done — crunch my week →"}
        </Button>
        <button
          type="button"
          disabled={closing}
          onClick={onInjury}
          style={{
            display: 'block', margin: '12px auto 0', background: 'none', border: 'none',
            cursor: closing ? 'default' : 'pointer', opacity: closing ? 0.5 : 1,
            fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-dim)',
          }}
        >
          Injured / taking time off →
        </button>
      </div>
    </div>
  )
}

/**
 * TRAIN — the week, in full. Every session for the week is on the surface with
 * its state (to-do / in-progress / done), startable, resumable, and editable in
 * any order. Sessions aren't pinned to days — you pick what fits the gym, the
 * gear, the time you've got. The read sharpens underneath as you train; the
 * end-of-week recap lives in Coach.
 */
export function TodayScreen({ athleteId, todayRoutine, routines, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const { refresh } = (useOutletContext<LoopContext>() ?? { refresh: () => {} })
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [draftRoutineIds, setDraftRoutineIds] = useState<string[]>([])
  const [recapDismissed, setRecapDismissed] = useState(false)
  const [showCloseSheet, setShowCloseSheet] = useState(false)
  const [closing, setClosing] = useState(false)
  const [weekOffset, setWeekOffset] = useState(0)   // 0 = this week, <0 past, >0 future/boundary
  // Planned day rides on routine.intended_dow (synced). Keep an optimistic
  // override so the chip/picker updates instantly before the refetch lands.
  const [dowOverride, setDowOverride] = useState<Record<string, number | null>>({})
  const handlePlanDay = (routineId: string, dow: number | null) => {
    setDowOverride((o) => ({ ...o, [routineId]: dow }))
    void setIntendedDay(routineId, dow).then(() => refresh())
  }
  const plannedDowFor = (r: RoutineRow): number | null =>
    r.id in dowOverride ? dowOverride[r.id] : (r.intended_dow ?? null)
  // Sessions finished offline, waiting to sync. Re-checked when connectivity
  // returns so the note clears itself once the outbox drains.
  const [pendingSync, setPendingSync] = useState(pendingCount())

  const { data: view, loading, refetch } = useCachedLoader(
    `today:${athleteId}`,
    () => fetchTodayView(athleteId),
  )
  const { data: pager } = useCachedLoader(
    `weekpager:${athleteId}`,
    () => gatherWeekPager(athleteId, getWeightUnit()),
  )

  const totalInsights = view?.totalInsights ?? 0
  const likelyCount   = view?.likelyCount ?? 0
  const p1Count       = view?.p1Count ?? 0
  const lastSignalAt  = view?.lastSignalAt ?? null
  const p1            = view?.p1 ?? null
  const retestDue     = isRetestDue(view?.retestDate ?? null)
  const weekWorkouts  = view?.weekWorkouts ?? []

  // Week strip — recomputed from the workouts against the current day, so "today"
  // and the Mon–Sun window are always correct even from a stale cache.
  const today = new Date()
  const loggedDates = weekWorkouts.map((w) => new Date(w.performedAt))
  const weekDays: WeekDayStatus[] = getWeekDays().map((d) => ({
    date: d,
    logged: loggedDates.some((ld) => isSameDay(ld, d)),
    isToday: isSameDay(d, today),
  }))

  // Which sessions are mid-flight (a live draft). Offline-tolerant — the local
  // scan alone is enough, so the markers show with no connection.
  useEffect(() => {
    void loadDraftRoutineIds(athleteId).then(setDraftRoutineIds).catch(() => setDraftRoutineIds([]))
  }, [athleteId, view])

  // Keep the pending-sync note honest: the outbox flushes on `online`, so recount
  // shortly after connectivity returns (and on focus) to clear it when drained.
  useEffect(() => {
    const recount = () => setTimeout(() => setPendingSync(pendingCount()), 1500)
    window.addEventListener('online', recount)
    window.addEventListener('focus', recount)
    return () => {
      window.removeEventListener('online', recount)
      window.removeEventListener('focus', recount)
    }
  }, [])

  // Lazy outer-cadence triggers (§4.2, §5): run the weekly review + phase
  // advancement once per page-session, then refresh ONLY if something changed.
  useEffect(() => {
    if (triggeredThisSession.has(athleteId)) return
    triggeredThisSession.add(athleteId)
    void (async () => {
      const changed = await runLoopTriggers(athleteId)
      if (changed) {
        refetch()
        refresh()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId])

  // Per-routine status for the week list.
  function statusFor(routineId: string): SessionState {
    const ws = weekWorkouts
      .filter((w) => w.routineId === routineId)
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
    if (ws.length) return { kind: 'done', lastWorkout: ws[0], count: ws.length }
    if (draftRoutineIds.includes(routineId)) return { kind: 'in_progress' }
    return { kind: 'todo' }
  }

  const telemetryItems: Array<{ label: string; value: string | number; signal?: boolean }> = [
    { label: 'INSIGHTS', value: totalInsights },
    { label: String(likelyCount), value: 'LIKELY' },
    { label: String(p1Count), value: 'P1', signal: p1Count > 0 },
  ]

  const confidencePct = p1 ? Math.round(p1.confidence * 100) : null
  const doneCount = routines.filter((r) => statusFor(r.id).kind === 'done').length
  const lastDoneByRoutine = view?.lastDoneByRoutine ?? {}

  // Exactly one session gets the primary (yellow) Start: the scheduler's pick if
  // it's still to-do, otherwise the first to-do in the list. Guarantees a clear
  // CTA even when the week has rolled over and there's no scheduled "today".
  const primaryRoutineId =
    (todayRoutine && statusFor(todayRoutine.id).kind === 'todo' ? todayRoutine.id : null)
    ?? routines.find((r) => statusFor(r.id).kind === 'todo')?.id
    ?? null

  // Recap prompt: the latest review, shown for ~10 days after it's cut, until
  // viewed or dismissed (tracked locally — no schema change).
  const latestReview = view?.latestReview ?? null

  const recapRecent = latestReview
    ? Date.now() - new Date(`${latestReview.weekEnding}T12:00:00`).getTime() < 11 * 864e5
    : false
  const showRecap = !loading && !!latestReview && recapRecent && !recapDismissed && !recapSeen(latestReview.id)

  // ── Week pager — ← real past weeks · this week · projected future → · phase edge.
  const pastWeeks = pager?.past ?? []
  const futureWeeks = pager?.future ?? []
  const boundary = pager?.boundary ?? null
  const minWeekOffset = -pastWeeks.length
  const maxWeekOffset = futureWeeks.length + (boundary ? 1 : 0)
  const wOffset = Math.max(minWeekOffset, Math.min(maxWeekOffset, weekOffset))
  const atBoundary = boundary != null && wOffset === futureWeeks.length + 1
  const pagerWeek: PagerWeekView | null =
    wOffset < 0 ? pastWeeks[pastWeeks.length + wOffset]
    : wOffset > 0 && wOffset <= futureWeeks.length ? futureWeeks[wOffset - 1]
    : null
  const curRange = fmtWeekRange(localIso(weekDays[0]?.date ?? today), localIso(weekDays[6]?.date ?? today))
  const weekTitle = wOffset === 0 ? 'This week'
    : atBoundary ? `${boundary!.phaseName} phase`
    : wOffset === 1 ? 'Next week'
    : pagerWeek ? fmtWeekRange(pagerWeek.weekStart, pagerWeek.weekEnd) : ''
  const weekSub = wOffset === 0 ? curRange
    : atBoundary ? 'Upcoming'
    : wOffset < 0 ? `${pagerWeek ? fmtWeekRange(pagerWeek.weekStart, pagerWeek.weekEnd) : ''} · logged`
    : `${pagerWeek?.phaseName ? pagerWeek.phaseName + ' · ' : ''}projected`

  // The current week's close-out (origin/master's flow). weekClosed is true once
  // a review exists for THIS week's Sunday — re-closing is idempotent, but we swap
  // the CTA so it reads "done" rather than inviting a second close.
  const currentWeekEnding = localIso(weekDays[6].date)
  const weekClosed = (latestReview?.weekEnding ?? null) === currentWeekEnding
  const plannedThisWeek = routines.length || 3

  async function handleCloseWeek(injury: boolean) {
    if (closing) return
    setClosing(true)
    try {
      const res = await closeOutCurrentWeek(athleteId, { injury })
      setShowCloseSheet(false)
      refetch()
      refresh()
      if (res) navigate(`/app/recap/${res.reviewId}`)
    } catch (e) {
      console.error('[close-week] failed', e)
    } finally {
      setClosing(false)
    }
  }

  return (
    <div className="screen with-nav">
      {isFirstVisit && (
        <p
          className="fade-rise"
          style={{ padding: '12px 16px', fontSize: 14, color: 'var(--text)', lineHeight: 1.5, borderBottom: '1px solid var(--line)' }}
        >
          This is your week. Every session's here — start any of them, in any order, and pick up where you left off. The read sharpens underneath as you train.
        </p>
      )}

      {!loading && <TelemetryStrip items={telemetryItems} lastSignalAt={lastSignalAt} />}

      <div className="page page--rail">
       <div className="page__main">

        {/* Offline-completed sessions waiting to sync. */}
        {pendingSync > 0 && (
          <div
            className="fade-rise"
            style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--line)',
            }}
          >
            <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
              {pendingSync} session{pendingSync === 1 ? '' : 's'} saved offline — {pendingSync === 1 ? 'it syncs' : 'they sync'} and the coach reads {pendingSync === 1 ? 'it' : 'them'} when you're back online.
            </p>
          </div>
        )}

        {/* Weekly recap — last week's review, the end-of-week payoff. */}
        {showRecap && latestReview && (
          <div className="card fade-rise" style={{ marginBottom: 16, borderColor: 'var(--signal)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <SectionHeader>Weekly recap</SectionHeader>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => { markRecapSeen(latestReview.id); setRecapDismissed(true) }}
                style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}
              >
                ×
              </button>
            </div>
            <p className="text-sm" style={{ marginTop: 8, lineHeight: 1.5 }}>
              Last week's in — what you did, what moved, and the call for this week.
            </p>
            <Button
              variant="primary"
              full
              style={{ marginTop: 14 }}
              onClick={() => { markRecapSeen(latestReview.id); navigate(`/app/recap/${latestReview.id}`) }}
            >
              View recap →
            </Button>
          </div>
        )}

        {/* The read — a quick glance that taps through to Coach. The goal
            ("chasing") anchor lives in Profile, so it isn't duplicated here. */}
        {!loading && p1 && confidencePct !== null && (
          <button
            type="button"
            onClick={() => navigate('/app/coach')}
            className="fade-rise"
            style={{
              marginBottom: 20, padding: 0, background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em',
              color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            THE READ · {p1.category.toUpperCase()} ·{' '}
            <span className="num text-signal">{confidencePct}%</span> CONFIDENT
            <span style={{ opacity: 0.6 }}>›</span>
          </button>
        )}

        {/* Retest due — the program cadence CTA (§6). Routes into the rescreen. */}
        {!loading && retestDue && (
          <div className="card fade-rise" style={{ marginBottom: 16, borderColor: 'var(--signal)' }}>
            <SectionHeader>Retest due</SectionHeader>
            <p className="text-sm" style={{ marginTop: 8, lineHeight: 1.5 }}>
              Time to re-read where you are. A quick movement rescreen shows what's moved since baseline and re-scopes the program.
            </p>
            <Button variant="primary" full style={{ marginTop: 14 }} onClick={() => navigate('/app/retest')}>
              Start retest →
            </Button>
          </div>
        )}

        {/* THE WEEK PAGER — ← past (logged) · this week · projected → · phase edge */}
        <div style={{ marginBottom: 8 }}>
          {/* Pager header: arrows + which week you're looking at */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
            <button
              type="button" aria-label="Previous week"
              disabled={wOffset <= minWeekOffset}
              onClick={() => setWeekOffset(wOffset - 1)}
              style={pagerArrowStyle(wOffset <= minWeekOffset)}
            >
              <ChevronLeft size={18} strokeWidth={1.5} />
            </button>
            <div style={{ textAlign: 'center', flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 14, fontWeight: 600 }}>{weekTitle}</p>
              {weekSub && (
                <p className="text-xs text-dim" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', marginTop: 2 }}>{weekSub}</p>
              )}
            </div>
            <button
              type="button" aria-label="Next week"
              disabled={wOffset >= maxWeekOffset}
              onClick={() => setWeekOffset(wOffset + 1)}
              style={pagerArrowStyle(wOffset >= maxWeekOffset)}
            >
              <ChevronRight size={18} strokeWidth={1.5} />
            </button>
          </div>

          {/* Body — current week is fully interactive; other weeks are read-only. */}
          {wOffset === 0 ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
                <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
                  Do whichever fits — gym, gear, time. Tap a logged one to edit.
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, whiteSpace: 'nowrap' }}>
                  {!loading && routines.length > 0 && (
                    <span className="num text-xs text-dim">{doneCount}/{routines.length} done</span>
                  )}
                  <button
                    type="button"
                    onClick={() => navigate('/app/history')}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-dim)' }}
                  >
                    All ›
                  </button>
                </div>
              </div>

              {loading && routines.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <Skeleton height={14} width={160} /><Skeleton height={10} width={90} /><Skeleton height={36} width="100%" />
                    </div>
                  ))}
                </div>
              ) : routines.length === 0 ? (
                <div className="card">
                  <p className="text-sm text-dim" style={{ lineHeight: 1.6 }}>
                    No sessions in this phase yet. Finish onboarding and your program builds here.
                  </p>
                </div>
              ) : (
                routines.map((r) => (
                  <SessionCard
                    key={r.id}
                    routine={r}
                    recommended={r.id === primaryRoutineId}
                    state={statusFor(r.id)}
                    lastDone={lastDoneByRoutine[r.id] ?? null}
                    plannedDow={plannedDowFor(r)}
                    onPlanDay={(dow) => handlePlanDay(r.id, dow)}
                    onStart={() => navigate(`/app/workout/${r.id}`)}
                    onResume={() => navigate(`/app/workout/${r.id}`)}
                    onLogAgain={() => navigate(`/app/workout/${r.id}`)}
                    onEdit={() => {
                      const s = statusFor(r.id)
                      if (s.kind === 'done') navigate(`/app/workout/${r.id}?w=${s.lastWorkout.id}`)
                    }}
                  />
                ))
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

        {/* End-of-week — the manual "I'm done" close-out. Hidden until a program
            exists; swaps to a "closed" state once this week's review is cut. */}
        {!loading && routines.length > 0 && (
          weekClosed ? (
            <button
              type="button"
              onClick={() => latestReview && navigate(`/app/recap/${latestReview.id}`)}
              className="fade-rise"
              style={{
                marginTop: 18, padding: 0, background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em',
                color: 'var(--confirmed)', display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              ✓ WEEK CLOSED · VIEW RECAP <span style={{ opacity: 0.6 }}>›</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowCloseSheet(true)}
              className="fade-rise"
              style={{
                marginTop: 18, width: '100%', padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)',
                fontSize: 13, textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600 }}>Done with the week?</span>
              <span className="text-dim" style={{ display: 'block', marginTop: 3, fontSize: 12, lineHeight: 1.4 }}>
                Crunch the numbers, set next week, and get the coach's note.
              </span>
            </button>
          )
        )}
       </div>

       {/* Week strip — cadence, de-emphasised. Right rail on desktop. */}
       <aside className="page__rail">
        <div className="fade-rise fade-rise-delay-2 today-week">
          <SectionHeader>This week</SectionHeader>
          <div className="week-strip" style={{ marginTop: 10, opacity: 0.7, padding: 0 }}>
            {loading
              ? Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="week-day" style={{ minWidth: 36 }}>
                    <Skeleton height={9} width={24} />
                    <Skeleton height={12} width={18} />
                    <div style={{ width: 4, height: 4 }} />
                  </div>
                ))
              : weekDays.map((day, i) => (
                  <div
                    key={i}
                    className={`week-day${day.isToday ? ' week-day--today' : ''}${day.logged ? ' week-day--logged' : ''}`}
                  >
                    <span className="week-day__label">{DAY_LABELS[(day.date.getDay() + 6) % 7]}</span>
                    <span className="week-day__num">{day.date.getDate()}</span>
                    <div className="week-day__dot" />
                  </div>
                ))
            }
          </div>
        </div>
       </aside>
      </div>

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
