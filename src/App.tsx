import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { useAppState } from './hooks/useAppState'
import { Spinner } from './components/ui'
import { Nav } from './components/layout/Nav'
import { DebugReset } from './components/DebugReset'

// Funnel
import { AuthScreen }       from './screens/funnel/AuthScreen'
import { DiagnosticIntake } from './screens/funnel/DiagnosticIntake'
import { ZeroedInScreen }   from './screens/funnel/ZeroedInScreen'

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
  const {
    athlete,
    hasDiagnostic,
    hasProfile,
    todayRoutine,
    loading: stateLoading,
    refresh,
  } = useAppState(user?.id)

  if (authLoading || stateLoading) return <Splash />

  // Not signed in → auth screen
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<AuthScreen />} />
      </Routes>
    )
  }

  // Signed in but no diagnostic → intake funnel
  if (!hasDiagnostic) {
    return (
      <Routes>
        <Route
          path="*"
          element={
            <DiagnosticIntake
              athleteId={athlete?.id ?? null}
              userId={user.id}
              onComplete={refresh}
            />
          }
        />
      </Routes>
    )
  }

  // Has diagnostic but zeroed-in not cleared → ZeroedIn screen
  if (!hasProfile) {
    return (
      <Routes>
        <Route
          path="/zeroed-in"
          element={
            athlete ? (
              <ZeroedInScreen athleteId={athlete.id} onComplete={refresh} />
            ) : (
              <Splash />
            )
          }
        />
        <Route path="*" element={<Navigate to="/zeroed-in" replace />} />
      </Routes>
    )
  }

  // Fully unlocked loop
  const athleteId   = athlete!.id
  const athleteName = athlete?.name ?? null

  return (
    <Routes>
      {/* Redirect root to today */}
      <Route path="/" element={<Navigate to="/app/today" replace />} />

      {/* Redirect funnel routes back to loop */}
      <Route path="/zeroed-in" element={<Navigate to="/app/today" replace />} />

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
        <Route path="today"   element={<TodayScreen   athleteId={athleteId} todayRoutine={todayRoutine} />} />
        <Route path="profile" element={<ProfileScreen athleteId={athleteId} athleteName={athleteName} />} />
        <Route path="program" element={<ProgramScreen />} />
        <Route path="coach"   element={<CoachScreen />} />
      </Route>

      {/* Workout — full-screen, no nav (rendered outside LoopLayout) */}
      <Route path="/app/workout/:routineId" element={<WorkoutScreen />} />

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
