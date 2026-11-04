import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Activity, User, LayoutGrid, MessageSquare, Target } from 'lucide-react'
import { tracksOn } from '../../lib/tracksFlag'
import { Logo } from '../ui'
import { MonitorReticle } from '../convergence/MonitorReticle'
import { GoalReticle } from '../convergence/GoalReticle'
import { useCachedLoader } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { fetchGoalsView, type GoalView } from '../../lib/tracksData'
import { progressRatio } from '../../engine/goals'

// Ordered by how often a tab is actually opened, left to right: you train most
// days, check the plan weekly, ask the coach occasionally, and touch settings
// almost never. Profile used to sit in slot two, next to the most-used tab.
const ITEMS = [
  { to: '/app/today',   label: 'Train',   Icon: Activity      },
  { to: '/app/program', label: 'Program', Icon: LayoutGrid    },
  { to: '/app/coach',   label: 'Coach',   Icon: MessageSquare },
  { to: '/app/profile', label: 'You',     Icon: User          },
]

// With tracks_v1 the plan lives under Goals: the goals are the aim and the
// block is how you get there, so Program folds in and the bar is four tabs.
// Program stays reachable from Goals as the block's detail.
function navItems() {
  if (!tracksOn()) return ITEMS
  return [
    ITEMS[0],
    { to: '/app/goals', label: 'Goals', Icon: Target },
    ITEMS[2],
    ITEMS[3],
  ]
}

/** Goals stays lit while you're inside the block it now owns. */
function useActiveFor() {
  const { pathname } = useLocation()
  return (to: string, isActive: boolean) =>
    isActive || (to === '/app/goals' && tracksOn() && pathname.startsWith('/app/program'))
}

// Bottom tab bar — the mobile surface. Hidden on desktop, where Sidebar takes over.
export function Nav() {
  const activeFor = useActiveFor()
  return (
    <nav className="nav">
      {navItems().map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `nav__item${activeFor(to, isActive) ? ' nav__item--active' : ''}`
          }
        >
          {({ isActive }) => {
            const on = activeFor(to, isActive)
            return (
              <>
                <Icon
                  size={24}
                  strokeWidth={on ? 2 : 1.75}
                  style={{ color: on ? 'var(--signal)' : 'var(--text-dim)' }}
                />
                <span className="nav__label">{label}</span>
              </>
            )
          }}
        </NavLink>
      ))}
    </nav>
  )
}

// Left rail — the desktop surface. Hidden on mobile (CSS). Carries the wordmark,
// the four destinations, and the persistent Convergence reticle (Phase F) — the
// MONITOR marker is now the live read organism: its tightness IS the program
// fit, it breathes off real session state, and it taps through to the Coach
// stack. Falls back to the static dot until the stack loads / nothing tracked.
export function Sidebar({ athleteId }: { athleteId: string }) {
  const activeFor = useActiveFor()
  return (
    <aside className="app-sidebar">
      <div className="sidebar__brand"><Logo /></div>

      <nav className="sidebar__nav">
        {navItems().map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar__item${activeFor(to, isActive) ? ' sidebar__item--active' : ''}`
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={18}
                  strokeWidth={1.5}
                  style={{ color: activeFor(to, isActive) ? 'var(--text)' : 'var(--text-dim)' }}
                />
                <span className="sidebar__label">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__spacer" />

      {tracksOn() ? <SidebarGoals athleteId={athleteId} /> : <MonitorReticle athleteId={athleteId} variant="sidebar" />}
    </aside>
  )
}

// With goals on, the rail's organism is the goals themselves: the same reticle
// as the Goals tab, small, tapping through to it. Before any goal exists it
// falls back to the read monitor.
function SidebarGoals({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const { data } = useCachedLoader<GoalView[]>(cacheKeys.goals(athleteId), () => fetchGoalsView(athleteId))
  const goals = data ?? []
  if (!goals.length) return <MonitorReticle athleteId={athleteId} variant="sidebar" />
  const off = goals.filter((g) => g.display === 'off_course').length
  return (
    <button type="button" className="sidebar__goals" onClick={() => navigate('/app/goals')}>
      <GoalReticle
        goals={goals.map((g) => ({ id: g.id, label: g.name, progress: progressRatio(g), display: g.display }))}
        size={112}
        labels={false}
        perGoal={6}
      />
      <span className="sidebar__goals-read">
        {off ? <><b className="text-signal">{off}</b> off course</> : `${goals.length} goals`}
      </span>
    </button>
  )
}
