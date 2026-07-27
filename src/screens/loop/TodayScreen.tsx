import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { runLoopTriggers, isRetestDue, closeOutCurrentWeek, gatherWeekPager, type PagerWeekView, type WeekPagerData } from '../../engine'
import { getWeightUnit } from '../../lib/units'
import { ChevronLeft, ChevronRight, Lock, Sparkles, Activity, CloudUpload, Flag } from 'lucide-react'
import { loadDraftRoutineIds } from '../../lib/workoutDraft'
import { pendingCount } from '../../lib/workoutOutbox'
import { setIntendedDay, DAY_LABELS as PLAN_DAYS } from '../../lib/weekPlan'
import { Button, SectionHeader, Skeleton, Ring, Chip, Sheet, Banner, Meter } from '../../components/ui'
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

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  )
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
  p1: { category: string; confidence: number; claim: string } | null
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
    p1: top ? { category: top.category, confidence: top.confidence, claim: top.claim } : null,
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

const STATE_CHIP: Record<SessionState['kind'], { tone: 'todo' | 'doing' | 'done'; label: string }> = {
  todo:        { tone: 'todo',  label: 'To do' },
  in_progress: { tone: 'doing', label: 'In progress' },
  done:        { tone: 'done',  label: 'Done' },
}

/**
 * The session detail sub-screen. Everything that used to crowd the card — the
 * intent, the exercise list, the day-pinning, the secondary actions — lives
 * here, one tap away, so the week list stays scannable.
 */
function SessionSheet({
  routine, state, plannedDow, onPlanDay, onClose, onStart, onEdit, onLogAgain,
}: {
  routine: RoutineRow
  state: SessionState
  plannedDow: number | null
  onPlanDay: (dow: number | null) => void
  onClose: () => void
  onStart: () => void
  onEdit: () => void
  onLogAgain: () => void
}) {
  const exercises = routine.exercises
  const chip = STATE_CHIP[state.kind]

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
        <span className="text-xs text-dim num">{exercises.length} exercises</span>
      </div>

      {routine.intent && (
        <p className="text-sm text-dim" style={{ marginBottom: 20, lineHeight: 1.55 }}>{routine.intent}</p>
      )}

      <SectionHeader>The work</SectionHeader>
      <div style={{ marginTop: 10, marginBottom: 24 }}>
        {exercises.map((ex, i) => (
          <div
            key={i}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              gap: 14, padding: '12px 0', borderBottom: '1px solid var(--line)',
            }}
          >
            <span className="text-base" style={{ fontWeight: 500, minWidth: 0 }}>{ex.name}</span>
            <span className="num text-sm text-dim" style={{ whiteSpace: 'nowrap' }}>
              {ex.sets}×{ex.reps}{ex.load ? ` · ${ex.load}` : ''}
            </span>
          </div>
        ))}
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
          <p className="text-xs text-dim num" style={{ marginTop: 4 }}>{meta}</p>
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
        <Lock size={16} strokeWidth={1.75} color="var(--text-dim)" />
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
      onClose={onClose}
      dismissOnBackdrop={!closing}
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
        <Ring value={planned ? doneCount / planned : 0} size={64}>
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
 * TRAIN — the week, in full. Every session is on the surface with its state
 * (to-do / in-progress / done), startable in any order. Mobile shape: one
 * summary instrument, at most one attention banner, then the session list.
 * Detail lives in sheets, never inline.
 */
