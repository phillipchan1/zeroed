import { NavLink } from 'react-router-dom'
import { Activity, User, LayoutGrid, MessageSquare } from 'lucide-react'
import { Logo, PresenceDot } from '../ui'

const ITEMS = [
  { to: '/app/today',   label: 'Train',   Icon: Activity    },
  { to: '/app/profile', label: 'Profile', Icon: User        },
  { to: '/app/program', label: 'Program', Icon: LayoutGrid  },
  { to: '/app/coach',   label: 'Coach',   Icon: MessageSquare },
]

// Bottom tab bar — the mobile surface. Hidden on desktop, where Sidebar takes over.
export function Nav() {
  return (
    <nav className="nav">
      {ITEMS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `nav__item${isActive ? ' nav__item--active' : ''}`
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                size={20}
                strokeWidth={1.5}
                color={isActive ? 'var(--text)' : 'var(--text-dim)'}
              />
              <span className="nav__label">{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

// Left rail — the desktop surface. Hidden on mobile (CSS). Carries the wordmark,
// the four destinations, and a persistent MONITOR line so the "system is
// watching" signal lives on every screen, not just a strip that scrolls away.
export function Sidebar() {
  return (
    <aside className="app-sidebar">
      <div className="sidebar__brand"><Logo /></div>

      <nav className="sidebar__nav">
        {ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar__item${isActive ? ' sidebar__item--active' : ''}`
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={18}
                  strokeWidth={1.5}
                  color={isActive ? 'var(--text)' : 'var(--text-dim)'}
                />
                <span className="sidebar__label">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__spacer" />

      <div className="sidebar__system">
        <PresenceDot />
        <span>MONITOR</span>
      </div>
    </aside>
  )
}
