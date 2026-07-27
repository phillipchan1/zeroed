import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { useAppState } from './hooks/useAppState'
import { useDisableShakeToUndo } from './hooks/useDisableShakeToUndo'
import { useOutboxSync, pendingSessionsRaw } from './lib/workoutOutbox'
import { cacheKeys, useWarmLoopCaches } from './lib/loopCache'
import { getWeightUnit } from './lib/units'
import { gatherProgramMap, gatherTrainingLog, gatherWeekPager } from './engine'
import { Spinner } from './components/ui'
import { Nav, Sidebar } from './components/layout/Nav'
import { DebugReset } from './components/DebugReset'
import { OfflineBar } from './components/OfflineBar'
import { ONBOARDING_FUNNEL_STEPS } from './types/database'

// Onboarding (six-act "First Read")
import { OnboardingRouter }             from './screens/onboarding/OnboardingRouter'
import { PostSessionRevelationScreen }  from './screens/onboarding/PostSessionRevelationScreen'

// Loop
import { TodayScreen }   from './screens/loop/TodayScreen'
import { ProfileScreen, fetchProfileMeta } from './screens/loop/ProfileScreen'
import { WorkoutScreen } from './screens/loop/WorkoutScreen'
import { ProgramScreen, fetchProgramView } from './screens/loop/ProgramScreen'
import { ProgramEditScreen } from './screens/loop/ProgramEditScreen'
import { CoachScreen, fetchCoachView }   from './screens/loop/CoachScreen'
import { HistoryScreen } from './screens/loop/HistoryScreen'
import { RecapScreen }   from './screens/loop/RecapScreen'
import { RetestScreen }  from './screens/loop/RetestScreen'

// ---- Splash ----------------------------------------------------------------

function Splash() {
  return (
    <div className="screen--centered">
      <Spinner />
    </div>
  )
}

// ---- Loop layout (persistent nav) -----------------------------------------

// Screens are swapped inside a persistent scroll container, so without this a
// tab opened after scrolling down another one appears already scrolled. Reset
// synchronously (no smooth scroll) so the new screen's first painted frame is
// already at the top.
function useScrollReset() {
  const { pathname } = useLocation()
  useEffect(() => {
    // Desktop: .app-main owns the scroll. Mobile: #root does. Reset whichever
    // is actually scrolled.
    document.querySelector('.app-main')?.scrollTo({ top: 0 })
    document.getElementById('root')?.scrollTo({ top: 0 })
  }, [pathname])
}

function LoopLayout({
  athleteId,
  athleteName,
  todayRoutine,
  refresh,
}: {
  athleteId: string
  athleteName: string | null
  todayRoutine: import('./types/database').RoutineRow | null
  refresh: () => void
}) {
  useScrollReset()

  // Warm the tabs the athlete hasn't opened yet, once, in the background. Today
  // loads its own view; these are the ones that would otherwise cost a wait on
  // first tap. Ordered by how likely they are to be opened next.
  useWarmLoopCaches(athleteId, [
    { key: cacheKeys.weekPager(athleteId),   load: () => gatherWeekPager(athleteId, getWeightUnit()) },
    { key: cacheKeys.program(athleteId),     load: () => fetchProgramView(athleteId) },
    { key: cacheKeys.history(athleteId),     load: () => gatherTrainingLog(athleteId, pendingSessionsRaw()) },
    { key: cacheKeys.programMap(athleteId),  load: () => gatherProgramMap(athleteId, getWeightUnit()) },
    { key: cacheKeys.profile(athleteId),     load: () => fetchProfileMeta(athleteId) },
    { key: cacheKeys.coach(athleteId),       load: () => fetchCoachView(athleteId) },
  ])

  return (
    <div className="app-shell">
      <Sidebar athleteId={athleteId} />
      <main className="app-main">
        <Outlet context={{ athleteId, athleteName, todayRoutine, refresh }} />
      </main>
      <Nav />
    </div>
  )
}

// ---- Root router -----------------------------------------------------------

function AppRoutes() {
  const { user, loading: authLoading } = useAuth()
  const { athlete, todayRoutine, routines, loading: stateLoading, refresh } = useAppState(user?.id)

  // Flush any sessions completed offline once we're back (and on every launch).
  useOutboxSync()

  if (authLoading || stateLoading) return <Splash />

  // Onboarding owns the athlete until they finish the first session. That's
  // every state before auth, the brief no-athlete beat after sign-in, and every
  // funnel step (hook → zeroed_in). Everything else is the daily loop.
  const inOnboarding =
    !user || !athlete || ONBOARDING_FUNNEL_STEPS.has(athlete.onboarding_step)

  if (inOnboarding) {
    return <OnboardingRouter user={user} athlete={athlete} refresh={refresh} />
  }

  // ---- Daily loop (first_session_pending / first_session_complete / complete)
  const athleteId      = athlete!.id
  const athleteName    = athlete!.name ?? null
  const onboardingStep = athlete!.onboarding_step

  return (
    <Routes>
      {/* Redirect root to today */}
      <Route path="/" element={<Navigate to="/app/today" replace />} />

      {/* Act 6 — the post-session revelation (Screen 21) */}
      <Route
        path="/onboarding/revelation"
        element={<PostSessionRevelationScreen athleteId={athleteId} onComplete={refresh} />}
      />

      {/* Loop with persistent nav */}
      <Route
        path="/app"
        element={
          <LoopLayout
            athleteId={athleteId}
            athleteName={athleteName}
            todayRoutine={todayRoutine}
            refresh={refresh}
          />
        }
      >
        <Route index element={<Navigate to="today" replace />} />
        <Route path="today"   element={<TodayScreen   athleteId={athleteId} todayRoutine={todayRoutine} routines={routines} onboardingStep={onboardingStep} />} />
        <Route path="profile" element={<ProfileScreen athleteId={athleteId} athleteName={athleteName} />} />
        <Route path="program" element={<ProgramScreen athleteId={athleteId} />} />
        <Route path="program/edit" element={<ProgramEditScreen athleteId={athleteId} />} />
        <Route path="coach"   element={<CoachScreen athleteId={athleteId} />} />
        <Route path="history" element={<HistoryScreen athleteId={athleteId} />} />
        <Route path="recap"             element={<RecapScreen athleteId={athleteId} />} />
        <Route path="recap/:reviewId"   element={<RecapScreen athleteId={athleteId} />} />
      </Route>

      {/* Workout — full-screen, no nav */}
      <Route path="/app/workout/:routineId" element={<WorkoutScreen onCommitted={refresh} />} />

      {/* Retest — full-screen rescreen (program cadence, §6) */}
      <Route path="/app/retest" element={<RetestScreen athleteId={athleteId} onDone={refresh} />} />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/app/today" replace />} />
    </Routes>
  )
}

export default function App() {
  useDisableShakeToUndo()
  return (
    <BrowserRouter>
      {/* Connectivity / update pill — a corner badge, only when there's something
          verified to say. */}
      <OfflineBar />
      <AppRoutes />
      {/* DEV-only: wipe onboarding state to re-test the funnel. No-op in prod. */}
      <DebugReset onReset={() => { window.location.href = '/' }} />
    </BrowserRouter>
  )
}
