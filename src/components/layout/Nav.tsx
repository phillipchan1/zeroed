import { NavLink } from 'react-router-dom'
import { Activity, User, LayoutGrid, MessageSquare } from 'lucide-react'

const ITEMS = [
  { to: '/app/today',   label: 'Train',   Icon: Activity    },
  { to: '/app/profile', label: 'Profile', Icon: User        },
  { to: '/app/program', label: 'Program', Icon: LayoutGrid  },
  { to: '/app/coach',   label: 'Coach',   Icon: MessageSquare },
]

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
