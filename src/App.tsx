import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { useAppState } from './hooks/useAppState'
import { Spinner } from './components/ui'
import { Nav } from './components/layout/Nav'
import { DebugReset } from './components/DebugReset'
import { ONBOARDING_FUNNEL_STEPS } from './types/database'

// Onboarding (six-act "First Read")
import { OnboardingRouter }             from './screens/onboarding/OnboardingRouter'
import { PostSessionRevelationScreen }  from './screens/onboarding/PostSessionRevelationScreen'

// Loop
import { TodayScreen }   from './screens/loop/TodayScreen'
import { ProfileScreen } from './screens/loop/ProfileScreen'
import { WorkoutScreen } from './screens/loop/WorkoutScreen'
import { ProgramScreen } from './screens/loop/ProgramScreen'
import { CoachScreen }   from './screens/loop/CoachScreen'

// ---- Splash ----------------------------------------------------------------

function Splash() {
  return (
    <div className="screen--centered">
      <Spinner />
    </div>
  )
}

// ---- Loop layout (persistent nav) -----------------------------------------

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
  return (
    <>
      <Outlet context={{ athleteId, athleteName, todayRoutine, refresh }} />
      <Nav />
    </>
  )
}

// ---- Root router -----------------------------------------------------------

function AppRoutes() {
  const { user, loading: authLoading } = useAuth()
  const { athlete, todayRoutine, week, loading: stateLoading, refresh } = useAppState(user?.id)

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
        <Route path="today"   element={<TodayScreen   athleteId={athleteId} todayRoutine={todayRoutine} week={week} onboardingStep={onboardingStep} />} />
        <Route path="profile" element={<ProfileScreen athleteId={athleteId} athleteName={athleteName} />} />
        <Route path="program" element={<ProgramScreen athleteId={athleteId} week={week} />} />
        <Route path="coach"   element={<CoachScreen athleteId={athleteId} />} />
      </Route>

      {/* Workout — full-screen, no nav */}
      <Route path="/app/workout/:routineId" element={<WorkoutScreen onLogged={refresh} />} />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/app/today" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      {/* DEV-only: wipe onboarding state to re-test the funnel. No-op in prod. */}
      <DebugReset onReset={() => { window.location.href = '/' }} />
    </BrowserRouter>
  )
}
