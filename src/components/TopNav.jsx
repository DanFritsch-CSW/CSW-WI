import { NavLink } from 'react-router-dom'

const links = [
  { to: '/',          label: 'Labor Planning' },
  { to: '/orders',    label: 'Order Creator'  },
  { to: '/analytics', label: 'Analytics'      },
  { to: '/settings',  label: 'Settings'       },
]

export default function TopNav() {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <nav className="top-nav">
      <div className="nav-brand">CSW <span>OPS HUB</span></div>
      <div className="nav-links">
        {links.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            {label}
          </NavLink>
        ))}
      </div>
      <div className="nav-meta">
        <span>{dateStr}</span>
        <span>{timeStr}</span>
        <div className="status-dot" title="Live" />
      </div>
    </nav>
  )
}