export function TodayScreen({ athleteId, todayRoutine, routines, onboardingStep }: TodayScreenProps) {
  const navigate   = useNavigate()
  const { refresh } = (useOutletContext<LoopContext>() ?? { refresh: () => {} })
  const isFirstVisit = onboardingStep === 'first_session_pending'
  const [draftRoutineIds, setDraftRoutineIds] = useState<string[]>([])
  const [showCloseSheet, setShowCloseSheet] = useState(false)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
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

  const confidencePct = p1 ? Math.round(p1.confidence * 100) : null
  const doneCount = routines.filter((r) => statusFor(r.id).kind === 'done').length
  const lastDoneByRoutine = view?.lastDoneByRoutine ?? {}

  // Exactly one session gets the primary (yellow) Start: the scheduler's pick if
  // it's still to-do, otherwise the first to-do in the list. Guarantees a clear
  // CTA even when the week has rolled over and there's no scheduled "today".
  const primaryRoutineId =
    (todayRoutine && statusFor(todayRoutine.id).kind === 'todo' ? todayRoutine.id : null)
    ?? routines.find((r) => statusFor(r.id).kind === 'in_progress')?.id
    ?? routines.find((r) => statusFor(r.id).kind === 'todo')?.id
    ?? null

  // Recap prompt: the latest review, shown for ~10 days after it's cut, until
  // viewed or dismissed (tracked locally — no schema change).
  const latestReview = view?.latestReview ?? null

  const recapRecent = latestReview
    ? Date.now() - new Date(`${latestReview.weekEnding}T12:00:00`).getTime() < 11 * 864e5
    : false
  // No separate dismiss control: opening the recap marks it seen, and it
  // self-expires after ~11 days. One banner, one action.
  const showRecap = !loading && !!latestReview && recapRecent && !recapSeen(latestReview.id)

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
    : atBoundary ? boundary!.phaseName
    : wOffset === 1 ? 'Next week'
    : pagerWeek ? fmtWeekRange(pagerWeek.weekStart, pagerWeek.weekEnd) : ''
  const weekSub = wOffset === 0 ? curRange
    : atBoundary ? 'Upcoming phase'
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

  const openSession = routines.find((r) => r.id === openSessionId) ?? null

  // At most ONE attention banner. Ranked by urgency so the screen never stacks
  // three competing yellow boxes the way it used to.
  const banner = (() => {
    if (loading) return null
    if (retestDue) {
      return (
        <Banner
          icon={<Activity size={20} strokeWidth={1.75} color="var(--signal)" />}
          title="Retest due"
          sub="A quick rescreen re-scopes your program."
          onClick={() => navigate('/app/retest')}
        />
      )
    }
    if (showRecap && latestReview) {
      return (
        <Banner
          icon={<Sparkles size={20} strokeWidth={1.75} color="var(--signal)" />}
          title="Your weekly recap is ready"
          sub="What moved, and the call for this week."
          onClick={() => { markRecapSeen(latestReview.id); navigate(`/app/recap/${latestReview.id}`) }}
        />
      )
    }
    if (pendingSync > 0) {
      return (
        <Banner
          tone="quiet"
          icon={<CloudUpload size={20} strokeWidth={1.75} color="var(--text-dim)" />}
          title={`${pendingSync} session${pendingSync === 1 ? '' : 's'} saved offline`}
          sub="They sync when you're back online."
        />
      )
    }
    return null
  })()

  return (
    <div className="screen with-nav">
      <div className="page page--rail">
       <div className="page__main">

        {/* Week pager — the one header. Arrows are 44px targets. */}
        <div className="pager">
          <button
            type="button" aria-label="Previous week"
            className="pager__btn"
            disabled={wOffset <= minWeekOffset}
            onClick={() => setWeekOffset(wOffset - 1)}
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

        {wOffset === 0 ? (
          <>
            {isFirstVisit && (
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
            {!loading && routines.length > 0 && (
              <div className="card fade-rise" style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  <Ring value={doneCount / routines.length} size={72}>
                    <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700 }}>{doneCount}</span>
                    <span className="text-micro text-dim" style={{ marginTop: 2 }}>of {routines.length}</span>
                  </Ring>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="text-lg" style={{ fontWeight: 700, lineHeight: 1.25 }}>
                      {doneCount === 0 ? 'Nothing logged yet'
                        : doneCount >= routines.length ? 'Week complete'
                        : `${routines.length - doneCount} to go`}
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
              </div>
            )}

            {/* Sessions */}
            {loading && routines.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Skeleton height={18} width={170} /><Skeleton height={12} width={110} />
                  </div>
                ))}
              </div>
            ) : routines.length === 0 ? (
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
                {routines.map((r) => (
                  <SessionCard
                    key={r.id}
                    routine={r}
                    recommended={r.id === primaryRoutineId}
                    state={statusFor(r.id)}
                    lastDone={lastDoneByRoutine[r.id] ?? null}
                    plannedDow={plannedDowFor(r)}
                    onOpen={() => setOpenSessionId(r.id)}
                    onStart={() => navigate(`/app/workout/${r.id}`)}
                  />
                ))}
              </>
            )}

            {/* The read — a glance that taps through to Coach. A meter, not a
                mono string of telemetry nobody could parse. */}
            {!loading && p1 && confidencePct !== null && (
              <button
                type="button"
                onClick={() => navigate('/app/coach')}
                className="card card--tap fade-rise"
                style={{ width: '100%', textAlign: 'left', marginTop: 24, color: 'var(--text)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span className="section-header">The read</span>
                  <span className="num text-sm text-signal">{confidencePct}% confident</span>
                </div>
                <p className="text-base prose-clamp" style={{ marginTop: 8, lineHeight: 1.45 }}>{p1.claim}</p>
                <div style={{ marginTop: 12 }}><Meter value={p1.confidence} /></div>
              </button>
            )}

            {/* End-of-week close-out. */}
            {!loading && routines.length > 0 && (
              weekClosed ? (
                <Banner
                  tone="good"
                  icon={<Flag size={20} strokeWidth={1.75} color="var(--confirmed)" />}
                  title="Week closed"
                  sub="View the recap"
                  onClick={() => latestReview && navigate(`/app/recap/${latestReview.id}`)}
                />
              ) : (
                <Banner
                  tone="quiet"
                  icon={<Flag size={20} strokeWidth={1.75} color="var(--text-dim)" />}
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
          plannedDow={plannedDowFor(openSession)}
          onPlanDay={(dow) => handlePlanDay(openSession.id, dow)}
          onClose={() => setOpenSessionId(null)}
          onStart={() => navigate(`/app/workout/${openSession.id}`)}
          onLogAgain={() => navigate(`/app/workout/${openSession.id}`)}
          onEdit={() => {
            const s = statusFor(openSession.id)
            if (s.kind === 'done') navigate(`/app/workout/${openSession.id}?w=${s.lastWorkout.id}`)
          }}
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
